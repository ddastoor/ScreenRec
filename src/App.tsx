import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import {
  RecorderStudio,
  type RecorderStudioHandle,
  type StudioState,
} from './components/RecorderStudio';
import { RecordingsList } from './components/RecordingsList';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { DebianReleasePanel } from './components/DebianReleasePanel';
import type { ActiveView, RecordedClip, SystemInfo } from './types';
import { formatDuration } from './utils/recorderConfig';
import {
  matchShortcutAction,
  parseStoredShortcuts,
  serializeShortcuts,
  SHORTCUTS_STORAGE_KEY,
  toElectronAccelerator,
  type ShortcutActionId,
  type ShortcutBinding,
} from './utils/shortcuts';

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>('recorder');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemLoading, setSystemLoading] = useState<boolean>(true);
  const [simulationMode, setSimulationMode] = useState<'auto' | 'wayland' | 'x11'>('auto');
  const [recordings, setRecordings] = useState<RecordedClip[]>([]);

  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>(() => {
    try {
      return parseStoredShortcuts(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY));
    } catch {
      return parseStoredShortcuts(null);
    }
  });
  const [shortcutsEnabled, setShortcutsEnabled] = useState<boolean>(true);
  const [rebindingAction, setRebindingAction] = useState<ShortcutActionId | null>(null);
  const [studioState, setStudioState] = useState<StudioState>('idle');
  const [studioElapsed, setStudioElapsed] = useState<number>(0);

  const recorderRef = useRef<RecorderStudioHandle | null>(null);
  const lastTriggerTimeRef = useRef<number>(0);

  const fetchStartupSystemInfo = useCallback(async (mode: 'auto' | 'wayland' | 'x11') => {
    setSystemLoading(true);
    try {
      const query = mode === 'auto' ? '' : `?simulate=${mode}`;
      const res = await fetch(`/api/system-info${query}`);
      if (!res.ok) throw new Error('System probe failed');
      const data = (await res.json()) as SystemInfo;

      // If running inside the native Electron .deb desktop shell in 'auto' mode,
      // merge the desktop process startup X11/Wayland detection directly.
      if (mode === 'auto' && window.screenRecDesktop?.getStartupDisplayInfo) {
        const desktopDisplay = await window.screenRecDesktop.getStartupDisplayInfo();
        data.displayServer = {
          ...data.displayServer,
          protocol: desktopDisplay.protocol,
          label: desktopDisplay.label,
        };
      }

      setSystemInfo(data);
    } catch {
      setSystemInfo(null);
    } finally {
      setSystemLoading(false);
    }
  }, []);

  // Auto-detect X11 or Wayland immediately when the application starts
  useEffect(() => {
    void fetchStartupSystemInfo(simulationMode);
  }, [fetchStartupSystemInfo, simulationMode]);

  const handleClipSaved = (clip: RecordedClip) => {
    setRecordings((prev) => [clip, ...prev]);
  };

  const handleDeleteClip = (id: string) => {
    setRecordings((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) {
        URL.revokeObjectURL(target.url);
      }
      return prev.filter((c) => c.id !== id);
    });
  };

  const handleUpdateShortcuts = useCallback((next: ShortcutBinding[]) => {
    setShortcuts(next);
    try {
      window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, serializeShortcuts(next));
    } catch {
      // Ignore storage quota errors in restricted frames
    }
  }, []);

  const triggerShortcutAction = useCallback((action: ShortcutActionId) => {
    const now = Date.now();
    // Deduplicate simultaneous Electron globalShortcut IPC + DOM keydown within 140ms
    if (now - lastTriggerTimeRef.current < 140) return;
    lastTriggerTimeRef.current = now;
    recorderRef.current?.dispatchShortcut(action);
  }, []);

  // Register global window keyboard listener across all views in the app
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (rebindingAction) return;
      const target = event.target as HTMLElement | null;
      const matched = matchShortcutAction(event, shortcuts, {
        enabled: shortcutsEnabled,
        targetTagName: target?.tagName ?? null,
        isContentEditable: Boolean(target?.isContentEditable),
      });
      if (!matched) return;

      event.preventDefault();
      triggerShortcutAction(matched);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, shortcutsEnabled, rebindingAction, triggerShortcutAction]);

  // Sync shortcuts with Electron desktop globalShortcut when running from .deb package
  useEffect(() => {
    if (!window.screenRecDesktop?.syncShortcuts) return;
    const desktopPayload = shortcutsEnabled
      ? shortcuts.map((s) => ({
          action: s.action,
          accelerator: toElectronAccelerator(s.combo),
        }))
      : [];
    window.screenRecDesktop.syncShortcuts(desktopPayload).catch(() => undefined);
  }, [shortcuts, shortcutsEnabled]);

  useEffect(() => {
    if (!window.screenRecDesktop?.onShortcutTriggered) return;
    const unsubscribe = window.screenRecDesktop.onShortcutTriggered((action) => {
      if (!shortcutsEnabled || rebindingAction) return;
      triggerShortcutAction(action);
    });
    return unsubscribe;
  }, [shortcutsEnabled, rebindingAction, triggerShortcutAction]);

  const handleStudioStateChange = useCallback((state: StudioState, elapsed: number) => {
    setStudioState(state);
    setStudioElapsed(elapsed);
  }, []);

  const recordCombo = shortcuts.find((s) => s.action === 'toggleRecord')?.combo || 'F9';
  const pauseCombo = shortcuts.find((s) => s.action === 'togglePause')?.combo || 'F10';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeView={activeView}
        recordingsCount={recordings.length}
        isInstalledDesktop={Boolean(systemInfo?.isInstalledDesktop || window.screenRecDesktop?.isDesktopApp)}
        onSelectView={setActiveView}
      />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <nav
          aria-label="Mobile view navigation"
          className="flex md:hidden items-center gap-1 p-1 bg-slate-200/70 rounded-lg"
        >
          {(
            [
              { id: 'recorder', label: 'Recorder' },
              {
                id: 'recordings',
                label: recordings.length > 0 ? `Clips (${recordings.length})` : 'Clips',
              },
              { id: 'shortcuts', label: 'Shortcuts' },
              { id: 'debian', label: '.deb' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveView(tab.id)}
              aria-current={activeView === tab.id ? 'page' : undefined}
              className={`flex-1 min-h-[40px] px-2 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                activeView === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Global Recording Bar when recording or paused on non-recorder views */}
        {activeView !== 'recorder' &&
          (studioState === 'recording' ||
            studioState === 'paused' ||
            studioState === 'converting') && (
            <div
              role="status"
              aria-live="polite"
              data-testid="global-recording-banner"
              className="bg-white border border-slate-200 rounded-xl px-5 py-3 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex items-center gap-2 text-xs text-slate-700">
                <span className="font-semibold text-slate-900">
                  {studioState === 'converting'
                    ? 'Finalizing MP4 File'
                    : studioState === 'paused'
                      ? 'Recording Paused'
                      : 'Recording Active'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatDuration(studioElapsed)}
                </span>
              </div>

              {studioState !== 'converting' && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => triggerShortcutAction('togglePause')}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {studioState === 'paused' ? 'Resume' : 'Pause'} ({pauseCombo})
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerShortcutAction('toggleRecord')}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Stop & Save MP4 ({recordCombo})
                  </button>
                </div>
              )}
            </div>
          )}

        <div className={activeView === 'recorder' ? 'block' : 'hidden'}>
          <RecorderStudio
            ref={recorderRef}
            systemInfo={systemInfo}
            systemLoading={systemLoading}
            simulationMode={simulationMode}
            shortcuts={shortcuts}
            onChangeSimulationMode={setSimulationMode}
            onClipSaved={handleClipSaved}
            onStateChange={handleStudioStateChange}
          />
        </div>

        {activeView === 'recordings' && (
          <RecordingsList
            clips={recordings}
            onDeleteClip={handleDeleteClip}
            onGoToRecorder={() => setActiveView('recorder')}
          />
        )}

        {activeView === 'shortcuts' && (
          <ShortcutsPanel
            shortcuts={shortcuts}
            shortcutsEnabled={shortcutsEnabled}
            rebindingAction={rebindingAction}
            onSetShortcutsEnabled={setShortcutsEnabled}
            onSetRebindingAction={setRebindingAction}
            onUpdateShortcuts={handleUpdateShortcuts}
          />
        )}

        {activeView === 'debian' && <DebianReleasePanel systemInfo={systemInfo} />}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>ScreenRec for Debian-based Linux distributions</span>
          <span>
            Shortcuts: {recordCombo} Start/Stop · {pauseCombo} Pause · MP4 (H.264 / AAC)
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
