import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApiApp } from '../src/server/createApp';

test('Debian .deb installer builds cleanly and passes dpkg-deb validation', async () => {
  const app = createApiApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind test port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const infoRes = await fetch(`${baseUrl}/api/package/deb-info`);
    assert.equal(infoRes.status, 200);
    const info = (await infoRes.json()) as {
      fileName: string;
      arch: string;
      sizeBytes: number;
      sha256: string;
      dpkgInfo: string;
    };

    assert.match(info.fileName, /^screenrec_.*_amd64\.deb$/);
    assert.equal(info.arch, 'amd64');
    assert.ok(info.sizeBytes > 1000);
    assert.equal(info.sha256.length, 64);
    assert.match(info.dpkgInfo, /Package: screenrec/);
    assert.match(info.dpkgInfo, /Depends:.*ffmpeg/);

    const debRes = await fetch(`${baseUrl}/api/package/deb`);
    assert.equal(debRes.status, 200);
    assert.match(
      debRes.headers.get('content-type') || '',
      /application\/vnd\.debian\.binary-package/
    );

    const debBuffer = Buffer.from(await debRes.arrayBuffer());
    assert.equal(debBuffer.byteLength, info.sizeBytes);
    // Standard Debian archive starts with '!<arch>\n'
    assert.equal(debBuffer.subarray(0, 8).toString('ascii'), '!<arch>\n');

    const builtPath = path.resolve(process.cwd(), 'dist-deb', info.fileName);
    const contents = execFileSync('dpkg-deb', ['--contents', builtPath], { encoding: 'utf-8' });
    assert.match(contents, /\.\/usr\/bin\/screenrec/);
    assert.match(contents, /\.\/usr\/share\/applications\/screenrec\.desktop/);
    assert.match(contents, /\.\/usr\/share\/icons\/hicolor\/scalable\/apps\/screenrec\.svg/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GitHub Release and Electron Wayland/X11 startup configurations are present and valid', () => {
  const releaseYml = fs.readFileSync(
    path.resolve(process.cwd(), '.github/workflows/release.yml'),
    'utf-8'
  );
  assert.match(releaseYml, /electron-builder --linux deb/);
  assert.match(releaseYml, /softprops\/action-gh-release@v2/);
  assert.match(releaseYml, /npm test/);

  const ciYml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf-8');
  assert.match(ciYml, /npm test/);
  assert.match(ciYml, /npm run build:deb/);

  const electronMain = fs.readFileSync(
    path.resolve(process.cwd(), 'electron/main.cjs'),
    'utf-8'
  );
  assert.match(electronMain, /detectStartupDisplayProtocol/);
  assert.match(electronMain, /WebRTCPipeWireCapturer/);
});
