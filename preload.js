const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolders: () => ipcRenderer.invoke('pick-folders'),
  isDir: (p) => ipcRenderer.invoke('is-dir', p),
  samplesDir: () => ipcRenderer.invoke('samples-dir'),
  pluginsDir: () => ipcRenderer.invoke('plugins-dir'),
  listPlugins: () => ipcRenderer.invoke('list-plugins'),
  listImages: (dirs) => ipcRenderer.invoke('list-images', dirs),
  readFileBase64: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  toFileUrl: (filePath) => ipcRenderer.invoke('to-file-url', filePath),
  exportFiles: (sourcePaths, destDir) => ipcRenderer.invoke('export-files', sourcePaths, destDir),
  pickExportFolder: () => ipcRenderer.invoke('pick-export-folder'),
  saveReport: (csv) => ipcRenderer.invoke('save-report', csv),
  getEdition: () => ipcRenderer.invoke('get-edition'),
  copyText: (t) => ipcRenderer.invoke('clipboard-write', t),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  minimizeWindow: () => ipcRenderer.send('win-min'),
  closeWindow: () => ipcRenderer.send('win-close')
});
