#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function getLatestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const full = path.join(targetPath, entry.name);
    const mtime = getLatestMtimeMs(full);
    if (mtime > latest) latest = mtime;
  }
  return latest;
}

function hasNativeGtkCompilerToolchain() {
  try {
    execFileSync('gcc', ['--version'], { stdio: 'ignore' });
    execFileSync('pkg-config', ['--exists', 'gtk+-3.0', 'gio-unix-2.0', 'x11'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles the native C11 + GTK3 ELF desktop executable (/usr/bin/screenrec)
 * from native/src/*.c when gcc + libgtk-3-dev headers are available, or uses
 * the precompiled stripped ELF binary in native/bin/screenrec when running in
 * a minimal container without -dev headers.
 */
function ensureNativeGtkBinary() {
  const binDir = path.join(ROOT_DIR, 'native', 'bin');
  const binPath = path.join(binDir, 'screenrec');
  const srcDir = path.join(ROOT_DIR, 'native', 'src');

  const binMtime = fs.existsSync(binPath) ? fs.statSync(binPath).mtimeMs : 0;
  const srcMtime = getLatestMtimeMs(srcDir);

  if ((!binMtime || srcMtime > binMtime) && hasNativeGtkCompilerToolchain()) {
    fs.mkdirSync(binDir, { recursive: true });
    const cflagsRaw = execFileSync(
      'pkg-config',
      ['--cflags', 'gtk+-3.0', 'gio-unix-2.0', 'x11'],
      { encoding: 'utf-8' }
    ).trim();
    const libsRaw = execFileSync(
      'pkg-config',
      ['--libs', 'gtk+-3.0', 'gio-unix-2.0', 'x11'],
      { encoding: 'utf-8' }
    ).trim();

    const cflags = cflagsRaw ? cflagsRaw.split(/\s+/) : [];
    const libs = libsRaw ? libsRaw.split(/\s+/) : [];

    execFileSync(
      'gcc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Wno-deprecated-declarations',
        '-DHAVE_X11',
        ...cflags,
        '-o',
        binPath,
        path.join(srcDir, 'main.c'),
        path.join(srcDir, 'core.c'),
        path.join(srcDir, 'wayland_portal.c'),
        ...libs,
      ],
      { cwd: ROOT_DIR, stdio: 'pipe' }
    );

    try {
      execFileSync('strip', ['--strip-unneeded', binPath], { stdio: 'ignore' });
    } catch {
      // strip is optional
    }
  }

  if (!fs.existsSync(binPath)) {
    throw new Error(
      'Native GTK3 binary (native/bin/screenrec) is missing and libgtk-3-dev toolchain is unavailable.'
    );
  }

  const hdr = fs.readFileSync(binPath).subarray(0, 4);
  if (hdr[0] !== 0x7f || hdr[1] !== 0x45 || hdr[2] !== 0x4c || hdr[3] !== 0x46) {
    throw new Error('native/bin/screenrec is not a valid compiled ELF executable.');
  }

  return binPath;
}

/**
 * Generates crisp RGBA PNG icons using pure Node.js zlib so all Debian-based
 * GUI installers (GNOME Software, KDE Discover, GDebi, MintInstall, MX Package
 * Installer, Synaptic) render the ScreenRec icon natively.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generateAppIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const s = size;

  for (let y = 0; y < s; y++) {
    const rowOffset = y * (1 + s * 4);
    raw[rowOffset] = 0;
    const ny = y / s;

    for (let x = 0; x < s; x++) {
      const px = rowOffset + 1 + x * 4;
      const nx = x / s;

      const pad = 0.0625;
      const rad = 0.18;
      let insideOuter = nx >= pad && nx <= 1 - pad && ny >= pad && ny <= 1 - pad;
      if (insideOuter) {
        const cx = nx < pad + rad ? pad + rad : nx > 1 - pad - rad ? 1 - pad - rad : nx;
        const cy = ny < pad + rad ? pad + rad : ny > 1 - pad - rad ? 1 - pad - rad : ny;
        if (Math.hypot(nx - cx, ny - cy) > rad) insideOuter = false;
      }

      if (!insideOuter) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      let r = 15;
      let g = 23;
      let b = 42;

      if (nx >= 0.16 && nx <= 0.84 && ny >= 0.19 && ny <= 0.66) {
        r = 30;
        g = 41;
        b = 59;
      }

      if (nx >= 0.34 && nx <= 0.66 && ny >= 0.75 && ny <= 0.81) {
        r = 71;
        g = 85;
        b = 105;
      }

      const dist = Math.hypot(nx - 0.5, ny - 0.425);
      if (dist <= 0.055) {
        r = 254;
        g = 202;
        b = 202;
      } else if (dist <= 0.125) {
        r = 220;
        g = 38;
        b = 38;
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function collectFilesForMd5Sums(rootStageDir, currentDir = rootStageDir, acc = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootStageDir, fullPath).split(path.sep).join('/');
    if (relPath === 'DEBIAN' || relPath.startsWith('DEBIAN/')) continue;
    if (entry.isDirectory()) {
      collectFilesForMd5Sums(rootStageDir, fullPath, acc);
    } else if (entry.isFile()) {
      const md5 = crypto.createHash('md5').update(fs.readFileSync(fullPath)).digest('hex');
      acc.push(`${md5}  ${relPath}`);
    }
  }
  return acc;
}

export function buildDebianPackage() {
  const compiledElfPath = ensureNativeGtkBinary();

  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const version = pkgJson.version || '2.0.0';
  const arch = 'amd64';
  const debFileName = `screenrec_${version}_${arch}.deb`;

  const outRoot = path.join(ROOT_DIR, 'dist-deb');
  const stageDir = path.join(outRoot, `screenrec_${version}_${arch}`);
  const debOutputPath = path.join(outRoot, debFileName);

  fs.mkdirSync(outRoot, { recursive: true });
  // Remove stale .deb versions if present
  for (const entry of fs.readdirSync(outRoot)) {
    if (entry.endsWith('.deb') && entry !== debFileName) {
      fs.rmSync(path.join(outRoot, entry), { force: true });
    }
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'metainfo'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'pixmaps'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps'), {
    recursive: true,
  });

  // Install natively compiled C11 + GTK3 ELF binary directly to /usr/bin/screenrec
  const binDest = path.join(stageDir, 'usr', 'bin', 'screenrec');
  fs.copyFileSync(compiledElfPath, binDest);
  fs.chmodSync(binDest, 0o755);

  // Desktop launcher entry for GNOME, KDE Plasma, XFCE, Cinnamon, MATE, LXQt, Budgie
  const desktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=ScreenRec
GenericName=Screen Recorder
Comment=Native GTK3 screen recorder for Debian-based Linux distros with X11/Wayland auto-detection and MP4 export
Exec=/usr/bin/screenrec
TryExec=/usr/bin/screenrec
Icon=screenrec
Terminal=false
Categories=GTK;AudioVideo;Video;Recorder;
Keywords=screen;recorder;screencast;mp4;wayland;x11;audio;gtk;
StartupWMClass=ScreenRec
StartupNotify=true
X-KDE-SubstituteUID=false
`;
  fs.writeFileSync(
    path.join(stageDir, 'usr', 'share', 'applications', 'screenrec.desktop'),
    desktopEntry,
    { mode: 0o644 }
  );

  // AppStream metadata for GNOME Software, KDE Discover, MintInstall, Pop!_Shop
  const metainfoXml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>screenrec.desktop</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>ScreenRec</name>
  <summary>Native GTK3 screen recorder with automatic X11/Wayland detection and MP4 export</summary>
  <pkgname>screenrec</pkgname>
  <launchable type="desktop-id">screenrec.desktop</launchable>
  <description>
    <p>
      ScreenRec is a natively compiled C11 and GTK3 desktop screen recorder built for Debian-based
      Linux distributions (Debian, Ubuntu, Linux Mint, LMDE, MX Linux, Pop!_OS, KDE neon, Zorin OS,
      Elementary OS, Kali, and Devuan).
    </p>
    <p>
      Record your entire screen, an individual application window, or a browser tab/window with
      system audio, optional microphone voiceover, mouse cursor visibility toggle, customizable
      global keyboard shortcuts (F9 / F10), automatic startup X11 and Wayland detection, and
      direct H.264/AAC MP4 output.
    </p>
  </description>
  <categories>
    <category>AudioVideo</category>
    <category>Video</category>
    <category>Recorder</category>
  </categories>
  <provides>
    <binary>screenrec</binary>
  </provides>
  <releases>
    <release version="${version}" date="2026-11-22"/>
  </releases>
</component>
`;
  fs.writeFileSync(
    path.join(stageDir, 'usr', 'share', 'metainfo', 'screenrec.metainfo.xml'),
    metainfoXml,
    { mode: 0o644 }
  );

  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="8" y="8" width="112" height="112" rx="24" fill="#0f172a"/>
  <rect x="20" y="24" width="88" height="60" rx="10" fill="#1e293b" stroke="#334155" stroke-width="3"/>
  <circle cx="64" cy="54" r="16" fill="#dc2626"/>
  <circle cx="64" cy="54" r="7" fill="#fecaca"/>
  <rect x="44" y="96" width="40" height="8" rx="4" fill="#475569"/>
</svg>
`;
  fs.writeFileSync(
    path.join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'screenrec.svg'),
    iconSvg,
    { mode: 0o644 }
  );

  for (const iconSize of [48, 128, 256]) {
    const sizeDir = path.join(
      stageDir,
      'usr',
      'share',
      'icons',
      'hicolor',
      `${iconSize}x${iconSize}`,
      'apps'
    );
    fs.mkdirSync(sizeDir, { recursive: true });
    const pngBuf = generateAppIconPng(iconSize);
    fs.writeFileSync(path.join(sizeDir, 'screenrec.png'), pngBuf, { mode: 0o644 });
    if (iconSize === 128) {
      fs.writeFileSync(path.join(stageDir, 'usr', 'share', 'pixmaps', 'screenrec.png'), pngBuf, {
        mode: 0o644,
      });
    }
  }

  const calcDirBytes = (dir) => {
    let sum = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sum += calcDirBytes(full);
      else sum += fs.statSync(full).size;
    }
    return sum;
  };
  const installedSizeKb = Math.max(32, Math.ceil(calcDirBytes(stageDir) / 1024));

  // Cross-distro Debian/Ubuntu DEBIAN/control:
  // - Uses `libgtk-3-bin` (concrete package in BOTH pre-t64 Debian 12 / Ubuntu 22.04 / Mint 21 / MX 23
  //   AND post-t64 Ubuntu 24.04+ / Debian 13 / Mint 22 / Kali, automatically pulling in libgtk-3-0
  //   or libgtk-3-0t64 + libglib2.0-0/t64 without ABI rename conflicts!)
  // - Zero '|' pipe OR-alternates so KDE Discover (packagekit-backend-aptcc), GNOME Software,
  //   GDebi, MintInstall, and QApt GUI installers never fail dependency resolution.
  const controlContent = `Package: screenrec
Version: ${version}
Section: video
Priority: optional
Architecture: ${arch}
Installed-Size: ${installedSizeKb}
Depends: libc6, libgtk-3-bin, libx11-6, ffmpeg, x11-utils, pulseaudio-utils
Recommends: gstreamer1.0-tools, gstreamer1.0-pipewire, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, xdg-desktop-portal
Maintainer: ScreenRec Contributors <maintainers@screenrec.linux>
Homepage: https://github.com/screenrec/screenrec
Description: Native GTK3 screen recorder for Debian-based Linux distributions
 ScreenRec is a natively compiled C11 and GTK3 desktop application that records
 your entire screen, an individual window, or a browser tab with system audio,
 optional microphone voiceover, mouse cursor visibility toggle, and global
 keyboard shortcuts (F9/F10). Automatically detects Wayland or X11 on startup
 and saves recordings directly as H.264/AAC MP4 files.
`;
  fs.writeFileSync(path.join(stageDir, 'DEBIAN', 'control'), controlContent, { mode: 0o644 });

  const postinst = `#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
  fi
fi
exit 0
`;
  const postinstPath = path.join(stageDir, 'DEBIAN', 'postinst');
  fs.writeFileSync(postinstPath, postinst, { mode: 0o755 });
  fs.chmodSync(postinstPath, 0o755);

  const md5Lines = collectFilesForMd5Sums(stageDir).sort();
  fs.writeFileSync(path.join(stageDir, 'DEBIAN', 'md5sums'), `${md5Lines.join('\n')}\n`, {
    mode: 0o644,
  });

  execFileSync('dpkg-deb', ['--build', '--root-owner-group', stageDir, debOutputPath], {
    stdio: 'pipe',
  });

  const debBytes = fs.readFileSync(debOutputPath);
  const sha256 = crypto.createHash('sha256').update(debBytes).digest('hex');
  const dpkgInfo = execFileSync('dpkg-deb', ['--info', debOutputPath], { encoding: 'utf-8' });

  fs.rmSync(stageDir, { recursive: true, force: true });

  return {
    fileName: debFileName,
    filePath: debOutputPath,
    version,
    arch,
    binaryFormat: 'ELF 64-bit LSB pie executable (Native C11 + GTK3)',
    sizeBytes: debBytes.byteLength,
    sha256,
    dpkgInfo,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = buildDebianPackage();
  console.log(`Built ${result.fileName} (${result.sizeBytes} bytes) [${result.binaryFormat}]`);
  console.log(`SHA256: ${result.sha256}`);
}
