import { AbsoluteFill, interpolate } from "remotion";
import { Glow, Kbd, Reveal, T, pop, useScene } from "../primitives";

/** The reel's open and close. Both start and end on the bare ground colour so the loop has no seam. */

export const FEATURE_NAMES = [
  "Workspaces",
  "Coding agents",
  "Agent",
  "Network",
  "Console",
  "Rules",
  "Mobile",
  "Recording",
  "Capture",
  "Playwright",
  "Bug reports",
  "Localhost",
];

export function Intro() {
  const { frame, fps, opacity } = useScene();
  const word = pop(frame, fps, 2);
  const line = pop(frame, fps, 14);
  const tag = pop(frame, fps, 18);
  return (
    <AbsoluteFill style={{ background: T.ground, color: T.ink, fontFamily: T.sans, opacity, alignItems: "center", justifyContent: "center" }}>
      <Glow />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", top: -20 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 12,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: T.hi,
            opacity: word,
            transform: `translateY(${(1 - word) * 10}px)`,
          }}
        >
          Dive
        </div>
        <h1
          style={{
            margin: "14px 0 0",
            fontSize: 58,
            lineHeight: 1.05,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            textAlign: "center",
            opacity: word,
            transform: `translateY(${(1 - word) * 24}px) scale(${0.96 + 0.04 * word})`,
          }}
        >
          The browser built for developers
        </h1>
        <div style={{ marginTop: 22, width: interpolate(line, [0, 1], [0, 72]), height: 2, borderRadius: 1, background: T.hi }} />
        <p style={{ margin: "18px 0 0", fontSize: 17, color: T.ink2, opacity: tag, transform: `translateY(${(1 - tag) * 12}px)` }}>
          Chromium, a workspace per project, a toolkit beside the page, and an agent that works in your tabs.
        </p>
      </div>
      <div style={{ position: "absolute", bottom: 46, display: "flex", gap: 8 }}>
        {FEATURE_NAMES.map((name, i) => (
          <Reveal key={name} at={56 + i * 3} dx={0} style={{ transform: `translateY(${(1 - pop(frame, fps, 56 + i * 3)) * 10}px)` }}>
            <span style={{ display: "inline-block", padding: "5px 10px", borderRadius: 999, border: `1px solid ${T.line2}`, fontSize: 11, color: T.ink2 }}>{name}</span>
          </Reveal>
        ))}
      </div>
    </AbsoluteFill>
  );
}

export function Outro() {
  const { frame, fps, opacity } = useScene();
  const title = pop(frame, fps, 2);
  const key = pop(frame, fps, 14, true);
  const press = frame >= 44 && frame < 56 ? 1 - Math.abs((frame - 50) / 6) : 0;
  const after = pop(frame, fps, 58);
  return (
    <AbsoluteFill style={{ background: T.ground, color: T.ink, fontFamily: T.sans, opacity, alignItems: "center", justifyContent: "center" }}>
      <Glow />
      <h2 style={{ margin: 0, fontSize: 40, fontWeight: 600, letterSpacing: "-0.03em", opacity: title, transform: `translateY(${(1 - title) * 18}px)` }}>
        Everything is a keystroke away.
      </h2>
      <div style={{ marginTop: 30, opacity: key, transform: `scale(${(0.9 + 0.1 * key) * (1 - press * 0.08)})` }}>
        <Kbd size={30}>⌘K</Kbd>
      </div>
      <p style={{ margin: "26px 0 0", fontSize: 15, color: T.ink2, opacity: after, transform: `translateY(${(1 - after) * 10}px)` }}>
        Tabs, history, bookmarks, local servers and every command — one palette.
      </p>
      <div style={{ position: "absolute", bottom: 40, fontFamily: T.mono, fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink3, opacity: after }}>
        Dive
      </div>
    </AbsoluteFill>
  );
}
