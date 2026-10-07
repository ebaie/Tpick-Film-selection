const { app, BrowserWindow, dialog, ipcMain, protocol, net, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 自定义协议：model:// 用于渲染进程 fetch 人脸模型文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'model',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: '快调',
    frame: false,              // 无系统标题栏，用自绘工具栏（拖拽区 + 最小化/关闭按钮）
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--smoke')) runSmoke();
  if (process.argv.includes('--flow')) runFlow();
  if (process.argv.includes('--face-check')) runFaceCheck(process.argv[process.argv.indexOf('--face-check') + 1]);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 用户流程复现：点示例 → 分析 → 调阈值 → 激活（设备码激活码），采集每步结果
async function runFlow() {
  mainWindow.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await mainWindow.webContents.executeJavaScript(`(async () => {
      const out = { errors: [] };
      window.addEventListener('error', (e) => out.errors.push(e.message));
      window.addEventListener('unhandledrejection', (e) => out.errors.push('REJ:' + String(e.reason && e.reason.message || e.reason)));
      const S = () => document.getElementById('status').textContent;
      const blurTags = () => document.querySelectorAll('.tag.blur').length;
      localStorage.removeItem('kx.onboarded');  // flow 每次运行后重置教程标记，便于用户查看新手教程
      out.tour = 'onboarded=' + localStorage.getItem('kx.onboarded') + ' | hidden=' + document.getElementById('tour').hidden + ' | exists=' + !!document.getElementById('tour');
      document.getElementById('btn-samples').click();
      await new Promise((r) => setTimeout(r, 8000));
      const sdir = await window.api.samplesDir();
      const slist = await window.api.listImages([sdir]);
      const imgs = [...document.querySelectorAll('#grid img')];
      out.samples = S() + ' | cards=' + imgs.length + ' | loaded=' + imgs.filter((i) => i.complete && i.naturalWidth > 0).length + ' | diag=' + imgs.slice(0, 2).map((i) => (i.complete ? 'C' : '!') + (i.naturalWidth || 0) + '|' + i.src.slice(0, 45)).join(' ;; ') + ' | diagList=' + slist.length;
      document.getElementById('btn-scan').click();
      // 轮询等待分析完成（分析节奏较慢，最多等 100 秒）
      for (let w = 0; w < 200; w++) {
        await new Promise((r) => setTimeout(r, 500));
        if (S().includes('分析完成')) break;
      }
      out.analyzeBlur = blurTags();
      out.analyze = S() + ' | cards=' + document.querySelectorAll('.card').length + ' | tags=' + document.querySelectorAll('.tag').length + ' | blurTags=' + out.analyzeBlur;
      // 模糊调到「严格」（档位 0，阈值 40）：blur 标签应增多
      const s = document.getElementById('blur-threshold'); s.value = '0'; s.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
      const afterBlur = blurTags();
      // 欠曝调到「严格」（档位 0，阈值 20）：欠曝标签应增多
      const underBefore = document.querySelectorAll('.tag.under').length;
      const u = document.getElementById('under-threshold'); u.value = '0'; u.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
      const underAfter = document.querySelectorAll('.tag.under').length;
      out.thr = 'blur严格: ' + out.analyzeBlur + '→' + afterBlur + ' | 欠曝严格: ' + underBefore + '→' + underAfter;
      // 单击改判：点击第一张卡应切换状态并显示 ✓
      const c0 = document.querySelector('.card');
      const beforeCls = c0.className;
      c0.click();
      await new Promise((r) => setTimeout(r, 300));
      out.clickTest = 'before=' + beforeCls + ' | after=' + c0.className + ' | mark=' + !!c0.querySelector('.manual-mark') + ' | stats=' + document.getElementById('stats').textContent;
      // 双击第一张卡片 → 放大查看器应打开
      const card = document.querySelector('.card');
      if (card) card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const vImg = document.getElementById('viewer-img');
      out.viewer = 'hidden=' + document.getElementById('viewer').hidden + ' | src=' + (vImg.src || '').slice(0, 50) + ' | name=' + document.getElementById('viewer-name').textContent;
      document.getElementById('viewer').hidden = true;
      return out;
    })()`);
    console.log('FLOW_RESULT', JSON.stringify(res));
    try {
      const fsm = require('fs');
      fsm.mkdirSync(path.join(__dirname, 'test-output'), { recursive: true });
      fsm.writeFileSync(path.join(__dirname, 'test-output', 'flow.json'), JSON.stringify(res, null, 2));
    } catch (e) { console.error('FLOW_WRITE_ERROR', e.message); }
    setTimeout(() => app.quit(), 300);
  });
}

