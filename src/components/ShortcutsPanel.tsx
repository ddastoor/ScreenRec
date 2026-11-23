import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SHORTCUTS,
  normalizeKeyboardEvent,
  updateShortcutBinding,
  type ShortcutActionId,
  type ShortcutBinding,
} from '../utils/shortcuts';

interface ShortcutsPanelProps {
  shortcuts: ShortcutBinding[];
  shortcutsEnabled: boolean;
  rebindingAction: ShortcutActionId | null;
  onSetShortcutsEnabled: (enabled: boolean) => void;
  onSetRebindingAction: (action: ShortcutActionId | null) => void;
  onUpdateShortcuts: (next: ShortcutBinding[]) => void;
}

export const ShortcutsPanel: React.FC<ShortcutsPanelProps> = ({
  shortcuts,
  shortcutsEnabled,
  rebindingAction,
  onSetShortcutsEnabled,
  onSetRebindingAction,
  onUpdateShortcuts,
}) => {
  const [conflictError, setConflictError] = useState<string | null>(null);

  useEffect(() => {
    if (!rebindingAction) return;

    const handleCaptureKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        onSetRebindingAction(null);
        setConflictError(null);
        return;
      }

      const combo = normalizeKeyboardEvent(e);
      if (!combo) return;

      const result = updateShortcutBinding(shortcuts, rebindingAction, combo);
      if (!result.ok) {
        setConflictError(result.error);
        return;
      }

      setConflictError(null);
      onUpdateShortcuts(result.bindings);
      onSetRebindingAction(null);
    };

    window.addEventListener('keydown', handleCaptureKey, true);
    return () => {
      window.removeEventListener('keydown', handleCaptureKey, true);
    };
  }, [rebindingAction, shortcuts, onUpdateShortcuts, onSetRebindingAction]);

  const handleResetDefaults = () => {
    setConflictError(null);
    onSetRebindingAction(null);
    onUpdateShortcuts(DEFAULT_SHORTCUTS.map((b) => ({ ...b })));
  };

  return (
    <section aria-labelledby="shortcuts-heading" className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <h1 id="shortcuts-heading" className="text-xl font-bold text-slate-900">
              Global Keyboard Shortcuts
            </h1>
            <p className="text-sm text-slate-600">
              Control recording from any screen in ScreenRec—or system-wide via Electron{' '}
              <code className="font-mono">globalShortcut</code> when installed from the Debian{' '}
              <code className="font-mono">.deb</code> package.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={shortcutsEnabled}
                onChange={(e) => onSetShortcutsEnabled(e.target.checked)}
                className="w-4 h-4 accent-slate-900 rounded cursor-pointer"
              />
              <span>Enable Global Shortcuts</span>
            </label>

            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Reset Defaults</span>
            </button>
          </div>
        </div>

        {conflictError && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800"
          >
            {conflictError}
          </div>
        )}

        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Behavior</th>
                <th className="py-3 px-4 text-right">Shortcut</th>
                <th className="py-3 px-4 text-right">Customize</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {shortcuts.map((binding) => {
                const isListening = rebindingAction === binding.action;
                return (
                  <tr
                    key={binding.action}
                    className={`transition-colors ${
                      isListening ? 'bg-slate-50' : 'hover:bg-slate-50/70'
                    }`}
                  >
                    <td className="py-3.5 px-4 font-semibold text-xs text-slate-900 whitespace-nowrap">
                      {binding.label}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600">{binding.description}</td>
                    <td className="py-3.5 px-4 text-right">
                      <kbd
                        data-testid={`shortcut-combo-${binding.action}`}
                        className="font-mono text-xs font-semibold text-slate-900 bg-slate-100 border border-slate-300 rounded px-2 py-1 whitespace-nowrap"
                      >
                        {isListening ? 'Press keys... (Esc to cancel)' : binding.combo}
                      </kbd>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      {isListening ? (
                        <button
                          type="button"
                          onClick={() => {
                            onSetRebindingAction(null);
                            setConflictError(null);
                          }}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-200 hover:bg-slate-300 rounded-md transition-colors whitespace-nowrap"
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConflictError(null);
                            onSetRebindingAction(binding.action);
                          }}
                          aria-label={`Rebind ${binding.label}`}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
                        >
                          Rebind
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-500">
          Function keys (<code className="font-mono">F1</code>–<code className="font-mono">F12</code>)
          stay active across all views even while search or form inputs are focused. Custom bindings
          are saved automatically in local preferences.
        </p>
      </div>
    </section>
  );
};
