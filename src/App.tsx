import React, { useCallback, useEffect, useState } from 'react';
import { TopBar } from './components/TopBar';
import { RecorderStudio } from './components/RecorderStudio';
import { RecordingsList } from './components/RecordingsList';
import { DebianReleasePanel } from './components/DebianReleasePanel';
import type { ActiveView, RecordedClip, SystemInfo } from './types';

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>('recorder');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemLoading, setSystemLoading] = useState<boolean>(true);
  const [simulationMode, setSimulationMode] = useState<'auto' | 'wayland' | 'x11'>('auto');
  const [recordings, setRecordings] = useState<RecordedClip[]>([]);

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

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeView={activeView}
        recordingsCount={recordings.length}
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
                label: recordings.length > 0 ? `Recordings (${recordings.length})` : 'Recordings',
              },
              { id: 'debian', label: 'Debian .deb' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveView(tab.id)}
              aria-current={activeView === tab.id ? 'page' : undefined}
              className={`flex-1 min-h-[40px] px-2.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                activeView === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeView === 'recorder' && (
          <RecorderStudio
            systemInfo={systemInfo}
            systemLoading={systemLoading}
            simulationMode={simulationMode}
            onChangeSimulationMode={setSimulationMode}
            onClipSaved={handleClipSaved}
          />
        )}

        {activeView === 'recordings' && (
          <RecordingsList
            clips={recordings}
            onDeleteClip={handleDeleteClip}
            onGoToRecorder={() => setActiveView('recorder')}
          />
        )}

        {activeView === 'debian' && <DebianReleasePanel systemInfo={systemInfo} />}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>ScreenRec for Debian-based Linux distributions</span>
          <span>MP4 (H.264 / AAC) · X11 & Wayland Auto-Detection · .deb Release Ready</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
