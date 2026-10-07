// MediaPipe Tasks Vision 是 ES 模块，这里加载后挂到 window，供 app.js（经典脚本）使用。
// 必须是外部文件：应用的 CSP 不允许内联脚本（script-src 无 'unsafe-inline'）。
window.__MP_READY = import('./vendor/mediapipe/vision_bundle.mjs').then(function (m) {
  window.MediaPipeVision = m;
  return m;
}).catch(function (e) {
  window.__MP_ERROR = String((e && e.message) || e);
  throw e;
});
