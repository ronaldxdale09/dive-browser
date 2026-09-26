// Particle Surge — a canvas orb whose dots burst out to a shell and ring back.
// Adapted from the Originkit reference; the loop below (`frame`) is the only
// part that is "burst", everything else is generic projection and plumbing.
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useReducedMotion } from "../lib/useReducedMotion";

const MAX_DPR = 2;
const TAU = Math.PI * 2;

const PERIOD = 3.2; // seconds for one loop at Speed 50
const BASE_SPREAD = 0.29; // sphere radius as a fraction of the ball box
const PERSPECTIVE = 3.5; // camera distance in ball radii
const DEPTH_SIZE = 1;
const DEPTH_FADE = 1;
const MIN_RADIUS = 0.6; // below this a disc is widened and its alpha scaled back
const MAX_DOTS = 1024;
/** Frame interval while the window is unfocused: a splash nobody is looking at gets 20fps, not 60. */
const BLURRED_FRAME_MS = 50;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function dotsN(base: number, n: number): number {
  const v = Math.round(base * n);
  return v < 1 ? 1 : v;
}

// Golden ratio: equidistributed with no short period, so no two neighbours
// ever share a clock.
function hashG(i: number): number {
  return (0.61803398875 * i) % 1;
}

// Fibonacci sphere: even coverage with no poles and no seam.
// Writes into `into`, which the loop shares, rather than returning a new point.
function fib(i: number, n: number, into: [number, number, number]): [number, number, number] {
  const y = 1 - (i / Math.max(1, n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = 2.399963 * i;
  into[0] = Math.cos(th) * r;
  into[1] = y;
  into[2] = Math.sin(th) * r;
  return into;
}
const FIB_POINT: [number, number, number] = [0, 0, 0];

type Dot = [number, number, number, (number | undefined)?, (number | undefined)?, (string | undefined)?];

// Yaw about the vertical axis, then pitch. Used both for a loop's own baked
// tilt and for the viewer's Turn / Tilt. Writes into `into` (which may be `p`
// itself) so a running loop reuses its dots instead of making hundreds of
// small arrays a frame.
function spin(p: Dot, yaw: number, pitch: number, into: Dot = [0, 0, 0]): Dot {
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const rx = p[0] * ca - p[2] * sa;
  let rz = p[0] * sa + p[2] * ca;
  const co = Math.cos(pitch);
  const so = Math.sin(pitch);
  const ry = p[1] * co - rz * so;
  rz = p[1] * so + rz * co;
  into[0] = rx;
  into[1] = ry;
  into[2] = rz;
  into[3] = p[3];
  into[4] = p[4];
  into[5] = p[5];
  return into;
}

type Params = {
  n: number;
  sp: number;
  ds: number;
  yw: number; // resting yaw plus whatever the drag has added
  sn: number; // extra whole turns per loop
  pc: number;
  t: number;
  dot: string;
  acc: string;
};

/** Fill `out` with this phase's dots, reusing the ones already in it. */
function frame(t: number, P: Params, out: Dot[]) {
  const n = dotsN(120, P.n);
  for (let i = 0; i < n; i += 1) {
    // Golden-ratio stagger: the burst is continuous because every dot is on
    // its own leg of one journey, not because anything is re-fired.
    const u = (t + hashG(i)) % 1;
    const e = Math.min(1, u / 0.72);
    // Elastic: exponential decay times a cosine, so the dot overshoots the
    // shell and rings back rather than easing onto it.
    const r = 1 - Math.pow(2, -9 * e) * Math.cos(e * Math.PI * 4.5);
    const q = fib(i, n, FIB_POINT);
    const f = Math.pow(Math.sin(Math.PI * u), 0.5);
    const dot = out[i] ?? (out[i] = [0, 0, 0]);
    dot[0] = q[0] * r;
    dot[1] = q[1] * r;
    dot[2] = q[2] * r;
    dot[3] = 0.5 + 1.3 * (1 - u);
    dot[4] = f;
    dot[5] = u < 0.12 ? P.acc : P.dot;
    spin(dot, TAU * t * 0.25, 0.35, dot);
  }
  out.length = n;
}

type Emit = (x: number, y: number, r: number, a: number, col: string) => void;

type Projected = [number, number, number, number, string, number];
const byDepth = (a: Projected, b: Projected) => a[5] - b[5];
const SPUN: Dot = [0, 0, 0];

// Rotate, project, sort back to front, emit. The sort is not a nicety: painting
// in depth order with source-over alpha is what makes the ball a volume.
// `list` is the caller's to keep: a running loop passes the same one every
// frame and its entries are reused.
function project(pts: Dot[], size: number, P: Params, emit: Emit, list: Projected[] = []) {
  const c = size / 2;
  const R = size * BASE_SPREAD * P.sp;
  const pv = PERSPECTIVE;
  // Extra turns are counted PER LOOP rather than per second, so any whole
  // number of them leaves the loop exactly as seamless as it was.
  const yaw = P.yw + TAU * P.sn * P.t;
  for (let i = 0; i < pts.length; i += 1) {
    const q = spin(pts[i]!, yaw, P.pc, SPUN);
    const z = q[2];
    const s = pv / (pv - z);
    const f = clamp01((z + 1.1) / 2.2);
    const d = list[i] ?? (list[i] = [0, 0, 0, 0, "", 0]);
    d[0] = c + q[0] * R * s;
    d[1] = c + q[1] * R * s;
    d[2] = P.ds * (0.4 + 1.6 * DEPTH_SIZE * f) * s * (q[3] === undefined ? 1 : q[3]);
    d[3] = (0.07 + 0.93 * Math.pow(f, 1.55 * DEPTH_FADE)) * (q[4] === undefined ? 1 : q[4]);
    d[4] = q[5] || P.dot;
    d[5] = z;
  }
  list.length = pts.length;
  list.sort(byDepth);
  for (const d of list) emit(d[0], d[1], d[2], d[3], d[4]);
}

// Sample the loop at twenty phases and measure how far out it ever throws a
// dot, so the ball can be normalised to its box. Cached: twenty frames of work
// whose answer only changes when the ball does.
const fitCache = new Map<string, number>();
function autoFit(size: number, P: Params, restYaw: number, restPitch: number): number {
  // Keyed on the RESTING orientation: a drag is a rigid rotation that moves the
  // extent by far less than the 8% margin the fit leaves, and re-running the
  // sweep every frame would cost twenty times the draw it is normalising.
  const key = size + "/" + P.n + "/" + P.sp + "/" + restYaw + "/" + restPitch + "/" + P.sn;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const half = size / 2;
  let ext = 0;
  const probe: Params = { ...P, ds: 1, dot: "#fff", acc: "#fff", t: 0, yw: restYaw, pc: restPitch };
  const emit: Emit = (x, y, r, a) => {
    if (a <= 0.05 || r <= 0.15) return;
    ext = Math.max(ext, Math.abs(x - half) + 0.5 * r, Math.abs(y - half) + 0.5 * r);
  };
  for (let k = 0; k < 20; k += 1) {
    probe.t = k / 20;
    const out: Dot[] = [];
    frame(probe.t, probe, out);
    project(out, size, probe, emit);
  }
  const fit = ext > 1 ? Math.max(0.55, Math.min(1.7, (0.415 * size) / ext)) : 1;
  fitCache.set(key, fit);
  return fit;
}

// Ball size to dot scale, in three segments. Deliberately NOT linear: a ball
// twice the size gets dots well under twice the radius, so it reads as denser
// rather than as a zoom.
function dotScaleFor(size: number): number {
  if (size <= 46) return 0.4;
  if (size <= 190) return 0.4 + ((size - 46) / 144) * 0.6;
  if (size <= 340) return 1 + ((size - 190) / 150) * 0.55;
  return 1.55;
}

type RGBA = [number, number, number, number];

function parseColor(input: string | undefined, fb: RGBA): RGBA {
  if (!input) return fb;
  const str = String(input).trim();
  const variable = str.match(/^var\((--[^)]+)\)$/);
  if (variable && typeof document !== "undefined") {
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(variable[1]!).trim();
    return resolved ? parseColor(resolved, fb) : fb;
  }
  if (str.charAt(0) === "#") {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((ch) => ch + ch)
        .join("");
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b, a];
    }
    return fb;
  }
  const m = str.match(/[\d.]+/g);
  if (m && m.length >= 3) {
    const [r, g, b, a] = m.map((x) => parseFloat(x));
    return [
      Math.min(255, r ?? 0),
      Math.min(255, g ?? 0),
      Math.min(255, b ?? 0),
      a === undefined ? 1 : Math.min(1, a),
    ];
  }
  return fb;
}

