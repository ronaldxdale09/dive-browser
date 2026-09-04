/**
 * Draws one frame of a DiveScreen project onto a canvas: background, the
 * padded and rounded video under the zoom camera, the pointer, and the
 * annotations. Pure with respect to time, so the stage and the export call
 * the same function and get the same picture.
 */
import { Spring, cameraAt, cameraTransform, clickBounce, contentBox, cursorAt, easeOutBack, easeOutCubic, lerp } from "./math";
import type { Camera } from "./math";
import { WALLPAPERS } from "./model";
import type { AnnotationRegion, CursorSample, Project, ZoomRegion } from "./model";

export type VideoSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

/** Per-project caches and the camera springs, kept between frames. */
export class Renderer {
  private wallpaperImage: HTMLImageElement | null = null;
  private wallpaperKey = "";
  private images = new Map<string, HTMLImageElement>();
  private scale = new Spring(1);
  private fx = new Spring(0.5);
  private fy = new Spring(0.5);
  private lastMs = Number.NaN;
  private cursorX = new Spring(0.5, 340, 58, 1);
  private cursorY = new Spring(0.5, 340, 58, 1);

  /** Forget motion state: after a seek the camera lands, it does not chase. */
  snap() {
    this.lastMs = Number.NaN;
  }

  /**
   * Draw the project at source time `tMs`. `smoothed` is the pre-smoothed
   * pointer path (or the raw one when smoothing is 0); `raw` carries clicks.
   */
  draw(ctx: CanvasRenderingContext2D, project: Project, video: VideoSource | null, tMs: number, smoothed: CursorSample[], raw: CursorSample[], opts: { width: number; height: number; playing: boolean }) {
    const { width: W, height: H } = opts;
    const e = project.editor;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    this.drawBackground(ctx, e.wallpaper, W, H, e.blurBackground);

    // The picture after cropping.
    const crop = e.crop;
    const srcW = project.media.width * crop.width;
    const srcH = project.media.height * crop.height;
    const box = contentBox(W, H, e.padding, srcW || 16, srcH || 9);

    // Camera: the timeline's request, chased by springs in content time.
    const target = cameraAt(e.zooms, tMs, (z, t) => this.focusOf(z, t, project, smoothed));
    const dt = Number.isNaN(this.lastMs) ? Number.NaN : tMs - this.lastMs;
    const cam: Camera =
      Number.isNaN(dt) || dt < 0 || dt > 500
        ? (this.scale.snap(target.scale), this.fx.snap(target.cx), this.fy.snap(target.cy), target)
        : { scale: this.scale.step(target.scale, dt), cx: this.fx.step(target.cx, dt), cy: this.fy.step(target.cy, dt) };
    this.lastMs = tMs;
    const cam2 = cameraTransform(cam, box.w, box.h);

    // Shadow under the content box (drawn before the clip).
    const radius = e.roundness * (W / 1920);
    if (e.shadow > 0) {
      ctx.save();
      const i = e.shadow;
      for (const [dy, blur, alpha] of [
        [12 * i, 48 * i, 0.7 * i],
        [4 * i, 16 * i, 0.5 * i],
        [2 * i, 8 * i, 0.3 * i],
      ] as const) {
        ctx.shadowColor = `rgba(0,0,0,${alpha})`;
        ctx.shadowBlur = blur * (W / 1920);
        ctx.shadowOffsetY = dy * (W / 1920);
        ctx.fillStyle = "#000";
        roundRect(ctx, box.x, box.y, box.w, box.h, radius);
        ctx.fill();
      }
      ctx.restore();
    }

    // The video, under the camera, inside the rounded box.
    ctx.save();
    roundRect(ctx, box.x, box.y, box.w, box.h, radius);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.translate(box.x + cam2.x, box.y + cam2.y);
    ctx.scale(cam2.scale, cam2.scale);
    if (video) {
      try {
        ctx.drawImage(video, crop.x * project.media.width, crop.y * project.media.height, srcW, srcH, 0, 0, box.w, box.h);
      } catch {
        // A frame that is not ready yet leaves black; the next one draws.
      }
    }
    // Blur annotations sit on the picture, so they follow the camera.
    for (const a of sortedAnnotations(e.annotations).filter((a) => a.type === "blur" && inRange(a, tMs))) {
      this.drawMosaic(ctx, a, box.w, box.h, cam2.scale);
    }
    ctx.restore();

    // Pointer.
    if (e.cursor.show && smoothed.length) this.drawCursor(ctx, project, smoothed, raw, tMs, box, cam2, W, H, opts.playing);

    // Annotations over everything, in canvas space.
    for (const a of sortedAnnotations(e.annotations).filter((a) => a.type !== "blur" && inRange(a, tMs))) {
      this.drawAnnotation(ctx, a, tMs, W, H);
    }
    ctx.restore();
  }

