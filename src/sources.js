/**
 * sources.js — 帧来源抽象
 *
 *   VideoSource      : 用浏览器媒体栈（HTMLVideoElement）解码，drawImage 取帧
 *   SyntheticSource  : 无视频也能量出效果的合成图案（渐变 + 灰阶台阶 + 运动物体）
 *
 * 两者的接口一致：{ ready, width, height, mediaTime, duration, drawInto(ctx, w, h, opts) }
 */

/** 计算视频在目标矩形中的绘制矩形（纯几何，调用方保证 vw/vh 与 w/h 同一坐标系） */
export function fitRect(vw, vh, w, h, fit = 'contain') {
  if (fit === 'stretch') return { x: 0, y: 0, w, h };
  const s = fit === 'cover' ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const dw = vw * s;
  const dh = vh * s;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

/**
 * 把“显示空间”（宽 displayAspect、高 1）里的矩形换算回 cols×rows 采样画布坐标。
 *
 * 为什么不能直接在采样画布坐标里 contain/cover：
 *   单元格不是正方形（宽 ≈ 0.6 × 高），所以 cols×rows 的“单元矩形”和它显示出来的
 *   矩形比例不同。只有在显示空间里做适配，视频才不会既被留错黑边又被拉变形。
 */
export function fitRectToGrid(vw, vh, cols, rows, fit, displayAspect) {
  const boxW = displayAspect > 0 ? displayAspect : cols / rows;
  const r = fitRect(vw, vh, boxW, 1, fit);
  const kx = cols / boxW;
  const ky = rows;
  return { x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky };
}

export class VideoSource {
  constructor(video) {
    this.video = video;
    this.kind = 'video';
    this._mid = null;
  }

  get width() {
    return this.video.videoWidth || 0;
  }

  get height() {
    return this.video.videoHeight || 0;
  }

  get ready() {
    return this.video.readyState >= 2 && this.width > 0 && this.height > 0;
  }

  get mediaTime() {
    return this.video.currentTime || 0;
  }

  get duration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get paused() {
    return this.video.paused;
  }

  /**
   * 把当前视频帧画进 cols×rows 的采样画布。
   * 大比例缩小时先降到一个 3 倍网格的中间画布，避免浏览器单步缩放丢细节。
   */
  drawInto(ctx, w, h, opts = {}) {
    const vw = this.width;
    const vh = this.height;
    if (!vw || !vh) return false;
    const { fit = 'contain', highQuality = true, background = '#000000', displayAspect = w / h } = opts;
    const rect = fitRectToGrid(vw, vh, w, h, fit, displayAspect);
    this.lastRect = rect;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const shrink = rect.w > 0 ? vw / rect.w : 1;
    if (highQuality && shrink > 3) {
      const iw = Math.max(2, Math.min(vw, Math.round(w * 3)));
      const ih = Math.max(2, Math.round(h * (iw / w)));
      if (!this._mid) this._mid = document.createElement('canvas');
      if (this._mid.width !== iw || this._mid.height !== ih) {
        this._mid.width = iw;
        this._mid.height = ih;
      }
      const mctx = this._mid.getContext('2d');
      const k = iw / w;
      mctx.imageSmoothingEnabled = true;
      mctx.imageSmoothingQuality = 'high';
      mctx.clearRect(0, 0, iw, ih);
      mctx.drawImage(this.video, rect.x * k, rect.y * k, rect.w * k, rect.h * k);
      ctx.drawImage(this._mid, 0, 0, iw, ih, 0, 0, w, h);
    } else {
      ctx.drawImage(this.video, rect.x, rect.y, rect.w, rect.h);
    }
    return true;
  }
}

/**
 * 合成图案源：不依赖任何视频文件，用于首次打开时的演示与自动化测试。
 *
 * 画面自下而上包含：
 *   · 底部：0→255 的灰阶台阶带（可以肉眼/程序校验字符映射是否单调）
 *   · 中部：移动的亮球 + 旋转扫描线
 *   · 背景：随时间的垂直渐变
 */
export class SyntheticSource {
  constructor() {
    this.kind = 'synthetic';
    this.t0 = performance.now();
    this.elapsed = 0;
    this.playing = true;
    this.rate = 1;
    this.loopLength = 12;
  }

  get width() {
    return 640;
  }

  get height() {
    return 360;
  }

  get ready() {
    return true;
  }

  get mediaTime() {
    return this.elapsed % this.loopLength;
  }

  get duration() {
    return this.loopLength;
  }

  get paused() {
    return !this.playing;
  }

  tick(now) {
    if (this.playing) {
      const dt = (now - this.t0) / 1000;
      this.elapsed += Math.max(0, Math.min(0.25, dt)) * (this.rate || 1);
    }
    this.t0 = now;
    return this.mediaTime;
  }

  drawInto(ctx, w, h, opts = {}) {
    const t = this.mediaTime;
    this.lastRect = { x: 0, y: 0, w, h };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    // 背景垂直渐变（会随 t 呼吸）
    const breathe = 0.35 + 0.25 * Math.sin((t / this.loopLength) * Math.PI * 2);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, `rgb(${Math.round(20 * breathe)},${Math.round(40 * breathe)},${Math.round(90 * breathe)})`);
    bg.addColorStop(1, `rgb(${Math.round(180 * breathe)},${Math.round(60 * breathe)},${Math.round(20 * breathe)})`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 灰阶台阶带（底部 1/6），0 → 255 单调递增，用于校验亮度映射
    const bandTop = Math.floor((h * 5) / 6);
    const bandH = h - bandTop;
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / Math.max(1, w - 1)) * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, bandTop, 1, bandH);
    }

    // 圆形物体要按“显示空间”补偿单元格宽高比，否则圆会变成竖椭圆
    const displayAspect = opts.displayAspect > 0 ? opts.displayAspect : w / h;
    const cellAspect = displayAspect * (h / w); // cellW / cellH
    const ax = 1 / Math.max(0.2, cellAspect);
    const W = w / ax;

    ctx.save();
    ctx.scale(ax, 1);
    const cx = W / 2;
    const cy = h * 0.42;
    const ang = (t / this.loopLength) * Math.PI * 2;

    // 旋转扫描线
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, W / 160);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * W * 0.45, cy + Math.sin(ang) * h * 0.45);
    ctx.stroke();

    // 绕圈运动的亮球
    const bx = cx + Math.cos(ang * 2) * W * 0.3;
    const by = cy + Math.sin(ang * 2) * h * 0.22;
    const rad = Math.max(1.5, W / 45);
    const ball = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
    ball.addColorStop(0, '#ffffff');
    ball.addColorStop(0.6, 'rgba(255,210,120,0.9)');
    ball.addColorStop(1, 'rgba(255,120,0,0)');
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(bx, by, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return true;
  }
}
