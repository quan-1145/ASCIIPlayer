/**
 * unit.test.mjs — 纯计算层单元测试（node --test tests/）
 * 覆盖：亮度公式 / 字符映射 / 网格比例 / 颜色模式 / ANSI 导出 / 适配矩形
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LUMINANCE_WEIGHTS,
  CHARSETS,
  buildRamp,
  buildChannelLUT,
  computeGrid,
  computeRowsForCols,
  createFrameBuffer,
  mapFrame,
  frameToLines,
  frameToText,
  frameToAnsi,
  rgbToAnsi256,
  luminance255,
  clamp01,
} from '../src/ascii-core.js';
import { fitRect } from '../src/sources.js';

const RAMP = CHARSETS.classic.chars; // ' .:-=+*#%@'  index 0 = 空格
const IDENTITY = buildChannelLUT(0, 1, 1);

function solidRGB(n, r, g, b) {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function run(rgba, cols, rows, extra = {}) {
  const fb = createFrameBuffer(cols, rows);
  mapFrame(rgba, fb, {
    ramp: RAMP,
    lut: IDENTITY,
    colorMode: 'color',
    monoPacked: 0x35e07f,
    ...extra,
  });
  return fb;
}

/* ------------------------------ 亮度 ------------------------------ */
test('BT.601 权重之和为 1，且与文档一致', () => {
  assert.equal(LUMINANCE_WEIGHTS.r, 0.299);
  assert.equal(LUMINANCE_WEIGHTS.g, 0.587);
  assert.equal(LUMINANCE_WEIGHTS.b, 0.114);
  const sum = LUMINANCE_WEIGHTS.r + LUMINANCE_WEIGHTS.g + LUMINANCE_WEIGHTS.b;
  assert.ok(Math.abs(sum - 1) < 1e-12, `权重和应为 1，实际 ${sum}`);
});

test('纯色亮度：黑 0 / 白 255 / 单通道按权重比例', () => {
  assert.equal(luminance255(0, 0, 0), 0);
  assert.equal(luminance255(255, 255, 255), 255);
  assert.ok(Math.abs(luminance255(255, 0, 0) - 76.245) < 1e-9);
  assert.ok(Math.abs(luminance255(0, 255, 0) - 149.685) < 1e-9);
  assert.ok(Math.abs(luminance255(0, 0, 255) - 29.07) < 1e-9);
  // 绿色对亮度贡献最大
  assert.ok(luminance255(0, 255, 0) > luminance255(255, 0, 0));
  assert.ok(luminance255(255, 0, 0) > luminance255(0, 0, 255));
});

/* ------------------------------ 字符集 ------------------------------ */
test('字符集去重且可反相', () => {
  assert.equal(buildRamp('classic', '', false), ' .:-=+*#%@');
  assert.equal(buildRamp('classic', '', true), '@%#*+=-:. ');
  assert.equal(buildRamp('minimal', 'aaabbc', false), 'abc');
  assert.equal(buildRamp('classic', '', true).length, buildRamp('classic', '', false).length);
  // 未知字符集回落到默认
  assert.equal(buildRamp('nope', '', false), CHARSETS.classic.chars);
});

/* ------------------------------ 网格 ------------------------------ */
test('行数按容器比例与字符宽高比推导', () => {
  // 16:9 容器、120 列、字符宽高比 0.6 → 120 * 9/16 * 0.6 = 40.5 → 41
  assert.equal(computeRowsForCols(120, 1920, 1080, 0.6), 41);
  // 80 列 → 80 * 9/16 * 0.6 = 27
  assert.equal(computeRowsForCols(80, 1920, 1080, 0.6), 27);
  // 方形窗口、0.5 → 100 列 → 50 行
  assert.equal(computeRowsForCols(100, 1000, 1000, 0.5), 50);
  // 退化输入有保护
  assert.ok(computeRowsForCols(120, 0, 0, 0.6) >= 1);
});

test('computeGrid 保证单元格宽高比 ≈ charAspect', () => {
  const g = computeGrid({ canvasW: 1600, canvasH: 900, cols: 120, rows: 40, autoRows: true, charAspect: 0.6 });
  assert.equal(g.cols, 120);
  assert.ok(Math.abs(g.cellW / g.cellH - 0.6) < 0.02, `实际 ${g.cellW / g.cellH}`);
  // 关闭自适应时严格采用给定行数
  const g2 = computeGrid({ canvasW: 1600, canvasH: 900, cols: 120, rows: 40, autoRows: false, charAspect: 0.6 });
  assert.equal(g2.rows, 40);
  assert.equal(g2.cellW, 1600 / 120);
  assert.equal(g2.cellH, 900 / 40);
});

/* ------------------------------ 映射 ------------------------------ */
test('黑帧映射到空格，白帧映射到最亮字符', () => {
  const black = run(solidRGB(4, 0, 0, 0), 2, 2);
  assert.deepEqual(Array.from(black.rampIndex), [0, 0, 0, 0]);
  assert.equal(RAMP[0], ' ');

  const white = run(solidRGB(4, 255, 255, 255), 2, 2);
  assert.deepEqual(Array.from(white.rampIndex), [9, 9, 9, 9]);
  assert.equal(RAMP[9], '@');
});

