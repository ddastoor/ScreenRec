export type ShortcutActionId =
  | 'toggleRecord'
  | 'togglePause'
  | 'toggleDemoRecord'
  | 'toggleSystemAudio'
  | 'toggleMic'
  | 'toggleCursor';

export interface ShortcutBinding {
  action: ShortcutActionId;
  label: string;
  description: string;
  combo: string;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

export const SHORTCUTS_STORAGE_KEY = 'screenrec.shortcuts.v1';

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    action: 'toggleRecord',
    label: 'Start / Stop Recording',
    description: 'Begins screen capture when idle, or stops and exports MP4 when active.',
    combo: 'F9',
  },
  {
    action: 'togglePause',
    label: 'Pause / Resume Recording',
    description: 'Pauses an active recording or resumes a paused recording.',
    combo: 'F10',
  },
  {
    action: 'toggleDemoRecord',
    label: 'Start / Stop Test Screen',
    description: 'Starts or stops a simulated screen capture for quick audio/MP4 testing.',
    combo: 'Shift+F9',
  },
  {
    action: 'toggleSystemAudio',
    label: 'Toggle System Audio',
    description: 'Enables or mutes desktop / tab audio before starting a recording.',
    combo: 'Alt+S',
  },
  {
    action: 'toggleMic',
    label: 'Toggle Microphone',
    description: 'Enables or disables microphone voiceover before starting a recording.',
    combo: 'Alt+M',
  },
  {
    action: 'toggleCursor',
    label: 'Toggle Mouse Cursor',
    description: 'Shows or hides the mouse pointer in the screencast (works live).',
    combo: 'Alt+C',
  },
];

const MODIFIER_ONLY_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
]);

/**
 * Normalizes a KeyboardEvent into a canonical shortcut string such as
 * "F9", "F10", "Shift+F9", "Ctrl+Shift+R", or "Alt+M".
 * Returns null if only modifier keys are pressed.
 */
export function normalizeKeyboardEvent(event: KeyEventLike): string | null {
  if (!event.key || MODIFIER_ONLY_KEYS.has(event.key)) {
    return null;
  }

  let baseKey = event.key;

  // Use physical KeyX code when Alt produces special characters on certain layouts
  if (event.code && /^Key[A-Z]$/.test(event.code)) {
    baseKey = event.code.slice(3).toUpperCase();
  } else if (event.code && /^Digit[0-9]$/.test(event.code)) {
    baseKey = event.code.slice(5);
  } else if (/^f([1-9]|1[0-2])$/i.test(baseKey)) {
    baseKey = baseKey.toUpperCase();
  } else if (baseKey === ' ') {
    baseKey = 'Space';
  } else if (baseKey.length === 1) {
    baseKey = baseKey.toUpperCase();
  }

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(baseKey);

  return parts.join('+');
}

/**
 * Determines whether a global keyboard shortcut should be ignored because focus
 * is inside a text input, textarea, select, or contentEditable element.
 * Function-key combos (F1-F12) remain active globally even when a form control is focused.
 */
export function shouldIgnoreShortcutEvent(
  event: KeyEventLike,
  targetTagName?: string | null,
  isContentEditable?: boolean
): boolean {
  if (event.repeat) return true;

  const normalized = normalizeKeyboardEvent(event);
  if (!normalized) return true;

  const isFunctionKeyCombo = /(?:^|\+)F([1-9]|1[0-2])$/.test(normalized);
  if (isFunctionKeyCombo) {
    return false;
  }

  const tag = (targetTagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isContentEditable) {
    return true;
  }

  return false;
}

/**
 * Finds the matching ShortcutActionId for a KeyboardEvent, if any.
 */
export function matchShortcutAction(
  event: KeyEventLike,
  bindings: ShortcutBinding[],
  opts?: { targetTagName?: string | null; isContentEditable?: boolean; enabled?: boolean }
): ShortcutActionId | null {
  if (opts?.enabled === false) return null;
  if (shouldIgnoreShortcutEvent(event, opts?.targetTagName, opts?.isContentEditable)) {
    return null;
  }

  const combo = normalizeKeyboardEvent(event);
  if (!combo) return null;

  const found = bindings.find((b) => b.combo.toLowerCase() === combo.toLowerCase());
  return found ? found.action : null;
}

/**
 * Updates a single action's shortcut combo, rejecting empty or conflicting bindings.
 */
export function updateShortcutBinding(
  bindings: ShortcutBinding[],
  action: ShortcutActionId,
  newCombo: string
): { ok: true; bindings: ShortcutBinding[] } | { ok: false; error: string } {
  const trimmed = newCombo.trim();
  if (!trimmed) {
    return { ok: false, error: 'Shortcut combination cannot be empty.' };
  }

  const conflict = bindings.find(
    (b) => b.action !== action && b.combo.toLowerCase() === trimmed.toLowerCase()
  );
  if (conflict) {
    return {
      ok: false,
      error: `"${trimmed}" is already assigned to "${conflict.label}".`,
    };
  }

  const next = bindings.map((b) => (b.action === action ? { ...b, combo: trimmed } : b));
  return { ok: true, bindings: next };
}

/**
 * Safely parses stored custom shortcut overrides and merges with DEFAULT_SHORTCUTS.
 */
export function parseStoredShortcuts(rawJson: string | null): ShortcutBinding[] {
  if (!rawJson) return DEFAULT_SHORTCUTS.map((b) => ({ ...b }));
  try {
    const parsed = JSON.parse(rawJson) as Partial<Record<ShortcutActionId, string>>;
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_SHORTCUTS.map((b) => ({ ...b }));
    }

    const usedCombos = new Set<string>();
    return DEFAULT_SHORTCUTS.map((def) => {
      const candidate = typeof parsed[def.action] === 'string' ? parsed[def.action]!.trim() : '';
      const chosen = candidate && !usedCombos.has(candidate.toLowerCase()) ? candidate : def.combo;
      usedCombos.add(chosen.toLowerCase());
      return { ...def, combo: chosen };
    });
  } catch {
    return DEFAULT_SHORTCUTS.map((b) => ({ ...b }));
  }
}

export function serializeShortcuts(bindings: ShortcutBinding[]): string {
  const map: Record<string, string> = {};
  for (const b of bindings) {
    map[b.action] = b.combo;
  }
  return JSON.stringify(map);
}

/**
 * Converts canonical combo string (e.g. "Ctrl+Shift+R", "F9") to Electron globalShortcut format.
 */
export function toElectronAccelerator(combo: string): string {
  return combo.replace(/\bCtrl\b/g, 'CommandOrControl');
}
