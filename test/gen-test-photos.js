// 生成测试照片（BMP 24bit），用于端到端验证
// node test/gen-test-photos.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'test-photos');
fs.mkdirSync(OUT, { recursive: true });

// 24-bit BMP，bottom-up
function writeBmp(file, w, h, pixelFn) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const dataSize = rowSize * h;
  const fileSize = 54 + dataSize;
  const buf = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // 正数 = bottom-up
  buf.writeUInt16LE(1, 26);   // planes
  buf.writeUInt16LE(24, 28);  // bpp
  buf.writeUInt32LE(0, 30);   // compression
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < h; y++) {
    const rowStart = 54 + (h - 1 - y) * rowSize; // bottom-up
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const p = rowStart + x * 3;
      buf[p] = b; buf[p + 1] = g; buf[p + 2] = r;
    }
  }
  fs.writeFileSync(file, buf);
  console.log('generated', path.basename(file), `${w}x${h}`, (fileSize / 1024).toFixed(0) + 'KB');
}

// 清晰图：棋盘 + 文字般的随机块（高频细节）
writeBmp(path.join(OUT, 'sharp.bmp'), 640, 480, (x, y) => {
  const block = (((x >> 4) ^ (y >> 4)) & 1) ? 30 : 225;
  const detail = ((x * 7 + y * 13) % 5 === 0) ? 60 : 0;
  const v = Math.max(0, Math.min(255, block - detail));
  return [v, v, v];
});

// 模糊图：平滑渐变（无高频）
writeBmp(path.join(OUT, 'blur.bmp'), 640, 480, (x, y) => {
  const v = Math.round(60 + (x / 640) * 140);
  return [v, v, v];
});

// 过曝图：大部分纯白，少量细节
writeBmp(path.join(OUT, 'over.bmp'), 640, 480, (x, y) => {
  const edge = (x < 20 || y < 20) ? 128 : 253;
  return [edge, edge, edge];
});

// 欠曝图：大部分纯黑，少量细节
writeBmp(path.join(OUT, 'under.bmp'), 640, 480, (x, y) => {
  const edge = (x < 20 || y < 20) ? 60 : 8;
  return [edge, edge, edge];
});

console.log('done');
