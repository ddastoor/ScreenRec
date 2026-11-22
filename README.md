# ScreenRec

Simple screen recording application for **Debian-based Linux distributions** (Debian 12+, Ubuntu 22.04/24.04+, Linux Mint, Pop!_OS, Kali) with automatic **X11 / Wayland** detection on startup and direct **MP4** export.

## Features

- **Startup Display Server Auto-Detection**: Automatically detects **Wayland** (`xdg-desktop-portal` + PipeWire) vs **X11** (`X.Org` / `x11grab`) as soon as the app launches—properly prioritizing Wayland sockets even when XWayland (`DISPLAY`) is present.
- **Flexible Capture Targets**: Record your **Entire Screen**, a single **Application Window**, or a **Browser Tab**.
- **System Audio + Microphone**: Record desktop/system audio, optionally mix in microphone voiceover, or record silent video.
- **Mouse Cursor Toggle**: Choose whether the mouse pointer is included or hidden in the screencast.
- **Standards-Compliant MP4 Output**: Exports H.264 (`yuv420p`) + AAC `.mp4` files with `+faststart` metadata via FFmpeg.
- **Debian `.deb` Release Packaging**: Ships with both a local `dpkg-deb` builder (`npm run build:deb`) and an automated GitHub Actions release pipeline (`.github/workflows/release.yml`) that publishes standalone `.deb` installers to GitHub Releases.

## Installing the `.deb` Package on Debian / Ubuntu

Download `screenrec_<version>_amd64.deb` from the **Releases** page and install via `apt`:

```bash
sudo apt install ./screenrec_1.0.0_amd64.deb
```

Then launch **ScreenRec** from your desktop application menu or run `screenrec` in a terminal.

## Development & Automated Test Suite

```bash
# Install dependencies
npm install

# Run the full unit + integration test suite (X11/Wayland detection, FFmpeg MP4 muxing, dpkg-deb verification)
npm test

# Start the development server on http://localhost:3000
npm run dev

# Build production assets and generate dist-deb/screenrec_1.0.0_amd64.deb
npm run build:deb
```

## Publishing a `.deb` Release on GitHub

Tagging a version automatically runs the full test suite on `ubuntu-latest`, builds the standalone Electron `.deb` installer, generates `SHA256SUMS.txt`, and publishes the `.deb` file to **GitHub Releases**:

```bash
git tag v1.0.0
git push origin v1.0.0
```