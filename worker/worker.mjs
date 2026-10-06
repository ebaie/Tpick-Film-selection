// 快选 · 激活服务（Cloudflare Workers，可选部署）
// 部署: 安装 wrangler 后 `wrangler deploy`，或在 Dashboard 粘贴本文件
// 环境变量: KX_SECRET（必须设置，与 gen-license.mjs 使用相同密钥）
//
// 设备码方案：激活码 = PR- + base32(HMAC(secret, 设备码)) 前 12 位，
// 验证时对提交的 machineId 计算 HMAC 并与激活码比对 ——
// 激活码由设备码单向派生，一个激活码只对一台设备有效，无需额外 KV 绑定。
//
// 接口:
//   POST /activate  { code, machineId } -> { ok, expiresAt, machineId } 或 { ok:false, error }
//   GET  /ping      -> { ok:true, service:'kuaixuan-license' }

import { normalize, toBase32, hmac, deviceCodeToBytes } from './core.mjs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({ ok: true }, 204);

    if (url.pathname === '/activate' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST' }); }
      const { code, machineId } = body || {};
      if (!code || !machineId) return json({ ok: false, error: 'BAD_REQUEST' });

      const secret = env.KX_SECRET;
      if (!secret) return json({ ok: false, error: 'SERVER_NOT_CONFIGURED' });

      // 1. 对提交的设备码计算期望激活码并比对
      const clean = normalize(code);
      if (!clean.startsWith('PR')) return json({ ok: false, error: 'INVALID_CODE' });
      const deviceBytes = deviceCodeToBytes(String(machineId || ''));
      if (!deviceBytes) return json({ ok: false, error: 'INVALID_DEVICE' });
      const expect = 'PR-' + toBase32((await hmac(secret, deviceBytes)).slice(0, 8)).slice(0, 12);
      if (clean !== normalize(expect)) return json({ ok: false, error: 'DEVICE_MISMATCH' });

      return json({ ok: true, expiresAt: '2099-12-31', machineId });
    }

    if (url.pathname === '/ping') return json({ ok: true, service: 'kuaixuan-license' });
    return json({ ok: false, error: 'NOT_FOUND' }, 404);
  }
};
