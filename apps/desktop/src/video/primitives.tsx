import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { CSSProperties, ReactNode } from "react";

/**
 * Building blocks for the feature reel.
 *
 * Everything is drawn from the chrome's own design tokens — CSS variables the
 * Player resolves against the document it lives in — so the reel follows the
 * theme and accent the person chose rather than shipping a palette of its own.
 *
 * Motion follows Remotion's markup guidance: every animation is a function of
 * `useCurrentFrame()` through `interpolate()` with an explicit easing and
 * clamped ends, and transforms use the individual `scale` / `translate`
 * properties rather than a `transform` string. CSS transitions are never used;
 * they would not be deterministic per frame.
 */
export const T = {
  ground: "var(--color-ground)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
  surface3: "var(--color-surface-3)",
  ink: "var(--color-ink)",
  ink2: "var(--color-ink-2)",
  ink3: "var(--color-ink-3)",
  line: "var(--color-line)",
  line2: "var(--color-line-2)",
  hi: "var(--color-highlight)",
  hiSoft: "var(--color-highlight-soft)",
  danger: "var(--color-danger)",
  ok: "#7fd8a0",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
};

/** Composition size. Wide and short: it sits under a headline, not in a theatre. */
export const WIDTH = 1280;
export const HEIGHT = 480;
export const FPS = 30;

/** The "settle" curve used for nearly every entrance: fast out, soft landing. */
export const SETTLE = Easing.bezier(0.16, 1, 0.3, 1);

/** Props every feature scene receives from the series, so order lives in one place. */
export type SceneProps = { index: number };

/** Frame-relative timing of the current sequence. */
export function useScene() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return { frame, fps, durationInFrames };
}

/**
 * 0→1 starting `delay` frames in. The default settles in 0.6 s; `snappy`
 * uses a spring easing with a little overshoot for clicks and stamps.
 */
export function pop(frame: number, fps: number, delay = 0, snappy = false): number {
  return interpolate(frame, [delay, delay + (snappy ? 0.5 : 0.6) * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: snappy ? Easing.spring({ damping: 12, stiffness: 170, mass: 0.8 }) : SETTLE,
  });
}

