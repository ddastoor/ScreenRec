# ScreenRec

Natively compiled **C11 + GTK3** screen recording application for **Debian-based Linux distributions** — including **Debian 12 (Bookworm) & 13 (Trixie)**, **Ubuntu 22.04 & 24.04+ LTS**, **Linux Mint 21/22 & LMDE 6**, **MX Linux 23**, **Pop!_OS**, **KDE neon**, **Zorin OS**, **Elementary OS**, **Devuan**, and **Kali** — distributed as a **1-click GUI `.deb` installation file** with automatic **Wayland & X11** startup detection and direct **MP4** export.

## Features

- **Natively Compiled C11 + GTK3 Desktop App (`/usr/bin/screenrec`)**: Lightweight stripped x86-64 ELF binary (~72 KB) using native GTK3 widgets, `GtkHeaderBar`, `GtkFileChooserNative`, GIO `GDBusConnection`, and `libX11`—zero Electron bloat and zero localhost web wrapper.
- **Broad Multi-Distro Debian Compatibility**:
  - **Pre-`t64` & `t64` ABI Safe**: `DEBIAN/control` depends on concrete universal Debian packages (`libc6, libgtk-3-bin, libx11-6, ffmpeg, x11-utils, pulseaudio-utils`) with zero `|` OR-alternates, working seamlessly across Debian 12/13, Ubuntu 22.04/24.04+, Mint, MX Linux, Pop!_OS, and KDE Discover (`aptcc`).
  - **systemd & Non-systemd Support**: Works on both `systemd` distros (Debian, Ubuntu, Mint, Pop!_OS) and `SysVinit` / `elogind` distros (MX Linux, Devuan, antiX).
- **1-Click GUI Installation & Launch (Zero Command Line Needed)**: Double-click `screenrec_2.0.0_amd64.deb` in **GNOME Software**, **KDE Discover**, **GDebi**, **MintInstall**, or **MX Package Installer**, then launch directly from the installer's **Open** button or your desktop **Application Menu**.
- **Automatic Wayland & X11 Detection on GUI Startup**: Probes `/run/user/$UID/wayland-*`, `/tmp/.X11-unix/X*`, `systemctl --user`, and `loginctl`/`elogind` before `gtk_init_check`—even when launched from GUI menus with blank environment variables.
- **Flexible Capture Targets**: Record **Entire Screen**, **Application Window**, or **Browser Tab / Window** (via `org.freedesktop.portal.ScreenCast` + PipeWire on Wayland, or `libX11` window geometry + `x11grab` on X11).
- **System Audio + Microphone**: Record desktop/system audio (`.monitor` sink), optionally mix microphone voiceover (`amix`), or record silent video.
- **Mouse Cursor Visibility Toggle**: Include or hide the mouse pointer (`cursor_mode = 2|1` on Wayland Portal; `-draw_mouse 1|0` on X11).
- **Global Power-User Keyboard Shortcuts**: Default `F9` start/stop, `F10` pause/resume, `Alt+S` system audio, `Alt+M` microphone, and `Alt+C` cursor toggle—customizable in `~/.config/screenrec/shortcuts.conf` with global X11 `XGrabKey` hotkeys.
- **Direct MP4 Output**: Saves H.264 (`yuv420p`) + AAC `.mp4` files with `+faststart` metadata via native GTK Save dialog.

## Installing on Debian-Based Distros (GUI — No Terminal Needed)

1. Download **`screenrec_2.0.0_amd64.deb`** from **GitHub Releases** (or the companion web download panel).
2. Double-click `screenrec_2.0.0_amd64.deb` in your file manager to open your distro's **GUI Package Installer** and click **Install**.
3. Click **Open / Launch** inside the installer, or launch **ScreenRec** from your desktop **Application Menu** (*Sound & Video* / *Multimedia*).

*(Optional CLI alternative: `sudo apt install ./screenrec_2.0.0_amd64.deb`)*

## Building & Running the Automated Test Suite

```bash
# Compile native C11 + GTK3 binary and run C unit tests + headless Xvfb GTK3 & MP4 self-test
make -C native test

# Build dist-deb/screenrec_2.0.0_amd64.deb
npm run build:deb

# Run full repository test suite (native ELF verification, multi-distro .deb inspection, API & logic tests)
npm test
```