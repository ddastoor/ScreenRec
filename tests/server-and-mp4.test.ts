import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApiApp } from '../src/server/createApp';
import { probeLinuxEnvironment } from '../src/server/systemProbe';

async function withTestServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApiApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind ephemeral test port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function generateWebmSample(opts: {
  withAudio: boolean;
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenrec-test-sample-'));
  const samplePath = path.join(tmpDir, 'sample.webm');
  const w = opts.width ?? 640;
  const h = opts.height ?? 360;

  try {
    const args = opts.withAudio
      ? [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `testsrc=duration=1:size=${w}x${h}:rate=15`,
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:v',
          'libvpx',
          '-c:a',
          'libopus',
          samplePath,
        ]
      : [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `testsrc=duration=1:size=${w}x${h}:rate=15`,
          '-c:v',
          'libvpx',
          '-an',
          samplePath,
        ];

    execFileSync('ffmpeg', args, { stdio: 'ignore' });
    return await fs.readFile(samplePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test('startup probe detects X11, Wayland, XWayland, and host OS capabilities', () => {
  const hostProbe = probeLinuxEnvironment();
  assert.equal(typeof hostProbe.os.prettyName, 'string');
  assert.equal(hostProbe.capabilities.ffmpegAvailable, true);
  assert.equal(hostProbe.capabilities.mp4H264Supported, true);
  assert.equal(hostProbe.capabilities.aacAudioSupported, true);

  const waylandProbe = probeLinuxEnvironment({
    xdgSessionType: 'wayland',
    waylandDisplay: 'wayland-0',
    display: ':0',
    xdgCurrentDesktop: 'GNOME',
  });
  assert.equal(waylandProbe.displayServer.protocol, 'wayland');
  assert.equal(waylandProbe.displayServer.isXWaylandAvailable, true);

  const x11Probe = probeLinuxEnvironment({
    xdgSessionType: 'x11',
    display: ':0.0',
    xdgCurrentDesktop: 'KDE',
  });
  assert.equal(x11Probe.displayServer.protocol, 'x11');

  const socketOnlyWayland = probeLinuxEnvironment({
    waylandSockets: ['/run/user/1000/wayland-1'],
  });
  assert.equal(socketOnlyWayland.displayServer.protocol, 'wayland');
  assert.equal(socketOnlyWayland.displayServer.details.waylandDisplay, '/run/user/1000/wayland-1');

  const loginctlX11 = probeLinuxEnvironment({
    loginctlType: 'x11',
  });
  assert.equal(loginctlX11.displayServer.protocol, 'x11');
});

test('GET /api/health and /api/system-info expose startup X11/Wayland detection', async () => {
  await withTestServer(async (baseUrl) => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; startupDisplayProtocol: string };
    assert.equal(health.status, 'ok');
    assert.ok(['wayland', 'x11', 'headless'].includes(health.startupDisplayProtocol));

    const waylandRes = await fetch(`${baseUrl}/api/system-info?simulate=wayland`);
    assert.equal(waylandRes.status, 200);
    const waylandJson = (await waylandRes.json()) as {
      displayServer: { protocol: string; label: string };
    };
    assert.equal(waylandJson.displayServer.protocol, 'wayland');

    const x11Res = await fetch(`${baseUrl}/api/system-info?simulate=x11`);
    assert.equal(x11Res.status, 200);
    const x11Json = (await x11Res.json()) as {
      displayServer: { protocol: string; label: string };
    };
    assert.equal(x11Json.displayServer.protocol, 'x11');
  });
});

test('POST /api/convert-mp4 converts WebM video+audio into valid H.264/AAC MP4', async () => {
  const webmWithAudio = await generateWebmSample({ withAudio: true });

  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/convert-mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(webmWithAudio),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /video\/mp4/);

    const mp4Bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(mp4Bytes.byteLength > 500, 'Expected non-trivial MP4 byte size');

    // Verify ISO Base Media File Format (MP4) 'ftyp' box header at bytes 4..8
    const boxType = mp4Bytes.subarray(4, 8).toString('ascii');
    assert.equal(boxType, 'ftyp');

    // Verify streams inside the output MP4 contain h264 video and aac audio
    const tmpOut = path.join(os.tmpdir(), `verify-${Date.now()}.mp4`);
    await fs.writeFile(tmpOut, mp4Bytes);
    try {
      let ffmpegInspect = '';
      try {
        execFileSync('ffmpeg', ['-i', tmpOut], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e) {
        ffmpegInspect = (e as { stderr?: string }).stderr || '';
      }
      assert.match(ffmpegInspect, /Video: h264/);
      assert.match(ffmpegInspect, /Audio: aac/);
    } finally {
      await fs.rm(tmpOut, { force: true });
    }
  });
});

test('POST /api/convert-mp4 handles silent video-only recordings and odd window dimensions', async () => {
  // 321x241 tests odd-width/odd-height window capture scaling for yuv420p H.264 compatibility
  const silentOddWebm = await generateWebmSample({
    withAudio: false,
    width: 321,
    height: 241,
  });

  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/convert-mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(silentOddWebm),
    });

    assert.equal(res.status, 200);
    const mp4Bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(mp4Bytes.subarray(4, 8).toString('ascii'), 'ftyp');
  });
});

test('POST /api/convert-mp4 rejects empty payloads with 400 Bad Request', async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/convert-mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    assert.equal(res.status, 400);
  });
});
