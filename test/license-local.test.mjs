// 单机离线激活码端到端测试：生成端(WebCrypto) 与 客户端本地校验(node crypto) 必须一致
// 运行: node test/license-local.test.mjs
import crypto from 'node:crypto';
import { activationCode, generateDeviceCode } from '../worker/core.mjs';

const SECRET = 'KX-KUA1XUAN-SECRET-6F2A9C71';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 复刻客户端 license.js 的本地校验（对设备码计算 HMAC 前 12 位 base32）
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
function deviceToBytes(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== 20) return null;
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(bytes.slice(0, 12));
}
function verify(code, machineId) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean.startsWith('PR')) return false;
  const deviceBytes = deviceToBytes(machineId);
  if (!deviceBytes) return false;
  const expect = 'PR-' + toBase32(crypto.createHmac('sha256', SECRET).update(deviceBytes).digest()).slice(0, 12);
  return clean === expect.replace(/[^A-Z2-7]/g, '');
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name, detail || ''); }
  else { fail++; console.log('  ❌', name, detail || ''); }
}

console.log('== 单机离线激活码（设备码绑定）==');
const device = generateDeviceCode();
const code = await activationCode(SECRET, device);
console.log('   设备码:', device.slice(0, 4) + '-' + device.slice(4, 8) + '-' + device.slice(8, 12) + '-' + device.slice(12, 16) + '-' + device.slice(16, 20));
console.log('   激活码:', code);
check('生成端与客户端校验一致(同设备)', verify(code, device) === true);
check('客户端拒绝其他设备(设备码不匹配)', verify(code, generateDeviceCode()) === false);
check('客户端拒绝旧格式激活码', verify('KX-KUHIIAHC-TNA5JJYW-IRTFKRAA-ABD4JWKS', device) === false);
check('客户端拒绝乱码', verify('PR-AAAAAAAAAAAA', device) === false);
check('客户端拒绝空串', verify('', device) === false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
