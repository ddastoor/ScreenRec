const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

/**
 * Auto-detects X11 vs Wayland immediately at Electron startup BEFORE app.whenReady()
 * so PipeWire ScreenCast portal flags are enabled automatically on Wayland sessions.
 */
function detectStartupDisplayProtocol() {
  const xdgSession = (process.env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  const waylandDisplay = (process.env.WAYLAND_DISPLAY || '').trim();
  const x11Display = (process.env.DISPLAY || '').trim();

  if (xdgSession === 'wayland' || Boolean(waylandDisplay)) {
    return {
      protocol: 'wayland',
      label: x11Display ? 'Wayland (with XWayland)' : 'Wayland',
      waylandDisplay: waylandDisplay || 'wayland-0',
      x11Display: x11Display || null,
    };
  }
  if (xdgSession === 'x11' || Boolean(x11Display)) {
    return {
      protocol: 'x11',
      label: 'X11 (X.Org Server)',
      waylandDisplay: null,
      x11Display: x11Display || ':0',
    };
  }
  return {
    protocol: 'headless',
    label: 'Linux Desktop Session',
    waylandDisplay: null,
    x11Display: null,
  };
}

const startupDisplay = detectStartupDisplayProtocol();

if (startupDisplay.protocol === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

let requestedCapturePrefs = {
  sourceType: 'monitor',
  systemAudio: true,
  includeCursor: true,
};

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: 'ScreenRec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Wire Electron's display media handler for X11 & Wayland PipeWire capture
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const types =
        requestedCapturePrefs.sourceType === 'window' ? ['window', 'screen'] : ['screen', 'window'];
      const sources = await desktopCapturer.getSources({ types });
      if (!sources || sources.length === 0) {
        callback({});
        return;
      }
      callback({
        video: sources[0],
        audio: requestedCapturePrefs.systemAudio ? 'loopback' : undefined,
      });
    } catch (err) {
      console.error('[ScreenRec Desktop] desktopCapturer failed:', err);
      callback({});
    }
  });

  const devUrl = process.env.SCREENREC_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('screenrec:get-startup-display', () => startupDisplay);

ipcMain.handle('screenrec:set-capture-prefs', (_event, prefs) => {
  requestedCapturePrefs = { ...requestedCapturePrefs, ...prefs };
  return { ok: true };
});

ipcMain.handle('screenrec:save-mp4-dialog', async (_event, { defaultFilename, rawBytes }) => {
  const videosDir = app.getPath('videos') || os.homedir();
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save MP4 Recording',
    defaultPath: path.join(videosDir, defaultFilename || 'screenrec.mp4'),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled || !filePath) {
    return { saved: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-desktop-'));
  const inputPath = path.join(tmpDir, 'raw.webm');
  try {
    fs.writeFileSync(inputPath, Buffer.from(rawBytes));
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        filePath,
      ]);
      ff.on('error', reject);
      ff.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))
      );
    });
    return { saved: true, filePath };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
