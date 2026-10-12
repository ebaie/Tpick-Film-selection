/*
 * 快调选片 · 功能插件：RS 眼部检测模型
 * ---------------------------------------------------------------------------
 * 声明（manifest）
 *   id          eye-smart
 *   name        RS眼部检测模型
 *   version     1.4
 *   type        feature（在检测阶段执行，可标记新的废片类型）
 *   entry       analyze(canvas, metrics, ctx) → { reason, label, fire, detail }
 *   author      快调选片
 *   license     插件代码：随快调选片分发；模型：OCEC 为 MIT（© 2025 Katsuya Hyodo），
 *               MediaPipe Face Landmarker 为 Apache-2.0。许可正文见应用内「开源许可」。
 *   source      https://github.com/google-ai-edge/mediapipe  （MediaPipe，Apache-2.0）
 *               https://github.com/PINTO0309/OCEC            （OCEC 单眼分类，MIT）
 *   requires    MediaPipe Tasks Vision 运行时（renderer/vendor/mediapipe/）、
 *               lib/eye-detector.js、models/face_landmarker.task、models/ocec_s_*、models/eye_ensemble_6f.json
 *   cost        按人脸数和精定位次数增加耗时（本地 CPU，无网络请求）
 *
 * 判定口径
 *   只有"双眼都可见地闭合"才算闭眼；单眼眨眼不标记双眼闭合，遮挡与分歧留待复核。
 *
 * 检测链
 *   MediaPipe Face Landmarker（478 点网格 + 52 表情系数）
 *     → 双眼开合度 + eyeBlinkLeft/Right
 *     → 按眼位裁左右眼（三档余量 1.5/1.7/2.0 投票，抗关键点定位误差）
 *     → OCEC 单眼开闭分类器（纯 JS 推理，权重数值未改动）
 *     → 像素坐标开合度 + 旋转校正眼框 → 6 维单调回归 →「双眼闭合」概率
 *     → 原图眼框与小脸精定位；最多 8 张人脸逐一判断
 *     → 逐眼闭合证据与睁眼保护；小眼睛、越界和信号冲突返回需复核
 */