  private focusOf(z: ZoomRegion, tMs: number, project: Project, smoothed: CursorSample[]): { cx: number; cy: number } {
    const auto = project.editor.autoFocusAll || z.focusMode === "auto";
    if (!auto) return z.focus;
    const c = cursorAt(smoothed, tMs);
    return c ?? z.focus;
  }

  private drawBackground(ctx: CanvasRenderingContext2D, wallpaper: string, W: number, H: number, blur: boolean) {
    const css = WALLPAPERS.find((w) => w.id === wallpaper)?.css ?? wallpaper;
    if (css.startsWith("data:") || css.startsWith("http") || css.startsWith("file:")) {
      if (this.wallpaperKey !== css) {
        this.wallpaperKey = css;
        this.wallpaperImage = null;
        const img = new Image();
        img.onload = () => (this.wallpaperImage = img);
        img.src = css;
      }
      const img = this.wallpaperImage;
      if (img && img.naturalWidth) {
        const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * s;
        const h = img.naturalHeight * s;
        ctx.save();
        if (blur) ctx.filter = `blur(${6 * (W / 1920)}px)`;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        ctx.restore();
        return;
      }
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W, H);
      return;
    }
    ctx.fillStyle = cssPaint(ctx, css, W, H);
    ctx.fillRect(0, 0, W, H);
  }

  private drawCursor(ctx: CanvasRenderingContext2D, project: Project, smoothed: CursorSample[], raw: CursorSample[], tMs: number, box: { x: number; y: number; w: number; h: number }, cam: { scale: number; x: number; y: number }, W: number, H: number, playing: boolean) {
    const c = project.editor.cursor;
    const target = cursorAt(smoothed, tMs);
    if (!target) return;
    // A little extra lag while playing keeps the pointer feeling physical.
    const p = playing ? { cx: this.cursorX.step(target.cx, 16), cy: this.cursorY.step(target.cy, 16) } : (this.cursorX.snap(target.cx), this.cursorY.snap(target.cy), target);
    const crop = project.editor.crop;
    // From frame-normalised to cropped-picture-normalised, then through the camera.
    const px = ((p.cx - crop.x) / crop.width) * box.w;
    const py = ((p.cy - crop.y) / crop.height) * box.h;
    const x = box.x + cam.x + px * cam.scale;
    const y = box.y + cam.y + py * cam.scale;
    if (c.clipToCanvas && (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h)) return;
    const lastClick = [...raw].reverse().find((s) => s.click && s.timeMs <= tMs);
    const since = lastClick ? tMs - lastClick.timeMs : Number.POSITIVE_INFINITY;
    const bounce = clickBounce(since, c.clickBounce);
    const base = 28 * (c.size / 3) * Math.max(0.55, W / 1920) * Math.min(1.6, cam.scale ** 0.35);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    if (c.clickRing && since < 420 && lastClick) {
      const rp = since / 420;
      const cx = box.x + cam.x + (((lastClick.cx - crop.x) / crop.width) * box.w) * cam.scale;
      const cy = box.y + cam.y + (((lastClick.cy - crop.y) / crop.height) * box.h) * cam.scale;
      ctx.beginPath();
      ctx.arc(cx, cy, base * (0.6 + 1.4 * easeOutCubic(rp)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - rp)})`;
      ctx.lineWidth = Math.max(1.5, base * 0.09);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.18 * (1 - rp)})`;
      ctx.fill();
    }
    ctx.translate(x, y);
    ctx.scale(bounce, bounce);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 3 * (W / 1920);
    ctx.shadowOffsetY = 2 * (W / 1920);
    drawArrowCursor(ctx, base);
    ctx.restore();
  }

  private drawMosaic(ctx: CanvasRenderingContext2D, a: AnnotationRegion, w: number, h: number, camScale: number) {
    // Pixel-average blocks of the already-drawn picture inside the box.
    const x = (a.position.x / 100) * w - ((a.size.width / 100) * w) / 2;
    const y = (a.position.y / 100) * h - ((a.size.height / 100) * h) / 2;
    const bw = (a.size.width / 100) * w;
    const bh = (a.size.height / 100) * h;
    const block = Math.max(2, (a.style.blockSize * w) / 1920 / camScale);
    ctx.save();
    if (a.style.shape === "oval") {
      ctx.beginPath();
      ctx.ellipse(x + bw / 2, y + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    // Sample the canvas under the current transform via a temporary read of
    // device pixels; average per block.
    const m = ctx.getTransform();
    const dx = m.a * x + m.c * y + m.e;
    const dy = m.b * x + m.d * y + m.f;
    const dw = bw * m.a;
    const dh = bh * m.d;
    try {
      const img = ctx.getImageData(Math.max(0, dx), Math.max(0, dy), Math.max(1, dw), Math.max(1, dh));
      const stepPx = Math.max(2, Math.round(block * m.a));
      for (let by = 0; by < img.height; by += stepPx) {
        for (let bx = 0; bx < img.width; bx += stepPx) {
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let yy = by; yy < Math.min(img.height, by + stepPx); yy += 2) {
            for (let xx = bx; xx < Math.min(img.width, bx + stepPx); xx += 2) {
              const i = (yy * img.width + xx) * 4;
              r += img.data[i]!;
              g += img.data[i + 1]!;
              b += img.data[i + 2]!;
              n++;
            }
          }
          if (!n) continue;
          ctx.fillStyle = `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`;
          ctx.fillRect(x + bx / m.a, y + by / m.d, stepPx / m.a + 0.5, stepPx / m.d + 0.5);
        }
      }
    } catch {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x, y, bw, bh);
    }
    ctx.restore();
  }

  private drawAnnotation(ctx: CanvasRenderingContext2D, a: AnnotationRegion, tMs: number, W: number, H: number) {
    const cx = (a.position.x / 100) * W;
    const cy = (a.position.y / 100) * H;
    const w = (a.size.width / 100) * W;
    const h = (a.size.height / 100) * H;
    const p = Math.min(1, Math.max(0, (tMs - a.startMs) / 700));
    ctx.save();
    // Entrance animation.
    let alpha = 1;
    let ox = 0;
    let oy = 0;
    let s = 1;
    switch (a.style.animation) {
      case "fade":
        alpha = easeOutCubic(p);
        break;
      case "rise":
        alpha = easeOutCubic(p);
        oy = 18 * (1 - easeOutCubic(p)) * (H / 1080);
        break;
      case "pop":
        alpha = Math.min(1, p * 2);
        s = lerp(0.6, 1, easeOutBack(p));
        break;
      case "slide-left":
        alpha = easeOutCubic(p);
        ox = -28 * (1 - easeOutCubic(p)) * (W / 1920);
        break;
      case "pulse":
        s = 1 + 0.06 * Math.sin((tMs - a.startMs) / 180);
        break;
      default:
        break;
    }
    ctx.globalAlpha = alpha;
    ctx.translate(cx + ox, cy + oy);
    ctx.scale(s, s);
    if (a.type === "text") {
      const size = a.style.fontSize * (W / 1920);
      if (a.style.background !== "transparent") {
        ctx.fillStyle = a.style.background;
        roundRect(ctx, -w / 2, -h / 2, w, h, 8 * (W / 1920));
        ctx.fill();
      }
      ctx.fillStyle = a.style.color;
      ctx.font = `${a.style.italic ? "italic " : ""}${a.style.bold ? "700" : "400"} ${size}px ${a.style.fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = a.style.align;
      const full = a.text ?? "";
      const text = a.style.animation === "typewriter" ? full.slice(0, Math.ceil(full.length * p)) : full;
      const lines = wrap(ctx, text, w - size * 0.6);
      const lh = size * 1.25;
      const startY = -((lines.length - 1) * lh) / 2;
      const tx = a.style.align === "left" ? -w / 2 + size * 0.3 : a.style.align === "right" ? w / 2 - size * 0.3 : 0;
      lines.forEach((line, i) => {
        ctx.fillText(line, tx, startY + i * lh);
        if (a.style.underline) {
          const m = ctx.measureText(line);
          const lx = a.style.align === "left" ? tx : a.style.align === "right" ? tx - m.width : tx - m.width / 2;
          ctx.fillRect(lx, startY + i * lh + size * 0.42, m.width, Math.max(1, size * 0.06));
        }
      });
    } else if (a.type === "arrow") {
      const dirs: Record<string, number> = { right: 0, "down-right": 45, down: 90, "down-left": 135, left: 180, "up-left": 225, up: 270, "up-right": 315 };
      ctx.rotate(((dirs[a.style.direction] ?? 0) * Math.PI) / 180);
      const len = Math.min(w, h) * 0.9;
      const lw = a.style.strokeWidth * 2 * (W / 1920);
      ctx.strokeStyle = a.style.color;
      ctx.fillStyle = a.style.color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.lineTo(len / 2 - lw * 2, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(len / 2, 0);
      ctx.lineTo(len / 2 - lw * 3.2, -lw * 2);
      ctx.lineTo(len / 2 - lw * 3.2, lw * 2);
      ctx.closePath();
      ctx.fill();
    } else if (a.type === "image" && a.image) {
      let img = this.images.get(a.image);
      if (!img) {
        img = new Image();
        img.src = a.image;
        this.images.set(a.image, img);
      }
      if (img.naturalWidth) ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
}

function inRange(a: { startMs: number; endMs: number }, tMs: number) {
  return tMs >= a.startMs && tMs < a.endMs;
}

function sortedAnnotations(list: AnnotationRegion[]) {
  return [...list].sort((a, b) => a.zIndex - b.zIndex);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The classic arrow pointer, hotspot at the origin, `size` px tall. */
function drawArrowCursor(ctx: CanvasRenderingContext2D, size: number) {
  const s = size / 28;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 22 * s);
  ctx.lineTo(5.5 * s, 17 * s);
  ctx.lineTo(9.5 * s, 26 * s);
  ctx.lineTo(13 * s, 24.5 * s);
  ctx.lineTo(9 * s, 15.5 * s);
  ctx.lineTo(16 * s, 15.5 * s);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.strokeStyle = "#111";
  ctx.lineJoin = "round";
  ctx.stroke();
}

/** A CSS colour or gradient string as a canvas paint. */
export function cssPaint(ctx: CanvasRenderingContext2D, css: string, W: number, H: number): string | CanvasGradient {
  const m = /^(linear|radial)-gradient\((.*)\)$/s.exec(css.trim());
  if (!m) return css;
  const parts = splitTop(m[2]!);
  let grad: CanvasGradient;
  if (m[1] === "linear") {
    let angle = 180;
    if (parts[0] && /deg$/.test(parts[0].trim())) angle = parseFloat(parts.shift()!);
    else if (parts[0] && /^to /.test(parts[0].trim())) {
      const to = parts.shift()!.trim();
      angle = to.includes("top") ? 0 : to.includes("bottom") ? 180 : to.includes("left") ? 270 : 90;
      if (to.includes("right") && to.includes("top")) angle = 45;
      if (to.includes("right") && to.includes("bottom")) angle = 135;
    }
    const a = ((angle - 90) * Math.PI) / 180;
    const len = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a));
    const x = (Math.cos(a) * len) / 2;
    const y = (Math.sin(a) * len) / 2;
    grad = ctx.createLinearGradient(W / 2 - x, H / 2 - y, W / 2 + x, H / 2 + y);
  } else {
    if (parts[0] && /^(ellipse|circle|at )/.test(parts[0].trim())) parts.shift();
    grad = ctx.createRadialGradient(W * 0.3, H * 0.2, 0, W * 0.3, H * 0.2, Math.max(W, H));
  }
  const stops = parts.map((p) => p.trim()).filter(Boolean);
  stops.forEach((stop, i) => {
    const mm = /^(.*?)\s+([\d.]+)%$/.exec(stop);
    const color = mm ? mm[1]! : stop;
    const at = mm ? parseFloat(mm[2]!) / 100 : stops.length === 1 ? 0 : i / (stops.length - 1);
    try {
      grad.addColorStop(Math.min(1, Math.max(0, at)), color);
    } catch {
      // An unparseable stop is skipped.
    }
  });
  return grad;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = probe;
    }
    lines.push(line);
  }
  return lines;
}
