#!/usr/bin/env node
/**
 * make-fixtures.mjs — 用本地 ffmpeg 生成测试素材
 *
 *   node tools/make-fixtures.mjs            # 缺什么补什么
 *   node tools/make-fixtures.mjs --force    # 全部重建
 *
 * 产出（tests/fixtures/）：
 *   bands.mp4          黑 | 灰 | 白 三条竖带，用于校验“亮度 → 字符”映射
 *   ramp.mp4           水平灰阶渐变，用于校验映射单调性
 *   badapple-6s.mp4    真实视频片段（含 AAC 音轨），用于端到端测试
 *   reference-*.png    对应时间点的原始画面，用于和字符画截图对比
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIX = join(ROOT, 'tests', 'fixtures');
const FORCE = process.argv.includes('--force');

const CANDIDATE_FFMPEG = [
  process.env.FFMPEG,
  'ffmpeg',
  'D:\\Apps\\mpv\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
].filter(Boolean);

function findFfmpeg() {
  for (const exe of CANDIDATE_FFMPEG) {
    const probe = spawnSync(exe, ['-hide_banner', '-version'], { stdio: 'ignore', shell: false });
    if (probe.status === 0) return exe;
  }
  throw new Error('找不到 ffmpeg，请设置环境变量 FFMPEG 指向可执行文件。');
}

function findSourceVideo() {
  const files = readdirSync(ROOT).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(ROOT, b)).size - statSync(join(ROOT, a)).size);
  return join(ROOT, files[0]);
}

function ff(exe, args, label) {
  process.stdout.write(`  · ${label}\n`);
  const r = spawnSync(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`${label} 失败（ffmpeg exit ${r.status}）`);
}

function need(path) {
  return FORCE || !existsSync(path);
}

function main() {
  const exe = findFfmpeg();
  mkdirSync(FIX, { recursive: true });
  console.log(`ffmpeg: ${exe}`);
  console.log(`输出目录: ${FIX}`);

  /* 1. 黑 / 灰 / 白 三条竖带 ------------------------------------------------ */
  const bands = join(FIX, 'bands.mp4');
  if (need(bands)) {
    ff(exe, [
      '-f', 'lavfi', '-i', 'color=c=black:s=480x270:r=10:d=2',
      '-vf',
      'drawbox=x=160:y=0:w=160:h=270:c=gray@1:t=fill,' +
        'drawbox=x=320:y=0:w=160:h=270:c=white@1:t=fill',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18',
      '-g', '10', '-movflags', '+faststart', bands,
    ], 'bands.mp4（黑|灰|白竖带）');
  } else {
    console.log('  = bands.mp4 已存在');
  }

  /* 2. 水平灰阶渐变 -------------------------------------------------------- */
  const ramp = join(FIX, 'ramp.mp4');
  if (need(ramp)) {
    try {
      ff(exe, [
        '-f', 'lavfi', '-i', 'color=c=black:s=480x270:r=10:d=2',
        '-vf', "format=yuv420p,geq=lum='255*X/W':cb=128:cr=128",
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18',
        '-g', '10', '-movflags', '+faststart', ramp,
      ], 'ramp.mp4（水平灰阶）');
    } catch (err) {
      console.warn(`  ! 跳过 ramp.mp4：${err.message}`);
    }
  } else {
    console.log('  = ramp.mp4 已存在');
  }

  /* 3. 真实视频片段 + 参考帧 ---------------------------------------------- */
  const src = findSourceVideo();
  if (!src) {
    console.warn('  ! 项目根目录下没有找到源视频，跳过真实片段生成。');
  } else {
    console.log(`源视频: ${src}`);
    const clip = join(FIX, 'badapple-6s.mp4');
    if (need(clip)) {
      ff(exe, [
        '-ss', '60', '-i', src, '-t', '6',
        '-vf', 'scale=640:360', '-r', '30',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '24', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart', clip,
      ], 'badapple-6s.mp4（640×360，含音轨）');
    } else {
      console.log('  = badapple-6s.mp4 已存在');
    }

    for (const t of [60, 62, 64]) {
      const png = join(FIX, `reference-${t}s.png`);
      if (!need(png)) {
        console.log(`  = reference-${t}s.png 已存在`);
        continue;
      }
      ff(exe, [
        '-ss', String(t), '-i', src, '-frames:v', '1',
        '-vf', 'scale=640:360', '-pix_fmt', 'rgb24', png,
      ], `reference-${t}s.png（原始画面参考）`);
    }
  }

  console.log('完成。');
}

main();
