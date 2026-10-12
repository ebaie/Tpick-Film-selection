// MediaPipe Tasks Vision 是 ES 模块，这里按需加载后挂到 window，供经典脚本（app.js / 插件）使用。
// 必须是外部文件：应用的 CSP 不允许内联脚本（script-src 无 'unsafe-inline'）。
// 按需加载的意义：闭眼插件没启用时不加载 13MB 的 WASM 运行时，启动与常规检测不受影响。
(function () {
  var promise = null;
  window.__kxLoadMediaPipe = function () {
    if (!promise) {
      promise = import('./vendor/mediapipe/vision_bundle.mjs').then(function (m) {
        window.MediaPipeVision = m;
        return m;
      }).catch(function (e) {
        promise = null;               // 失败后允许重试
        window.__MP_ERROR = String((e && e.message) || e);
        throw e;
      });
    }
    return promise;
  };
})();
