// 复现用户操作流程的测试：捕捉 JS 错误 + 检查各步骤结果
// 运行: node_modules\.bin\electron.cmd test\flow-test.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360, height: 860, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const res = await win.webContents.executeJavaScript(`(async () => {
      const out = { errors: [] };
      window.addEventListener('error', (e) => out.errors.push('uncaught: ' + e.message));
      // 1. 点「试用示例照片」
      document.getElementById('btn-samples').click();
      await new Promise((r) => setTimeout(r, 2500));
      out.samples = {
        status: document.getElementById('status').textContent,
        gridHidden: document.getElementById('grid').hidden,
        thumbImgs: document.querySelectorAll('#grid img').length
      };
      // 2. 点「开始分析」
      document.getElementById('btn-scan').click();
      await new Promise((r) => setTimeout(r, 12000));
      out.analyze = {
        status: document.getElementById('status').textContent,
        cards: document.querySelectorAll('#grid .card').length,
        tags: document.querySelectorAll('#grid .tag').length
      };
      // 3. 调阈值（模糊阈值拉满）
      const s = document.getElementById('blur-threshold');
      s.value = '300';
      s.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 600));
      out.afterThr = {
        status: document.getElementById('status').textContent,
        blurTags: document.querySelectorAll('#grid .tag.blur').length,
        cards: document.querySelectorAll('#grid .card').length
      };
      return out;
    })()`);
    console.log('FLOW_RESULT', JSON.stringify(res));
    win.webContents.capturePage().then((img) => {
      fs.mkdirSync(path.join(__dirname, '..', 'test-output'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', 'test-output', 'flow.png'), img.toPNG());
      console.log('FLOW_SHOT test-output/flow.png');
      app.quit();
    });
  });
});
