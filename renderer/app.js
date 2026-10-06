/* 快选 · 摄影师自动选片 —— 前端逻辑 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const dropzone = $('dropzone');
  const dropHint = $('drop-hint');
  const btnPick = $('btn-pick');
  const btnScan = $('btn-scan');
  const btnExport = $('btn-export');
  const btnReset = $('btn-reset');
  const statusEl = $('status');
  const statsEl = $('stats');

  const blurSlider = $('blur-threshold');
  const overSlider = $('over-threshold');
  const underSlider = $('under-threshold');
  const darkSlider = $('dark-threshold');
  const focusSlider = $('focus-threshold');
  const eyeSlider = $('eye-threshold');
  const thresholdSliders = [blurSlider, overSlider, underSlider, darkSlider, focusSlider, eyeSlider];
  for (const slider of thresholdSliders) {
    const saved = localStorage.getItem('kx.threshold.' + slider.id);
    if (saved !== null && /^[0-4]$/.test(saved)) slider.value = saved;
  }

  const MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff'
  };
  const REASON_LABEL = { blur: '模糊', over: '过曝', under: '欠曝', eye: '闭眼', dark: '过暗', focus: '虚焦' };
  const REASON_LABEL_EN = { blur: 'Blur', over: 'Over', under: 'Under', eye: 'Eye Closed', dark: 'Dark', focus: 'OOF' };
  const reasonLabel = (rz) => (lang === 'en' && REASON_LABEL_EN[rz] ? REASON_LABEL_EN[rz] : (REASON_LABEL[rz] || rz));
  let lang = localStorage.getItem('kx.lang') || 'zh';  // 语言(必须在顶部声明,LEVEL_LABEL 依赖)

  // 检测标准：五档中文（非常严格 / 严格 / 标准 / 宽松 / 非常宽松）→ 实际阈值
  const LEVEL_LABEL_ZH = ['非常严格', '严格', '标准', '宽松', '非常宽松'];
  const LEVEL_LABEL_EN = ['Very Strict', 'Strict', 'Standard', 'Relaxed', 'Very Relaxed'];
  const LEVEL_LABEL = () => (lang === 'en' ? LEVEL_LABEL_EN : LEVEL_LABEL_ZH);
  const BLUR_LEVELS = [400, 200, 100, 50, 20];  // 档位0=非常严格(400,稍模糊即标) → 档位4=非常宽松(20)
  const OVER_LEVELS = [3, 7, 12, 20, 35];
  const UNDER_LEVELS = [10, 25, 40, 55, 70];
  const DARK_LEVELS = [130, 110, 90, 70, 50];   // 过暗：平均亮度低于该值判过暗
  const FOCUS_LEVELS = [0.4, 0.5, 0.6, 0.75, 0.85];  // 虚焦：中央（主体）模糊块比例达到该值判虚焦（默认标准 0.6）
  const EAR_LEVELS = [0.15, 0.18, 0.2, 0.22, 0.25];  // 闭眼：双眼 EAR 低于该值判闭眼

  let files = [];      // [{path, name}]
  let results = [];    // [{path, name, thumbUrl, metrics, reasons, kept, manual}]
  let scanning = false;
  let abortScan = false;        // 分析中请求取消（清空按钮随时可中止）
  let paused = false;           // 暂停分析（点「暂停分析」挂起，点「继续分析」恢复）
  let exportDir = localStorage.getItem('kx.exportDir') || '';  // 自定义导出位置
  let plugins = [];             // 已加载插件 [{...def, enabled}]
  let plugCssEl = null;
  let detectMode = localStorage.getItem('kx.detectMode') === 'fine' ? 'fine' : 'standard';
  let sortOrder = 'import';
  let remarkIndex = -1;
  let viewerIndex = -1;
  let faceTask = null;

  // ---------- 闭眼检测（face-api） ----------
  let faceReady = false;
  async function initFace() {
    try {
      // 加载超时保护：模型加载挂起时不阻塞后续
      const loaded = await Promise.race([
        Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri('model://local'),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri('model://local')
        ]),
        new Promise((r) => setTimeout(() => r('__timeout__'), 8000))
      ]);
      if (loaded === '__timeout__') { console.warn('人脸模型加载超时（闭眼检测将跳过）'); return; }
      // 强制 CPU 推理后端：避免 WebGL 上下文在大量画布操作后退化导致推理挂起/极慢
      try {
        if (faceapi.tf && faceapi.tf.setBackend) {
          await faceapi.tf.setBackend('cpu');
        }
      } catch (e) { console.warn('人脸推理后端切换失败:', e.message); }
      faceReady = true;
      console.log('人脸模型加载成功（CPU 推理）');
    } catch (err) {
      console.error('人脸模型加载失败（闭眼检测将跳过）:', err);
      faceReady = false;
    }
  }
  initFace();

  function earOf(pts) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const width = d(pts[0], pts[3]);
    return width > 0 ? (d(pts[1], pts[5]) + d(pts[2], pts[4])) / (2 * width) : null;
  }

  // 检测主脸双眼 EAR（睁眼约 0.25-0.35，闭眼约 0.1-0.15）；无脸/出错/超时返回 null
  async function eyeEAR(canvas) {
    // A timed-out inference may still be running. Do not accumulate background tasks.
    if (!faceReady || faceTask) return null;
    let timer;
    try {
      const task = Promise.resolve(faceapi
        .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: detectMode === 'fine' ? 320 : 224 }))
        .withFaceLandmarks());
      faceTask = task;
      const release = () => { if (faceTask === task) faceTask = null; };
      task.then(release, release);
      const res = await Promise.race([
        task,
        new Promise((r) => { timer = setTimeout(() => r('__timeout__'), 4000); })
      ]);
      if (res === '__timeout__') { console.warn('闭眼检测超时，跳过'); return null; }
      if (!res) return null;
      const left = earOf(res.landmarks.getLeftEye());
      const right = earOf(res.landmarks.getRightEye());
      return left === null || right === null ? null : (left + right) / 2;
    } catch (err) {
      console.error('闭眼检测错误:', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 工具函数 ----------
  const extOf = (p) => { const m = p.match(/\.[^.]+$/); return m ? m[0].toLowerCase() : ''; };
  const nameOf = (p) => p.split(/[\\/]/).pop();

  function setStatus(t) { statusEl.textContent = t; }
  function setStats(t) { statsEl.textContent = t; }
  function getThresholds() {
    return {
      blur: BLUR_LEVELS[+blurSlider.value],
      over: OVER_LEVELS[+overSlider.value],
      under: UNDER_LEVELS[+underSlider.value],
      dark: DARK_LEVELS[+darkSlider.value],
      focus: FOCUS_LEVELS[+focusSlider.value],
      eye: EAR_LEVELS[+eyeSlider.value]
    };
  }
  function updateSliderLabels() {
    $('blur-val').textContent = LEVEL_LABEL()[+blurSlider.value];
    $('over-val').textContent = LEVEL_LABEL()[+overSlider.value];
    $('under-val').textContent = LEVEL_LABEL()[+underSlider.value];
    $('dark-val').textContent = LEVEL_LABEL()[+darkSlider.value];
    $('focus-val').textContent = LEVEL_LABEL()[+focusSlider.value];
    $('eye-val').textContent = LEVEL_LABEL()[+eyeSlider.value];
  }
  function judge(m, thr) {
    const reasons = [];
    // 分区锐度判定：全图模糊块 ≥70% 判「模糊」（主体背景全糊）；
    // 中央 2x2（主体区域）模糊块达到虚焦阈值判「虚焦」（主体脱焦、背景清晰）
    if (m.blurBlocks && m.blurBlocks.length >= 16) {
      const vars = m.blurBlocks;
      const allRatio = vars.filter((v) => v < thr.blur).length / vars.length;
      const center = [vars[5], vars[6], vars[9], vars[10]];
      const centerRatio = center.filter((v) => v < thr.blur).length / center.length;
      if (allRatio >= 0.7) reasons.push('blur');
      else if (centerRatio >= thr.focus) reasons.push('focus');
    }
    if (m.overRatio * 100 > thr.over) reasons.push('over');
    if (m.underRatio * 100 > thr.under) reasons.push('under');
    if (Number.isFinite(m.ear) && m.ear < thr.eye) reasons.push('eye');
    if (m.avgLuma < thr.dark) reasons.push('dark');
    // 功能插件自定义检测（插件需激活后可用）
    for (const p of plugins) {
      if (!(p.enabled && p.type === 'feature' && typeof p.detect === 'function')) continue;
      try {
        const extra = p.detect(m);
        if (extra && extra.reason) {
          if (!REASON_LABEL[extra.reason]) REASON_LABEL[extra.reason] = extra.label || extra.reason;
          reasons.push(extra.reason);
        }
      } catch (err) { console.error('plugin detect error:', p.name, err); }
    }
    return reasons;
  }

  // ---------- 加载（追加模式：新增照片不清空已有列表） ----------
  async function addPhotos(paths) {
    setStatus(t('scanning'));
    const newPaths = await window.api.listImages(paths);
    if (!newPaths.length) { setStatus(t('noImages')); return; }
    const existing = new Set(files.map((f) => f.path));
    let added = newPaths.filter((p) => !existing.has(p)).map((p) => ({ path: p, name: nameOf(p) }));
    if (!added.length) { setStatus(t('dupPhotos')); return; }
    files.push(...added);
    log('添加照片 ' + added.length + ' 张，共 ' + files.length + ' 张');
    dropHint.hidden = true;
    grid.hidden = false;
    btnScan.disabled = false;
    btnReset.disabled = false;
    btnExport.disabled = true;
    // 追加渲染待分析占位卡
    const frag = document.createDocumentFragment();
    for (const f of added) {
      frag.appendChild(buildCard({ ...f, metrics: null, reasons: [], kept: true, manual: false, pending: true }));
    }
    grid.appendChild(frag);
    setStats(`共 ${files.length} 张照片`);
    filterBar.hidden = true;  // 新照片未分析，隐藏筛选
    resetFilter();
    updateOverview();
    applySort();
    setStatus(`已添加 ${added.length} 张 · 共 ${files.length} 张 · 点击「开始分析」`);
    loadThumbs(added); // 新照片立即以原图显示
  }

  // 加载后立即用 file:// 直连显示照片（浏览器原生解码，无需 IPC 读文件）
  async function loadThumbs(list) {
    if (!list.length) return;
    const all = grid.querySelectorAll('.card');
    const start = all.length - list.length;  // 新照片卡片在列表末尾
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const card = all[start + i];
      const ci = card && card.querySelector('img');
      if (ci) {
        try {
          const url = await window.api.toFileUrl(f.path);
          ci.src = url;  // 原图直连，浏览器按卡片尺寸缩放显示
        } catch (_) { /* 该张保留灰色占位，分析时按失败处理 */ }
      }
      if ((i + 1) % 8 === 0 && !scanning) setStatus(`加载照片 ${i + 1}/${list.length}…`);
    }
  }

  async function pickFolders() {
    if (scanning) return;
    const dirs = await window.api.pickFolders();
    if (dirs && dirs.length) await addPhotos(dirs);
  }

  // 拖拽导入（目录或图片文件）
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    if (scanning) return;
    const paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    if (!paths.length) return;
    setStatus('正在识别拖入内容…');
    // 目录递归扫描、单文件直接分析（main.js 的 list-images 统一处理）
    await addPhotos(paths);
  });

  // ---------- 分析 ----------
  async function analyzeOne(f) {
    const img = new Image();
    try {
      // 原图 file:// 直连加载（浏览器异步解码），避免大图 base64 IPC 传输开销
      img.src = await window.api.toFileUrl(f.path);
      await withTimeout(img.decode(), 15000);
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) return null;

      // Fine mode uses more source pixels; deterministic metrics are computed once.
      const isFine = detectMode === 'fine' || plugins.some((p) => p.enabled && p.fine);
      const A = isFine ? 1024 : 512;  // 标准 512px（速度快），精细 1024px
      const ar = Math.min(1, A / Math.max(nw, nh));
      const aw = Math.max(1, Math.round(nw * ar));
      const ah = Math.max(1, Math.round(nh * ar));
      const ac = document.createElement('canvas');
      ac.width = aw; ac.height = ah;
      const actx = ac.getContext('2d', { willReadFrequently: true });
      actx.drawImage(img, 0, 0, aw, ah);
      const imageData = actx.getImageData(0, 0, aw, ah);
      // 人脸检测画布：独立高分辨率（宽 1024，保证人脸检出率）
      const F = 1024;  // 人脸检测画布（高分辨率保证检出，推理由 inputSize 控制）
      const fr = Math.min(1, F / Math.max(nw, nh));
      const fw = Math.max(1, Math.round(nw * fr));
      const fh = Math.max(1, Math.round(nh * fr));
      const fc = document.createElement('canvas');
      fc.width = fw; fc.height = fh;
      fc.getContext('2d').drawImage(img, 0, 0, fw, fh);
      const metrics = Detectors.analyze(imageData);

      // 缩略图：宽 240（加载时已生成则复用）
      let thumbUrl = f.thumbUrl;
      if (!thumbUrl) {
        const T = 240;
        const tr = Math.min(1, T / nw);
        const tw = Math.max(1, Math.round(nw * tr));
        const th = Math.max(1, Math.round(nh * tr));
        const tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(img, 0, 0, tw, th);
        thumbUrl = tc.toDataURL('image/jpeg', 0.72);
      }
      img.src = '';

      metrics.ear = await eyeEAR(fc);
      metrics.width = nw;
      metrics.height = nh;
      metrics.qualityScore = Detectors.qualityScore(metrics);
      return { all: [metrics], thumbUrl };
    } catch (err) {
      console.error('analyze error:', f.path, err);
      return null;
    } finally {
      img.src = '';
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function withTimeout(task, ms) {
    let timer;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Image decode timed out')), ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  // 多轮检测结果对比：出现次数过半的判定保留（精细检测 3 轮取多数一致）
  function mergeReasons(reasonLists) {
    if (!reasonLists || !reasonLists.length) return [];
    if (reasonLists.length === 1) return reasonLists[0] || [];
    const count = {};
    for (const list of reasonLists) {
      for (const rz of new Set(list || [])) count[rz] = (count[rz] || 0) + 1;
    }
    const need = Math.ceil(reasonLists.length / 2);
    return Object.keys(count).filter((rz) => count[rz] >= need);
  }

  async function analyzeAll() {
    if (scanning || !files.length) return;
    scanning = true;
    paused = false;
    log('开始分析：' + files.length + ' 张');
    btnScan.disabled = false;
    btnScan.textContent = t('pause');
    btnPick.disabled = true;
    btnExport.disabled = true;
    $('detect-mode').disabled = true;
    $('sort-order').disabled = true;
    $('btn-report').disabled = true;
    hideCtxMenu();
    setActiveNav('scan');
    results = [];
    resetFilter();
    applyFilter();
    updateOverview();
    addProgressBar();
    const thr = getThresholds();
    let failed = 0;
    // 不重建网格：复用加载时的待分析卡，逐张更新，保证「扫描高亮」平滑扫过
    const cardEls = grid.querySelectorAll('.card');
    // 演示节奏：极轻延迟保证进度可见（30 张内 10-80ms，30 张以上 5-50ms）
    const perMin = files.length <= 30 ? 10 : 5;
    const perMax = files.length <= 30 ? 80 : 50;
    const startAt = Date.now();
    let prevCard = null;
    let cancelled = false;
    try {
      for (let i = 0; i < files.length; i++) {
        if (abortScan) { cancelled = true; break; }  // 用户请求取消
        // 暂停：扫到哪里停到哪里，已扫描结果保留，未扫描保持待分析
        if (paused) {
          setStatus(t('paused', i, files.length));
          log('分析已暂停（第 ' + i + '/' + files.length + ' 张）');
          while (paused && !abortScan) await sleep(250);
          if (abortScan) { cancelled = true; break; }
        }
        const f = files[i];
        setProgress(i / files.length);
        // 扫描高亮：当前照片蓝色光圈扫过
        if (prevCard) prevCard.classList.remove('analyzing');
        if (cardEls[i]) {
          cardEls[i].classList.add('analyzing');
          cardEls[i].scrollIntoView({ block: 'nearest' });
          prevCard = cardEls[i];
        }
        // 剩余时间估算
        const elapsed = Date.now() - startAt;
        const remain = Math.max(1, Math.round((elapsed / (i + 1)) * (files.length - i - 1) / 1000));
        setStatus(t('analyzing', i + 1, files.length, remain));
        setStats(Math.round(((i + 1) / files.length) * 100) + '%');
        const t0 = Date.now();
        const res = await analyzeOne(f);
        if (!res) {
          failed++;
          results.push({ ...f, metrics: null, reasons: [], kept: false, manual: false, failed: true });
        } else {
          const metrics = { all: res.all };
          const reasons = mergeReasons(res.all.map((m) => judge(m, thr)));
          results.push({ ...f, thumbUrl: res.thumbUrl, metrics, reasons, kept: reasons.length === 0, manual: false });
        }
        // 节奏控制：实际检测耗时决定速度，只补极小延迟让进度平滑
        const spent = Date.now() - t0;
        const target = perMin + Math.random() * (perMax - perMin);
        if (spent < target) await sleep(target - spent);
        // 更新该卡片状态（不重建）
        const r = results[results.length - 1];
        if (cardEls[i]) updateCardState(cardEls[i], r);
        updateOverview();
      }
    } finally {
      scanning = false;
      abortScan = false;
      paused = false;
      btnScan.disabled = false;
      btnScan.textContent = t('scan');
      btnPick.disabled = false;
      $('detect-mode').disabled = false;
      $('sort-order').disabled = false;
      removeProgressBar();
      if (prevCard) prevCard.classList.remove('analyzing');
    }
    updateStats();
    applySort();
    setActiveNav('results');
    if (cancelled) {
      // 被取消：保留已分析部分
      setStatus(`分析已取消 · 已完成 ${results.length}/${files.length} 张`);
      log('分析已取消，已完成 ' + results.length + '/' + files.length + ' 张');
      if (results.length) {
        filterBar.hidden = false;
        applyFilter();
      }
      if (results.length) btnExport.disabled = false;
      return;
    }
    const bad = results.filter((r) => !r.kept).length;
    log('分析完成：' + results.length + ' 张成功，废片 ' + bad + ' 张');
    setStatus(
      `分析完成 · ${results.length} 张成功` +
      (failed ? `，${failed} 张读取失败` : '') +
      ` · 标记废片 ${bad} 张` +
      (!faceReady ? ' · 闭眼检测不可用（人脸模型未加载）' : '')
    );
    if (results.length) btnExport.disabled = false;
    // 分析完成：显示筛选栏
    filterBar.hidden = false;
    applyFilter();
  }

  // 阈值变化后重新判定（无需重新检测，增量更新卡片，拖动滑块不卡顿）
  function rejudge() {
    if (!results.length || scanning) return;
    const thr = getThresholds();
    const cards = grid.querySelectorAll('.card');
    let changed = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || r.manual || !r.metrics) continue; // 未分析/手动改判/读取失败的不覆盖
      const before = r.kept;
      const mlist = r.metrics.all || [r.metrics];  // 精细检测保存多轮结果
      r.reasons = mergeReasons(mlist.map((m) => judge(m, thr)));
      r.kept = r.reasons.length === 0;
      if (before !== r.kept) changed++;
      const card = cards[i];
      if (card) updateCardState(card, r);
    }
    updateStats();
    const bad = results.filter((r) => !r.kept).length;
    setStatus(changed
      ? `阈值已更新 · ${changed} 张判定发生变化 · 当前废片 ${bad} 张`
      : `阈值已更新 · 判定无变化 · 当前废片 ${bad} 张（照片指标与阈值范围不重叠）`);
  }

  thresholdSliders.forEach((s) =>
    s.addEventListener('input', () => {
      localStorage.setItem('kx.threshold.' + s.id, s.value);
      updateSliderLabels();
      rejudge();
    })
  );

  // ---------- 渲染 ----------
  // 构建单张卡片（失败照片显示占位，不消失）
  function buildCard(r) {
    const card = document.createElement('div');
    card.className = 'card ' + (r.kept ? 'kept' : 'rejected') + (r.manual ? ' manual' : '') + (r.failed ? ' failed' : '') + (r.pending ? ' pending' : '');
    card.addEventListener('dblclick', () => openViewer(card));
    if (r.failed) {
      const bg = document.createElement('div');
      bg.className = 'fail-bg';
      bg.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      card.appendChild(bg);
      const box = document.createElement('div');
      box.className = 'reason';
      const t = document.createElement('span');
      t.className = 'tag fail';
      t.textContent = '读取失败';
      box.appendChild(t);
      card.appendChild(box);
    } else if (r.pending) {
      // 待分析：先显示灰色占位图，缩略图后台生成后填充
      const img = document.createElement('img');
      img.alt = r.name;
      img.draggable = false;
      card.appendChild(img);
      const box = document.createElement('div');
      box.className = 'reason';
      const t = document.createElement('span');
      t.className = 'tag pending';
      t.textContent = '待分析';
      box.appendChild(t);
      card.appendChild(box);
    } else {
      const img = document.createElement('img');
      img.src = r.thumbUrl;
      img.loading = 'lazy';
      img.alt = r.name;
      img.draggable = false;
      card.appendChild(img);
      if (r.reasons.length) {
        const box = document.createElement('div');
        box.className = 'reason';
        for (const rz of r.reasons) {
          const t = document.createElement('span');
          t.className = 'tag ' + rz;
          t.textContent = reasonLabel(rz);
          box.appendChild(t);
        }
        card.appendChild(box);
      }
      if (r.kept) {
        const mm = document.createElement('div');
        mm.className = 'manual-mark';
        mm.textContent = '✓';
        card.appendChild(mm);
      }
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.remark || r.name;
    card.appendChild(name);
    updateQualityBadge(card, r);

    card.addEventListener('click', () => {
      // 从结果集取最新数据（卡片闭包是加载时的待分析对象）
      const idx = Array.prototype.indexOf.call(grid.children, card);
      const r = results[idx];
      if (scanning || !r || r.pending || r.failed) return;
      r.kept = !r.kept;
      r.manual = true;
      updateCardState(card, r);
      updateStats();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (scanning) return;
      e.stopPropagation();  // 阻止冒泡到 document 的关闭逻辑（否则菜单瞬间被关闭）
      showCtxMenu(card, e.clientX, e.clientY);
    });
    return card;
  }

  function renderResults(list) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(buildCard(r));
    grid.appendChild(frag);
  }

  // 分析中增量追加新卡片（避免反复全量重建）
  function appendResults(list) {
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(buildCard(r));
    grid.appendChild(frag);
  }

  // 局部更新单张卡片状态（改判/阈值调整/分析完成时更新，不重建网格）
  function updateCardState(card, r) {
    card.classList.toggle('kept', r.kept);
    card.classList.toggle('rejected', !r.kept);
    card.classList.toggle('manual', r.manual);
    card.classList.toggle('pending', !!r.pending);
    card.classList.toggle('failed', !!r.failed);
    if (r.failed) {
      // 读取失败：占位图换成失败图标 + 灰色标签
      const img = card.querySelector('img');
      if (img) img.remove();
      let bg = card.querySelector('.fail-bg');
      if (!bg) {
        bg = document.createElement('div');
        bg.className = 'fail-bg';
        bg.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
        card.insertBefore(bg, card.firstChild);
      }
      let box = card.querySelector('.reason');
      if (!box) {
        box = document.createElement('div');
        box.className = 'reason';
        card.appendChild(box);
      }
      box.innerHTML = '<span class="tag fail">读取失败</span>';
    } else {
      const bg = card.querySelector('.fail-bg');
      if (bg) bg.remove();
      let img = card.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.draggable = false;
        img.alt = r.name;
        card.prepend(img);
      }
      if (r.thumbUrl && !r.pending) img.src = r.thumbUrl;
      if (!r.pending) setCardReason(card, r);
    }
    let mm = card.querySelector('.manual-mark');
    if (r.kept) {
      if (!mm) {
        mm = document.createElement('div');
        mm.className = 'manual-mark';
        card.appendChild(mm);
      }
      mm.textContent = '✓';
    } else if (mm) {
      mm.remove();
    }
    updateQualityBadge(card, r);
  }

  function primaryMetrics(r) { return r && r.metrics && (r.metrics.all ? r.metrics.all[0] : r.metrics); }
  function updateQualityBadge(card, r) {
    const m = primaryMetrics(r);
    let badge = card.querySelector('.quality-badge');
    if (!m || !Number.isFinite(m.qualityScore)) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'quality-badge';
      card.appendChild(badge);
    }
    badge.textContent = m.qualityScore;
    badge.dataset.level = m.qualityScore >= 70 ? 'high' : m.qualityScore >= 40 ? 'medium' : 'low';
    badge.title = t('qualityHint', m.qualityScore, Math.round(m.blurScore), Math.round(m.avgLuma));
  }

  function setCardReason(card, r) {
    let box = card.querySelector('.reason');
    if (r.reasons.length) {
      if (!box) {
        box = document.createElement('div');
        box.className = 'reason';
        card.appendChild(box);
      }
      box.innerHTML = '';
      for (const rz of r.reasons) {
        const t = document.createElement('span');
        t.className = 'tag ' + rz;
        t.textContent = reasonLabel(rz);
        box.appendChild(t);
      }
    } else if (box) {
      box.remove();
    }
  }

  function updateStats() {
    const list = results.filter(Boolean);
    updateOverview();
    applyFilter();
    applySort();
    if (!list.length) { setStats(''); return; }
    const kept = list.filter((r) => r.kept && !r.failed).length;
    const bad = list.length - kept;
    setStats(t('statsSummary', kept, bad, list.length));
  }

  function updateOverview() {
    const list = results.filter(Boolean);
    const valid = list.filter((r) => !r.failed && primaryMetrics(r));
    const scores = valid.map((r) => primaryMetrics(r).qualityScore).filter(Number.isFinite);
    const kept = valid.filter((r) => r.kept).length;
    const counts = {};
    for (const r of valid) for (const reason of r.reasons) counts[reason] = (counts[reason] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    $('overview-total').textContent = files.length;
    $('overview-analyzed').textContent = list.length + ' / ' + files.length;
    $('overview-kept').textContent = valid.length ? Math.round(kept / valid.length * 100) + '%' : '—';
    $('overview-score').textContent = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '—';
    $('overview-issue').textContent = top ? reasonLabel(top[0]) + ' · ' + top[1] : t(valid.length ? 'noIssues' : 'awaitAnalysis');
    const overviewStatus = $('overview-status');
    if (overviewStatus) {
      overviewStatus.textContent = scanning ? t('overviewScanning') : files.length ? (valid.length === files.length ? t('overviewComplete') : t('overviewReadyToScan')) : t('overviewReady');
    }
    $('btn-report').disabled = scanning || !list.length;
  }

  // CSS order changes visual order only; DOM indexes stay aligned with files/results.
  function applySort() {
    const indices = files.map((_, i) => i);
    indices.sort((a, b) => {
      if (sortOrder === 'name') return files[a].name.localeCompare(files[b].name, lang === 'zh' ? 'zh-CN' : 'en', { numeric: true }) || a - b;
      if (sortOrder.startsWith('quality-')) {
        const am = primaryMetrics(results[a]), bm = primaryMetrics(results[b]);
        const av = am && Number.isFinite(am.qualityScore) ? am.qualityScore : null;
        const bv = bm && Number.isFinite(bm.qualityScore) ? bm.qualityScore : null;
        if (av === null || bv === null) return av === bv ? a - b : av === null ? 1 : -1;
        return (sortOrder === 'quality-desc' ? bv - av : av - bv) || a - b;
      }
      return a - b;
    });
    indices.forEach((index, order) => { if (grid.children[index]) grid.children[index].style.order = order; });
  }

  // ---------- 废片筛选（全部 / 模糊 / 过曝 / 欠曝 / 闭眼 / 过暗） ----------
  let filter = 'all';
  const filterBar = $('filter-bar');
  function applyFilter() {
    const cards = grid.children;
    for (let i = 0; i < cards.length; i++) {
      const r = results[i];
      let show;
      if (filter === 'all') show = true;
      else if (filter === 'failed') show = !!r && r.failed;
      else if (!r || r.pending || r.failed) show = false;  // 未分析/读取失败不参与筛选
      else if (filter === 'kept') show = r.kept;
      else if (filter === 'rejected') show = !r.kept;
      else show = r.reasons.includes(filter);
      cards[i].hidden = !show;
    }
  }
  function resetFilter() {
    filter = 'all';
    filterBar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.f === 'all'));
    applyFilter();
  }
  filterBar.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      filterBar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      filter = chip.dataset.f;
      applyFilter();
    });
  });

  // ---------- 右键菜单：单独分析 / 单独导出 / 移除列表 ----------
  let ctxIndex = -1;
  const ctxMenu = $('ctx-menu');
  function showCtxMenu(card, x, y) {
    ctxIndex = Array.prototype.indexOf.call(grid.children, card);
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - 148)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - 130)) + 'px';
    ctxMenu.hidden = false;
  }
  function hideCtxMenu() { ctxMenu.hidden = true; ctxIndex = -1; }
  document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
  document.addEventListener('contextmenu', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });

  // 单独分析：只分析这一张照片
  async function analyzeSingle(idx) {
    if (scanning) return;
    const f = files[idx];
    if (!f) return;
    const thr = getThresholds();
    setStatus(`正在分析「${f.name}」…`);
    const res = await analyzeOne(f);
    let r;
    if (!res) {
      r = { ...f, metrics: null, reasons: [], kept: false, manual: false, failed: true };
    } else {
      const metrics = { all: res.all };
      const reasons = mergeReasons(res.all.map((m) => judge(m, thr)));
      r = { ...f, thumbUrl: res.thumbUrl, metrics, reasons, kept: reasons.length === 0, manual: false };
    }
    results[idx] = r;
    const card = grid.children[idx];
    if (card) updateCardState(card, r);
    updateStats();
    filterBar.hidden = false;
    btnExport.disabled = !results.some((r) => r && r.kept && !r.failed);
    setStatus(`已单独分析「${f.name}」` + (r.failed ? ' · 读取失败' : (r.reasons.length ? ' · 标记为废片' : ' · 合格')));
  }

  // 单独导出：只导出这一张照片的原图
  async function exportSingle(idx) {
    const r = results[idx] || files[idx];
    if (!r || r.failed) return;
    let dest = exportDir || (await window.api.pickExportFolder());
    if (!dest) return;
    if (!exportDir) { exportDir = dest; localStorage.setItem('kx.exportDir', dest); }
    setStatus(`正在导出「${r.name}」…`);
    try {
      await window.api.exportFiles([r.path], dest);
      showExportDone(1, dest);
      log('单独导出：' + r.name);
    } catch (err) {
      setStatus('导出失败：' + (err.message || err));
    }
  }

  // 移除列表：只从列表删除这一张，不删本地文件
  function removeFromList(idx) {
    if (scanning || idx < 0) return;
    const removed = files[idx];
    if (files[idx]) files.splice(idx, 1);
    if (idx < results.length) results.splice(idx, 1);
    const card = grid.children[idx];
    if (card) card.remove();
    updateStats();
    if (!files.length) {
      grid.hidden = true;
      dropHint.hidden = false;
      btnScan.disabled = true;
      btnReset.disabled = true;
      btnExport.disabled = true;
      filterBar.hidden = true;
    }
    setStatus('已从列表移除该照片（本地文件未删除）');
    log('从列表移除：' + (removed ? removed.name : ''));
  }

  $('ctx-analyze').addEventListener('click', () => { const index = ctxIndex; hideCtxMenu(); analyzeSingle(index); });
  $('ctx-export').addEventListener('click', () => { const index = ctxIndex; hideCtxMenu(); exportSingle(index); });
  $('ctx-remove').addEventListener('click', () => { const index = ctxIndex; hideCtxMenu(); removeFromList(index); });

  // 备注：自定义文字显示在照片名称位置
  $('ctx-remark').addEventListener('click', () => {
    remarkIndex = ctxIndex;
    hideCtxMenu();
    const r = results[remarkIndex] || files[remarkIndex];
    if (!r) return;
    $('remark-input').value = r.remark || '';
    $('remark-overlay').hidden = false;
    $('remark-input').focus();
  });
  $('remark-cancel').addEventListener('click', () => { $('remark-overlay').hidden = true; });
  $('remark-ok').addEventListener('click', () => {
    const r = results[remarkIndex] || files[remarkIndex];
    const fr = files[remarkIndex];
    const value = $('remark-input').value.trim();
    if (r) r.remark = value;
    if (fr) fr.remark = value;  // 同时写入文件列表引用，重新分析后仍保留
    const card = grid.children[remarkIndex];
    const nameEl = card && card.querySelector('.name');
    if (nameEl) nameEl.textContent = value || (r && r.name) || (fr && fr.name);
    setStatus(value ? `已设置备注：${value}` : '已清除备注');
    log('备注' + (value ? '：' + value : '已清除'));
    $('remark-overlay').hidden = true;
  });
  $('remark-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('remark-ok').click();
    if (e.key === 'Escape') $('remark-overlay').hidden = true;
  });

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  async function exportReport() {
    const list = results.filter(Boolean);
    if (!list.length || scanning) return;
    const headers = ['文件名', '路径', '质量分', '状态', '问题', '清晰度', '平均亮度', '对比度'];
    const rows = list.map((r) => {
      const m = primaryMetrics(r) || {};
      const state = r.failed ? '读取失败' : r.kept ? '合格' : '废片';
      return [r.name, r.path, Number.isFinite(m.qualityScore) ? m.qualityScore : '', state, r.reasons.map(reasonLabel).join('、'), Number.isFinite(m.blurScore) ? Math.round(m.blurScore) : '', Number.isFinite(m.avgLuma) ? m.avgLuma.toFixed(1) : '', Number.isFinite(m.contrast) ? m.contrast.toFixed(1) : ''];
    });
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    try {
      const saved = window.api.saveReport ? await window.api.saveReport(csv) : null;
      if (saved) { setStatus(t('reportSaved', saved)); log('已保存分析报告：' + saved); }
    } catch (err) {
      setStatus(t('reportFailed') + '：' + (err.message || err));
      log('保存分析报告失败：' + (err.message || err));
    }
  }

  // ---------- 导出 ----------
  async function exportKept() {
    if (scanning || !results.length) return;
    // 优先使用设置里的导出位置，未设置则手动选择
    let dest = exportDir || (await window.api.pickExportFolder());
    if (!dest) return;
    if (!exportDir) { exportDir = dest; localStorage.setItem('kx.exportDir', dest); }
    // 防御：results 可能有未分析的空位（单独分析产生），过滤时空位会抛错导致导出静默中断
    const kept = results.filter((r) => r && r.kept && !r.failed).map((r) => r.path);
    const skippedFail = results.filter((r) => r && r.kept && r.failed).length;
    if (!kept.length) { setStatus('没有合格片可导出'); return; }
    setStatus(`正在导出 ${kept.length} 张到目标文件夹…` + (skippedFail ? `（跳过 ${skippedFail} 张读取失败的照片）` : ''));
    btnExport.disabled = true;
    try {
      const copied = await window.api.exportFiles(kept, dest);
      showExportDone(copied.length, dest);
      log('导出 ' + copied.length + ' 张到 ' + dest);
    } catch (err) {
      console.error(err);
      setStatus('导出失败：' + (err.message || err));
    } finally {
      btnExport.disabled = false;
    }
  }

  // 导出完成提示（可一键打开文件夹）
  function showExportDone(count, dest) {
    setStatus(`已导出 ${count} 张合格片到 ${dest}`);
    $('export-done-info').textContent = `已导出 ${count} 张照片到：\n${dest}`;
    $('export-done').hidden = false;
  }
  $('export-open').addEventListener('click', async () => {
    const dest = $('export-done-info').textContent.split('\n')[1];
    if (dest) window.api.openPath(dest);
  });
  $('export-close').addEventListener('click', () => { $('export-done').hidden = true; });

  // ---------- 照片放大查看（双击卡片；滚轮缩放；左键拖动平移） ----------
  let viewerScale = 1;
  let viewerX = 0;
  let viewerY = 0;
  function applyViewerTransform() {
    $('viewer-img').style.transform = `translate(${viewerX}px, ${viewerY}px) scale(${viewerScale})`;
  }
  async function openViewer(card) {
    const idx = Array.prototype.indexOf.call(grid.children, card);
    const r = results[idx] || files[idx];  // 未分析时用文件数据
    if (!r || r.failed) return;
    try {
      const url = await window.api.toFileUrl(r.path);
      viewerScale = 1;
      viewerX = 0;
      viewerY = 0;
      applyViewerTransform();
      $('viewer-img').src = url;
      $('viewer-name').textContent = r.name;
      $('viewer').hidden = false;
    } catch (_) { /* 打开失败忽略 */ }
  }
  function closeViewer() {
    $('viewer').hidden = true;
    $('viewer-img').src = '';
    viewerScale = 1;
    viewerX = 0;
    viewerY = 0;
  }
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('click', (e) => {
    if (e.target === $('viewer')) closeViewer();
  });
  $('viewer').addEventListener('wheel', (e) => {
    e.preventDefault();
    viewerScale = Math.min(8, Math.max(0.2, viewerScale + (e.deltaY < 0 ? 0.15 : -0.15)));
    applyViewerTransform();
  }, { passive: false });
  // 左键拖动平移图片
  const viewerImg = $('viewer-img');
  let dragState = null;
  viewerImg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragState = { sx: e.clientX, sy: e.clientY, ox: viewerX, oy: viewerY, moved: false };
    viewerImg.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.sx;
    const dy = e.clientY - dragState.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
    viewerX = dragState.ox + dx;
    viewerY = dragState.oy + dy;
    applyViewerTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!dragState) return;
    viewerImg.classList.remove('dragging');
    dragState = null;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('viewer').hidden) closeViewer();
  });

  // ---------- 清空（带确认；分析中点击可立即取消） ----------
  function reset() {
    if (scanning) {
      abortScan = true;
      setStatus('正在取消分析…');
      return;
    }
    files = [];
    results = [];
    grid.hidden = true;
    dropHint.hidden = false;
    btnScan.disabled = true;
    btnExport.disabled = true;
    btnReset.disabled = true;
    renderResults([]);
    setStats('');
    setStatus(t('ready'));
    filterBar.hidden = true;
    resetFilter();
    sortOrder = 'import';
    const sortEl = $('sort-order');
    if (sortEl) sortEl.value = sortOrder;
    updateOverview();
    setActiveNav('workbench');
  }
  $('confirm-cancel').addEventListener('click', () => { $('confirm-overlay').hidden = true; });
  $('confirm-ok').addEventListener('click', () => { $('confirm-overlay').hidden = true; reset(); });

  // ---------- 进度条 ----------
  function addProgressBar() {
    const w = document.createElement('div');
    w.className = 'progress-wrap';
    w.id = 'prog';
    const b = document.createElement('div');
    b.className = 'progress-bar';
    w.appendChild(b);
    dropzone.prepend(w);
  }
  function setProgress(p) {
    const b = document.querySelector('#prog .progress-bar');
    if (b) b.style.width = (p * 100).toFixed(1) + '%';
  }
  function removeProgressBar() {
    const w = document.getElementById('prog');
    if (w) w.remove();
  }


  // ---------- 插件系统 ----------
  const pluginsPanel = $('plugins-panel');
  const pluginsList = $('plugins-list');
  const pluginsFoot = $('plugins-foot');
  const btnPlugins = $('btn-plugins');

  function applyTheme() {
    if (!plugCssEl) {
      plugCssEl = document.createElement('style');
      plugCssEl.id = 'kx-plugin-css';
      document.head.appendChild(plugCssEl);
    }
    plugCssEl.textContent = plugins
      .filter((p) => p.enabled && p.type === 'theme' && p.css)
      .map((p) => p.css).join('\n');
  }

  async function loadPlugins() {
    try {
      const list = await window.api.listPlugins();
      plugins = [];
      for (const item of list) {
        try {
          window.__KX_PLUGIN = null;
          new Function(item.content)(); // 执行插件（约定写入 window.__KX_PLUGIN）
          const def = window.__KX_PLUGIN;
          window.__KX_PLUGIN = null;
          if (!def || (!def.css && typeof def.detect !== 'function')) continue;
          const key = def.id || item.name;
          // 默认停用：只有用户手动启用才生效；选择保存在本地，重启后保留
          const enabled = localStorage.getItem('kx.plugin.' + key) === '1';
          plugins.push({ ...def, file: item.file, enabled });
        } catch (err) { console.error('插件加载失败', item.name, err); }
      }
      applyTheme();
      renderPlugins();
    } catch (err) { console.error('list plugins error', err); }
  }

  // 插件行：名称 + 类型 + 功能说明（常显）+ 启用开关
  function pluginRow(name, type, desc, enabled, onToggle) {
    const row = document.createElement('div');
    row.className = 'plugin-item';
    const meta = document.createElement('div');
    meta.className = 'plugin-meta';
    const nm = document.createElement('div');
    nm.className = 'plugin-name';
    nm.textContent = name;
    const typeEl = document.createElement('div');
    typeEl.className = 'plugin-type';
    typeEl.textContent = type;
    meta.appendChild(nm); meta.appendChild(typeEl);
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'plugin-desc';
      descEl.textContent = desc;
      meta.appendChild(descEl);
    }
    row.appendChild(meta);
    const toggle = document.createElement('button');
    toggle.className = 'btn small plugin-toggle' + (enabled ? ' on' : '');
    if (onToggle) {
      toggle.textContent = enabled ? '启用' : '停用';
      toggle.title = enabled ? '点击停用' : '点击启用';
      toggle.addEventListener('click', () => onToggle());
    } else {
      toggle.disabled = true;
      toggle.textContent = enabled ? '启用' : '停用';
      toggle.title = '激活后可启用插件';
    }
    row.appendChild(toggle);
    return row;
  }

  function renderPlugins() {
    pluginsList.innerHTML = '';
    if (!plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'plugin-empty';
      empty.textContent = '插件文件夹里还没有插件\n把下载的 .js 插件放进去，重启后出现在这里';
      pluginsList.appendChild(empty);
      return;
    }
    for (const p of plugins) {
      const row = pluginRow(
        p.name || p.file,
        (p.type === 'theme' ? '主题' : p.type === 'feature' ? '功能' : '插件') + ' · v' + (p.version || '1.0'),
        p.description || (p.type === 'theme' ? '主题插件：改变界面配色方案。' : '功能插件：在检测时执行自定义逻辑，可标记新的废片类型。'),
        p.enabled,
        () => {
          p.enabled = !p.enabled;
          localStorage.setItem('kx.plugin.' + (p.id || p.file), p.enabled ? '1' : '0');
          applyTheme();
          renderPlugins();
          if (results.length) rejudge();
        }
      );
      pluginsList.appendChild(row);
    }
  }

  btnPlugins.addEventListener('click', () => {
    pluginsPanel.hidden = !pluginsPanel.hidden;
    if (!pluginsPanel.hidden) {
      placePanel(pluginsPanel, btnPlugins);
      loadPlugins();
    }
  });

  // ---------- 绑定事件 ----------
  btnPick.addEventListener('click', pickFolders);
  btnScan.addEventListener('click', () => {
    if (scanning) {
      paused = !paused;  // 暂停 / 继续
      btnScan.textContent = paused ? t('resume') : t('pause');
      if (!paused) setStatus(t('resuming'));
      return;
    }
    analyzeAll();
  });
  btnExport.addEventListener('click', exportKept);
  btnReset.addEventListener('click', () => {
    if (files.length || results.length) $('confirm-overlay').hidden = false;
  });
  $('btn-report').addEventListener('click', exportReport);
  const detectModeEl = $('detect-mode');
  detectModeEl.value = detectMode;
  detectModeEl.addEventListener('change', () => {
    detectMode = detectModeEl.value === 'fine' ? 'fine' : 'standard';
    localStorage.setItem('kx.detectMode', detectMode);
    setStatus(t(detectMode === 'fine' ? 'fineModeSet' : 'standardModeSet'));
  });
  const sortEl = $('sort-order');
  sortEl.value = sortOrder;
  sortEl.addEventListener('change', () => {
    const value = sortEl.value;
    sortOrder = ['import', 'quality-desc', 'quality-asc', 'name'].includes(value) ? value : 'import';
    applySort();
  });
  $('btn-threshold-reset').addEventListener('click', () => {
    thresholdSliders.forEach((slider) => {
      slider.value = '2';
      localStorage.removeItem('kx.threshold.' + slider.id);
    });
    updateSliderLabels();
    rejudge();
    setStatus(t('thresholdResetDone'));
  });

  // ---------- 自定义导出位置 ----------
  const exportPathInput = $('export-path');
  exportPathInput.value = exportDir;
  $('btn-export-path').addEventListener('click', async () => {
    const dest = await window.api.pickExportFolder();
    if (dest) {
      exportDir = dest;
      localStorage.setItem('kx.exportDir', dest);
      exportPathInput.value = dest;
      setStatus('导出位置已设置为 ' + dest);
    }
  });
  exportPathInput.addEventListener('change', () => {
    exportDir = exportPathInput.value.trim();
    localStorage.setItem('kx.exportDir', exportDir);
  });

  const btnSettings = $('btn-settings');
  const settingsPanel = $('settings-panel');

  // 弹出面板：定位到触发按钮正下方
  function placePanel(panel, btn) {
    const r = btn.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.left + r.width - panel.offsetWidth)) + 'px';
    panel.style.top = (r.bottom + 7) + 'px';
  }

  btnSettings.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    if (!settingsPanel.hidden) placePanel(settingsPanel, btnSettings);
  });

  function setActiveNav(name) {
    document.querySelectorAll('.side-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === name));
  }
  function focusNavTarget(name) {
    setActiveNav(name);
    if (name === 'workbench') {
      dropzone.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (name === 'scan') {
      (files.length ? btnScan : dropzone).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (files.length && !scanning) btnScan.focus({ preventScroll: true });
    } else if (name === 'results') {
      $('quality-overview').scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (!filterBar.hidden) filterBar.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (name === 'settings') {
      settingsPanel.hidden = false;
      placePanel(settingsPanel, btnSettings);
      btnSettings.focus({ preventScroll: true });
    }
  }
  document.querySelectorAll('.side-nav-item').forEach((item) => item.addEventListener('click', (e) => {
    e.stopPropagation();
    focusNavTarget(item.dataset.nav);
  }));

  const donationOverlay = $('donation-overlay');
  const closeDonation = () => { donationOverlay.hidden = true; };
  $('btn-donate').addEventListener('click', () => {
    donationOverlay.hidden = false;
    $('donation-close').focus();
  });
  $('donation-close').addEventListener('click', closeDonation);
  donationOverlay.addEventListener('click', (e) => { if (e.target === donationOverlay) closeDonation(); });

  // 自定义窗口控制（无边框标题栏）
  $('btn-win-min').addEventListener('click', () => window.api.minimizeWindow());
  $('btn-win-close').addEventListener('click', () => window.api.closeWindow());
  document.addEventListener('click', (e) => {
    // 点击的元素若已在面板重建中被移除，不触发「点击外部关闭」
    if (e.target && !e.target.isConnected) return;
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !btnSettings.contains(e.target)) {
      settingsPanel.hidden = true;
    }
    if (!pluginsPanel.hidden && !pluginsPanel.contains(e.target) && !btnPlugins.contains(e.target)) {
      pluginsPanel.hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const typing = target && (target.matches('input, textarea, select') || target.isContentEditable);
    if (e.key === 'Escape') {
      if (!donationOverlay.hidden) closeDonation();
      if (!$('log-overlay').hidden) $('log-overlay').hidden = true;
      if (!$('confirm-overlay').hidden) $('confirm-overlay').hidden = true;
      if (!$('remark-overlay').hidden) $('remark-overlay').hidden = true;
      if (!$('export-done').hidden) $('export-done').hidden = true;
      hideCtxMenu();
    }
    if (typing || e.altKey || e.metaKey) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!scanning) pickFolders(); }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (!scanning && files.length) analyzeAll(); }
  });

  updateSliderLabels();

  // ---------- 新手引导（首次启动，支持中英） ----------
  const zhSteps = [{"sel":"#btn-pick","title":"选择照片","desc":"点击这里选择照片文件，可多选；整个文件夹直接拖入窗口即可。新照片会追加到列表，不会清空已有内容。"},{"sel":"#btn-scan","title":"一键开始分析","desc":"自动标记六类问题：模糊（主体背景全糊）、虚焦（主体脱焦）、过曝、欠曝、闭眼、过暗。蓝色光圈逐张扫描，状态栏显示剩余时间。"},{"sel":"#filter-bar","title":"筛选废片","desc":"分析完成后，点上面的筛选按钮只看某一类照片：模糊、虚焦、过曝、欠曝、闭眼、过暗；点「全部」恢复显示。"},{"sel":"#dropzone","title":"单击改判","desc":"分析后单击照片切换合格/废片：系统判定合格显示白色 ✓，你手动选为合格显示蓝色 ✓，废片保留原因标签。"},{"sel":"#dropzone","title":"双击放大查看","desc":"双击任何照片可放大查看，滚轮缩放、按住左键拖动；右键弹出菜单，可单独分析、单独导出或从列表移除。"},{"sel":"#btn-export","title":"导出合格片","desc":"一键导出所有合格照片（白色 ✓ 和蓝色 ✓ 都会导出）到指定位置，位置可在「阈值」面板预设。"},{"sel":"#btn-license","title":"完整版","desc":"体验版最多分析 20 张。正式版请在微软商店购买，一次付费永久使用。"}];
  const enSteps = [{"sel":"#btn-pick","title":"Pick Photos","desc":"Click to pick photo files (multi-select). Or drag a whole folder into the window. New photos are appended without clearing."},{"sel":"#btn-scan","title":"Start Analysis","desc":"Auto-marks six issues: blur, out-of-focus, overexposed, underexposed, eyes closed, too dark. Blue glow scans each photo."},{"sel":"#filter-bar","title":"Filter Bad Photos","desc":"After analysis, use the filter bar to view one category: blur, focus, over, under, eye, dark. Click \"All\" to restore."},{"sel":"#dropzone","title":"Click to Re-judge","desc":"Click a photo to toggle good/bad: system-approved shows white ✓, your manual choice shows blue ✓."},{"sel":"#dropzone","title":"Double-click to Zoom","desc":"Double-click to zoom. Scroll to zoom, drag to pan. Right-click for single analyze / export / remove."},{"sel":"#btn-export","title":"Export Good Photos","desc":"Export all approved photos (white ✓ and blue ✓) to the preset folder."},{"sel":"#btn-license","title":"Full Version","desc":"Trial allows 20 photos. Get the full version on Microsoft Store, pay once, use forever."}];
  const tourSteps = () => (lang === 'en' ? enSteps : zhSteps);
  let tourIdx = 0;
  function placeTour() {
    const spot = $('tour-spot');
    const stepEl = $('tour-step');
    const titleEl = $('tour-title');
    const descEl = $('tour-desc');
    const nextBtn = $('tour-next');
    const step = tourSteps()[tourIdx];
    const el = document.querySelector(step.sel);
    if (!el) { tourIdx++; if (tourIdx >= tourSteps().length) return finishTour(); return placeTour(); }
    if (el.hidden) el.hidden = false;  // 教程高亮需要显示的元素（如筛选栏）临时显示
    const r = el.getBoundingClientRect();
    spot.style.left = (r.left - 4) + 'px';
    spot.style.top = (r.top - 4) + 'px';
    spot.style.width = (r.width + 8) + 'px';
    spot.style.height = (r.height + 8) + 'px';
    stepEl.textContent = '新手引导 · 第 ' + (tourIdx + 1) + ' / ' + tourSteps().length + ' 步';
    titleEl.textContent = step.title;
    descEl.textContent = step.desc;
    nextBtn.textContent = tourIdx === tourSteps().length - 1 ? (lang === 'en' ? 'Get Started' : '开始使用') : (lang === 'en' ? 'Next' : '下一步');
  }
  function finishTour() {
    $('tour').hidden = true;
    localStorage.setItem('kx.onboarded', '1');
    if (!results.length) filterBar.hidden = true;  // 教程临时显示的筛选栏：无结果时恢复隐藏
  }
  function startTour() {
    tourIdx = 0;
    $('tour').hidden = false;
    placeTour();
  }
  // 事件只绑定一次（重复打开教程不会重复触发）
  $('tour-next').addEventListener('click', () => {
    tourIdx++;
    if (tourIdx >= tourSteps().length) finishTour(); else placeTour();
  });
  $('tour-skip').addEventListener('click', finishTour);
  if (!localStorage.getItem('kx.onboarded')) {
    setTimeout(startTour, 800);
  }
  // 设置面板：随时可重新查看新手教程
  $('btn-tour').addEventListener('click', () => {
    settingsPanel.hidden = true;
    startTour();
  });

  // ---------- 日志（滚动，最多 100 条） ----------
  const logEntries = [];
  const MAX_LOG = 100;
  function log(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logEntries.push('[' + ts + '] ' + msg);
    if (logEntries.length > MAX_LOG) logEntries.shift();
    console.log('[快调]', msg);
    const box = $('log-list');
    if (box && !$('log-overlay').hidden) {
      box.innerHTML = logEntries.map((e) => '<div>' + e.replace(/</g, '&lt;') + '</div>').join('');
    }
  }
  $('btn-log').addEventListener('click', () => {
    const ov = $('log-overlay');
    ov.hidden = !ov.hidden;
    if (!ov.hidden) {
      $('log-list').innerHTML = logEntries.length
        ? logEntries.map((e) => '<div>' + e.replace(/</g, '&lt;') + '</div>').join('')
        : '<div class="log-empty">（暂无日志）</div>';
    }
  });
  $('log-close').addEventListener('click', () => { $('log-overlay').hidden = true; });

  // ---------- 版本信息（正式版 / 体验版） ----------
  window.api.getEdition().then((ed) => {
    log('版本信息：v' + ed.version + (ed.store ? ' · Microsoft Store 版' : ''));
  }).catch(() => { log('版本信息获取失败'); });
  log('应用启动');

  // ---------- 中英文切换 ----------
  const I18N = {
    zh: {
      log: '日志', logTitle: '运行日志', logHint: '最多保留最近 100 条记录',
      pick: '选择照片', scan: '开始分析', pause: '暂停分析', resume: '继续分析', export: '导出合格片',
      clear: '清空', plugins: '插件', settings: '阈值',
      navWorkbench: '工作台', navScan: '智能检测', navResults: '筛选结果', navSettings: '检测设置', donateNav: '支持作者', donateNavSub: '请作者喝杯奶茶', sidebarFoot: '离线运行 · 照片不上传',
      donateTitle: '如果觉得 App 还不错', donateText: '支持作者一杯奶茶吧', donateSub: '你的支持会帮助我们继续优化检测和体验', donateFoot: '使用微信扫一扫即可支持',
      chipAll: '全部', chipKept: '合格', chipRejected: '废片', chipFailed: '读取失败', chipBlur: '模糊', chipFocus: '虚焦', chipOver: '过曝', chipUnder: '欠曝', chipEye: '闭眼', chipDark: '过暗',
      sortLabel: '排序', sortImport: '导入顺序', sortQualityDesc: '质量从高到低', sortQualityAsc: '质量从低到高', sortName: '文件名', report: '导出报告', reportSaved: '报告已保存：{0}', reportFailed: '报告保存失败',
      overviewEyebrow: '当前批次', overviewTitle: '质量概览', overviewReady: '等待导入照片', overviewReadyToScan: '等待开始分析', overviewScanning: '正在分析…', overviewComplete: '分析完成', overviewTotal: '总照片', overviewAnalyzed: '已分析', overviewKept: '合格率', overviewScore: '平均质量', overviewIssue: '主要问题', overviewNoIssue: '暂无', noIssues: '暂无明显问题', awaitAnalysis: '等待分析', qualityHint: '质量 {0} · 清晰度 {1} · 亮度 {2}', statsSummary: '合格 {0} · 废片 {1} · 共 {2}',
      detectMode: '检测模式', detectModeStandard: '标准', detectModeFine: '精细', thresholdReset: '恢复默认阈值', thresholdResetDone: '检测阈值已恢复默认', fineModeSet: '已切换为精细检测（下次分析生效）', standardModeSet: '已切换为标准检测（下次分析生效）',
      settingsTitle: '检测标准', lblBlur: '模糊', lblOver: '过曝', lblUnder: '欠曝', lblDark: '过暗', lblFocus: '虚焦', lblEye: '闭眼',
      exportLoc: '导出位置', exportPh: '留空则每次手动选择', browse: '浏览', tourView: '查看新手教程',
      pluginTitle: '插件', confirmTitle: '确认清空', confirmText: '将清空所有照片和分析结果，确定继续吗？', cancel: '取消', confirmOk: '确认清空',
      exportDoneTitle: '导出完成', openFolder: '打开文件夹', close: '关闭',
      ctxAnalyze: '单独分析', ctxExport: '单独导出', ctxRemark: '备注', ctxRemove: '移除列表',
      remarkTitle: '照片备注', remarkPh: '输入备注，显示在照片名称位置', save: '保存',
      hintTitle: '拖入照片，开始选片', hintSub: '支持 JPG / PNG / WEBP / TIFF · 原片不会被修改',
      scanning: '正在扫描…', noImages: '没有找到支持的图片文件', dupPhotos: '这些照片已经在列表里了',
      readyInitial: '就绪', ready: '就绪 · 等待选择照片', analyzing: '正在分析 {0}/{1} · 剩余约 {2} 秒', paused: '已暂停 · 第 {0}/{1} 张 · 点击「继续分析」', resuming: '继续分析…'
    },
    en: {
      log: 'Log', logTitle: 'Activity Log', logHint: 'Keeps the latest 100 entries',
      pick: 'Pick Photos', scan: 'Start Analysis', pause: 'Pause', resume: 'Resume', export: 'Export Good Ones',
      clear: 'Clear', plugins: 'Plugins', settings: 'Thresholds',
      navWorkbench: 'Workspace', navScan: 'Smart Scan', navResults: 'Results', navSettings: 'Detection', donateNav: 'Support the author', donateNavSub: 'Buy a milk tea', sidebarFoot: 'Offline · photos stay local',
      donateTitle: 'Enjoying the app?', donateText: 'Buy the author a milk tea', donateSub: 'Your support helps us keep improving detection and the experience', donateFoot: 'Scan with WeChat to support',
      chipAll: 'All', chipKept: 'Good', chipRejected: 'Rejected', chipFailed: 'Failed', chipBlur: 'Blur', chipFocus: 'OOF', chipOver: 'Over', chipUnder: 'Under', chipEye: 'Eye', chipDark: 'Dark',
      sortLabel: 'Sort', sortImport: 'Import order', sortQualityDesc: 'Quality: high to low', sortQualityAsc: 'Quality: low to high', sortName: 'File name', report: 'Export report', reportSaved: 'Report saved: {0}', reportFailed: 'Could not save report',
      overviewEyebrow: 'CURRENT BATCH', overviewTitle: 'Quality overview', overviewReady: 'Waiting for photos', overviewReadyToScan: 'Ready to scan', overviewScanning: 'Scanning…', overviewComplete: 'Analysis complete', overviewTotal: 'Photos', overviewAnalyzed: 'Analyzed', overviewKept: 'Good rate', overviewScore: 'Avg. quality', overviewIssue: 'Top issue', overviewNoIssue: 'None', noIssues: 'No major issues', awaitAnalysis: 'Waiting for analysis', qualityHint: 'Quality {0} · Sharpness {1} · Brightness {2}', statsSummary: 'Good {0} · Rejected {1} · Total {2}',
      detectMode: 'Detection mode', detectModeStandard: 'Standard', detectModeFine: 'Fine', thresholdReset: 'Reset thresholds', thresholdResetDone: 'Detection thresholds reset', fineModeSet: 'Fine detection selected (applies next scan)', standardModeSet: 'Standard detection selected (applies next scan)',
      settingsTitle: 'Detection Levels', lblBlur: 'Blur', lblOver: 'Overexposed', lblUnder: 'Underexposed', lblDark: 'Dark', lblFocus: 'Out-of-focus', lblEye: 'Eyes',
      exportLoc: 'Export Folder', exportPh: 'Leave empty to choose each time', browse: 'Browse', tourView: 'View Tutorial',
      pluginTitle: 'Plugins', confirmTitle: 'Confirm Clear', confirmText: 'Clear all photos and results?', cancel: 'Cancel', confirmOk: 'Clear',
      exportDoneTitle: 'Export Complete', openFolder: 'Open Folder', close: 'Close',
      ctxAnalyze: 'Analyze One', ctxExport: 'Export One', ctxRemark: 'Remark', ctxRemove: 'Remove',
      remarkTitle: 'Photo Remark', remarkPh: 'Remark shown at photo name', save: 'Save',
      hintTitle: 'Drop photos to start', hintSub: 'JPG / PNG / WEBP / TIFF · originals never modified',
      scanning: 'Scanning…', noImages: 'No supported images found', dupPhotos: 'These photos are already in the list',
      readyInitial: 'Ready', ready: 'Ready · pick photos to start', analyzing: 'Analyzing {0}/{1} · ~{2}s left', paused: 'Paused · {0}/{1} · click Resume', resuming: 'Resuming…'
    }
  };
  function applyLang() {
    const t = I18N[lang] || I18N.zh;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (t[key]) el.textContent = t[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.dataset.i18nPlaceholder;
      if (t[key]) el.placeholder = t[key];
    });
    const btnMap = { 'btn-pick': t.pick, 'btn-export': t.export, 'btn-reset': t.clear, 'btn-plugins': t.plugins, 'btn-settings': t.settings };
    for (const [id, txt] of Object.entries(btnMap)) {
      const el = $(id);
      if (el && el.lastChild && el.lastChild.nodeType === 3) el.lastChild.textContent = txt;
    }
    if (!scanning) {
      const scan = $('btn-scan');
      if (scan && scan.lastChild && scan.lastChild.nodeType === 3) scan.lastChild.textContent = t.scan;
    }
    const lbl = $('lang-label');
    if (lbl) lbl.textContent = lang === 'zh' ? 'EN' : '中文';
    updateSliderLabels();  // 档位标签跟随语言刷新
  }
  function t(key, ...args) {
    let txt = (I18N[lang] || I18N.zh)[key] || key;
    args.forEach((a, i) => { txt = txt.split('{' + i + '}').join(a); });
    return txt;
  }
  $('btn-lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('kx.lang', lang);
    applyLang();
    log(lang === 'zh' ? '语言：中文' : 'Language: English');
  });
  applyLang();
  log(lang === 'zh' ? '语言：中文' : 'Language: English');

  // 启动：加载插件
  loadPlugins();
})();
