import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDisplayMediaConstraints,
  formatDuration,
  formatBytes,
  createMp4Filename,
  selectSupportedRecorderMimeType,
} from './recorderConfig';

test('builds DisplayMedia constraints respecting source surface, system audio, and cursor toggle', () => {
  const withCursorAndAudio = buildDisplayMediaConstraints({
    sourceType: 'window',
    systemAudio: true,
    micAudio: false,
    includeCursor: true,
  });
  const videoOn = withCursorAndAudio.video as Record<string, unknown>;
  assert.equal(videoOn.displaySurface, 'window');
  assert.equal(videoOn.cursor, 'always');
  assert.notEqual(withCursorAndAudio.audio, false);

  const withoutCursorNoAudio = buildDisplayMediaConstraints({
    sourceType: 'monitor',
    systemAudio: false,
    micAudio: true,
    includeCursor: false,
  });
  const videoOff = withoutCursorNoAudio.video as Record<string, unknown>;
  assert.equal(videoOff.displaySurface, 'monitor');
  assert.equal(videoOff.cursor, 'never');
  assert.equal(withoutCursorNoAudio.audio, false);
});

test('formats durations and byte sizes cleanly', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(3661), '01:01:01');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('creates .mp4 filenames with source type and timestamp', () => {
  const date = new Date(2026, 10, 22, 14, 5, 9);
  const name = createMp4Filename('browser', date);
  assert.equal(name, 'screenrec-tab-2026-11-22-140509.mp4');
  assert.ok(name.endsWith('.mp4'));
});

test('selects MP4 MIME type when available and falls back to WebM cleanly', () => {
  const mp4Supported = selectSupportedRecorderMimeType((m) => m === 'video/mp4');
  assert.equal(mp4Supported, 'video/mp4');

  const webmFallback = selectSupportedRecorderMimeType((m) => m === 'video/webm;codecs=vp8,opus');
  assert.equal(webmFallback, 'video/webm;codecs=vp8,opus');
});
