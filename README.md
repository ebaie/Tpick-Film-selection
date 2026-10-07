# 快调选片 · Tpick-Film selection

面向摄影师的 Windows 本地自动选片工具：一键识别并标记模糊、虚焦、过曝、欠曝、闭眼和过暗的照片，帮你从成百上千张里快速筛出合格片。

## 下载

- **Microsoft Store（推荐，免费）**：<https://apps.microsoft.com/detail/9PN3FB25RBF6>
- 商店程序包（APPX）：见本仓库 [Releases](https://github.com/ebaie/Tpick-Film-selection/releases)

## 主要功能

- 自动检测模糊 / 虚焦 / 过曝 / 欠曝 / 闭眼 / 过暗
- 显示每张照片被标记的原因，二次确认后再导出
- 批量分析与导出，内置示例照片可直接试用
- 完全本地运行，照片不上传云端
- 支持插件扩展（主题与自定义检测规则）

## 闭眼检测是怎么做的

口径：**只有双眼都可见地闭合才算「闭眼」**；单眼闭（眨眼、单眼眯、另一只眼被挡）一律算「睁眼」。

处理链（全部在本地 CPU 运行，无网络请求）：

1. **MediaPipe Face Landmarker**（Apache-2.0，`models/face_landmarker.task`）定位人脸，输出 478 点网格与 52 个表情系数
2. 由网格计算**双眼开合度**，由表情系数取 **eyeBlinkLeft / eyeBlinkRight**
3. 按眼位裁出左右眼（三档余量投票），送入 **OCEC 单眼开闭分类器**（MIT，`models/ocec_*`）——该模型已转换为自有权重格式，由 `renderer/ocec.js` 以**纯 JavaScript** 推理，**不依赖 ONNX Runtime**
4. 以上 5 个特征送入**逻辑回归融合模型**（`models/eye_ensemble_5f.json`，阈值 0.80），输出"双眼闭合"概率

在自建数据集（374 条人工标注，含 36 张闭眼）上的**分组交叉验证**表现：

| 指标 | 数值 |
|---|---|
| 准确率 | 0.957 |
| 闭眼精确率 | 0.784 |
| 闭眼召回率 | 0.806 |
| F1 | 0.795 |

边界说明：这是**提示性**判定，界面支持一键改判（单击照片）。当前误差集中在黑白老照片、浓妆睫毛、挤眼抓拍等困难样本上。

## 开发与构建

```bash
npm install        # 安装依赖（@mediapipe/tasks-vision、electron 等）
npm start          # 开发运行（prestart 会自动把 MediaPipe 运行时复制到 renderer/vendor/mediapipe/）
npm test           # 单元测试 + 自研推理器与 ONNX Runtime 的一致性回归测试
npm run dist-store # 打包 APPX（商店提交用）
```

- MediaPipe 的 WASM 运行时约 13MB，属第三方二进制，**不进入 git 历史**；由 `npm run vendor`（`scripts/fetch-runtime.js`）从 node_modules 复制。
- `test/ocec-parity.test.js` 用真实眼部裁剪比对自研 JS 推理器与 ONNX Runtime 的输出（要求最大偏差 < 1e-4）。

## 第三方组件与许可

完整清单见 [licenses/THIRD-PARTY-NOTICES.md](licenses/THIRD-PARTY-NOTICES.md)；应用内可通过「检测标准 → 开源许可」查看。

| 组件 | 许可 |
|---|---|
| MediaPipe Tasks Vision 及 Face Landmarker 模型 | Apache License 2.0 |
| OCEC（睁眼/闭眼分类模型） | MIT License（Copyright © 2025 Katsuya Hyodo） |
| Electron / Chromium | MIT / BSD 3-Clause 等（随安装包分发） |

许可正文随仓库与应用一起分发：`licenses/LICENSE-Apache-2.0.txt`、`licenses/LICENSE-MIT-OCEC.txt`。

## 数据集（不随仓库分发）

闭眼模型所用数据集**不在本仓库内**：图片取自 Wikimedia Commons 与 Openverse 上**允许商用与修改**的 CC / 公有领域素材，逐条记录了来源、许可与作者，仅用于本地训练与评测。抓取脚本、标注工具、评测与训练脚本位于本地数据目录，图片本身不对外分发。

## 系统要求

Windows 10 14316 或更高版本，x64

## 隐私

本应用不收集任何个人数据，照片仅在设备本地处理，导出为复制行为、原片不被修改。

隐私策略：<https://ebaie.github.io/Tpick-Film-selection/>

## 关于本仓库

本仓库同时托管「快调选片」的隐私策略页面（GitHub Pages）。闭眼检测的训练数据与训练脚本不在此仓库内。
