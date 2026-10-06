/*
 * Preload used by test/ui.integration.cjs.
 *
 * It deliberately does not load the production preload.  The renderer only
 * needs the small window.api contract below, which keeps this test isolated
 * from native dialogs, the user's clipboard, and the real userData folder.
 */
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const photoDir = path.join(root, 'test-photos');
const outputDir = path.join(root, 'test-output');

// Capture uncaught page errors before the renderer application starts.  The
// integration test listens for these messages in the browser process.
window.addEventListener('error', (event) => {
  ipcRenderer.send('ui-test-page-error', String(event.error?.stack || event.message || 'window error'));
});
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send('ui-test-page-error', String(event.reason?.stack || event.reason || 'unhandled rejection'));
});

function fixturePaths() {
  const names = ['sharp.bmp', 'blur.bmp', 'over.bmp', 'under.bmp'];
  // Keep the fixture name compatible with a future rename, while using the
  // checked-in `blur.bmp` on the current repository.
  if (fs.existsSync(path.join(photoDir, 'blurry.bmp'))) {
    names[1] = 'blurry.bmp';
  }
  const bad = path.join(outputDir, 'ui-bad-image.jpg');
  return [...names.map((name) => path.join(photoDir, name)), bad];
}

const api = {
  pickFolders: () => ipcRenderer.invoke('ui-test-pick-folders', photoDir),
  isDir: async (value) => {
    try { return fs.statSync(value).isDirectory(); } catch (_) { return false; }
  },
  samplesDir: () => photoDir,
  pluginsDir: () => path.join(root, 'plugins'),
  listPlugins: async () => [],
  listImages: () => ipcRenderer.invoke('ui-test-list-images', fixturePaths()),
  readFileBase64: async (filePath) => fs.readFileSync(filePath).toString('base64'),
  toFileUrl: async (filePath) => pathToFileURL(filePath).href,
  exportFiles: (sourcePaths, destDir) => ipcRenderer.invoke('ui-test-export', sourcePaths, destDir),
  pickExportFolder: () => outputDir,
  getEdition: async () => ({ version: 'ui-test', store: false }),
  copyText: async () => true,
  openPath: async () => true,
  minimizeWindow: () => {},
  closeWindow: () => {},
  // Test-only methods.  They are not used by the production renderer.
  testState: () => ipcRenderer.invoke('ui-test-state'),
  saveReport: (csv) => ipcRenderer.invoke('ui-test-save-report', String(csv ?? ''))
};

contextBridge.exposeInMainWorld('api', api);

