/**
 * verify-video.mjs — 用一个真实的本地视频文件跑一遍完整流水线
 *
 *   node tools/verify-video.mjs                    # 自动挑工作区里最大的视频
 *   node tools/verify-video.mjs "D:\path\to.mp4"
 *   node tools/verify-video.mjs --seek 60,90,120
 *
 * 会启动本地服务器 + 无头 Edge，通过 HTTP Range 拉流（大文件 moov 在尾部时尤其关键），
 * 解码 → 采样 → 字符映射 → 截图，并把结果写到 tests/out/。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'tests', 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pickVideo() {
  const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (explicit) return resolve(explicit);
  const files = readdirSync(ROOT)
    .filter((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f))
    .map((f) => join(ROOT, f))
    .sort((a, b) => statSync(b).size - statSync(a).size);
  if (!files.length) throw new Error('工作区里没有视频文件，请显式传路径');
  return files[0];
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => res(new CDP(ws)));
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });
  }
  send(method, params = {}, timeout = 180000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, timeout);
    });
  }
}

async function main() {
  const video = pickVideo();
  const seeks = arg('seek', '60,90,120').split(',').map(Number);
  const sizeMB = statSync(video).size / 1048576;
  if (!existsSync(video)) throw new Error(`文件不存在: ${video}`);
  mkdirSync(OUT, { recursive: true });
  console.log(`源视频: ${basename(video)}  (${sizeMB.toFixed(1)} MB)`);

  // 1. 服务器
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--port', '0'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((res, rej) => {
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /DSH_SERVER_PORT=(\d+)/.exec(buf);
      if (m) res(Number(m[1]));
    });
    setTimeout(() => rej(new Error('服务器启动超时')), 10000);
  });
  console.log(`服务器: http://127.0.0.1:${port}/`);

  // 2. 浏览器
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(existsSync);
  if (!edge) throw new Error('找不到 Edge');
  const profile = mkdtempSync(join(tmpdir(), 'ascii-verify-'));
  const headed = process.argv.includes('--headed');
  const playSec = Number(arg('play', '5'));
  const browser = spawn(edge, [
    ...(headed ? [] : ['--headless=new']),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900',
    // 有头模式下窗口可能被遮挡/失焦，浏览器会因此限制帧回调，量出来的帧率会偏低
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(headed ? ['--window-position=0,0'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`浏览器模式: ${headed ? '有头（真实合成器 / 硬件解码）' : '无头（软件解码）'}`);

  const portFile = join(profile, 'DevToolsActivePort');
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    if (existsSync(portFile)) {
      try {
        const p = Number(readFileSync(portFile, 'utf8').split('\n')[0]); // 可能正被浏览器写入
        const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
        wsUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || null;
      } catch { /* 还没起来 */ }
    }
  }
  if (!wsUrl) throw new Error('浏览器调试端口未就绪');

  const cdp = await CDP.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { if (await evalJs('!!window.__ASCII__')) break; } catch { /* 加载中 */ }
  }

  // 3. 通过 HTTP 载入真实文件（Range 拉流）
  // 路径要相对服务器根目录，否则子目录里的文件会 404
  const rel = relative(ROOT, video).split(sep).map(encodeURIComponent).join('/');
  const url = '/' + rel;
  const t0 = Date.now();
  const info = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 120, rows: 40, autoRows: false, engine: 'layered', colorMode: 'color', autoPerf: false });
    await A.loadUrl(${JSON.stringify(url)});
    const v = document.getElementById('video');
    const st = A.getStats();
    return { width: st.canvasW, height: st.canvasH, source: A.getStats().sourceKind,
             videoW: v.videoWidth, videoH: v.videoHeight, duration: v.duration,
             buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 };
  })()`);
  console.log(`载入完成 ${((Date.now() - t0) / 1000).toFixed(1)}s · 视频 ${info.videoW}×${info.videoH} · 时长 ${info.duration.toFixed(1)}s · 已缓冲 ${info.buffered.toFixed(1)}s`);

  const rows = [];
  for (const t of seeks) {
    const r = await evalJs(`(async () => {
      const A = window.__ASCII__;
      const t0 = performance.now();
      await A.seek(${t});
      const seekMs = performance.now() - t0;
      A.renderOnce();
      const st = A.getStats();
      const lines = A.getFrameLines();
      const text = lines.join('');
      const distinct = new Set(text.split('')).size;
      let spaces = 0;
      for (const ch of text) if (ch === ' ') spaces++;
      const t1 = performance.now();
      for (let i = 0; i < 20; i++) A.renderOnce();
      const frameMs = (performance.now() - t1) / 20;
      return { t: ${t}, seekMs, frameMs, cols: st.cols, rows: st.rows, distinct,
               spaceRatio: spaces / text.length, tainted: st.tainted,
               mediaTime: document.getElementById('video').currentTime,
               head: lines.slice(0, 8).join('\\n') };
    })()`);
    rows.push(r);
    console.log(`  t=${String(t).padStart(5)}s  定位 ${r.seekMs.toFixed(0)}ms · 渲染 ${r.frameMs.toFixed(1)}ms/帧 · 字形 ${r.distinct} 种 · 暗部 ${(r.spaceRatio * 100).toFixed(1)}% · ${r.tainted ? '画布被污染!' : '像素可读'}`);
  }

  // 4. 真实播放：连续播 N 秒，量实际刷新率、丢帧、内存增长
  const playback = [];
  for (const [cols, rows2] of [[120, 40], [200, 60]]) {
    const r = await evalJs(`(async () => {
      const A = window.__ASCII__;
      const v = document.getElementById('video');
      A.setOptions({ cols: ${cols}, rows: ${rows2}, autoRows: false, engine: 'layered',
                     targetFps: 30, autoPerf: false, colorMode: 'color' });
      await A.seek(0.5);
      const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      const st0 = A.getStats();
      const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const t0 = performance.now();
      await A.play();
      await new Promise((res) => setTimeout(res, ${playSec * 1000}));
      const elapsed = (performance.now() - t0) / 1000;
      const st = A.getStats();
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      const mediaTime = v.currentTime;
      A.pause();
      return {
        cols: ${cols}, rows: ${rows2}, elapsed,
        fps: (st.frames - st0.frames) / elapsed,
        rendered: st.frames - st0.frames,
        skipped: st.skipped - st0.skipped,
        vfc: st.vfc - st0.vfc,
        loopStarts: st.loopStarts - st0.loopStarts,
        playEvents: st.playEvents - st0.playEvents,
        wasPaused: st0.pausedNow,
        renderMs: st.renderEma,
        tDraw: st.tDraw, tRead: st.tRead, tSource: st.tSource, tMap: st.tMap,
        mediaTime,
        drift: mediaTime - (0.5 + elapsed),
        audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
        videoDropped: q && q0 ? q.droppedVideoFrames - q0.droppedVideoFrames : null,
        videoTotal: q && q0 ? q.totalVideoFrames - q0.totalVideoFrames : null,
        heapDeltaMB: (heap1 - heap0) / 1048576,
        paused: v.paused,
      };
    })()`);
    playback.push(r);
    console.log(`  ${String(r.cols).padStart(3)}×${String(r.rows).padEnd(3)} 播放 ${r.elapsed.toFixed(2)}s → 字符刷新 ${r.fps.toFixed(1)} fps（渲染 ${r.rendered} 帧 / 丢帧 ${r.skipped}）· ` +
      `rVFC 回调 ${r.vfc} · 循环重启 ${r.loopStarts} · play 事件 ${r.playEvents} · 起始 paused=${r.wasPaused} · ` +
      `渲染 ${r.renderMs.toFixed(1)}ms · 视频解码 ${r.videoTotal ?? '?'} 帧丢 ${r.videoDropped ?? '?'} · ` +
      `媒体时间 ${r.mediaTime.toFixed(2)}s（漂移 ${r.drift >= 0 ? '+' : ''}${r.drift.toFixed(2)}s）· 堆 ${r.heapDeltaMB >= 0 ? '+' : ''}${r.heapDeltaMB.toFixed(1)}MB`);
  }

  // 5. 截图（先切回 120×40 并定位到最后一个采样点，保证截图可比对）
  await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 120, rows: 40, autoRows: false, engine: 'layered' });
    await A.seek(${seeks[seeks.length - 1]});
  })()`);
  // HUD 内部按 220ms 节流刷新，等一拍再渲染，否则截图里的状态栏是上一阶段的旧值
  await sleep(400);
  const shotState = await evalJs(`(() => { const A = window.__ASCII__; A.renderOnce();
    const s = A.getStats(); return { cols: s.cols, rows: s.rows, engine: s.engine, cells: s.cols * s.rows }; })()`);
  console.log(`  截图状态: ${shotState.cols}×${shotState.rows}（${shotState.cells} 单元，${shotState.engine}）`);
  const rect = await evalJs(`(() => { const r = document.getElementById('stage').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const shotName = `source-${basename(video).replace(/[^\w.-]/g, '_').slice(0, 40)}-t${seeks[seeks.length - 1]}.png`;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  writeFileSync(join(OUT, shotName), Buffer.from(shot.data, 'base64'));

  writeFileSync(join(OUT, 'verify-video.json'),
    JSON.stringify({ video: basename(video), sizeMB, headed, info, seekSamples: rows, playback, shotState }, null, 2));

  console.log('\n字符画样例（前 8 行）：');
  console.log(rows[0].head.split('\n').map((l) => '  |' + l + '|').join('\n'));
  console.log(`\n截图: tests/out/${shotName}`);
  console.log(`报告: tests/out/verify-video.json`);

  const failures = [];
  for (const r of rows) {
    if (r.tainted) failures.push(`t=${r.t}s 画布被污染`);
    if (r.distinct < 5) failures.push(`t=${r.t}s 字形种类只有 ${r.distinct}`);
    if (r.cols !== 120) failures.push(`t=${r.t}s 列数异常 ${r.cols}`);
  }
  for (const p of playback) {
    // 先看解码器自己跟不跟得上：跟不上就不能拿刷新率去怪渲染
    const decodeOk = p.videoTotal ? 1 - p.videoDropped / p.videoTotal > 0.9 : true;
    if (decodeOk && p.fps < 25) failures.push(`${p.cols}×${p.rows} 播放刷新只有 ${p.fps.toFixed(1)} fps`);
    if (!decodeOk) {
      console.log(`  ⚠ ${p.cols}×${p.rows}：解码器跟不上（丢弃 ${p.videoDropped}/${p.videoTotal} 帧），刷新率受限于片源解码而非字符渲染`);
    }
    if (Math.abs(p.drift) > 0.5) failures.push(`${p.cols}×${p.rows} 音视频时钟漂移 ${p.drift.toFixed(2)}s`);
    if (p.heapDeltaMB > 60) failures.push(`${p.cols}×${p.rows} 播放期间堆增长 ${p.heapDeltaMB.toFixed(1)}MB`);
    if (p.renderMs > 33.3) failures.push(`${p.cols}×${p.rows} 渲染耗时 ${p.renderMs.toFixed(1)}ms 超出 30fps 预算`);
  }
  if (failures.length) {
    console.error('\n✖ 不符合预期：');
    failures.forEach((f) => console.error(`   · ${f}`));
    process.exitCode = 1;
  } else {
    console.log('\n✔ 真实视频全流程通过（定位 / 渲染 / 播放 / 音画时钟 / 内存）');
  }

  browser.kill();
  server.kill();
  await sleep(300);
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('验证失败：', e.stack || e);
  process.exit(2);
});
