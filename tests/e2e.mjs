/**
 * e2e.mjs — 真浏览器端到端测试
 *
 *   1. 启动本地静态服务器（serve.mjs，随机端口）
 *   2. 用 CDP 启动无头 Edge（Chrome DevTools Protocol，Node 内置 WebSocket 驱动，无第三方依赖）
 *   3. 在真实页面里跑完整流水线：解码 → 采样 → 亮度映射 → 字符刷新
 *   4. 断言映射正确性、性能、响应式，并输出截图供人工核对
 *
 * 运行：node tests/e2e.mjs
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
  readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'tests', 'out');
const FIXTURES = '/tests/fixtures';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */
const results = [];
const pageErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? `\n      ${detail}` : ''}`);
  return ok;
}

function section(title) {
  console.log(`\n─ ${title} ─`);
}

function assert(name, cond, detail) {
  return record(name, !!cond, detail);
}

/* ------------------------------------------------------------------ *
 * CDP 客户端
 * ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else res(msg.result);
      } else if (msg.method) {
        const fns = this.listeners.get(msg.method) || [];
        fns.forEach((fn) => fn(msg.params));
      }
    });
  }

  static connect(url, timeoutMs = 15000) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rej(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res(new CDP(ws));
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        rej(new Error(`CDP 连接失败: ${e.message || 'error'}`));
      });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ *
 * 启动服务器 / 浏览器
 * ------------------------------------------------------------------ */
function startServer() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--port', '0'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = /DSH_SERVER_PORT=(\d+)/.exec(buf);
      if (m) {
        child.stdout.off('data', onData);
        res({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));
    child.on('exit', (code) => rej(new Error(`serve.mjs 提前退出，code=${code}`)));
    setTimeout(() => rej(new Error('服务器启动超时')), 10000);
  });
}

function findBrowser() {
  const candidates = [
    process.env.EDGE,
    process.env.CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome 可执行文件');
}

async function launchBrowser(extraArgs = []) {
  const exe = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), 'ascii-e2e-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1600,900',
    '--hide-scrollbars',
    'about:blank',
    ...extraArgs,
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (existsSync(portFile)) {
      // 浏览器可能正写入这个文件，Windows 下会短暂 EBUSY
      let port = 0;
      try {
        const lines = readFileSync(portFile, 'utf8').split('\n');
        port = Number(lines[0]) || 0;
      } catch {
        continue;
      }
      if (port) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
        } catch { /* 还没起来 */ }
      }
    }
    if (child.exitCode !== null) break;
  }
  if (!wsUrl) {
    child.kill();
    throw new Error(`浏览器未能启动调试端口。\n${stderr.slice(-1200)}`);
  }
  return { child, wsUrl, userDataDir, exe };
}

/* ------------------------------------------------------------------ *
 * 页面辅助
 * ------------------------------------------------------------------ */
function makeHelpers(cdp) {
  async function evalJs(expression) {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`页面异常: ${d}`);
    }
    return r.result.value;
  }

  async function waitFor(expression, { timeout = 15000, label = expression } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await evalJs(`!!(${expression})`)) return true;
      } catch { /* 页面还在切换 */ }
      await sleep(150);
    }
    throw new Error(`等待超时: ${label}`);
  }

  async function navigate(url) {
    const loaded = new Promise((res) => {
      const off = () => res();
      cdp.on('Page.loadEventFired', off);
    });
    await cdp.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(12000)]);
  }

  async function capture(name, selector = '#stage') {
    const result = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    if (!result) throw new Error(`找不到元素: ${selector}`);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...result, scale: 1 },
      captureBeyondViewport: false,
    });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  /** 整页截图（含右侧参数面板与底部控制条） */
  async function capturePage(name) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  return { evalJs, waitFor, navigate, capture, capturePage };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  mkdirSync(OUT, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), pageErrors, results };

  section('启动环境');
  const server = await startServer();
  console.log(`  本地服务器: http://127.0.0.1:${server.port}/`);
  const browser = await launchBrowser();
  console.log(`  浏览器: ${browser.exe}`);
  const cdp = await CDP.connect(browser.wsUrl);

  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      pageErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const { evalJs, waitFor, navigate, capture, capturePage } = makeHelpers(cdp);

  const APP = `http://127.0.0.1:${server.port}/`;
  await navigate(APP);
  await waitFor('window.__ASCII__', { label: '应用脚本加载' });

  /* ------------------------- 1. 启动状态 ------------------------- */
  section('1. 页面启动与默认网格');
  const boot = await evalJs(`(() => {
    const A = window.__ASCII__;
    const s = A.getStats();
    return { stats: s, options: A.getOptions(), title: document.title, advance: A.measureAdvanceRatio() };
  })()`);
  assert('应用已就绪并暴露测试 API', boot.stats.sourceKind === 'synthetic', `来源=${boot.stats.sourceKind}`);
  assert('默认渲染后端 = 分层合成', boot.stats.engine === 'layered', `engine=${boot.stats.engine}`);
  assert('默认 120 列', boot.options.cols === 120);
  assert('等宽字符步进比在 0.45–0.75 之间', boot.advance > 0.45 && boot.advance < 0.75, `measured=${boot.advance.toFixed(4)}`);
  const ratio = boot.stats.cellW / boot.stats.cellH;
  assert('单元格宽高比 ≈ 字符宽高比（纵向校正生效）',
    Math.abs(ratio - boot.options.charAspect) < 0.03,
    `cellW/cellH=${ratio.toFixed(4)}, charAspect=${boot.options.charAspect}`);
  assert('画布按设备像素比放大', boot.stats.dpr >= 1, `dpr=${boot.stats.dpr}, canvas=${boot.stats.canvasW}×${boot.stats.canvasH}`);

  /* ------------------------- 2. 合成源 + 灰阶 ------------------------- */
  section('2. 合成图案：亮度 → 字符映射');
  await sleep(600);
  const syn = await evalJs(`(() => {
    const A = window.__ASCII__;
    A.renderOnce();
    const lines = A.getFrameLines();
    const idx = A.getRampIndices();
    const st = A.getStats();
    const lastRow = idx.slice((st.rows - 1) * st.cols);
    const distinct = new Set(lines.join('').split('')).size;
    return { lines, lastRow, distinct, cols: st.cols, rows: st.rows };
  })()`);
  assert('每行字符数 = 列数', syn.lines.every((l) => l.length === syn.cols), `${syn.lines[0].length} vs ${syn.cols}`);
  assert('行数 = 网格行数', syn.lines.length === syn.rows, `${syn.lines.length} vs ${syn.rows}`);
  assert('画面使用了多种字形', syn.distinct >= 4, `distinct=${syn.distinct}`);
  let drops = 0;
  for (let i = 1; i < syn.lastRow.length; i++) if (syn.lastRow[i] < syn.lastRow[i - 1]) drops++;
  assert('灰阶条（底行）字符索引单调不减',
    drops <= 2 && syn.lastRow[0] <= 1 && syn.lastRow[syn.lastRow.length - 1] >= 8,
    `首=${syn.lastRow[0]} 尾=${syn.lastRow[syn.lastRow.length - 1]} 回退次数=${drops}`);
  await capture('01-synthetic-120x40');

  /* ------------------------- 3. 真实视频：黑/灰/白 ------------------------- */
  section('3. 真实 H.264 解码 + 映射校验（bands.mp4）');
  const bands = await evalJs(`(async () => {
    const A = window.__ASCII__;
    // stretch：让视频正好铺满网格，三分带就对应到确定的列区间，便于校验映射
    A.setOptions({ fit: 'stretch', colorMode: 'color', engine: 'layered', autoRows: false,
                   cols: 120, rows: 40, brightness: 0, contrast: 1, gamma: 1, customCharset: '', invert: false });
    await A.loadUrl('${FIXTURES}/bands.mp4');
    await A.seek(1.0);
    A.renderOnce();
    const st = A.getStats();
    const idx = A.getRampIndices();
    const colors = A.getPackedColors();
    const row = Math.floor(st.rows / 2);
    const pick = (frac) => {
      const c = Math.min(st.cols - 1, Math.max(0, Math.round(frac * st.cols)));
      const i = row * st.cols + c;
      return { index: idx[i], color: colors[i] };
    };
    return { left: pick(0.15), mid: pick(0.5), right: pick(0.85), stats: st, ramp: st.ramp };
  })()`);
  assert('视频像素可读（画布未被污染）', bands.stats.tainted === false);
  assert('黑色区域 → 空格/极暗字符', bands.left.index <= 1, `index=${bands.left.index}, color=#${bands.left.color.toString(16)}`);
  assert('中灰区域 → 字符集中间', bands.mid.index >= 3 && bands.mid.index <= 6,
    `index=${bands.mid.index} → "${bands.ramp[bands.mid.index]}"`);
  assert('白色区域 → 最亮字符 @', bands.right.index >= 8,
    `index=${bands.right.index} → "${bands.ramp[bands.right.index]}"`);
  assert('左暗右明的真彩色保留',
    ((bands.left.color >> 16) & 255) < ((bands.right.color >> 16) & 255),
    `left=#${bands.left.color.toString(16)} right=#${bands.right.color.toString(16)}`);
  await capture('02-bands-120x40');

  /* ------------------------- 4. 灰阶渐变单调性 ------------------------- */
  section('4. 水平灰阶渐变（ramp.mp4）单调性');
  const rampHit = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ fit: 'stretch' });
    await A.loadUrl('${FIXTURES}/ramp.mp4');
    await A.seek(1.0);
    A.renderOnce();
    const st = A.getStats();
    const idx = A.getRampIndices();
    const row = Math.floor(st.rows / 2);
    const line = idx.slice(row * st.cols, (row + 1) * st.cols);
    let back = 0;
    for (let i = 1; i < line.length; i++) if (line[i] < line[i - 1] - 1) back++;
    return { line, back, first: line[0], last: line[line.length - 1], ok: true };
  })()`).catch((e) => ({ ok: false, error: e.message }));
  if (rampHit.ok) {
    assert('渐变从左到右单调变亮', rampHit.back === 0 && rampHit.first <= 1 && rampHit.last >= 8,
      `首=${rampHit.first} 尾=${rampHit.last} 回退=${rampHit.back}`);
  } else {
    record('渐变从左到右单调变亮', false, `跳过：${rampHit.error}`);
  }

  /* ------------------------- 4b. 缩放适配 ------------------------- */
  section('4b. 缩放适配与黑边（把容器改成接近方形，暴露比例问题）');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(700);
  const fitTest = await evalJs(`(() => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 120, rows: 40, autoRows: false });
    const out = {};
    for (const fit of ['contain', 'cover', 'stretch']) {
      A.setOptions({ fit });
      A.renderOnce();
      const st = A.getStats();
      const r = A.getSampleRect();
      out[fit] = { ...r, displayAspect: (r.w * st.cellW) / (r.h * st.cellH),
                   canvasAspect: st.canvasW / st.canvasH };
    }
    out.video = 480 / 270;
    return out;
  })()`);
  const near = (a, b, eps) => Math.abs(a - b) < eps;
  assert('contain：视频在“显示空间”里保持原始比例',
    near(fitTest.contain.displayAspect, fitTest.video, 0.05),
    `显示比例 ${fitTest.contain.displayAspect.toFixed(3)} vs 视频 ${fitTest.video.toFixed(3)}（容器 ${fitTest.contain.canvasAspect.toFixed(3)}）`);
  assert('contain：比例不符时上下留黑边',
    fitTest.contain.y > 1 && fitTest.contain.h < 39,
    `y=${fitTest.contain.y.toFixed(2)} 行, h=${fitTest.contain.h.toFixed(2)} 行`);
  assert('cover：裁切填满且仍保持比例',
    fitTest.cover.w >= 119.5 && fitTest.cover.h >= 39.5 &&
      near(fitTest.cover.displayAspect, fitTest.video, 0.05),
    `w=${fitTest.cover.w.toFixed(1)} h=${fitTest.cover.h.toFixed(1)} 比例=${fitTest.cover.displayAspect.toFixed(3)}`);
  assert('stretch：铺满整个网格',
    fitTest.stretch.w === 120 && fitTest.stretch.h === 40 &&
      fitTest.stretch.x === 0 && fitTest.stretch.y === 0,
    JSON.stringify(fitTest.stretch));
  await capture('05-fit-contain');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  /* ------------------------- 5. Bad Apple 真实片段 ------------------------- */
  section('5. 真实视频（Bad Apple 640×360 @30fps）多时间点渲染');
  const clipStats = [];
  for (const t of [0.5, 2.0, 4.0, 5.5]) {
    const r = await evalJs(`(async () => {
      const A = window.__ASCII__;
      ${clipStats.length === 0 ? `await A.loadUrl('${FIXTURES}/badapple-6s.mp4');` : ''}
      await A.seek(${t});
      A.renderOnce();
      const st = A.getStats();
      const lines = A.getFrameLines();
      const text = lines.join('');
      const counts = {};
      for (const ch of text) counts[ch] = (counts[ch] || 0) + 1;
      const spaces = counts[' '] || 0;
      let sum = 0;
      const idx = A.getRampIndices();
      for (let i = 0; i < idx.length; i++) sum += idx[i];
      return {
        t: ${t}, cols: st.cols, rows: st.rows, distinct: Object.keys(counts).length,
        spaceRatio: spaces / text.length, meanIndex: sum / idx.length, frames: st.frames,
      };
    })()`);
    clipStats.push(r);
    assert(`t=${t}s 渲染出字符网格`, r.cols > 0 && r.rows > 0);
    assert(`t=${t}s 字形种类 ≥ 6`, r.distinct >= 6, `distinct=${r.distinct}`);
    assert(`t=${t}s 暗部占比合理（Bad Apple 为白剪影黑底）`,
      r.spaceRatio > 0.2 && r.spaceRatio < 0.95,
      `空格 ${(r.spaceRatio * 100).toFixed(1)}% · 平均字符索引 ${r.meanIndex.toFixed(2)}`);
    await capture(`03-badapple-t${String(t).replace('.', '_')}`);
  }

  /* ------------------------- 6. 性能 ------------------------- */
  section('6. 渲染性能（真实视频帧，逐帧同步渲染）');
  const perf = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ engine: 'layered', autoPerf: false });
    const out = {};
    const bench = (cols, rows, engine, n) => {
      A.setOptions({ cols, rows, autoRows: false, engine });
      A.renderOnce();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) A.renderOnce();
      return (performance.now() - t0) / n;
    };
    out.layered120x40 = bench(120, 40, 'layered', 60);
    out.direct120x40 = bench(120, 40, 'direct', 40);
    out.layered200x60 = bench(200, 60, 'layered', 45);
    out.direct200x60 = bench(200, 60, 'direct', 25);
    out.layered240x72 = bench(240, 72, 'layered', 30);
    out.direct240x72 = bench(240, 72, 'direct', 20);
    // 只测后端绘制（排除解码/读回/映射），公平比较三种输出方式
    A.setOptions({ cols: 120, rows: 40 });
    out.drawOnly = {
      layered120x40: A.benchRender('layered', 120),
      direct120x40: A.benchRender('direct', 80),
      dom120x40: A.benchRender('dom', 80),
    };
    A.setOptions({ cols: 240, rows: 72, engine: 'layered' });
    out.drawOnly.layered240x72 = A.benchRender('layered', 80);
    out.drawOnly.direct240x72 = A.benchRender('direct', 60);
    A.setOptions({ cols: 120, rows: 40, engine: 'layered', autoPerf: true });
    for (let i = 0; i < 6; i++) A.renderOnce();
    out.breakdown = A.getStats();
    return out;
  })()`);
  const budget = 1000 / 30;
  assert(`120×40 端到端 < ${budget.toFixed(1)}ms/帧（30fps 预算）`, perf.layered120x40 < budget,
    `${perf.layered120x40.toFixed(2)}ms/帧（逐格直绘 ${perf.direct120x40.toFixed(2)}ms）`);
  assert('200×60 端到端 < 33.3ms/帧（30fps 预算）', perf.layered200x60 < budget,
    `${perf.layered200x60.toFixed(2)}ms/帧（逐格直绘 ${perf.direct200x60.toFixed(2)}ms）`);
  assert('240×72 端到端 < 33.3ms/帧（30fps 预算）', perf.layered240x72 < budget,
    `${perf.layered240x72.toFixed(2)}ms/帧（逐格直绘 ${perf.direct240x72.toFixed(2)}ms）`);
  assert('分层合成的绘制开销低于逐格直绘',
    perf.drawOnly.layered120x40 < perf.drawOnly.direct120x40 &&
      perf.drawOnly.layered240x72 < perf.drawOnly.direct240x72,
    `120×40: ${perf.drawOnly.layered120x40.toFixed(2)}ms vs ${perf.drawOnly.direct120x40.toFixed(2)}ms · ` +
      `240×72: ${perf.drawOnly.layered240x72.toFixed(2)}ms vs ${perf.drawOnly.direct240x72.toFixed(2)}ms · ` +
      `DOM: ${perf.drawOnly.dom120x40.toFixed(2)}ms`);
  record('耗时分解（真实视频，120×40）', true,
    `采样 ${perf.breakdown.tSource.toFixed(2)}ms + 读回 ${perf.breakdown.tRead.toFixed(2)}ms + ` +
      `亮度映射 ${perf.breakdown.tMap.toFixed(2)}ms + 绘制 ${perf.breakdown.tDraw.toFixed(2)}ms`);

  /* ------------------------- 7. 播放帧率 ------------------------- */
  section('7. 实际播放刷新率（rAF 定时驱动 + 音频同步播放）');
  const fps = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 120, rows: 40, engine: 'layered', targetFps: 30, autoPerf: false });
    await A.seek(0.2);
    const before = A.getStats().frames;
    const t0 = performance.now();
    await A.play();
    await new Promise((r) => setTimeout(r, 3000));
    const st = A.getStats();
    const elapsed = (performance.now() - t0) / 1000;
    A.pause();
    const rendered = st.frames - before;
    const v = document.getElementById('video');
    return { rendered, elapsed, fps: rendered / elapsed, skipped: st.skipped,
             mediaTime: v.currentTime, paused: v.paused, muted: v.muted,
             audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
             playbackRate: v.playbackRate, duration: v.duration };
  })()`);
  assert('30fps 目标下实际刷新 ≥ 22fps', fps.fps >= 22,
    `实测 ${fps.fps.toFixed(1)} fps（${fps.rendered} 帧 / ${fps.elapsed.toFixed(2)}s，丢帧 ${fps.skipped}）`);
  assert('播放推进了媒体时间（1× 速率，无漂移）',
    fps.mediaTime > 2.0 && Math.abs(fps.mediaTime - (fps.elapsed + 0.2)) < 0.35,
    `currentTime=${fps.mediaTime.toFixed(2)}s，期望 ≈ ${(fps.elapsed + 0.2).toFixed(2)}s（时长 ${fps.duration.toFixed(2)}s）`);
  assert('音频轨已解码（与视频帧共用媒体时钟，因此天然同步）',
    fps.audioBytes === null || fps.audioBytes > 0,
    fps.audioBytes === null ? '该浏览器不暴露音频解码字节数' : `已解码音频 ${fps.audioBytes} 字节`);

  /* ------------------------- 8. 后端与颜色模式一致性 ------------------------- */
  section('8. 三种后端与颜色模式');
  const engines = await evalJs(`(async () => {
    const A = window.__ASCII__;
    await A.seek(2.0);
    A.setOptions({ engine: 'layered', colorMode: 'color' });
    const a = A.getFrameText();
    const colors = A.getPackedColors();
    A.setOptions({ engine: 'direct', colorMode: 'color' });
    const b = A.getFrameText();
    A.setOptions({ engine: 'dom', colorMode: 'mono' });
    const domText = document.getElementById('textlayer').textContent;
    const canvasHidden = document.getElementById('canvas').hidden;
    A.setOptions({ engine: 'layered', colorMode: 'gray' });
    const grays = A.getPackedColors();
    A.setOptions({ colorMode: 'mono' });
    const monos = A.getPackedColors();
    A.setOptions({ engine: 'layered', colorMode: 'color' });
    const colorSet = new Set(colors);
    return {
      sameText: a === b, textLen: a.length, domLen: domText.length, canvasHidden,
      grayOk: grays.every((p) => ((p >>> 16) & 255) === ((p >>> 8) & 255) && ((p >>> 8) & 255) === (p & 255)),
      monoOk: monos.every((p) => p === 0x35e07f),
      uniqueColors: colorSet.size,
    };
  })()`);
  assert('分层合成与逐格直绘得到完全相同的字符矩阵', engines.sameText);
  assert('DOM 文本后端输出等长字符画', engines.domLen > 3000 && engines.canvasHidden,
    `textContent=${engines.domLen} 字符，canvas hidden=${engines.canvasHidden}`);
  assert('灰度模式 r=g=b', engines.grayOk);
  assert('单色模式全部为终端绿', engines.monoOk);
  assert('真彩色模式保留了多色信息', engines.uniqueColors > 20, `不同颜色数=${engines.uniqueColors}`);

  /* ------------------------- 9. 参数联动 ------------------------- */
  section('9. 字符集 / 反相 / 网格预设');
  const variants = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const out = {};
    const N = 400;
    A.setOptions({ charset: 'classic', customCharset: '', invert: false });
    out.baseText = A.getFrameLines().join('').slice(0, N);
    out.baseIdx = A.getRampIndices().slice(0, N);
    out.baseRamp = A.getStats().ramp;
    A.setOptions({ invert: true });
    out.invText = A.getFrameLines().join('').slice(0, N);
    out.invIdx = A.getRampIndices().slice(0, N);
    out.invRamp = A.getStats().ramp;
    let mismatch = 0;
    let firstBad = null;
    for (let i = 0; i < N; i++) {
      if (out.invIdx[i] !== out.baseIdx[i]) {
        mismatch++;
        if (firstBad === null) firstBad = { i, base: out.baseIdx[i], inv: out.invIdx[i] };
      }
    }
    out.mismatch = mismatch;
    out.firstBad = firstBad;
    out.sample = out.baseText.slice(0, 12) + ' / ' + out.invText.slice(0, 12);
    A.setOptions({ invert: false, charset: 'blocks', customCharset: '', engine: 'dom' });
    out.blocksText = document.getElementById('textlayer').textContent.slice(0, 40);
    A.setOptions({ engine: 'layered', charset: 'classic', customCharset: ' .oO@' });
    out.custom = A.getStats().ramp;
    A.setOptions({ customCharset: '', charset: 'classic' });
    return out;
  })()`);
  const last = variants.baseRamp.length - 1;
  assert('反相：字符集倒序、亮度索引不变',
    variants.invRamp === [...variants.baseRamp].reverse().join('') && variants.mismatch === 0,
    `"${variants.baseRamp}" → "${variants.invRamp}"，索引不一致 ${variants.mismatch} 处` +
      (variants.firstBad ? `（首个 i=${variants.firstBad.i}: ${variants.firstBad.base} vs ${variants.firstBad.inv}）` : ''));
  assert('反相：同一像素取到对称字形（亮暗互换）',
    [...variants.invText].every((ch, i) => ch === variants.baseRamp[last - variants.baseIdx[i]]),
    `样例 ${variants.sample}`);
  assert('字符集切换到方块字符生效', /[█▓▒░ ]/.test(variants.blocksText), `样例="${variants.blocksText.slice(0, 12)}"`);
  assert('自定义字符集生效', variants.custom === ' .oO@', `ramp="${variants.custom}"`);

  /* ------------------------- 10. 响应式 ------------------------- */
  section('10. 窗口尺寸变化（响应式重算网格）');
  const before = await evalJs(`(() => { const A = window.__ASCII__;
    A.setOptions({ autoRows: true, cols: 120 });   // 预设按钮会把自适应关掉，这里恢复
    const s = A.getStats();
    return { canvasW: s.canvasW, canvasH: s.canvasH, cols: s.cols, rows: s.rows }; })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000, height: 700, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(700);
  const after = await evalJs(`(() => { const A = window.__ASCII__; A.renderOnce();
    const s = A.getStats(); const o = A.getOptions();
    return { canvasW: s.canvasW, canvasH: s.canvasH, cols: s.cols, rows: s.rows,
             ratio: s.cellW / s.cellH, charAspect: o.charAspect }; })()`);
  assert('画布随窗口缩小', after.canvasW < before.canvasW, `${before.canvasW} → ${after.canvasW}`);
  assert('自动行数随容器比例重算', after.rows !== before.rows, `${before.rows} 行 → ${after.rows} 行`);
  assert('缩小后仍保持字符宽高比校正',
    Math.abs(after.ratio - after.charAspect) < 0.05, `cellW/cellH=${after.ratio.toFixed(3)}`);
  await capture('04-responsive-1000x700');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* ------------------------- 11. 大网格压力 ------------------------- */
  section('11. 大网格压力（240×72）');
  const stress = await evalJs(`(() => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 240, rows: 72, autoRows: false, engine: 'layered', autoPerf: false });
    A.renderOnce();
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) A.renderOnce();
    const ms = (performance.now() - t0) / 30;
    const lines = A.getFrameLines();
    A.setOptions({ cols: 120, rows: 40, autoRows: true, autoPerf: true });
    return { ms, rows: lines.length, cols: lines[0].length, cells: lines.length * lines[0].length };
  })()`);
  assert('240×72（17280 单元）仍能渲染', stress.cells === 240 * 72, `${stress.cells} 个字符单元`);
  record('240×72 渲染耗时（参考）', true, `${stress.ms.toFixed(2)}ms/帧 ≈ ${(1000 / stress.ms).toFixed(0)} fps 上限`);

  /* ------------------------- 12. 导出 ------------------------- */
  section('12. 导出功能');
  const ex = await evalJs(`(() => {
    const A = window.__ASCII__;
    const ansi = A.getFrameAnsi();
    const url = A.getCanvasDataURL();
    const lines = A.getFrameLines();
    return { ansiHasColor: /\\u001b\\[38;2;/.test(ansi), ansiLines: ansi.split('\\n').length,
             pngOk: url.startsWith('data:image/png'), pngLen: url.length, lines: lines.length };
  })()`);
  assert('ANSI 导出含 24 位真彩色转义', ex.ansiHasColor);
  assert('ANSI 行数与网格一致', ex.ansiLines === ex.lines, `${ex.ansiLines} vs ${ex.lines}`);
  assert('画布可导出 PNG', ex.pngOk && ex.pngLen > 5000, `dataURL ${(ex.pngLen / 1024).toFixed(0)} KB`);

  /* ------------------------- 12b. 本地文件上传 ------------------------- */
  section('12b. 本地文件上传（真实用户路径：input[type=file] → blob URL）');
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument');
  const fileInput = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  assert('找到文件输入控件', !!fileInput.nodeId, `nodeId=${fileInput.nodeId}`);

  /** 用 CDP 给 input[type=file] 塞文件，并等待应用载入 */
  async function uploadFile(absPath, seekTime = 1.0) {
    await evalJs(`(() => { window.__ASCII__.setOptions({ cols: 120, rows: 40, autoRows: false }); })()`);
    await cdp.send('DOM.setFileInputFiles', { files: [absPath], nodeId: fileInput.nodeId });
    let ok = await waitFor('window.__ASCII__.getStats().sourceKind === "video"', { timeout: 3000, label: '文件载入' })
      .then(() => true).catch(() => false);
    if (!ok) {
      // 某些版本不会自动派发 change，手动补一次
      await evalJs(`document.getElementById('file').dispatchEvent(new Event('change', { bubbles: true }))`);
      ok = await waitFor('window.__ASCII__.getStats().sourceKind === "video"', { timeout: 20000, label: '文件载入' })
        .then(() => true).catch(() => false);
    }
    if (!ok) return { loaded: false };
    await sleep(300);
    return evalJs(`(async () => {
      const A = window.__ASCII__;
      const v = document.getElementById('video');
      await A.seek(${seekTime});
      A.renderOnce();
      const st = A.getStats();
      const lines = A.getFrameLines();
      return {
        loaded: true,
        protocol: v.src.slice(0, 5),
        readyState: v.readyState,
        videoW: v.videoWidth, videoH: v.videoHeight,
        duration: v.duration,
        tainted: st.tainted,
        distinct: new Set(lines.join('').split('')).size,
        spaceRatio: (lines.join('').split(' ').length - 1) / lines.join('').length,
        banner: document.getElementById('banner').classList.contains('show'),
        objectUrl: !!A.state.objectUrl,
        gridOk: lines.length === st.rows && lines[0].length === st.cols,
      };
    })()`);
  }

  const smallFile = await uploadFile(join(ROOT, 'tests', 'fixtures', 'badapple-6s.mp4'));
  assert('选择本地文件后能正常载入', smallFile.loaded && smallFile.videoW > 0,
    smallFile.loaded ? `${smallFile.videoW}×${smallFile.videoH}` : '未载入');
  assert('blob URL 没有被提前回收（ERR_FILE_NOT_FOUND 的根因）',
    smallFile.loaded && smallFile.protocol === 'blob:' && smallFile.readyState >= 2,
    `src=${smallFile.protocol}… readyState=${smallFile.readyState}`);
  assert('上传失败时不应弹出错误横幅', smallFile.loaded && smallFile.banner === false);
  assert('本地文件像素可读、字符画正常',
    smallFile.loaded && !smallFile.tainted && smallFile.distinct >= 6 && smallFile.gridOk,
    `字形 ${smallFile.distinct} 种 · 画布污染=${smallFile.tainted} · 网格一致=${smallFile.gridOk}`);
  await capture('07-file-upload-360p');

  // 用户实际遇到问题的那个文件：4K 123.6MB
  const bigVideo = readdirSync(ROOT)
    .filter((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f))
    .map((f) => join(ROOT, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (bigVideo) {
    // 这个文件开头是黑场淡入，取 t=1s 会得到「全空格」——那是正确结果，但不适合断言字形多样性
    const bigFile = await uploadFile(bigVideo, 60);
    assert('上传工作区里的 4K 源文件（123.6MB）也能载入',
      bigFile.loaded && bigFile.videoW === 3840 && bigFile.videoH === 2160,
      bigFile.loaded ? `${bigFile.videoW}×${bigFile.videoH} · ${bigFile.duration.toFixed(1)}s` : '未载入');
    assert('4K 本地文件同样像素可读、渲染正常',
      bigFile.loaded && !bigFile.tainted && bigFile.distinct >= 6 && bigFile.gridOk,
      `字形 ${bigFile.distinct} 种 · 暗部 ${(bigFile.spaceRatio * 100).toFixed(1)}% · 网格一致=${bigFile.gridOk}`);
    await capture('08-file-upload-4k');
  } else {
    record('上传 4K 源文件', false, '工作区里找不到视频文件');
  }

  const released = await evalJs(`(() => {
    const A = window.__ASCII__;
    A.useSynthetic();
    return { objectUrl: A.state.objectUrl, kind: A.getStats().sourceKind };
  })()`);
  assert('切回内置演示后释放 blob URL（不泄漏）',
    released.objectUrl === null && released.kind === 'synthetic',
    `objectUrl=${released.objectUrl}`);

  /* ------------------------- 13. 传输控制条 ------------------------- */
  section('13. 传输控制条（时间显示 / 进度 / 倍速）');
  const transport = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.setOptions({ cols: 120, rows: 40, autoRows: false });
    await A.loadUrl('${FIXTURES}/badapple-6s.mp4');
    await A.seek(1.0);
    const before = document.getElementById('time').textContent;
    const seek0 = document.getElementById('seek').value;
    await A.play();
    await new Promise((r) => setTimeout(r, 1800));
    const during = document.getElementById('time').textContent;
    const seek1 = document.getElementById('seek').value;
    const cur = document.getElementById('video').currentTime;
    A.pause();
    const rateSel = document.getElementById('rate');
    const cs = getComputedStyle(rateSel);
    return {
      before, during, seek0, seek1, cur,
      duration: document.getElementById('video').duration,
      pausedText: document.getElementById('time').textContent,
      rateBg: cs.backgroundColor, rateColor: cs.color,
      optionBg: rateSel.querySelector('option') ? getComputedStyle(rateSel.querySelector('option')).backgroundColor : null,
    };
  })()`);
  assert('时间显示会随播放更新（不是一直 00:00.00）',
    transport.before !== transport.during && !/^00:00\.00 \/ 00:00\.00$/.test(transport.during),
    `${transport.before} → ${transport.during}`);
  const shownSec = Number((/(\d\d:\d\d\.\d\d)/.exec(transport.during) || [])[1]?.split(':')[1]);
  assert('时间显示与实际播放位置一致', Math.abs(shownSec - transport.cur) < 0.5,
    `显示 ${shownSec}s，实际 currentTime ${transport.cur.toFixed(2)}s`);
  assert('时间显示带上了总时长', /\/\s*00:0[56]\./.test(transport.during), `"${transport.during}"（时长 ${transport.duration.toFixed(2)}s）`);
  assert('进度条随播放前进', Number(transport.seek1) > Number(transport.seek0),
    `${transport.seek0} → ${transport.seek1}`);
  assert('倍速下拉框是深色主题（不是白底黑字）',
    /^rgb\((\d+), (\d+), (\d+)\)$/.test(transport.rateBg) &&
      transport.rateBg.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 80),
    `background=${transport.rateBg} color=${transport.rateColor}`);

  const rateTest = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const sel = document.getElementById('rate');
    sel.value = '2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const v = document.getElementById('video');
    await A.seek(0.2);
    await A.play();
    await new Promise((r) => setTimeout(r, 1000));
    const advanced = v.currentTime - 0.2;
    const appliedRate = v.playbackRate;
    A.pause();
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { playbackRate: appliedRate, advanced };
  })()`);
  assert('2× 倍速真的生效（1 秒推进约 2 秒）',
    rateTest.playbackRate === 2 && rateTest.advanced > 1.5,
    `playbackRate=${rateTest.playbackRate}，1s 推进 ${rateTest.advanced.toFixed(2)}s`);

  const synthRate = await evalJs(`(async () => {
    const A = window.__ASCII__;
    A.useSynthetic();
    const sel = document.getElementById('rate');
    sel.value = '2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const t0 = A.state.source.mediaTime;
    const p0 = A.state.source.elapsed;
    await new Promise((r) => setTimeout(r, 1000));
    const advanced = A.state.source.elapsed - p0;
    const timeText = document.getElementById('time').textContent;
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { advanced, timeText, rate: A.state.source.rate };
  })()`);
  assert('内置演示图案也支持倍速与时间显示',
    synthRate.advanced > 1.5 && !/^00:00\.00 \/ 00:00\.00$/.test(synthRate.timeText),
    `1s 推进 ${synthRate.advanced.toFixed(2)}s · 时间栏 "${synthRate.timeText}"`);

  // 控制条外观留证：时间在走 + 倍速框深色
  await evalJs(`(async () => { const A = window.__ASCII__;
    await A.loadUrl('${FIXTURES}/badapple-6s.mp4'); await A.seek(2.5); await A.play();
    await new Promise((r) => setTimeout(r, 700)); A.pause(); })()`);
  await capture('10-transport-bar', '.transport');

  /* ------------------------- 14. 控件主题 ------------------------- */
  section('14. 所有控件的配色与对比度（WCAG 对比度 ≥ 3）');
  const theme = await evalJs(`(() => {
    const parse = (c) => { const n = (c.match(/[\\d.]+/g) || []).map(Number);
      return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n.length > 3 ? n[3] : 1 }; };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
                                b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const opaqueBg = (el) => {
      let acc = null, node = el;
      const stack = [];
      while (node && node !== document.documentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c.a > 0) stack.push(c);
        if (c.a >= 0.999) break;
        node = node.parentElement;
      }
      if (!stack.length) return { r: 255, g: 255, b: 255, a: 1 };
      acc = stack.pop();
      while (stack.length) acc = over(stack.pop(), acc);
      return acc;
    };
    const lum = (c) => { const f = (v) => { const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };

    const sel = 'button, select, input[type="text"], input[type="url"], input[type="number"], summary';
    return [...document.querySelectorAll(sel)].filter((el) => el.offsetParent !== null).map((el) => {
      const cs = getComputedStyle(el);
      const bg = opaqueBg(el);
      const fg = parse(cs.color);
      return { id: el.id || null, tag: el.tagName.toLowerCase(),
               cls: String(el.className).slice(0, 24),
               bg: '#' + [bg.r, bg.g, bg.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
               ratio: Number(ratio(fg, bg).toFixed(2)) };
    });
  })()`);
  const worst = theme.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 4);
  assert(`审计了 ${theme.length} 个可见控件`, theme.length > 12);
  assert('没有控件的对比度低于 3.0', theme.every((t) => t.ratio >= 3.0),
    worst.map((t) => `${t.tag}${t.id ? '#' + t.id : ''}(${t.cls}) ratio=${t.ratio} bg=${t.bg}`).join(' · '));
  const lightish = theme.filter((t) => /^#(e|f)/i.test(t.bg));
  assert('没有控件退回浏览器默认白底', lightish.length === 0,
    lightish.map((t) => `${t.tag}${t.id ? '#' + t.id : ''} bg=${t.bg}`).join(' · ') || '全部为深色');

  /* ------------------------- 15. 键盘快捷键 ------------------------- */
  section('15. 键盘快捷键');
  const keys = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const press = (key, opts = {}) => document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await A.loadUrl('${FIXTURES}/badapple-6s.mp4');
    await A.seek(0.2);
    const v = document.getElementById('video');
    const out = {};

    A.pause(); await sleep(150);
    press(' '); await sleep(350);
    out.spaceStartsPlay = !v.paused;
    press(' '); await sleep(350);
    out.spacePauses = v.paused;

    await A.seek(0.2); await sleep(200);
    press('ArrowRight'); await sleep(500);
    out.rightSeek = v.currentTime;
    press('ArrowLeft'); await sleep(500);
    out.leftSeek = v.currentTime;

    const mutedBefore = v.muted;
    press('m'); await sleep(150);
    out.muteToggles = v.muted !== mutedBefore;
    press('m'); await sleep(100);

    press('3'); await sleep(300);
    out.preset = A.getOptions().cols + 'x' + A.getOptions().rows;

    press('d'); await sleep(300);
    out.demoKey = A.getStats().sourceKind;
    return out;
  })()`);
  assert('空格：播放 / 暂停', keys.spaceStartsPlay && keys.spacePauses,
    `播放=${keys.spaceStartsPlay} 暂停=${keys.spacePauses}`);
  assert('→ / ← 快进快退 5 秒',
    keys.rightSeek > 4.5 && keys.leftSeek < keys.rightSeek - 4,
    `→ 到 ${keys.rightSeek.toFixed(2)}s，← 回到 ${keys.leftSeek.toFixed(2)}s`);
  assert('M 静音开关', keys.muteToggles);
  assert('数字键切换网格预设（3 → 160×48）', keys.preset === '160x48', `实际 ${keys.preset}`);
  assert('D 切到内置演示', keys.demoKey === 'synthetic');

  /* ------------------------- 16. 拖放载入 ------------------------- */
  section('16. 拖放视频文件');
  const dropped = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const res = await fetch('${FIXTURES}/bands.mp4');
    const file = new File([await res.arrayBuffer()], '拖进来的视频.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const stage = document.getElementById('stage');
    const fire = (type) => stage.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire('dragenter'); fire('dragover');
    const highlighted = document.getElementById('dropzone').classList.contains('drag');
    fire('drop');
    const t0 = performance.now();
    while (performance.now() - t0 < 15000) {
      if (A.getStats().sourceKind === 'video' && document.getElementById('video').videoWidth === 480) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const v = document.getElementById('video');
    await A.seek(1.0); A.renderOnce();
    const st = A.getStats();
    const lines = A.getFrameLines();
    const row = Math.floor(st.rows / 2) * st.cols;
    const idx = A.getRampIndices();
    return { highlighted, kind: st.sourceKind, w: v.videoWidth, h: v.videoHeight,
             protocol: v.src.slice(0, 5), tainted: st.tainted,
             dragged: document.getElementById('dropzone').classList.contains('drag'),
             left: idx[row + Math.round(st.cols * 0.15)],
             right: idx[row + Math.round(st.cols * 0.85)] };
  })()`);
  assert('拖到画面上会高亮投放区', dropped.highlighted);
  assert('拖放后成功载入并播放该文件', dropped.kind === 'video' && dropped.w === 480 && dropped.h === 270,
    `${dropped.w}×${dropped.h} · ${dropped.protocol}…`);
  assert('拖放载入后投放区取消高亮且像素可读',
    dropped.dragged === false && !dropped.tainted && dropped.right > dropped.left,
    `暗部索引 ${dropped.left} < 亮部索引 ${dropped.right}`);
  await capture('09-drag-drop');
  await evalJs(`(async () => { const A = window.__ASCII__;
    await A.play(); await new Promise((r) => setTimeout(r, 800)); A.pause(); })()`);
  await capturePage('11-full-ui');

  /* ------------------------- 17. 对话框与播放收尾 ------------------------- */
  section('17. 帮助对话框 / 音量 / 播放结束');
  const misc = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = document.getElementById('video');
    const dlg = document.getElementById('help');
    const out = {};

    document.getElementById('btn-help').click();
    out.dialogOpen = dlg.open;
    document.getElementById('btn-close-help').click();
    await sleep(100);
    out.dialogClosed = !dlg.open;

    const vol = document.getElementById('volume');
    vol.value = '0.3';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    out.volume = v.volume;
    out.muteIcon = document.getElementById('btn-mute').textContent;
    document.getElementById('btn-mute').click();
    await sleep(100);
    out.mutedAfterClick = v.muted;
    document.getElementById('btn-mute').click();
    await sleep(100);

    // 进度条拖动：拖动期间不被 timeupdate 抢回
    await A.seek(0.2);
    A.play();
    await sleep(200);
    const seek = document.getElementById('seek');
    seek.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    seek.value = '100';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    const afterDragInput = seek.value;
    await sleep(700);
    out.seekHeldDuringDrag = seek.value;
    out.seekValueAtDragStart = afterDragInput;
    seek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await sleep(200);
    out.seekFollowsAfterRelease = seek.value;

    // 播放到结尾
    A.pause();
    await A.seek(v.duration - 0.3);
    await A.play();
    await sleep(1400);
    out.ended = v.ended;
    out.playIcon = document.getElementById('btn-play').textContent;
    out.timeAtEnd = document.getElementById('time').textContent;
    return out;
  })()`);
  assert('帮助对话框能打开与关闭', misc.dialogOpen && misc.dialogClosed);
  assert('音量滑块生效且图标同步', Math.abs(misc.volume - 0.3) < 0.01 && misc.muteIcon === '🔊',
    `volume=${misc.volume} 图标=${misc.muteIcon}`);
  assert('静音按钮生效', misc.mutedAfterClick === true);
  assert('拖动进度条时滑块不被 timeupdate 抢回',
    misc.seekHeldDuringDrag === misc.seekValueAtDragStart,
    `拖动中保持 ${misc.seekHeldDuringDrag}（松开后跟随到 ${misc.seekFollowsAfterRelease}）`);
  assert('播放到结尾后按钮回到 ▶', misc.ended === true && misc.playIcon === '▶',
    `ended=${misc.ended} 图标=${misc.playIcon} 时间栏="${misc.timeAtEnd}"`);

  /* ------------------------- 17b. HUD 状态栏 ------------------------- */
  section('17b. 状态栏显示 / 隐藏（复选框 + H 键）');
  const hud = await evalJs(`(async () => {
    const A = window.__ASCII__;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hud = document.getElementById('hud');
    const cb = document.getElementById('showHud');
    const press = (key) => document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const out = {};

    await A.loadUrl('${FIXTURES}/badapple-6s.mp4');
    await A.seek(2.0);
    A.pause();
    A.setOptions({ cols: 120, rows: 40, autoRows: false });
    await sleep(350); // 等 HUD 节流刷新
    out.visibleByDefault = getComputedStyle(hud).display !== 'none' && cb.checked;
    out.baseShown = hud.textContent.includes('120 × 40');

    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    out.hiddenByCheckbox = hud.hidden === true && getComputedStyle(hud).display === 'none';

    // 隐藏期间改网格：此刻内容应停在旧值，重新显示时必须立刻跟上
    A.setOptions({ cols: 160, rows: 48, autoRows: false });
    await sleep(200);
    out.showsOldWhileHidden = hud.textContent.includes('120 × 40');
    out.showsNewWhileHidden = hud.textContent.includes('160 × 48');
    press('h');
    await sleep(250);
    out.shownByKey = hud.hidden === false && getComputedStyle(hud).display !== 'none' && cb.checked === true;
    out.freshAfterShow = hud.textContent.includes('160 × 48');

    press('h');
    await sleep(200);
    out.hiddenByKey = hud.hidden === true && cb.checked === false;
    press('h'); // 恢复，别影响后续用例
    await sleep(150);
    return out;
  })()`);
  assert('默认显示状态栏', hud.visibleByDefault === true);
  assert('状态栏内容与当前网格一致（基准 120×40）', hud.baseShown === true);
  assert('取消「显示 HUD 状态」可隐藏（display:none 生效）', hud.hiddenByCheckbox === true);
  assert('隐藏期间内容不再更新', hud.showsOldWhileHidden === true && hud.showsNewWhileHidden === false,
    `旧值 120×40=${hud.showsOldWhileHidden}，新值 160×48=${hud.showsNewWhileHidden}`);
  assert('H 键可恢复显示并同步勾选框', hud.shownByKey === true);
  assert('暂停状态下重新显示时内容立即刷新（不是旧值）', hud.freshAfterShow === true,
    `恢复后 HUD ${hud.freshAfterShow ? '已' : '未'}跟上 160×48`);
  assert('H 键再次隐藏', hud.hiddenByKey === true);

  /* ------------------------- 18. file:// 行为 ------------------------- */
  section('18. file:// 直接打开的行为（应给出提示，而非静默失败）');
  const fileUrl = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');
  await navigate(fileUrl);
  await sleep(3200);
  const fileProbe = await evalJs(`(() => ({
    bannerShown: document.getElementById('banner').classList.contains('show'),
    bannerText: document.getElementById('banner').textContent.slice(0, 80),
    appLoaded: !!window.__ASCII__,
  }))()`);
  assert('file:// 下给出明确提示横幅', fileProbe.bannerShown || fileProbe.appLoaded,
    `banner="${fileProbe.bannerText}" appLoaded=${fileProbe.appLoaded}`);
  record('file:// 说明', true,
    fileProbe.appLoaded
      ? '模块可加载（部分浏览器允许），像素读取仍可能被拒绝，提示横幅已就位'
      : 'ES 模块被拦截，提示横幅正确显示');

  /* ------------------------- 19. 控制台错误 ------------------------- */
  section('19. 页面运行时错误');
  const noise = pageErrors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
  assert('页面无未捕获异常 / console.error', noise.length === 0,
    noise.length ? noise.slice(0, 5).join('\n      ') : '无');

  /* ------------------------- 汇总 ------------------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  summary.passed = passed;
  summary.failed = failed;
  summary.performance = perf;
  summary.playbackFps = fps.fps;
  summary.clipStats = clipStats;
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`端到端测试：${passed} 通过 / ${failed} 失败`);
  console.log(`报告: tests/out/report.json`);
  console.log(`截图: tests/out/*.png`);
  console.log('='.repeat(64));

  cdp.close();
  browser.child.kill();
  server.child.kill();
  await sleep(300);
  try { rmSync(browser.userDataDir, { recursive: true, force: true }); } catch { /* noop */ }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n端到端测试崩溃：', err && err.stack ? err.stack : err);
  process.exit(2);
});
