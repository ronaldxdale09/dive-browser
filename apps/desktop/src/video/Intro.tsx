import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { T, pop } from "./primitives";

/**
 * The first-run sting: five seconds, one idea. Dive's mark, a sphere of
 * dots, assembles out of scattered points; the wordmark cascades in beneath
 * it; a line and a tagline settle; four beats name what the browser is for;
 * then everything but the mark clears so the start screen can take over with
 * its own orb in the same place.
 *
 * Build / breathe / resolve, as the motion guidance has it: the assembly is
 * the build (0–1.6 s), the wordmark and beats breathe over it (1.4–4.2 s),
 * and the clear is the resolve (4.3–5 s). Every value is a function of the
 * frame through `interpolate` with clamped ends, so scrubbing, pausing and
 * reduced-motion posters all show a coherent picture. No CSS transitions.
 */
export const INTRO_FPS = 30;
export const INTRO_DURATION = 150;
export const INTRO_WIDTH = 1600;
export const INTRO_HEIGHT = 1000;
/** The still shown instead of motion: the finished lockup, before the clear. */
export const INTRO_POSTER_FRAME = 118;

const CENTER_X = INTRO_WIDTH / 2;
const MARK_Y = 400;
const MARK_RADIUS = 150;
const DOTS = 180;
const GOLDEN = 0.61803398875;

/** Index-derived pseudo-random in [0, 1): equidistributed, never random. */
function hash(i: number, salt = 0): number {
  return (GOLDEN * (i + 1) + salt * 0.37) % 1;
}

/** Fibonacci sphere: even coverage with no poles and no seam. */
function onSphere(i: number): [number, number, number] {
  const y = 1 - (i / (DOTS - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = 2.399963 * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
}

/** Where each dot waits before it is called in: far out, in every direction. */
function scattered(i: number): [number, number, number] {
  const a = hash(i, 1) * Math.PI * 2;
  const b = (hash(i, 2) - 0.5) * Math.PI;
  const d = 3.6 + hash(i, 3) * 2.4;
  return [Math.cos(a) * Math.cos(b) * d, Math.sin(b) * d, Math.sin(a) * Math.cos(b) * d];
}

/** A dot's arrival, staggered so the whole assembly reads as one half-second beat. */
function arrival(frame: number, fps: number, i: number): number {
  return interpolate(frame, [8 + hash(i) * 15, 8 + hash(i) * 15 + 0.9 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
}

const PERSPECTIVE = 3.4;

/** The mark: dots gather onto a slowly turning sphere. */
function Mark() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const yaw = (frame / fps) * 0.55;
  const tilt = -0.35;
  // The ignite: a quick swell when the last dots land, then a settle.
  const ignite = interpolate(frame, [46, 54, 70], [1, 1.07, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const dots = Array.from({ length: DOTS }, (_, i) => {
    const p = arrival(frame, fps, i);
    const home = onSphere(i);
    const away = scattered(i);
    const x = away[0] + (home[0] - away[0]) * p;
    const y = away[1] + (home[1] - away[1]) * p;
    const z = away[2] + (home[2] - away[2]) * p;
    // Yaw about the vertical axis, then pitch, then a perspective divide.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const rx = x * cy - z * sy;
    const rz = x * sy + z * cy;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const ry = y * ct - rz * st;
    const rz2 = y * st + rz * ct;
    const depth = PERSPECTIVE / (PERSPECTIVE - rz2);
    const screenX = CENTER_X + rx * MARK_RADIUS * ignite * depth;
    const screenY = MARK_Y - ry * MARK_RADIUS * ignite * depth;
    const near = (rz2 + 1) / 2;
    const accent = hash(i, 4) < 0.28;
    return { i, screenX, screenY, r: (1.9 + near * 2.2) * depth, alpha: (0.25 + near * 0.75) * p, accent, z: rz2 };
  }).sort((a, b) => a.z - b.z);
  return (
    <svg width={INTRO_WIDTH} height={INTRO_HEIGHT} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {dots.map((d) => (
        <circle key={d.i} cx={d.screenX} cy={d.screenY} r={d.r} fill={d.accent ? T.hi : T.ink} opacity={d.alpha} />
      ))}
    </svg>
  );
}

/** Ground, glow and ghost type: the depth behind the mark. */
function Backdrop() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const glow = pop(frame, fps, 0);
  const breath = 1 + 0.04 * Math.sin((frame / fps) * 1.1);
  const drift = interpolate(frame, [0, durationInFrames], [14, -14]);
  return (
    <>
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: CENTER_X - 420,
          top: MARK_Y - 420,
          width: 840,
          height: 840,
          borderRadius: "50%",
          background: `radial-gradient(closest-side, ${T.hiSoft}, transparent)`,
          opacity: 0.7 * glow,
          scale: String(breath),
          filter: "blur(28px)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 120,
          textAlign: "center",
          fontFamily: T.sans,
          fontWeight: 700,
          fontSize: 520,
          lineHeight: 1,
          letterSpacing: "0.08em",
          color: T.ink,
          opacity: 0.035 * glow,
          translate: `0px ${drift}px`,
          userSelect: "none",
        }}
      >
        DIVE
      </div>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.35 * glow,
          backgroundImage: `repeating-linear-gradient(90deg, ${T.line} 0 1px, transparent 1px 160px), repeating-linear-gradient(0deg, ${T.line} 0 1px, transparent 1px 160px)`,
          maskImage: "radial-gradient(ellipse 60% 60% at 50% 45%, black, transparent)",
        }}
      />
    </>
  );
}

