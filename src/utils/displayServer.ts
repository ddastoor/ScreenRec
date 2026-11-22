export type DisplayProtocol = 'wayland' | 'x11' | 'headless';

export interface DisplayEnvInput {
  xdgSessionType?: string;
  waylandDisplay?: string;
  display?: string;
  xdgCurrentDesktop?: string;
  desktopSession?: string;
  waylandSockets?: string[];
  x11Sockets?: string[];
  loginctlType?: string;
}

export interface DisplayDetectionResult {
  protocol: DisplayProtocol;
  label: string;
  isXWaylandAvailable: boolean;
  captureBackend: string;
  cursorMechanism: string;
  desktopEnvironment: string;
  detectedVia: string;
  details: {
    xdgSessionType: string | null;
    waylandDisplay: string | null;
    x11Display: string | null;
  };
}

export interface LinuxCaptureCommandOptions {
  protocol: DisplayProtocol;
  sourceType: 'monitor' | 'window' | 'browser';
  systemAudio: boolean;
  micAudio: boolean;
  includeCursor: boolean;
  outputFile: string;
  x11Display?: string;
  defaultSinkMonitor?: string;
  defaultMicSource?: string;
}

/**
 * Auto-detects whether the Linux session is running Wayland or X11 at startup.
 * Prioritizes explicit session type and Wayland sockets over XWayland DISPLAY variables
 * so Wayland desktops with XWayland active never misclassify as X11 (which causes black screens).
 */
export function detectDisplayServer(input: DisplayEnvInput): DisplayDetectionResult {
  const rawSession = (input.xdgSessionType ?? '').trim().toLowerCase();
  const waylandDisplay = (input.waylandDisplay ?? '').trim() || null;
  const x11Display = (input.display ?? '').trim() || null;
  const loginctl = (input.loginctlType ?? '').trim().toLowerCase();
  const waylandSockets = (input.waylandSockets ?? []).filter(Boolean);
  const x11Sockets = (input.x11Sockets ?? []).filter(Boolean);

  const desktopRaw =
    (input.xdgCurrentDesktop ?? '').trim() ||
    (input.desktopSession ?? '').trim() ||
    'Standard Linux Desktop';

  const hasWaylandEnv = Boolean(waylandDisplay) || waylandSockets.length > 0;
  const hasX11Env = Boolean(x11Display) || x11Sockets.length > 0;

  // 1. Explicit XDG_SESSION_TYPE=wayland or active WAYLAND_DISPLAY / Wayland runtime socket
  if (rawSession === 'wayland' || hasWaylandEnv || loginctl === 'wayland') {
    const isXWayland = hasX11Env;
    let detectedVia = 'XDG_SESSION_TYPE=wayland';
    if (rawSession !== 'wayland') {
      if (waylandDisplay) {
        detectedVia = `WAYLAND_DISPLAY=${waylandDisplay}`;
      } else if (waylandSockets.length > 0) {
        detectedVia = `Wayland socket (${waylandSockets[0]})`;
      } else {
        detectedVia = 'systemd-logind session type (wayland)';
      }
    }

    return {
      protocol: 'wayland',
      label: isXWayland ? 'Wayland (with XWayland)' : 'Wayland',
      isXWaylandAvailable: isXWayland,
      captureBackend: 'xdg-desktop-portal + PipeWire ScreenCast',
      cursorMechanism: 'Portal cursor_mode (Embedded = 2, Hidden = 1)',
      desktopEnvironment: desktopRaw,
      detectedVia,
      details: {
        xdgSessionType: rawSession || null,
        waylandDisplay: waylandDisplay ?? waylandSockets[0] ?? null,
        x11Display,
      },
    };
  }

  // 2. Explicit XDG_SESSION_TYPE=x11 or X11 DISPLAY / X11 unix socket without Wayland
  if (rawSession === 'x11' || hasX11Env || loginctl === 'x11') {
    let detectedVia = 'XDG_SESSION_TYPE=x11';
    if (rawSession !== 'x11') {
      if (x11Display) {
        detectedVia = `DISPLAY=${x11Display}`;
      } else if (x11Sockets.length > 0) {
        detectedVia = `X11 socket (${x11Sockets[0]})`;
      } else {
        detectedVia = 'systemd-logind session type (x11)';
      }
    }

    return {
      protocol: 'x11',
      label: 'X11 (X.Org Server)',
      isXWaylandAvailable: false,
      captureBackend: 'X11 Composite / FFmpeg x11grab',
      cursorMechanism: 'XFixes cursor overlay (-draw_mouse 1 | 0)',
      desktopEnvironment: desktopRaw,
      detectedVia,
      details: {
        xdgSessionType: rawSession || null,
        waylandDisplay: null,
        x11Display: x11Display ?? (x11Sockets[0] ? `:0 (${x11Sockets[0]})` : ':0'),
      },
    };
  }

  // 3. Headless / Cloud container / Browser-only environment
  return {
    protocol: 'headless',
    label: 'Web DisplayMedia (No local X11/Wayland socket)',
    isXWaylandAvailable: false,
    captureBackend: 'Browser navigator.mediaDevices.getDisplayMedia',
    cursorMechanism: 'DisplayMedia video constraint (cursor: always | never)',
    desktopEnvironment: desktopRaw,
    detectedVia: 'Startup environment scan (no WAYLAND_DISPLAY or DISPLAY set)',
    details: {
      xdgSessionType: rawSession || null,
      waylandDisplay: null,
      x11Display: null,
    },
  };
}

