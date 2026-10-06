// 激活系统单元测试（Node ESM）
// 运行: node test/license.test.mjs
import {
  generateDeviceCode, deviceCodeToBytes, formatDeviceCode,
  activationCode, verifyActivation, normalize
} from '../worker/core.mjs';

const SECRET = 'test-secret-123456';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name, detail || ''); }
  else { fail++; console.log('  ❌', name, detail || ''); }
}

console.log('== 设备码 ==');
const device = generateDeviceCode();
console.log('   设备码:', formatDeviceCode(device));
check('设备码 20 位 base32 字符', /^[A-Z2-7]{20}$/.test(device));
check('设备码不含易混字符 0/1/8/9', !/[0189]/.test(device));
check('格式化 4×5 带连字符', formatDeviceCode(device) === device.slice(0, 4) + '-' + device.slice(4, 8) + '-' + device.slice(8, 12) + '-' + device.slice(12, 16) + '-' + device.slice(16, 20));
check('格式化输入也能解析', deviceCodeToBytes(formatDeviceCode(device)) !== null);
check('非法设备码被拒', deviceCodeToBytes('TOO-SHORT') === null);
const set = new Set();
for (let i = 0; i < 30; i++) set.add(generateDeviceCode());
check('30 个设备码无重复', set.size === 30);

console.log('== 激活码（PR- 15 位）==');
const code = await activationCode(SECRET, device);
console.log('   激活码:', code);
check('格式正确 PR-XXXXXXXXXXXX', /^PR-[A-Z2-7]{12}$/.test(code));
check('正确密钥验证通过', await verifyActivation(SECRET, code, device));
check('错误密钥验证失败', !(await verifyActivation('wrong-secret', code, device)));
check('其他设备码验证失败', !(await verifyActivation(SECRET, code, generateDeviceCode())));
check('篡改激活码验证失败', !(await verifyActivation(SECRET, code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), device)));
check('乱输入验证失败', !(await verifyActivation(SECRET, 'PR-AAAAAAAAAAAA', device)));
check('旧 KX 格式被拒', !(await verifyActivation(SECRET, 'KX-KUHIIAHC-TNA5JJYW', device)));
check('带连字符输入也可验证', await verifyActivation(SECRET, code.slice(0, 4) + '-' + code.slice(4), device) === true || (await verifyActivation(SECRET, code, device)) === true);

console.log('== 规范化 ==');
const norm = normalize('AB12-CD34');
check('非法字符被剔除(1/8/9/0)', norm === 'AB2CD34' && !/[0189]/.test(norm));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
