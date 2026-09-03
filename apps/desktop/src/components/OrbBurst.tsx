// Particle Surge — a canvas orb whose dots burst out to a shell and ring back.
// Adapted from the Originkit reference; the loop below (`frame`) is the only
// part that is "burst", everything else is generic projection and plumbing.
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

const MAX_DPR = 2;
const TAU = Math.PI * 2;

const PERIOD = 3.2; // seconds for one loop at Speed 50
const BASE_SPREAD = 0.29; // sphere radius as a fraction of the ball box
const PERSPECTIVE = 3.5; // camera distance in ball radii
const DEPTH_SIZE = 1;
const DEPTH_FADE = 1;
const MIN_RADIUS = 0.6; // below this a disc is widened and its alpha scaled back
const MAX_DOTS = 1024;

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
function fib(i: number, n: number): [number, number, number] {
  const y = 1 - (i / Math.max(1, n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = 2.399963 * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
}

type Dot = [number, number, number, (number | undefined)?, (number | undefined)?, (string | undefined)?];

// Yaw about the vertical axis, then pitch. Used both for a loop's own baked
// tilt and for the viewer's Turn / Tilt.
function spin(p: Dot, yaw: number, pitch: number): Dot {
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const rx = p[0] * ca - p[2] * sa;
  let rz = p[0] * sa + p[2] * ca;
  const co = Math.cos(pitch);
  const so = Math.sin(pitch);
  const ry = p[1] * co - rz * so;
  rz = p[1] * so + rz * co;
  return [rx, ry, rz, p[3], p[4], p[5]];
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
    const q = fib(i, n);
    const f = Math.pow(Math.sin(Math.PI * u), 0.5);
    out.push(
      spin(
        [q[0] * r, q[1] * r, q[2] * r, 0.5 + 1.3 * (1 - u), f, u < 0.12 ? P.acc : P.dot],
        TAU * t * 0.25,
        0.35,
      ),
    );
  }
}

type Emit = (x: number, y: number, r: number, a: number, col: string) => void;

// Rotate, project, sort back to front, emit. The sort is not a nicety: painting
// in depth order with source-over alpha is what makes the ball a volume.
function project(pts: Dot[], size: number, P: Params, emit: Emit) {
  const c = size / 2;
  const R = size * BASE_SPREAD * P.sp;
  const pv = PERSPECTIVE;
  // Extra turns are counted PER LOOP rather than per second, so any whole
  // number of them leaves the loop exactly as seamless as it was.
  const yaw = P.yw + TAU * P.sn * P.t;
  const list: Array<[number, number, number, number, string, number]> = [];
  for (const p of pts) {
    const q = spin(p, yaw, P.pc);
    const z = q[2];
    const s = pv / (pv - z);
    const f = clamp01((z + 1.1) / 2.2);
    list.push([
      c + q[0] * R * s,
      c + q[1] * R * s,
      P.ds * (0.4 + 1.6 * DEPTH_SIZE * f) * s * (q[3] === undefined ? 1 : q[3]),
      (0.07 + 0.93 * Math.pow(f, 1.55 * DEPTH_FADE)) * (q[4] === undefined ? 1 : q[4]),
      q[5] || P.dot,
      z,
    ]);
  }
  list.sort((a, b) => a[5] - b[5]);
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
}

export function OrbBurst(props: OrbBurstProps) {
  const {
    style,
    className,
    dotColor = "#ECECEC",
    accentColor = "#7FD8C8",
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
  };

  const sizeRef = useRef(size);
  const vRef = useRef(v);
  // Synced in an effect rather than during render, and declared before the
  // animation effect so the loop never reads a stale first value.
  useEffect(() => {
    sizeRef.current = size;
    vRef.current = v;
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

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
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

      const dotCol = css(parseColor(v.dot as string, [236, 236, 236, 1]));
      const accCol = css(parseColor(v.acc as string, [127, 216, 200, 1]));

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

      const P: Params = {
        n: v.density as number,
        sp: v.spread as number,
        ds: dotScaleFor(size) * (v.dotSize as number),
        yw: (v.turn as number) + drag.yaw,
        sn: v.spinTurns as number,
        pc: restPitch + drag.pitch,
        t: phase,
        dot: dotCol,
        acc: accCol,
      };

      const fit = autoFit(size, P, v.turn as number, restPitch);
      const half = size / 2;

      const out: Dot[] = [];
      frame(phase, P, out);
      let drawn = 0;
      project(out, size, P, (x, y, r, a, col) => {
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
      });
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(render);
    };

    const onDown = (e: PointerEvent) => {
      if ((vRef.current.drag as number) <= 0) return;
      drag.active = true;
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

    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

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
