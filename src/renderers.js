/**
 * renderers.js — 三种输出后端，都消费同一个 frameBuffer（rampIndex + packed）
 *
 *  1. LayeredCanvasRenderer  颜色层 × 字形层 相乘合成 —— 默认，最快
 *       ① 在 cols×rows 的小画布上 putImageData，得到“每格一像素”的颜色层
 *       ② 放大绘制到主画布（关闭插值）→ 每格成为一块纯色
 *       ③ 另一张同尺寸画布：黑底 + 白色字形（fillStyle 恒定）
 *       ④ 主画布 multiply 合成 → 字形被染成该格颜色，空格处相乘为黑
 *       相比逐格改 fillStyle，少了 N 次状态切换，30fps 下余量充足。
 *
 *  2. DirectCanvasRenderer   逐格 fillStyle + fillText —— 基线实现，便于对比
 *
 *  3. DomTextRenderer        真正的 <pre> 文本输出（单色），可选中、可复制
 */

import { DEFAULT_CHAR_ASPECT } from './ascii-core.js';

/** 测量等宽字体“步进宽 / 字号”，用于把字符塞满单元格 */
export function measureAdvanceRatio(fontFamily = 'monospace') {
  try {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext('2d');
    ctx.font = `100px ${fontFamily}`;
    const w = ctx.measureText('MMMMMMMMMM').width / 10 / 100;
    return w > 0.01 && w < 3 ? w : DEFAULT_CHAR_ASPECT;
  } catch {
    return DEFAULT_CHAR_ASPECT;
  }
}

/** 单元格像素尺寸决定字号：让字形宽度正好等于 cellW */
export function fontSizeForCell(cellW, advanceRatio) {
  return Math.max(1, cellW / (advanceRatio || DEFAULT_CHAR_ASPECT));
}

/* ------------------------------------------------------------------ *
 * 1. 分层合成（默认）
 * ------------------------------------------------------------------ */
export class LayeredCanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.colorCanvas = document.createElement('canvas');
    this.colorCtx = this.colorCanvas.getContext('2d', { alpha: false });
    this.glyphCanvas = document.createElement('canvas');
    // 注意：字形层必须保留 alpha 通道。不透明画布会让 Chrome 启用 LCD 亚像素抗锯齿，
    // 白字边缘会出现红/青彩边，再乘上颜色层就变成明显的彩色描边。
    this.glyphCtx = this.glyphCanvas.getContext('2d');
    this.image = null;
    this.id = 'layered';
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.glyphCanvas.width = w;
    this.glyphCanvas.height = h;
    this.ctx.imageSmoothingEnabled = false;
    const g = this.glyphCtx;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }

  _prepareColorLayer(fb) {
    if (this.colorCanvas.width !== fb.cols || this.colorCanvas.height !== fb.rows) {
      this.colorCanvas.width = fb.cols;
      this.colorCanvas.height = fb.rows;
      this.image = this.colorCtx.createImageData(fb.cols, fb.rows);
      const d = this.image.data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255; // 一次性写满 alpha
    }
  }

  draw(fb, o) {
    const { cols, rows } = fb;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // ① 颜色层：每格一个像素
    this._prepareColorLayer(fb);
    const d = this.image.data;
    const packed = fb.packed;
    for (let i = 0, j = 0; i < packed.length; i++, j += 4) {
      const p = packed[i];
      d[j] = (p >>> 16) & 255;
      d[j + 1] = (p >>> 8) & 255;
      d[j + 2] = p & 255;
    }
    this.colorCtx.putImageData(this.image, 0, 0);

    // ② 字形层：黑底白字
    const g = this.glyphCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000000';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    g.font = o.font;

    const idx = fb.rampIndex;
    const ramp = o.ramp;
    const spaceIndex = ramp.indexOf(' ');
    const cw = o.cellW;
    const ch = o.cellH;
    for (let r = 0; r < rows; r++) {
      const y = r * ch + ch * 0.5;
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const k = idx[base + c];
        if (k === spaceIndex) continue;
        g.fillText(ramp[k], c * cw + cw * 0.5, y);
      }
    }

    // ③ 合成：颜色 × 字形
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.colorCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.glyphCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ------------------------------------------------------------------ *
 * 2. 直接逐格绘制（基线 / 对比用）
 * ------------------------------------------------------------------ */
export class DirectCanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cache = new Map();
    this.id = 'direct';
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.cache.clear();
  }

  _css(p) {
    let s = this.cache.get(p);
    if (s === undefined) {
      if (this.cache.size > 8192) this.cache.clear();
      s = `rgb(${(p >>> 16) & 255},${(p >>> 8) & 255},${p & 255})`;
      this.cache.set(p, s);
    }
    return s;
  }

  draw(fb, o) {
    const { cols, rows } = fb;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = o.background || '#000000';
    ctx.fillRect(0, 0, W, H);
    ctx.font = o.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const idx = fb.rampIndex;
    const packed = fb.packed;
    const ramp = o.ramp;
    const spaceIndex = ramp.indexOf(' ');
    const cw = o.cellW;
    const ch = o.cellH;
    for (let r = 0; r < rows; r++) {
      const y = r * ch + ch * 0.5;
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = base + c;
        const k = idx[i];
        if (k === spaceIndex) continue;
        ctx.fillStyle = this._css(packed[i]);
        ctx.fillText(ramp[k], c * cw + cw * 0.5, y);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. DOM 文本层（真·字符输出，单色）
 * ------------------------------------------------------------------ */
export class DomTextRenderer {
  constructor(pre) {
    this.pre = pre;
    this.id = 'dom';
    this.lastText = '';
    this.lastColor = '';
  }

  resize(w, h) {
    /* 尺寸由 layout() 通过 CSS 控制 */
  }

  /** 让 DOM 文本的行距/字距与 canvas 网格对齐 */
  layout(cellW, cellH, advanceRatio, color) {
    const fs = cellH;
    const adv = (advanceRatio || DEFAULT_CHAR_ASPECT) * fs;
    this.pre.style.fontSize = `${fs}px`;
    this.pre.style.lineHeight = `${cellH}px`;
    this.pre.style.letterSpacing = `${(cellW - adv).toFixed(3)}px`;
    if (color !== this.lastColor) {
      this.pre.style.color = color;
      this.lastColor = color;
    }
  }

  draw(fb, o) {
    const { cols, rows, rampIndex } = fb;
    const ramp = o.ramp;
    let s = '';
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) s += ramp[rampIndex[base + c]];
      if (r < rows - 1) s += '\n';
    }
    if (s !== this.lastText) {
      this.pre.textContent = s;
      this.lastText = s;
    }
  }
}

export function createRenderer(kind, canvas, pre) {
  if (kind === 'direct') return new DirectCanvasRenderer(canvas);
  if (kind === 'dom') return new DomTextRenderer(pre);
  return new LayeredCanvasRenderer(canvas);
}
