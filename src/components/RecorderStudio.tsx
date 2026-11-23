import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Circle,
  Download,
  Globe,
  Mic,
  Monitor,
  MousePointer,
  Pause,
  Play,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import type { RecordedClip, SystemInfo } from '../types';
import { buildLinuxCapturePipelineSummary } from '../utils/displayServer';
import {
  buildDisplayMediaConstraints,
  createMp4Filename,
  formatBytes,
  formatDuration,
  selectSupportedRecorderMimeType,
  type CaptureSourceType,
} from '../utils/recorderConfig';
import { createRecordingStreamMixer, type AudioMixerHandle } from '../utils/audioMixer';
import { createDemoCaptureStream, type DemoStreamHandle } from '../utils/demoStream';
import type { ShortcutActionId, ShortcutBinding } from '../utils/shortcuts';

export type StudioState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'paused'
  | 'converting'
  | 'completed';

export interface RecorderStudioHandle {
  dispatchShortcut: (action: ShortcutActionId) => void;
}

interface RecorderStudioProps {
  ref?: React.Ref<RecorderStudioHandle>;
  systemInfo: SystemInfo | null;
  systemLoading: boolean;
  simulationMode: 'auto' | 'wayland' | 'x11';
  shortcuts: ShortcutBinding[];
  onChangeSimulationMode: (mode: 'auto' | 'wayland' | 'x11') => void;
  onClipSaved: (clip: RecordedClip) => void;
  onStateChange?: (state: StudioState, elapsedSeconds: number) => void;
}