// 闭眼检测验收：electron . --face-check <图片目录>
// 结果同时落盘到 test-output/face-check.json —— Windows 上 Electron 的 stdout 不可靠（GUI 子系统不接父控制台）
async function runFaceCheck(dir) {
  const outDir = path.join(__dirname, 'test-output');
  const outPath = path.join(outDir, 'face-check.json');
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'face-check-start.txt'), 'called at ' + new Date().toISOString() + ' dir=' + String(dir)); } catch (_) {}
  mainWindow.webContents.once('did-finish-load', async () => {
    const result = { at: new Date().toISOString(), dir: dir || null, face: null, items: [], error: null };
    try {
      if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在: ' + dir);
      const files = fs.readdirSync(dir)
        .filter((f) => /\.(jpe?g|png|bmp|webp)$/i.test(f))
        .map((f) => path.join(dir, f));
      const res = await mainWindow.webContents.executeJavaScript(`(async () => {
        const diag = window.__kxDiag;
        if (!diag) return { error: '__kxDiag 未注入（renderer 未加载完成？）' };
        const face = await diag.waitFace(20000);
        const items = [];
        for (const f of ${JSON.stringify(files)}) {
          try { items.push(await diag.probe(f)); }
          catch (e) { items.push({ file: f, error: String((e && e.message) || e) }); }
        }
        return { face: face, items: items };
      })()`);
      Object.assign(result, res);
    } catch (e) {
      result.error = String((e && e.message) || e);
    }
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    } catch (e) { console.error('FACE_CHECK_WRITE_ERROR', e.message); }
    console.log('FACE_CHECK_RESULT', JSON.stringify(result));
    setTimeout(() => app.quit(), 200);
  });
}