(function () {
  'use strict';

  var EW = 40, EH = 24;                         // OCEC 输入尺寸（宽x高）
  var PADS = [1.5, 1.7, 2.0];                   // 眼框余量：多档投票
  var MAX_FACES = 8;
  var detector = null;

  var landmarker = null;
  var net = null;
  var model = null;
  var eyeCanvas = null, eyeCtx = null;
  // state.code 供界面本地化显示（idle / loading / ready / error）
  var state = { ready: false, code: 'idle', status: '', error: null };
  var initTask = null;

  function log(ctx, msg) { if (ctx && typeof ctx.log === 'function') ctx.log(msg); }

  function cropEye(canvas, box) {
    if (!eyeCanvas) {
      eyeCanvas = document.createElement('canvas');
      eyeCanvas.width = EW; eyeCanvas.height = EH;
      eyeCtx = eyeCanvas.getContext('2d', { willReadFrequently: true });
    }
    eyeCtx.resetTransform();
    eyeCtx.clearRect(0, 0, EW, EH);
    eyeCtx.translate(EW / 2, EH / 2);
    eyeCtx.scale(EW / box.w, EH / box.h);
    eyeCtx.rotate(-box.angle);
    eyeCtx.drawImage(canvas, -box.cx, -box.cy);
    eyeCtx.resetTransform();
    var d = eyeCtx.getImageData(0, 0, EW, EH).data;
    var HW = EW * EH;
    var out = new Float32Array(3 * HW);
    for (var i = 0, p = 0; i < HW; i++, p += 4) {
      out[i] = d[p] / 255;
      out[HW + i] = d[p + 1] / 255;
      out[2 * HW + i] = d[p + 2] / 255;
    }
    return out;
  }

  function load(url, binary) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('眼部模型加载失败：' + url + ' (' + r.status + ')');
      return binary ? r.arrayBuffer() : r.text();
    });
  }

  // 启用（或启动时已启用）后调用：加载运行时、模型与融合权重
  function init(ctx) {
    if (state.ready) return Promise.resolve(state);
    if (initTask) return initTask;
    state.code = 'loading';
    state.error = null;
    initTask = Promise.resolve()
      .then(function () {
        detector = window.EyeDetector;
        if (!detector) throw new Error('缺少眼部检测计算库（lib/eye-detector.js）');
        if (typeof window.__kxLoadMediaPipe !== 'function') throw new Error('缺少 MediaPipe 引导脚本（mp-boot.js）');
        return window.__kxLoadMediaPipe();
      })
      .then(function (vision) {
        return vision.FilesetResolver.forVisionTasks('vendor/mediapipe').then(function (fileset) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: 'model://local/face_landmarker.task', delegate: 'CPU' },
            runningMode: 'IMAGE',
            numFaces: MAX_FACES,
            outputFaceBlendshapes: true,
            minFaceDetectionConfidence: 0.3
          });
        });
      })
      .then(function (lm) {
        landmarker = lm;
        return Promise.all([
          load('model://local/ocec_s_graph.json'),
          load('model://local/ocec_s_weights.bin', true),
          load('model://local/eye_ensemble_6f.json')
        ]);
      })
      .then(function (res) {
        if (typeof window.OcecNet !== 'function') throw new Error('缺少 OCEC 推理器（renderer/ocec.js）');
        net = window.OcecNet.fromBuffers(res[0], res[1]);
        model = detector.validateModel(JSON.parse(res[2]));
        state.ready = true;
        state.code = 'ready';
        log(ctx, 'RS 插件 v1.4：模型就绪（原图眼框 + 多人检测 + 小脸精定位 + 双眼证据复核）');
        return state;
      })
      .catch(function (err) {
        try { if (landmarker) landmarker.close(); } catch (_) {}
        landmarker = null;
        state.ready = false;
        state.error = String((err && err.message) || err);
        state.code = 'error';
        log(ctx, '闭眼插件加载失败：' + state.error);
        throw err;
      }).finally(function () { initTask = null; });
    return initTask;
  }

  function dispose() {
    try { if (landmarker && typeof landmarker.close === 'function') landmarker.close(); } catch (e) {}
    landmarker = null;
    net = null;
    model = null;
    eyeCanvas = null;
    eyeCtx = null;
    state.ready = false;
    state.code = 'idle';
  }

  function refineFace(source, lms, cats, width, height, previewWidth, previewHeight) {
    var left = detector.geometry(lms, previewWidth, previewHeight, 'L');
    var right = detector.geometry(lms, previewWidth, previewHeight, 'R');
    if (!left || !right) {
      return { lms: lms, cats: cats, refined: false };
    }
    var region = detector.faceRegion(lms, width, height);
    if (!region) return { lms: lms, cats: cats, refined: false };
    if (region.w >= width * 0.85 && region.h >= height * 0.85 && Math.min(left.span, right.span) >= 24) {
      return { lms: lms, cats: cats, refined: false };
    }
    var roi = document.createElement('canvas');
    var scale = Math.min(1, 640 / Math.max(region.w, region.h));
    roi.width = Math.max(1, Math.round(region.w * scale));
    roi.height = Math.max(1, Math.round(region.h * scale));
    roi.getContext('2d').drawImage(source, region.x, region.y, region.w, region.h, 0, 0, roi.width, roi.height);
    try {
      var refined = landmarker.detect(roi);
      var candidates = refined.faceLandmarks || [];
      // Do not switch to a neighbouring person inside the expanded crop.
      var center = function (mesh) {
        if (!mesh.length || mesh.some(function (point) { return !Number.isFinite(point.x) || !Number.isFinite(point.y); })) return null;
        var xs = mesh.map(function (point) { return point.x; }), ys = mesh.map(function (point) { return point.y; });
        return { x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 };
      };
      var originalBox = detector.faceRegion(lms, width, height);
      var target = { x: (originalBox.x + originalBox.w / 2 - region.x) / region.w, y: (originalBox.y + originalBox.h / 2 - region.y) / region.h };
      var best = -1, distance = Infinity;
      candidates.forEach(function (mesh, index) {
        var point = center(mesh);
        var delta = point ? Math.hypot(point.x - target.x, point.y - target.y) : Infinity;
        if (delta < distance) { distance = delta; best = index; }
      });
      if (best < 0 || distance > 0.2) return { lms: lms, cats: cats, refined: false };
      return {
        lms: candidates[best].map(function (point) { return { x: (region.x + point.x * region.w) / width, y: (region.y + point.y * region.h) / height }; }),
        cats: refined.faceBlendshapes && refined.faceBlendshapes[best] ? refined.faceBlendshapes[best].categories : [],
        refined: true
      };
    } finally { roi.width = roi.height = 1; }
  }

  // 原图只用于眼框采样，不创建整张高分辨率画布。
  function analyze(canvas, metrics, ctx) {
    if (!state.ready || !landmarker || !net || !model) return Promise.resolve({ reason: 'eye', label: '闭眼', fire: false, detail: { p: null, reliable: false, status: 'unavailable' } });
    return Promise.resolve().then(function () {
      var res = landmarker.detect(canvas);
      var value = (ctx && typeof ctx.thresholds === 'function') ? ctx.thresholds().eye : model.threshold;
      var thr = Number.isFinite(value) && value > 0 && value < 1 ? value : model.threshold;
      function uncertain(status, extras) {
        return { reason: 'eye', label: '闭眼', fire: false,
          detail: Object.assign({ p: null, threshold: thr, reliable: false, status: status }, extras) };
      }
      var meshes = res && res.faceLandmarks || [];
      if (!meshes.length) return uncertain('no-face');
      var source = ctx && ctx.eyeSource || canvas;
      var W = source.naturalWidth || source.width, H = source.naturalHeight || source.height;
      function analyzeFace(lms, cats) {
        var refinement = refineFace(source, lms, cats, W, H, canvas.width, canvas.height);
        lms = refinement.lms; cats = refinement.cats;
        var blinkL = null, blinkR = null;
        for (var i = 0; i < cats.length; i++) {
          // Mesh 33/133 is the person's RIGHT eye; 263/362 is their LEFT eye.
          // Our L/R identifiers refer to the image side, so pair the blink names accordingly.
          if (cats[i].categoryName === 'eyeBlinkLeft') blinkR = cats[i].score;
          else if (cats[i].categoryName === 'eyeBlinkRight') blinkL = cats[i].score;
        }
        var eyes = { L: detector.geometry(lms, W, H, 'L'), R: detector.geometry(lms, W, H, 'R') };
        var blink = { L: blinkL, R: blinkR };
        if (!Number.isFinite(blinkL) || !Number.isFinite(blinkR) || !eyes.L || !eyes.R) return uncertain('missing-landmarks');
        if (!eyes.L.inFrame || !eyes.R.inFrame) return uncertain('out-of-frame');
        if (Math.min(eyes.L.span, eyes.R.span) < 10) return uncertain('small-eyes');
        if (Math.min(eyes.L.span, eyes.R.span) / Math.max(eyes.L.span, eyes.R.span) < 0.25) return uncertain('side-face');
        var open = { L: eyes.L.openness, R: eyes.R.openness };
        var votes = { L: [], R: [] };
        for (var side of ['L', 'R']) {
          for (var pad of PADS) {
            var box = detector.cropBox(eyes[side], W, H, pad);
            if (!box.inFrame) continue;
            var probOpen = net.run(cropEye(source, box));
            if (!Number.isFinite(probOpen) || probOpen < 0 || probOpen > 1) return uncertain('invalid-model-output');
            votes[side].push(probOpen);
          }
          if (votes[side].length < 2) return uncertain('out-of-frame');
        }
        var mean = function (v) { return v.reduce(function (a, b) { return a + b; }, 0) / v.length; };
        var ocec = { L: mean(votes.L), R: mean(votes.R) };
        var feat = detector.features(blink, open, ocec);
        var p = detector.predict(feat, model);
        var eligible = !detector.clearlyOpen(blink, open, votes);
        var evidence = { L: detector.eyeEvidence(blink.L, open.L, votes.L), R: detector.eyeEvidence(blink.R, open.R, votes.R) };
        var detail = { p: p, threshold: thr, reliable: Number.isFinite(p), bothClosedEligible: eligible,
          closedSupported: evidence.L.closed && evidence.R.closed, evidence: evidence, refined: refinement.refined,
          status: 'unmarked', blink: blink, openness: open, ocec: ocec, votes: votes, feat: feat,
          eyePixels: { L: eyes.L.span, R: eyes.R.span }, model: model.version };
        detail.status = detector.decision(detail, thr);
        return { reason: 'eye', label: '闭眼', fire: detector.isClosed(detail, thr), detail: detail };
      }
      var faces = meshes.map(function (mesh, index) {
        var cats = res.faceBlendshapes && res.faceBlendshapes[index] ? res.faceBlendshapes[index].categories : [];
        try { return Object.assign({ faceIndex: index }, analyzeFace(mesh, cats).detail); }
        catch (error) { return { faceIndex: index, p: null, reliable: false, status: 'detector-error', error: String(error.message || error) }; }
      });
      var selected = faces.reduce(function (best, face) {
        var faceClosed = detector.isClosed(face, thr), bestClosed = detector.isClosed(best, thr);
        return faceClosed && !bestClosed || faceClosed === bestClosed && (face.p || 0) > (best.p || 0) ? face : best;
      }, faces[0]);
      var detail = Object.assign({}, selected, { faces: faces, faceCount: faces.length, faceLimitReached: faces.length >= MAX_FACES, threshold: thr });
      detail.status = detector.decision(detail, thr);
      return { reason: 'eye', label: '闭眼', fire: detector.isClosed(detail, thr), detail: detail };
    });
  }

  window.__KX_PLUGIN = {
    id: 'eye-smart',
    name: 'RS眼部检测模型',
    name_en: 'RS Eye Detection',
    version: '1.4',
    type: 'feature',
    license: 'OCEC 模型 MIT（© 2025 Katsuya Hyodo）· MediaPipe Apache-2.0',
    license_en: 'OCEC model MIT (© 2025 Katsuya Hyodo) · MediaPipe Apache-2.0',
    cost: '按人脸数与精定位次数增加耗时',
    cost_en: 'Time varies with face count and refinement',
    description: '从原图裁眼框，小脸二次定位，最多检查 8 张人脸。逐只眼结合开合度、眨眼系数和多档眼框投票；仅在双眼都有闭合证据时标记闭眼。看不清、投票分歧和信号冲突进入复核；完全离线。',
    description_en: 'Samples eyes from the original image, refines small faces and checks up to 8 faces. Requires evidence from both eyes to flag closure; ambiguous crops, conflicting signals and unclear faces need review. Runs entirely offline.',
    // 开源地址：界面里可点击打开
    links: [
      { label: 'MediaPipe（Apache-2.0）', label_en: 'MediaPipe (Apache-2.0)', url: 'https://github.com/google-ai-edge/mediapipe' },
      { label: 'OCEC 单眼分类（MIT）', label_en: 'OCEC single-eye (MIT)', url: 'https://github.com/PINTO0309/OCEC' },
      { label: '许可与出处说明', label_en: 'License & attribution', url: 'https://github.com/ebaie/Tpick-Film-selection/blob/main/licenses/THIRD-PARTY-NOTICES.md' }
    ],
    init: init,
    analyze: analyze,
    dispose: dispose,
    status: function () { return { ready: state.ready, code: state.code, error: state.error }; }
  };
})();
