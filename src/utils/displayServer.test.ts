import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDisplayServer,
  parseOsRelease,
  buildLinuxCapturePipelineSummary,
} from './displayServer';

test('auto-detects Wayland when XDG_SESSION_TYPE=wayland even if XWayland DISPLAY is present', () => {
  const res = detectDisplayServer({
    xdgSessionType: 'wayland',
    waylandDisplay: 'wayland-0',
    display: ':0',
    xdgCurrentDesktop: 'GNOME',
  });
  assert.equal(res.protocol, 'wayland');
  assert.equal(res.isXWaylandAvailable, true);
  assert.equal(res.label, 'Wayland (with XWayland)');
  assert.match(res.captureBackend, /PipeWire/);
});

test('auto-detects Wayland from WAYLAND_DISPLAY or runtime socket when XDG_SESSION_TYPE is unset', () => {
  const res = detectDisplayServer({
    waylandSockets: ['/run/user/1000/wayland-0'],
    xdgCurrentDesktop: 'KDE',
  });
  assert.equal(res.protocol, 'wayland');
  assert.equal(res.isXWaylandAvailable, false);
  assert.match(res.detectedVia, /wayland-0/);
});

test('auto-detects X11 when XDG_SESSION_TYPE=x11 or DISPLAY is set without Wayland', () => {
  const res = detectDisplayServer({
    xdgSessionType: 'x11',
    display: ':0.0',
    xdgCurrentDesktop: 'XFCE',
  });
  assert.equal(res.protocol, 'x11');
  assert.equal(res.label, 'X11 (X.Org Server)');
  assert.match(res.captureBackend, /x11grab/);
});

test('auto-detects Wayland with XWayland from GUI sockets alone when CLI env vars are unset', () => {
  const res = detectDisplayServer({
    waylandSockets: ['/run/user/1000/wayland-0'],
    x11Sockets: ['/tmp/.X11-unix/X0'],
  });
  assert.equal(res.protocol, 'wayland');
  assert.equal(res.isXWaylandAvailable, true);
  assert.equal(res.label, 'Wayland (with XWayland)');
  assert.match(res.detectedVia, /Wayland socket/);
});

test('auto-detects X11 from /tmp/.X11-unix socket or loginctl when CLI env vars are unset', () => {
  const fromSocket = detectDisplayServer({
    x11Sockets: ['/tmp/.X11-unix/X0'],
  });
  assert.equal(fromSocket.protocol, 'x11');
  assert.match(fromSocket.detectedVia, /X11 socket/);

  const fromLogind = detectDisplayServer({
    loginctlType: 'wayland',
  });
  assert.equal(fromLogind.protocol, 'wayland');
  assert.match(fromLogind.detectedVia, /logind/);
});

test('returns headless/web mode when neither X11 nor Wayland sockets exist', () => {
  const res = detectDisplayServer({});
  assert.equal(res.protocol, 'headless');
});

test('parses Debian and Ubuntu /etc/os-release accurately', () => {
  const debian = parseOsRelease(`
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian
`);
  assert.equal(debian.isDebianBased, true);
  assert.equal(debian.id, 'debian');
  assert.equal(debian.prettyName, 'Debian GNU/Linux 12 (bookworm)');

  const ubuntu = parseOsRelease(`
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04.1 LTS"
`);
  assert.equal(ubuntu.isDebianBased, true);
  assert.equal(ubuntu.id, 'ubuntu');
});

test('builds X11 and Wayland capture pipeline commands with cursor and audio flags', () => {
  const x11NoCursor = buildLinuxCapturePipelineSummary({
    protocol: 'x11',
    sourceType: 'monitor',
    systemAudio: true,
    micAudio: true,
    includeCursor: false,
    outputFile: 'out.mp4',
  });
  assert.match(x11NoCursor, /-draw_mouse 0/);
  assert.match(x11NoCursor, /amix=inputs=2/);
  assert.match(x11NoCursor, /-c:v libx264/);

  const waylandWithCursor = buildLinuxCapturePipelineSummary({
    protocol: 'wayland',
    sourceType: 'window',
    systemAudio: true,
    micAudio: false,
    includeCursor: true,
    outputFile: 'clip.mp4',
  });
  assert.match(waylandWithCursor, /cursor_mode=2 \(Embedded\)/);
  assert.match(waylandWithCursor, /source_type=2 \(Window\)/);
});
