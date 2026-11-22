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
  if (!envOverride && !process.env.XDG_SESSION_TYPE && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    const sessionId = process.env.XDG_SESSION_ID;
    if (sessionId) {
      loginctlType = safeExec('loginctl', ['show-session', sessionId, '-p', 'Type', '--value']) || '';
    }
  }

  const envInput: DisplayEnvInput = envOverride ?? {
    xdgSessionType: process.env.XDG_SESSION_TYPE || process.env.SCREENREC_DETECTED_SESSION,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    display: process.env.DISPLAY,
    xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
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
