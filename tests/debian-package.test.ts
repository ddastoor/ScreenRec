import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createApiApp } from '../src/server/createApp';

test('Native C11 + GTK3 unit tests compile and pass', () => {
  execFileSync('make', ['-C', 'native', 'bin/test_native_core'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  const out = execFileSync(path.resolve(process.cwd(), 'native/bin/test_native_core'), [], {
    encoding: 'utf-8',
  });
  assert.match(out, /\[OK\] All native C11 core unit tests passed\./);
});

test('Native GTK3 Debian .deb package builds ELF binary, satisfies multi-distro Debian dependencies, and passes GUI Wayland/X11 + Xvfb MP4 tests', async () => {
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
      version: string;
      arch: string;
      binaryFormat: string;
      sizeBytes: number;
      sha256: string;
      dpkgInfo: string;
    };

    assert.equal(info.version, '2.0.0');
    assert.equal(info.fileName, 'screenrec_2.0.0_amd64.deb');
    assert.equal(info.arch, 'amd64');
    assert.match(info.binaryFormat, /ELF 64-bit/);
    assert.ok(info.sizeBytes > 8000, 'Expected non-empty .deb archive');
    assert.equal(info.sha256.length, 64);
    assert.match(info.dpkgInfo, /Package: screenrec/);

    // Multi-distro Debian safety:
    // 1. Must use `libgtk-3-bin` (concrete package in both pre-t64 Debian 12 / Ubuntu 22.04 / MX 23
    //    AND post-t64 Ubuntu 24.04+ / Debian 13 / Mint 22 / Kali) rather than ABI-renamed libgtk-3-0t64.
    assert.match(
      info.dpkgInfo,
      /Depends: libc6, libgtk-3-bin, libx11-6, ffmpeg, x11-utils, pulseaudio-utils/
    );
    assert.equal(
      info.dpkgInfo.includes('libgtk-3-0t64'),
      false,
      'Must not hardcode t64-only library package name that breaks Debian 12 / Ubuntu 22.04 / MX Linux'
    );

    // 2. Zero '|' pipe OR-alternates in Depends/Recommends so KDE Discover (aptcc), GNOME Software,
    //    GDebi, MintInstall, and MX Package Installer never fail local .deb resolution.
    const depLines = info.dpkgInfo
      .split('\n')
      .filter((l) => /^\s*(Depends|Recommends):/.test(l));
    assert.ok(depLines.length >= 2);
    for (const line of depLines) {
      assert.equal(
        line.includes('|'),
        false,
        `GUI installer compatibility violation: pipe '|' found in ${line}`
      );
    }

    const debRes = await fetch(`${baseUrl}/api/package/deb`);
    assert.equal(debRes.status, 200);
    const debBuffer = Buffer.from(await debRes.arrayBuffer());
    assert.equal(debBuffer.byteLength, info.sizeBytes);
    assert.equal(debBuffer.subarray(0, 8).toString('ascii'), '!<arch>\n');

    const builtPath = path.resolve(process.cwd(), 'dist-deb', info.fileName);
    const contents = execFileSync('dpkg-deb', ['--contents', builtPath], { encoding: 'utf-8' });
    assert.match(contents, /\.\/usr\/bin\/screenrec/);
    assert.match(contents, /\.\/usr\/share\/applications\/screenrec\.desktop/);
    assert.match(contents, /\.\/usr\/share\/metainfo\/screenrec\.metainfo\.xml/);
    assert.match(contents, /\.\/usr\/share\/icons\/hicolor\/scalable\/apps\/screenrec\.svg/);
    assert.match(contents, /\.\/usr\/share\/icons\/hicolor\/128x128\/apps\/screenrec\.png/);
    assert.match(contents, /\.\/usr\/share\/pixmaps\/screenrec\.png/);
    // Ensure NO legacy localhost web wrapper or /opt/screenrec scripts exist in the native .deb
    assert.equal(contents.includes('/opt/screenrec'), false);

    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-native-deb-'));
    try {
      execFileSync('dpkg-deb', ['-x', builtPath, isolatedRoot]);
      const controlDir = path.join(isolatedRoot, 'DEBIAN-check');
      execFileSync('dpkg-deb', ['-e', builtPath, controlDir]);

      // 1. Verify /usr/bin/screenrec is a genuine compiled 64-bit ELF binary linked with GTK3 & X11
      const elfPath = path.join(isolatedRoot, 'usr', 'bin', 'screenrec');
      const elfBytes = fs.readFileSync(elfPath);
      assert.deepEqual(
        Array.from(elfBytes.subarray(0, 4)),
        [0x7f, 0x45, 0x4c, 0x46],
        '/usr/bin/screenrec must be a natively compiled ELF binary (not a shell/Python/Node script)'
      );
      assert.equal(elfBytes[4], 2, 'Expected 64-bit ELFCLASS64 binary');

      const lddOut = execFileSync('ldd', [elfPath], { encoding: 'utf-8' });
      assert.match(lddOut, /libgtk-3\.so\.0/);
      assert.match(lddOut, /libX11\.so\.6/);

      // 2. Verify GLIBC symbol baseline <= 2.34 so binary runs across Ubuntu 22.04+, Debian 12+, Mint, MX 23
      const objdumpOut = execFileSync('objdump', ['-T', elfPath], { encoding: 'utf-8' });
      const glibcVersions = Array.from(objdumpOut.matchAll(/GLIBC_(\d+)\.(\d+)/g)).map((m) => ({
        major: Number(m[1]),
        minor: Number(m[2]),
      }));
      assert.ok(glibcVersions.length > 0);
      for (const v of glibcVersions) {
        assert.ok(
          v.major < 2 || (v.major === 2 && v.minor <= 36),
          `Found symbol requiring GLIBC_${v.major}.${v.minor} which would break older Debian/Ubuntu releases`
        );
      }

      // 3. Verify --version output
      const verOut = execFileSync(elfPath, ['--version'], { encoding: 'utf-8' }).trim();
      assert.equal(verOut, 'ScreenRec 2.0.0 (Native GTK3 C11)');

      // 4. Verify DEBIAN/postinst and DEBIAN/md5sums integrity
      const postinstPath = path.join(controlDir, 'postinst');
      const postinstSrc = fs.readFileSync(postinstPath, 'utf-8');
      assert.equal(postinstSrc.includes('pkill'), false);
      execFileSync('sh', [postinstPath, 'configure'], { stdio: 'ignore' });

      const md5Entries = fs
        .readFileSync(path.join(controlDir, 'md5sums'), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.ok(md5Entries.length >= 7);
      for (const entry of md5Entries) {
        const [expectedMd5, relFile] = entry.split(/\s{2}/);
        const actualMd5 = crypto
          .createHash('md5')
          .update(fs.readFileSync(path.join(isolatedRoot, relFile)))
          .digest('hex');
        assert.equal(actualMd5, expectedMd5, `MD5 mismatch for ${relFile}`);
      }

      // 5. Blank-environment GUI launch test: auto-detects Wayland purely from socket (zero CLI env vars!)
      const simRuntimeDir = path.join(isolatedRoot, 'sim-wayland-runtime');
      fs.mkdirSync(simRuntimeDir, { recursive: true });
      fs.writeFileSync(path.join(simRuntimeDir, 'wayland-0'), '');
      fs.writeFileSync(path.join(simRuntimeDir, 'wayland-0.lock'), '');

      const probeJsonRaw = execFileSync(elfPath, ['--probe-json'], {
        cwd: isolatedRoot,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: isolatedRoot,
          XDG_RUNTIME_DIR: simRuntimeDir,
          // Deliberately NO DISPLAY, NO WAYLAND_DISPLAY, NO XDG_SESSION_TYPE!
        },
        encoding: 'utf-8',
      }).trim();

      const probe = JSON.parse(probeJsonRaw) as {
        version: string;
        nativeGtk: boolean;
        distro: string;
        protocol: string;
        waylandDisplay: string;
        detectedVia: string;
      };
      assert.equal(probe.version, '2.0.0');
      assert.equal(probe.nativeGtk, true);
      assert.ok(probe.distro.length > 0);
      assert.equal(probe.protocol, 'wayland');
      assert.equal(probe.waylandDisplay, 'wayland-0');
      assert.match(probe.detectedVia, /Wayland socket/);

      // 6. Live headless Xvfb GTK3 window render + real X11grab H.264 MP4 capture test using extracted .deb binary!
      const screenshotOut = path.join(isolatedRoot, 'deb-gtk-window.png');
      const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], {
        stdio: 'ignore',
      });
      try {
        await new Promise((r) => setTimeout(r, 650));
        execFileSync(elfPath, ['--gui-self-test', screenshotOut], {
          cwd: isolatedRoot,
          env: {
            ...process.env,
            HOME: isolatedRoot,
            XDG_CONFIG_HOME: path.join(isolatedRoot, '.config'),
            DISPLAY: ':97',
            WAYLAND_DISPLAY: '',
            XDG_SESSION_TYPE: 'x11',
          },
          stdio: 'pipe',
        });
        assert.equal(fs.existsSync(screenshotOut), true, 'Expected rendered GTK3 window PNG');
        const pngHeader = fs.readFileSync(screenshotOut).subarray(0, 8);
        assert.deepEqual(
          Array.from(pngHeader),
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        );
      } finally {
        xvfb.kill('SIGTERM');
      }
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GitHub Release & CI workflows compile native C11 + GTK3 app on ubuntu-22.04 for multi-distro compatibility', () => {
  const releaseYml = fs.readFileSync(
    path.resolve(process.cwd(), '.github/workflows/release.yml'),
    'utf-8'
  );
  assert.match(releaseYml, /runs-on:\s*ubuntu-22\.04/);
  assert.match(releaseYml, /libgtk-3-dev/);
  assert.match(releaseYml, /make -C native clean && make -C native test/);
  assert.match(releaseYml, /npm run build:deb/);
  assert.match(releaseYml, /softprops\/action-gh-release@v2/);
  assert.equal(releaseYml.includes('electron-builder'), false);
});
