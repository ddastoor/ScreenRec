import React, { useEffect, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import type { DebPackageInfo, SystemInfo } from '../types';
import { formatBytes } from '../utils/recorderConfig';

interface DebianReleasePanelProps {
  systemInfo: SystemInfo | null;
}

export const DebianReleasePanel: React.FC<DebianReleasePanelProps> = ({ systemInfo }) => {
  const [debInfo, setDebInfo] = useState<DebPackageInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch('/api/package/deb-info')
      .then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || 'Could not inspect Debian package.');
        }
        return res.json() as Promise<DebPackageInfo>;
      })
      .then((data) => {
        if (!active) return;
        setDebInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load .deb package details.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const copyText = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedCmd(id);
    window.setTimeout(() => setCopiedCmd(null), 1800);
  };

  const installCmd = debInfo?.installCommand || 'sudo apt install ./screenrec_1.0.0_amd64.deb';
  const releaseCmd = 'git tag v1.0.0 && git push origin v1.0.0';

  return (
    <section aria-labelledby="debian-heading" className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <h1 id="debian-heading" className="text-xl font-bold text-slate-900">
              Debian Linux Installer (.deb) & GitHub Release
            </h1>
            <p className="text-sm text-slate-600">
              Install ScreenRec natively on Debian 12+, Ubuntu 22.04/24.04+, Linux Mint, Pop!_OS, or
              publish standalone <code className="font-mono">.deb</code> packages automatically on
              GitHub Releases.
            </p>
          </div>

          <a
            href="/api/package/deb"
            download
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Download {debInfo?.fileName || 'screenrec_1.0.0_amd64.deb'}</span>
          </a>
        </div>

        {loading && (
          <div className="text-xs text-slate-500 py-2">
            Building and verifying Debian package metadata with dpkg-deb...
          </div>
        )}

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}

        {debInfo && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-2 border-t border-slate-100 text-xs">
            <div>
              <span className="text-slate-500 block">Package File</span>
              <span className="font-mono font-semibold text-slate-900 mt-0.5 block" data-testid="deb-filename">
                {debInfo.fileName}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Architecture</span>
              <span className="font-mono font-semibold text-slate-900 mt-0.5 block">
                {debInfo.arch} (Debian / Ubuntu)
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Package Size</span>
              <span className="font-mono font-semibold text-slate-900 mt-0.5 block tabular-nums">
                {formatBytes(debInfo.sizeBytes)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">SHA-256 Checksum</span>
              <span
                className="font-mono text-slate-800 mt-0.5 block truncate"
                title={debInfo.sha256}
              >
                {debInfo.sha256.slice(0, 20)}...
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Install Instructions */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Install on Debian / Ubuntu
          </h2>

          <p className="text-xs text-slate-600 leading-relaxed">
            Use <code className="font-mono">apt</code> so dependencies (<code className="font-mono">ffmpeg</code>,{' '}
            <code className="font-mono">xdg-desktop-portal</code>, and PipeWire/PulseAudio utilities)
            are resolved automatically:
          </p>

          <div className="flex items-center justify-between gap-2 bg-slate-900 text-slate-100 rounded-lg px-3.5 py-2.5 font-mono text-xs">
            <span className="overflow-x-auto">{installCmd}</span>
            <button
              type="button"
              onClick={() => copyText(installCmd, 'apt')}
              aria-label="Copy apt install command"
              className="p-1.5 text-slate-300 hover:text-white rounded transition-colors shrink-0"
            >
              {copiedCmd === 'apt' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </div>

          <div className="space-y-2 text-xs text-slate-600 pt-1">
            <p className="font-semibold text-slate-800">X11 & Wayland Runtime Behavior:</p>
            <p>
              · <strong className="text-slate-900">Wayland Sessions</strong>: Detected automatically
              on startup via <code className="font-mono">XDG_SESSION_TYPE=wayland</code> or{' '}
              <code className="font-mono">WAYLAND_DISPLAY</code>; enables Chromium PipeWire
              ScreenCast portal with embedded or hidden cursor mode.
            </p>
            <p>
              · <strong className="text-slate-900">X11 Sessions</strong>: Detected via{' '}
              <code className="font-mono">XDG_SESSION_TYPE=x11</code> or{' '}
              <code className="font-mono">DISPLAY</code>; captures desktop or individual X11 window
              IDs with XFixes cursor control.
            </p>
          </div>
        </div>

        {/* GitHub Releases Automation */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            GitHub Releases (.deb CI/CD Pipeline)
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            This repository includes <code className="font-mono">.github/workflows/release.yml</code>{' '}
            and <code className="font-mono">.github/workflows/ci.yml</code>. Pushing a semantic
            version tag runs the automated test suite, packages the standalone Electron{' '}
            <code className="font-mono">.deb</code> installer, and attaches it to your GitHub
            Releases page:
          </p>

          <div className="flex items-center justify-between gap-2 bg-slate-900 text-slate-100 rounded-lg px-3.5 py-2.5 font-mono text-xs">
            <span className="overflow-x-auto">{releaseCmd}</span>
            <button
              type="button"
              onClick={() => copyText(releaseCmd, 'tag')}
              aria-label="Copy git tag release command"
              className="p-1.5 text-slate-300 hover:text-white rounded transition-colors shrink-0"
            >
              {copiedCmd === 'tag' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </div>

          {systemInfo && (
            <div className="text-xs text-slate-600 space-y-1 pt-1">
              <p className="font-semibold text-slate-800">Current Host Verification:</p>
              <p className="font-mono text-[11px] text-slate-700">
                OS: {systemInfo.os.prettyName} ({systemInfo.os.arch}) · FFmpeg:{' '}
                {systemInfo.capabilities.ffmpegAvailable ? 'Ready (H.264/AAC)' : 'Unavailable'} ·
                dpkg-deb: {systemInfo.capabilities.dpkgDebAvailable ? 'Ready' : 'Unavailable'}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
