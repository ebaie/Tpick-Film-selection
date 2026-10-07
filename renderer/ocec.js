/*
 * OCEC 最小推理器（纯 JS，无需 ONNX Runtime）
 * 模型：PINTO0309/OCEC 的 ocec_s（MIT License）
 *   https://github.com/PINTO0309/OCEC
 * 图与权重由 RS-modle/export_ocec_js.py 从 ONNX 导出：
 *   models/ocec_s_graph.json + models/ocec_s_weights.bin
 * 支持算子：Conv(含 depthwise/分组) / Sigmoid / Relu / Mul / Add / GlobalAveragePool /
 *          ReduceMean / ReduceMax / Concat / Gemm / Squeeze
 * 用法：
 *   const net = OcecNet.fromBuffers(graphJson, weightsArrayBuffer);
 *   const probOpen = net.run(rgbFloat32NCHW);   // [1,3,24,40] 归一化到 0..1
 */
(function (global) {
  'use strict';

  function shapeSize(s) { let n = 1; for (let i = 0; i < s.length; i++) n *= s[i]; return n; }

  function broadcastShape(a, b) {
    const n = Math.max(a.length, b.length);
    const A = a.slice().reverse(), B = b.slice().reverse(), out = [];
    for (let i = 0; i < n; i++) {
      const x = A[i] === undefined ? 1 : A[i], y = B[i] === undefined ? 1 : B[i];
      if (x !== y && x !== 1 && y !== 1) return null;
      out.push(Math.max(x, y));
    }
    return out.reverse();
  }

  // 把 out 的扁平下标映射到 src 的扁平下标（按 numpy 广播规则）
  function mapIndex(flat, outShape, srcShape) {
    const rank = outShape.length, off = rank - srcShape.length;
    let idx = 0, rem = flat;
    const outStride = new Array(rank);
    for (let i = rank - 1, s = 1; i >= 0; i--) { outStride[i] = s; s *= outShape[i]; }
    for (let i = 0; i < rank; i++) {
      const coord = Math.floor(rem / outStride[i]); rem -= coord * outStride[i];
      const j = i - off;
      if (j < 0) continue;
      const dim = srcShape[j];
      idx = idx * dim + (dim === 1 ? 0 : coord);
    }
    return idx;
  }

  function elementwise(fn, A, B) {
    // 快路径：形状完全一致（SiLU 的 Mul、残差 Add 都走这里）
    if (A.shape.length === B.shape.length) {
      let same = true;
      for (let i = 0; i < A.shape.length; i++) if (A.shape[i] !== B.shape[i]) { same = false; break; }
      if (same) {
        const n = A.data.length, out = new Float32Array(n);
        const a = A.data, b = B.data;
        for (let i = 0; i < n; i++) out[i] = fn(a[i], b[i]);
        return { data: out, shape: A.shape.slice() };
      }
    }
    const outShape = broadcastShape(A.shape, B.shape);
    if (!outShape) throw new Error('broadcast 失败 ' + A.shape + ' vs ' + B.shape);
    const n = shapeSize(outShape);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ia = mapIndex(i, outShape, A.shape);
      const ib = mapIndex(i, outShape, B.shape);
      data[i] = fn(A.data[ia], B.data[ib]);
    }
    return { data: data, shape: outShape };
  }

  function unary(fn, A) {
    const data = new Float32Array(A.data.length);
    for (let i = 0; i < A.data.length; i++) data[i] = fn(A.data[i]);
    return { data: data, shape: A.shape.slice() };
  }

  function conv(A, W, B, attrs) {
    const x = A.data, xsh = A.shape;             // [N,C,H,W]
    const w = W.data, wsh = W.shape;             // [OC, IC/g, KH, KW]
    const N = xsh[0], C = xsh[1], H = xsh[2], Wd = xsh[3];
    const OC = wsh[0], ICg = wsh[1], KH = wsh[2], KW = wsh[3];
    const group = attrs.group || 1;
    const strides = attrs.strides || [1, 1];
    const pads = attrs.pads || [0, 0, 0, 0];
    const sh = strides[0], sw = strides[1];
    const pt = pads[0], pl = pads[1], pb = pads[2], pr = pads[3];
    const OH = Math.floor((H + pt + pb - KH) / sh) + 1;
    const OW = Math.floor((Wd + pl + pr - KW) / sw) + 1;
    const OCperG = OC / group;
    const out = new Float32Array(N * OC * OH * OW);
    // 快路径 1：1x1 卷积（无 padding、stride 1、普通分组）—— 网络里最耗时的一类
    if (KH === 1 && KW === 1 && sh === 1 && sw === 1 && pt === 0 && pl === 0 && group === 1) {
      const HW = H * Wd, OHW = OH * OW;
      for (let n = 0; n < N; n++) {
        const xb = n * C * HW, ob = n * OC * OHW;
        for (let oc = 0; oc < OC; oc++) {
          const bias = B ? B.data[oc] : 0;
          const wb = oc * ICg;
          for (let ic = 0; ic < ICg; ic++) {
            const xo = xb + ic * HW, wv = w[wb + ic];
            if (wv === 0) continue;
            const oo = ob + oc * OHW;
            for (let p = 0; p < OHW; p++) out[oo + p] += x[xo + p] * wv;
          }
          const oo2 = ob + oc * OHW;
          for (let p = 0; p < OHW; p++) out[oo2 + p] += bias;
        }
      }
      return { data: out, shape: [N, OC, OH, OW] };
    }
    // 快路径 2：depthwise 3x3（group === C）
    if (group === C && OC === C && KH === 3 && KW === 3) {
      for (let n = 0; n < N; n++) {
        for (let c = 0; c < C; c++) {
          const bias = B ? B.data[c] : 0;
          const wb = c * 9;
          for (let oh = 0; oh < OH; oh++) {
            for (let ow = 0; ow < OW; ow++) {
              let sum = bias;
              for (let kh = 0; kh < 3; kh++) {
                const ih = oh * sh - pt + kh;
                if (ih < 0 || ih >= H) continue;
                for (let kw = 0; kw < 3; kw++) {
                  const iw = ow * sw - pl + kw;
                  if (iw < 0 || iw >= Wd) continue;
                  sum += x[((n * C + c) * H + ih) * Wd + iw] * w[wb + kh * 3 + kw];
                }
              }
              out[((n * OC + c) * OH + oh) * OW + ow] = sum;
            }
          }
        }
      }
      return { data: out, shape: [N, OC, OH, OW] };
    }
    for (let n = 0; n < N; n++) {
      for (let oc = 0; oc < OC; oc++) {
        const g = Math.floor(oc / OCperG);
        const bias = B ? B.data[oc] : 0;
        for (let oh = 0; oh < OH; oh++) {
          for (let ow = 0; ow < OW; ow++) {
            let sum = bias;
            for (let ic = 0; ic < ICg; ic++) {
              const icc = g * ICg + ic;
              for (let kh = 0; kh < KH; kh++) {
                const ih = oh * sh - pt + kh;
                if (ih < 0 || ih >= H) continue;
                for (let kw = 0; kw < KW; kw++) {
                  const iw = ow * sw - pl + kw;
                  if (iw < 0 || iw >= Wd) continue;
                  sum += x[((n * C + icc) * H + ih) * Wd + iw] * w[((oc * ICg + ic) * KH + kh) * KW + kw];
                }
              }
            }
            out[((n * OC + oc) * OH + oh) * OW + ow] = sum;
          }
        }
      }
    }
    return { data: out, shape: [N, OC, OH, OW] };
  }

  function globalAveragePool(A) {
    const [N, C, H, W] = A.shape;
    const out = new Float32Array(N * C);
    const per = H * W;
    for (let n = 0; n < N; n++) {
      for (let c = 0; c < C; c++) {
        let s = 0;
        const base = (n * C + c) * per;
        for (let i = 0; i < per; i++) s += A.data[base + i];
        out[n * C + c] = s / per;
      }
    }
    return { data: out, shape: [N, C, 1, 1] };
  }

  function reduce(A, mode, axes) {
    const rank = A.shape.length;
    // ONNX 允许负轴（如 [-2,-1]），先归一化成正轴
    let ax = (axes && axes.length ? axes.slice() : [0]).map(function (a) { return a < 0 ? a + rank : a; });
    ax.sort(function (a, b) { return a - b; });
    const shape = A.shape.slice();
    const src = A.data;
    const kept = [];
    for (let i = 0; i < shape.length; i++) if (ax.indexOf(i) < 0) kept.push(shape[i]);
    const outSize = shapeSize(kept);
    const out = mode === 'max' ? new Float32Array(outSize).fill(-Infinity) : new Float32Array(outSize);
    const strides = new Array(rank);
    for (let i = rank - 1, s = 1; i >= 0; i--) { strides[i] = s; s *= shape[i]; }
    const total = shapeSize(shape);
    for (let f = 0; f < total; f++) {
      let rem = f, oi = 0;
      for (let i = 0; i < rank; i++) {
        const c = Math.floor(rem / strides[i]); rem -= c * strides[i];
        if (ax.indexOf(i) < 0) { oi = oi * shape[i] + c; }
      }
      if (mode === 'max') { if (src[f] > out[oi]) out[oi] = src[f]; }
      else out[oi] += src[f];
    }
    if (mode === 'mean') {
      const count = total / (outSize || 1);
      for (let i = 0; i < outSize; i++) out[i] /= count;
    }
    return { data: out, shape: kept };
  }

  function concat(list, axis) {
    const shape = list[0].shape.slice();
    let outer = 1, inner = 1;
    for (let i = 0; i < axis; i++) outer *= shape[i];
    for (let i = axis + 1; i < shape.length; i++) inner *= shape[i];
    let totalAxis = 0;
    list.forEach(function (t) { totalAxis += t.shape[axis]; });
    const outShape = shape.slice(); outShape[axis] = totalAxis;
    const out = new Float32Array(outer * totalAxis * inner);
    let cursor = 0;
    for (let o = 0; o < outer; o++) {
      for (let li = 0; li < list.length; li++) {
        const t = list[li], a = t.shape[axis], n = a * inner;
        out.set(t.data.subarray(o * n, o * n + n), cursor);
        cursor += n;
      }
    }
    return { data: out, shape: outShape };
  }

  function gemm(A, W, B, attrs) {
    // A: [M,K]（把任意形状按行 flatten），W: [N,K]（transB=1 时）或 [K,N]
    const transB = attrs.transB ? 1 : 0;
    let M = 1, K = A.data.length;
    const dims = A.shape.filter(function (d) { return d !== 1; });
    if (dims.length >= 2) { M = dims[0]; K = A.data.length / M; } else { M = 1; K = A.data.length; }
    const N = transB ? W.shape[0] : W.shape[1];
    const out = new Float32Array(M * N);
    for (let m = 0; m < M; m++) {
      for (let nIdx = 0; nIdx < N; nIdx++) {
        let s = 0;
        for (let k = 0; k < K; k++) {
          const wv = transB ? W.data[nIdx * K + k] : W.data[k * N + nIdx];
          s += A.data[m * K + k] * wv;
        }
        out[m * N + nIdx] = s * (attrs.alpha || 1);
      }
    }
    if (B) for (let i = 0; i < out.length; i++) out[i] += (attrs.beta === undefined ? 1 : attrs.beta) * B.data[i];
    return { data: out, shape: [M, N] };
  }

  // 图级优化：把 Sigmoid → Mul(x, sigmoid(x)) 融合成一步 SiLU（网络里有 19 处）
  function optimize(graph) {
    const skip = {};
    for (let i = 0; i < graph.steps.length - 1; i++) {
      const a = graph.steps[i], b = graph.steps[i + 1];
      if (a.op === 'Sigmoid' && b.op === 'Mul') {
        const sig = a.out[0], x = a.in[0];
        if (b.in.indexOf(sig) >= 0 && b.in.indexOf(x) >= 0) {
          a.op = 'Silu';
          a.in = [x];
          a.out = [sig, b.out[0]];   // 一个张量同时占两个名字，下游引用哪个都能取到
          skip[i + 1] = true;
        }
      }
    }
    graph.steps = graph.steps.filter(function (_, i) { return !skip[i]; });
    return graph;
  }

  function OcecNet(graph, weights) {
    this.graph = graph;
    this.w = weights;   // Float32Array 视图
  }

  OcecNet.fromBuffers = function (graphJson, weightBuffer) {
    const graph = typeof graphJson === 'string' ? JSON.parse(graphJson) : graphJson;
    optimize(graph);
    const w = weightBuffer instanceof Float32Array ? weightBuffer : new Float32Array(weightBuffer);
    return new OcecNet(graph, w);
  };

  OcecNet.prototype.tensor = function (ref) {
    if (ref.values) {
      return { data: Float32Array.from(ref.values), shape: ref.shape };
    }
    const shape = ref.shape, n = shapeSize(shape);
    const off = ref.off / 4;   // 字节偏移 → float 下标
    return { data: this.w.subarray(off, off + n), shape: shape };
  };

  // 取某个算子的第 idx 个输入：优先取上游张量，其次取该算子的常量
  OcecNet.prototype.inputOf = function (T, st, idx) {
    const name = st.in[idx];
    if (T[name]) return T[name];
    if (st.consts && st.consts[name]) return this.tensor(st.consts[name]);
    throw new Error('缺少输入张量: ' + name + '（算子 ' + st.op + '）');
  };

  OcecNet.prototype.run = function (inputNCHW) {
    const T = { };
    const g = this.graph;
    T[g.input.name] = { data: inputNCHW, shape: g.input.shape.slice() };
    for (let i = 0; i < g.steps.length; i++) {
      const st = g.steps[i];
      const A = this.inputOf(T, st, 0);
      let out;
      switch (st.op) {
        case 'Conv': out = conv(A, this.tensor(st.w), st.b ? this.tensor(st.b) : null, st.attrs); break;
        case 'Sigmoid': out = unary(function (v) { return 1 / (1 + Math.exp(-v)); }, A); break;
        case 'Silu': out = unary(function (v) { return v / (1 + Math.exp(-v)); }, A); break;
        case 'Relu': out = unary(function (v) { return v > 0 ? v : 0; }, A); break;
        case 'Mul': out = elementwise(function (a, b) { return a * b; }, A, this.inputOf(T, st, 1)); break;
        case 'Add': out = elementwise(function (a, b) { return a + b; }, A, this.inputOf(T, st, 1)); break;
        case 'GlobalAveragePool': out = globalAveragePool(A); break;
        case 'ReduceMean': out = reduce(A, 'mean', st.attrs.axes); break;
        case 'ReduceMax': out = reduce(A, 'max', st.attrs.axes); break;
        case 'Concat': out = concat(st.in.map((nm) => (T[nm] || (st.consts && this.tensor(st.consts[nm])))), st.attrs.axis === undefined ? 1 : st.attrs.axis); break;
        case 'Gemm': out = gemm(A, this.tensor(st.w), st.b ? this.tensor(st.b) : null, st.attrs); break;
        case 'Squeeze': {
          const shape = A.shape.filter(function (d) { return d !== 1; });
          out = { data: A.data, shape: shape.length ? shape : [1] };
          break;
        }
        default: throw new Error('未实现的算子: ' + st.op);
      }
      T[st.out[0]] = out;
      for (let k = 1; k < st.out.length; k++) T[st.out[k]] = out;   // 融合后可能有多名别名
    }
    const y = T[g.output.name];
    return y.data[0];
  };

  global.OcecNet = OcecNet;
  if (typeof module !== 'undefined' && module.exports) module.exports = OcecNet;
})(typeof window !== 'undefined' ? window : globalThis);
