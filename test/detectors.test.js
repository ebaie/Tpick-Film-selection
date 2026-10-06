// 检测算法单元测试（Node 直接运行：node test/detectors.test.js）
const D = require('../lib/detectors.js');

function img(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name, detail || ''); }
  else { fail++; console.log('  ❌', name, detail || ''); }
}

console.log('== 模糊检测（拉普拉斯方差）==');
const sharp = img(256, 256, (x, y) => (((x >> 2) ^ (y >> 2)) & 1) ? 255 : 0); // 棋盘格=高频
const blur = img(256, 256, () => 128);                                        // 纯色=无细节
let noiseState = 12345;
const noise = img(256, 256, () => {                                         // 确定性噪声，避免测试随机波动
  noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
  return (noiseState >>> 24);
});
const s1 = D.laplacianVariance(sharp);
const s2 = D.laplacianVariance(blur);
const s3 = D.laplacianVariance(noise);
console.log('   棋盘格方差 =', s1.toFixed(1));
console.log('   纯色方差   =', s2.toFixed(1));
console.log('   噪声方差   =', s3.toFixed(1));
check('清晰(棋盘格) 方差显著高于 纯色', s1 > s2 * 50);
check('噪声 方差最高', s3 > s1);
check('纯色 方差≈0', s2 < 1);

console.log('== 曝光检测 ==');
const over = img(256, 256, () => 252);
const under = img(256, 256, () => 10);
const normal = img(256, 256, () => 128);
const eo = D.exposureStats(over);
const eu = D.exposureStats(under);
const en = D.exposureStats(normal);
console.log('   过曝图:', JSON.stringify(eo));
console.log('   欠曝图:', JSON.stringify(eu));
console.log('   正常图:', JSON.stringify(en));
check('过曝图 overRatio 高', eo.overRatio > 0.9);
check('欠曝图 underRatio 高', eu.underRatio > 0.9);
check('正常图 两比例都低', en.overRatio < 0.01 && en.underRatio < 0.01);
check('正常图 平均亮度≈128', Math.abs(en.avgLuma - 128) < 10);

console.log('== 合并检测与兼容 API ==');
const detailed = D.analyze(sharp);
const numberKeys = ['blurScore', 'overRatio', 'underRatio', 'avgLuma', 'contrast',
  'p01', 'p99', 'clippedHighlights', 'clippedShadows', 'edgeDensity', 'detailConfidence'];
check('新增指标均为有限数值', numberKeys.every((key) => Number.isFinite(detailed[key])));
check('旧拉普拉斯 API 与合并结果一致', detailed.blurScore === s1);
check('旧曝光 API 与合并结果一致', ['overRatio', 'underRatio', 'avgLuma'].every((key) =>
  detailed[key] === D.exposureStats(sharp)[key]));
check('旧分区 API 与合并结果一致', JSON.stringify(detailed.blurBlocks) === JSON.stringify(D.regionBlurVars(sharp)));
check('正常纯色对比度接近 0 且百分位一致', D.analyze(normal).contrast < 0.001 &&
  D.analyze(normal).p01 === 128 && D.analyze(normal).p99 === 128);
const gradient = D.analyze(img(256, 32, (x) => x));
check('亮度渐变有正确的百分位和对比度', gradient.p01 === 2 && gradient.p99 === 253 &&
  gradient.contrast > 70 && gradient.contrast < 75);
check('有纹理样本边缘密度和可信度高于纯色', detailed.edgeDensity > D.analyze(normal).edgeDensity &&
  detailed.detailConfidence > D.analyze(normal).detailConfidence);

console.log('== RGB 裁剪与小图边界 ==');
const redClip = img(32, 32, () => 0);
for (let p = 0; p < redClip.data.length; p += 4) redClip.data[p] = 255;
const redMetrics = D.analyze(redClip);
check('单通道高光裁剪可检出，保留原亮度曝光语义', redMetrics.clippedHighlights === 1 &&
  redMetrics.overRatio === 0 && redMetrics.avgLuma > 75 && redMetrics.avgLuma < 77);
check('纯白和纯黑裁剪正确', D.analyze(img(16, 16, () => 255)).clippedHighlights === 1 &&
  D.analyze(img(16, 16, () => 0)).clippedShadows === 1);
for (const [w, h] of [[1, 1], [2, 3], [3, 2], [4, 4], [5, 7]]) {
  const m = D.analyze(img(w, h, (x, y) => (x + y) * 20));
  check(`${w}x${h} 固定 16 分区且无非法数值`, m.blurBlocks.length === 16 &&
    m.blurBlocks.every(Number.isFinite) && numberKeys.every((key) => Number.isFinite(m[key])));
}
const empty = D.analyze({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
check('空图安全返回零值', empty.blurBlocks.length === 16 && empty.blurBlocks.every((v) => v === 0) &&
  numberKeys.every((key) => empty[key] === 0));
// 21x21 的最后一个分区包含余数；其内部边缘必须参与检测。
const tail = D.analyze(img(21, 21, (x, y) => x === 19 && y === 19 ? 255 : 128));
check('最后分区覆盖不能整除的尾部像素', tail.blurBlocks[15] > 0 && tail.blurBlocks.slice(0, 15).every((v) => v === 0));

console.log('== 质量参考分排序 ==');
const cleanSharp = D.analyze(img(128, 128, (x, y) => (((x >> 2) ^ (y >> 2)) & 1) ? 208 : 48));
const softPhoto = D.analyze(img(128, 128, (x, y) => 128 + 35 * Math.sin(x / 16) + 25 * Math.cos(y / 20)));
const black = D.analyze(img(32, 32, () => 0));
const white = D.analyze(img(32, 32, () => 255));
const scores = [cleanSharp, softPhoto, D.analyze(normal), black, white].map(D.qualityScore);
check('清晰样本高于平滑模糊样本', scores[0] > scores[1], scores.join(' / '));
check('清晰样本高于全黑或全白', scores[0] > scores[3] && scores[0] > scores[4]);
check('同样纹理下高光裁剪降低参考分', D.qualityScore(cleanSharp) > D.qualityScore({ ...cleanSharp, clippedHighlights: 0.8 }));
check('参考分为 0–100 的整数', scores.every((score) => Number.isInteger(score) && score >= 0 && score <= 100));
check('缺失或非法指标不会产生 NaN', D.qualityScore(null) === 0 && Number.isFinite(D.qualityScore({ blurScore: NaN, avgLuma: Infinity })));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
