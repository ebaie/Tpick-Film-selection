// 打包脚本：正式版 / 体验版
// 用法: node scripts/build.js            → 正式版（无试用限制）
//       node scripts/build.js --trial    → 体验版（试用 20 张）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isTrial = process.argv.includes('--trial');
const editionFile = path.join(__dirname, '..', 'edition.json');

// 写版本标记（打包进 asar，main.js 读取）
fs.writeFileSync(editionFile, JSON.stringify({ trial: isTrial }));

const productName = isTrial ? '快调体验版' : '快调';
try {
  console.log('===== 打包 ' + (isTrial ? '体验版(试用20张)' : '正式版(商店付费)') + ' =====');
  execSync(
    'npx electron-builder --win -c.productName="' + productName + '"' +
    (isTrial ? ' -c.artifactName="快调体验版-Setup-${version}.${ext}"' : ' -c.artifactName="快调-Setup-${version}.${ext}"'),
    { stdio: 'inherit', env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/', ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/' } }
  );
} finally {
  try { fs.unlinkSync(editionFile); } catch (_) {}
  console.log('===== 打包结束（edition 标记已清理） =====');
}
