/**
 * ascii-core.js — 纯计算层（无 DOM 依赖，可在 Node 中直接单元测试）
 *
 * 职责：
 *   1. 亮度计算        Y = 0.299R + 0.587G + 0.114B   (ITU-R BT.601)
 *   2. 亮度 → 字符映射 按字符集从暗到亮取索引
 *   3. 网格几何        根据容器尺寸 + 字符宽高比算出 cols × rows
 *   4. 颜色量化        真彩色 / 灰度 / 单色，以及 ANSI 24 位转义
 */

/** ITU-R BT.601 亮度权重 */
export const LUMINANCE_WEIGHTS = Object.freeze({ r: 0.299, g: 0.587, b: 0.114 });

/**
 * 内置字符集。索引 0 = 最暗（留白最多），末尾 = 最亮。
 * 这是 ASCII art 的“调色板”：暗处用空格，亮处用 @ / # / █。
 */
export const CHARSETS = Object.freeze({
  classic: { name: '经典 10 级  .:-=+*#%@', chars: ' .:-=+*#%@' },
  dense: {
    name: '细密 69 级',
    chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  },
  blocks: { name: '方块渐变  ░▒▓█', chars: ' ░▒▓█' },
  shade: { name: '明暗阶  ▁▂▃▄▅▆▇█', chars: ' ▁▂▃▄▅▆▇█' },
  digital: { name: '数字  .123456789', chars: ' .123456789' },
  minimal: { name: '极简  .:*#', chars: ' .:*#' },
  binary: { name: '二值（阈值）', chars: ' 1' },
});

export const DEFAULT_CHARSET = 'classic';
/** 等宽字符的“步进宽 / 字号”经验值；运行时会被真实测量值覆盖 */
export const DEFAULT_CHAR_ASPECT = 0.6;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 单像素亮度，返回 0..255 */
export function luminance255(r, g, b) {
  return LUMINANCE_WEIGHTS.r * r + LUMINANCE_WEIGHTS.g * g + LUMINANCE_WEIGHTS.b * b;
}

/** 单像素亮度，返回 0..1 */
export function luminanceNorm(r, g, b) {
  return luminance255(r, g, b) / 255;
}

/**
 * 字符集去重 + 可选反相。
 * 反相直接把字符序列倒过来，等价于暗↔亮互换，且不改变颜色。
 */
export function buildRamp(charsetKey, customCharset, invert) {
  let raw = typeof customCharset === 'string' && customCharset.length > 0
    ? customCharset
    : (CHARSETS[charsetKey] || CHARSETS[DEFAULT_CHARSET]).chars;
  // 去重保序：重复字符等于把某些亮度区间挤成同一个字形
  const seen = new Set();
  let out = '';
  for (const ch of raw) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out += ch;
    }
  }
  if (out.length === 0) out = CHARSETS[DEFAULT_CHARSET].chars;
  return invert ? [...out].reverse().join('') : out;
}

/**
 * 逐通道查找表：亮度 / 对比度 / 伽马。
 * brightness ∈ [-1, 1]，contrast ∈ [0, 2]，gamma ∈ (0, 4]（>1 提亮暗部）
 */
export function buildChannelLUT(brightness = 0, contrast = 1, gamma = 1) {
  const lut = new Uint8ClampedArray(256);
  const invG = 1 / (gamma > 0 ? gamma : 1);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = (v - 0.5) * contrast + 0.5 + brightness;
    v = clamp01(v);
    if (invG !== 1) v = Math.pow(v, invG);
    lut[i] = Math.round(v * 255);
  }
  return lut;
}

/**
 * 计算行数：让“字符单元”的宽高比等于 charAspect。
 *
 *   cellW = canvasW / cols, cellH = canvasH / rows
 *   要求 cellW / cellH = charAspect
 *   ⇒ rows = cols * (canvasH / canvasW) * charAspect
 *
 * 例：16:9 容器、120 列、等宽字符步进比 0.6 → 120 * 0.5625 * 0.6 ≈ 40 行。
 */
export function computeRowsForCols(cols, canvasW, canvasH, charAspect = DEFAULT_CHAR_ASPECT) {
  if (!(canvasW > 0) || !(canvasH > 0)) return Math.max(1, Math.round(cols * 0.5));
  const rows = Math.round(cols * (canvasH / canvasW) * charAspect);
  return clamp(rows, 1, 500);
}

