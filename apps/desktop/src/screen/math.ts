/**
 * The arithmetic DiveScreen's preview and export share, so a frame looks
 * the same on the stage and in the file: how source time maps through
 * trims and speed changes, where the camera is for a zoom, how the pointer
 * is smoothed, and where automatic zooms should go.
 */
import type { CursorSample, SpeedRegion, TrimRegion, ZoomRegion } from "./model";

/* ------------------------------------------------------------------ time */

/** One stretch of the finished video, and the source it plays. */
export interface Segment {
  /** Output time the segment starts at. */
  outStartMs: number;
  outEndMs: number;
  srcStartMs: number;
  srcEndMs: number;
  speed: number;
}

/**
 * Break the source into output segments: trims are removed, and each speed
 * region plays its stretch faster or slower. Segments are contiguous in
 * output time.
 */
export function buildSegments(durationMs: number, trims: TrimRegion[], speeds: SpeedRegion[]): Segment[] {
  const cuts = new Set<number>([0, durationMs]);
  for (const t of trims) {
    cuts.add(clampMs(t.startMs, durationMs));
    cuts.add(clampMs(t.endMs, durationMs));
  }
  for (const s of speeds) {
    cuts.add(clampMs(s.startMs, durationMs));
    cuts.add(clampMs(s.endMs, durationMs));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let out = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const mid = (a + b) / 2;
    if (trims.some((t) => mid >= t.startMs && mid < t.endMs)) continue;
    const speed = speeds.find((s) => mid >= s.startMs && mid < s.endMs)?.speed ?? 1;
    const length = (b - a) / speed;
    segments.push({ outStartMs: out, outEndMs: out + length, srcStartMs: a, srcEndMs: b, speed });
    out += length;
  }
  return segments;
}

function clampMs(v: number, max: number) {
  return Math.min(max, Math.max(0, v));
}

/** Length of the finished video. */
export function outputDuration(segments: Segment[]): number {
  return segments.length ? segments[segments.length - 1]!.outEndMs : 0;
}

/** Source time for an output time, or null past the end. */
export function sourceTime(segments: Segment[], outMs: number): number | null {
  for (const s of segments) {
    if (outMs >= s.outStartMs && outMs < s.outEndMs) return s.srcStartMs + (outMs - s.outStartMs) * s.speed;
  }
  const last = segments[segments.length - 1];
  return last && outMs >= last.outEndMs ? last.srcEndMs : null;
}

/** Output time for a source time; a trimmed-away moment maps to the cut. */
export function outputTime(segments: Segment[], srcMs: number): number {
  for (const s of segments) {
    if (srcMs >= s.srcStartMs && srcMs < s.srcEndMs) return s.outStartMs + (srcMs - s.srcStartMs) / s.speed;
    if (srcMs < s.srcStartMs) return s.outStartMs;
  }
  return outputDuration(segments);
}

/* ------------------------------------------------------------------ easing */

/** cubic-bezier(0.16, 1, 0.3, 1): the "screen studio" ease-out. */
export const easeOutStudio = cubicBezier(0.16, 1, 0.3, 1);
/** cubic-bezier(0.1, 0, 0.2, 1): the glide between connected zooms. */
export const easeConnect = cubicBezier(0.1, 0, 0.2, 1);
export const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
export const easeOutBack = (p: number) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;

/** A CSS-style cubic bezier as a function of progress 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const bx = (t: number) => 3 * x1 * (1 - t) ** 2 * t + 3 * x2 * (1 - t) * t ** 2 + t ** 3;
  const by = (t: number) => 3 * y1 * (1 - t) ** 2 * t + 3 * y2 * (1 - t) * t ** 2 + t ** 3;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = p;
    for (let i = 0; i < 24; i++) {
      const x = bx(t);
      if (Math.abs(x - p) < 1e-5) break;
      if (x < p) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ zoom */

export const DEPTH_SCALE: Record<number, number> = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 };
export const ZOOM_IN_MS = 1.5 * 1015.05;
export const ZOOM_IN_LEAD_MS = ZOOM_IN_MS - 500;
export const ZOOM_OUT_MS = 1015.05;
export const CONNECT_GAP_MS = 1500;
export const CONNECT_MS = 1000;

export function zoomScale(z: ZoomRegion): number {
  return z.customScale ?? DEPTH_SCALE[z.depth] ?? 1.8;
}

/** How far into a zoom we are at source time t: 0 none, 1 fully in. */
export function zoomStrength(z: ZoomRegion, tMs: number): number {
  const inStart = z.startMs - ZOOM_IN_LEAD_MS;
  const inEnd = z.startMs + 500;
  if (tMs < inStart) return 0;
  if (tMs < inEnd) return easeOutStudio((tMs - inStart) / ZOOM_IN_MS);
  if (tMs <= z.endMs) return 1;
  const outEnd = z.endMs + ZOOM_OUT_MS;
  if (tMs < outEnd) return 1 - easeOutStudio((tMs - z.endMs) / ZOOM_OUT_MS);
  return 0;
}

