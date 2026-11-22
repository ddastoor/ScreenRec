export type CaptureSourceType = 'monitor' | 'window' | 'browser';

export interface RecorderOptions {
  sourceType: CaptureSourceType;
  systemAudio: boolean;
  micAudio: boolean;
  micDeviceId?: string;
  includeCursor: boolean;
}

/**
 * Builds standard DisplayMediaStreamOptions with cursor and surface hints
 * supported by Chromium, Firefox, and Electron on Linux (X11 & Wayland PipeWire).
 */
export function buildDisplayMediaConstraints(options: RecorderOptions): DisplayMediaStreamOptions & Record<string, unknown> {
  const videoConstraints: MediaTrackConstraints & Record<string, unknown> = {
    displaySurface: options.sourceType,
    cursor: options.includeCursor ? 'always' : 'never',
    frameRate: { ideal: 30, max: 60 },
  };

  const audioConstraints: boolean | MediaTrackConstraints = options.systemAudio
    ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    : false;

  return {
    video: videoConstraints,
    audio: audioConstraints,
    selfBrowserSurface: options.sourceType === 'browser' ? 'include' : 'exclude',
    surfaceSwitching: 'include',
    systemAudio: options.systemAudio ? 'include' : 'exclude',
  };
}

/**
 * Formats elapsed seconds into MM:SS or HH:MM:SS with zero padding.
 */
export function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Formats file byte size into human-readable KB / MB / GB.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Generates a clean timestamped .mp4 filename for a saved screencast.
 */
export function createMp4Filename(sourceType: CaptureSourceType, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const sec = pad(now.getSeconds());
  const label = sourceType === 'monitor' ? 'screen' : sourceType === 'window' ? 'window' : 'tab';
  return `screenrec-${label}-${yyyy}-${mm}-${dd}-${hh}${min}${sec}.mp4`;
}

/**
 * Picks the best supported MediaRecorder MIME type in the current runtime.
 * Prefers native MP4 H.264/AAC when supported, falling back to WebM VP9/VP8
 * prior to FFmpeg H.264/AAC MP4 muxing.
 */
export function selectSupportedRecorderMimeType(
  isTypeSupported: (mime: string) => boolean
): string {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}
