/**
 * app.js — 应用装配层
 *
 * 数据流：
 *   ① 帧来源（<video> 或合成图案）
 *   ② 画进 cols×rows 采样画布（浏览器做缩放/滤波）
 *   ③ getImageData → 逐像素亮度 → 字符索引 + 颜色
 *   ④ 渲染后端输出（分层合成 / 逐格直绘 / DOM 文本）
 *   ⑤ requestVideoFrameCallback / rAF 按目标帧率刷新
 *
 * 音频：由 <video> 自己播放，和视频帧共用同一个媒体时钟，因此天然同步。
 */

import {
  CHARSETS,
  DEFAULT_CHARSET,
  DEFAULT_CHAR_ASPECT,
  buildRamp,
  buildChannelLUT,
  computeGrid,
  createFrameBuffer,
  mapFrame,
  frameToLines,
  frameToText,
  frameToAnsi,
  clamp,
} from './ascii-core.js';
import { createRenderer, measureAdvanceRatio, fontSizeForCell } from './renderers.js';
import { VideoSource, SyntheticSource } from './sources.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  canvas: $('canvas'),
  textlayer: $('textlayer'),
  video: $('video'),
  file: $('file'),
  dropzone: $('dropzone'),
  hud: $('hud'),
  toast: $('toast'),
  banner: $('banner'),
  seek: $('seek'),
  time: $('time'),
  volume: $('volume'),
};

const FONT_STACK =
  'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Courier New", monospace';
const MONO_RGB = 0x35e07f;
const STORAGE_KEY = 'ascii-player-options-v1';
const NO_PERSIST = /[?&]nopersist\b/.test(location.search);
const MAX_DPR = 2;

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
const opt = {
  cols: 120,
  rows: 40,
  autoRows: true,
  charAspect: DEFAULT_CHAR_ASPECT,
  charset: DEFAULT_CHARSET,
  customCharset: '',
  invert: false,
  brightness: 0,
  contrast: 1,
  gamma: 1,
  colorMode: 'color',
  fit: 'contain',
  highQuality: true,
  engine: 'layered',
  targetFps: 30,
  autoPerf: true,
  showHud: true,
};

const S = {
  source: null,
  renderer: null,
  rendererKind: null,
  fb: null,
  sample: null,
  sampleCtx: null,
  rgba: null,
  ramp: ' .:-=+*#%@',
  lut: null,
  grid: { cols: 120, rows: 40, cellW: 8, cellH: 16 },
  vw: 0,
  vh: 0,
  dpr: 1,
  rafId: 0,
  vfcHandle: 0,
  lastRenderedMediaTime: -1,
  lastRenderWall: 0,
  nextRenderAt: 0,
  lastTimeUiAt: 0,
  draggingSeek: false,
  lastVfcAt: 0,
  lastMeta: null,
  tainted: false,
  objectUrl: null,
  running: false,
  autoReductions: 0,
  toastTimer: 0,
  hudTimer: 0,
  hudTrailing: 0,
  stats: {
    fps: 0,
    renderMs: 0,
    renderEma: 0,
    tSource: 0,
    tRead: 0,
    tMap: 0,
    tDraw: 0,
    frames: 0,
    skipped: 0,
    vfc: 0,
    rafs: 0,
    loopStarts: 0,
    playEvents: 0,
    lastFrameAt: 0,
    fpsEma: 0,
  },
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function toast(msg, { error = false, ms = 2600 } = {}) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', !!error);
  els.toast.classList.add('show');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function showBanner(html) {
  els.banner.innerHTML = html;
  els.banner.classList.add('show');
}

function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function saveOptions() {
  if (NO_PERSIST) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(opt));
  } catch { /* 忽略隐私模式等写入失败 */ }
}

function loadOptions() {
  if (NO_PERSIST) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(opt)) {
      if (k in saved && typeof saved[k] === typeof opt[k]) opt[k] = saved[k];
    }
    return true;
  } catch {
    return false; // 损坏的存档直接忽略
  }
}

/* ------------------------------------------------------------------ *
 * 派生参数：字符集 / 查找表 / 网格 / 缓冲
 * ------------------------------------------------------------------ */
function rebuildRamp() {
  S.ramp = buildRamp(opt.charset, opt.customCharset, opt.invert);
  const preview = $('ramp-preview');
  if (preview) {
    const title = (CHARSETS[opt.charset] || {}).name || opt.charset;
    preview.textContent = `[${S.ramp}]  ${S.ramp.length} 级 · ${title}`;
  }
}

function rebuildLUT() {
  S.lut = buildChannelLUT(opt.brightness, opt.contrast, opt.gamma);
}

