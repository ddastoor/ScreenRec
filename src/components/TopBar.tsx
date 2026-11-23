import React from 'react';
import { Download } from 'lucide-react';
import type { ActiveView } from '../types';

interface TopBarProps {
  activeView: ActiveView;
  recordingsCount: number;
  isInstalledDesktop?: boolean;
  onSelectView: (view: ActiveView) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  recordingsCount,
  isInstalledDesktop,
  onSelectView,
}) => {
  const navItems: { id: ActiveView; label: string }[] = [
    { id: 'recorder', label: 'Recorder' },
    {
      id: 'recordings',
      label: recordingsCount > 0 ? `Recordings (${recordingsCount})` : 'Recordings',
    },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'debian', label: 'Debian Installer' },
  ];

  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 py-4">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#recorder"
          onClick={(e) => {
            e.preventDefault();
            onSelectView('recorder');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
        >
          ScreenRec
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav aria-label="Primary" className="hidden md:flex items-center gap-6 text-sm font-medium">
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 ${
                  isActive
                    ? 'border-red-600 text-slate-900 font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          {isInstalledDesktop ? (
            <button
              type="button"
              onClick={() => onSelectView('recorder')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              <span>Recorder Studio</span>
            </button>
          ) : (
            <a
              href="/api/package/deb"
              download
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Download .deb</span>
            </a>
          )}
        </div>
      </div>
    </header>
  );
};