test('中灰映射到字符集中间位置，且索引随亮度单调不减', () => {
  const idxOf = (v) => run(solidRGB(1, v, v, v), 1, 1).rampIndex[0];
  assert.equal(idxOf(0), 0);
  assert.equal(idxOf(128), 5); // round(128/255*9) = 5 → '+'
  assert.equal(idxOf(255), 9);
  let prev = -1;
  for (let v = 0; v <= 255; v += 5) {
    const k = idxOf(v);
    assert.ok(k >= prev, `亮度 ${v} 时索引回退了：${prev} → ${k}`);
    prev = k;
  }
});

test('真彩色模式保留原始色相', () => {
  const fb = run(solidRGB(1, 10, 200, 30), 1, 1);
  const p = fb.packed[0];
  assert.equal((p >>> 16) & 255, 10);
  assert.equal((p >>> 8) & 255, 200);
  assert.equal(p & 255, 30);
});

test('灰度模式输出 r=g=b=亮度', () => {
  const fb = run(solidRGB(1, 200, 100, 50), 1, 1, { colorMode: 'gray' });
  const p = fb.packed[0];
  const r = (p >>> 16) & 255;
  assert.equal(r, (p >>> 8) & 255);
  assert.equal(r, p & 255);
  assert.equal(r, Math.trunc(luminance255(200, 100, 50))); // 124
});

test('单色模式全部使用同一主题色', () => {
  const fb = run(solidRGB(3, 0, 0, 0), 3, 1, { colorMode: 'mono' });
  assert.deepEqual(Array.from(fb.packed), [0x35e07f, 0x35e07f, 0x35e07f]);
});

test('单字符集不会越界', () => {
  const fb = createFrameBuffer(2, 1);
  mapFrame(solidRGB(2, 255, 255, 255), fb, {
    ramp: '#', lut: IDENTITY, colorMode: 'color', monoPacked: 0,
  });
  assert.deepEqual(Array.from(fb.rampIndex), [0, 0]);
});

test('亮度/对比度/伽马查找表行为正确', () => {
  const id = buildChannelLUT(0, 1, 1);
  for (const v of [0, 1, 64, 128, 200, 255]) assert.equal(id[v], v);

  const bright = buildChannelLUT(1, 1, 1);
  assert.equal(bright[0], 255);
  assert.equal(bright[255], 255);

  const black = buildChannelLUT(-1, 1, 1);
  assert.equal(black[255], 0);

  const gamma2 = buildChannelLUT(0, 1, 2); // 提亮
  assert.ok(Math.abs(gamma2[128] - Math.round(Math.pow(128 / 255, 0.5) * 255)) <= 1);
  assert.ok(gamma2[128] > 128);

  const contrast2 = buildChannelLUT(0, 2, 1);
  // 以 0.5 为轴：128/255 略高于 0.5，所以放大后是 129 而不是 128
  assert.ok(Math.abs(contrast2[128] - 128) <= 1, `实际 ${contrast2[128]}`);
  assert.ok(contrast2[200] > 200);
  assert.ok(contrast2[50] < 50);
});

test('伽马会影响字符选择', () => {
  const dark = solidRGB(1, 60, 60, 60);
  const plain = run(dark, 1, 1, { lut: buildChannelLUT(0, 1, 1) }).rampIndex[0];
  const lifted = run(dark, 1, 1, { lut: buildChannelLUT(0, 1, 2) }).rampIndex[0];
  assert.ok(lifted > plain, `伽马 2 应提亮：${plain} → ${lifted}`);
});

/* ------------------------------ 导出 ------------------------------ */
test('frameToLines/Text 尺寸与网格一致', () => {
  const fb = run(solidRGB(6, 255, 255, 255), 3, 2);
  const lines = frameToLines(fb, RAMP);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, 3);
  assert.equal(lines[0], '@@@');
  assert.equal(frameToText(fb, RAMP), '@@@\n@@@');
});

test('frameToAnsi 输出 24 位真彩色转义序列', () => {
  const fb = run(solidRGB(2, 255, 0, 0), 2, 1);
  const ansi = frameToAnsi(fb, RAMP);
  assert.ok(ansi.includes('\u001b[38;2;255;0;0m'), ansi);
  assert.ok(ansi.endsWith('\u001b[0m'));
  // 空格不产生颜色转义，避免无意义输出
  const fb2 = run(solidRGB(1, 0, 0, 0), 1, 1);
  assert.equal(frameToAnsi(fb2, RAMP), ' \u001b[0m');
});

test('rgbToAnsi256 落在合法区间', () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [12, 200, 90]]) {
    const n = rgbToAnsi256(r, g, b);
    assert.ok(Number.isInteger(n) && n >= 16 && n <= 255, `${r},${g},${b} → ${n}`);
  }
});

/* ------------------------------ 适配 ------------------------------ */
test('fitRect：contain 留黑边 / cover 裁切 / stretch 拉伸', () => {
  const contain = fitRect(1920, 1080, 100, 100, 'contain');
  assert.equal(contain.w, 100);
  assert.equal(contain.h, 56.25);
  assert.equal(contain.y, 21.875);

  const cover = fitRect(1920, 1080, 100, 100, 'cover');
  assert.equal(cover.h, 100);
  assert.ok(cover.w > 100);
  assert.ok(cover.x < 0);

  assert.deepEqual(fitRect(1920, 1080, 100, 50, 'stretch'), { x: 0, y: 0, w: 100, h: 50 });
});

test('clamp01 边界', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(9), 1);
});
