import React, { useState } from 'react';
import { Download, Film, Play, Search, Trash2 } from 'lucide-react';
import type { RecordedClip } from '../types';
import { formatBytes, formatDuration } from '../utils/recorderConfig';

interface RecordingsListProps {
  clips: RecordedClip[];
  onDeleteClip: (id: string) => void;
  onGoToRecorder: () => void;
}

export const RecordingsList: React.FC<RecordingsListProps> = ({
  clips,
  onDeleteClip,
  onGoToRecorder,
}) => {
  const [query, setQuery] = useState<string>('');
  const [activeClipId, setActiveClipId] = useState<string | null>(clips[0]?.id ?? null);

  const filtered = clips.filter((clip) =>
    clip.filename.toLowerCase().includes(query.trim().toLowerCase())
  );

  const selectedClip =
    filtered.find((c) => c.id === activeClipId) || filtered[0] || null;

  if (clips.length === 0) {
    return (
      <section
        aria-labelledby="recordings-empty-heading"
        className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-4"
      >
        <Film className="w-10 h-10 text-slate-400 mx-auto" aria-hidden="true" />
        <div className="space-y-1 max-w-md mx-auto">
          <h1 id="recordings-empty-heading" className="text-lg font-bold text-slate-900">
            No MP4 recordings saved yet
          </h1>
          <p className="text-sm text-slate-600">
            Completed screen, window, and tab recordings are encoded into H.264 MP4 files and listed
            here for instant playback or download.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoToRecorder}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
        >
          <span>Create First Recording</span>
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="recordings-heading" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="recordings-heading" className="text-xl font-bold text-slate-900">
            Saved MP4 Recordings
          </h1>
          <p className="text-sm text-slate-600">
            Preview or download your recorded MP4 screencasts from this session.
          </p>
        </div>

        <div className="relative w-full sm:w-64">
          <label htmlFor="search-recordings" className="sr-only">
            Filter recordings by filename
          </label>
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="search-recordings"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter filenames..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-2 focus:outline-slate-900"
          />
        </div>
      </div>

      {selectedClip && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span className="font-mono font-semibold text-slate-900">{selectedClip.filename}</span>
            <span>
              {formatDuration(selectedClip.durationSeconds)} · {formatBytes(selectedClip.sizeBytes)}{' '}
              · {selectedClip.includeCursor ? 'Cursor Shown' : 'Cursor Hidden'}
            </span>
          </div>
          <div className="bg-slate-950 rounded-lg overflow-hidden max-h-[380px] flex items-center justify-center">
            <video
              key={selectedClip.url}
              src={selectedClip.url}
              controls
              playsInline
              className="w-full max-h-[380px] object-contain"
            />
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600 bg-slate-50">
              <th className="py-3 px-4">Filename</th>
              <th className="py-3 px-4">Capture Configuration</th>
              <th className="py-3 px-4 text-right">Duration</th>
              <th className="py-3 px-4 text-right">Size</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-sm">
            {filtered.map((clip) => (
              <tr key={clip.id} className="hover:bg-slate-50 transition-colors">
                <td className="py-3 px-4 font-mono text-xs text-slate-900">{clip.filename}</td>
                <td className="py-3 px-4 text-xs text-slate-600">
                  {clip.sourceType === 'monitor'
                    ? 'Entire Screen'
                    : clip.sourceType === 'window'
                      ? 'Window'
                      : 'Tab'}{' '}
                  · {clip.systemAudio ? 'System Audio' : 'No System Audio'} ·{' '}
                  {clip.micAudio ? 'Mic On' : 'Mic Off'} ·{' '}
                  {clip.includeCursor ? 'Cursor On' : 'Cursor Off'}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                  {formatDuration(clip.durationSeconds)}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                  {formatBytes(clip.sizeBytes)}
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setActiveClipId(clip.id)}
                      aria-label={`Play ${clip.filename}`}
                      className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <a
                      href={clip.url}
                      download={clip.filename}
                      aria-label={`Download ${clip.filename}`}
                      className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
                    <button
                      type="button"
                      onClick={() => onDeleteClip(clip.id)}
                      aria-label={`Delete ${clip.filename}`}
                      className="p-1.5 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
