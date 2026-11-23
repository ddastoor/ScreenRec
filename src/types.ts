import type { DisplayDetectionResult } from './utils/displayServer';
import type { CaptureSourceType } from './utils/recorderConfig';

import type { ShortcutActionId } from './utils/shortcuts';

export type ActiveView = 'recorder' | 'recordings' | 'shortcuts' | 'debian';

export interface SystemInfo {
  detectedAt: string;
  isInstalledDesktop?: boolean;
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

export interface RecordedClip {
  id: string;
  filename: string;
  url: string;
  sizeBytes: number;
  durationSeconds: number;
  createdAt: string;
  sourceType: CaptureSourceType;
  systemAudio: boolean;
  micAudio: boolean;
  includeCursor: boolean;
  displayProtocol: string;
}

export interface DebPackageInfo {
  fileName: string;
  version: string;
  arch: string;
  binaryFormat?: string;
  sizeBytes: number;
  sha256: string;
  installedOnSystem?: boolean;
  dpkgInfo: string;
  installCommand: string;
  dpkgCommand: string;
}

export interface DesktopBridge {
  isDesktopApp: boolean;
  getStartupDisplayInfo: () => Promise<{
    protocol: 'wayland' | 'x11' | 'headless';
    label: string;
    waylandDisplay: string | null;
    x11Display: string | null;
  }>;
  setCapturePrefs: (prefs: {
    sourceType: CaptureSourceType;
    systemAudio: boolean;
    includeCursor: boolean;
  }) => Promise<{ ok: boolean }>;
  saveMp4WithDialog: (payload: {
    defaultFilename: string;
    rawBytes: ArrayBuffer;
  }) => Promise<{ saved: boolean; filePath?: string }>;
  syncShortcuts?: (
    bindings: { action: ShortcutActionId; accelerator: string }[]
  ) => Promise<{ registered: ShortcutActionId[] }>;
  onShortcutTriggered?: (listener: (action: ShortcutActionId) => void) => () => void;
}

declare global {
  interface Window {
    screenRecDesktop?: DesktopBridge;
  }
}