/**
 * Parses Debian / Linux /etc/os-release content into structured distribution fields.
 */
export function parseOsRelease(osReleaseContent: string): {
  prettyName: string;
  id: string;
  idLike: string;
  versionId: string;
  isDebianBased: boolean;
} {
  const map: Record<string, string> = {};
  for (const rawLine of osReleaseContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    map[key] = val;
  }

  const id = (map.ID ?? 'linux').toLowerCase();
  const idLike = (map.ID_LIKE ?? '').toLowerCase();
  const isDebianBased =
    id === 'debian' ||
    id === 'ubuntu' ||
    id === 'linuxmint' ||
    id === 'pop' ||
    id === 'kali' ||
    idLike.includes('debian') ||
    idLike.includes('ubuntu');

  return {
    prettyName: map.PRETTY_NAME || map.NAME || 'Linux',
    id,
    idLike,
    versionId: map.VERSION_ID || '',
    isDebianBased,
  };
}

/**
 * Builds the representative Linux capture pipeline command for transparency and CLI parity.
 */
export function buildLinuxCapturePipelineSummary(opts: LinuxCaptureCommandOptions): string {
  const sink = opts.defaultSinkMonitor || 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor';
  const mic = opts.defaultMicSource || 'alsa_input.pci-0000_00_1f.3.analog-stereo';
  const cursorFlag = opts.includeCursor ? '1' : '0';

  const audioInputs: string[] = [];
  if (opts.systemAudio) {
    audioInputs.push(`-f pulse -i ${sink}`);
  }
  if (opts.micAudio) {
    audioInputs.push(`-f pulse -i ${mic}`);
  }

  let audioCodecArgs = '-an';
  if (opts.systemAudio && opts.micAudio) {
    audioCodecArgs =
      '-filter_complex "[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]" -map 0:v -map "[aout]" -c:a aac -b:a 160k';
  } else if (opts.systemAudio || opts.micAudio) {
    audioCodecArgs = '-c:a aac -b:a 128k';
  }

  if (opts.protocol === 'x11') {
    const disp = opts.x11Display || ':0.0';
    const inputTarget =
      opts.sourceType === 'window' ? `-window_id $(xdotool selectwindow) -i ${disp}` : `-i ${disp}`;
    return [
      'ffmpeg -y',
      `-f x11grab -framerate 30 -draw_mouse ${cursorFlag} ${inputTarget}`,
      ...audioInputs,
      '-c:v libx264 -preset veryfast -pix_fmt yuv420p',
      audioCodecArgs,
      '-movflags +faststart',
      opts.outputFile,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (opts.protocol === 'wayland') {
    const portalSourceType = opts.sourceType === 'window' ? '2 (Window)' : '1 (Monitor)';
    const portalCursorMode = opts.includeCursor ? '2 (Embedded)' : '1 (Hidden)';
    return [
      `# xdg-desktop-portal ScreenCast: source_type=${portalSourceType}, cursor_mode=${portalCursorMode}`,
      'ffmpeg -y -f pipewire -i pipewire-node',
      ...audioInputs,
      '-c:v libx264 -preset veryfast -pix_fmt yuv420p',
      audioCodecArgs,
      '-movflags +faststart',
      opts.outputFile,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    'ffmpeg -y -i browser-capture-stream',
    '-c:v libx264 -preset veryfast -pix_fmt yuv420p',
    opts.systemAudio || opts.micAudio ? '-c:a aac -b:a 128k' : '-an',
    '-movflags +faststart',
    opts.outputFile,
  ].join(' ');
}
