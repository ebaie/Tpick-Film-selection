// Run with electron test/eye-runtime.test.cjs <RS dataset> [feature-reference.json]
// Isolated profile and IPC: does not touch the user's plugins or app settings.
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const args = process.argv.slice(process.argv.findIndex(arg => arg.endsWith('eye-runtime.test.cjs')) + 1);
const [dataset, referenceFile] = args;
const uiOnly = args.includes('--ui-only');
const root = process.env.KX_EYE_APP_ROOT || path.resolve(__dirname, '..');
const out = path.join(path.resolve(__dirname, '..'), 'test-output');
const reference = referenceFile ? JSON.parse(fs.readFileSync(referenceFile)).rows : [];
app.setPath('userData', path.join(out, 'eye-runtime-profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'model', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let reportCsv = '';
let exportedFiles = [];
const handlers = {
  'list-plugins': () => ['eye-smart.js', 'fine-detect.js', 'theme-teal.js'].map(file => ({ file, content: fs.readFileSync(path.join(root, 'assets/plugins', file), 'utf8') })),
  'get-edition': () => ({ version: require('../package.json').version, displayVersion: require('../package.json').displayVersion, free: true, store: false }),
  'env-info': () => ({ app: require('../package.json').version, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, userData: app.getPath('userData') }),
  'log-append': () => true,
  'list-images': (_, files) => files,
  'to-file-url': (_, file) => pathToFileURL(file).href,
  'save-report': (_, csv) => { reportCsv = csv; return path.join(out, 'eye-runtime.csv'); },
  'log-path': () => path.join(out, 'eye-runtime.log'),
  'pick-export-folder': () => out,
  'export-files': (_, files) => { exportedFiles = files; return files; }
};
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
app.whenReady().then(async () => {
  protocol.handle('model', request => net.fetch(pathToFileURL(path.join(root, 'models', new URL(request.url).pathname)).href));
  const window = new BrowserWindow({ show: false, width: 1360, height: 860, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await window.loadURL(pathToFileURL(path.join(root, 'renderer/index.html')).href);
    const evaluate = code => window.webContents.executeJavaScript(code);
    const startup = await evaluate(`(async () => {
      for (let i=0;i<100 && (!window.__kxDiag || !window.__kxDiag.plugins().length);i++) await new Promise(r=>setTimeout(r,50));
      localStorage.setItem('kx.onboarded','1'); document.getElementById('tour').hidden=true;
      const ready = await window.__kxDiag.enablePlugin('eye-smart');
      return ready;
    })()`);
    assert.equal(startup.ok, true, JSON.stringify(startup));
    assert.equal(startup.plugins.find(p => p.id === 'eye-smart').version, '1.4');
    const items=[];
    const regressions = [{photo:'rs_0051.jpg',label:'open'},{photo:'rs_0200.jpg',label:'open'},
      {photo:'rs_0010.jpg',label:'closed'},{photo:'rs_0017.jpg',label:'closed'}];
    const inputRows = new Map((uiOnly ? reference.filter(r => ['rs_0004.jpg','rs_0743.jpg','rs_1099.jpg'].includes(r.photo)) : reference).map(row=>[row.photo,row]));
    for (const row of regressions) inputRows.set(row.photo, {...row,labelSource:'user-reported'});
    for (const row of inputRows.values()) {
      const file=path.join(dataset,'photos',row.photo);
      const probe=await evaluate(`window.__kxDiag.probe(${JSON.stringify(file)})`);
      if (probe.eye && probe.eye.faces) {
        assert.ok(probe.eye.faceCount > 0 && probe.eye.faceCount <= 8);
        for (const face of probe.eye.faces) {
          assert.ok(face.status !== 'detector-error', row.photo + ': ' + face.error);
          if (face.reliable) {
            assert.ok(Number.isFinite(face.p) && face.p >= 0 && face.p <= 1);
            assert.ok(face.evidence && face.feat.length === 6);
          }
        }
      }
      items.push({photo:row.photo,label:row.label,labelSource:row.labelSource || 'dataset',...probe});
      if(items.length%50===0)console.log('RUNTIME',items.length+'/'+inputRows.size);
    }
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'eye-runtime-v1.4-samples.json'),JSON.stringify({items},null,2));
    for (const row of regressions) {
      const item=items.find(item=>item.photo===row.photo);
      if (row.label==='open') assert.equal(item.eyeClosed,false,row.photo+' is reported open: '+JSON.stringify(item.eye));
      else assert.notEqual(item.eyeState,'open',row.photo+' is reported closed: '+JSON.stringify(item.eye));
    }
    const picks=['rs_0743.jpg','rs_1099.jpg','rs_0017.jpg','rs_0004.jpg',...regressions.map(row=>row.photo)];
    const borderline=items.find(i=>i.eye && i.eye.p>=.70 && i.eye.p<.86 && i.eye.bothClosedEligible && i.eye.closedSupported && i.eye.reliable);
    if(borderline)picks.push(borderline.photo);
    const files=[...new Set(picks)].map(file=>path.join(dataset,'photos',file));
    const ui=await evaluate(`(async () => {
      const diag=window.__kxDiag;
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      document.querySelector('[data-set-lang="zh"]').click();
      document.getElementById('tour').hidden=true;
      document.getElementById('app-settings-close').click();await sleep(400);
      await diag.addPhotos(${JSON.stringify(files)});
      document.getElementById('btn-scan').click();
      for(let i=0;i<1000;i++){await sleep(20);if(document.getElementById('btn-scan').textContent.includes('开始'))break;}
      const before=diag.results();
      const version=document.querySelector('.brand .version').textContent;
      const filterStates={};
      for(const state of ['kept','rejected','review']) {
        document.querySelector('[data-f="'+state+'"]').click();
        filterStates[state]=[...document.querySelectorAll('.card')].map((card,i)=>!card.hidden?before[i].path:null).filter(Boolean);
      }
      document.querySelector('[data-f="all"]').click();
      document.getElementById('btn-report').click(); await sleep(100);
      document.getElementById('btn-export').click(); await sleep(100);
      document.getElementById('export-close').click();
      const slider=document.getElementById('eye-threshold');
      slider.value='0';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));await sleep(500);
      document.getElementById('btn-scan').click();await sleep(300);
      const strict=diag.results();
      slider.value='4';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));await sleep(500);
      document.getElementById('btn-scan').click();await sleep(300);
      const relaxed=diag.results();
      // Manual choices survive cached rejudgement.
      const card=document.querySelector('.card');card.click();await sleep(650);
      const manualBefore=diag.results()[0];
      slider.value='2';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));await sleep(500);
      document.getElementById('btn-scan').click();await sleep(300);
      const manualAfter=diag.results()[0];
      const menuState=action=>{
        card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
        document.getElementById('ctx-'+action).click();
        return diag.results()[0];
      };
      const manualReview=menuState('review'), manualRejected=menuState('reject'), manualKept=menuState('keep');
      document.querySelector('[data-f="kept"]').click();
      const doubleBefore=diag.results()[0];
      card.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await sleep(70);
      const firstClickVisible=!card.hidden, firstClickState=diag.results()[0];
      card.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));
      card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await sleep(700);
      const doubleAfter=diag.results()[0], viewerOpened=!document.getElementById('viewer').hidden, stayedVisible=!card.hidden;
      document.getElementById('viewer-close').click();
      document.querySelector('[data-f="all"]').click();
      return {before,strict,relaxed,manualBefore,manualAfter,reviewBadges:document.querySelectorAll('.eye-review').length,
        filterStates,version,manualReview,manualRejected,manualKept,doubleBefore,doubleAfter,firstClickVisible,firstClickState,viewerOpened,stayedVisible,
        eyeLibrary:!!window.EyeDetector,donationLoaded:!!document.querySelector('#donation-overlay img')};
    })()`);
    assert.ok(ui.before.length===files.length);
    assert.equal(ui.version,'V2.01');
    const expectedKept=ui.before.filter(r=>r.state==='kept').map(r=>r.path);
    assert.deepEqual(ui.filterStates.kept,expectedKept);
    assert.deepEqual(ui.filterStates.rejected,ui.before.filter(r=>r.state==='rejected').map(r=>r.path));
    assert.deepEqual(ui.filterStates.review,ui.before.filter(r=>r.state==='review').map(r=>r.path));
    assert.deepEqual(exportedFiles,expectedKept,'batch export must exclude review photos');
    assert.equal(ui.manualReview.state,'review');
    assert.equal(ui.manualRejected.state,'rejected');
    assert.equal(ui.manualKept.state,'kept');
    assert.deepEqual(ui.doubleBefore,ui.doubleAfter,'double-click must not change judgement');
    assert.deepEqual(ui.doubleBefore,ui.firstClickState,'first click of a double-click must not change judgement');
    assert.equal(ui.firstClickVisible,true,'first click must not remove the photo before the second click');
    assert.equal(ui.viewerOpened,true);
    assert.equal(ui.stayedVisible,true,'double-clicked good photo must stay in the good filter');
    for(const row of ui.before) {
      const probe=items.find(item=>row.path.endsWith(item.photo));
      if(probe && probe.eye && row.eye) {
        // Two landmark passes amplify small floating-point differences; compare within 0.5 percentage points.
        assert.ok(row.eye.p === probe.eye.p || Number.isFinite(row.eye.p) && Number.isFinite(probe.eye.p) && Math.abs(row.eye.p-probe.eye.p)<.005,
          'probe and normal analysis must sample the same original image: '+row.path+' '+row.eye.p+' vs '+probe.eye.p);
      }
    }
    for(const wink of ['rs_0743.jpg','rs_1099.jpg']) {
      const result=ui.strict.find(r=>r.path.endsWith(wink));
      assert.ok(!result.reasons.includes('eye'),wink+' must not be flagged BOTH closed');
    }
    if(borderline){
      const strict=ui.strict.find(r=>r.path.endsWith(borderline.photo));
      const relaxed=ui.relaxed.find(r=>r.path.endsWith(borderline.photo));
      assert.ok(strict.reasons.includes('eye'),'strict threshold must rejudge cached probability');
      assert.ok(!relaxed.reasons.includes('eye'),'relaxed threshold must remove cached eye verdict');
      assert.equal(strict.eye.p,relaxed.eye.p,'threshold updates must not re-run inference');
    }
    assert.equal(ui.manualAfter.manual,true);
    assert.equal(ui.manualBefore.kept,ui.manualAfter.kept);
    assert.ok(ui.reviewBadges>0,'uncertain eyes must be visible');
    assert.ok(reportCsv.includes('眼部判定') && reportCsv.includes('闭眼概率'));
    fs.mkdirSync(out,{recursive:true});
    if(ui.before.some(row=>row.review)) assert.ok(reportCsv.includes('待复核'));
    const counts = {};
    for (const item of items) {
      const key = item.label + ':' + item.eyeState;
      counts[key] = (counts[key] || 0) + 1;
    }
    fs.writeFileSync(path.join(out,uiOnly ? 'eye-ui-v1.4.json' : 'eye-runtime-v1.4.json'),JSON.stringify({items,ui,counts},null,2));
    fs.writeFileSync(path.join(out,'eye-runtime-v1.4.csv'),'\uFEFF'+reportCsv);
    fs.writeFileSync(path.join(out,'eye-runtime-v1.4.png'),(await window.webContents.capturePage()).toPNG());
    console.log('EYE_RUNTIME_OK',JSON.stringify({photos:items.length,uiPhotos:ui.before.length,reviewBadges:ui.reviewBadges}));
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
