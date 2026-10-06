# 快调 · 摄影师自动选片工具

一个 Windows 桌面选片工具：一键标记照片里的 **模糊 / 过曝 / 欠曝 / 闭眼** 废片，你只需对标记二次确认，即可导出合格片。

---

## 打开 / 运行 App

**开发运行**（需要已安装 Node.js）：
```bash
npm install     # 首次先装依赖
npm start       # 启动应用
```

**打包成安装包后运行**：
```bash
npm run dist    # 打包
```
打包产物在 `release/` 目录，双击 `快调 Setup <版本>.exe` 安装即可。

打开后：上传你自己的照片（或点「试用示例照片」）即可体验筛选；试用版最多分析 20 张，导出 / 插件 / 批量需激活解锁。

---

## 项目结构

```
photo-culler/
├── main.js            # Electron 主进程窗口
├── preload.js         # 预加载（安全暴露 API）
├── license.js         # 授权相关（内部）
├── renderer/          # 软件界面（HTML/CSS/JS）+ 人脸检测库
├── lib/detectors.js   # 模糊 / 曝光检测算法
├── models/            # 人脸模型（本地，无需联网）
├── worker/            # 激活服务（内部）
├── assets/samples/    # 内置 20 张示例照片
├── site/index.html    # 官网落地页
├── test/              # 单元测试 + 冒烟测试
├── test-photos/       # 生成的测试图片
└── build/icon.png     # 应用图标
```

---

## 插件指南

插件是放在插件目录里的 `.js` 文件，App 启动时自动识别，可**美化界面（主题）**或**扩展功能（自定义检测）**。

**插件目录**：`%APPDATA%\kuaixuan\plugins\`（首次使用自动创建）。

**插件写法规约**：文件里给 `window.__KX_PLUGIN` 赋值一个对象：

```js
(function () {
  window.__KX_PLUGIN = {
    id: 'my-plugin',        // 唯一 id
    name: '我的插件',
    version: '1.0',
    type: 'theme',          // 'theme'（主题）或 'feature'（功能检测）
    css: ':root { --accent: #4dbfa5; }',   // 主题插件：注入的 CSS
    detect: function (m) {   // 功能插件：m = { blurScore, overRatio, underRatio, avgLuma, eyeClosed }
      if (m.avgLuma < 40) return { reason: 'dark', label: '过暗' };
      return null;           // 返回 {reason,label} 新增一条废片标记；null 则不加
    }
  };
})();
```

- `type: 'theme'` + `css`：注入界面，可覆盖 `--accent` 等变量做主题美化。
- `type: 'feature'` + `detect(m)`：返回 `{reason, label}` 会额外标记一张照片的"原因"，`label` 显示在缩略图角标上。

启用 / 停用：在软件右上角的「插件」面板里切换，状态会自动记住。

**内置示例插件**（在插件目录内，供参考，可删）：`theme-teal.js`（青绿主题）、`feature-dark.js`（检测过暗画面）。