function canvasSize() {
  const r = els.stage.getBoundingClientRect();
  S.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  S.vw = Math.max(1, Math.round(r.width * S.dpr));
  S.vh = Math.max(1, Math.round(r.height * S.dpr));
}

function recomputeGrid() {
  canvasSize();
  const g = computeGrid({
    canvasW: S.vw,
    canvasH: S.vh,
    cols: opt.cols,
    rows: opt.rows,
    autoRows: opt.autoRows,
    charAspect: opt.charAspect,
  });
  S.grid = g;

  // 采样画布 = 网格大小
  if (!S.sample) {
    S.sample = document.createElement('canvas');
    S.sampleCtx = S.sample.getContext('2d', { willReadFrequently: true });
  }
  if (S.sample.width !== g.cols || S.sample.height !== g.rows) {
    S.sample.width = g.cols;
    S.sample.height = g.rows;
  }
  if (!S.fb || S.fb.cols !== g.cols || S.fb.rows !== g.rows) {
    S.fb = createFrameBuffer(g.cols, g.rows);
  }
  if (!S.rgba || S.rgba.length !== g.cols * g.rows * 4) {
    S.rgba = new Uint8ClampedArray(g.cols * g.rows * 4);
  }
  if (S.renderer) S.renderer.resize(S.vw, S.vh);

  // 滑块回显（自动行数时同步显示真实行数）
  $('rows').value = String(g.rows);
  $('rows-val').textContent = String(g.rows);
  $('rows').disabled = !!opt.autoRows;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */
function drawOpts() {
  const cellW = S.grid.cellW;
  const cellH = S.grid.cellH;
  const ratio = opt.charAspect || DEFAULT_CHAR_ASPECT;
  const fontSize = fontSizeForCell(cellW, ratio);
  return {
    ramp: S.ramp,
    cellW,
    cellH,
    font: `${fontSize.toFixed(2)}px ${FONT_STACK}`,
    background: '#000000',
    advanceRatio: ratio,
  };
}

/** 渲染当前源的一帧（同步） */
function renderOnce() {
  if (!S.source || !S.source.ready || S.tainted) return false;
  const tStart = performance.now();
  const { cols, rows } = S.grid;

  S.source.drawInto(S.sampleCtx, cols, rows, {
    fit: opt.fit,
    highQuality: opt.highQuality,
    displayAspect: S.vh > 0 ? S.vw / S.vh : cols / rows,
  });
  const tSource = performance.now();

  let data;
  try {
    data = S.sampleCtx.getImageData(0, 0, cols, rows).data;
  } catch (err) {
    S.tainted = true;
    stopLoop();
    showBanner(
      '⚠️ 浏览器拒绝读取视频像素（画布被污染）。这通常发生在用 <code>file://</code> 直接打开页面时。' +
        '请改用本地服务器：双击 <code>start.cmd</code>，或执行 <code>node serve.mjs</code>，' +
        '然后访问 <code>http://localhost:8080</code>。'
    );
    return false;
  }
  const tRead = performance.now();

  if (S.rgba.length !== data.length) S.rgba = new Uint8ClampedArray(data.length);
  S.rgba.set(data);

  mapFrame(S.rgba, S.fb, {
    ramp: S.ramp,
    lut: S.lut,
    colorMode: opt.colorMode,
    monoPacked: MONO_RGB,
  });
  const tMap = performance.now();

  const o = drawOpts();
  if (opt.engine === 'dom') {
    S.renderer.layout(o.cellW, o.cellH, o.advanceRatio, '#35e07f');
  }
  S.renderer.draw(S.fb, o);
  const tEnd = performance.now();

  const st = S.stats;
  const dt = tEnd - tStart;
  st.renderEma = st.renderEma ? st.renderEma * 0.85 + dt * 0.15 : dt;
  st.renderMs = dt;
  // 分阶段耗时（指数滑动平均），用于定位瓶颈
  st.tSource = ema(st.tSource, tSource - tStart);
  st.tRead = ema(st.tRead, tRead - tSource);
  st.tMap = ema(st.tMap, tMap - tRead);
  st.tDraw = ema(st.tDraw, tEnd - tMap);
  st.frames++;
  st.lastFrameAt = tEnd;
  maybeAutoPerf();
  scheduleHud();
  return true;
}

function ema(prev, v) {
  return prev ? prev * 0.85 + v * 0.15 : v;
}

/** 掉帧时自动降低列数（只降不升，避免来回抖动） */
function maybeAutoPerf() {
  if (!opt.autoPerf || opt.targetFps === 0) return;
  const budget = 1000 / opt.targetFps;
  const st = S.stats;
  if (st.frames < 45 || st.frames % 20 !== 0) return;
  if (st.renderEma > budget * 0.9 && opt.cols > 48 && S.autoReductions < 4) {
    S.autoReductions++;
    const next = Math.max(48, Math.round(opt.cols * 0.85));
    opt.cols = next;
    $('cols').value = String(next);
    $('cols-val').textContent = String(next);
    recomputeGrid();
    toast(`渲染耗时 ${st.renderEma.toFixed(1)}ms 超出 ${budget.toFixed(1)}ms 预算，已自动降到 ${next} 列`);
  }
}

/**
 * HUD 刷新：节流但绝不丢帧。
 * 如果只是「到点才画、没到点就 return」，那么当渲染停下来时（暂停、单帧步进）
 * 最后一次状态就永远不会显示出来，HUD 会停在旧值上。
 * 所以被节流时补一个尾部定时器，保证最终状态一定落地。
 */
function scheduleHud(force = false) {
  if (!opt.showHud) return;
  const wait = 220 - (performance.now() - S.hudTimer);
  if (!force && wait > 0) {
    if (!S.hudTrailing) {
      S.hudTrailing = setTimeout(() => {
        S.hudTrailing = 0;
        if (opt.showHud) renderHud();
      }, wait);
    }
    return;
  }
  renderHud();
}

function renderHud() {
  if (S.hudTrailing) {
    clearTimeout(S.hudTrailing);
    S.hudTrailing = 0;
  }
  S.hudTimer = performance.now();
  const st = S.stats;
  const g = S.grid;
  const playing = S.source ? (S.source.kind === 'video' ? !els.video.paused : !!S.source.playing) : false;
  const realFps = st.fpsEma;
  const cls = realFps >= opt.targetFps * 0.85 || opt.targetFps === 0 ? 'ok' : 'bad';
  const fpsText = playing ? `${realFps.toFixed(1)} fps` : '暂停';
  const src = S.source;
  const res = src ? `${src.width}×${src.height}` : '—';
  // 真实“视频丢帧”看解码器统计；stats.skipped 只是被目标帧率节流掉的 rAF 次数
  let videoDrop = '—';
  if (src && src.kind === 'video' && els.video.getVideoPlaybackQuality) {
    const q = els.video.getVideoPlaybackQuality();
    videoDrop = `${q.droppedVideoFrames}/${q.totalVideoFrames}`;
  }
  els.hud.innerHTML = `
    <span>刷新</span><b class="${cls}">${fpsText}</b>
    <span>渲染耗时</span><b>${st.renderEma.toFixed(2)} ms</b>
    <span>采样</span><b>${g.cols} × ${g.rows}</b>
    <span>字符单元</span><b>${g.cols * g.rows}</b>
    <span>耗时分解</span><b>${st.tSource.toFixed(2)} + ${st.tRead.toFixed(2)} + ${st.tMap.toFixed(2)} + ${st.tDraw.toFixed(2)} ms</b>
    <span>源分辨率</span><b>${res}</b>
    <span>媒体时间</span><b>${fmtTime(src ? src.mediaTime : 0)}</b>
    <span>视频丢帧</span><b>${videoDrop}</b>
    <span>节流跳过</span><b>${st.skipped}</b>
    <span>后端</span><b>${opt.engine}</b>`;
}

/* ------------------------------------------------------------------ *
 * 帧循环
 * ------------------------------------------------------------------ */
function tickFps() {
  const now = performance.now();
  const st = S.stats;
  if (st.lastFrameAt) {
    const dt = now - st.lastFrameAt;
    if (dt > 0 && dt < 1000) {
      const inst = 1000 / dt;
      st.fpsEma = st.fpsEma ? st.fpsEma * 0.9 + inst * 0.1 : inst;
    }
  }
}

function stopLoop() {
  if (S.rafId) cancelAnimationFrame(S.rafId);
  S.rafId = 0;
  if (S.vfcHandle && typeof els.video.cancelVideoFrameCallback === 'function') {
    els.video.cancelVideoFrameCallback(S.vfcHandle);
  }
  S.vfcHandle = 0;
  S.running = false;
}

function startLoop() {
  stopLoop();
  S.running = true;
  S.stats.loopStarts = (S.stats.loopStarts || 0) + 1;
  S.lastRenderWall = 0;
  S.nextRenderAt = 0;

  const isVideoSource = S.source && S.source.kind === 'video';
  const hasVfc = isVideoSource && typeof els.video.requestVideoFrameCallback === 'function';

  // rVFC 只用来记录“解码帧到达”与精确媒体时间。
  // 刷新节奏必须由 rAF + 墙钟驱动：某些情况下（窗口被遮挡、主线程吃紧）浏览器会把
  // rVFC 回调合并得很厉害，实测出现过视频解码 59fps 而回调只有 8fps 的情况，
  // 那时若把重绘挂在 rVFC 上，画面就跟着掉到 8fps。
  if (hasVfc) {
    const onVideoFrame = (now, meta) => {
      S.stats.vfc++;
      if (!S.running) return;
      S.vfcHandle = els.video.requestVideoFrameCallback(onVideoFrame);
      S.lastVfcAt = performance.now();
      S.lastMeta = meta;
    };
    S.vfcHandle = els.video.requestVideoFrameCallback(onVideoFrame);
  }

  const onRaf = (now) => {
    if (!S.running) return;
    S.rafId = requestAnimationFrame(onRaf);
    S.stats.rafs = (S.stats.rafs || 0) + 1;

    // 目标帧率用「理想截止时刻」节流，而不是「距上次渲染多久」：
    // rAF 的间隔和 1000/target 通常不成整数倍（例如 75Hz 下 13.3ms），
    // 用差值判断会变成“每 3 个 tick 才画一次” → 实际只有 25fps。
    const capMs = opt.targetFps > 0 ? 1000 / opt.targetFps : 0;
    if (capMs) {
      if (now + 0.5 < S.nextRenderAt) {
        S.stats.skipped++;
        return;
      }
      S.nextRenderAt += capMs;
      // 落后超过一帧（比如渲染太慢）就重新对时，避免疯狂追赶
      if (S.nextRenderAt < now - capMs) S.nextRenderAt = now + capMs;
    }

    if (isVideoSource) {
      // 暂停时不重绘：跳转/暂停由事件直接触发一次
      if (els.video.paused || els.video.ended) return;
    } else if (S.source && S.source.kind === 'synthetic') {
      S.source.tick(now);
    }

    S.lastRenderWall = now;
    S.lastRenderedMediaTime = isVideoSource ? els.video.currentTime : 0;
    tickFps();
    renderOnce();
    // 合成图案没有 timeupdate 事件，时间/进度由循环自己刷新（节流到 ~8Hz）
    if (!isVideoSource && now - S.lastTimeUiAt > 120) {
      S.lastTimeUiAt = now;
      updateTransportUi();
    }
  };

  S.rafId = requestAnimationFrame(onRaf);
}

/* ------------------------------------------------------------------ *
 * 帧来源
 * ------------------------------------------------------------------ */
function setSource(src, label) {
  S.source = src;
  S.tainted = false;
  S.lastRenderedMediaTime = -1;
  S.stats.frames = 0;
  S.stats.skipped = 0;
  S.stats.fpsEma = 0;
  S.autoReductions = 0;
  els.stage.classList.add('has-source');
  $('src-info').textContent = `当前来源：${label}`;
  recomputeGrid();
  renderOnce();
  startLoop();
  syncTransport();
  updateTransportUi();
}

function waitForEvent(el, okEvents, errEvents = ['error', 'abort']) {
  return new Promise((resolve, reject) => {
    const done = (err) => {
      okEvents.forEach((e) => el.removeEventListener(e, onOk));
      errEvents.forEach((e) => el.removeEventListener(e, onErr));
      err ? reject(err) : resolve();
    };
    const onOk = () => done(null);
    const onErr = () => done(new Error('媒体加载失败：浏览器可能不支持该编码格式。'));
    okEvents.forEach((e) => el.addEventListener(e, onOk, { once: true }));
    errEvents.forEach((e) => el.addEventListener(e, onErr, { once: true }));
  });
}

/**
 * 载入一个视频地址。
 *
 * objectUrl 是调用方（loadFile）为本地文件创建的 blob URL：
 * 只回收「上一个」blob URL，绝不能回收这次要播的这一个——
 * 提前 revoke 会让媒体元素直接 ERR_FILE_NOT_FOUND。
 */
async function loadUrl(url, label, { objectUrl = null, isFile = false } = {}) {
  if (S.objectUrl && S.objectUrl !== objectUrl) {
    URL.revokeObjectURL(S.objectUrl);
    S.objectUrl = null;
  }
  S.objectUrl = objectUrl;
  els.video.src = url;
  els.video.load();
  try {
    await waitForEvent(els.video, ['loadedmetadata']);
  } catch (err) {
    if (isFile) {
      showBanner(
        `⚠️ 无法播放本地文件：${label}<br>` +
          '浏览器媒体栈不支持这个文件的编码格式（常见于 HEVC/H.265、部分 MKV、或损坏的文件）。<br>' +
          '可以先用 FFmpeg 转成 H.264 MP4：' +
          '<code>ffmpeg -i "输入.mkv" -c:v libx264 -crf 20 -c:a aac -movflags +faststart "输出.mp4"</code>'
      );
    } else {
      showBanner(`⚠️ 无法加载视频：${label}。请确认链接可直接访问（且允许跨域），或换用本地文件。`);
    }
    throw err;
  }
  const v = new VideoSource(els.video);
  els.video.volume = Number(els.volume.value);
  setSource(v, `${label}（${v.width}×${v.height}${v.duration ? `，${v.duration.toFixed(1)}s` : ''}）`);
  els.seek.value = '0';
  return v;
}

async function loadFile(file) {
  if (!file) return null;
  const url = URL.createObjectURL(file);
  const mb = (file.size / 1048576).toFixed(1);
  try {
    return await loadUrl(url, `${file.name}（${mb} MB）`, { objectUrl: url, isFile: true });
  } catch (err) {
    if (S.objectUrl === url) {
      URL.revokeObjectURL(url);
      S.objectUrl = null;
    }
    throw err;
  }
}

function useSynthetic() {
  if (S.objectUrl) {
    URL.revokeObjectURL(S.objectUrl);
    S.objectUrl = null;
  }
  els.video.removeAttribute('src');
  try { els.video.load(); } catch { /* noop */ }
  const src = new SyntheticSource();
  src.rate = Number($('rate').value) || 1;
  setSource(src, '内置演示图案（合成，无需视频文件）');
  startLoop();
}

/* ------------------------------------------------------------------ *
 * 播放控制
 * ------------------------------------------------------------------ */
function isVideo() {
  return S.source && S.source.kind === 'video';
}

function togglePlay() {
  if (!isVideo()) {
    // 合成图案：切换播放/暂停
    S.source.playing = !S.source.playing;
    syncTransport();
    return;
  }
  if (els.video.paused) {
    els.video.play().catch((e) => toast(`播放失败：${e.message}`, { error: true }));
  } else {
    els.video.pause();
  }
  syncTransport();
}

function seekTo(t) {
  if (!isVideo()) return Promise.resolve();
  const target = clamp(t, 0, Math.max(0, els.video.duration - 0.001));
  const p = waitForEvent(els.video, ['seeked']).catch(() => {});
  els.video.currentTime = target;
  S.lastRenderedMediaTime = -1; // 跳转后允许立刻重绘
  return p.then(() => {
    renderOnce();
  });
}

function stepFrame(dir) {
  if (!isVideo()) return;
  els.video.pause();
  const step = 1 / 30;
  seekTo(els.video.currentTime + dir * step).then(syncTransport);
}

/** 显示 / 隐藏 HUD 状态栏（复选框与 H 键共用这一条路径） */
function toggleHud() {
  opt.showHud = !opt.showHud;
  $('showHud').checked = opt.showHud;
  els.hud.hidden = !opt.showHud;
  scheduleHud(true);
  saveOptions();
  // 隐藏后必须告诉用户怎么找回来，否则就再也开不出来了
  toast(opt.showHud ? '状态栏已显示' : '状态栏已隐藏 · 按 H 可恢复', { ms: opt.showHud ? 1600 : 4000 });
}

function syncTransport() {
  const playing = isVideo() ? !els.video.paused : (S.source && S.source.playing);
  $('btn-play').textContent = playing ? '⏸' : '▶';
  $('btn-mute').textContent = els.video.muted || els.video.volume === 0 ? '🔇' : '🔊';
}

/** 时间显示 + 进度条。视频、合成图案都用它，避免两条路径各写一份。 */
function updateTransportUi() {
  const src = S.source;
  let cur = 0;
  let dur = 0;
  if (src && src.kind === 'video') {
    cur = els.video.currentTime || 0;
    dur = Number.isFinite(els.video.duration) ? els.video.duration : 0;
  } else if (src) {
    cur = src.mediaTime;
    dur = src.duration;
  }
  els.time.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  if (dur > 0 && !S.draggingSeek) {
    els.seek.value = String(Math.round((cur / dur) * 1000));
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */
function screenshot() {
  if (opt.engine === 'dom') {
    toast('DOM 文本模式下画布是空的，请切到画布后端再截图', { error: true });
    return;
  }
  els.canvas.toBlob((blob) => {
    if (!blob) return;
    download(blob, `ascii-frame-${Date.now()}.png`);
    toast('已保存截图 PNG');
  }, 'image/png');
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function currentText() {
  return frameToText(S.fb, S.ramp);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label}（${text.length} 字符）`);
  } catch {
    toast('剪贴板被浏览器拒绝，请改用「下载 .txt」', { error: true });
  }
}

/* ------------------------------------------------------------------ *
 * UI 绑定
 * ------------------------------------------------------------------ */
function bindRange(id, key, fmt, after) {
  const el = $(id);
  const val = $(`${id}-val`);
  el.value = String(opt[key]);
  val.textContent = fmt(opt[key]);
  el.addEventListener('input', () => {
    opt[key] = Number(el.value);
    val.textContent = fmt(opt[key]);
    if (after) after();
    saveOptions();
  });
}

function bindCheck(id, key, after) {
  const el = $(id);
  el.checked = !!opt[key];
  el.addEventListener('change', () => {
    opt[key] = el.checked;
    if (after) after();
    saveOptions();
  });
}

function bindSelect(id, key, after) {
  const el = $(id);
  el.value = String(opt[key]);
  el.addEventListener('change', () => {
    opt[key] = el.value;
    if (after) after();
    saveOptions();
  });
}

function setEngine(kind) {
  opt.engine = kind;
  // 注意：必须和“当前真正安装的后端”比较，不能和 opt.engine 比较
  // （调用方通常已经改过 opt.engine，那样会误判为无需切换）
  if (S.rendererKind === kind && S.renderer) return;
  S.rendererKind = kind;
  S.renderer = createRenderer(kind, els.canvas, els.textlayer);
  S.renderer.resize(S.vw, S.vh);
  els.canvas.hidden = kind === 'dom';
  els.textlayer.hidden = kind !== 'dom';
  S.fb = createFrameBuffer(S.grid.cols, S.grid.rows);
  renderOnce();
}

function setupUI() {
  // 字符集下拉
  const sel = $('charset');
  sel.innerHTML = '';
  for (const [key, def] of Object.entries(CHARSETS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = def.name;
    sel.appendChild(o);
  }
  sel.value = opt.charset;

  sel.addEventListener('change', () => {
    opt.charset = sel.value;
    rebuildRamp();
    renderOnce();
    saveOptions();
  });

  $('customCharset').value = opt.customCharset;
  $('customCharset').addEventListener('input', (e) => {
    opt.customCharset = e.target.value;
    rebuildRamp();
    renderOnce();
    saveOptions();
  });

  bindCheck('invert', 'invert', () => { rebuildRamp(); renderOnce(); });
  bindRange('cols', 'cols', (v) => String(v), recomputeGrid);
  bindRange('rows', 'rows', (v) => String(v), recomputeGrid);
  bindRange('charAspect', 'charAspect', (v) => v.toFixed(3), recomputeGrid);
  bindRange('brightness', 'brightness', (v) => v.toFixed(2), () => { rebuildLUT(); renderOnce(); });
  bindRange('contrast', 'contrast', (v) => v.toFixed(2), () => { rebuildLUT(); renderOnce(); });
  bindRange('gamma', 'gamma', (v) => v.toFixed(2), () => { rebuildLUT(); renderOnce(); });

  bindCheck('autoRows', 'autoRows', recomputeGrid);
  bindCheck('highQuality', 'highQuality', renderOnce);
  bindCheck('showHud', 'showHud', () => {
    els.hud.hidden = !opt.showHud;
    // 重新显示时要绕过 220ms 节流，否则暂停状态下会一直停在旧内容
    scheduleHud(true);
  });
  bindCheck('autoPerf', 'autoPerf');

  bindSelect('colorMode', 'colorMode', renderOnce);
  bindSelect('fit', 'fit', renderOnce);
  bindSelect('engine', 'engine', () => setEngine(opt.engine));
  bindSelect('targetFps', 'targetFps', () => {
    opt.targetFps = Number(opt.targetFps);
    S.lastRenderedMediaTime = -1;
  });

  // 网格预设
  document.querySelectorAll('[data-cols]').forEach((btn, i) => {
    btn.dataset.presetIndex = String(i + 1);
    btn.addEventListener('click', () => {
      const c = Number(btn.dataset.cols);
      const r = Number(btn.dataset.rows);
      opt.cols = c;
      opt.rows = r;
      opt.autoRows = false;
      $('cols').value = String(c);
      $('cols-val').textContent = String(c);
      $('autoRows').checked = false;
      recomputeGrid();
      renderOnce();
      saveOptions();
    });
  });

  // 文件 / 网址
  $('btn-open').addEventListener('click', () => els.file.click());
  $('btn-open-2').addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    const f = els.file.files && els.file.files[0];
    if (f) loadFile(f).catch(() => {});
  });
  $('btn-url-load').addEventListener('click', () => {
    const url = $('url-input').value.trim();
    if (!url) return toast('请先填写视频网址', { error: true });
    loadUrl(url, url).catch(() => {});
  });
  $('btn-demo').addEventListener('click', useSynthetic);

  // 拖放
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) =>
    els.stage.addEventListener(ev, (e) => {
      stop(e);
      els.dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    els.stage.addEventListener(ev, (e) => {
      stop(e);
      els.dropzone.classList.remove('drag');
    })
  );
  els.stage.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f).catch(() => {});
  });
  els.dropzone.addEventListener('click', () => els.file.click());
  window.addEventListener('dragover', stop);
  window.addEventListener('drop', stop);

  // 传输控制
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-back').addEventListener('click', () => seekTo(els.video.currentTime - 5).then(syncTransport));
  $('btn-fwd').addEventListener('click', () => seekTo(els.video.currentTime + 5).then(syncTransport));
  $('btn-frame-back').addEventListener('click', () => stepFrame(-1));
  $('btn-frame-fwd').addEventListener('click', () => stepFrame(1));
  els.seek.addEventListener('input', () => {
    if (!isVideo() || !els.video.duration) return;
    els.video.currentTime = (Number(els.seek.value) / 1000) * els.video.duration;
    updateTransportUi();
  });
  // 拖动进度条时不要让 timeupdate 把滑块抢回去
  els.seek.addEventListener('pointerdown', () => { S.draggingSeek = true; });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    els.seek.addEventListener(ev, () => {
      if (!S.draggingSeek) return;
      S.draggingSeek = false;
      updateTransportUi();
    })
  );
  els.volume.addEventListener('input', () => {
    els.video.volume = Number(els.volume.value);
    els.video.muted = els.video.volume === 0;
    syncTransport();
  });
  $('btn-mute').addEventListener('click', () => {
    els.video.muted = !els.video.muted;
    syncTransport();
  });
  $('rate').addEventListener('change', () => {
    const r = Number($('rate').value);
    els.video.playbackRate = r;
    if (S.source && S.source.kind === 'synthetic') S.source.rate = r; // 合成图案也能变速
  });
  $('btn-shot').addEventListener('click', screenshot);
  $('btn-shot-2').addEventListener('click', screenshot);
  $('btn-copy').addEventListener('click', () => copyText(currentText(), '字符帧'));
  $('btn-copy-ansi').addEventListener('click', () => copyText(frameToAnsi(S.fb, S.ramp), 'ANSI 真彩色帧'));
  $('btn-download').addEventListener('click', () => {
    const blob = new Blob([currentText()], { type: 'text/plain;charset=utf-8' });
    download(blob, `ascii-frame-${Date.now()}.txt`);
  });
  $('btn-fs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.stage.requestFullscreen && els.stage.requestFullscreen();
  });

  // 帮助
  $('btn-help').addEventListener('click', () => $('help').showModal());
  $('btn-close-help').addEventListener('click', () => $('help').close());

  // 视频事件
  els.video.addEventListener('play', () => { S.stats.playEvents++; syncTransport(); if (!S.running) startLoop(); });
  els.video.addEventListener('pause', () => { syncTransport(); renderOnce(); updateTransportUi(); });
  els.video.addEventListener('seeked', () => { renderOnce(); syncTransport(); updateTransportUi(); });
  els.video.addEventListener('timeupdate', updateTransportUi);
  els.video.addEventListener('loadedmetadata', updateTransportUi);
  els.video.addEventListener('durationchange', updateTransportUi);
  els.video.addEventListener('ended', () => {
    syncTransport();
    renderOnce();
    updateTransportUi();
  });

  // 键盘
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); const d = e.shiftKey ? -1 / 30 : -5; if (e.shiftKey) stepFrame(-1); else seekTo(els.video.currentTime + d).then(syncTransport); }
    else if (k === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) stepFrame(1); else seekTo(els.video.currentTime + 5).then(syncTransport); }
    else if (k === 'ArrowUp') { e.preventDefault(); els.volume.value = String(Math.min(1, Number(els.volume.value) + 0.05)); els.video.volume = Number(els.volume.value); }
    else if (k === 'ArrowDown') { e.preventDefault(); els.volume.value = String(Math.max(0, Number(els.volume.value) - 0.05)); els.video.volume = Number(els.volume.value); }
    else if (k === 'm' || k === 'M') { els.video.muted = !els.video.muted; syncTransport(); }
    else if (k === 'f' || k === 'F') { $('btn-fs').click(); }
    else if (k === 'h' || k === 'H') { e.preventDefault(); toggleHud(); }
    else if (k === 's' || k === 'S') { screenshot(); }
    else if (k === 'c' || k === 'C') { copyText(currentText(), '字符帧'); }
    else if (k === 'd' || k === 'D') { useSynthetic(); }
    else if (/^[1-5]$/.test(k)) {
      const btn = document.querySelectorAll('[data-cols]')[Number(k) - 1];
      if (btn) btn.click();
    }
  });

  // 尺寸变化：重算网格（自适应窗口/缩放）
  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        recomputeGrid();
        if (!S.running || !isVideo() || els.video.paused) renderOnce();
      });
    });
    ro.observe(els.stage);
  } else {
    window.addEventListener('resize', () => { recomputeGrid(); renderOnce(); });
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function boot() {
  const restored = loadOptions();
  rebuildRamp();
  rebuildLUT();

  // 用真实字体测量等宽字符步进比，作为“字符宽高比”的初值；
  // 用户手动调过（存档里已有）就不再覆盖
  const ratio = measureAdvanceRatio(FONT_STACK);
  if (!restored) opt.charAspect = Number(ratio.toFixed(3));
  $('charAspect').value = String(opt.charAspect);
  $('charAspect-val').textContent = opt.charAspect.toFixed(3);

  $('cols').value = String(opt.cols);
  $('cols-val').textContent = String(opt.cols);
  $('autoRows').checked = !!opt.autoRows;
  els.hud.hidden = !opt.showHud;

  setupUI();
  setEngine(opt.engine);
  recomputeGrid();
  rebuildRamp();

  if (location.protocol === 'file:') {
    showBanner(
      '⚠️ 当前是 <code>file://</code> 方式打开：浏览器会拦截 ES 模块与画布像素读取。' +
        '请改用本地服务器 —— 双击 <code>start.cmd</code>（或执行 <code>node serve.mjs</code>）后访问 <code>http://localhost:8080</code>。'
    );
  }

  useSynthetic();
  setTimeout(() => {
    if (S.source && S.source.kind === 'synthetic') {
      toast('正在播放内置演示图案 · 拖入视频文件或点「选择视频」即可替换', { ms: 6000 });
    }
  }, 700);

  // 自动化测试入口
  window.__ASCII__ = {
    version: '1.0.0',
    options: opt,
    state: S,
    loadUrl,
    loadFile,
    useSynthetic,
    play: () => { if (isVideo()) return els.video.play(); return Promise.resolve(); },
    pause: () => { if (isVideo()) els.video.pause(); else S.source.playing = false; syncTransport(); },
    seek: seekTo,
    renderOnce,
    setOptions(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in opt)) continue;
        opt[k] = v;
        const el = $(k);
        if (el) {
          if (el.type === 'checkbox') el.checked = !!v;
          else el.value = String(v);
          const val = $(`${k}-val`);
          if (val) val.textContent = typeof v === 'number' ? v.toFixed(2) : String(v);
        }
      }
      rebuildRamp();
      rebuildLUT();
      if ('engine' in patch) setEngine(opt.engine);
      recomputeGrid();
      renderOnce();
      return { ...opt };
    },
    getOptions: () => ({ ...opt }),
    getStats: () => ({
      ...S.stats,
      cols: S.grid.cols,
      rows: S.grid.rows,
      cellW: S.grid.cellW,
      cellH: S.grid.cellH,
      canvasW: S.vw,
      canvasH: S.vh,
      dpr: S.dpr,
      engine: opt.engine,
      tainted: S.tainted,
      ramp: S.ramp,
      sourceKind: S.source ? S.source.kind : null,
      pausedNow: isVideo() ? els.video.paused : !(S.source && S.source.playing),
      running: S.running,
    }),
    getFrameLines: () => frameToLines(S.fb, S.ramp),
    getFrameText: () => currentText(),
    getFrameAnsi: () => frameToAnsi(S.fb, S.ramp),
    getRampIndices: () => Array.from(S.fb.rampIndex),
    getPackedColors: () => Array.from(S.fb.packed),
    getCanvasDataURL: () => els.canvas.toDataURL('image/png'),
    /** 最近一次采样时，视频被画进网格的矩形（单元坐标），用于校验适配与黑边 */
    getSampleRect: () =>
      S.source && S.source.lastRect ? { ...S.source.lastRect } : null,
    /** 只测后端绘制耗时（排除解码/读回/映射），用于公平比较三种后端 */
    benchRender(engine, n = 40) {
      const prev = opt.engine;
      setEngine(engine);
      const o = drawOpts();
      // DOM 后端会跳过“内容没变”的更新，压测前先失效缓存，否则测出来的是空转
      if ('lastText' in S.renderer) S.renderer.lastText = '';
      S.renderer.draw(S.fb, o); // 预热
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if ('lastText' in S.renderer) S.renderer.lastText = '';
        S.renderer.draw(S.fb, o);
      }
      const ms = (performance.now() - t0) / n;
      setEngine(prev);
      return ms;
    },
    measureAdvanceRatio: () => measureAdvanceRatio(FONT_STACK),
    isPlaying: () => (isVideo() ? !els.video.paused : !!(S.source && S.source.playing)),
  };
}

boot();