/** Camera target at a moment: scale and focus, before any spring. */
export interface Camera {
  scale: number;
  cx: number;
  cy: number;
}

/**
 * The camera the timeline asks for at source time t. The strongest zoom
 * wins; two zooms close together glide from one to the next instead of
 * zooming out and back in.
 */
export function cameraAt(zooms: ZoomRegion[], tMs: number, focusOf: (z: ZoomRegion, tMs: number) => { cx: number; cy: number }): Camera {
  const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const gap = b.startMs - a.endMs;
    if (gap >= 0 && gap <= CONNECT_GAP_MS && tMs >= a.endMs && tMs < b.startMs) {
      const p = easeConnect(clamp01((tMs - a.endMs) / Math.min(CONNECT_MS, Math.max(1, gap))));
      const fa = focusOf(a, tMs);
      const fb = focusOf(b, tMs);
      return { scale: lerp(zoomScale(a), zoomScale(b), p), cx: lerp(fa.cx, fb.cx, p), cy: lerp(fa.cy, fb.cy, p) };
    }
  }
  let best: { z: ZoomRegion; s: number } | null = null;
  for (const z of sorted) {
    const s = zoomStrength(z, tMs);
    if (s <= 0) continue;
    if (!best || s > best.s || (s === best.s && z.startMs > best.z.startMs)) best = { z, s };
  }
  if (!best) return { scale: 1, cx: 0.5, cy: 0.5 };
  const f = focusOf(best.z, tMs);
  return { scale: 1 + (zoomScale(best.z) - 1) * best.s, cx: f.cx, cy: f.cy };
}

/** Keep the focus where the zoomed viewport stays inside the frame. */
export function clampFocus(cx: number, cy: number, scale: number): { cx: number; cy: number } {
  const m = 1 / (2 * Math.max(scale, 1));
  return { cx: Math.min(1 - m, Math.max(m, cx)), cy: Math.min(1 - m, Math.max(m, cy)) };
}

/** Where to draw the content box (w×h at 0,0) for a camera, in its own pixels. */
export function cameraTransform(cam: Camera, w: number, h: number): { scale: number; x: number; y: number } {
  const f = clampFocus(cam.cx, cam.cy, cam.scale);
  return { scale: cam.scale, x: w / 2 - f.cx * w * cam.scale, y: h / 2 - f.cy * h * cam.scale };
}

/* ------------------------------------------------------------------ spring */

/** A damped spring chasing a target; stepped in content time so preview and export agree. */
export class Spring {
  value: number;
  velocity = 0;
  constructor(
    value: number,
    private readonly stiffness = 320,
    private readonly damping = 40,
    private readonly mass = 0.92,
  ) {
    this.value = value;
  }

  snap(target: number) {
    this.value = target;
    this.velocity = 0;
  }

  /** Advance towards `target` by `dtMs`, sub-stepped for stability. */
  step(target: number, dtMs: number): number {
    const steps = Math.max(1, Math.ceil(dtMs / 4));
    const h = dtMs / steps / 1000;
    for (let i = 0; i < steps; i++) {
      const before = this.value - target;
      const accel = (-this.stiffness * (this.value - target) - this.damping * this.velocity) / this.mass;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      // Clamp overshoot: crossing the target lands on it.
      if ((this.value - target) * before < 0) {
        this.value = target;
        this.velocity = 0;
      }
    }
    return this.value;
  }
}

/* ------------------------------------------------------------------ cursor */

