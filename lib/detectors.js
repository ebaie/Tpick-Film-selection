// 图像质量检测算法（纯 JS，无外部依赖）
// 在渲染进程运行，输入 ImageData，输出各项指标。

const Detectors = (() => {
  const GRID = 4;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

  // 一次读取 RGB，缓存灰度并统计曝光。保留旧阈值以兼容现有检测标准。
  function scanImage(imageData) {
    const w = imageData && imageData.width;
    const h = imageData && imageData.height;
    const data = imageData && imageData.data;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        !data || data.length < w * h * 4) {
      return { gray: new Float32Array(0), width: 0, height: 0, total: 0,
        histogram: new Uint32Array(256), overRatio: 0, underRatio: 0,
        avgLuma: 0, contrast: 0, clippedHighlights: 0, clippedShadows: 0 };
    }
    const total = w * h;
    const gray = new Float32Array(total);
    const histogram = new Uint32Array(256);
    let over = 0, under = 0, highlights = 0, shadows = 0, sum = 0, sumSq = 0;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[i] = l;
      histogram[Math.round(l)]++;
      sum += l;
      sumSq += l * l;
      if (l > 250) over++;
      else if (l < 25) under++;
      // 单个颜色通道溢出也会丢失细节；纯黑必须三通道同时接近零。
      if (Math.max(r, g, b) >= 250) highlights++;
      if (Math.max(r, g, b) <= 5) shadows++;
    }
    const avgLuma = sum / total;
    return { gray, width: w, height: h, total, histogram,
      overRatio: over / total, underRatio: under / total, avgLuma,
      contrast: Math.sqrt(Math.max(0, sumSq / total - avgLuma * avgLuma)),
      clippedHighlights: highlights / total, clippedShadows: shadows / total };
  }

  function percentile(histogram, total, fraction) {
    if (!total) return 0;
    const target = Math.max(1, Math.ceil(total * fraction));
    let seen = 0;
    for (let i = 0; i < histogram.length; i++) {
      seen += histogram[i];
      if (seen >= target) return i;
    }
    return 255;
  }

  function variance(sum, sumSq, count) {
    if (!count) return 0;
    const mean = sum / count;
    return Math.max(0, sumSq / count - mean * mean);
  }

  // 灰度只生成一次；同一拉普拉斯值同时参与全图和分区统计。
  // 分区按比例切分，包含不足 4 整除的尾部像素；小块没有内部像素时为 0。
  function sharpnessStats(gray, w, h) {
    const sums = new Float64Array(GRID * GRID);
    const sumSqs = new Float64Array(GRID * GRID);
    const counts = new Uint32Array(GRID * GRID);
    const xBounds = Array.from({ length: GRID + 1 }, (_, i) => Math.floor(i * w / GRID));
    const yBounds = Array.from({ length: GRID + 1 }, (_, i) => Math.floor(i * h / GRID));
    const colOf = new Uint8Array(w), rowOf = new Uint8Array(h);
    for (let c = 0; c < GRID; c++) colOf.fill(c, xBounds[c], xBounds[c + 1]);
    for (let r = 0; r < GRID; r++) rowOf.fill(r, yBounds[r], yBounds[r + 1]);
    let sum = 0, sumSq = 0, n = 0, edges = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w, ry = rowOf[y];
      for (let x = 1; x < w - 1; x++) {
        const i = row + x, rx = colOf[x];
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += v;
        sumSq += v * v;
        n++;
        // 保持原分区算法不跨块采样，同时让最后一块覆盖尾部余数。
        if (x > xBounds[rx] && x < xBounds[rx + 1] - 1 &&
            y > yBounds[ry] && y < yBounds[ry + 1] - 1) {
          const block = ry * GRID + rx;
          sums[block] += v;
          sumSqs[block] += v * v;
          counts[block]++;
        }
        const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
        const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
        if (Math.hypot(gx, gy) / 4 > 16) edges++;
      }
    }
    return { blurScore: variance(sum, sumSq, n),
      blurBlocks: Array.from(sums, (s, i) => variance(s, sumSqs[i], counts[i])),
      edgeDensity: n ? edges / n : 0 };
  }

  // 综合分析：亮度、灰度直方图、锐度和分区统计共用同一份像素缓存。
  // contrast/p01/p99 单位为 0–255 亮度；比例和 detailConfidence 范围为 0–1。
  function analyze(imageData) {
    const image = scanImage(imageData);
    const sharpness = sharpnessStats(image.gray, image.width, image.height);
    const p01 = percentile(image.histogram, image.total, 0.01);
    const p99 = percentile(image.histogram, image.total, 0.99);
    return { ...sharpness,
      overRatio: image.overRatio, underRatio: image.underRatio, avgLuma: image.avgLuma,
      contrast: image.contrast, p01, p99,
      clippedHighlights: image.clippedHighlights, clippedShadows: image.clippedShadows,
      // 低纹理或低对比度图像的锐度判断可信度较低，此值用于提示而非判废。
      detailConfidence: clamp((p99 - p01) / 80) * clamp(Math.sqrt(sharpness.edgeDensity / 0.08)) };
  }

  // 原 API 继续可用；批量检测应直接调用 analyze，避免重复扫描同一张图。
  function laplacianVariance(imageData) { return analyze(imageData).blurScore; }
  function regionBlurVars(imageData) { return analyze(imageData).blurBlocks; }
  function exposureStats(imageData) {
    const { overRatio, underRatio, avgLuma } = scanImage(imageData);
    return { overRatio, underRatio, avgLuma };
  }

  // 质量分仅供同批照片排序/人工复核，不能替代主体、构图或自动检测结论。
  function qualityScore(metrics) {
    if (!metrics) return 0;
    const finite = (key, fallback = 0) => Number.isFinite(metrics[key]) ? metrics[key] : fallback;
    const sharp = clamp(Math.log1p(Math.max(0, finite('blurScore'))) / Math.log1p(2000));
    const contrast = clamp(finite('contrast') / 48);
    const luma = finite('avgLuma');
    const exposure = clamp(1 - Math.max((75 - luma) / 75, (luma - 205) / 50, 0));
    const clipping = clamp(finite('clippedHighlights') + finite('clippedShadows'));
    const detail = clamp(finite('detailConfidence', contrast));
    const score = (0.62 * sharp + 0.20 * contrast + 0.18 * exposure) *
      (0.5 + 0.5 * detail) * (1 - 0.45 * clipping);
    return Math.round(clamp(score) * 100);
  }

  return { analyze, qualityScore, laplacianVariance, exposureStats, regionBlurVars };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Detectors;
}
