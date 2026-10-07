/*
 * 回归测试：自研 JS 推理器（renderer/ocec.js）与 ONNX Runtime 的结果必须一致。
 * 对照数据 test/ocec_oracle.json 由 RS-modle/gen_ocec_oracle.py 生成：
 *   真实眼部裁剪 → NCHW 输入 + ONNX Runtime 的参考输出。
 * 运行：node test/ocec-parity.test.js（已包含在 npm test 中）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const OcecNet = require(path.join(root, 'renderer', 'ocec.js'));

const graphPath = path.join(root, 'models', 'ocec_s_graph.json');
const weightsPath = path.join(root, 'models', 'ocec_s_weights.bin');
const oraclePath = path.join(root, 'test', 'ocec_oracle.json');

assert.ok(fs.existsSync(graphPath), '缺少 models/ocec_s_graph.json');
assert.ok(fs.existsSync(weightsPath), '缺少 models/ocec_s_weights.bin');
assert.ok(fs.existsSync(oraclePath), '缺少 test/ocec_oracle.json（对照数据）');

const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const wbuf = fs.readFileSync(weightsPath);
const net = OcecNet.fromBuffers(
  graph,
  wbuf.buffer.slice(wbuf.byteOffset, wbuf.byteOffset + wbuf.byteLength)
);
const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));

const EW = oracle.ew, EH = oracle.eh;
let worst = 0, count = 0;
for (const c of oracle.cases) {
  const flat = Float32Array.from(c.input);
  for (let eye = 0; eye < 2; eye++) {
    const slice = flat.subarray(eye * 3 * EW * EH, (eye + 1) * 3 * EW * EH);
    const got = net.run(new Float32Array(slice));
    const diff = Math.abs(got - c.expected[eye]);
    if (diff > worst) worst = diff;
    count++;
  }
}

assert.ok(count > 0, '对照数据为空');
assert.ok(
  worst < 1e-4,
  'JS 推理器与 ONNX Runtime 偏差过大：' + worst.toExponential(3) + '（应 < 1e-4）'
);
console.log('ocec-parity: ' + count + ' 次推理全部一致（最大偏差 ' + worst.toExponential(3) + '）');