/** Linear 0→1 between two frames, clamped. For progress bars and sweeps. */
export function ramp(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** One feature: copy on the left, a staged mock of the UI on the right. */
export function Scene({
  index,
  eyebrow,
  title,
  text,
  keys,
  children,
}: {
  index: number;
  eyebrow: string;
  title: string;
  text: string;
  keys?: string;
  children: ReactNode;
}) {
  const { frame, fps } = useScene();
  const rise = (delay: number) => `0px ${interpolate(pop(frame, fps, delay), [0, 1], [18, 0])}px`;
  return (
    <AbsoluteFill style={{ background: T.ground, color: T.ink, fontFamily: T.sans }}>
      <Glow />
      {/* Copy column. The safe area starts 80px in; nothing important sits closer to an edge. */}
      <div style={{ position: "absolute", left: 80, top: 0, bottom: 0, width: 400, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: T.hi,
            opacity: pop(frame, fps, 0),
            translate: rise(0),
          }}
        >
          {String(index).padStart(2, "0")} / 12 · {eyebrow}
        </div>
        <h2
          style={{
            margin: "12px 0 0",
            fontSize: 38,
            lineHeight: 1.08,
            fontWeight: 600,
            letterSpacing: "-0.028em",
            textWrap: "balance",
            opacity: pop(frame, fps, 3),
            translate: rise(3),
          }}
        >
          {title}
        </h2>
        <p
          style={{
            margin: "14px 0 0",
            maxWidth: 360,
            fontSize: 16,
            lineHeight: 1.5,
            color: T.ink2,
            textWrap: "pretty",
            opacity: pop(frame, fps, 8),
            translate: rise(8),
          }}
        >
          {text}
        </p>
        {keys && (
          <div style={{ marginTop: 18, opacity: pop(frame, fps, 14) }}>
            <Kbd>{keys}</Kbd>
          </div>
        )}
      </div>
      {/* The stage: what the viewer should notice first, so it gets the most room. */}
      <div
        style={{
          position: "absolute",
          left: 500,
          top: 50,
          width: 720,
          height: 380,
          opacity: pop(frame, fps, 5),
          translate: `0px ${interpolate(pop(frame, fps, 5), [0, 1], [28, 0])}px`,
          scale: String(
            interpolate(frame, [5, 5 + 0.6 * fps], [0.96, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: SETTLE,
              output: "perceptual-scale",
            }),
          ),
          transformOrigin: "50% 60%",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** A faint pool of accent light behind the stage, so the mock does not float on flat black. */
export function Glow() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 620,
        top: -120,
        width: 700,
        height: 700,
        borderRadius: "50%",
        background: `radial-gradient(closest-side, ${T.hiSoft}, transparent)`,
        opacity: 0.55,
        filter: "blur(30px)",
      }}
    />
  );
}

/** A miniature Dive window: traffic lights, address bar, then whatever is inside. */
export function Window({
  url,
  children,
  width = 720,
  height = 380,
  style,
  bare = false,
}: {
  url?: string;
  children: ReactNode;
  width?: number;
  height?: number;
  style?: CSSProperties;
  bare?: boolean;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 16,
        border: `1px solid ${T.line2}`,
        background: T.surface,
        boxShadow: "0 30px 80px -30px rgba(0,0,0,.6)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        fontFamily: T.sans,
        ...style,
      }}
    >
      {!bare && (
        <div style={{ height: 40, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: `1px solid ${T.line}` }}>
          <span style={{ display: "flex", gap: 6 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span key={c} style={{ width: 10, height: 10, borderRadius: 5, background: c, opacity: 0.85 }} />
            ))}
          </span>
          {url && (
            <span
              style={{
                marginLeft: 8,
                flex: 1,
                height: 24,
                borderRadius: 12,
                background: T.surface2,
                border: `1px solid ${T.line}`,
                display: "flex",
                alignItems: "center",
                padding: "0 10px",
                fontFamily: T.mono,
                fontSize: 11,
                color: T.ink2,
              }}
            >
              {url}
            </span>
          )}
        </div>
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

/** Text arriving one character at a time from `start`; the caret blinks while typing and for a beat after. */
export function Typed({
  text,
  start,
  cps = 30,
  caret = true,
  style,
}: {
  text: string;
  start: number;
  cps?: number;
  caret?: boolean;
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shown = Math.max(0, Math.min(text.length, Math.floor(((frame - start) / fps) * cps)));
  const finishedAt = start + (text.length / cps) * fps;
  const typing = frame >= start && shown < text.length;
  const lingering = frame >= finishedAt && frame < finishedAt + 1.2 * fps && Math.floor(frame / 15) % 2 === 0;
  return (
    <span style={style}>
      {text.slice(0, shown)}
      {caret && (typing || lingering) && <span style={{ display: "inline-block", width: 7, height: "1em", verticalAlign: "-0.15em", background: T.hi, marginLeft: 1 }} />}
    </span>
  );
}

/** Keycap. */
export function Kbd({ children, size = 12 }: { children: ReactNode; size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: `${size * 0.35}px ${size * 0.7}px`,
        borderRadius: size * 0.5,
        background: T.surface3,
        border: `1px solid ${T.line2}`,
        fontFamily: T.mono,
        fontSize: size,
        color: T.ink2,
        lineHeight: 1,
      }}
    >
      {children}
    </span>
  );
}

/** Small status pill. */
export function Chip({ children, tone = "quiet", style }: { children: ReactNode; tone?: "quiet" | "hi" | "danger" | "ok"; style?: CSSProperties }) {
  const colors =
    tone === "hi"
      ? { background: T.hiSoft, color: T.hi, border: "transparent" }
      : tone === "danger"
        ? { background: "color-mix(in srgb, var(--color-danger) 18%, transparent)", color: T.danger, border: "transparent" }
        : tone === "ok"
          ? { background: "color-mix(in srgb, #7fd8a0 18%, transparent)", color: T.ok, border: "transparent" }
          : { background: T.surface3, color: T.ink2, border: T.line2 };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 20,
        padding: "0 8px",
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        background: colors.background,
        color: colors.color,
        fontFamily: T.mono,
        fontSize: 10.5,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Content that settles into place once its turn comes, from `dx` pixels to the side. */
export function Reveal({ at, children, dx = -14, style }: { at: number; children: ReactNode; dx?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, at);
  return <div style={{ opacity: p, translate: `${interpolate(p, [0, 1], [dx, 0])}px 0px`, ...style }}>{children}</div>;
}

/** Mouse pointer gliding between waypoints; `clicks` are frames where it presses. */
export function Pointer({
  path,
  clicks = [],
}: {
  /** `[frame, x, y]` waypoints; the pointer eases between consecutive ones. */
  path: [number, number, number][];
  clicks?: number[];
}) {
  const frame = useCurrentFrame();
  const first = path[0];
  if (!first || frame < first[0]) return null;
  let x = first[1];
  let y = first[2];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (frame < a[0]) break;
    const p = interpolate(frame, [a[0], Math.max(a[0] + 1, b[0])], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: SETTLE });
    x = a[1] + (b[1] - a[1]) * p;
    y = a[2] + (b[2] - a[2]) * p;
  }
  const press = clicks.reduce((acc, c) => Math.max(acc, frame >= c && frame < c + 14 ? 1 - (frame - c) / 14 : 0), 0);
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
      {press > 0 && (
        <span
          style={{
            position: "absolute",
            left: -14,
            top: -14,
            width: 28,
            height: 28,
            borderRadius: 14,
            border: `2px solid ${T.hi}`,
            opacity: press,
            scale: String(1.6 - press * 0.6),
          }}
        />
      )}
      <svg width="18" height="20" viewBox="0 0 18 20" style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,.5))" }}>
        <path d="M2 1.5 L15.5 11 L9.2 11.8 L12.4 18.4 L9.9 19.5 L6.8 12.9 L2 16.6 Z" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Grey placeholder text lines, for pages that are scenery rather than subject. */
export function Skeleton({ lines = 4, width = 260, top = 0, left = 0, gap = 12 }: { lines?: number; width?: number; top?: number; left?: number; gap?: number }) {
  return (
    <div style={{ position: "absolute", top, left, display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ height: 8, borderRadius: 4, width: width * (i % 3 === 2 ? 0.55 : i % 2 ? 0.8 : 1), background: T.surface3 }} />
      ))}
    </div>
  );
}
