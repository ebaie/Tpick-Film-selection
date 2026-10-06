// 快选激活系统 · 核心逻辑（ESM 纯函数，Node 与 Cloudflare Workers 通用）
// 设备码授权方案：
//   设备码 = 12 字节随机 → base32 20 字符（无易混字符 0/1/8/9），显示为 XXXX-XXXX-XXXX-XXXX-XXXX
//   激活码 = "PR-" + base32(HMAC-SHA256(secret, 设备码)) 前 12 位（共 15 位）
//   验证   = 对当前设备码计算同样 HMAC 并与激活码比对 ——
//            激活码由设备码单向派生，一个激活码只对一台设备有效；
//            HMAC 截断 60 bit，无法从激活码反推设备码或密钥。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

// 规范化输入（去分隔符、大写、剔除易混淆字符）
export function normalize(s) {
  return (s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

// 生成 HMAC-SHA256（Node webcrypto / Workers crypto 通用）
export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data); // data 直接作为原始字节
  return new Uint8Array(sig);
}

// 生成 20 位设备码（12 字节随机 → base32 20 字符）
export function generateDeviceCode() {
  const random = crypto.getRandomValues(new Uint8Array(12));
  return toBase32(random);
}

// 设备码(20 位 base32) → 12 字节；格式非法返回 null
export function deviceCodeToBytes(code) {
  const clean = normalize(code);
  if (clean.length !== 20) return null;
  const bytes = fromBase32(clean);
  if (!bytes) return null;
  return bytes.slice(0, 12);
}

// 设备码加连字符显示格式: XXXX-XXXX-XXXX-XXXX-XXXX
export function formatDeviceCode(code) {
  const clean = normalize(code);
  if (clean.length !== 20) return code || '';
  return clean.slice(0, 4) + '-' + clean.slice(4, 8) + '-' + clean.slice(8, 12) + '-' + clean.slice(12, 16) + '-' + clean.slice(16, 20);
}

// 生成激活码: PR- + base32(HMAC(secret, 设备码)) 前 12 位（共 15 位）
export async function activationCode(secret, deviceCode) {
  const deviceBytes = deviceCodeToBytes(deviceCode);
  if (!deviceBytes) throw new Error('设备码格式错误: ' + deviceCode);
  const sig = (await hmac(secret, deviceBytes)).slice(0, 8);
  const b32 = toBase32(sig);
  return 'PR-' + b32.slice(0, 12);
}

// 验证激活码是否与设备码匹配
export async function verifyActivation(secret, code, deviceCode) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean.startsWith('PR')) return false;
  let expect;
  try {
    expect = await activationCode(secret, deviceCode);
  } catch (_) { return false; }
  return clean === expect.replace(/[^A-Z2-7]/g, '');
}
