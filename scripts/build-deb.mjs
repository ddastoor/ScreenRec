#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function buildDebianPackage() {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const version = pkgJson.version || '1.0.0';
  const arch = 'amd64';
  const debFileName = `screenrec_${version}_${arch}.deb`;

  const outRoot = path.join(ROOT_DIR, 'dist-deb');
  const stageDir = path.join(outRoot, `screenrec_${version}_${arch}`);
  const debOutputPath = path.join(outRoot, debFileName);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(stageDir, 'usr', 'share', 'doc', 'screenrec'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'opt', 'screenrec'), { recursive: true });

  // Copy application runtime files into /opt/screenrec
  const copyIfExists = (relPath) => {
    const src = path.join(ROOT_DIR, relPath);
    const dest = path.join(stageDir, 'opt', 'screenrec', relPath);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  };

  copyIfExists('dist');
  copyIfExists('electron');
  copyIfExists('src/server');
  copyIfExists('src/utils');
  copyIfExists('server.ts');
  copyIfExists('package.json');

  // Create /usr/bin/screenrec launcher script with automatic X11/Wayland startup detection
  const launcherScript = `#!/usr/bin/env bash
set -euo pipefail

# Auto-detect X11 vs Wayland display protocol at startup
SESSION_PROTOCOL="headless"
if [[ "\${XDG_SESSION_TYPE:-}" == "wayland" ]] || [[ -n "\${WAYLAND_DISPLAY:-}" ]]; then
  SESSION_PROTOCOL="wayland"
elif [[ "\${XDG_SESSION_TYPE:-}" == "x11" ]] || [[ -n "\${DISPLAY:-}" ]]; then
  SESSION_PROTOCOL="x11"
fi

export SCREENREC_DETECTED_SESSION="\${SESSION_PROTOCOL}"
APP_DIR="/opt/screenrec"

# Launch via Electron desktop shell if available, otherwise local desktop web window
if command -v electron >/dev/null 2>&1 && [[ -f "\${APP_DIR}/electron/main.cjs" ]]; then
  if [[ "\${SESSION_PROTOCOL}" == "wayland" ]]; then
    exec electron "\${APP_DIR}/electron/main.cjs" --enable-features=WebRTCPipeWireCapturer --ozone-platform-hint=auto "$@"
  else
    exec electron "\${APP_DIR}/electron/main.cjs" "$@"
  fi
fi

PORT="\${SCREENREC_PORT:-3789}"
PORT="\${PORT}" NODE_ENV=production node "\${APP_DIR}/server.ts" &
SERVER_PID=$!
trap "kill \${SERVER_PID} 2>/dev/null || true" EXIT

sleep 1
for BROWSER_BIN in chromium google-chrome brave-browser xdg-open; do
  if command -v "\${BROWSER_BIN}" >/dev/null 2>&1; then
    if [[ "\${BROWSER_BIN}" == "xdg-open" ]]; then
      xdg-open "http://127.0.0.1:\${PORT}" >/dev/null 2>&1 || true
    else
      "\${BROWSER_BIN}" --app="http://127.0.0.1:\${PORT}" >/dev/null 2>&1 &
    fi
    break
  fi
done

wait "\${SERVER_PID}"
`;
  const binPath = path.join(stageDir, 'usr', 'bin', 'screenrec');
  fs.writeFileSync(binPath, launcherScript, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);

  // Create /usr/share/applications/screenrec.desktop
  const desktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=ScreenRec
GenericName=Screen Recorder
Comment=Simple screen recorder for Debian Linux with X11/Wayland auto-detection and MP4 export
Exec=/usr/bin/screenrec %U
Icon=screenrec
Terminal=false
Categories=AudioVideo;Video;Recorder;GTK;
Keywords=screen;recorder;screencast;mp4;wayland;x11;audio;
StartupNotify=true
`;
  fs.writeFileSync(
    path.join(stageDir, 'usr', 'share', 'applications', 'screenrec.desktop'),
    desktopEntry,
    { mode: 0o644 }
  );

  // Create scalable SVG icon
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

  // Calculate installed size in KiB
  const calcDirBytes = (dir) => {
    let sum = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sum += calcDirBytes(full);
      else sum += fs.statSync(full).size;
    }
    return sum;
  };
  const installedSizeKb = Math.max(16, Math.ceil(calcDirBytes(stageDir) / 1024));

  // Create DEBIAN/control
  const controlContent = `Package: screenrec
Version: ${version}
Section: video
Priority: optional
Architecture: ${arch}
Installed-Size: ${installedSizeKb}
Depends: ffmpeg, xdg-utils, pulseaudio-utils | pipewire-pulse
Recommends: xdg-desktop-portal, xdg-desktop-portal-gtk | xdg-desktop-portal-kde | xdg-desktop-portal-wlr
Maintainer: ScreenRec Contributors <maintainers@screenrec.linux>
Homepage: https://github.com/screenrec/screenrec
Description: Simple screen recorder for Debian-based Linux distributions
 ScreenRec records an entire screen, single application window, or browser tab
 with optional system audio, microphone voiceover, and mouse cursor visibility.
 Automatically detects X11 or Wayland on startup and exports standard H.264/AAC
 MP4 files.
`;
  fs.writeFileSync(path.join(stageDir, 'DEBIAN', 'control'), controlContent, { mode: 0o644 });

  // Create DEBIAN/postinst
  const postinst = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
`;
  const postinstPath = path.join(stageDir, 'DEBIAN', 'postinst');
  fs.writeFileSync(postinstPath, postinst, { mode: 0o755 });
  fs.chmodSync(postinstPath, 0o755);

  // Build binary .deb with dpkg-deb
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', stageDir, debOutputPath], {
    stdio: 'pipe',
  });

  const debBytes = fs.readFileSync(debOutputPath);
  const sha256 = crypto.createHash('sha256').update(debBytes).digest('hex');
  const dpkgInfo = execFileSync('dpkg-deb', ['--info', debOutputPath], { encoding: 'utf-8' });

  // Clean staging folder, keep built .deb artifact
  fs.rmSync(stageDir, { recursive: true, force: true });

  return {
    fileName: debFileName,
    filePath: debOutputPath,
    version,
    arch,
    sizeBytes: debBytes.byteLength,
    sha256,
    dpkgInfo,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = buildDebianPackage();
  console.log(`Built ${result.fileName} (${result.sizeBytes} bytes)`);
  console.log(`SHA256: ${result.sha256}`);
}
