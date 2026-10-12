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
  const focusSlider = $('focus-threshold');
  const eyeSlider = $('eye-threshold');
  const thresholdSliders = [blurSlider, overSlider, underSlider, focusSlider, eyeSlider];
  for (const slider of thresholdSliders) {
    const saved = localStorage.getItem('kx.threshold.' + slider.id);
    if (saved !== null && /^[0-4]$/.test(saved)) slider.value = saved;
  }

  const MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff'
  };
  const REASON_LABEL = { blur: '模糊', over: '过曝', under: '欠曝', eye: '闭眼', focus: '虚焦' };
  const REASON_LABEL_EN = { blur: 'Blur', over: 'Over', under: 'Under', eye: 'Eye Closed', focus: 'OOF' };
  const reasonLabel = (rz) => (lang === 'en' && REASON_LABEL_EN[rz] ? REASON_LABEL_EN[rz] : (REASON_LABEL[rz] || rz));
  let lang = localStorage.getItem('kx.lang') || 'zh';  // 语言(必须在顶部声明,LEVEL_LABEL 依赖)

  // 检测标准：五档中文（非常严格 / 严格 / 标准 / 宽松 / 非常宽松）→ 实际阈值
  const LEVEL_LABEL_ZH = ['非常严格', '严格', '标准', '宽松', '非常宽松'];
  const LEVEL_LABEL_EN = ['Very Strict', 'Strict', 'Standard', 'Relaxed', 'Very Relaxed'];
  const LEVEL_LABEL = () => (lang === 'en' ? LEVEL_LABEL_EN : LEVEL_LABEL_ZH);
  const BLUR_LEVELS = [400, 200, 100, 50, 20];  // 档位0=非常严格(400,稍模糊即标) → 档位4=非常宽松(20)
  const OVER_LEVELS = [3, 7, 12, 20, 35];
  const UNDER_LEVELS = [10, 25, 40, 55, 70];
  const FOCUS_LEVELS = [0.4, 0.5, 0.6, 0.75, 0.85];  // 虚焦：中央（主体）模糊块比例达到该值判虚焦（默认标准 0.6）
  const EYE_PROB_LEVELS = [0.65, 0.78, 0.88, 0.93, 0.97];  // 旋转校正融合模型：标准=源图分组交叉验证工作点

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
  let pluginAnalysisDirty = false;

  // ---------- 闭眼检测：由插件提供 ----------
  // 检测能力（闭眼等）通过插件接口提供：init / analyze / dispose / status。
  // 未启用插件时不加载 MediaPipe 运行时（13MB）也不做任何额外推理——
  // 也就是说"用户不开启插件就不用它"，内置检测器（模糊/虚焦/过曝/欠曝）不受影响。
  let eyePlugin = null;          // 当前提供闭眼判定的插件
  let faceReady = false;         // 兼容界面与诊断：闭眼检测是否可用
  let faceStatus = '闭眼插件未启用';
  const MP_WASM_DIR = 'vendor/mediapipe';

  // 传给插件的上下文：日志、翻译、当前阈值、主进程 API
  function pluginCtx() {
    return {
      log: (m) => log(m),
      t: (k) => t(k),
      thresholds: () => getThresholds(),
      api: window.api,
      wasmDir: MP_WASM_DIR
    };
  }

  function pickEyePlugin() {
    return plugins.find((p) => p.enabled && p.type === 'feature' && typeof p.analyze === 'function') || null;
  }

  // 启用（或启动时已启用）的插件做一次初始化；失败只记录，不影响其他检测
  async function activatePlugins() {
    // 先把"哪些插件已启用"反映到界面（闭眼阈值项、检测模式），不要等模型加载完
    syncEyePluginStatus();
    renderPlugins();
    for (const p of plugins) {
      if (!p.enabled || typeof p.init !== 'function') continue;
      try {
        await p.init(pluginCtx());
        p.__error = null;
      } catch (err) {
        p.__error = String((err && err.message) || err);
        console.error('插件初始化失败', p.name, err);
        logErr(L2('插件「' + p.name + '」初始化失败', 'Plugin "' + p.name + '" failed to initialize'), err);
      }
      syncEyePluginStatus();
      renderPlugins();
    }
    syncEyePluginStatus();
    renderPlugins();
  }

  // 插件显示名（英文界面用 name_en）与状态文案（插件只回报状态码，界面负责本地化）
  function pluginName(p) { return (lang === 'en' && p.name_en) ? p.name_en : (p.name || p.file); }
  function pluginStateText(st, enabled) {
    if (!st) return enabled ? t('pluginReady') : t('pluginDisabled');
    if (st.code === 'error') return t('pluginFailed') + (st.error ? '：' + st.error : '');
    if (st.code === 'loading') return t('pluginLoading');
    if (st.code === 'ready' || st.ready) return t('pluginReady');
    if (st.code === 'idle') return t('pluginDisabled');
    return enabled ? t('pluginReady') : t('pluginDisabled');
  }
  // 闭眼检测状态文案（切换语言后重新生成，避免界面里出现中英混排）
  function eyeStatusText() {
    if (!eyePlugin) return t('eyeOffHint');
    const st = typeof eyePlugin.status === 'function' ? eyePlugin.status() : null;
    if (eyePlugin.__error) return pluginName(eyePlugin) + '：' + t('pluginFailed') + '（' + eyePlugin.__error + '）';
    return pluginName(eyePlugin) + '：' + pluginStateText(st, true);
  }

  function syncEyePluginStatus() {
    eyePlugin = pickEyePlugin();
    // 闭眼阈值档位只在插件开启时出现：不开启就没有闭眼检测，也就没有可调项
    const eyeRow = $('row-eye');
    if (eyeRow) eyeRow.hidden = !eyePlugin;
    syncDetectMode();
    faceStatus = eyeStatusText();
    const st = eyePlugin && typeof eyePlugin.status === 'function' ? eyePlugin.status() : null;
    faceReady = !!(st && st.ready);
  }

  // 供诊断/验收使用：由启用的闭眼插件执行一次判定，返回其 detail
  async function eyeScore(canvas, metrics, source) {
    if (!eyePlugin) return null;
    const v = await eyePlugin.analyze(canvas, metrics || {}, { ...pluginCtx(), eyeSource: source || canvas });
    return v && v.detail ? v.detail : null;
  }

  // ---------- 工具函数 ----------
  const extOf = (p) => { const m = p.match(/\.[^.]+$/); return m ? m[0].toLowerCase() : ''; };
  const nameOf = (p) => p.split(/[\\/]/).pop();

  function setStatus(t) { statusEl.textContent = t; }
  function setStats(t) { statsEl.textContent = t; }
  function getThresholds() {
    const lv = (s) => Math.max(0, Math.min(4, Math.round(+s.value)));
    return {
      blur: BLUR_LEVELS[lv(blurSlider)],
      over: OVER_LEVELS[lv(overSlider)],
      under: UNDER_LEVELS[lv(underSlider)],
      focus: FOCUS_LEVELS[lv(focusSlider)],
      eye: EYE_PROB_LEVELS[lv(eyeSlider)]
    };
  }
  function updateSliderLabels() {
    // 拖动过程中值是连续的，取最近档位名做预览
    const nm = (s) => LEVEL_LABEL()[Math.max(0, Math.min(4, Math.round(+s.value)))];
    $('blur-val').textContent = nm(blurSlider);
    $('over-val').textContent = nm(overSlider);
    $('under-val').textContent = nm(underSlider);
    $('focus-val').textContent = nm(focusSlider);
    $('eye-val').textContent = nm(eyeSlider);
  }
  // 判定 + 严重程度：severity ∈ (0,1]，0 表示没有该问题。
  // 刚过阈值 ≈0.35，越严重越接近 1——质量分按"问题类型权重 × 严重程度"扣，而不是只数个数。
  function judgeDetailed(m, thr) {
    const out = [];
    const sev = (base) => Math.max(0, Math.min(1, base));
    if (m.blurBlocks && m.blurBlocks.length >= 16) {
      const vars = m.blurBlocks;
      const allRatio = vars.filter((v) => v < thr.blur).length / vars.length;
      const center = [vars[5], vars[6], vars[9], vars[10]];
      const centerRatio = center.filter((v) => v < thr.blur).length / center.length;
      if (allRatio >= 0.7) {
        out.push({ reason: 'blur', severity: sev(0.35 + 0.65 * ((allRatio - 0.7) / 0.3)) });
      } else if (centerRatio >= thr.focus) {
        const span = Math.max(0.05, 1 - thr.focus);
        out.push({ reason: 'focus', severity: sev(0.35 + 0.65 * ((centerRatio - thr.focus) / span)) });
      }
    }
    const overPct = m.overRatio * 100;
    if (overPct > thr.over) out.push({ reason: 'over', severity: sev(0.35 + 0.65 * ((overPct - thr.over) / Math.max(5, 100 - thr.over))) });
    const underPct = m.underRatio * 100;
    if (underPct > thr.under) out.push({ reason: 'under', severity: sev(0.35 + 0.65 * ((underPct - thr.under) / Math.max(5, 100 - thr.under))) });
    // 插件判定（闭眼等）：fire === false 表示"算出结果但本次不标记"
    for (const v of (m.__verdicts || [])) {
      const d = v.detail || {};
      if (v.reason === 'eye' && window.EyeDetector) {
        if (!eyePlugin || !window.EyeDetector.isClosed(d, thr.eye)) continue;
      } else if (v.fire === false) continue;
      if (!REASON_LABEL[v.reason]) REASON_LABEL[v.reason] = v.label || v.reason;
      // 插件可在 detail 里给出概率，用"超过阈值多少"折算严重程度
      let s = 0.6;
      if (v.reason === 'eye' && Number.isFinite(d.p)) {
        s = 0.35 + 0.65 * Math.min(1, (d.p - thr.eye) / Math.max(0.05, 1 - thr.eye));
      }
      out.push({ reason: v.reason, severity: sev(s), plugin: v.__plugin });
    }
    // 兼容只实现同步 detect 的插件（旧格式）
    for (const p of plugins) {
      if (!(p.enabled && p.type === 'feature' && typeof p.detect === 'function' && typeof p.analyze !== 'function')) continue;
      try {
        const extra = p.detect(m);
        if (extra && extra.reason) {
          if (!REASON_LABEL[extra.reason]) REASON_LABEL[extra.reason] = extra.label || extra.reason;
          out.push({ reason: extra.reason, severity: sev(Number.isFinite(extra.severity) ? extra.severity : 0.6) });
        }
      } catch (err) {
        p.__error = String((err && err.message) || err);
        console.error('plugin detect error:', p.name, err);
        logErr(L2('插件「' + p.name + '」检测出错', 'Plugin "' + p.name + '" detect error'), err);
      }
    }
    return out;
  }

  // 兼容旧调用：只要原因列表
  function judge(m, thr) { return judgeDetailed(m, thr).map((d) => d.reason); }

  // 质量分：按"问题权重 × 严重程度"扣分，再乘上无问题时的成像素质项
  //  权重体现"对选片决策的影响"：模糊最致命，闭眼次之（人像），曝光问题再次
  const ISSUE_WEIGHT = { blur: 0.62, focus: 0.34, eye: 0.30, over: 0.17, under: 0.17 };
  function scoreFromIssues(m, issues) {
    // 无问题时：清晰度/对比度/细节决定分数（85~100），而不是一律 100
    const blurScore = Number.isFinite(m.blurScore) ? m.blurScore : 0;
    const sharpQ = Math.min(1, Math.log1p(Math.max(0, blurScore)) / Math.log1p(1200));
    const contrastQ = Math.min(1, (Number.isFinite(m.contrast) ? m.contrast : 0) / 42);
    const detailQ = Number.isFinite(m.detailConfidence) ? Math.min(1, m.detailConfidence) : contrastQ;
    const base = 100 * (0.86 + 0.14 * (0.45 * sharpQ + 0.3 * contrastQ + 0.25 * detailQ));
    let deduct = 0;
    const seen = {};
    for (const it of issues) {
      seen[it.reason] = Math.max(seen[it.reason] || 0, it.severity || 0);
    }
    for (const [reason, sev] of Object.entries(seen)) {
      const w = ISSUE_WEIGHT[reason] !== undefined ? ISSUE_WEIGHT[reason] : 0.2;   // 未知插件问题给一个中等权重
      deduct += w * Math.pow(sev, 0.6);
    }
    const score = base * (1 - Math.min(0.94, deduct));
    return Math.round(Math.max(0, Math.min(100, score)));
  }

  // ---------- 动效引擎（全部走 JS / Web Animations API，不用 CSS 过渡） ----------
  // 尊重系统"减少动态效果"设置；动画失败也绝不影响功能
  const reduceMotion = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();
  const EASE = 'cubic-bezier(.22,.61,.36,1)';
  const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
  const EASE_SMOOTH = 'cubic-bezier(.4,0,.2,1)';   // 进出对称，收放都顺
  const EASE_IN = 'cubic-bezier(.4,0,.9,.4)';      // 离场：缓慢起步再加速离开

  function anim(el, frames, opts) {
    if (!el || reduceMotion || typeof el.animate !== 'function') return null;
    try { return el.animate(frames, Object.assign({ duration: 260, easing: EASE, fill: 'both' }, opts || {})); }
    catch (e) { return null; }
  }

  // 入场：淡入 + 轻微上浮 + 微缩放（卡片、面板、空状态都用同一套语汇）
  function popIn(el, delay) {
    if (!el) return;
    return anim(el, [
      { opacity: 0, transform: 'translateY(10px) scale(.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: 300, easing: EASE_OUT, delay: delay || 0 });
  }

  // 出场：反向但更柔（先慢后快，像被轻轻收回；收起来要利落但不生硬）
  function popOut(el, done) {
    if (!el) { if (done) done(); return; }
    const a = anim(el, [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(8px) scale(.965)' }
    ], { duration: 210, easing: EASE_IN });
    let called = false;
    const finish = () => { if (!called) { called = true; if (done) done(); } };
    if (a) { a.onfinish = finish; setTimeout(finish, 260); }   // 兜底：动画被取消也要收尾
    else finish();
  }

  // 卡片入场：逐个错开，像水波一样铺开
  function animateCards(nodes) {
    if (reduceMotion) return;
    let i = 0;
    for (const el of nodes) {
      if (el.dataset.kxShown === '1') continue;
      el.dataset.kxShown = '1';
      popIn(el, Math.min(i, 14) * 26);
      i++;
    }
  }

  // 卡片悬浮：轻轻浮起 + 投影加深（JS 驱动，进出都有过渡）
  // 投影值从 CSS 变量读取，避免动画写死深色投影（白主题/暗色主题都会自动跟随）
  function attachHoverLift(el) {
    if (reduceMotion || typeof el.animate !== 'function') return;
    let hover = null;
    const shadows = () => {
      const cs = getComputedStyle(el);
      const base = (cs.getPropertyValue('--card-shadow') || '').trim() || '0 2px 10px rgba(23, 35, 64, .1)';
      const up = (cs.getPropertyValue('--card-shadow-hover') || '').trim() || '0 14px 30px rgba(23, 35, 64, .18)';
      return { base: base, up: up };
    };
    el.addEventListener('pointerenter', () => {
      if (hover) { try { hover.cancel(); } catch (e) {} }
      const s = shadows();
      hover = anim(el, [
        { transform: 'translateY(0) scale(1)', boxShadow: s.base },
        { transform: 'translateY(-5px) scale(1.01)', boxShadow: s.up }
      ], { duration: 240, easing: EASE_OUT, fill: 'forwards' });
    });
    el.addEventListener('pointerleave', () => {
      if (hover) { try { hover.cancel(); } catch (e) {} }
      const s = shadows();
      hover = anim(el, [
        { transform: 'translateY(-5px) scale(1.01)', boxShadow: s.up },
        { transform: 'translateY(0) scale(1)', boxShadow: s.base }
      ], { duration: 220, easing: EASE_SMOOTH, fill: 'forwards' });
    });
  }

  // 面板展开/收起：用 JS 动画替代直接切 hidden，避免"啪"一下很生硬
  function showPanel(el, anchor) {
    if (!el) return;
    el.hidden = false;
    // 从锚点方向展开/收回：面板贴在工具栏按钮下方，所以原点取顶部右侧
    el.style.transformOrigin = 'top right';
    if (anchor && typeof placePanel === 'function') placePanel(el, anchor);
    // 液态玻璃：浏览器支持 backdrop-filter 用 SVG 滤镜时，加上背景折射层
    try {
      if (!el.dataset.kxGlassChecked) {
        el.dataset.kxGlassChecked = '1';
        const ok = (window.CSS && CSS.supports && (CSS.supports('backdrop-filter', 'url(#kx-glass-refract)') ||
                                                   CSS.supports('-webkit-backdrop-filter', 'url(#kx-glass-refract)')));
        if (ok && document.getElementById('kx-glass-refract')) el.classList.add('kx-refract');
      }
    } catch (e) { /* 不支持就只用磨砂 */ }
    anim(el, [
      { opacity: 0, transform: 'translateY(-10px) scale(.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: 280, easing: EASE_OUT });
  }
  function hidePanel(el) {
    if (!el || el.hidden) return;
    el.style.transformOrigin = 'top right';
    popOut(el, () => { el.hidden = true; });
  }
  function togglePanel(el, anchor) { if (el.hidden) showPanel(el, anchor); else hidePanel(el); }

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
      // 插件逐张检测（闭眼等）。未启用插件时完全跳过——不加载模型、不做额外推理。
      metrics.__verdicts = [];
      for (const p of plugins) {
        if (!(p.enabled && p.type === 'feature' && typeof p.analyze === 'function')) continue;
        try {
          const v = await p.analyze(fc, metrics, { ...pluginCtx(), eyeSource: img });
          if (v && v.reason) {
            v.__plugin = p.id || p.file;
            metrics.__verdicts.push(v);
            if (v.reason === 'eye' && v.detail) metrics.eye = v.detail;   // 供界面与验收读取
          }
        } catch (err) {
          if (p === eyePlugin) metrics.eye = { p: null, reliable: false, status: 'detector-error' };
          p.__error = String((err && err.message) || err);
          console.error('插件检测失败', p.name, err);
          logErr(L2('插件「' + p.name + '」检测失败', 'Plugin "' + p.name + '" analyze failed'), err);
        }
      }
      syncEyePluginStatus();
      metrics.width = nw;
      metrics.height = nh;
      // 质量分：按严重程度加权扣分（严重程度由同一次判定给出）
      metrics.issues = judgeDetailed(metrics, getThresholds());
      metrics.qualityScore = scoreFromIssues(metrics, metrics.issues);
      return { all: [metrics], thumbUrl };
    } catch (err) {
      console.error('analyze error:', f.path, err);
      logErr(L2('读取/解码照片失败：' + (f.name || f.path), 'Failed to read/decode photo: ' + (f.name || f.path)), err);
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
    thrDirty = false;
    pluginAnalysisDirty = false;
    scanning = true;
    paused = false;
    log('开始分析：' + files.length + ' 张');
    btnScan.disabled = false;
    btnScan.textContent = t('pause');
    btnPick.disabled = true;
    btnExport.disabled = true;
    sortWrap.classList.add('disabled');
    if (sortBtn) sortBtn.disabled = true;
    $('btn-report').disabled = true;
    hideCtxMenu();
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
          const result = { ...f, thumbUrl: res.thumbUrl, metrics, reasons, kept: false, manual: false };
          applyAutoDecision(result);
          results.push(result);
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
      if (sortBtn) sortBtn.disabled = false;
      removeProgressBar();
      if (prevCard) prevCard.classList.remove('analyzing');
    }
    updateStats();
    applySort();
    if (cancelled) {
      // 被取消：保留已分析部分
      setStatus(`分析已取消 · 已完成 ${results.length}/${files.length} 张`);
      log('分析已取消，已完成 ' + results.length + '/' + files.length + ' 张');
      if (results.length) {
        filterBar.hidden = false;
        applyFilter();
      }
      return;
    }
    const bad = results.filter((r) => !r.failed && !r.kept && !needsReview(r)).length;
    const review = results.filter(needsReview).length;
    log(L2('分析完成：' + results.length + ' 张成功，废片 ' + bad + ' 张', 'Analysis done: ' + results.length + ' ok, ' + bad + ' rejected'));
    setStatus(
      (lang === 'en'
        ? `Analysis done · ${results.length - failed} analyzed` + (failed ? `, ${failed} unreadable` : '') + ` · ${bad} rejected · ${review} to review`
        : `分析完成 · ${results.length - failed} 张成功` + (failed ? `，${failed} 张读取失败` : '') + ` · 废片 ${bad} 张 · 待复核 ${review} 张`) +
      (!faceReady ? ' · ' + t('eyeOffShort') : '')
    );
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
      const before = photoState(r);
      const mlist = r.metrics.all || [r.metrics];  // 精细检测保存多轮结果
      // 多轮结果：原因合并；严重程度按"最严重的一次"合并后再算分
      const detail = mlist.map((m) => judgeDetailed(m, thr));
      r.reasons = mergeReasons(detail.map((d) => d.map((x) => x.reason)));
      const merged = [];
      for (const list of detail) for (const it of list) merged.push(it);
      for (const m of mlist) {
        m.issues = judgeDetailed(m, thr);
        if (m && (m.qualityScore === undefined || m.qualityScore === null || !Number.isFinite(m.qualityScore))) continue;
        m.qualityScore = scoreFromIssues(m, merged);
      }
      const primary = mlist[0];
      if (primary && Number.isFinite(primary.qualityScore)) r.metrics.qualityScore = primary.qualityScore;
      applyAutoDecision(r);
      if (before !== photoState(r)) changed++;
      const card = cards[i];
      if (card) updateCardState(card, r);
    }
    updateStats();
    const bad = results.filter((r) => !r.failed && !r.kept && !needsReview(r)).length;
    const review = results.filter(needsReview).length;
    setStatus(changed
      ? `阈值已更新 · ${changed} 张判定发生变化 · 当前废片 ${bad} 张`
      : `阈值已更新 · 判定无变化 · 当前废片 ${bad} 张`);
    setStatus(statusEl.textContent + L2(` · 待复核 ${review} 张`, ` · ${review} to review`));
  }

  // ---------- 阈值滑块：自由拖动 + 松手吸附到最近档位 ----------
  // 拖动过程是连续值（不再一格一格跳）；松手用一小段缓动"吸"到最近档位。
  // 阈值改动不再自动重判 —— 由用户点「开始分析」才生效（thrDirty 标记）。
  let thrDirty = false;
  function sliderFill(s) {
    const min = +s.min || 0, max = +s.max || 4;
    const pct = ((+s.value - min) / (max - min)) * 100;
    s.style.setProperty('--kx-fill', pct.toFixed(2) + '%');
  }
  function markThresholdsDirty() {
    if (!results.length) return;   // 还没分析过，没有"待生效"的概念
    thrDirty = true;
    setStatus(t('thrDirty'));
    seekEl(btnScan);
  }
  function popSliderLabel(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('kx-pop');
    void el.offsetWidth;
    el.classList.add('kx-pop');
    setTimeout(() => el.classList.remove('kx-pop'), 400);
  }
  function snapSlider(s, animateSnap) {
    const target = Math.max(+s.min, Math.min(+s.max, Math.round(+s.value)));
    const from = +s.value;
    const settle = () => {
      const item = s.closest('.slider-item');
      if (item && !reduceMotion) {
        item.classList.remove('kx-settle');
        void item.offsetWidth;
        item.classList.add('kx-settle');
        setTimeout(() => item.classList.remove('kx-settle'), 400);
      }
      popSliderLabel(s.id.replace('-threshold', '-val'));
    };
    if (!animateSnap || reduceMotion || Math.abs(target - from) < 0.015) {
      s.value = String(target);
      sliderFill(s);
      updateSliderLabels();
      settle();
      return;
    }
    const t0 = performance.now(), dur = 190;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.value = String(target);
      sliderFill(s);
      updateSliderLabels();
      settle();
      try { localStorage.setItem('kx.threshold.' + s.id, String(target)); } catch (e) {}
      log('阈值「' + s.id + '」= ' + LEVEL_LABEL()[target]);
    };
    const tick = (now) => {
      if (done) return;
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);    // easeOutCubic：快速贴近、缓慢收尾
      s.value = String(from + (target - from) * e);
      sliderFill(s);
      if (k < 1) requestAnimationFrame(tick);
      else finish();
    };
    requestAnimationFrame(tick);
    // 兜底：窗口被遮挡时 rAF 会被节流甚至暂停，务必让吸附在固定时间内落地（否则滑块停在中间值）
    setTimeout(finish, dur + 120);
  }
  thresholdSliders.forEach((s) => {
    sliderFill(s);
    s.addEventListener('input', () => {   // 拖动中：只更新视觉，不重判
      localStorage.setItem('kx.threshold.' + s.id, Math.round(+s.value));
      sliderFill(s);
      updateSliderLabels();
    });
    const release = () => { snapSlider(s, true); markThresholdsDirty(); };
    s.addEventListener('change', release);
    s.addEventListener('pointerup', release);
    s.addEventListener('keyup', release);
  });

  // ---------- 渲染 ----------
  // 构建单张卡片（失败照片显示占位，不消失）
  function buildCard(r) {
    const card = document.createElement('div');
    card.className = 'card ' + photoState(r) + (r.manual ? ' manual' : '');
    let clickTimer = null;
    card.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      clickTimer = null;
      openViewer(card);
    });
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
    if (!r.failed && !r.pending) setCardReason(card, r);
    updateQualityBadge(card, r);

    card.addEventListener('click', (event) => {
      clearTimeout(clickTimer);
      if (event.detail > 1) return;
      const index = Array.prototype.indexOf.call(grid.children, card);
      const clicked = results[index];
      if (scanning || !clicked || clicked.pending || clicked.failed) return;
      // Wait through the double-click interval before changing state or hiding this card.
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const index = Array.prototype.indexOf.call(grid.children, card);
        if (index < 0 || scanning || results[index] !== clicked) return;
        markPhoto(index, clicked.kept ? 'rejected' : 'kept');
      }, 500);
    });
    card.addEventListener('contextmenu', (e) => {
      clearTimeout(clickTimer);
      clickTimer = null;
      e.preventDefault();
      if (scanning) return;
      e.stopPropagation();  // 阻止冒泡到 document 的关闭逻辑（否则菜单瞬间被关闭）
      showCtxMenu(card);
    });
    attachHoverLift(card);   // 悬浮轻浮起 + 投影加深
    return card;
  }

  // 空列表也要给东西看：小图 + 一句话，不留白
  function emptyGridCard(title, sub) {
    const d = document.createElement('div');
    d.className = 'grid-empty';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '46');
    svg.setAttribute('height', '46');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>';
    const p = document.createElement('p');
    p.className = 'grid-empty-title';
    p.textContent = title;
    const s = document.createElement('small');
    s.className = 'grid-empty-sub';
    s.textContent = sub;
    d.appendChild(svg); d.appendChild(p); d.appendChild(s);
    return d;
  }

  function renderResults(list) {
    grid.innerHTML = '';
    if (!list.length) {
      grid.appendChild(emptyGridCard(t('gridEmptyTitle'), t('gridEmptySub')));
      popIn(grid.firstChild);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(buildCard(r));
    grid.appendChild(frag);
    animateCards(grid.querySelectorAll('.card'));
  }

  // 分析中增量追加新卡片（避免反复全量重建）
  function appendResults(list) {
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(buildCard(r));
    grid.appendChild(frag);
    animateCards(grid.querySelectorAll('.card:not([data-kx-shown])'));
  }

  // 局部更新单张卡片状态（改判/阈值调整/分析完成时更新，不重建网格）
  function updateCardState(card, r) {
    card.classList.toggle('kept', r.kept);
    card.classList.toggle('rejected', photoState(r) === 'rejected');
    card.classList.toggle('review', needsReview(r));
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
  function needsReview(r) {
    if (!r || r.failed || r.pending) return false;
    if (r.manual) return r.review === true;
    if (r.reasons.length || !eyePlugin || !r.metrics || !window.EyeDetector) return false;
    return (r.metrics.all || [r.metrics]).some(m => m.eye &&
      !['off', 'open', 'closed', 'no-face'].includes(window.EyeDetector.decision(m.eye, getThresholds().eye)));
  }
  function applyAutoDecision(r) {
    r.review = needsReview(r);
    r.kept = !r.reasons.length && !r.review;
  }
  function photoState(r) {
    return r && r.failed ? 'failed' : r && r.pending ? 'pending' : needsReview(r) ? 'review' : r && r.kept ? 'kept' : 'rejected';
  }
  function eyeSummary(metrics) {
    if (!eyePlugin || !metrics || !metrics.eye || !window.EyeDetector) return '';
    const state = window.EyeDetector.decision(metrics.eye, getThresholds().eye);
    const text = state === 'closed' ? L2('检测到双眼闭合', 'Both eyes closed') :
      state === 'open' ? L2('睁眼倾向', 'Likely open') :
      state === 'no-face' ? L2('未检测到人脸', 'No face detected') :
      L2('眼部不确定，需人工复核', 'Uncertain eyes — review manually');
    const count = metrics.eye.faceCount;
    return L2('眼部：', 'Eyes: ') + text + (count > 1 ? L2(`（检查 ${count} 张人脸）`, ` (${count} faces checked)`) : '');
  }
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
    const eyeText = eyeSummary(m);
    if (eyeText) badge.title += '\n' + eyeText;
  }

  function setCardReason(card, r) {
    let box = card.querySelector('.reason');
    const m = primaryMetrics(r);
    const eyeState = eyePlugin && m && m.eye && window.EyeDetector ? window.EyeDetector.decision(m.eye, getThresholds().eye) : 'off';
    const reviewEyes = !['off', 'open', 'closed', 'no-face'].includes(eyeState);
    if (r.reasons.length || reviewEyes || needsReview(r)) {
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
      if (reviewEyes) {
        const label = document.createElement('span');
        label.className = 'tag eye-review';
        label.textContent = r.manual && !r.review ? L2('已人工复核', 'Reviewed') : L2('眼部需复核', 'Review eyes');
        label.title = eyeSummary(m);
        box.appendChild(label);
      }
      if (needsReview(r) && !reviewEyes) {
        const label = document.createElement('span');
        label.className = 'tag manual-review';
        label.textContent = L2('待复核', 'To review');
        box.appendChild(label);
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
    const review = list.filter(needsReview).length;
    const failed = list.filter(r => r.failed).length;
    const bad = list.length - kept - review - failed;
    setStats(t('statsSummary', kept, bad, review, list.length) + (failed ? L2(` · 读取失败 ${failed}`, ` · Failed ${failed}`) : ''));
    btnExport.disabled = scanning || !kept;
  }

  function markPhoto(index, state) {
    const r = results[index];
    if (scanning || !r || r.failed || r.pending) return;
    r.manual = true;
    r.review = state === 'review';
    r.kept = state === 'kept';
    const card = grid.children[index];
    if (card) updateCardState(card, r);
    updateStats();
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

  // ---------- 废片筛选（全部 / 模糊 / 过曝 / 欠曝 / 闭眼 / 虚焦） ----------
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
      else if (filter === 'rejected') show = !r.kept && !needsReview(r);
      else if (filter === 'review') show = needsReview(r);
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
  // 右键菜单固定贴在卡片上（不跟随鼠标）：优先卡片右侧，空间不够放左侧，仍不够就贴卡片内
  function showCtxMenu(card) {
    ctxIndex = Array.prototype.indexOf.call(grid.children, card);
    ctxMenu.hidden = false;   // 先显示，才能量到实际尺寸
    const r = card.getBoundingClientRect();
    const mw = ctxMenu.offsetWidth || 152;
    const mh = ctxMenu.offsetHeight || 132;
    const gap = 8;
    let left = r.right + gap;
    if (left + mw > window.innerWidth - gap) left = r.left - mw - gap;
    if (left < gap) left = Math.min(Math.max(gap, r.left), window.innerWidth - mw - gap);
    let top = r.top + 6;
    if (top + mh > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - mh - gap);
    ctxMenu.style.left = Math.round(left) + 'px';
    ctxMenu.style.top = Math.round(top) + 'px';
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
      applyAutoDecision(r);
    }
    results[idx] = r;
    const card = grid.children[idx];
    if (card) updateCardState(card, r);
    updateStats();
    filterBar.hidden = false;
    btnExport.disabled = !results.some((r) => r && r.kept && !r.failed);
    setStatus(`已单独分析「${f.name}」` + (r.failed ? ' · 读取失败' : needsReview(r) ? ' · 待复核' : r.reasons.length ? ' · 标记为废片' : ' · 合格'));
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
      logErr(L2('单独导出失败：' + r.name, 'Export failed: ' + r.name), err);
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
  for (const [id, state] of [['ctx-keep', 'kept'], ['ctx-reject', 'rejected'], ['ctx-review', 'review']]) {
    $(id).addEventListener('click', () => { const index = ctxIndex; hideCtxMenu(); markPhoto(index, state); });
  }
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
    const headers = ['文件名', '路径', '质量分', '状态', '问题', '清晰度', '平均亮度', '对比度', '眼部判定', '闭眼概率'];
    const rows = list.map((r) => {
      const m = primaryMetrics(r) || {};
      const state = r.failed ? '读取失败' : needsReview(r) ? '待复核' : r.kept ? '合格' : '废片';
      return [r.name, r.path, Number.isFinite(m.qualityScore) ? m.qualityScore : '', state, r.reasons.map(reasonLabel).join('、'), Number.isFinite(m.blurScore) ? Math.round(m.blurScore) : '', Number.isFinite(m.avgLuma) ? m.avgLuma.toFixed(1) : '', Number.isFinite(m.contrast) ? m.contrast.toFixed(1) : '', eyeSummary(m), eyePlugin && m.eye && Number.isFinite(m.eye.p) ? m.eye.p.toFixed(4) : ''];
    });
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    try {
      const saved = window.api.saveReport ? await window.api.saveReport(csv) : null;
      if (saved) { setStatus(t('reportSaved', saved)); log('已保存分析报告：' + saved); }
    } catch (err) {
      setStatus(t('reportFailed') + '：' + (err.message || err));
      logErr(L2('保存分析报告失败', 'Failed to save report'), err);
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
    const kept = results.filter((r) => r && r.kept && !r.failed && !needsReview(r)).map((r) => r.path);
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
      logErr(L2('导出合格片失败（目标：' + dest + '）', 'Export failed (target: ' + dest + ')'), err);
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
      const eyeText = eyeSummary(primaryMetrics(r));
      if (eyeText) $('viewer-name').textContent += ' · ' + eyeText;
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
    syncSortUI();
    updateOverview();
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
          if (!def || (!def.css && !def.detect && !def.analyze)) continue;
          const key = def.id || item.name;
          // 默认停用：只有用户手动启用才生效；选择保存在本地，重启后保留
          const enabled = localStorage.getItem('kx.plugin.' + key) === '1';
          plugins.push({ ...def, file: item.file, enabled });
        } catch (err) {
          console.error('插件加载失败', item.name, err);
          logErr(L2('插件加载失败：' + item.name, 'Plugin load failed: ' + item.name), err);
          plugins.push({ id: item.name, name: item.name, file: item.file, enabled: false, __error: '加载失败：' + ((err && err.message) || err) });
        }
      }
      applyTheme();
      renderPlugins();
      activatePlugins();   // 已启用的插件异步初始化，不阻塞界面
    } catch (err) { console.error('list plugins error', err); logErr(L2('读取插件目录失败', 'Failed to read plugins folder'), err); }
  }

  // 插件行：名称 + 类型/版本/作者/许可（声明）+ 功能说明 + 运行状态 + 启用开关
  function pluginRow(p, onToggle) {
    const row = document.createElement('div');
    row.className = 'plugin-item';

    const meta = document.createElement('div');
    meta.className = 'plugin-meta';

    const nm = document.createElement('div');
    nm.className = 'plugin-name';
    nm.textContent = pluginName(p);
    meta.appendChild(nm);

    const typeName = p.type === 'theme' ? t('pluginTypeTheme') : (p.type === 'feature' ? t('pluginTypeFeature') : t('pluginTypeOther'));
    const decl = [typeName + ' · v' + (p.version || '1.0')];
    const costText = lang === 'en' && p.cost_en ? p.cost_en : p.cost;
    if (costText) decl.push(costText);
    const typeEl = document.createElement('div');
    typeEl.className = 'plugin-type';
    typeEl.textContent = decl.join('　');
    meta.appendChild(typeEl);

    const descText = lang === 'en' && p.description_en ? p.description_en : p.description;
    if (descText) {
      const descEl = document.createElement('div');
      descEl.className = 'plugin-desc';
      descEl.textContent = descText;
      meta.appendChild(descEl);
    }
    if (p.license) {
      const licEl = document.createElement('div');
      licEl.className = 'plugin-license';
      const licText = lang === 'en' && p.license_en ? p.license_en : p.license;
      licEl.textContent = (lang === 'en' ? t('pluginLicense') + ': ' : t('pluginLicense') + '：') + licText;
      meta.appendChild(licEl);
    }
    // 开源地址：可点击打开（http/https）
    if (Array.isArray(p.links) && p.links.length) {
      const wrap = document.createElement('div');
      wrap.className = 'plugin-links';
      for (const l of p.links) {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'plugin-link';
        a.textContent = (lang === 'en' && l.label_en ? l.label_en : l.label) || l.url;
        a.title = l.url;
        a.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (window.api.openExternal) window.api.openExternal(l.url);
        });
        wrap.appendChild(a);
      }
      meta.appendChild(wrap);
    }

    // 运行状态：插件的 status() 或加载错误都显示出来，不再静默失败
    const st = typeof p.status === 'function' ? p.status() : null;
    const stEl = document.createElement('div');
    stEl.className = 'plugin-status' + (p.__error ? ' bad' : (st && st.ready ? ' ok' : ''));
    stEl.textContent = (p.__error ? '⚠ ' : '') + (p.__error || pluginStateText(st, p.enabled));
    meta.appendChild(stEl);

    row.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.className = 'btn small plugin-toggle' + (p.enabled ? ' on' : '');
    toggle.textContent = p.enabled ? t('pluginOn') : t('pluginOff');
    toggle.title = p.enabled ? t('pluginTurnOff') : t('pluginTurnOn');
    toggle.addEventListener('click', () => onToggle());
    row.appendChild(toggle);
    return row;
  }

  function renderPlugins() {
    pluginsList.innerHTML = '';
    if (!plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'plugin-empty';
      empty.textContent = t('pluginEmpty');
      pluginsList.appendChild(empty);
    } else {
      let idx = 0;
      for (const p of plugins) {
        const row = pluginRow(p, async () => {
          p.enabled = !p.enabled;
          if (p.type === 'feature') pluginAnalysisDirty = true;
          localStorage.setItem('kx.plugin.' + (p.id || p.file), p.enabled ? '1' : '0');
          applyTheme();
          p.__error = null;
          if (p.enabled) {
            renderPlugins();
            if (typeof p.init === 'function') {
              try { await p.init(pluginCtx()); } catch (err) { p.__error = String((err && err.message) || err); }
            }
            // 逐张检测类插件需要重新检测才会产出结果
            if (typeof p.analyze === 'function') {
              log('插件「' + (p.name || p.file) + '」已启用，重新点「开始检测」后对新结果生效');
            }
          } else if (typeof p.dispose === 'function') {
            try { p.dispose(); } catch (e) { /* 忽略 */ }
          }
          syncEyePluginStatus();
          renderPlugins();
          if (results.length) {
            if (!p.enabled || typeof p.analyze !== 'function') rejudge();
          }
        });
        pluginsList.appendChild(row);
        popIn(row, Math.min(idx, 6) * 40);   // 逐个错开入场，不再"啪"地出现
        idx++;
      }
    }
    // 底部：打开插件文件夹（用户自己放插件的地方）
    pluginsFoot.textContent = '';
    const openBtn = document.createElement('button');
    openBtn.className = 'btn small';
    openBtn.type = 'button';
    openBtn.textContent = t('pluginOpenFolder');
    openBtn.addEventListener('click', async () => {
      try { await window.api.openPluginsDir(); } catch (err) { log('打开插件文件夹失败：' + ((err && err.message) || err)); }
    });
    pluginsFoot.appendChild(openBtn);
    const hint = document.createElement('div');
    hint.className = 'plugin-foot-hint';
    hint.textContent = t('pluginFolderHint');
    pluginsFoot.appendChild(hint);
  }

  btnPlugins.addEventListener('click', () => {
    if (pluginsPanel.hidden) { showPanel(pluginsPanel, btnPlugins); loadPlugins(); }
    else hidePanel(pluginsPanel);
  });

  // ---------- 绑定事件 ----------
  btnPick.addEventListener('click', pickFolders);
  $('hint-import').addEventListener('click', pickFolders);   // 空状态里的"立即导入吧"
  btnScan.addEventListener('click', () => {
    if (scanning) {
      paused = !paused;  // 暂停 / 继续
      btnScan.textContent = paused ? t('resume') : t('pause');
      if (!paused) setStatus(t('resuming'));
      return;
    }
    // 只改了阈值：照片指标没变，重新判定即可（秒出），不必重跑一遍检测
    const allAnalyzed = results.length > 0 && files.length > 0 &&
      results.filter((r) => r && (r.metrics || r.failed)).length === files.length;
    if (thrDirty && allAnalyzed && !pluginAnalysisDirty) {
      thrDirty = false;
      log('阈值已改：重新判定 ' + results.length + ' 张（复用已有指标）');
      rejudge();
      return;
    }
    analyzeAll();
  });
  btnExport.addEventListener('click', exportKept);
  btnReset.addEventListener('click', () => {
    if (files.length || results.length) $('confirm-overlay').hidden = false;
  });
  $('btn-report').addEventListener('click', exportReport);
  // 检测模式完全由插件决定（面板里已不提供选项）：
  //   精细检测插件开启 → 每次分析都用精细；未开启 → 标准
  function syncDetectMode() {
    detectMode = plugins.some((p) => p.enabled && p.fine) ? 'fine' : 'standard';
  }
  syncDetectMode();
  // 排序：自绘下拉（展开/收起有动画，选中项高亮）
  const sortWrap = document.querySelector('.sort-wrap');
  const sortBtn = $('sort-btn');
  const sortMenu = $('sort-menu');
  const SORT_KEYS = { import: 'sortImport', 'quality-desc': 'sortQualityDesc', 'quality-asc': 'sortQualityAsc', name: 'sortName' };
  function syncSortUI() {
    const cur = $('sort-current');
    if (cur) cur.textContent = t(SORT_KEYS[sortOrder] || 'sortImport');
    sortMenu.querySelectorAll('.sort-item').forEach((b) => b.classList.toggle('active', b.dataset.sort === sortOrder));
  }
  function toggleSortMenu() {
    const open = sortMenu.hidden;
    if (open) {
      sortWrap.classList.add('open');
      showPanel(sortMenu);   // 统一的面板展开动画（含液态玻璃检测）
      sortBtn.setAttribute('aria-expanded', 'true');
    } else {
      sortWrap.classList.remove('open');
      sortBtn.setAttribute('aria-expanded', 'false');
      hidePanel(sortMenu);
    }
  }
  sortBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSortMenu(); });
  sortMenu.querySelectorAll('.sort-item').forEach((b) => {
    b.addEventListener('click', () => {
      const value = b.dataset.sort;
      sortOrder = SORT_KEYS[value] ? value : 'import';
      syncSortUI();
      toggleSortMenu();
      log('排序方式：' + t(SORT_KEYS[sortOrder]));
      applySort();
    });
  });
  document.addEventListener('click', (e) => {
    if (!sortMenu.hidden && !sortWrap.contains(e.target)) toggleSortMenu();
  });
  // 注：syncSortUI() 依赖 I18N，必须等 I18N 定义后再调用（见文件末尾初始化处）
  $('btn-threshold-reset').addEventListener('click', () => {
    thresholdSliders.forEach((slider) => {
      slider.value = '2';
      localStorage.removeItem('kx.threshold.' + slider.id);
      sliderFill(slider);
      popSliderLabel(slider.id.replace('-threshold', '-val'));
    });
    updateSliderLabels();
    log('阈值已恢复默认（5 项标准档）');
    markThresholdsDirty();
    setStatus(t('thresholdResetDone') + ' · ' + t('thrDirty'));
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

  btnSettings.addEventListener('click', () => { togglePanel(settingsPanel, btnSettings); });

  // 工具栏等固定区域用闪烁提示（它们不在滚动容器里，滚动无效）
  function seekEl(el) {
    if (!el) return false;
    const scroller = document.querySelector('.dropzone');
    if (scroller && scroller.contains(el) && el !== scroller) {
      scroller.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' });
      return true;
    }
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2600);
    return false;
  }

  const donationOverlay = $('donation-overlay');
  const closeDonation = () => {
    popOut(donationOverlay.querySelector('.donation-box'), () => { donationOverlay.hidden = true; });
  };
  $('btn-donate').addEventListener('click', () => {
    donationOverlay.hidden = false;
    anim(donationOverlay, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    const box = donationOverlay.querySelector('.donation-box');
    anim(box, [
      { opacity: 0, transform: 'translateY(16px) scale(.955)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: 320, easing: EASE_OUT });
    $('donation-close').focus();
  });
  $('donation-close').addEventListener('click', closeDonation);
  donationOverlay.addEventListener('click', (e) => { if (e.target === donationOverlay) closeDonation(); });

  // 自定义窗口控制（无边框标题栏）
  $('btn-win-min').addEventListener('click', () => window.api.minimizeWindow());
  $('btn-win-close').addEventListener('click', () => window.api.closeWindow());
  // 最大化 / 还原：无边框窗口没有系统按钮，必须自绘
  const btnWinMax = $('btn-win-max');
  const icoWinMax = $('ico-win-max');
  const RESTORE_PATH = '<rect x="1.6" y="3.4" width="7" height="7" rx="1"/><path d="M4.2 3.4V2.6a1 1 0 0 1 1-1h5.2a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-.8"/>';
  const MAX_PATH = '<rect x="1.6" y="1.6" width="8.8" height="8.8" rx="1"/>';
  function setMaxIcon(isMax) {
    if (icoWinMax) icoWinMax.innerHTML = isMax ? RESTORE_PATH : MAX_PATH;
    // 注意：本函数在 i18n 初始化之前就会被调用一次，取词失败时退回中文兜底
    try { btnWinMax.title = isMax ? t('winRestore') : t('winMaximize'); }
    catch (e) { btnWinMax.title = isMax ? '向下还原' : '最大化'; }
  }
  btnWinMax.addEventListener('click', () => window.api.toggleMaximize());
  if (window.api.onMaximizeChange) window.api.onMaximizeChange(setMaxIcon);
  setMaxIcon(false);
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
      if (!$('app-settings-overlay').hidden) closeModal($('app-settings-overlay'), '.app-settings-box');
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
  const zhSteps = [{"sel":"#app-settings-overlay [data-set-lang=\"zh\"]","title":"设置语言","desc":"先选界面语言：中文 / English——两个里必须选一个才能继续。这个窗口还能切换深色外观、查看运行日志；选好之后，后面的引导就用你选的语言显示。","inSettings":true},{"sel":"#btn-pick","title":"选择照片","desc":"点击这里选择照片文件，可多选；整个文件夹直接拖入窗口即可。新照片会追加到列表，不会清空已有内容。"},{"sel":"#btn-scan","title":"一键开始分析","desc":"自动标记五类问题：模糊（主体背景全糊）、虚焦（主体脱焦）、过曝、欠曝、闭眼。蓝色光圈逐张扫描，状态栏显示剩余时间。"},{"sel":"#filter-bar","title":"筛选废片","desc":"分析完成后，点上面的筛选按钮只看某一类照片：模糊、虚焦、过曝、欠曝、闭眼；点「全部」恢复显示。"},{"sel":"#dropzone","title":"单击改判","desc":"分析后单击照片切换合格/废片：系统判定合格显示白色 ✓，你手动选为合格显示蓝色 ✓，废片保留原因标签。"},{"sel":"#dropzone","title":"双击放大查看","desc":"双击任何照片可放大查看，滚轮缩放、按住左键拖动；右键弹出菜单，可单独分析、单独导出或从列表移除。"},{"sel":"#btn-export","title":"导出合格片","desc":"一键导出所有合格照片（白色 ✓ 和蓝色 ✓ 都会导出）到指定位置，位置可在「阈值」面板预设。"},{"sel":"#btn-donate","title":"支持作者","desc":"软件完全免费，所有功能都能用。喜欢的话可以点这里请作者喝杯奶茶。"}];
  const enSteps = [{"sel":"#app-settings-overlay [data-set-lang=\"en\"]","title":"Choose the Language","desc":"Pick the interface language first: 中文 / English — you must choose one to continue. This window also switches the dark appearance and shows the run log; the rest of the tour follows your choice.","inSettings":true},{"sel":"#btn-pick","title":"Pick Photos","desc":"Click to pick photo files (multi-select). Or drag a whole folder into the window. New photos are appended without clearing."},{"sel":"#btn-scan","title":"Start Analysis","desc":"Auto-marks five issues: blur, out-of-focus, overexposed, underexposed, eyes closed. Blue glow scans each photo."},{"sel":"#filter-bar","title":"Filter Bad Photos","desc":"After analysis, use the filter bar to view one category: blur, focus, over, under, eye. Click \"All\" to restore."},{"sel":"#dropzone","title":"Click to Re-judge","desc":"Click a photo to toggle good/bad: system-approved shows white ✓, your manual choice shows blue ✓."},{"sel":"#dropzone","title":"Double-click to Zoom","desc":"Double-click to zoom. Scroll to zoom, drag to pan. Right-click for single analyze / export / remove."},{"sel":"#btn-export","title":"Export Good Photos","desc":"Export all approved photos (white ✓ and blue ✓) to the preset folder."},{"sel":"#btn-donate","title":"Support the Author","desc":"The app is completely free with every feature unlocked. If you like it, buy the author a coffee here."}];
  const tourSteps = () => (lang === 'en' ? enSteps : zhSteps);
  let tourIdx = 0;
  // 第一步（设置语言）必须由用户明确点一个语言才能继续：默认沿用上次语言会让人以为"没得选"
  let tourLangChosen = false;
  // 进入某一步前的状态整理：第一步在设置窗口里选语言，会在教程中自动打开设置窗口；离开该步时再自动关掉
  function tourPrep(step) {
    const wantSettings = !!step.inSettings;
    if (wantSettings) {
      if (settingsOverlay.hidden) { openAppSettings(); setTimeout(placeTourNow, 380); return true; }
    } else if (!settingsOverlay.hidden) {
      settingsOverlay.hidden = true;   // 教程遮罩盖在上面，直接收起即可，不必等出场动画
      setTimeout(placeTourNow, 60); return true;
    }
    return false;
  }
  function placeTour() {
    const step = tourSteps()[tourIdx];
    if (!step) return finishTour();
    if (tourPrep(step)) return;        // 等窗口状态就绪后再量位置
    placeTourNow();
  }
  function placeTourNow() {
    const spot = $('tour-spot');
    const stepEl = $('tour-step');
    const titleEl = $('tour-title');
    const descEl = $('tour-desc');
    const nextBtn = $('tour-next');
    const step = tourSteps()[tourIdx];
    if (!step) return finishTour();
    const el = document.querySelector(step.sel);
    if (!el) { tourIdx++; if (tourIdx >= tourSteps().length) return finishTour(); return placeTour(); }
    if (el.hidden) el.hidden = false;  // 教程高亮需要显示的元素（如筛选栏）临时显示
    const r = el.getBoundingClientRect();
    spot.style.left = (r.left - 4) + 'px';
    spot.style.top = (r.top - 4) + 'px';
    spot.style.width = (r.width + 8) + 'px';
    spot.style.height = (r.height + 8) + 'px';
    stepEl.textContent = lang === 'en'
      ? 'Onboarding · Step ' + (tourIdx + 1) + ' / ' + tourSteps().length
      : '新手引导 · 第 ' + (tourIdx + 1) + ' / ' + tourSteps().length + ' 步';
    titleEl.textContent = step.title;
    descEl.textContent = step.desc;
    // 语言步：教程层本身不吃点击（下面加 kx-pass 让设置窗口里的中文/English 能被真正点到）
    const tourEl = $('tour');
    tourEl.classList.toggle('kx-pass', !!step.inSettings);
    if (step.inSettings) {
      // 必须先选一个语言：未选之前禁用「下一步」，文案直接说明原因
      nextBtn.disabled = !tourLangChosen;
      nextBtn.textContent = tourLangChosen ? (lang === 'en' ? 'Next' : '下一步')
                                           : (lang === 'en' ? 'Choose a language first' : '请先选择语言');
      return;
    }
    nextBtn.disabled = false;
    nextBtn.textContent = tourIdx === tourSteps().length - 1 ? (lang === 'en' ? 'Get Started' : '开始使用') : (lang === 'en' ? 'Next' : '下一步');
  }
  function finishTour() {
    $('tour').hidden = true;
    $('tour').classList.remove('kx-pass');
    if (!settingsOverlay.hidden) settingsOverlay.hidden = true;  // 教程停在第一步时，连设置窗口一起收起
    localStorage.setItem('kx.onboarded', '1');
    if (!results.length) filterBar.hidden = true;  // 教程临时显示的筛选栏：无结果时恢复隐藏
  }
  function startTour() {
    tourIdx = 0;
    tourLangChosen = false;   // 每次看教程都重新要求选一次语言
    $('tour').hidden = false;
    placeTour();
  }
  // 事件只绑定一次（重复打开教程不会重复触发）
  $('tour-next').addEventListener('click', () => {
    tourIdx++;
    if (tourIdx >= tourSteps().length) finishTour(); else placeTour();
  });
  if (!localStorage.getItem('kx.onboarded')) {
    setTimeout(startTour, 800);
  }
  // 设置窗口里：随时可重新查看新手教程（教程第一步会自己再打开设置窗口）
  $('btn-tour').addEventListener('click', () => {
    settingsPanel.hidden = true;
    if (!$('app-settings-overlay').hidden) $('app-settings-overlay').hidden = true;
    startTour();
  });

  // ---------- 日志：分级 + 时间 + 详细上下文；同时写文件，报错可查 ----------
  const logEntries = [];       // { t, level, msg }
  const MAX_LOG = 400;
  let logFilter = 'all';
  const LV_TEXT = () => (lang === 'en' ? { info: 'INFO', warn: 'WARN', error: 'ERR', detail: '···' }
                                        : { info: '信息', warn: '警告', error: '错误', detail: '细节' });
  function logEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function log(msg, level) {
    const lv = level || 'info';
    const d = new Date();
    const ts = d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    const entry = { t: ts, level: lv, msg: String(msg) };
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG) logEntries.shift();
    // 控制台也带上等级，排障时一眼看出错误
    const c = lv === 'error' ? console.error : (lv === 'warn' ? console.warn : console.log);
    try { c('[' + ts + '][' + lv + ']', msg); } catch (e) {}
    // 落盘（主进程追加写文件；失败不影响使用）
    try { if (window.api && window.api.logAppend) window.api.logAppend(ts + '\t' + lv + '\t' + msg); } catch (e) {}
    if (!$('app-settings-overlay').hidden) renderLogLines();
    return entry;
  }
  function logErr(where, err) {
    const detail = err && err.stack ? err.stack : String(err);
    log(where + (lang === 'en' ? ': ' : '：') + detail, 'error');
  }
  // 日志文案随界面语言（插件名/文件名等动态部分由调用处拼接）
  function L2(zh, en) { return lang === 'en' ? en : zh; }
  function renderLogLines() {
    const box = $('log-list');
    if (!box) return;
    const lv = LV_TEXT();
    const list = logFilter === 'all' ? logEntries : logEntries.filter((e) => e.level === logFilter);
    if (!list.length) {
      box.innerHTML = '<div class="log-empty">' + (lang === 'en' ? '(no log entries)' : '（暂无日志）') + '</div>';
      return;
    }
    box.innerHTML = list.map((e) => '<div class="log-line ' + e.level + '">' +
      '<span class="log-time">' + logEsc(e.t) + '</span>' +
      '<span class="log-lv">' + logEsc(lv[e.level] || e.level) + '</span>' +
      '<span class="log-msg">' + logEsc(e.msg) + '</span></div>').join('');
    box.scrollTop = box.scrollHeight;
  }
  // 全局错误捕获：以前报错只进控制台，用户看不到也发不出来
  window.addEventListener('error', (e) => {
    if (e && e.message) logErr(L2('脚本错误 ', 'Script error ') + (e.filename || '') + ':' + (e.lineno || 0), e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logErr(L2('未处理的 Promise 拒绝', 'Unhandled promise rejection'), e && e.reason ? e.reason : 'unknown');
  });
  // 通用弹窗动画：入场淡入 + 盒子上浮缩放；出场整体淡出（遮罩一起淡，不再"啪"地消失）
  function openModal(ov, boxSel) {
    if (!ov) return;
    ov.hidden = false;
    anim(ov, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE_OUT });
    const box = ov.querySelector(boxSel || '.modal-box, .log-box, .donation-box, .remark-box, .app-settings-box');
    if (box) anim(box, [
      { opacity: 0, transform: 'translateY(14px) scale(.965)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: 300, easing: EASE_OUT });
  }
  function closeModal(ov, boxSel) {
    if (!ov || ov.hidden) return;
    const box = ov.querySelector(boxSel || '.modal-box, .log-box, .donation-box, .remark-box, .app-settings-box');
    anim(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: EASE_IN });
    popOut(box || ov, () => { ov.hidden = true; });
  }

  // ---------- 设置窗口（语言 / 外观 / 日志） ----------
  const settingsOverlay = $('app-settings-overlay');
  function syncSettingsUI() {
    document.querySelectorAll('[data-set-lang]').forEach((b) => b.classList.toggle('active', b.dataset.setLang === lang));
    document.querySelectorAll('[data-set-theme]').forEach((b) => b.classList.toggle('active', b.dataset.setTheme === theme));
    document.querySelectorAll('[data-log-filter]').forEach((b) => b.classList.toggle('active', b.dataset.logFilter === logFilter));
  }
  function openAppSettings() {
    if (settingsOverlay.hidden) {
      syncSettingsUI();
      renderLogLines();
      openModal(settingsOverlay, '.app-settings-box');
      log('打开设置面板（语言 / 外观 / 日志）');
    } else {
      closeModal(settingsOverlay, '.app-settings-box');
    }
  }
  $('btn-app-settings').addEventListener('click', openAppSettings);
  $('app-settings-close').addEventListener('click', () => closeModal(settingsOverlay, '.app-settings-box'));
  settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeModal(settingsOverlay, '.app-settings-box'); });
  document.querySelectorAll('[data-set-lang]').forEach((b) => {
    b.addEventListener('click', () => {
      const want = b.dataset.setLang;
      // 新手教程第一步：点中任意一个（哪怕点的是当前语言）都算"已选"，立刻放行「下一步」
      if (!tourLangChosen) {
        tourLangChosen = true;
        if (!$('tour').hidden) placeTour();
      }
      if (want === lang) return;
      lang = want;
      localStorage.setItem('kx.lang', lang);
      applyLang();
      syncSettingsUI();
      log(lang === 'zh' ? '语言切换为中文' : 'Language switched to English');
    });
  });
  document.querySelectorAll('[data-set-theme]').forEach((b) => {
    b.addEventListener('click', () => {
      setTheme(b.dataset.setTheme);
      syncSettingsUI();
    });
  });
  document.querySelectorAll('[data-log-filter]').forEach((b) => {
    b.addEventListener('click', () => { logFilter = b.dataset.logFilter; syncSettingsUI(); renderLogLines(); });
  });
  $('log-copy').addEventListener('click', async () => {
    const text = logEntries.map((e) => e.t + '\t' + e.level + '\t' + e.msg).join('\r\n');
    try {
      await navigator.clipboard.writeText(text);
      log('已复制 ' + logEntries.length + ' 条日志到剪贴板');
      const btn = $('log-copy');
      const old = btn.textContent;
      btn.textContent = lang === 'en' ? 'Copied' : '已复制';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (e) { logErr(L2('复制日志失败', 'Copy log failed'), e); }
  });
  $('log-open').addEventListener('click', async () => {
    try {
      const r = await window.api.openLogFile();
      log('打开日志文件：' + (r && r.path ? r.path : '(未知路径)'));
    } catch (e) { logErr(L2('打开日志文件失败', 'Open log file failed'), e); }
  });

  // 开源许可：第三方组件声明（Apache-2.0 / MIT 要求随分发提供）
  const licOverlay = $('lic-overlay');
  $('btn-licenses').addEventListener('click', () => {
    $('lic-text').textContent = window.KX_LICENSES_TEXT || '（未找到许可文本）';
    licOverlay.hidden = false;
    const box = licOverlay.querySelector('.log-box');
    anim(licOverlay, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    anim(box, [
      { opacity: 0, transform: 'translateY(14px) scale(.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: 280, easing: EASE_OUT });
  });
  $('lic-close').addEventListener('click', () => { popOut(licOverlay.querySelector('.log-box'), () => { licOverlay.hidden = true; }); });
  licOverlay.addEventListener('click', (e) => {
    if (e.target === licOverlay) popOut(licOverlay.querySelector('.log-box'), () => { licOverlay.hidden = true; });
  });

  // ---------- 版本信息 ----------
  window.api.getEdition().then((ed) => {
    const versionEl = document.querySelector('.brand .version');
    if (versionEl && ed.version) versionEl.textContent = 'V' + (ed.displayVersion || ed.version);
    log('版本信息：v' + ed.version + (ed.store ? ' · Microsoft Store 版' : ''));
  }).catch(() => { log('版本信息获取失败'); });
  log('应用启动');

  // ---------- 中英文切换 ----------
  const I18N = {
    zh: {
      log: '日志', logTitle: '运行日志', logHint: '日志同时写入应用数据目录（可在设置里打开文件）；报错按「错误」筛选即可找到，内容含时间、等级与详细堆栈。',
      appSettings: '设置', setLang: '界面语言', setTheme: '外观', themeLight: '浅色', themeDark: '深色',
      logAll: '全部', logWarn: '警告', logError: '错误', logCopy: '复制', logOpen: '打开日志文件',
      thrDirty: '阈值已改 · 点「开始分析」重新检测后生效',
      pick: '选择照片', scan: '开始分析', pause: '暂停分析', resume: '继续分析', export: '导出合格片',
      clear: '清空', plugins: '插件', settings: '阈值',
      winMaximize: '最大化', winRestore: '向下还原', donateNav: '支持作者', donateNavSub: '请作者喝杯奶茶', sidebarFoot: '离线运行 · 照片不上传',
      donateTitle: '如果觉得 App 还不错', donateText: '支持作者一杯奶茶吧', donateSub: '你的支持会帮助我们继续优化检测和体验', donateFoot: '使用微信扫一扫即可支持',
      chipAll: '全部', chipKept: '合格', chipRejected: '废片', chipReview: '复核', chipFailed: '读取失败', chipBlur: '模糊', chipFocus: '虚焦', chipOver: '过曝', chipUnder: '欠曝', chipEye: '闭眼',
      sortLabel: '排序', sortImport: '导入顺序', sortQualityDesc: '质量从高到低', sortQualityAsc: '质量从低到高', sortName: '文件名', report: '导出报告', reportSaved: '报告已保存：{0}', reportFailed: '报告保存失败',
      overviewEyebrow: '当前批次', overviewTitle: '质量概览', overviewReady: '等待导入照片', overviewReadyToScan: '等待开始分析', overviewScanning: '正在分析…', overviewComplete: '分析完成', overviewTotal: '总照片', overviewAnalyzed: '已分析', overviewKept: '合格率', overviewScore: '平均质量', overviewIssue: '主要问题', overviewNoIssue: '暂无', noIssues: '暂无明显问题', awaitAnalysis: '等待分析', qualityHint: '质量 {0} · 清晰度 {1} · 亮度 {2}', statsSummary: '合格 {0} · 废片 {1} · 复核 {2} · 共 {3}',
thresholdReset: '恢复默认阈值', thresholdResetDone: '检测阈值已恢复默认', licensesBtn: '开源许可', licTitle: '开源许可与第三方声明',
      settingsTitle: '检测标准', lblBlur: '模糊', lblOver: '过曝', lblUnder: '欠曝', lblFocus: '虚焦', lblEye: '闭眼',
      exportLoc: '导出位置', exportPh: '留空则每次手动选择', browse: '浏览', setTour: '新手教程', tourView: '查看新手教程',
      pluginTitle: '插件', pluginTypeFeature: '功能', pluginTypeTheme: '主题', pluginTypeOther: '插件', pluginLoading: '加载中…', pluginReady: '已就绪', pluginFailed: '加载失败', eyeOffHint: '闭眼检测未开启（在「插件」里开启 RS眼部检测模型）', eyeOffShort: '闭眼检测未开启 · 可在「插件」开启', pluginLicense: '许可', pluginDisabled: '未启用', pluginOn: '已启用', pluginOff: '启用', pluginTurnOn: '点击启用', pluginTurnOff: '点击停用', pluginEmpty: '插件文件夹里还没有插件。把 .js 插件放进去后重新打开本面板即可看到。', pluginOpenFolder: '打开插件文件夹', pluginFolderHint: '插件放在用户目录下的 kuaixuan\\plugins，重启或重开本面板后生效。', confirmTitle: '确认清空', confirmText: '将清空所有照片和分析结果，确定继续吗？', cancel: '取消', confirmOk: '确认清空',
      exportDoneTitle: '导出完成', openFolder: '打开文件夹', close: '关闭',
      ctxAnalyze: '单独分析', ctxExport: '单独导出', ctxRemark: '备注', ctxRemove: '移除列表',
      ctxKeep: '标为合格', ctxReject: '标为废片', ctxReview: '放入复核',
      remarkTitle: '照片备注', remarkPh: '输入备注，显示在照片名称位置', save: '保存',
      hintTitle: '更专注于精彩的那一张', hintCta: '立即导入吧', hintSub: '支持 JPG / PNG / WEBP / TIFF · 直接把文件夹拖进来也可以 · 原片不会被修改',
      gridEmptyTitle: '这一栏里没有照片', gridEmptySub: '换个筛选看看，或者再导入一些',
      scanning: '正在扫描…', noImages: '没有找到支持的图片文件', dupPhotos: '这些照片已经在列表里了',
      readyInitial: '就绪', ready: '就绪 · 等待选择照片', analyzing: '正在分析 {0}/{1} · 剩余约 {2} 秒', paused: '已暂停 · 第 {0}/{1} 张 · 点击「继续分析」', resuming: '继续分析…'
    },
    en: {
      log: 'Log', logTitle: 'Activity Log', logHint: 'The log is also written to the app data folder (open it from Settings). Filter by "Error" to find failures; each entry has time, level and full stack.',
      appSettings: 'Settings', setLang: 'Language', setTheme: 'Appearance', themeLight: 'Light', themeDark: 'Dark',
      logAll: 'All', logWarn: 'Warnings', logError: 'Errors', logCopy: 'Copy', logOpen: 'Open log file',
      thrDirty: 'Thresholds changed · click "Start Analysis" to re-check',
      pick: 'Pick Photos', scan: 'Start Analysis', pause: 'Pause', resume: 'Resume', export: 'Export Good Ones',
      clear: 'Clear', plugins: 'Plugins', settings: 'Thresholds',
      winMaximize: 'Maximize', winRestore: 'Restore down', donateNav: 'Support the author', donateNavSub: 'Buy a milk tea', sidebarFoot: 'Offline · photos stay local',
      donateTitle: 'Enjoying the app?', donateText: 'Buy the author a milk tea', donateSub: 'Your support helps us keep improving detection and the experience', donateFoot: 'Scan with WeChat to support',
      chipAll: 'All', chipKept: 'Good', chipRejected: 'Rejected', chipReview: 'Review', chipFailed: 'Failed', chipBlur: 'Blur', chipFocus: 'OOF', chipOver: 'Over', chipUnder: 'Under', chipEye: 'Eye',
      sortLabel: 'Sort', sortImport: 'Import order', sortQualityDesc: 'Quality: high to low', sortQualityAsc: 'Quality: low to high', sortName: 'File name', report: 'Export report', reportSaved: 'Report saved: {0}', reportFailed: 'Could not save report',
      overviewEyebrow: 'CURRENT BATCH', overviewTitle: 'Quality overview', overviewReady: 'Waiting for photos', overviewReadyToScan: 'Ready to scan', overviewScanning: 'Scanning…', overviewComplete: 'Analysis complete', overviewTotal: 'Photos', overviewAnalyzed: 'Analyzed', overviewKept: 'Good rate', overviewScore: 'Avg. quality', overviewIssue: 'Top issue', overviewNoIssue: 'None', noIssues: 'No major issues', awaitAnalysis: 'Waiting for analysis', qualityHint: 'Quality {0} · Sharpness {1} · Brightness {2}', statsSummary: 'Good {0} · Rejected {1} · Review {2} · Total {3}',
thresholdReset: 'Reset thresholds', thresholdResetDone: 'Detection thresholds reset', licensesBtn: 'Licenses', licTitle: 'Open source licenses and third-party notices',
      settingsTitle: 'Levels', lblBlur: 'Blur', lblOver: 'Over', lblUnder: 'Under', lblFocus: 'Focus', lblEye: 'Eyes',
      exportLoc: 'Export Folder', exportPh: 'Leave empty to choose each time', browse: 'Browse', setTour: 'Tutorial', tourView: 'View Tutorial',
      pluginTitle: 'Plugins', pluginTypeFeature: 'Feature', pluginTypeTheme: 'Theme', pluginTypeOther: 'Plugin', pluginLoading: 'Loading…', pluginReady: 'Ready', pluginFailed: 'Failed to load', eyeOffHint: 'Closed-eye detection is off (enable "RS Eye Detection" under Plugins)', eyeOffShort: 'Closed-eye detection off · enable it under Plugins', pluginLicense: 'License', pluginDisabled: 'Off', pluginOn: 'On', pluginOff: 'Enable', pluginTurnOn: 'Click to enable', pluginTurnOff: 'Click to disable', pluginEmpty: 'No plugins yet. Drop a .js plugin into the plugins folder, then reopen this panel.', pluginOpenFolder: 'Open plugins folder', pluginFolderHint: 'Plugins live in kuaixuan\\plugins under your user folder; reopened panels pick them up.', confirmTitle: 'Confirm Clear', confirmText: 'Clear all photos and results?', cancel: 'Cancel', confirmOk: 'Clear',
      exportDoneTitle: 'Export Complete', openFolder: 'Open Folder', close: 'Close',
      ctxAnalyze: 'Analyze One', ctxExport: 'Export One', ctxRemark: 'Remark', ctxRemove: 'Remove',
      ctxKeep: 'Mark good', ctxReject: 'Mark rejected', ctxReview: 'Send to review',
      remarkTitle: 'Photo Remark', remarkPh: 'Remark shown at photo name', save: 'Save',
      hintTitle: 'Focus on the one that shines', hintCta: 'Import now', hintSub: 'JPG / PNG / WEBP / TIFF · drag a whole folder in · originals are never modified',
      gridEmptyTitle: 'Nothing in this view', gridEmptySub: 'Try another filter, or import more photos',
      scanning: 'Scanning…', noImages: 'No supported images found', dupPhotos: 'These photos are already in the list',
      readyInitial: 'Ready', ready: 'Ready · pick photos to start', analyzing: 'Analyzing {0}/{1} · ~{2}s left', paused: 'Paused · {0}/{1} · click Resume', resuming: 'Resuming…'
    }
  };
  function applyLang() {
    const t = I18N[lang] || I18N.zh;
    document.body.dataset.lang = lang;   // 供 CSS 按语言微调宽度（英文更长）
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
    // 图标按钮的提示文字也要跟着语言走
    const tipMap = { 'btn-app-settings': t.appSettings, 'btn-plugins': t.plugins, 'btn-settings': t.settings, 'btn-donate': t.donateNav, 'btn-pick': t.pick, 'btn-scan': t.scan, 'btn-export': t.export, 'btn-reset': t.clear, 'btn-licenses': t.licensesBtn, 'btn-tour': t.tourView };
    for (const [id, txt] of Object.entries(tipMap)) {
      const el = $(id);
      if (el && txt) { el.title = txt; if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', txt); }
    }
    updateSliderLabels();  // 档位标签跟随语言刷新
    try { renderPlugins(); } catch (e) { /* 插件列表未就绪时忽略 */ }
    try { syncSortUI(); } catch (e) { /* 排序控件未就绪时忽略 */ }
    try { renderLogLines(); } catch (e) { /* 日志面板未就绪时忽略 */ }
    try { syncSettingsUI(); } catch (e) { /* 设置面板未就绪时忽略 */ }
    try { if (!$('tour').hidden) placeTour(); } catch (e) { /* 教程未就绪时忽略 */ }
  }
  function t(key, ...args) {
    let txt = (I18N[lang] || I18N.zh)[key] || key;
    args.forEach((a, i) => { txt = txt.split('{' + i + '}').join(a); });
    return txt;
  }
  // ---------- 外观：浅色 / 深色（设置面板里切换，写入 localStorage） ----------
  let theme = localStorage.getItem('kx.theme') === 'dark' ? 'dark' : 'light';
  function setTheme(name) {
    theme = name === 'dark' ? 'dark' : 'light';
    document.body.dataset.theme = theme;
    localStorage.setItem('kx.theme', theme);
    log(theme === 'dark' ? '外观切换为深色模式' : '外观切换为浅色模式');
  }

  applyLang();
  syncSortUI();
  setTheme(theme);
  log(lang === 'zh' ? '语言：中文' : 'Language: English');
  log('界面初始化完成，等待选择照片');
  // 启动环境信息（供用户反馈问题时定位）：版本、运行时、系统、数据目录、日志文件、插件目录
  try {
    const p = window.api && window.api.envInfo ? window.api.envInfo() : null;
    const showInfo = (info) => {
      if (!info) { log('运行环境信息获取失败（不影响使用）', 'warn'); return; }
      log('运行环境：快调 v' + info.app + ' · Electron ' + info.electron + ' · Chromium ' + info.chrome + ' · ' + info.platform + (info.os ? ' · Windows ' + info.os : '') + (info.store ? ' · Microsoft Store 版' : ' · 独立版'));
      log('数据目录：' + info.userData);
      log('日志文件：' + info.logFile);
      log('插件目录：' + (info.pluginsDir || '(未知)'));
    };
    if (p && typeof p.then === 'function') p.then(showInfo).catch((e) => logErr(L2('读取运行环境信息失败', 'Failed to read environment info'), e));
    else showInfo(null);
  } catch (e) { logErr(L2('读取运行环境信息失败', 'Failed to read environment info'), e); }

  // 诊断接口：仅供自动化测试（electron . --face-check <目录>）与排障使用，不参与正常流程
  window.__kxDiag = {
    face: () => ({ ready: faceReady, status: faceStatus, plugin: eyePlugin ? (eyePlugin.id || eyePlugin.file) : null }),
    waitFace: (ms = 15000) => new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (faceReady || Date.now() - t0 > ms) resolve(window.__kxDiag.face());
        else setTimeout(tick, 200);
      };
      tick();
    }),
    plugins: () => plugins.map((p) => {
      const st = typeof p.status === 'function' ? p.status() : null;
      return { id: p.id || p.file, name: p.name, shown: pluginName(p), type: p.type, version: p.version, enabled: p.enabled,
               ready: !!(st && st.ready), code: (st && st.code) || null, error: p.__error || null };
    }),
    // 排障用：读取本次会话日志（含错误），便于自动化核对界面是否出过错
    logs: (n) => logEntries.slice(-(n || 40)),
    theme: () => theme,
    setTheme: (name) => { setTheme(name); syncSettingsUI(); return theme; },
    // 验收用：读当前「主题 × 主题插件」组合下的真实取色，用于核对暗色是否把主题插件压掉
    themeVars: () => {
      const cs = getComputedStyle(document.body);
      const bgOf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
      const imgOf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundImage : null; };
      const colOf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
      const pluginsOn = plugins.filter((p) => p.enabled && p.type === 'theme').map((p) => p.id || p.file);
      return {
        theme: theme, themePlugins: pluginsOn,
        accent: cs.getPropertyValue('--accent').trim(),
        accentBright: cs.getPropertyValue('--accent-bright').trim(),
        accentDeep: cs.getPropertyValue('--accent-deep').trim(),
        activeChipBg: bgOf('#filter-bar .chip.active'),
        primaryBtnBg: String(imgOf('.btn.primary')).slice(0, 60),
        tourStepColor: colOf('.tour-step')
      };
    },
    // 自动化用：无视「已看过」标记重新拉起新手引导（第一步是设置语言）
    startTour: () => { startTour(); return { hidden: $('tour').hidden, step: tourIdx + 1 }; },
    thrDirty: () => thrDirty,
    results: () => results.filter(Boolean).map(r => ({ path: r.path, kept: r.kept, manual: r.manual, review: needsReview(r), state: photoState(r),
      reasons: r.reasons.slice(), eye: (primaryMetrics(r) || {}).eye || null })),
    logPath: () => (window.api && window.api.getLogPath ? window.api.getLogPath() : null),
    // 验收/排障用：本次会话内临时启用某插件（不写入用户设置，避免影响用户选择）
    enablePlugin: async (id) => {
      const p = plugins.find((x) => (x.id || x.file) === id || x.file === id + '.js');
      if (!p) return { ok: false, error: '未找到插件 ' + id, plugins: window.__kxDiag.plugins() };
      p.enabled = true;
      p.__error = null;
      if (typeof p.init === 'function') {
        try { await p.init(pluginCtx()); } catch (err) { p.__error = String((err && err.message) || err); logErr(L2('插件「' + pluginName(p) + '」启动失败', 'Plugin "' + pluginName(p) + '" failed to start'), err); }
      }
      syncEyePluginStatus();
      renderPlugins();
      applyTheme();   // 主题类插件靠它注入 / 撤下 css（真实开关路径 app.js:1461 同样会调）
      return { ok: faceReady, face: window.__kxDiag.face(), plugins: window.__kxDiag.plugins() };
    },
    // 验收/排障用：本次会话内临时停用某插件（不改用户设置）
    disablePlugin: (id) => {
      const p = plugins.find((x) => (x.id || x.file) === id || x.file === id + '.js');
      if (p) {
        p.enabled = false;
        if (typeof p.dispose === 'function') { try { p.dispose(); } catch (e) { /* 忽略 */ } }
        syncEyePluginStatus();
        renderPlugins();
        applyTheme();
      }
      return window.__kxDiag.plugins();
    },
    // 验收/排障用：走真实导入路径添加照片（等价于拖入文件夹）
    addPhotos: async (paths) => { await addPhotos(paths); return { files: files.length }; },
    // 验收/排障用：走真实分析路径，回报质量分与各项严重程度（用于核对评分是否合理）
    analyze: async (filePath) => {
      const res = await analyzeOne({ path: filePath, name: nameOf(filePath) });
      if (!res) return null;
      return res.all.map((m) => ({
        score: m.qualityScore,
        issues: (m.issues || []).map((i) => i.reason + ':' + (i.severity || 0).toFixed(2)),
        blurScore: Math.round(m.blurScore || 0),
        avgLuma: +(m.avgLuma || 0).toFixed(1),
        over: +(m.overRatio * 100 || 0).toFixed(1),
        under: +(m.underRatio * 100 || 0).toFixed(1)
      }));
    },
    probe: async (filePath) => {
      const img = new Image();
      img.src = await window.api.toFileUrl(filePath);
      await img.decode();
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const F = 1024;
      const r = Math.min(1, F / Math.max(nw, nh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(nw * r));
      c.height = Math.max(1, Math.round(nh * r));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const thr = getThresholds();
      const eye = await eyeScore(c, null, img);
      img.src = '';
      return {
        file: filePath,
        size: nw + 'x' + nh,
        canvas: c.width + 'x' + c.height,
        threshold: thr.eye,
        eye: eye,
        eyeClosed: window.EyeDetector.isClosed(eye, thr.eye),
        eyeState: window.EyeDetector.decision(eye, thr.eye),
        faceStatus: faceStatus
      };
    }
  };

  // 启动：加载插件
  // 概览卡片也做悬浮微交互 + 入场动画
  document.querySelectorAll('.overview-card').forEach((el, i) => { attachHoverLift(el); popIn(el, i * 40); });
  loadPlugins();
})();