/** 网格几何：列数/行数 → 单元格像素尺寸 */
export function computeGrid({ canvasW, canvasH, cols, rows, autoRows, charAspect }) {
  const c = clamp(Math.round(cols), 1, 500);
  const r = autoRows
    ? computeRowsForCols(c, canvasW, canvasH, charAspect)
    : clamp(Math.round(rows), 1, 500);
  return { cols: c, rows: r, cellW: canvasW / c, cellH: canvasH / r };
}

/** 单元格显存：字符索引 + 打包颜色（0xRRGGBB） */
export function createFrameBuffer(cols, rows) {
  const n = Math.max(1, cols * rows);
  return {
    cols,
    rows,
    rampIndex: new Uint8Array(n),
    packed: new Uint32Array(n),
  };
}

/**
 * 核心映射：源帧 RGBA → 每个字符单元的“字形索引 + 颜色”。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba 源采样数据，长度 cols*rows*4
 * @param {object} fb   createFrameBuffer() 的结果
 * @param {object} o    { ramp, lut, colorMode: 'color'|'gray'|'mono', monoPacked }
 */
export function mapFrame(rgba, fb, o) {
  const n = fb.cols * fb.rows;
  const ramp = o.ramp;
  const last = ramp.length - 1; // 单字符集时 last = 0，scale = 0，索引恒为 0
  const scale = last / 255;
  const lut = o.lut;
  const mode = o.colorMode || 'color';
  const mono = o.monoPacked >>> 0;
  const idx = fb.rampIndex;
  const packed = fb.packed;

  for (let i = 0; i < n; i++) {
    const p = i << 2;
    const r = lut[rgba[p]];
    const g = lut[rgba[p + 1]];
    const b = lut[rgba[p + 2]];
    const y = LUMINANCE_WEIGHTS.r * r + LUMINANCE_WEIGHTS.g * g + LUMINANCE_WEIGHTS.b * b;

    let k = (y * scale + 0.5) | 0;
    if (k > last) k = last; // y 恰好为 255 时的舍入保护
    idx[i] = k;

    if (mode === 'mono') {
      packed[i] = mono;
    } else if (mode === 'gray') {
      const v = y < 0 ? 0 : y > 255 ? 255 : y | 0;
      packed[i] = (v << 16) | (v << 8) | v;
    } else {
      packed[i] = (r << 16) | (g << 8) | b;
    }
  }
  return fb;
}

/** 帧缓冲 → 纯文本字符画（每行一个字符串的数组） */
export function frameToLines(fb, ramp) {
  const { cols, rows, rampIndex } = fb;
  const out = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let s = '';
    for (let c = 0; c < cols; c++) s += ramp[rampIndex[base + c]];
    out[r] = s;
  }
  return out;
}

/** 帧缓冲 → 文本（含换行） */
export function frameToText(fb, ramp) {
  return frameToLines(fb, ramp).join('\n');
}

/**
 * 帧缓冲 → ANSI 24 位真彩色文本。
 * 每格输出 \x1b[38;2;R;G;Bm + 字符，行尾复位。可直接粘进支持真彩色的终端。
 */
export function frameToAnsi(fb, ramp, { forceColor = true } = {}) {
  const { cols, rows, rampIndex, packed } = fb;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let s = '';
    let lastPacked = -1;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const ch = ramp[rampIndex[i]];
      if (ch === ' ') {
        s += ' ';
        lastPacked = -1;
        continue;
      }
      if (forceColor) {
        const p = packed[i];
        if (p !== lastPacked) {
          s += `\u001b[38;2;${(p >>> 16) & 255};${(p >>> 8) & 255};${p & 255}m`;
          lastPacked = p;
        }
      }
      s += ch;
    }
    out.push(s + '\u001b[0m');
  }
  return out.join('\n');
}

/** xterm 256 色号（Web-safe cube + 灰阶），用于导出/对比 */
export function rgbToAnsi256(r, g, b) {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** 打包的 0xRRGGBB → 每格颜色字符串缓存用的键 */
export function hexString(p) {
  return '#' + ((p | 0x1000000).toString(16).slice(1));
}
