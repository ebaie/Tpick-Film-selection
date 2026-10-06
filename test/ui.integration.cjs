/*
 * Electron UI integration test for the navigation, donation dialog, quality
 * overview, detection controls, filtering, sorting, card actions, and CSV
 * reporting added to the photo-culler renderer.
 *
 * Run from the project directory:
 *   node_modules\\.bin\\electron.cmd test\\ui.integration.cjs
 *
 * The test uses a fresh BrowserWindow session and test/ui-preload.cjs, so no
 * native file dialogs or persistent user preferences are touched.  Its mock
 * API contract is documented in ui-preload.cjs: pickFolders -> listImages ->
 * toFileUrl, plus testState/saveReport for assertions.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'test-output');
const rendererFile = path.join(root, 'renderer', 'index.html');
const testPreload = path.join(__dirname, 'ui-preload.cjs');
const badImage = path.join(outputDir, 'ui-bad-image.jpg');

// Electron's own cache/config lives in a new directory too, in addition to
// the renderer's non-persistent session partition.
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-culler-ui-'));
app.setPath('userData', isolatedUserData);

let win;
let reportCsv = '';
let pickCalls = 0;
let pageErrors = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  throw new Error(message);
}

function assertPage(condition, message) {
  assert.ok(condition, message);
}

async function page(fn) {
  return win.webContents.executeJavaScript(`(${fn.toString()})()`, true);
}

async function waitForPage(predicate, timeout = 10000, label = 'page condition') {
  const source = predicate.toString();
  return win.webContents.executeJavaScript(`(async () => {
    const predicate = ${source};
    const end = Date.now() + ${timeout};
    let last;
    while (Date.now() < end) {
      try {
        last = await predicate();
        if (last) return last;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(${JSON.stringify(`Timed out waiting for ${label}`)});
  })()`, true);
}

async function screenshot(name) {
  fs.mkdirSync(outputDir, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });
  // A file with a valid image extension but invalid bytes exercises the
  // renderer's failed-read card and the “读取失败” filter.
  fs.writeFileSync(badImage, Buffer.from('this is deliberately not an image\n', 'utf8'));

  ipcMain.on('ui-test-page-error', (_event, message) => pageErrors.push(String(message)));
  ipcMain.handle('ui-test-pick-folders', () => { pickCalls += 1; return [path.join(root, 'test-photos')]; });
  ipcMain.handle('ui-test-list-images', (_event, paths) => paths);
  ipcMain.handle('ui-test-state', () => ({ pickCalls, reportCount: reportCsv ? 1 : 0 }));
  ipcMain.handle('ui-test-save-report', (_event, csv) => {
    reportCsv = String(csv);
    const file = path.join(outputDir, 'ui-upgrade-report.csv');
    fs.writeFileSync(file, reportCsv, 'utf8');
    return file;
  });
  ipcMain.handle('ui-test-export', (_event, sourcePaths, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    return sourcePaths.map((source) => path.join(destDir, path.basename(source)));
  });

  const isolatedSession = session.fromPartition(`ui-upgrade-${Date.now()}-${Math.random()}`, { cache: false });
  win = new BrowserWindow({
    width: 700,
    height: 720,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      session: isolatedSession,
      preload: testPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  const loadFailure = [];
  win.webContents.on('did-fail-load', (_event, code, description, url) => loadFailure.push({ code, description, url }));
  win.webContents.on('render-process-gone', (_event, details) => pageErrors.push(`render-process-gone: ${details.reason}`));
  await win.loadFile(rendererFile);
  if (loadFailure.length) fail(`renderer failed to load: ${JSON.stringify(loadFailure)}`);

  // Prevent the first-run tour timer from covering controls during the test.
  await page(() => {
    localStorage.setItem('kx.onboarded', '1');
    const tour = document.getElementById('tour');
    if (tour) tour.hidden = true;
  });
  await wait(350);
  await waitForPage(() => document.readyState === 'complete' && document.getElementById('btn-donate'), 5000, 'renderer controls');

  const initial = await page(() => ({
    donation: !!document.getElementById('btn-donate'),
    sidebar: !!document.getElementById('sidebar'),
    overview: !!document.getElementById('quality-overview'),
    errors: []
  }));
  assertPage(initial.sidebar && initial.donation && initial.overview, 'base upgraded UI is present');
  await screenshot('ui-upgrade-initial.png');

  // Donation: open, verify the bundled QR image and copy, then close with Esc.
  const donation = await page(async () => {
    const button = document.getElementById('btn-donate');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const overlay = document.getElementById('donation-overlay');
    const qr = overlay?.querySelector('.donation-qr');
    const opened = !!overlay && !overlay.hidden && !!qr && /支持作者/.test(overlay.textContent) && /奶茶/.test(overlay.textContent);
    const loaded = !!qr && qr.complete && qr.naturalWidth > 0;
    const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    // Start from the focused button, matching a real bubbling key event.
    document.activeElement?.dispatchEvent(escape);
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { opened, loaded, closed: !!overlay?.hidden };
  });
  assertPage(donation.opened, 'donation dialog opens with requested text');
  assertPage(donation.loaded, 'donation QR image loads from the app assets');
  assertPage(donation.closed, 'Escape closes the donation dialog');
  await screenshot('ui-upgrade-donation.png');

  // Navigation must not be immediately undone by the document click handler.
  const navSettings = await page(async () => {
    document.getElementById('nav-settings').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      open: !document.getElementById('settings-panel').hidden,
      active: document.getElementById('nav-settings').classList.contains('active')
    };
  });
  assertPage(navSettings.open && navSettings.active, 'settings navigation stays open and active');

  // Threshold persistence/reset and fine-mode selection.
  const controls = await page(async () => {
    const mode = document.getElementById('detect-mode');
    mode.value = 'fine';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const slider = document.getElementById('blur-threshold');
    slider.value = '3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const persisted = localStorage.getItem('kx.threshold.blur-threshold') === '3' && localStorage.getItem('kx.detectMode') === 'fine';
    document.getElementById('btn-threshold-reset').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { persisted, reset: slider.value === '2' && localStorage.getItem('kx.threshold.blur-threshold') === null };
  });
  assertPage(controls.persisted, 'threshold and detection mode persist');
  assertPage(controls.reset, 'threshold reset restores the default preference');

  // Focused inputs must consume global shortcuts instead of opening a picker.
  const shortcut = await page(async () => {
    const slider = document.getElementById('blur-threshold');
    slider.focus();
    const before = await window.api.testState();
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await window.api.testState();
    return { unchanged: before.pickCalls === after.pickCalls };
  });
  assertPage(shortcut.unchanged, 'Ctrl+O while an input is focused does not open a picker');

  // Import through the mocked pickFolders/listImages path.
  await page(() => document.getElementById('nav-workbench').click());
  await page(() => document.getElementById('btn-pick').click());
  await waitForPage(() => Number.parseInt(document.getElementById('overview-total')?.textContent || '0', 10) >= 5, 8000, 'photo import');
  await waitForPage(() => document.querySelectorAll('#grid .card').length >= 5, 5000, 'photo cards');
  const imported = await page(async () => ({
    cards: document.querySelectorAll('#grid .card').length,
    total: document.getElementById('overview-total').textContent,
    pickCalls: (await window.api.testState()).pickCalls
  }));
  assertPage(imported.cards >= 5 && imported.pickCalls === 1, 'mock import adds sharp, blur, exposure, and failed fixtures');

  // Scan all real fixture files.  Face detection may be unavailable in the
  // test process; the renderer is expected to skip it without rejecting scan.
  await page(() => document.getElementById('btn-scan').click());
  await waitForPage(() => /分析完成/.test(document.getElementById('status')?.textContent || ''), 45000, 'analysis completion');
  const analyzed = await page(() => ({
    analyzed: document.getElementById('overview-analyzed').textContent,
    score: document.getElementById('overview-score').textContent,
    filterVisible: !document.getElementById('filter-bar').hidden,
    cards: document.querySelectorAll('#grid .card').length,
    failed: document.querySelectorAll('#grid .card.failed').length
  }));
  assertPage(/5\s*\/\s*5/.test(analyzed.analyzed), `all fixtures analyzed (${analyzed.analyzed})`);
  assertPage(analyzed.score !== '—', 'quality overview has an average score');
  assertPage(analyzed.filterVisible && analyzed.cards >= 5 && analyzed.failed >= 1, 'result filters and failed card are rendered');

  // Manual verdict changes and all status filters update immediately.
  const filterResult = await page(async () => {
    const sharp = document.querySelector('#grid img[alt="sharp.bmp"], #grid img[alt="blurry.bmp"]')?.closest('.card');
    const before = sharp?.classList.contains('kept');
    sharp?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const changed = !!sharp && sharp.classList.contains('manual') && sharp.classList.contains(before ? 'rejected' : 'kept');
    const checkChip = async (name, selector) => {
      document.querySelector(`#filter-bar .chip[data-f="${name}"]`)?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const visible = [...document.querySelectorAll('#grid .card')].filter((card) => !card.hidden);
      // A legitimate filter can have zero matches (for example no kept
      // photos under a deliberately strict threshold); when matches exist,
      // every visible card must satisfy the selected predicate.
      return visible.every((card) => selector(card));
    };
    const kept = await checkChip('kept', (card) => card.classList.contains('kept'));
    const rejected = await checkChip('rejected', (card) => card.classList.contains('rejected'));
    const failed = await checkChip('failed', (card) => card.classList.contains('failed'));
    document.querySelector('#filter-bar .chip[data-f="all"]')?.click();
    return { changed, kept, rejected, failed };
  });
  assertPage(filterResult.changed, 'clicking a card toggles a manual verdict');
  assertPage(filterResult.kept && filterResult.rejected && filterResult.failed, `kept/rejected/failed filters apply immediately: ${JSON.stringify(filterResult)}`);

  // Sorting changes CSS order while preserving DOM indexes for context-menu
  // operations.  Remark and remove a known card after sorting.
  const cardActions = await page(async () => {
    const order = document.getElementById('sort-order');
    const originalCards = [...document.querySelectorAll('#grid .card')];
    order.value = 'quality-desc';
    order.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const cards = [...document.querySelectorAll('#grid .card')];
    const domUnchanged = cards.every((card, index) => card === originalCards[index]);
    const visualCards = cards.slice().sort((a, b) => Number(a.style.order) - Number(b.style.order));
    const score = (card) => Number.parseInt(card.querySelector('.quality-badge')?.textContent || '-1', 10);
    const ordered = domUnchanged && visualCards.every((card, index) => !index || score(visualCards[index - 1]) >= score(card));
    const target = document.querySelector('#grid img[alt="over.bmp"]')?.closest('.card');
    if (!target) return { ordered, remarked: false, removed: false };
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 36, clientY: 36 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getElementById('ctx-remark').click();
    const input = document.getElementById('remark-input');
    input.value = '排序后备注';
    document.getElementById('remark-ok').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const remarked = target.querySelector('.name')?.textContent === '排序后备注';
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 36, clientY: 36 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getElementById('ctx-remove').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const removed = !document.querySelector('#grid img[alt="over.bmp"]');
    return { ordered, remarked, removed };
  });
  assertPage(cardActions.ordered, 'quality sort applies CSS order without rebuilding card indexes');
  assertPage(cardActions.remarked && cardActions.removed, 'remark/remove after sorting targets the selected photo');

  // CSV report goes through the mock saveReport contract and contains useful
  // headers and fixture rows.
  await page(() => document.getElementById('btn-report').click());
  const reportEnd = Date.now() + 5000;
  while (!reportCsv && Date.now() < reportEnd) await wait(80);
  assert.ok(reportCsv, 'report is saved through window.api.saveReport');
  assert.ok(reportCsv.includes('文件名') && reportCsv.includes('质量分') && reportCsv.includes('sharp.bmp'), 'CSV report contains headers and fixture rows');

  // Narrow viewport smoke check: the upgraded layout must not create a
  // horizontal page scroll bar.
  win.setSize(640, 720);
  await wait(250);
  const layout = await page(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  assert.ok(layout.scrollWidth <= layout.width + 16 && layout.bodyWidth <= layout.width + 16,
    `small-window layout overflows horizontally (${JSON.stringify(layout)})`);
  await screenshot('ui-upgrade-final.png');

  if (pageErrors.length) {
    fail(`uncaught renderer errors: ${pageErrors.join('\n')}`);
  }
  console.log('UI_INTEGRATION_OK', JSON.stringify({ reportBytes: reportCsv.length, layout }));
}

async function main() {
  try {
    await app.whenReady();
    await run();
    if (win && !win.isDestroyed()) win.destroy();
    await app.quit();
  } catch (error) {
    console.error('UI_INTEGRATION_FAILED', error && error.stack ? error.stack : error);
    try { if (win && !win.isDestroyed()) await screenshot('ui-upgrade-failure.png'); } catch (_) {}
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}

main();