export const RecorderStudio: React.FC<RecorderStudioProps> = ({
  ref,
  systemInfo,
  systemLoading,
  simulationMode,
  shortcuts,
  onChangeSimulationMode,
  onClipSaved,
  onStateChange,
}) => {
  const [sourceType, setSourceType] = useState<CaptureSourceType>('monitor');
  const [systemAudio, setSystemAudio] = useState<boolean>(true);
  const [micAudio, setMicAudio] = useState<boolean>(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('default');
  const [includeCursor, setIncludeCursor] = useState<boolean>(true);

  const [studioState, setStudioState] = useState<StudioState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latestClip, setLatestClip] = useState<RecordedClip | null>(null);
  const [showBackendInspector, setShowBackendInspector] = useState<boolean>(false);

  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mixerRef = useRef<AudioMixerHandle | null>(null);
  const demoHandleRef = useRef<DemoStreamHandle | null>(null);
  const displayTrackRef = useRef<MediaStreamTrack | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const meterIntervalRef = useRef<number | null>(null);
  const elapsedRef = useRef<number>(0);

  // Enumerate microphone devices when user toggles Microphone on
  useEffect(() => {
    if (!micAudio || !navigator.mediaDevices?.enumerateDevices) return;
    let active = true;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!active) return;
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        setMicDevices(inputs);
        if (inputs.length > 0 && selectedMicId === 'default') {
          setSelectedMicId(inputs[0].deviceId || 'default');
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [micAudio, selectedMicId]);

  // Update cursor visibility live during recording if toggled
  useEffect(() => {
    demoHandleRef.current?.setCursorVisible(includeCursor);
    const track = displayTrackRef.current;
    if (track && typeof track.applyConstraints === 'function') {
      const constraintPatch = { cursor: includeCursor ? 'always' : 'never' } as MediaTrackConstraints;
      track.applyConstraints(constraintPatch).catch(() => undefined);
    }
  }, [includeCursor]);

  // Cleanup active streams on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current !== null) window.clearInterval(timerIntervalRef.current);
      if (meterIntervalRef.current !== null) window.clearInterval(meterIntervalRef.current);
      demoHandleRef.current?.stop();
      mixerRef.current?.cleanup();
    };
  }, []);

  const clearTimers = () => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (meterIntervalRef.current !== null) {
      window.clearInterval(meterIntervalRef.current);
      meterIntervalRef.current = null;
    }
  };

  const startTimers = () => {
    clearTimers();
    timerIntervalRef.current = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsedSeconds(elapsedRef.current);
    }, 1000);
    meterIntervalRef.current = window.setInterval(() => {
      if (mixerRef.current) {
        setAudioLevel(mixerRef.current.getAudioLevel());
      }
    }, 120);
  };

  const finalizeRecordingToMp4 = async (rawBlob: Blob, durationSec: number) => {
    setStudioState('converting');
    setAudioLevel(0);

    try {
      const rawArrayBuffer = await rawBlob.arrayBuffer();
      const filename = createMp4Filename(sourceType);

      const response = await fetch('/api/convert-mp4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rawArrayBuffer,
      });

      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({}));
        throw new Error(errPayload.error || `MP4 conversion failed (${response.status})`);
      }

      const mp4Buffer = await response.arrayBuffer();
      const mp4Blob = new Blob([mp4Buffer], { type: 'video/mp4' });
      const mp4Url = URL.createObjectURL(mp4Blob);

      const clip: RecordedClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename,
        url: mp4Url,
        sizeBytes: mp4Blob.size,
        durationSeconds: Math.max(1, durationSec),
        createdAt: new Date().toISOString(),
        sourceType,
        systemAudio,
        micAudio,
        includeCursor,
        displayProtocol: systemInfo?.displayServer.label || 'Linux Display',
      };

      setLatestClip(clip);
      onClipSaved(clip);
      setStudioState('completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to convert recording to MP4.';
      setErrorMessage(msg);
      setStudioState('idle');
    }
  };

  const beginRecordingWithStream = async (displayStream: MediaStream) => {
    let micStream: MediaStream | null = null;
    if (micAudio && navigator.mediaDevices?.getUserMedia) {
      try {
        const audioConstraint: MediaTrackConstraints =
          selectedMicId && selectedMicId !== 'default'
            ? { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true }
            : { echoCancellation: true, noiseSuppression: true };
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
      } catch {
        // Proceed with recording if mic permission is unavailable, noting it subtly
        setErrorMessage('Microphone access was unavailable; recording video without mic voiceover.');
      }
    }

    const vTrack = displayStream.getVideoTracks()[0] || null;
    displayTrackRef.current = vTrack;

    if (vTrack) {
      vTrack.onended = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      };
    }

    const mixer = createRecordingStreamMixer(displayStream, micStream, systemAudio);
    mixerRef.current = mixer;

    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = displayStream;
      liveVideoRef.current.play().catch(() => undefined);
    }

    const mimeType = selectSupportedRecorderMimeType((m) =>
      typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
        ? MediaRecorder.isTypeSupported(m)
        : false
    );

    chunksRef.current = [];
    const recorder = mimeType
      ? new MediaRecorder(mixer.combinedStream, { mimeType })
      : new MediaRecorder(mixer.combinedStream);

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      clearTimers();
      const recordedDuration = Math.max(1, elapsedRef.current);
      const finalBlob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'video/webm',
      });

      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = null;
      }

      demoHandleRef.current?.stop();
      demoHandleRef.current = null;
      mixerRef.current?.cleanup();
      mixerRef.current = null;
      displayTrackRef.current = null;

      void finalizeRecordingToMp4(finalBlob, recordedDuration);
    };

    elapsedRef.current = 0;
    setElapsedSeconds(0);
    setLatestClip(null);
    recorder.start(250);
    setStudioState('recording');
    startTimers();
  };

  const handleStartDisplayCapture = async () => {
    setErrorMessage(null);
    setStudioState('requesting');

    try {
      if (window.screenRecDesktop?.setCapturePrefs) {
        await window.screenRecDesktop.setCapturePrefs({
          sourceType,
          systemAudio,
          includeCursor,
        });
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen capture API is not supported in this browser context.');
      }

      const constraints = buildDisplayMediaConstraints({
        sourceType,
        systemAudio,
        micAudio,
        includeCursor,
      });

      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      await beginRecordingWithStream(stream);
    } catch (err) {
      setStudioState('idle');
      const rawMsg = err instanceof Error ? err.message : 'Screen capture could not start.';
      if (
        rawMsg.toLowerCase().includes('permission') ||
        rawMsg.toLowerCase().includes('disallowed') ||
        rawMsg.toLowerCase().includes('not allowed') ||
        rawMsg.toLowerCase().includes('denied')
      ) {
        setErrorMessage(
          'Screen selection was canceled or restricted by browser iframe permissions. On Debian desktop (.deb) or a standalone browser tab, native screen picking opens directly—or click "Record Test Screen" to test MP4 recording right here.'
        );
      } else {
        setErrorMessage(rawMsg);
      }
    }
  };

  const handleStartDemoCapture = async () => {
    setErrorMessage(null);
    setStudioState('requesting');
    try {
      const demo = createDemoCaptureStream({
        sourceType,
        systemAudio,
        includeCursor,
        displayLabel: systemInfo?.displayServer.label || 'Debian Linux',
      });
      demoHandleRef.current = demo;
      await beginRecordingWithStream(demo.stream);
    } catch (err) {
      setStudioState('idle');
      setErrorMessage(err instanceof Error ? err.message : 'Could not start test screen capture.');
    }
  };

  const handlePauseResume = () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.pause();
      clearTimers();
      setStudioState('paused');
    } else if (rec.state === 'paused') {
      rec.resume();
      startTimers();
      setStudioState('recording');
    }
  };

  const handleStopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    }
  };

  const isBusy =
    studioState === 'requesting' ||
    studioState === 'recording' ||
    studioState === 'paused' ||
    studioState === 'converting';

  useEffect(() => {
    onStateChange?.(studioState, elapsedSeconds);
  }, [studioState, elapsedSeconds, onStateChange]);

  useImperativeHandle(ref, () => ({
    dispatchShortcut: (action: ShortcutActionId) => {
      if (studioState === 'requesting' || studioState === 'converting') {
        return;
      }
      switch (action) {
        case 'toggleRecord':
          if (studioState === 'recording' || studioState === 'paused') {
            handleStopRecording();
          } else {
            void handleStartDisplayCapture();
          }
          break;
        case 'toggleDemoRecord':
          if (studioState === 'recording' || studioState === 'paused') {
            handleStopRecording();
          } else {
            void handleStartDemoCapture();
          }
          break;
        case 'togglePause':
          if (studioState === 'recording' || studioState === 'paused') {
            handlePauseResume();
          }
          break;
        case 'toggleSystemAudio':
          if (!isBusy) {
            setSystemAudio((prev) => !prev);
          }
          break;
        case 'toggleMic':
          if (!isBusy) {
            setMicAudio((prev) => !prev);
          }
          break;
        case 'toggleCursor':
          setIncludeCursor((prev) => !prev);
          break;
      }
    },
  }));

  const comboFor = (action: ShortcutActionId): string =>
    shortcuts.find((s) => s.action === action)?.combo || '';

  const sourceOptions: {
    id: CaptureSourceType;
    label: string;
    subtitle: string;
    icon: React.FC<{ className?: string }>;
  }[] = [
    {
      id: 'monitor',
      label: 'Entire Screen',
      subtitle: 'Full desktop workspace',
      icon: Monitor,
    },
    {
      id: 'window',
      label: 'Window',
      subtitle: 'Single Linux app window',
      icon: AppWindow,
    },
    {
      id: 'browser',
      label: 'Browser Tab',
      subtitle: 'Single web tab',
      icon: Globe,
    },
  ];

  const detectedProtocol = systemInfo?.displayServer.protocol ?? 'headless';
  const pipelinePreview = buildLinuxCapturePipelineSummary({
    protocol: detectedProtocol,
    sourceType,
    systemAudio,
    micAudio,
    includeCursor,
    outputFile: createMp4Filename(sourceType),
    x11Display: systemInfo?.displayServer.details.x11Display || ':0.0',
  });

  return (
    <section aria-labelledby="recorder-heading" className="space-y-6">
      {/* Startup X11 / Wayland Auto-Detection Bar */}
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="font-semibold text-slate-900">Display Server Auto-Detection</span>
            <span aria-hidden="true">·</span>
            {systemLoading ? (
              <span>Scanning X11 and Wayland sockets...</span>
            ) : (
              <span className="font-mono text-slate-900 font-medium" data-testid="detected-display-label">
                {systemInfo?.displayServer.label || 'Unknown'}
              </span>
            )}
            {systemInfo && (
              <>
                <span aria-hidden="true">·</span>
                <span>{systemInfo.os.prettyName}</span>
                <span aria-hidden="true">·</span>
                <span>Output MP4 (H.264 + AAC)</span>
              </>
            )}
          </div>
          {systemInfo && (
            <p className="text-xs text-slate-500">
              Backend: {systemInfo.displayServer.captureBackend} · Detected via{' '}
              <span className="font-mono">{systemInfo.displayServer.detectedVia}</span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowBackendInspector((prev) => !prev)}
          aria-expanded={showBackendInspector}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <span>Inspect X11 / Wayland</span>
          {showBackendInspector ? (
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Optional Display Protocol Inspector & Pipeline View */}
      {showBackendInspector && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Linux Display Protocol & Capture Pipeline
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                ScreenRec probes Wayland/X11 compositor sockets (
                <code className="font-mono">/run/user/$UID/wayland-*</code>,{' '}
                <code className="font-mono">/tmp/.X11-unix/X*</code>),{' '}
                <code className="font-mono">systemd-logind</code>, and session metadata on GUI
                startup—selecting PipeWire Portal or X11Grab automatically with no command line needed.
              </p>
            </div>

            <div
              role="group"
              aria-label="Display detection mode"
              className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              {(
                [
                  { id: 'auto', label: 'Auto (System)' },
                  { id: 'wayland', label: 'Preview Wayland' },
                  { id: 'x11', label: 'Preview X11' },
                ] as const
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => onChangeSimulationMode(mode.id)}
                  aria-pressed={simulationMode === mode.id}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    simulationMode === mode.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 text-slate-200 rounded-lg p-3.5 font-mono text-xs overflow-x-auto">
            {pipelinePreview}
          </div>
        </div>
      )}

      {/* Main 2-Column Simple Recorder Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: Capture Settings */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-6">
            <div>
              <h1 id="recorder-heading" className="text-xl font-bold text-slate-900">
                New Screen Recording
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Choose what to capture, configure audio and cursor visibility, and save directly in
                MP4 format.
              </p>
            </div>

            {/* 1. Source Target Selector */}
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold text-slate-700">
                1. Capture Source
              </span>
              <div
                role="group"
                aria-label="Capture source"
                className="grid grid-cols-1 sm:grid-cols-3 gap-2.5"
              >
                {sourceOptions.map((opt) => {
                  const Icon = opt.icon;
                  const selected = sourceType === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={isBusy}
                      aria-pressed={selected}
                      onClick={() => setSourceType(opt.id)}
                      className={`flex flex-col items-start p-3 rounded-lg border text-left transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 ${
                        selected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                      }`}
                    >
                      <Icon
                        className={`w-4 h-4 mb-2 ${selected ? 'text-red-400' : 'text-slate-600'}`}
                      />
                      <span className="text-xs font-semibold whitespace-nowrap">{opt.label}</span>
                      <span
                        className={`text-[11px] mt-0.5 leading-tight ${
                          selected ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {opt.subtitle}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Audio & Mouse Cursor Options */}
            <div className="space-y-2.5">
              <span className="block text-xs font-semibold text-slate-700">
                2. Audio & Pointer Options
              </span>

              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {/* System Audio */}
                <label className="flex items-center justify-between gap-4 p-3.5 cursor-pointer hover:bg-slate-50 transition-colors">
                  <div className="flex items-start gap-3">
                    <Volume2 className="w-4 h-4 text-slate-600 mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                      <span className="block text-sm font-medium text-slate-900">
                        System Audio{' '}
                        <kbd
                          aria-hidden="true"
                          className="ml-1 font-mono text-[11px] font-normal text-slate-500"
                        >
                          {comboFor('toggleSystemAudio')}
                        </kbd>
                      </span>
                      <span className="block text-xs text-slate-500">
                        Record desktop output or browser tab sound
                      </span>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={systemAudio}
                    disabled={isBusy}
                    aria-keyshortcuts={comboFor('toggleSystemAudio')}
                    onChange={(e) => setSystemAudio(e.target.checked)}
                    className="w-4 h-4 accent-slate-900 rounded cursor-pointer disabled:opacity-50"
                  />
                </label>

                {/* Microphone Audio */}
                <div className="p-3.5 space-y-2.5 hover:bg-slate-50 transition-colors">
                  <label className="flex items-center justify-between gap-4 cursor-pointer">
                    <div className="flex items-start gap-3">
                      <Mic className="w-4 h-4 text-slate-600 mt-0.5 shrink-0" aria-hidden="true" />
                      <div>
                        <span className="block text-sm font-medium text-slate-900">
                          Microphone{' '}
                          <kbd
                            aria-hidden="true"
                            className="ml-1 font-mono text-[11px] font-normal text-slate-500"
                          >
                            {comboFor('toggleMic')}
                          </kbd>
                        </span>
                        <span className="block text-xs text-slate-500">
                          Mix your voiceover into the recording
                        </span>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={micAudio}
                      disabled={isBusy}
                      aria-keyshortcuts={comboFor('toggleMic')}
                      onChange={(e) => setMicAudio(e.target.checked)}
                      className="w-4 h-4 accent-slate-900 rounded cursor-pointer disabled:opacity-50"
                    />
                  </label>

                  {micAudio && (
                    <div className="pl-7">
                      <label htmlFor="mic-device-select" className="sr-only">
                        Microphone input device
                      </label>
                      <select
                        id="mic-device-select"
                        value={selectedMicId}
                        disabled={isBusy}
                        onChange={(e) => setSelectedMicId(e.target.value)}
                        className="w-full text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-white text-slate-800 focus:outline-2 focus:outline-slate-900"
                      >
                        {micDevices.length === 0 ? (
                          <option value="default">Default System Microphone</option>
                        ) : (
                          micDevices.map((d, idx) => (
                            <option key={d.deviceId || idx} value={d.deviceId || 'default'}>
                              {d.label || `Microphone ${idx + 1}`}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  )}
                </div>

                {/* Mouse Cursor Visibility (Can also be toggled live!) */}
                <label className="flex items-center justify-between gap-4 p-3.5 cursor-pointer hover:bg-slate-50 transition-colors">
                  <div className="flex items-start gap-3">
                    <MousePointer
                      className="w-4 h-4 text-slate-600 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <div>
                      <span className="block text-sm font-medium text-slate-900">
                        Include Mouse Cursor{' '}
                        <kbd
                          aria-hidden="true"
                          className="ml-1 font-mono text-[11px] font-normal text-slate-500"
                        >
                          {comboFor('toggleCursor')}
                        </kbd>
                      </span>
                      <span className="block text-xs text-slate-500">
                        Show mouse pointer movements in screencast
                      </span>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={includeCursor}
                    disabled={studioState === 'converting'}
                    aria-keyshortcuts={comboFor('toggleCursor')}
                    onChange={(e) => setIncludeCursor(e.target.checked)}
                    className="w-4 h-4 accent-slate-900 rounded cursor-pointer disabled:opacity-50"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Primary Action Controls */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            {errorMessage && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 space-y-2"
              >
                <p>{errorMessage}</p>
              </div>
            )}

            {studioState === 'recording' || studioState === 'paused' ? (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  aria-keyshortcuts={comboFor('togglePause')}
                  onClick={handlePauseResume}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  {studioState === 'paused' ? (
                    <>
                      <Play className="w-4 h-4" aria-hidden="true" />
                      <span>Resume</span>
                    </>
                  ) : (
                    <>
                      <Pause className="w-4 h-4" aria-hidden="true" />
                      <span>Pause</span>
                    </>
                  )}
                  <kbd
                    aria-hidden="true"
                    className="font-mono text-[11px] font-medium text-slate-500"
                  >
                    {comboFor('togglePause')}
                  </kbd>
                </button>

                <button
                  type="button"
                  aria-keyshortcuts={comboFor('toggleRecord')}
                  onClick={handleStopRecording}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>Stop & Save MP4</span>
                  <kbd
                    aria-hidden="true"
                    className="font-mono text-[11px] font-medium text-red-100"
                  >
                    {comboFor('toggleRecord')}
                  </kbd>
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={studioState === 'requesting' || studioState === 'converting'}
                  aria-keyshortcuts={comboFor('toggleRecord')}
                  onClick={handleStartDisplayCapture}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Circle className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>
                    {studioState === 'requesting'
                      ? 'Waiting for Source Selection...'
                      : studioState === 'converting'
                        ? 'Encoding MP4 (H.264 / AAC)...'
                        : 'Start Recording'}
                  </span>
                  {studioState !== 'requesting' && studioState !== 'converting' && (
                    <kbd
                      aria-hidden="true"
                      className="ml-1 font-mono text-[11px] font-medium text-red-100"
                    >
                      {comboFor('toggleRecord')}
                    </kbd>
                  )}
                </button>

                <button
                  type="button"
                  disabled={studioState === 'requesting' || studioState === 'converting'}
                  aria-keyshortcuts={comboFor('toggleDemoRecord')}
                  onClick={handleStartDemoCapture}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
                >
                  <span>Record Test Screen (Simulated Preview)</span>
                  <kbd
                    aria-hidden="true"
                    className="font-mono text-[11px] text-slate-500"
                  >
                    {comboFor('toggleDemoRecord')}
                  </kbd>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Live Monitor & Saved MP4 Preview */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">
                {studioState === 'completed'
                  ? 'MP4 Recording Ready'
                  : studioState === 'converting'
                    ? 'Finalizing MP4 File'
                    : studioState === 'recording'
                      ? 'Recording Active'
                      : studioState === 'paused'
                        ? 'Recording Paused'
                        : 'Preview Stage'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {sourceType === 'monitor'
                  ? 'Entire Screen'
                  : sourceType === 'window'
                    ? 'Window'
                    : 'Browser Tab'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{includeCursor ? 'Cursor Included' : 'Cursor Hidden'}</span>
            </div>

            <div className="font-mono text-sm font-semibold text-slate-900 tabular-nums" data-testid="recording-timer">
              {formatDuration(
                studioState === 'completed' && latestClip
                  ? latestClip.durationSeconds
                  : elapsedSeconds
              )}
            </div>
          </div>

          {/* Viewport Container */}
          <div className="relative flex-1 min-h-[320px] bg-slate-950 rounded-lg overflow-hidden flex items-center justify-center">
            {/* Live Video Monitor while recording */}
            <video
              ref={liveVideoRef}
              muted
              playsInline
              className={`w-full h-full object-contain ${
                studioState === 'recording' || studioState === 'paused' ? 'block' : 'hidden'
              }`}
            />

            {/* Completed MP4 Playback */}
            {studioState === 'completed' && latestClip && (
              <video
                key={latestClip.url}
                src={latestClip.url}
                controls
                playsInline
                data-testid="mp4-preview-video"
                className="w-full h-full object-contain"
              />
            )}

            {/* Converting State */}
            {studioState === 'converting' && (
              <div className="text-center px-6 space-y-2">
                <p className="text-sm font-semibold text-white">Muxing H.264 + AAC into MP4...</p>
                <p className="text-xs text-slate-400">
                  Applying fast-start MP4 container headers via FFmpeg
                </p>
              </div>
            )}

            {/* Idle / Requesting State */}
            {(studioState === 'idle' || studioState === 'requesting') && (
              <div className="text-center px-8 max-w-md space-y-3">
                <Monitor className="w-10 h-10 text-slate-500 mx-auto" aria-hidden="true" />
                <p className="text-sm font-medium text-slate-200">
                  Ready to record{' '}
                  {sourceType === 'monitor'
                    ? 'your entire screen'
                    : sourceType === 'window'
                      ? 'an application window'
                      : 'a browser tab'}
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {systemAudio ? 'System audio on' : 'System audio muted'} ·{' '}
                  {micAudio ? 'Microphone on' : 'Microphone off'} ·{' '}
                  {includeCursor ? 'Mouse cursor visible' : 'Mouse cursor hidden'} · Exports as{' '}
                  <span className="font-mono text-slate-300">.mp4</span>
                </p>
              </div>
            )}
          </div>

          {/* Bottom Bar: Audio Level Meter during recording OR Save MP4 actions when completed */}
          {(studioState === 'recording' || studioState === 'paused') && (
            <div className="flex items-center justify-between gap-4 pt-1">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-xs font-medium text-slate-600 whitespace-nowrap">
                  Audio Input
                </span>
                <div className="h-2 flex-1 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-slate-900 transition-transform duration-100 origin-left"
                    style={{ transform: `scaleX(${Math.max(0.03, audioLevel / 100)})` }}
                  />
                </div>
              </div>
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                {systemAudio || micAudio ? `${audioLevel}%` : 'Muted'}
              </span>
            </div>
          )}

          {studioState === 'completed' && latestClip && (
            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-100">
              <div className="text-xs text-slate-600 font-mono tabular-nums">
                <span>{latestClip.filename}</span>
                <span aria-hidden="true"> · </span>
                <span>{formatBytes(latestClip.sizeBytes)}</span>
                <span aria-hidden="true"> · </span>
                <span>MP4</span>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setLatestClip(null);
                    setStudioState('idle');
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>New Recording</span>
                </button>

                <a
                  href={latestClip.url}
                  download={latestClip.filename}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Save MP4 File</span>
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
