// 快调 · 客户端许可证（单机离线激活，设备码绑定）
// 设备码 = 12 字节随机 → base32 20 字符（无易混字符），显示为 XXXX-XXXX-XXXX-XXXX-XXXX
// 激活码 = PR- + base32(HMAC-SHA256(secret, 设备码)) 前 12 位（共 15 位）
// 一个激活码只对一台设备有效：验证时对当前设备码计算 HMAC 并与输入比对。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// 单机密钥：激活码用 SHA-256 HMAC 派生校验，全程在本地完成。
// 注意：此密钥编译在软件内，用于离线校验；与 worker/gen-license 的默认密钥保持一致。
const SECRET = 'KX-KUA1XUAN-SECRET-6F2A9C71';

const DIR = path.join(app.getPath('appData'), 'kuaixuan');
const MACHINE_FILE = path.join(DIR, 'machine.json');
const LICENSE_FILE = path.join(DIR, 'license.json');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEVICE_LEN = 20;

function toBase32(bytes) {
  let bits = 0, value = 0, out = '';
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

function fromBase32(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 0xff); }
  }
  return Uint8Array.from(bytes);
}

// 设备码(20 位 base32) → 12 字节；格式非法返回 null
function deviceToBytes(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== DEVICE_LEN) return null;
  const bytes = fromBase32(clean);
  return bytes ? bytes.slice(0, 12) : null;
}

// 生成本机设备码（20 位 base32，12 字节随机）
function generateDeviceId() {
  return toBase32(crypto.randomBytes(12));
}

function getMachineId() {
  try {
    if (fs.existsSync(MACHINE_FILE)) {
      const mid = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')).machineId;
      if (typeof mid === 'string' && deviceToBytes(mid)) return mid; // 格式正确则复用
    }
  } catch (_) { /* 重新生成 */ }
  const machineId = generateDeviceId();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(MACHINE_FILE, JSON.stringify({ machineId }));
  } catch (e) { console.error('machine id save failed', e); }
  return machineId;
}

function getLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    }
  } catch (_) { /* 无授权 */ }
  return null;
}

function saveLicense(lic) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(lic, null, 2));
}

// 计算某设备码对应的激活码（与生成端一致）
function codeFor(deviceId) {
  const deviceBytes = deviceToBytes(deviceId);
  if (!deviceBytes) return null;
  const sig = crypto.createHmac('sha256', SECRET).update(deviceBytes).digest();
  return 'PR-' + toBase32(sig).slice(0, 12);
}

// 查询授权状态（单机绑机器）
function getStatus() {
  const lic = getLicense();
  if (!lic || !lic.code) return { activated: false };
  // 授权记录必须与当前机器一致（防止授权文件被复制到其他电脑复用）
  if (lic.machineId && lic.machineId !== getMachineId()) {
    return { activated: false, reason: 'MACHINE_MISMATCH' };
  }
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) {
    return { activated: false, reason: 'EXPIRED' };
  }
  return { activated: true, expiresAt: lic.expiresAt };
}

// 激活（单机离线，激活码与设备码绑定；已激活后不可重复激活）
function activate(code) {
  const machineId = getMachineId();
  if (getStatus().activated) {
    return { ok: false, error: '已激活，无需重复激活' };
  }
  const expected = codeFor(machineId);
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean.startsWith('PR')) {
    return { ok: false, error: '激活码无效，请检查后重试' };
  }
  if (!expected || clean !== expected.replace(/[^A-Z2-7]/g, '')) {
    return { ok: false, error: '激活码与当前设备不匹配，请添加 QQ 1355788707 重新获取' };
  }
  saveLicense({
    machineId,
    code: clean,
    activatedAt: Date.now(),
    expiresAt: '2099-12-31'
  });
  return { ok: true, expiresAt: '2099-12-31' };
}

module.exports = { getMachineId, getLicense, getStatus, activate };