function css(c: RGBA): string {
  return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + c[3] + ")";
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && isFinite(v) ? v : fb;
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

type Ball = { spread?: number; turn?: number; tilt?: number };
type Pointer = { drag?: number; damping?: number };
const BALL_DEFAULTS: Required<Ball> = { spread: 100, turn: 0, tilt: 0 };
const POINTER_DEFAULTS: Required<Pointer> = { drag: 100, damping: 20 };

export interface OrbBurstProps {
  animated?: boolean;
  /** Stop altogether while the window is in the background, rather than slowing down. */
  pauseWhenBlurred?: boolean;
  style?: CSSProperties;
  className?: string;
  width?: number;
  height?: number;
  dotColor?: string;
  accentColor?: string;
  density?: number;
  dotSize?: number;
  speed?: number;
  spinTurns?: number;
  ball?: Ball;
  pointer?: Pointer;
  /** Paint at most this many frames a second while focused. */
  maxFps?: number;
  /**
   * Stop once the pointer has not moved anywhere in the window for this
   * long, and start again when it does. Unset, the orb never idles.
   */
  idleAfterMs?: number;
}

export function OrbBurst(props: OrbBurstProps) {
  const {
    style,
    className,
    dotColor = "var(--color-ink)",
    accentColor = "var(--color-highlight)",
    density = 300,
    dotSize = 150,
    speed = 50,
    spinTurns = 1,
    ball,
    pointer,
    width,
    height,
  } = props;

  // A group that was never set arrives undefined; spread-merging over a typed
  // literal beats a hand-written ?? chain, where one missed key silently pins a
  // control forever.
  const ball_ = { ...BALL_DEFAULTS, ...(ball || {}) };
  const pointer_ = { ...POINTER_DEFAULTS, ...(pointer || {}) };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motionReduced = useReducedMotion();
  const reduced = motionReduced || props.animated === false;

  const size = { w: num(width, 0), h: num(height, 0) };
  // Every live input is read from a ref inside the loop. Putting any of them in
  // the effect deps would restart the animation on every colour tweak.
  const v: Record<string, number | string> = {
    dot: dotColor,
    acc: accentColor,
    // Signed: negative speed runs the loop in reverse.
    speed: clampN(num(speed, 50), -100, 100) / 50,
    density: clampN(num(density, 100), 20, 300) / 100,
    dotSize: clampN(num(dotSize, 100), 20, 300) / 100,
    spinTurns: Math.round(clampN(num(spinTurns, 1), -3, 3)),
    drag: clampN(num(pointer_.drag, 100), 0, 300) / 100,
    damping: clampN(num(pointer_.damping, 20), 1, 100),
    spread: clampN(num(ball_.spread, 100), 40, 180) / 100,
    turn: (clampN(num(ball_.turn, 0), -180, 180) * Math.PI) / 180,
    tilt: (clampN(num(ball_.tilt, 0), -90, 90) * Math.PI) / 180,
    pause: props.pauseWhenBlurred ? 1 : 0,
    frameMs: props.maxFps && props.maxFps > 0 ? 1000 / props.maxFps : 0,
    idleMs: Math.max(0, num(props.idleAfterMs, 0)),
  };

  const sizeRef = useRef(size);
  const vRef = useRef(v);
  const redraw = useRef<() => void>(() => {});
  // Synced in an effect rather than during render, and declared before the
  // animation effect so the loop never reads a stale first value.
  useEffect(() => {
    const changed = sizeRef.current.w !== size.w || sizeRef.current.h !== size.h || Object.keys(v).some((key) => vRef.current[key] !== v[key]);
    sizeRef.current = size;
    vRef.current = v;
    if (changed) redraw.current();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Drag is a rigid rotation held in radians, plus an angular velocity so a
    // flick keeps going after the pointer lets go.
    const drag = { active: false, lx: 0, ly: 0, lt: 0, yaw: 0, pitch: 0, vx: 0, vy: 0 };

    let raf = 0;
    let last = performance.now();
    let phase = 0;
    let lastDrawn = 0;
    // When the pointer last moved in the window, and whether the loop has
    // stopped for want of it.
    let lastPointer = performance.now();
    let idle = false;
    // Kept across frames: the dots, their projections and the parameters are
    // rewritten in place, where every frame used to make hundreds of arrays.
    const dots: Dot[] = [];
    const projected: Projected[] = [];
    const P: Params = { n: 0, sp: 0, ds: 0, yw: 0, sn: 0, pc: 0, t: 0, dot: "", acc: "" };
    // Resolved colours, redone only when the inputs or the theme change.
    // Resolving a CSS variable reads computed style, and doing that twice a
    // frame was a style read sixty times a second.
    let themeVersion = 0;
    const colors = { key: "", theme: -1, dot: "", acc: "" };

    const render = (now: number) => {
      if (!reduced) {
        const focused = document.hasFocus();
        // Where the orb is decoration, as on the start page, a window in the
        // background stops it altogether; focus starts it again below.
        if (!focused && vRef.current.pause) return;
        // Likewise nobody moving the pointer for a while: the ball holds its
        // last frame until the pointer moves again.
        const idleMs = vRef.current.idleMs as number;
        if (idleMs > 0 && !drag.active && now - lastPointer > idleMs) {
          idle = true;
          return;
        }
        // Unfocused, the loop keeps its place but paints at a fraction of the
        // rate; there is no one to see the difference and the CPU is someone
        // else's. Focused, it paints at most at its own cap. `dt` is still
        // measured from the last paint, so the phase advances by real time
        // rather than slowing down. A few milliseconds of slack keep a cap of
        // half the display rate from landing on every third frame instead.
        const interval = focused ? (vRef.current.frameMs as number) : Math.max(BLURRED_FRAME_MS, vRef.current.frameMs as number);
        if (interval > 0 && now - lastDrawn < interval - 4) {
          raf = requestAnimationFrame(render);
          return;
        }
      }
      lastDrawn = now;
      const dt = reduced ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const v = vRef.current;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const cw = sizeRef.current.w || canvas.clientWidth || 120;
      const ch = sizeRef.current.h || canvas.clientHeight || 120;
      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Wrapped on the CPU: an unbounded accumulator eventually costs float
      // precision inside the loop's trig.
      phase = (phase + (dt * (v.speed as number)) / PERIOD) % 1;
      if (phase < 0) phase += 1;

      // The ball is square and takes the component's short side, centred.
      const size = Math.max(4, Math.min(cw, ch));
      const bx = (cw - size) / 2;
      const by = (ch - size) / 2;

      const colorKey = (v.dot as string) + "\n" + (v.acc as string);
      if (colors.key !== colorKey || colors.theme !== themeVersion) {
        colors.key = colorKey;
        colors.theme = themeVersion;
        colors.dot = css(parseColor(v.dot as string, [236, 236, 236, 1]));
        colors.acc = css(parseColor(v.acc as string, [127, 216, 200, 1]));
      }

      // Once the pointer is off, the flick coasts and decays; higher damping
      // brings it to rest sooner.
      if (!drag.active) {
        const decay = Math.exp(-(v.damping as number) * 0.12 * dt);
        drag.yaw += drag.vx * dt;
        drag.pitch += drag.vy * dt;
        drag.vx *= decay;
        drag.vy *= decay;
      }
      const restPitch = v.tilt as number;
      // Clamp the TOTAL pitch, so a drag cannot roll the ball past its own
      // poles and back out upside down.
      drag.pitch = clampN(drag.pitch, -Math.PI / 2 - restPitch, Math.PI / 2 - restPitch);

      P.n = v.density as number;
      P.sp = v.spread as number;
      P.ds = dotScaleFor(size) * (v.dotSize as number);
      P.yw = (v.turn as number) + drag.yaw;
      P.sn = v.spinTurns as number;
      P.pc = restPitch + drag.pitch;
      P.t = phase;
      P.dot = colors.dot;
      P.acc = colors.acc;

      const fit = autoFit(size, P, v.turn as number, restPitch);
      const half = size / 2;

      frame(phase, P, dots);
      let drawn = 0;
      project(dots, size, P, (x, y, r, a, col) => {
        if (drawn >= MAX_DOTS) return;
        // The fit scales positions about the ball's centre and radii by a
        // gentler factor.
        const rr = r * (0.55 + 0.45 * fit);
        if (rr <= 0.05 || a <= 0.004) return;
        const cx = bx + half + (x - half) * fit;
        const cy = by + half + (y - half) * fit;
        // Canvas 2D under-inks sub-pixel circles, and the back of the ball is
        // exactly where the depth cue lives, so a disc under MIN_RADIUS is
        // widened and its alpha scaled by the area it would otherwise lose.
        let dr = rr;
        let da = Math.min(1, a);
        if (dr < MIN_RADIUS) {
          da *= (dr / MIN_RADIUS) * (dr / MIN_RADIUS);
          dr = MIN_RADIUS;
        }
        ctx.globalAlpha = da;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy, dr, 0, TAU);
        ctx.fill();
        drawn += 1;
      }, projected);
      ctx.globalAlpha = 1;

      // Reduced motion gets one still of the ball and no loop; a drag still
      // redraws it, since that is motion the user asked for.
      if (!reduced || drag.active) raf = requestAnimationFrame(render);
    };

    // Static artwork still needs a single fresh paint after appearance or
    // layout changes. Coalesce invalidations; never start a recurring loop.
    const invalidate = () => {
      if (!reduced || document.hidden) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };
    redraw.current = invalidate;
    // A theme change re-resolves the colours on the next paint.
    const onTheme = () => {
      themeVersion += 1;
      invalidate();
    };
    const appearance = new MutationObserver(onTheme);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener("change", onTheme);
    const resize = new ResizeObserver(invalidate);
    resize.observe(canvas);
    window.addEventListener("resize", invalidate);

    // A hidden window paints nothing; when it comes back the clock resumes
    // from now rather than jumping the whole time it was away. Coming back
    // counts as the person being there.
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (document.hidden) return;
      last = performance.now();
      lastPointer = last;
      idle = false;
      raf = requestAnimationFrame(render);
    };

    // A loop paused for a blurred window resumes on focus, from now.
    const onFocus = () => {
      lastPointer = performance.now();
      if (reduced || document.hidden || (!vRef.current.pause && !idle)) return;
      idle = false;
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(render);
    };

    // A loop stopped for want of a pointer starts again when it moves.
    const onPointer = () => {
      lastPointer = performance.now();
      if (!idle || reduced || document.hidden) return;
      if (vRef.current.pause && !document.hasFocus()) return;
      idle = false;
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(render);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });

    const onDown = (e: PointerEvent) => {
      if ((vRef.current.drag as number) <= 0) return;
      drag.active = true;
      if (reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(render);
      }
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      drag.lt = performance.now();
      drag.vx = 0;
      drag.vy = 0;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture is a nicety; the window-level pointerup still ends the drag
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.active) return;
      // Radians per pixel, scaled so a drag across the component's width is one
      // whole turn at Drag 100%.
      const k = ((vRef.current.drag as number) * TAU) / Math.max(1, canvas.clientWidth || 120);
      const dx = (e.clientX - drag.lx) * k;
      const dy = (e.clientY - drag.ly) * k;
      const now2 = performance.now();
      const span = Math.max(1, now2 - drag.lt);
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      drag.lt = now2;
      // Dragging right turns the ball's near face right, which is a NEGATIVE
      // yaw in this basis.
      drag.yaw -= dx;
      drag.pitch += dy;
      drag.vx = (-dx / span) * 1000;
      drag.vy = (dy / span) * 1000;
    };
    // Release on window: a pointer that leaves the component mid-drag would
    // otherwise never let go.
    const onUp = () => {
      drag.active = false;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    if (!document.hidden) raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      redraw.current = () => {};
      appearance.disconnect();
      scheme?.removeEventListener("change", onTheme);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      resize.disconnect();
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [reduced]);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        overflow: "hidden",
        // No background: the orb sits on whatever is behind it.
        minWidth: 24,
        minHeight: 24,
        width: typeof width === "number" && width > 0 ? width : "100%",
        height: typeof height === "number" && height > 0 ? height : "100%",
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
          // The drag has to own the gesture or a touch drag turns into a page
          // scroll and the pointer stream stops mid-flick.
          touchAction: "none",
        }}
      />
    </div>
  );
}