/** Pointer position at t, interpolated between samples. */
export function cursorAt(samples: CursorSample[], tMs: number): { cx: number; cy: number } | null {
  if (samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  if (tMs <= samples[0]!.timeMs) return { cx: samples[0]!.cx, cy: samples[0]!.cy };
  if (tMs >= samples[hi]!.timeMs) return { cx: samples[hi]!.cx, cy: samples[hi]!.cy };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.timeMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.timeMs - a.timeMs;
  // A long gap means the pointer left and came back: jump, do not glide.
  if (span > 120) return tMs - a.timeMs < span / 2 ? { cx: a.cx, cy: a.cy } : { cx: b.cx, cy: b.cy };
  const p = span > 0 ? (tMs - a.timeMs) / span : 0;
  return { cx: lerp(a.cx, b.cx, p), cy: lerp(a.cy, b.cy, p) };
}

/** Spring constants for a smoothing amount 0..1, after OpenScreen's table. */
export function cursorSpringFor(smoothing: number): { stiffness: number; damping: number; mass: number } {
  if (smoothing <= 0) return { stiffness: 1000, damping: 100, mass: 1 };
  const s = Math.min(1, smoothing);
  if (s <= 0.5) {
    const p = s / 0.5;
    return { stiffness: lerp(760, 340, p), damping: lerp(34, 58, p), mass: lerp(0.55, 1, p) };
  }
  const p = (s - 0.5) / 0.5;
  return { stiffness: lerp(340, 160, p), damping: lerp(58, 80, p), mass: lerp(1, 1.35, p) };
}

/**
 * Pre-smooth the whole pointer path once at 240 Hz so preview and export
 * draw the same cursor; returns samples on that grid.
 */
export function smoothCursorPath(samples: CursorSample[], smoothing: number): CursorSample[] {
  if (samples.length < 2 || smoothing <= 0) return samples;
  const { stiffness, damping, mass } = cursorSpringFor(smoothing);
  const sx = new Spring(samples[0]!.cx, stiffness, damping, mass);
  const sy = new Spring(samples[0]!.cy, stiffness, damping, mass);
  const out: CursorSample[] = [];
  const step = 1000 / 240;
  const end = samples[samples.length - 1]!.timeMs;
  for (let t = samples[0]!.timeMs; t <= end; t += step) {
    const target = cursorAt(samples, t)!;
    out.push({ timeMs: t, cx: sx.step(target.cx, step), cy: sy.step(target.cy, step) });
  }
  return out;
}

/** Click bounce scale at `sinceMs` after a click. */
export function clickBounce(sinceMs: number, amount: number): number {
  if (sinceMs < 0 || sinceMs > 140 || amount <= 0) return 1;
  const p = sinceMs / 140;
  return Math.max(0.72, 1 - Math.sin(p * Math.PI) * 0.08 * amount);
}

/* ------------------------------------------------------------------ auto zoom */

/**
 * Where the pointer dwelled long enough to be worth a closer look. A dwell
 * is a run of samples moving less than 2% between neighbours, lasting
 * 450 ms to 2.6 s; the strongest, at least 1.8 s apart, become zooms.
 */
export function suggestZooms(samples: CursorSample[], durationMs: number, existing: ZoomRegion[], make: (startMs: number, endMs: number, cx: number, cy: number) => ZoomRegion): ZoomRegion[] {
  if (samples.length < 2) return [];
  type Dwell = { start: number; end: number; cx: number; cy: number; strength: number };
  const dwells: Dwell[] = [];
  let runStart = 0;
  for (let i = 1; i <= samples.length; i++) {
    const moved = i < samples.length && Math.hypot(samples[i]!.cx - samples[i - 1]!.cx, samples[i]!.cy - samples[i - 1]!.cy) < 0.02;
    if (moved) continue;
    const run = samples.slice(runStart, i);
    const length = run[run.length - 1]!.timeMs - run[0]!.timeMs;
    if (length >= 450 && length <= 2600) {
      const cx = run.reduce((a, s) => a + s.cx, 0) / run.length;
      const cy = run.reduce((a, s) => a + s.cy, 0) / run.length;
      dwells.push({ start: run[0]!.timeMs, end: run[run.length - 1]!.timeMs, cx, cy, strength: length });
    }
    runStart = i;
  }
  dwells.sort((a, b) => b.strength - a.strength);
  const span = Math.max(1000, durationMs * 0.05);
  const taken: { s: number; e: number; c: number }[] = existing.map((z) => ({ s: z.startMs, e: z.endMs, c: (z.startMs + z.endMs) / 2 }));
  const out: ZoomRegion[] = [];
  for (const d of dwells) {
    const c = (d.start + d.end) / 2;
    const s = Math.max(0, c - span / 2);
    const e = Math.min(durationMs, s + span);
    if (e - s < 100) continue;
    if (taken.some((t) => Math.abs(t.c - c) < 1800 || (s < t.e && e > t.s))) continue;
    taken.push({ s, e, c });
    out.push(make(s, e, d.cx, d.cy));
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/* ------------------------------------------------------------------ canvas */

export const RATIO_VALUE: Record<string, number | null> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "4:5": 4 / 5, "16:10": 16 / 10, native: null };

/** Even output dimensions for a ratio and a resolution choice. */
export function outputSize(ratio: string, resolution: "720p" | "1080p" | "source", src: { width: number; height: number }): { width: number; height: number } {
  const r = RATIO_VALUE[ratio] ?? src.width / Math.max(1, src.height);
  let w: number;
  let h: number;
  if (resolution === "source") {
    const long = Math.max(src.width, src.height);
    if (r >= 1) {
      w = long;
      h = long / r;
    } else {
      h = long;
      w = long * r;
    }
  } else {
    const short = resolution === "720p" ? 720 : 1080;
    if (r >= 1) {
      h = short;
      w = short * r;
    } else {
      w = short;
      h = short / r;
    }
  }
  return { width: Math.round(w / 2) * 2, height: Math.round(h / 2) * 2 };
}

/** The content box: the video fitted inside the canvas with padding. */
export function contentBox(canvasW: number, canvasH: number, padding: number, videoW: number, videoH: number): { x: number; y: number; w: number; h: number } {
  const scale = 1 - (padding / 100) * 0.4;
  const boxW = canvasW * scale;
  const boxH = canvasH * scale;
  const ratio = videoW / Math.max(1, videoH);
  let w = boxW;
  let h = w / ratio;
  if (h > boxH) {
    h = boxH;
    w = h * ratio;
  }
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}
