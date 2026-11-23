import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  detectDisplayServer,
  parseOsRelease,
  type DisplayDetectionResult,
  type DisplayEnvInput,
} from '../utils/displayServer.ts';

export interface SystemInfoPayload {
  detectedAt: string;
  os: {
    prettyName: string;
    id: string;
    idLike: string;
    versionId: string;
    isDebianBased: boolean;
    arch: string;
    kernel: string;
  };
  displayServer: DisplayDetectionResult;
  capabilities: {
    ffmpegAvailable: boolean;
    ffmpegVersion: string | null;
    mp4H264Supported: boolean;
    aacAudioSupported: boolean;
    dpkgDebAvailable: boolean;
    audioServer: string;
  };
}

function safeExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function listSockets(dirPath: string, prefix: string): string[] {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath)
      .filter((entry) => entry.startsWith(prefix) && !entry.endsWith('.lock'))
      .map((entry) => path.join(dirPath, entry));
  } catch {
    return [];
  }
}

export function probeLinuxEnvironment(envOverride?: DisplayEnvInput): SystemInfoPayload {
  let osReleaseRaw = '';
  try {
    if (fs.existsSync('/etc/os-release')) {
      osReleaseRaw = fs.readFileSync('/etc/os-release', 'utf-8');
    }
  } catch {
    osReleaseRaw = '';
  }

  const parsedOs = parseOsRelease(osReleaseRaw);

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const waylandSockets = listSockets(runtimeDir, 'wayland-');
  const x11Sockets = listSockets('/tmp/.X11-unix', 'X');

  let loginctlType = '';
  let sysWaylandDisplay = process.env.WAYLAND_DISPLAY;
  let sysX11Display = process.env.DISPLAY;
  let sysDesktop = process.env.XDG_CURRENT_DESKTOP;

  if (
    !envOverride &&
    !process.env.XDG_SESSION_TYPE &&
    !sysWaylandDisplay &&
    !sysX11Display &&
    waylandSockets.length === 0
  ) {
    const userEnv = safeExec('systemctl', ['--user', 'show-environment']);
    if (userEnv) {
      for (const line of userEnv.split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k === 'XDG_SESSION_TYPE' && v) loginctlType = v.toLowerCase();
        else if (k === 'WAYLAND_DISPLAY' && v && !sysWaylandDisplay) sysWaylandDisplay = v;
        else if (k === 'DISPLAY' && v && !sysX11Display) sysX11Display = v;
        else if (k === 'XDG_CURRENT_DESKTOP' && v && !sysDesktop) sysDesktop = v;
      }
    }

    if (!loginctlType) {
      const sessionId = process.env.XDG_SESSION_ID;
      if (sessionId) {
        loginctlType = safeExec('loginctl', ['show-session', sessionId, '-p', 'Type', '--value']) || '';
      } else {
        const sessionsOut = safeExec('loginctl', ['list-sessions', '--no-legend']);
        if (sessionsOut) {
          for (const line of sessionsOut.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2 || parts[1] !== String(uid)) continue;
            const sid = parts[0]!;
            const stype = (
              safeExec('loginctl', ['show-session', sid, '-p', 'Type', '--value']) || ''
            ).toLowerCase();
            if (stype === 'wayland' || stype === 'x11') {
              loginctlType = stype;
              break;
            }
          }
        }
      }
    }
  }

  const envInput: DisplayEnvInput = envOverride ?? {
    xdgSessionType: process.env.XDG_SESSION_TYPE || process.env.SCREENREC_DETECTED_SESSION,
    waylandDisplay: sysWaylandDisplay,
    display: sysX11Display,
    xdgCurrentDesktop: sysDesktop,
    desktopSession: process.env.DESKTOP_SESSION,
    waylandSockets,
    x11Sockets,
    loginctlType,
  };

  const displayServer = detectDisplayServer(envInput);

  const ffmpegOut = safeExec('ffmpeg', ['-version']);
  const ffmpegFirstLine = ffmpegOut ? ffmpegOut.split('\n')[0] ?? null : null;
  const encodersOut = ffmpegOut ? safeExec('ffmpeg', ['-hide_banner', '-encoders']) || '' : '';
  const mp4H264Supported = encodersOut.includes('libx264') || encodersOut.includes('h264');
  const aacAudioSupported = encodersOut.includes(' aac ');
  const dpkgDebAvailable = Boolean(safeExec('dpkg-deb', ['--version']));

  let audioServer = 'Web Audio / Browser MediaStream';
  const pactlInfo = safeExec('pactl', ['info']);
  if (pactlInfo) {
    if (pactlInfo.toLowerCase().includes('pipewire')) {
      audioServer = 'PipeWire (PulseAudio-compatible sink monitor)';
    } else {
      audioServer = 'PulseAudio (sink monitor + source)';
    }
  } else if (fs.existsSync(path.join(runtimeDir, 'pipewire-0'))) {
    audioServer = 'PipeWire';
  } else if (fs.existsSync(path.join(runtimeDir, 'pulse', 'native'))) {
    audioServer = 'PulseAudio';
  }

  return {
    detectedAt: new Date().toISOString(),
    os: {
      ...parsedOs,
      arch: process.arch === 'x64' ? 'amd64' : process.arch,
      kernel: safeExec('uname', ['-sr']) || `${process.platform} ${process.arch}`,
    },
    displayServer,
    capabilities: {
      ffmpegAvailable: Boolean(ffmpegFirstLine),
      ffmpegVersion: ffmpegFirstLine,
      mp4H264Supported,
      aacAudioSupported,
      dpkgDebAvailable,
      audioServer,
    },
  };
}
