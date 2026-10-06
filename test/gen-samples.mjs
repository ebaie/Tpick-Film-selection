// 生成 20 张示例照片（合成山景，含清晰/模糊/过曝/欠曝差异）供开箱试用
// 运行: node test/gen-samples.mjs
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const W = 640, H = 427; // 3:2
const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      raw[p++] = rgba[i]; raw[p++] = rgba[i + 1]; raw[p++] = rgba[i + 2]; raw[p++] = rgba[i + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) % 1000;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v) => Math.max(0, Math.min(255, v));

function mountainHeight(x, seed) {
  const n = seed % 3 + 1;
  let hgt = 0;
  for (let i = 0; i < n; i++) {
    const amp = 28 + ((seed * 31 + i * 57) % 42);
    const freq = 0.006 + 0.002 * i;
    hgt += amp * Math.sin(x * freq + i * 1.7 + (seed % 6));
  }
  return 0.42 + hgt / 260;
}

function genPhoto(idx) {
  const exposure = ['normal', 'normal', 'normal', 'over', 'over', 'under', 'under', 'blur'][idx % 8];
  const seed = idx * 7 + 3;
  const sunX = 0.2 + ((seed % 5) / 10);
  const sunY = 0.28 + ((seed % 4) / 30);
  const sunR = 0.05 + ((seed % 3) / 60);
  const rgba = new Uint8Array(W * H * 4);
  const isBlur = exposure === 'blur';
  const isOver = exposure === 'over';
  const isUnder = exposure === 'under';
  const mul = isUnder ? 0.16 : 1.0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W, ny = y / H;
      const mhFar = mountainHeight(x, seed);
      const mhNear = mountainHeight(x, seed + 11);
      let r = lerp(26, 210, ny), g = lerp(38, 124, ny), b = lerp(62, 80, ny);
      const d = Math.hypot(nx - sunX, ny - sunY);
      if (d < sunR) { r = 255; g = 248; b = 232; }
      else if (d < sunR * 3) { const glow = (1 - (d - sunR) / (sunR * 2)) * 0.5; r = lerp(r, 255, glow); g = lerp(g, 240, glow); b = lerp(b, 210, glow); }
      if (!isBlur && ny > mhFar) {
        const sh = (ny - mhFar) / (1 - mhFar);
        r = lerp(72, 44, sh); g = lerp(68, 40, sh); b = lerp(80, 50, sh);
        if (ny > mhNear) {
          const sh2 = (ny - mhNear) / (1 - mhNear);
          r = lerp(32, 24, sh2); g = lerp(34, 26, sh2); b = lerp(42, 32, sh2);
        }
      }
      if (isOver) {
        if (ny < mhFar * 0.96) { r = 255; g = 255; b = 255; }
        else { const f = 1.12; r = Math.min(255, r * f); g = Math.min(255, g * f); b = Math.min(255, b * f); }
      } else {
        r *= mul; g *= mul; b *= mul;
      }
      // 纹理：清晰图加高频噪点（拉普拉斯方差高）；模糊图近乎平滑；过曝死白云天不加噪
      if (isBlur) {
        const nz = (hash(x + idx * 13, y) - 500) / 500;
        r += nz * 2.5; g += nz * 2.5; b += nz * 2.5;
      } else if (!(isOver && ny < mhFar * 0.96)) {
        const nz = (hash(x + idx * 13, y) - 500) / 500;
        r += nz * 26; g += nz * 26; b += nz * 26;
      }
      const i = (y * W + x) * 4;
      rgba[i] = clamp(r); rgba[i + 1] = clamp(g); rgba[i + 2] = clamp(b); rgba[i + 3] = 255;
    }
  }
  const label = exposure === 'normal' ? '正常' : exposure === 'over' ? '过曝' : exposure === 'under' ? '欠曝' : '模糊';
  return { rgba, label };
}

let n = 0;
for (let i = 1; i <= 20; i++) {
  const { rgba, label } = genPhoto(i);
  const file = path.join(OUT, "示例-" + String(i).padStart(2, '0') + ".png");
  fs.writeFileSync(file, encodePng(rgba));
  n++;
  console.log("  生成 " + path.basename(file) + "  [" + label + "]");
}
console.log("完成，共 " + n + " 张");
