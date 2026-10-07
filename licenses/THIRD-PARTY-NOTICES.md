# 第三方组件与许可声明（快调选片 / Tpick）

本应用包含以下第三方组件。各组件的权利归其各自作者所有，使用时遵循其许可条款。

## 1. MediaPipe Tasks Vision（含 Face Landmarker 模型）

- 许可：**Apache License 2.0**（完整文本见 `LICENSE-Apache-2.0.txt`）
- 版权：Copyright 2023 The MediaPipe Authors
- 来源：<https://github.com/google-ai-edge/mediapipe>
- 模型文件：`models/face_landmarker.task`，包含 BlazeFace（Short Range）、Face Mesh V2、Blendshape V2 三个模型；三份官方模型卡均声明 *Licensed under the Apache License, Version 2.0*
  - <https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf>
  - <https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf>
  - <https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf>
- 本应用的改动：仅调用其推理接口，未修改其源码或权重；WASM 运行时随包分发（`renderer/vendor/mediapipe/`）。

## 2. OCEC（睁眼/闭眼分类模型）

- 许可：**MIT License**（完整文本见 `LICENSE-MIT-OCEC.txt`）
- 版权：Copyright (c) 2025 Katsuya Hyodo
- 来源：<https://github.com/PINTO0309/OCEC>
- 使用方式：采用其中间档模型 `ocec_s`，**已转换为本应用自有的权重格式**（`models/ocec_s_graph.json` + `models/ocec_s_weights.bin`），并使用自研的纯 JavaScript 推理器（`renderer/ocec.js`）执行，不再依赖 ONNX Runtime。
- 本应用的改动：格式转换（ONNX → 自有 JSON/BIN）与推理实现，**未修改模型权重数值**。

## 3. 闭眼判定融合模型

- 由本项目自行训练：以 MediaPipe 网格几何特征与 OCEC 单眼分类输出为输入，经逻辑回归得到"双眼闭合"概率。
- 训练数据来自本项目自建数据集（Wikimedia Commons 与 Openverse 上**允许商用与修改**的 CC/公有领域素材），**数据集本身不随应用分发**。
- 许可：与本应用一致（由本项目所有）。

## 4. Electron / Chromium

- Electron：MIT License；Chromium：BSD 3-Clause 等（`LICENSE.electron.txt` 与 `LICENSES.chromium.html` 随安装包分发）
- 来源：<https://github.com/electron/electron>

## 商标声明

MediaPipe 是 Google LLC 的商标；本项目与 Google LLC 无关联，也未获得其背书。"Electron" 为 OpenJS Foundation 的商标。本应用中对第三方名称的提及仅用于说明所使用组件，不构成任何赞助或背书关系。

---

本文件随应用一起分发；如需获取完整许可文本，请见同目录下的 `LICENSE-Apache-2.0.txt` 与 `LICENSE-MIT-OCEC.txt`，或在应用内「检测标准 → 开源许可」查看。
