const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenRecDesktop', {
  isDesktopApp: true,
  getStartupDisplayInfo: () => ipcRenderer.invoke('screenrec:get-startup-display'),
  setCapturePrefs: (prefs) => ipcRenderer.invoke('screenrec:set-capture-prefs', prefs),
  saveMp4WithDialog: (payload) => ipcRenderer.invoke('screenrec:save-mp4-dialog', payload),
});
