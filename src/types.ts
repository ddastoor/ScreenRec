import type { DisplayDetectionResult } from './utils/displayServer';
import type { CaptureSourceType } from './utils/recorderConfig';

export type ActiveView = 'recorder' | 'recordings' | 'debian';

export interface SystemInfo {
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
  sizeBytes: number;
  sha256: string;
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
}

declare global {
  interface Window {
    screenRecDesktop?: DesktopBridge;
  }
}
