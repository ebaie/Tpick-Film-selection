const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolders: () => ipcRenderer.invoke('pick-folders'),
  pluginsDir: () => ipcRenderer.invoke('plugins-dir'),
  openPluginsDir: () => ipcRenderer.invoke('open-plugins-dir'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  listPlugins: () => ipcRenderer.invoke('list-plugins'),
  listImages: (dirs) => ipcRenderer.invoke('list-images', dirs),
  readFileBase64: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  toFileUrl: (filePath) => ipcRenderer.invoke('to-file-url', filePath),
  exportFiles: (sourcePaths, destDir) => ipcRenderer.invoke('export-files', sourcePaths, destDir),
  pickExportFolder: () => ipcRenderer.invoke('pick-export-folder'),
  saveReport: (csv) => ipcRenderer.invoke('save-report', csv),
  getEdition: () => ipcRenderer.invoke('get-edition'),
  logAppend: (line) => ipcRenderer.invoke('log-append', line),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),
  getLogPath: () => ipcRenderer.invoke('log-path'),
  envInfo: () => ipcRenderer.invoke('env-info'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  minimizeWindow: () => ipcRenderer.send('win-min'),
  toggleMaximize: () => ipcRenderer.send('win-max'),
  onMaximizeChange: (cb) => ipcRenderer.on('win-max-state', (_e, isMax) => cb(!!isMax)),
  closeWindow: () => ipcRenderer.send('win-close')
});
