/* RS eye geometry and closure decisions. OCEC returns OPEN, fusion returns CLOSED. */
(function (root) {
  'use strict';
  const INDICES = {
    L: [33, 133, 159, 145, 160, 144, 158, 153],
    R: [263, 362, 386, 374, 387, 373, 385, 380]
  };
  const FEATURE_NAMES = ['minBlink', 'maxBlink', 'minOpenness', 'maxOpenness', 'ocecMaxOpen', 'ocecMinOpen'];

  function geometry(landmarks, width, height, side) {
    if (!(width > 0 && height > 0) || !INDICES[side]) return null;
    const points = INDICES[side].map(i => landmarks && landmarks[i]);
    if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    const pixels = points.map(p => ({ x: p.x * width, y: p.y * height }));
    const [a, b, upper, lower] = pixels;
    const dx = b.x - a.x, dy = b.y - a.y;
    const span = Math.hypot(dx, dy);
    if (span < 1e-6) return null;
    // Measure perpendicular to the eye axis, in pixels: invariant to aspect ratio and roll.
    const gaps = [];
    for (let i = 2; i < pixels.length; i += 2) {
      gaps.push(Math.abs((pixels[i + 1].x - pixels[i].x) * -dy + (pixels[i + 1].y - pixels[i].y) * dx) / (span * span));
    }
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    return {
      span, angle,
      cx: (a.x + b.x) / 2,
      cy: ((a.y + b.y) / 2 + (upper.y + lower.y) / 2) / 2,
      openness: gaps.sort((x, y) => x - y)[1],
      inFrame: pixels.every(p => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height)
    };
  }

  function cropBox(eye, width, height, pad) {
    const w = eye.span * pad, h = w * 24 / 40;
    const cos = Math.cos(eye.angle), sin = Math.sin(eye.angle);
    const rx = (Math.abs(cos) * w + Math.abs(sin) * h) / 2;
    const ry = (Math.abs(sin) * w + Math.abs(cos) * h) / 2;
    return { ...eye, w, h, inFrame: eye.cx - rx >= 0 && eye.cx + rx <= width && eye.cy - ry >= 0 && eye.cy + ry <= height };
  }

  function features(blink, openness, ocec) {
    const values = [blink.L, blink.R, openness.L, openness.R, ocec.L, ocec.R];
    if (values.some(v => !Number.isFinite(v))) return null;
    return [Math.min(blink.L, blink.R), Math.max(blink.L, blink.R),
      Math.min(openness.L, openness.R), Math.max(openness.L, openness.R),
      Math.max(ocec.L, ocec.R), Math.min(ocec.L, ocec.R)];
  }

  function validateModel(model) {
    if (!model || !Array.isArray(model.features) || model.features.join('|') !== FEATURE_NAMES.join('|') ||
      !Number.isFinite(model.intercept) || !Number.isFinite(model.threshold) || model.threshold <= 0 || model.threshold >= 1 ||
      ['mean', 'std', 'coef'].some(key => !Array.isArray(model[key]) || model[key].length !== 6 || model[key].some(v => !Number.isFinite(v))) ||
      model.std.some(v => v <= 0) || model.coef.slice(0, 2).some(v => v < 0) || model.coef.slice(2).some(v => v > 0)) {
      throw new Error('眼部融合模型的特征顺序或权重无效');
    }
    return model;
  }

  function predict(feat, model) {
    if (!feat || feat.length !== 6 || feat.some(v => !Number.isFinite(v))) return null;
    const z = model.intercept + feat.reduce((sum, value, i) => sum + model.coef[i] * (value - model.mean[i]) / model.std[i], 0);
    return 1 / (1 + Math.exp(-z));
  }

  function clearlyOpen(blink, openness, votes) {
    return ['L', 'R'].some(side => eyeEvidence(blink[side], openness[side], votes[side]).open);
  }

  function eyeEvidence(blink, openness, votes) {
    if (!Number.isFinite(blink) || !Number.isFinite(openness) || !Array.isArray(votes) ||
      votes.length < 2 || votes.some(p => !Number.isFinite(p) || p < 0 || p > 1)) {
      return { open: false, closed: false, unstable: true };
    }
    const mean = votes.reduce((sum, p) => sum + p, 0) / votes.length;
    const unstable = Math.max(...votes) - Math.min(...votes) > 0.5;
    const visualOpen = !unstable && mean >= 0.85 && votes.filter(p => p >= 0.85).length >= 2;
    const visualClosed = !unstable && mean <= 0.35 && votes.filter(p => p <= 0.35).length >= 2;
    // Keep signals paired by eye: min/max fusion alone can confuse a wink with two closed eyes.
    const openSignals = Number(blink <= 0.1) + Number(openness >= 0.24) + Number(visualOpen);
    const closedSignals = Number(blink >= 0.35) + Number(openness <= 0.16) + Number(visualClosed);
    // A visible eyelid gap takes priority over two learned scores agreeing on closure.
    // When geometry is inconclusive, require stronger agreement before calling this eye closed.
    const softClosed = openness <= 0.27 && blink >= 0.2 && mean <= 0.25;
    const closed = openness <= 0.16 && (blink >= 0.35 || visualClosed) ||
      blink >= 0.65 && visualClosed || softClosed;
    return { open: openSignals >= 2, closed, unstable, mean, openSignals, closedSignals };
  }

  function faceRegion(landmarks, width, height) {
    if (!Array.isArray(landmarks) || !landmarks.length || !(width > 0 && height > 0)) return null;
    if (landmarks.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    const xs = landmarks.map(p => p.x * width), ys = landmarks.map(p => p.y * height);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = Math.max(maxX - minX, maxY - minY) * 0.2;
    const x = Math.max(0, Math.floor(minX - pad)), y = Math.max(0, Math.floor(minY - pad));
    const w = Math.min(width, Math.ceil(maxX + pad)) - x, h = Math.min(height, Math.ceil(maxY + pad)) - y;
    return w >= 16 && h >= 16 ? { x, y, w, h } : null;
  }

  function isClosed(detail, threshold) {
    if (detail && Array.isArray(detail.faces)) return detail.faces.some(face => isClosed(face, threshold));
    return !!(detail && detail.reliable !== false && detail.bothClosedEligible !== false &&
      detail.closedSupported !== false && Number.isFinite(detail.p) && Number.isFinite(threshold) &&
      (detail.p >= threshold || (detail.closedSupported && detail.p >= Math.max(0.65, threshold - 0.12))));
  }

  function decision(detail, threshold) {
    if (!detail) return 'off';
    if (Array.isArray(detail.faces)) {
      const states = detail.faces.map(face => decision(face, threshold));
      if (states.includes('closed')) return 'closed';
      if (detail.faceLimitReached || states.some(state => state !== 'open')) return 'review';
      return states.length ? 'open' : 'no-face';
    }
    if (detail.reliable === false || !Number.isFinite(detail.p)) return detail.status || 'unknown';
    if (detail.bothClosedEligible === false && detail.p >= threshold) return 'conflict';
    if (isClosed(detail, threshold)) return 'closed';
    if (detail.closedSupported === false && detail.p >= threshold) return 'conflict';
    if (detail.evidence) {
      if (['L', 'R'].some(side => detail.evidence[side].closed || detail.evidence[side].unstable)) return 'review';
      return detail.bothClosedEligible === false ? 'open' : 'review';
    }
    return detail.p <= 0.2 ? 'open' : 'review';
  }

  const api = { geometry, cropBox, features, validateModel, predict, clearlyOpen, eyeEvidence, faceRegion, isClosed, decision };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EyeDetector = api;
})(typeof window !== 'undefined' ? window : globalThis);
