#!/usr/bin/env node
/*
 * 把 MediaPipe Tasks Vision 的运行时从 node_modules 复制到 renderer/vendor/mediapipe/
 * 原因：WASM 运行时约 13MB，属于第三方二进制，不放进 git 历史；由 npm 依赖提供，构建前复制即可。
 *   npm run vendor          # 手动执行
 *   npm start / npm run dist-store  # 会通过 pre* 钩子自动执行
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const dstDir = path.join(root, 'renderer', 'vendor', 'mediapipe');
const FILES = ['vision_bundle.mjs', path.join('wasm', 'vision_wasm_internal.js'), path.join('wasm', 'vision_wasm_internal.wasm')];

function main() {
  if (!fs.existsSync(srcDir)) {
    console.error('[vendor] 未找到 @mediapipe/tasks-vision，请先运行 npm install');
    process.exit(1);
  }
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  for (const rel of FILES) {
    const src = path.join(srcDir, rel);
    const dst = path.join(dstDir, path.basename(rel));
    if (!fs.existsSync(src)) { console.error('[vendor] 缺少文件：' + rel); continue; }
    const needCopy = !fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size;
    if (needCopy) { fs.copyFileSync(src, dst); copied++; }
  }
  console.log('[vendor] MediaPipe 运行时就绪（复制 ' + copied + ' 个文件 → renderer/vendor/mediapipe/）');
}

main();
