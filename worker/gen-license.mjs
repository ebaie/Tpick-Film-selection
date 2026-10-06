// 激活码生成器（设备码版）—— 卖家/客服工具
// 用法: node worker/gen-license.mjs <设备码1> [设备码2 ...]
// 设备码 20 位（可带连字符）；每个设备码生成唯一激活码 PR-XXXXXXXXXXXX，一个激活码绑定一台设备。
// 默认使用与客户端 license.js 一致的内置密钥；如需更换可用环境变量 KX_SECRET 覆盖（生成端与客户端要一致）

import { activationCode } from './core.mjs';

const SECRET = process.env.KX_SECRET || 'KX-KUA1XUAN-SECRET-6F2A9C71';

const ids = process.argv.slice(2);
if (!ids.length) {
  console.log('用法: node worker/gen-license.mjs <设备码1> [设备码2 ...]');
  console.log('示例: node worker/gen-license.mjs K7AB2X4Y-ZQ8T3N6W-P5HD2VAK-JM9L4C6R');
  process.exit(1);
}
for (const id of ids) {
  try {
    console.log(id + '  →  ' + (await activationCode(SECRET, id)));
  } catch (e) {
    console.error('❌ ' + id + ': ' + e.message);
    process.exitCode = 1;
  }
}
