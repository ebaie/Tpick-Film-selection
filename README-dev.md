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
npm run dist-portable    # 打包便携版
npm run dist-store       # 打包商店提交用 APPX
```
打包产物在 `release/` 目录，便携版 EXE 可直接运行；未签名 APPX 供 Partner Center 提交使用，终端用户从 Microsoft Store 安装微软签名的版本。

打开后：拖入（或点「选择照片」）自己的照片即可开始筛选；软件完全免费，所有功能都可直接使用。

---

## 项目结构

```
photo-culler/
├── main.js            # Electron 主进程窗口
├── preload.js         # 预加载（安全暴露 API）
├── renderer/          # 软件界面（HTML/CSS/JS）+ MediaPipe 运行时 + 眼部模型
├── lib/detectors.js   # 模糊 / 曝光检测算法
├── models/            # 人脸 / 眼部模型（本地，无需联网）
├── assets/plugins/    # 内置插件（眼部检测、精细检测、青绿主题）
├── scripts/           # 运行时下载、商店图标生成
├── test/              # 单元测试（npm test）+ 冒烟测试
├── test-photos/       # 生成的测试图片（test/gen-test-photos.js）
├── build/             # 应用图标与商店图标
└── licenses/          # 开源许可与第三方声明
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
    css: ':root { --accent: #4dbfa5; } body[data-theme="dark"] { --accent: #35c0a8; }',   // 主题插件：注入的 CSS
    detect: function (m) {   // 功能插件：m = { blurScore, overRatio, underRatio, avgLuma, eyeClosed }
      if (m.avgLuma < 40) return { reason: 'tooTight', label: '欠曝过度' };
      return null;           // 返回 {reason,label} 新增一条废片标记；null 则不加
    }
  };
})();
```

- `type: 'theme'` + `css`：注入界面，可覆盖 `--accent` 等变量做主题美化。
  **注意**：内置暗色调色板写在 `body[data-theme="dark"]` 上（`renderer/styles.css:1228`），而 body 离元素更近、继承时胜出，所以只写 `:root` 的主题在**暗色模式下会被内置蓝色调色板压掉**（看起来"没生效/冲突"）。做法是浅色写 `:root`、暗色再写一条 `body[data-theme="dark"]`：插件样式注入在 `<head>` 末尾，同特异性下后写者胜。
- `type: 'feature'` + `detect(m)`：返回 `{reason, label}` 会额外标记一张照片的"原因"，`label` 显示在缩略图角标上。

启用 / 停用：在软件右上角的「插件」面板里切换，状态会自动记住。

**内置示例插件**（在插件目录内，供参考，可删）：`theme-teal.js`（青绿主题）、`fine-detect.js`（精细检测）。
