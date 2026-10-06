// 激活 API 端到端测试（Node：直接调用 worker 的 fetch handler）
// 运行: node test/api.test.mjs
import worker from '../worker/worker.mjs';
import { activationCode, generateDeviceCode } from '../worker/core.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name, detail || ''); }
  else { fail++; console.log('  ❌', name, detail || ''); }
}

const env = { KX_SECRET: 'api-test-secret' };
const device = generateDeviceCode();
const other = generateDeviceCode();

async function call(path, body) {
  const req = new Request('https://test.local' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, body: await res.json() };
}

console.log('== 激活 API（设备码派生，无需 KV）==');
const code = await activationCode(env.KX_SECRET, device);

let r = await call('/activate', { code, machineId: device });
check('本设备激活成功', r.body.ok === true && r.body.expiresAt === '2099-12-31');

r = await call('/activate', { code, machineId: other });
check('其他设备被拒(DEVICE_MISMATCH)', r.body.ok === false && r.body.error === 'DEVICE_MISMATCH');

r = await call('/activate', { code, machineId: device.slice(0, 4) + '-' + device.slice(4, 8) + '-' + device.slice(8, 12) + '-' + device.slice(12, 16) + '-' + device.slice(16, 20) });
check('带连字符设备码同样有效', r.body.ok === true);

r = await call('/activate', { code: 'PR-AAAAAAAAAAAA', machineId: device });
check('无效激活码被拒绝', r.body.ok === false);

r = await call('/activate', { code, machineId: '' });
check('缺少机器码被拒', r.body.ok === false && r.body.error === 'BAD_REQUEST');

r = await call('/activate', null);
check('无 body 被拒', r.body.ok === false);

r = await call('/activate', { code: 'KX-KUHIIAHC-TNA5JJYW-IRTFKRAA-ABD4JWKS', machineId: device });
check('旧格式激活码被拒', r.body.ok === false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
