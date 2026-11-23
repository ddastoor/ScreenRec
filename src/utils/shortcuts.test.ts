import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHORTCUTS,
  normalizeKeyboardEvent,
  shouldIgnoreShortcutEvent,
  matchShortcutAction,
  updateShortcutBinding,
  parseStoredShortcuts,
  serializeShortcuts,
  toElectronAccelerator,
} from './shortcuts';

test('normalizes function keys and modifier combinations consistently', () => {
  assert.equal(normalizeKeyboardEvent({ key: 'F9' }), 'F9');
  assert.equal(normalizeKeyboardEvent({ key: 'f10' }), 'F10');
  assert.equal(normalizeKeyboardEvent({ key: 'F9', shiftKey: true }), 'Shift+F9');
  assert.equal(
    normalizeKeyboardEvent({ key: 'm', code: 'KeyM', altKey: true }),
    'Alt+M'
  );
  assert.equal(
    normalizeKeyboardEvent({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }),
    'Ctrl+Shift+R'
  );
  // Bare modifier presses return null
  assert.equal(normalizeKeyboardEvent({ key: 'Shift', shiftKey: true }), null);
  assert.equal(normalizeKeyboardEvent({ key: 'Alt', altKey: true }), null);
});

test('matches default F9, F10, Shift+F9, Alt+S, Alt+M, and Alt+C shortcuts accurately', () => {
  assert.equal(matchShortcutAction({ key: 'F9' }, DEFAULT_SHORTCUTS), 'toggleRecord');
  assert.equal(matchShortcutAction({ key: 'F10' }, DEFAULT_SHORTCUTS), 'togglePause');
  assert.equal(
    matchShortcutAction({ key: 'F9', shiftKey: true }, DEFAULT_SHORTCUTS),
    'toggleDemoRecord'
  );
  assert.equal(
    matchShortcutAction({ key: 's', code: 'KeyS', altKey: true }, DEFAULT_SHORTCUTS),
    'toggleSystemAudio'
  );
  assert.equal(
    matchShortcutAction({ key: 'm', code: 'KeyM', altKey: true }, DEFAULT_SHORTCUTS),
    'toggleMic'
  );
  assert.equal(
    matchShortcutAction({ key: 'c', code: 'KeyC', altKey: true }, DEFAULT_SHORTCUTS),
    'toggleCursor'
  );
});

test('ignores key repeats, disabled state, and non-function shortcuts inside form inputs', () => {
  assert.equal(
    matchShortcutAction({ key: 'F9', repeat: true }, DEFAULT_SHORTCUTS),
    null
  );
  assert.equal(
    matchShortcutAction({ key: 'F9' }, DEFAULT_SHORTCUTS, { enabled: false }),
    null
  );
  // Typing or Alt+M inside an INPUT is ignored, while F9/F10 still work globally
  assert.equal(
    shouldIgnoreShortcutEvent({ key: 'm', code: 'KeyM', altKey: true }, 'INPUT', false),
    true
  );
  assert.equal(
    shouldIgnoreShortcutEvent({ key: 'F9' }, 'INPUT', false),
    false
  );
});

test('updates custom shortcut bindings and prevents duplicate key conflicts', () => {
  const conflict = updateShortcutBinding(DEFAULT_SHORTCUTS, 'togglePause', 'f9');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.match(conflict.error, /already assigned/i);
  }

  const valid = updateShortcutBinding(DEFAULT_SHORTCUTS, 'togglePause', 'F8');
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(matchShortcutAction({ key: 'F8' }, valid.bindings), 'togglePause');
    const serialized = serializeShortcuts(valid.bindings);
    const restored = parseStoredShortcuts(serialized);
    assert.equal(restored.find((b) => b.action === 'togglePause')?.combo, 'F8');
  }
});

test('formats Electron globalShortcut accelerators cleanly', () => {
  assert.equal(toElectronAccelerator('F9'), 'F9');
  assert.equal(toElectronAccelerator('Ctrl+Shift+R'), 'CommandOrControl+Shift+R');
});