// 冒烟测试：验证 preload 注入、页面加载、canvas 分析管线
async function runSmoke() {
  const fs = require('fs');
  const b64 = fs.readFileSync(path.join(__dirname, 'test-photos', 'sharp.bmp')).toString('base64');
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const res = await mainWindow.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = 'data:image/bmp;base64,${b64}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 256, 256);
        const id = ctx.getImageData(0, 0, 256, 256);
        let faceState = 'n/a';
        let fetchTest = 'n/a';
        if (window.__kxDiag) {
          try {
            const r = await fetch('model://local/face_landmarker.task');
            fetchTest = r.status + ':' + (r.headers.get('content-length') || '?');
          } catch (e) { fetchTest = 'err:' + e.message; }
          try {
            const f = await window.__kxDiag.waitFace(20000);
            faceState = (f && f.ready) ? 'ready' : ('notready:' + ((f && f.status) || '?'));
          } catch (e) { faceState = 'error:' + e.message; }
        }
        // 内置示例照片检测验证（全部 20 张）
        let samples = 'n/a';
        try {
          const sfiles = await window.api.listImages([await window.api.samplesDir()]);
          const mimeOf = (p) => { const m = p.match(/\.[^.]+$/); return m && m[0] === '.jpg' ? 'image/jpeg' : 'image/png'; };
          const probe = async (i) => {
            const b64 = await window.api.readFileBase64(sfiles[i]);
            const im = new Image();
            im.src = 'data:' + mimeOf(sfiles[i]) + ';base64,' + b64;
            await im.decode();
            const cc = document.createElement('canvas');
            cc.width = 256; cc.height = 256;
            const cx = cc.getContext('2d', { willReadFrequently: true });
            cx.drawImage(im, 0, 0, 256, 256);
            const iid = cx.getImageData(0, 0, 256, 256);
            return { blur: Math.round(Detectors.laplacianVariance(iid)), over: +Detectors.exposureStats(iid).overRatio.toFixed(2), under: +Detectors.exposureStats(iid).underRatio.toFixed(2) };
          };
          const all = [];
          for (let i = 0; i < sfiles.length; i++) all.push(await probe(i));
          samples = all;
        } catch (e) { samples = 'error:' + e.message; }
        return {
          hasApi: typeof window.api === 'object',
          hasDetectors: typeof Detectors === 'object',
          hasEyeModel: !!(window.__kxDiag),
          fetchTest: fetchTest,
          faceState: faceState,
          samplesPreview: samples,
          gridHidden: document.getElementById('grid').hidden,
          blurScore: Math.round(Detectors.laplacianVariance(id)),
          overRatio: +Detectors.exposureStats(id).overRatio.toFixed(3)
        };
      })()`);
      console.log('SMOKE_RESULT', JSON.stringify(res));
      try {
        fs.mkdirSync(path.join(__dirname, 'test-output'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'test-output', 'smoke.json'), JSON.stringify(res, null, 2));
      } catch (e) { console.error('SMOKE_WRITE_ERROR', e.message); }
    } catch (e) {
      console.error('SMOKE_ERROR', e.message);
      process.exitCode = 1;
    }
    // 截图当前界面（应显示激活遮罩），供人工检查 UI
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const image = await mainWindow.webContents.capturePage();
      fs.mkdirSync(path.join(__dirname, 'test-output'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'test-output', 'smoke.png'), image.toPNG());
      console.log('SMOKE_SCREENSHOT test-output/smoke.png');
      await mainWindow.webContents.executeJavaScript("document.getElementById('drop-hint').style.display='flex';");
      await new Promise((r) => setTimeout(r, 1000));
      const main = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'ui-preview.png'), main.toPNG());
      console.log('UI_PREVIEW test-output/ui-preview.png');
    } catch (e) {
      console.error('SMOKE_SHOT_ERROR', e.message);
    }
    setTimeout(() => app.quit(), 300);
  });
}

// ---- IPC ----

// 选择文件夹（可多选）
ipcMain.handle('pick-folders', async () => {
  if (!mainWindow) return [];
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择照片（可多选；整个文件夹请直接拖入窗口）',
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
});

// 列出图片文件：目录递归扫描（限深 4 层），单个文件直接纳入（拖拽导入用）
ipcMain.handle('list-images', async (_e, paths) => {
  const exts = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.gif']);
  const files = [];
  const seen = new Set();
  async function walk(p, depth) {
    let st;
    try { st = await fs.promises.stat(p); } catch (_) { return; }
    if (st.isFile()) {
      if (exts.has(path.extname(p).toLowerCase())) files.push(p);
      return;
    }
    if (!st.isDirectory() || depth > 4) return;
    let entries;
    try { entries = await fs.promises.readdir(p, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (seen.has(full)) continue;
      seen.add(full);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) files.push(full);
    }
  }
  for (const p of paths || []) await walk(p, 0);
  files.sort();
  return files;
});

// 读取文件为 base64（异步，避免分析期间冻结窗口）
ipcMain.handle('read-file-buffer', async (_e, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  return buf.toString('base64');
});

// 路径转 file:// URL（用于 <img> 直接加载，避免大图内存开销）
ipcMain.handle('to-file-url', (_e, filePath) => {
  return pathToFileURL(filePath).href;
});

// 复制文件到目标目录（导出合格片，异步逐个复制；文件名加 pick- 前缀）
ipcMain.handle('export-files', async (_e, sourcePaths, destDir) => {
  await fs.promises.mkdir(destDir, { recursive: true });
  const copied = [];
  for (const src of sourcePaths) {
    const dest = path.join(destDir, 'pick-' + path.basename(src));
    await fs.promises.copyFile(src, dest);
    copied.push(dest);
  }
  return copied;
});

// 判断路径是否为目录（拖拽导入用）
ipcMain.handle('is-dir', (_e, p) => {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
});

// 内置示例照片目录
ipcMain.handle('samples-dir', () => path.join(__dirname, 'assets', 'samples'));

// ---- 插件 ----
function getPluginsDir() {
  return path.join(app.getPath('appData'), 'kuaixuan', 'plugins');
}

// 内置插件（随安装包分发，首次启动复制到插件目录；用户已有同名文件则不覆盖）
const BUILTIN_PLUGINS = ['fine-detect.js', 'theme-teal.js'];
function ensureBuiltinPlugins() {
  const dir = getPluginsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of BUILTIN_PLUGINS) {
      const dest = path.join(dir, f);
      if (!fs.existsSync(dest)) {
        const src = path.join(__dirname, 'assets', 'plugins', f);
        if (fs.existsSync(src)) fs.copyFileSync(src, dest);
      }
    }
  } catch (e) {
    console.error('内置插件复制失败:', e);
  }
}
ipcMain.handle('plugins-dir', () => {
  const d = getPluginsDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
});
ipcMain.handle('list-plugins', () => {
  const d = getPluginsDir();
  if (!fs.existsSync(d)) return [];
  try {
    return fs.readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith('.js'))
      .map((f) => ({
        file: f,
        name: f.replace(/\.js$/i, ''),
        content: fs.readFileSync(path.join(d, f), 'utf8')
      }));
  } catch (err) {
    console.error('list-plugins error:', err);
    return [];
  }
});

// ---- 自定义窗口控制（无边框标题栏） ----
ipcMain.on('win-min', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win-close', () => { if (mainWindow) mainWindow.close(); });

// ---- 版本信息（无试用版，全部为正式版全功能） ----
ipcMain.handle('get-edition', () => ({ version: app.getVersion(), store: !!process.windowsStore }));

// ---- 剪贴板写入（主进程 clipboard，沙箱 preload 中不可用） ----
ipcMain.handle('clipboard-write', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

// ---- 打开资源管理器定位到路径（导出完成后查看） ----
ipcMain.handle('open-path', async (_e, p) => {
  try { await shell.openPath(String(p || '')); } catch (_) {}
  return true;
});

// 选择导出目标文件夹
ipcMain.handle('pick-export-folder', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择导出文件夹（合格片将复制到这里）',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled) return null;
  return res.filePaths[0];
});

// 将分析报告保存为 UTF-8 BOM CSV，便于 Excel 直接打开中文。
ipcMain.handle('save-report', async (_e, csv) => {
  if (!mainWindow) return null;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '保存选片报告',
    defaultPath: 'kuaixuan-report.csv',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, '\uFEFF' + String(csv || ''), 'utf8');
  return res.filePath;
});

app.whenReady().then(() => {
  try { fs.mkdirSync(path.join(__dirname, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'test-output', 'argv.txt'), JSON.stringify(process.argv)); } catch (_) {}
  // 测试模式（npm start 带 --reset-license）：每次启动重置授权，便于反复测试激活流程
  if (process.argv.includes('--reset-license')) {
    try {
      fs.rmSync(path.join(app.getPath('appData'), 'kuaixuan', 'license.json'), { force: true });
    } catch (_) {}
  }
  // model:// 协议 → 项目 models/ 目录（防目录穿越）
  protocol.handle('model', (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const modelsDir = path.resolve(__dirname, 'models');
    const filePath = path.resolve(modelsDir, rel);
    if (filePath !== modelsDir && !filePath.startsWith(modelsDir + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
  ensureBuiltinPlugins();  // 内置插件就位
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
