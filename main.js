const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

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
    backgroundColor: '#f4f6f9',   // 白色主题：启动闪屏也用浅色，避免黑屏闪一下
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
  // 最大化状态变化时告诉渲染进程，好切换按钮图标
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
}

// 用户流程复现：导入照片 → 分析 → 调阈值 → 单击改判 / 双击大图，采集每步结果
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
      // 示例按钮已从界面移除：改走真实导入接口（目录可用 KX_SMOKE_PHOTOS 覆盖）
      const flowDir = ${JSON.stringify(process.env.KX_SMOKE_PHOTOS || '')};
      if (!flowDir) { out.imported = 'skipped (no KX_SMOKE_PHOTOS)'; return out; }
      try { const r = await window.__kxDiag.addPhotos([flowDir]); out.imported = r.files; }
      catch (e) { out.imported = 'ERR: ' + ((e && e.message) || e); }
      await new Promise((r) => setTimeout(r, 8000));
      const sdir = flowDir;
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
  const noPlugin = process.argv.includes('--no-plugin');   // 测"不启用闭眼插件"的路径
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
        // 闭眼检测现在是插件（默认停用）：验收默认临时启用；加 --no-plugin 则测"不开插件"的路径
        const noPlugin = ${JSON.stringify(noPlugin)};
        const enabled = noPlugin
          ? { plugins: diag.disablePlugin('eye-smart') }
          : await diag.enablePlugin('eye-smart');
        const face = await diag.waitFace(noPlugin ? 2000 : 60000);
        const items = [];
        const scores = [];
        for (const f of ${JSON.stringify(files)}) {
          try { items.push(await diag.probe(f)); }
          catch (e) { items.push({ file: f, error: String((e && e.message) || e) }); }
          try { const sc = await diag.analyze(f); scores.push({ file: f, variants: sc }); }
          catch (e) { scores.push({ file: f, error: String((e && e.message) || e) }); }
        }
        return { face: face, plugins: enabled.plugins, noPlugin: noPlugin, items: items, scores: scores };
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
      // 先看看新手引导（第一步=设置语言，会自动打开设置窗口），截一张作为验收证据
      await new Promise((r) => setTimeout(r, 1600));   // 等页面初始化完成
      try {
        await mainWindow.webContents.executeJavaScript("window.__kxDiag && window.__kxDiag.startTour();");
      } catch (e) { console.log('TOUR_START_ERROR', e.message); }
      let tourStep1 = null;
      try {
        fs.mkdirSync(path.join(__dirname, 'test-output'), { recursive: true });
        await new Promise((r) => setTimeout(r, 1200));  // 等教程与设置窗口入场动画结束再截图
        const shot = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'test-output', 'tour-preview.png'), shot.toPNG());
        console.log('TOUR_PREVIEW test-output/tour-preview.png');
        tourStep1 = await mainWindow.webContents.executeJavaScript(`(() => {
          const g = (id) => document.getElementById(id) || {};
          const spot = g('tour-spot');
          return {
            visible: !g('tour').hidden,
            skipGone: !document.getElementById('tour-skip'),
            step: (g('tour-step').textContent || '').trim(),
            title: (g('tour-title').textContent || '').trim(),
            nextLabel: (g('tour-next').textContent || '').trim(),
            nextDisabled: !!g('tour-next').disabled,
            passThrough: g('tour').classList.contains('kx-pass'),
            langBtns: Array.from(document.querySelectorAll('#app-settings-overlay [data-set-lang]')).map((b) => b.dataset.setLang + (b.classList.contains('active') ? '(on)' : '')),
            tourBtnInSettings: !!document.querySelector('#app-settings-overlay #btn-tour'),
            tourBtnInThresholds: !!document.querySelector('#settings-panel #btn-tour'),
            settingsOpen: !g('app-settings-overlay').hidden,
            spotLeft: Math.round(parseFloat(spot.style.left || '0')),
            spotWidth: Math.round(parseFloat(spot.style.width || '0'))
          };
        })()`);
        console.log('TOUR_STEP1', JSON.stringify(tourStep1));
        fs.writeFileSync(path.join(__dirname, 'test-output', 'tour-audit.json'), JSON.stringify(tourStep1, null, 2));
        // 教程第一步就能切语言：用**真实鼠标输入**点 English（不是 element.click()），
        // 以此证明「教程层放行点击」生效——否则用户根本点不到语言按钮，也就无法通过第一步。
        const enHit = await mainWindow.webContents.executeJavaScript(`(() => {
          const b = document.querySelector('#app-settings-overlay [data-set-lang="en"]');
          const r = b.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          const top = document.elementFromPoint(x, y);
          return { x: x, y: y, topIsLangBtn: !!(top && top.dataset && top.dataset.setLang), topTag: top ? (top.id || top.className || top.tagName) : '' };
        })()`);
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: enHit.x, y: enHit.y });
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: enHit.x, y: enHit.y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: enHit.x, y: enHit.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 700));
        const enTour = await mainWindow.webContents.executeJavaScript(`(() => {
          const g = (id) => document.getElementById(id) || {};
          const spot = g('tour-spot');
          return { step: (g('tour-step').textContent || '').trim(), title: (g('tour-title').textContent || '').trim(),
                   nextLabel: (g('tour-next').textContent || '').trim(), nextDisabled: !!g('tour-next').disabled,
                   spotLeft: Math.round(parseFloat(spot.style.left || '0')),
                   settingsVisible: !g('app-settings-overlay').hidden,
                   clickHitLangBtn: ${JSON.stringify(enHit.topIsLangBtn)}, clickHitTag: ${JSON.stringify(enHit.topTag)} };
        })()`);
        console.log('TOUR_LANG_SWITCH', JSON.stringify(enTour));
        await mainWindow.webContents.executeJavaScript("document.querySelector('#app-settings-overlay [data-set-lang=\\\"zh\\\"]').click();");
        await new Promise((r) => setTimeout(r, 400));
        // 一路「下一步」到最后一步，核对「支持作者」一步的文案（已去掉「试用」字样）
        for (let i = 0; i < 7; i++) {
          await mainWindow.webContents.executeJavaScript("(() => { const n = document.getElementById('tour-next'); if (n && !n.disabled) n.click(); return true; })()");
          await new Promise((r) => setTimeout(r, 260));
        }
        await new Promise((r) => setTimeout(r, 400));
        const lastShot = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'test-output', 'tour-last-preview.png'), lastShot.toPNG());
        const tourLast = await mainWindow.webContents.executeJavaScript(`(() => {
          const g = (id) => document.getElementById(id) || {};
          return { step: (g('tour-step').textContent || '').trim(), title: (g('tour-title').textContent || '').trim(),
                   desc: (g('tour-desc').textContent || '').trim(), nextLabel: (g('tour-next').textContent || '').trim(),
                   spotLeft: Math.round(parseFloat(g('tour-spot').style.left || '0')) };
        })()`);
        console.log('TOUR_LAST', JSON.stringify(tourLast));
        fs.writeFileSync(path.join(__dirname, 'test-output', 'tour-last.json'), JSON.stringify(tourLast, null, 2));
      } catch (e) { console.log('TOUR_PREVIEW_ERROR', e.message); }
      // 关掉新手引导，避免它的遮罩挡住后续自动化点击与截图（跳过按钮已移除，只能一路「下一步」）
      for (let i = 0; i < 14; i++) {
        const state = await mainWindow.webContents.executeJavaScript(`(() => {
          const tr = document.getElementById('tour');
          const visible = !!(tr && !tr.hidden);
          try { localStorage.setItem('kx.onboarded', '1'); } catch (e) {}
          if (visible) {
            const n = document.getElementById('tour-next');
            if (n && n.disabled) {
              // 第一步「必须先选一个语言」：自动模式下替用户点中文，才能继续往下走
              const zh = document.querySelector('#app-settings-overlay [data-set-lang="zh"]');
              if (zh) { zh.click(); return 'chose-lang'; }
            }
            if (n) { n.click(); return 'clicked'; }
            return 'visible';
          }
          return 'hidden';
        })()`);
        if (state === 'hidden') break;
        await new Promise((r) => setTimeout(r, 320));
      }
      const tourGone = await mainWindow.webContents.executeJavaScript("document.getElementById('tour').hidden");
      console.log('TOUR_DISMISSED', tourGone);
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
            // 闭眼检测现由插件提供：报告插件清单与状态，不等待超时
            const st = window.__kxDiag.plugins();
            const eye = st.find((p) => p.id === 'eye-smart');
            faceState = eye ? (eye.enabled ? (eye.code || (eye.ready ? 'ready' : 'unknown')) : 'plugin-disabled') : 'plugin-missing';
          } catch (e) { faceState = 'error:' + e.message; }
        }
        return {
          hasApi: typeof window.api === 'object',
          hasDetectors: typeof Detectors === 'object',
          hasEyeModel: !!(window.__kxDiag),
          fetchTest: fetchTest,
          faceState: faceState,
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
      // UI 规则断言：插件开关是否真的联动阈值项与检测模式
      try {
        const audit = await mainWindow.webContents.executeJavaScript(`(async () => {
          try {
          // 主题对照度自检：取关键元素的文字色与最近的实心背景色
          const pickColor = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const cs = getComputedStyle(el);
            let n = el, bg = null;
            while (n && n !== document.documentElement) {
              const b = getComputedStyle(n).backgroundColor;
              if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') { bg = b; break; }
              n = n.parentElement;
            }
            return { color: cs.color, bg: bg || 'none', text: (el.textContent || '').trim().slice(0, 10) };
          };
          const colors = {
            logo: pickColor('.logo'),
            hintTitle: pickColor('#drop-hint .hint-title'),
            hintCta: pickColor('#hint-import'),
            overviewValue: pickColor('.overview-value'),
            status: pickColor('#status'),
            exportBtn: pickColor('#btn-export'),
            note: pickColor('.statusbar-note')
          };
          const pick = () => ({
            eyeRowHidden: !!document.getElementById('row-eye') && document.getElementById('row-eye').hidden,
            detectModeSelectGone: !document.getElementById('detect-mode'),
            hintTitle: document.querySelector('#drop-hint .hint-title').textContent,
            hintCta: document.getElementById('hint-import').textContent,
            sidebarGone: !document.getElementById('sidebar'),
            plugins: window.__kxDiag.plugins().map((p) => p.id + ':' + p.name + (p.enabled ? '(on)' : '(off)'))
          });
          await window.__kxDiag.enablePlugin('eye-smart');   // 会话级启用（不写用户设置）
          const on = pick();
          window.__kxDiag.disablePlugin('eye-smart');
          const off = pick();
          return { on: on, off: off, colors: colors };
          } catch (e) { return { error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 400) }; }
        })()`);
        console.log('UI_AUDIT', JSON.stringify(audit));
        fs.writeFileSync(path.join(__dirname, 'test-output', 'ui-audit.json'), JSON.stringify(audit, null, 2));
      } catch (e) { console.error('UI_AUDIT_ERROR', e.message); }
    } catch (e) {
      console.error('SMOKE_ERROR', e.message);
      process.exitCode = 1;
    }
    // 截图主界面（ui-preview.png），供人工检查 UI
    try {
      // 截图前把窗口抬到最前：窗口被遮挡时 Chromium 会跳过绘制，capturePage 会返回上一帧（面板/菜单拍不到）
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true);
      mainWindow.moveTop();
      await new Promise((r) => setTimeout(r, 600));
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
      // 插件面板（含声明与状态）也截一张，便于人工检查
      await mainWindow.webContents.executeJavaScript("document.getElementById('btn-plugins').click();");
      await new Promise((r) => setTimeout(r, 1500));
      const plug = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'plugins-preview.png'), plug.toPNG());
      console.log('PLUGINS_PREVIEW test-output/plugins-preview.png');
      // 阈值面板（液态玻璃滑块）也截一张
      await mainWindow.webContents.executeJavaScript("document.getElementById('btn-plugins').click(); document.getElementById('btn-settings').click();");
      await new Promise((r) => setTimeout(r, 1200));
      const set = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'settings-preview.png'), set.toPNG());
      console.log('SETTINGS_PREVIEW test-output/settings-preview.png');
      // 排序下拉展开（新自绘控件）截图：筛选栏平时要分析后才出现，这里临时显示以便截图与断言
      const sortState = await mainWindow.webContents.executeJavaScript(`(() => {
        const sp = document.getElementById('settings-panel');
        if (sp && !sp.hidden) document.getElementById('btn-settings').click();
        document.getElementById('filter-bar').hidden = false;
        document.getElementById('sort-btn').click();
        return { menuHidden: document.getElementById('sort-menu').hidden, items: document.querySelectorAll('#sort-menu .sort-item').length,
                 current: document.getElementById('sort-current').textContent };
      })()`);
      console.log('SORT_STATE', JSON.stringify(sortState));
      await new Promise((r) => setTimeout(r, 900));
      const sortShot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'sort-preview.png'), sortShot.toPNG());
      console.log('SORT_PREVIEW test-output/sort-preview.png');
      // 设置窗口（语言 / 外观 / 日志）截图 + 断言
      await mainWindow.webContents.executeJavaScript("document.getElementById('filter-bar').hidden = true; document.getElementById('btn-app-settings').click();");
      await new Promise((r) => setTimeout(r, 1300));
      const asShot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'app-settings-preview.png'), asShot.toPNG());
      console.log('APP_SETTINGS_PREVIEW test-output/app-settings-preview.png');
      const audit2 = await mainWindow.webContents.executeJavaScript(`(async () => {
        try {
          const q = (s) => document.querySelector(s);
          const before = {
            theme: document.body.dataset.theme,
            settingsVisible: !q('#app-settings-overlay').hidden,
            logLines: document.querySelectorAll('#log-list .log-line').length,
            logErrors: document.querySelectorAll('#log-list .log-line.error').length,
            logText: (q('#log-list').textContent || '').slice(0, 300),
            sortItems: document.querySelectorAll('#sort-menu .sort-item').length,
            sortCurrent: q('#sort-current').textContent,
            segLang: [...document.querySelectorAll('[data-set-lang]')].map((b) => b.dataset.setLang + (b.classList.contains('active') ? '(on)' : '')),
            segTheme: [...document.querySelectorAll('[data-set-theme]')].map((b) => b.dataset.setTheme + (b.classList.contains('active') ? '(on)' : '')),
            pluginNames: window.__kxDiag.plugins().map((p) => (p.id || p.file) + ':' + p.name)
          };
          // 亮色下核对"概览条/照片区"是否同底（以前 .quality-overview 的白色渐变 + .dropzone 的实色 var(--bg)
          // 会在交界处切出一条横线，用户称之为"栏杆"）
          const lightChrome = {
            overviewBg: getComputedStyle(q('.quality-overview')).backgroundColor,
            dropzoneBg: getComputedStyle(q('.dropzone')).backgroundColor,
            overviewCardShadow: getComputedStyle(q('.overview-card')).boxShadow,
            bodyImage: getComputedStyle(document.body).backgroundImage.slice(0, 70)
          };
          q('[data-set-theme="dark"]').click();
          await new Promise((r) => setTimeout(r, 700));
          const dark = { theme: document.body.dataset.theme, bodyBg: getComputedStyle(document.body).backgroundColor, textColor: getComputedStyle(document.body).color,
            overviewBg: getComputedStyle(q('.quality-overview')).backgroundColor,
            dropzoneBg: getComputedStyle(q('.dropzone')).backgroundColor,
            overviewCardShadow: getComputedStyle(q('.overview-card')).boxShadow,
            overviewCardShadowVar: getComputedStyle(q('.overview-card')).getPropertyValue('--card-shadow-hover').trim(),
            bodyImage: getComputedStyle(document.body).backgroundImage.slice(0, 70) };
          const darkShot = 1;
          // 「暗色 × 主题插件」组合核对：内置暗色默认值写在 body[data-theme="dark"] 上，
          // 主题插件若只写 :root 会被它压掉（青绿主题曾经如此）→ 这里两种组合都读一遍真实取色
          await window.__kxDiag.enablePlugin('theme-teal');
          await new Promise((r) => setTimeout(r, 300));
          const darkTeal = window.__kxDiag.themeVars();
          await window.__kxDiag.disablePlugin('theme-teal');
          await new Promise((r) => setTimeout(r, 250));
          const darkPlain = window.__kxDiag.themeVars();
          // 机制核对（暗色下）：内置暗色默认值写在 body[data-theme="dark"]（styles.css:1228），
          // 主题插件若只写 :root 会被它压掉（= 用户看到的"冲突"）；同写 body[data-theme="dark"] 才胜出
          const cssProbe = (() => {
            const el = document.getElementById('kx-plugin-css');
            const keep = el.textContent;
            el.textContent = ':root { --accent: #123456; }';
            const onlyRoot = getComputedStyle(document.body).getPropertyValue('--accent').trim();
            el.textContent = ':root { --accent: #123456; } body[data-theme="dark"] { --accent: #123456; }';
            const scoped = getComputedStyle(document.body).getPropertyValue('--accent').trim();
            el.textContent = keep;
            return { onlyRoot: onlyRoot, scopedSame: scoped };
          })();
          q('[data-log-filter="error"]').click();
          await new Promise((r) => setTimeout(r, 300));
          const filtered = document.querySelectorAll('#log-list .log-line').length;
          q('[data-log-filter="all"]').click();
          q('[data-set-lang="en"]').click();
          await new Promise((r) => setTimeout(r, 600));
          // 英文界面下打开插件面板，核对插件名与描述是否真的用了英文
          q('#app-settings-close').click();
          await new Promise((r) => setTimeout(r, 400));
          q('#btn-plugins').click();
          await new Promise((r) => setTimeout(r, 700));
          const en = {
            sortCurrent: q('#sort-current').textContent,
            pluginCardNames: [...document.querySelectorAll('.plugin-name')].map((n) => n.textContent),
            pluginCardDesc: [...document.querySelectorAll('.plugin-desc')].map((n) => n.textContent.slice(0, 40)),
            pluginCost: [...document.querySelectorAll('.plugin-meta')].map((n) => n.textContent.replace(/\s+/g, ' ').slice(0, 60)),
            logOpen: q('#log-open').textContent,
            pluginNames: window.__kxDiag.plugins().map((p) => (p.id || p.file) + ':' + p.shown)
          };
          const enShot = 1;
          q('#btn-plugins').click();
          await new Promise((r) => setTimeout(r, 400));
          q('#btn-app-settings').click();
          await new Promise((r) => setTimeout(r, 500));
          const enSettingsTitle = q('#app-settings-overlay .log-head span').textContent;
          const enThemeLabel = q('[data-set-theme="dark"]').textContent;
          const enPluginShot = await new Promise((r) => setTimeout(r, 200));
          q('[data-set-lang="zh"]').click();
          await new Promise((r) => setTimeout(r, 500));
          q('[data-set-theme="light"]').click();
          await new Promise((r) => setTimeout(r, 500));
          const back = { theme: document.body.dataset.theme, sortCurrent: q('#sort-current').textContent };
          await window.__kxDiag.enablePlugin('theme-teal');
          await new Promise((r) => setTimeout(r, 300));
          const lightTeal = window.__kxDiag.themeVars();
          await window.__kxDiag.disablePlugin('theme-teal');
          await new Promise((r) => setTimeout(r, 250));
          const lightPlain = window.__kxDiag.themeVars();
          // 过暗已整类移除：筛选栏应只剩 9 个 chip（all/kept/rejected/failed/blur/focus/over/under/eye），阈值面板应只剩 5 行滑块
          const chrome = {
            chips: Array.from(document.querySelectorAll('#filter-bar .chip')).map((c) => c.dataset.f),
            sliderRows: Array.from(document.querySelectorAll('.settings-panel .slider-item')).map((r) => (r.querySelector('input') || {}).id || ''),
            darkGone: !document.getElementById('dark-threshold') && !document.querySelector('#filter-bar .chip[data-f="dark"]')
          };
          // 阈值滑块：自由拖动（步进 0.02）→ 松手吸附到最近整数档，且拖动本身不触发重新检测
          const sl = document.getElementById('blur-threshold');
          const snap = { step: sl.step, from: sl.value };
          sl.value = '2.4';
          sl.dispatchEvent(new Event('input', { bubbles: true }));
          snap.freeValue = sl.value;
          sl.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 500));
          snap.afterChange = sl.value;
          snap.stored = localStorage.getItem('kx.threshold.' + sl.id);
          snap.fill = (document.querySelector('.slider-item input[type=range]').parentElement.querySelector('input').style.getPropertyValue('--kx-fill') || getComputedStyle(sl).getPropertyValue('--kx-fill') || '').trim();
          snap.scanning = !!window.__kxDiag.thrDirty();
          sl.value = '2';
          sl.dispatchEvent(new Event('input', { bubbles: true }));
          sl.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const logs = window.__kxDiag.logs(200);
          const errs = logs.filter((e) => e.level === 'error');
          return { before: before, lightChrome: lightChrome, dark: dark, en: en, enSettingsTitle: enSettingsTitle, enThemeLabel: enThemeLabel,
                   filteredErrCount: filtered, back: back, slider: snap, chrome: chrome,
                   themePlugins: { lightPlain: lightPlain, lightTeal: lightTeal, darkPlain: darkPlain, darkTeal: darkTeal, cssProbe: cssProbe },
                   errCount: errs.length, errSample: errs.slice(0, 3), logPath: await window.__kxDiag.logPath() };
        } catch (e) { return { error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 500) }; }
      })()`);
      console.log('UI_AUDIT2', JSON.stringify(audit2));
      fs.writeFileSync(path.join(__dirname, 'test-output', 'ui-audit2.json'), JSON.stringify(audit2, null, 2));
      // 深色模式截图：先关掉设置窗口，才看得到概览条与照片区在暗色下的真实底色
      await mainWindow.webContents.executeJavaScript("document.getElementById('app-settings-close').click();");
      await new Promise((r) => setTimeout(r, 400));
      await mainWindow.webContents.executeJavaScript("document.querySelector('[data-set-theme=\\\"dark\\\"]').click();");
      await new Promise((r) => setTimeout(r, 900));
      const darkShot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'dark-preview.png'), darkShot.toPNG());
      console.log('DARK_PREVIEW test-output/dark-preview.png');
      // 「暗色 + 青绿主题」截图：用户报告的冲突组合，留一张作为验收证据
      await mainWindow.webContents.executeJavaScript("window.__kxDiag.enablePlugin('theme-teal')");
      await new Promise((r) => setTimeout(r, 700));
      const darkTealShot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'dark-teal-preview.png'), darkTealShot.toPNG());
      console.log('DARK_TEAL_PREVIEW test-output/dark-teal-preview.png');
      await mainWindow.webContents.executeJavaScript("window.__kxDiag.disablePlugin('theme-teal')");
      await new Promise((r) => setTimeout(r, 300));
      await mainWindow.webContents.executeJavaScript("document.querySelector('[data-set-theme=\\\"light\\\"]').click();");
      await new Promise((r) => setTimeout(r, 400));
      // 英文插件面板截图（核对插件名 / 描述 / 费用是否英文）
      await mainWindow.webContents.executeJavaScript(`(async () => {
        document.getElementById('btn-app-settings').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('[data-set-lang="en"]').click();
        await new Promise((r) => setTimeout(r, 400));
        document.getElementById('app-settings-close').click();
        await new Promise((r) => setTimeout(r, 600));
        document.getElementById('btn-plugins').click();
      })()`);
      await new Promise((r) => setTimeout(r, 1300));
      const plugEn = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'plugins-en-preview.png'), plugEn.toPNG());
      console.log('PLUGINS_EN_PREVIEW test-output/plugins-en-preview.png');
      // 照片网格（卡片投影/hover 卡）截图：导入示例照片（示例按钮已移除，改走真实导入接口）
      const gridClick = await mainWindow.webContents.executeJavaScript(`(async () => {
        try {
          const bp = document.getElementById('btn-plugins');
          if (bp && !document.getElementById('plugins-panel').hidden) bp.click();   // 已开则关掉，避免挡视线
          // 关掉可能还开着的弹窗（例如流程测试最后弹出的「导出完成」），否则会挡住网格截图
          document.querySelectorAll('.modal-overlay').forEach((ov) => { if (!ov.hidden) ov.hidden = true; });
          document.getElementById('drop-hint').style.display = 'none';
          const dir = ${JSON.stringify(process.env.KX_SMOKE_PHOTOS || '')};
          if (!dir) return 'skipped (no KX_SMOKE_PHOTOS)';
          const r = await window.__kxDiag.addPhotos([dir]);
          return 'ok files=' + r.files;
        } catch (e) { return 'ERR: ' + ((e && e.message) || e); }
      })()`);
      console.log('GRID_CLICK', gridClick);
      await new Promise((r) => setTimeout(r, 9000));
      const gridShot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'test-output', 'grid-preview.png'), gridShot.toPNG());
      console.log('GRID_PREVIEW test-output/grid-preview.png');
      // 收尾：把语言/主题恢复成中文+浅色，否则下次手动启动应用会停在英文界面（这些设置是持久化的）
      const resetRes = await mainWindow.webContents.executeJavaScript(`(() => {
        try {
          const zh = document.querySelector('[data-set-lang="zh"]');
          if (zh && document.body.dataset.lang !== 'zh') zh.click();
          const li = document.querySelector('[data-set-theme="light"]');
          if (li && document.body.dataset.theme !== 'light') li.click();
          document.querySelectorAll('.modal-overlay:not([hidden])').forEach((o) => { o.hidden = true; });
        } catch (e) {}
        return 'reset lang=' + document.body.dataset.lang + ' theme=' + document.body.dataset.theme;
      })()`);
      console.log('SMOKE_RESET', resetRes);
      mainWindow.setAlwaysOnTop(false);   // 恢复窗口层级，别让测试窗口一直压在最前
    } catch (e) {
      mainWindow.setAlwaysOnTop(false);
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

// ---- 插件 ----
function getPluginsDir() {
  return path.join(app.getPath('appData'), 'kuaixuan', 'plugins');
}

// 内置插件（随安装包分发）。升级策略见 ensureBuiltinPlugins：
//   未改动过的内置插件会随版本更新；用户自己改过的不会被覆盖。
const BUILTIN_PLUGINS = ['eye-smart.js', 'fine-detect.js', 'theme-teal.js'];

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function ensureBuiltinPlugins() {
  const dir = getPluginsDir();
  const manifestPath = path.join(dir, '.builtin-manifest.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {}; } catch (_) { manifest = {}; }
    for (const f of BUILTIN_PLUGINS) {
      const src = path.join(__dirname, 'assets', 'plugins', f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(dir, f);
      const srcBuf = fs.readFileSync(src);
      const srcSha = sha1(srcBuf);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        manifest[f] = { installed: srcSha };
        continue;
      }
      const destSha = sha1(fs.readFileSync(dest));
      const known = manifest[f] && manifest[f].installed;
      if (known && destSha === known) {
        // 用户没改过：有新版本就更新
        if (srcSha !== destSha) {
          fs.copyFileSync(src, dest);
          manifest[f] = { installed: srcSha, updatedAt: new Date().toISOString() };
          console.log('内置插件已更新:', f);
        }
      } else if (!known) {
        // 首次建立清单：先把旧文件备份，再更新（用户如果改过，可从 .bak 找回）
        try { fs.copyFileSync(dest, dest + '.bak'); } catch (_) {}
        fs.copyFileSync(src, dest);
        manifest[f] = { installed: srcSha, adoptedAt: new Date().toISOString() };
      } else {
        // 用户改过：不动它，避免覆盖用户的自定义
        console.log('内置插件已被用户修改，跳过更新:', f);
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error('内置插件复制失败:', e);
  }
}
ipcMain.handle('plugins-dir', () => {
  const d = getPluginsDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
});
// 在文件管理器中打开插件目录（用户放插件的地方）
ipcMain.handle('open-plugins-dir', async () => {
  const d = getPluginsDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  const err = await shell.openPath(d);
  return { dir: d, error: err || null };
});
// 用系统浏览器打开外部链接（仅允许 http/https，供插件展示开源地址）
ipcMain.handle('open-external', async (_e, url) => {
  const s = String(url || '');
  if (!/^https:\/\/[^\s]+$/i.test(s)) return { error: '仅允许 https 链接' };
  try { await shell.openExternal(s); return { ok: true }; }
  catch (err) { return { error: String((err && err.message) || err) }; }
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
ipcMain.on('win-max', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win-close', () => { if (mainWindow) mainWindow.close(); });

// 最大化状态回传（供渲染进程切换图标与提示）
function sendMaxState() {
  if (!mainWindow) return;
  try { mainWindow.webContents.send('win-max-state', mainWindow.isMaximized()); } catch (_) {}
}

// ---- 版本信息 ----
ipcMain.handle('get-edition', () => ({ version: app.getVersion(), displayVersion: require('./package.json').displayVersion || app.getVersion(), store: !!process.windowsStore }));

// ---- 运行日志落盘：%APPDATA%\kuaixuan\logs\app.log（渲染进程出错时也写这里，方便用户反馈） ----
function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'app.log');
}
ipcMain.handle('log-path', () => logFilePath());
// 排障用环境信息：写进启动日志，用户反馈时一眼看出运行环境
ipcMain.handle('env-info', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform + ' ' + process.arch,
  os: (process.getSystemVersion ? process.getSystemVersion() : ''),
  locale: app.getLocale(),
  store: !!process.windowsStore,
  userData: app.getPath('userData'),
  logFile: logFilePath(),
  pluginsDir: (typeof getPluginsDir === 'function' ? getPluginsDir() : '')
}));
ipcMain.handle('log-append', (_e, line) => {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 单文件超过 2MB 时轮转一次，避免长期使用后无限增长
    try {
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
    } catch (_) {}
    fs.appendFileSync(file, String(line || '') + '\r\n', 'utf8');
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('open-log-file', async () => {
  const file = logFilePath();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, '', 'utf8'); }
    shell.showItemInFolder(file);
    return { path: file };
  } catch (_) { return { path: file }; }
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
