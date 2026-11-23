import React, { useEffect, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import type { DebPackageInfo, SystemInfo } from '../types';
import { formatBytes } from '../utils/recorderConfig';

interface DebianReleasePanelProps {
  systemInfo: SystemInfo | null;
}

const SUPPORTED_DEBIAN_DISTROS = [
  {
    family: 'Debian Stable & Testing',
    releases: 'Debian 12 (Bookworm), Debian 13 (Trixie), LMDE 6',
    guiInstaller: 'GNOME Software, KDE Discover, GDebi, Synaptic',
    notes: 'Wayland Portal + PipeWire & X11 x11grab',
  },
  {
    family: 'Ubuntu & Official Flavors',
    releases: 'Ubuntu 22.04 LTS (Jammy), 24.04 LTS (Noble), Kubuntu, Xubuntu',
    guiInstaller: 'App Center, GNOME Software, KDE Discover',
    notes: 'Pre-t64 & t64 GTK3 ABI safe (libgtk-3-bin)',
  },
  {
    family: 'Linux Mint & Pop!_OS',
    releases: 'Linux Mint 21.x / 22.x (Cinnamon, MATE, Xfce), Pop!_OS 22.04 / 24.04',
    guiInstaller: 'MintInstall (Gdebi), Cosmic Store, Pop!_Shop',
    notes: 'Auto-detects X11 Cinnamon & COSMIC Wayland',
  },
  {
    family: 'MX Linux, Devuan & Rolling Derivatives',
    releases: 'MX Linux 23, Zorin OS 17, KDE neon, Elementary OS, Kali Rolling',
    guiInstaller: 'MX Package Installer, Discover, GDebi',
    notes: 'Works with both systemd & SysVinit / elogind',
  },
];

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

  const pkgFileName = debInfo?.fileName || 'screenrec_2.0.0_amd64.deb';
  const installCmd = debInfo?.installCommand || `sudo apt install ./${pkgFileName}`;

  return (
    <section aria-labelledby="debian-heading" className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <h1 id="debian-heading" className="text-xl font-bold text-slate-900">
              Native GTK3 Debian Installer (.deb) & GitHub Release
            </h1>
            <p className="text-sm text-slate-600">
              Natively compiled C11 + GTK3 ELF desktop binary (<code className="font-mono">/usr/bin/screenrec</code>)
              with zero Electron or localhost web wrapper—built for Debian, Ubuntu, Linux Mint, MX Linux,
              Pop!_OS, KDE neon, Zorin OS, and Kali.
            </p>
          </div>

          <a
            href="/api/package/deb"
            download
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Download {pkgFileName}</span>
          </a>
        </div>

        {loading && (
          <div className="text-xs text-slate-500 py-2">
            Compiling native C11 + GTK3 binary and verifying Debian package metadata...
          </div>
        )}

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}

        {debInfo && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3 border-t border-slate-100 text-xs">
            <div>
              <span className="text-slate-500 block">Package File</span>
              <span className="font-mono font-semibold text-slate-900 mt-0.5 block" data-testid="deb-filename">
                {debInfo.fileName}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Compiled Binary</span>
              <span className="font-mono font-semibold text-slate-900 mt-0.5 block">
                {debInfo.binaryFormat || 'ELF 64-bit C11 + GTK3'}
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
              <span className="font-mono text-slate-800 mt-0.5 block truncate" title={debInfo.sha256}>
                {debInfo.sha256.slice(0, 20)}...
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Multi-Distro Debian Compatibility Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900">
            Supported Debian-Based Linux Distributions
          </h2>
          <p className="text-xs text-slate-600">
            Engineered with <code className="font-mono">GLIBC_2.34</code> compatibility,{' '}
            <code className="font-mono">libgtk-3-bin</code> cross-ABI dependencies (supporting both pre-
            <code className="font-mono">t64</code> and Ubuntu 24.04 / Debian 13{' '}
            <code className="font-mono">t64</code> libraries), and init-system-independent socket scanning.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-semibold">Distribution Family</th>
                <th className="py-2 pr-4 font-semibold">Tested Releases</th>
                <th className="py-2 pr-4 font-semibold">GUI Package Installer</th>
                <th className="py-2 font-semibold">Display & Init Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {SUPPORTED_DEBIAN_DISTROS.map((row) => (
                <tr key={row.family} className="hover:bg-slate-50/70">
                  <td className="py-2.5 pr-4 font-semibold text-slate-900 whitespace-nowrap">
                    {row.family}
                  </td>
                  <td className="py-2.5 pr-4">{row.releases}</td>
                  <td className="py-2.5 pr-4">{row.guiInstaller}</td>
                  <td className="py-2.5 text-slate-600">{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            1-Click GUI Install & Launch (No Command Line Required)
          </h2>

          <ol className="space-y-2.5 text-xs text-slate-700 list-decimal list-inside leading-relaxed">
            <li>
              Download <span className="font-mono font-semibold text-slate-900">{pkgFileName}</span>{' '}
              above (or from GitHub Releases).
            </li>
            <li>
              Double-click the <code className="font-mono">.deb</code> file in your file manager to
              open your distro&apos;s <strong>GUI Package Installer</strong> (<em>GNOME Software</em>,{' '}
              <em>KDE Discover</em>, <em>GDebi</em>, <em>MintInstall</em>, or <em>MX Package Installer</em>)
              and click <strong>Install</strong>.
            </li>
            <li>
              Click <strong>Open / Launch</strong> inside the installer, or launch{' '}
              <strong>ScreenRec</strong> from your desktop <strong>Application Menu</strong> (under{' '}
              <em>Sound &amp; Video</em> / <em>Multimedia</em>).
            </li>
          </ol>

          <div className="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-slate-100">
            <p className="font-semibold text-slate-800">
              Native C11 + GTK3 Startup Architecture:
            </p>
            <p>
              · <strong className="text-slate-900">Instant Native Window</strong>: Launches directly as a
              compiled GTK3 desktop window—no localhost port, no Python/Node daemon, and no Chromium wrapper.
            </p>
            <p>
              · <strong className="text-slate-900">Automatic Wayland &amp; X11 Socket Probing</strong>:
              Scans <code className="font-mono">/run/user/$UID/wayland-*</code>,{' '}
              <code className="font-mono">/tmp/.X11-unix/X*</code>, and{' '}
              <code className="font-mono">loginctl</code>/<code className="font-mono">elogind</code> before{' '}
              <code className="font-mono">gtk_init_check</code> even when started from GUI menus with blank
              environment variables.
            </p>
          </div>

          <details className="text-xs text-slate-600 pt-1">
            <summary className="cursor-pointer font-medium text-slate-700 hover:text-slate-900">
              Optional: Install from Terminal (apt)
            </summary>
            <div className="mt-2 flex items-center justify-between gap-2 bg-slate-900 text-slate-100 rounded-lg px-3.5 py-2.5 font-mono text-xs">
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
          </details>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Automated GitHub Releases (.deb CI/CD Pipeline)
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            <code className="font-mono">.github/workflows/release.yml</code> compiles the native C11 + GTK3
            binary against baseline <code className="font-mono">GLIBC_2.34</code>, runs the native{' '}
            <code className="font-mono">Xvfb</code> GTK3 self-test and repository test suite, builds{' '}
            <code className="font-mono">{pkgFileName}</code>, and publishes directly to{' '}
            <strong>GitHub Releases</strong> on every push to <code className="font-mono">main</code> or{' '}
            <code className="font-mono">v*.*.*</code> tag.
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs text-slate-700 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">Release Workflow Trigger</span>
              <span className="font-mono text-slate-800">push → main / v*.*.*</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">Published GitHub Release Asset</span>
              <span className="font-mono text-slate-800">{pkgFileName}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">Installed Binary Target</span>
              <span className="font-mono text-slate-800">/usr/bin/screenrec (GTK3 ELF)</span>
            </div>
          </div>

          {systemInfo && (
            <div className="text-xs text-slate-600 space-y-1 pt-1">
              <p className="font-semibold text-slate-800">Build Host Verification:</p>
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