const LETTERS = ["D", "I", "V", "E"];
const BEATS: { word: string; enter: "pop" | "rise" | "slide" | "fade" }[] = [
  { word: "Workspaces", enter: "rise" },
  { word: "Agent", enter: "pop" },
  { word: "DevTools", enter: "slide" },
  { word: "Privacy", enter: "fade" },
];

export function Intro() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  // The clear: copy leaves upward, accelerating, so the mark is alone at the end.
  const clear = interpolate(frame, [durationInFrames - 22, durationInFrames - 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.quad) });
  const rule = pop(frame, fps, 60);
  const tagline = pop(frame, fps, 66);
  const eyebrow = pop(frame, fps, 80);
  return (
    <AbsoluteFill style={{ background: T.ground, color: T.ink, fontFamily: T.sans, overflow: "hidden" }}>
      <Backdrop />
      <Mark />
      <div style={{ position: "absolute", left: 0, right: 0, top: MARK_Y + MARK_RADIUS + 54, display: "flex", flexDirection: "column", alignItems: "center", opacity: 1 - clear, translate: `0px ${-40 * clear}px` }}>
        <div style={{ display: "flex", fontSize: 96, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.04em" }}>
          {LETTERS.map((letter, i) => {
            const p = pop(frame, fps, 42 + i * 4, true);
            return (
              <span
                key={letter}
                style={{
                  display: "inline-block",
                  opacity: p,
                  translate: `0px ${interpolate(p, [0, 1], [26, 0])}px`,
                  scale: String(interpolate(p, [0, 1], [0.92, 1])),
                }}
              >
                {letter}
              </span>
            );
          })}
        </div>
        <div style={{ marginTop: 26, width: 88, height: 2, borderRadius: 1, background: T.hi, scale: `${rule} 1`, transformOrigin: "50% 50%" }} />
        <p style={{ margin: "22px 0 0", fontSize: 24, color: T.ink2, letterSpacing: "-0.01em", opacity: tagline, translate: `0px ${interpolate(tagline, [0, 1], [14, 0])}px` }}>
          The browser built for developers
        </p>
        <div style={{ marginTop: 44, display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink3, opacity: eyebrow }}>
            Built in
          </span>
          {BEATS.map((beat, i) => {
            const at = 84 + i * 5;
            const p = pop(frame, fps, at, beat.enter === "pop");
            const translate =
              beat.enter === "rise" ? `0px ${interpolate(p, [0, 1], [16, 0])}px` : beat.enter === "slide" ? `${interpolate(p, [0, 1], [24, 0])}px 0px` : "0px 0px";
            return (
              <span
                key={beat.word}
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  borderRadius: 999,
                  border: `1px solid ${T.line2}`,
                  background: T.surface,
                  fontSize: 15,
                  color: T.ink,
                  opacity: p,
                  translate,
                  scale: String(beat.enter === "pop" ? interpolate(p, [0, 1], [0.7, 1]) : 1),
                }}
              >
                {beat.word}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
