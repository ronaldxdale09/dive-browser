import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Chip, Pointer, Reveal, Scene, Skeleton, T, Window, pop, ramp, useScene } from "../primitives";
import type { SceneProps } from "../primitives";

/** Scenes about looking inside a page: traffic, console, rules, devices. */

const REQUESTS = [
  { method: "GET", path: "/api/session", status: 200, type: "json", time: "42 ms" },
  { method: "GET", path: "/api/projects", status: 200, type: "json", time: "118 ms" },
  { method: "POST", path: "/api/checkout", status: 500, type: "json", time: "1.2 s" },
  { method: "GET", path: "/assets/app.js", status: 200, type: "script", time: "88 ms" },
  { method: "WS", path: "/realtime", status: 101, type: "ws", time: "↑ 12 ↓ 48" },
];

export function Network({ index }: SceneProps) {
  const { frame } = useScene();
  const open = frame >= 74;
  const replayed = frame >= 108;
  return (
    <Scene index={index} eyebrow="Inspect" title="Network, replayable" text="Every request with headers, bodies and WebSocket frames. Edit and replay one, copy it as cURL, or export the lot as HAR." keys="⌘⇧D">
      <Window url="acme.test/checkout">
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ height: 96, position: "relative", borderBottom: `1px solid ${T.line}` }}>
            <Skeleton top={20} left={24} lines={3} width={220} gap={10} />
          </div>
          <div style={{ flex: 1, display: "flex", fontFamily: T.mono, fontSize: 11.5 }}>
            <div style={{ flex: 1, padding: "8px 0" }}>
              {REQUESTS.map((r, i) => (
                <Reveal key={r.path} at={8 + i * 7}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "52px 1fr 48px 60px 70px",
                      alignItems: "center",
                      height: 30,
                      padding: "0 16px",
                      color: T.ink2,
                      background: i === 2 && open ? T.surface3 : "transparent",
                    }}
                  >
                    <span style={{ color: T.ink3 }}>{r.method}</span>
                    <span style={{ color: T.ink }}>{r.path}</span>
                    <span>
                      <Chip tone={i === 2 ? (replayed ? "ok" : "danger") : r.status === 101 ? "hi" : "quiet"}>{i === 2 && replayed ? 200 : r.status}</Chip>
                    </span>
                    <span style={{ color: T.ink3 }}>{r.type}</span>
                    <span style={{ textAlign: "right", color: T.ink3 }}>{r.time}</span>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal at={74} dx={20} style={{ width: 250, borderLeft: `1px solid ${T.line}`, padding: 14, background: T.ground, display: open ? "block" : "none" }}>
              <div style={{ color: T.ink, marginBottom: 6 }}>POST /api/checkout</div>
              <div style={{ color: T.ink3, fontSize: 10.5, lineHeight: 1.7 }}>
                content-type: application/json
                <br />
                <span style={{ color: replayed ? T.ok : T.ink3 }}>idempotency-key: {replayed ? "9f2c…" : "—"}</span>
              </div>
              <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: T.surface2, color: replayed ? T.ok : T.danger, fontSize: 10.5 }}>
                {replayed ? '{ "ok": true, "order": "A-1042" }' : '{ "error": "idempotency key required" }'}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                <Chip tone={replayed ? "ok" : "hi"}>{replayed ? "✓ Replayed" : "Replay"}</Chip>
                <Chip>cURL</Chip>
                <Chip>HAR</Chip>
              </div>
            </Reveal>
          </div>
        </div>
        <Pointer path={[[50, 380, 60], [62, 200, 172], [84, 200, 172], [94, 500, 290]]} clicks={[70, 104]} />
      </Window>
    </Scene>
  );
}

const LOGS = [
  { level: "log", text: "app booted in 212 ms", tone: T.ink2 },
  { level: "warn", text: "Each child in a list should have a unique key", tone: "#F0B35E" },
  { level: "error", text: "TypeError: cart is undefined · Checkout.tsx:48", tone: T.danger },
];

export function ConsoleVitals({ index }: SceneProps) {
  const { frame } = useScene();
  const grow = ramp(frame, 30, 70);
  return (
    <Scene index={index} eyebrow="Debug" title="Console, vitals, a11y, storage" text="Errors with source-mapped frames, Core Web Vitals as they happen, an axe audit and every cookie — one dock beside the page.">
      <Window url="acme.test/checkout">
        <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1.3fr 1fr", gridTemplateRows: "1fr 1fr", fontFamily: T.mono, fontSize: 11.5 }}>
          <Panel title="Console" style={{ gridRow: "1 / 3", borderRight: `1px solid ${T.line}` }}>
            {LOGS.map((l, i) => (
              <Reveal key={l.text} at={8 + i * 9}>
                <div style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: `1px solid ${T.line}`, color: l.tone }}>
                  <span style={{ width: 40, color: T.ink3 }}>{l.level}</span>
                  <span>{l.text}</span>
                </div>
              </Reveal>
            ))}
            <Reveal at={40}>
              <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: T.surface2, color: T.ink3, fontSize: 10.5, lineHeight: 1.7 }}>
                at Checkout <span style={{ color: T.ink2 }}>src/routes/Checkout.tsx:48:19</span>
                <br />
                at renderWithHooks <span style={{ color: T.ink2 }}>react-dom.development.js</span>
              </div>
            </Reveal>
          </Panel>
          <Panel title="Vitals" style={{ borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
              <Vital label="LCP" value={`${(1.2 * grow).toFixed(1)} s`} pct={0.45 * grow} good />
              <Vital label="CLS" value={(0.02 * grow).toFixed(2)} pct={0.15 * grow} good />
              <Vital label="INP" value={`${Math.round(90 * grow)} ms`} pct={0.35 * grow} good />
            </div>
          </Panel>
          <Panel title="Accessibility">
            <Reveal at={60}>
              <div style={{ color: T.ink2, marginBottom: 8 }}>
                <span style={{ color: T.danger }}>3</span> violations · 41 checks passed
              </div>
            </Reveal>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["color-contrast", "button-name", "label"].map((v, i) => (
                <Reveal key={v} at={66 + i * 5} dx={-6}>
                  <Chip tone="danger">{v}</Chip>
                </Reveal>
              ))}
            </div>
          </Panel>
        </div>
      </Window>
    </Scene>
  );
}

function Panel({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ padding: "12px 16px", minWidth: 0, ...style }}>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.12em", color: T.ink3, textTransform: "uppercase", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Vital({ label, value, pct, good }: { label: string; value: string; pct: number; good: boolean }) {
  const color = good ? T.ok : T.danger;
  return (
    <div style={{ flex: 1 }}>
      <div style={{ color: T.ink3, fontSize: 10 }}>{label}</div>
      <div style={{ color: T.ink, fontSize: 16, margin: "2px 0 6px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ height: 4, borderRadius: 2, background: T.surface3 }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", borderRadius: 2, background: color }} />
      </div>
    </div>
  );
}

const RULES = [
  { pattern: "*/api/flags*", kind: "MOCK", detail: '200 · { "beta": true }', tone: "hi" as const },
  { pattern: "*.analytics.js", kind: "BLOCK", detail: "fail as blocked by client", tone: "danger" as const },
  { pattern: "*/api/*", kind: "HEADER", detail: "X-Env: staging", tone: "quiet" as const },
];
const LANE = [
  { at: 44, label: "flags.json", stamp: "MOCKED · 200", tone: "hi" as const },
  { at: 66, label: "analytics.js", stamp: "BLOCKED", tone: "danger" as const },
  { at: 88, label: "/api/users", stamp: "+ X-Env", tone: "quiet" as const },
];

export function Rules({ index }: SceneProps) {
  const { frame } = useScene();
  return (
    <Scene index={index} eyebrow="Control" title="Mock and rewrite rules" text="Block a script, answer an endpoint with a canned response, or add a header — per workspace, applied before the request leaves.">
      <Window url="Rules · Client">
        <div style={{ position: "absolute", inset: 0, padding: "14px 18px", fontFamily: T.mono, fontSize: 11.5 }}>
          {RULES.map((r, i) => (
            <Reveal key={r.pattern} at={6 + i * 7}>
              <div style={{ display: "grid", gridTemplateColumns: "150px 80px 1fr", alignItems: "center", height: 36, borderBottom: `1px solid ${T.line}`, color: T.ink2 }}>
                <span style={{ color: T.ink }}>{r.pattern}</span>
                <span>
                  <Chip tone={r.tone}>{r.kind}</Chip>
                </span>
                <span style={{ color: T.ink3 }}>{r.detail}</span>
              </div>
            </Reveal>
          ))}
          <div style={{ fontSize: 9.5, letterSpacing: "0.12em", color: T.ink3, textTransform: "uppercase", margin: "18px 0 8px" }}>Live</div>
          <div style={{ position: "relative", height: 130 }}>
            {LANE.map((l, i) => {
              const p = ramp(frame, l.at, l.at + 22);
              const stamped = frame >= l.at + 22;
              if (frame < l.at) return null;
              return (
                <div key={l.label} style={{ position: "absolute", top: i * 42, left: interpolate(p, [0, 1], [0, 300]), display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 28, padding: "0 12px", borderRadius: 14, background: T.surface2, border: `1px solid ${T.line2}`, color: T.ink }}>
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: T.ink3 }} />
                    {l.label}
                  </span>
                  {stamped && (
                    <span style={{ scale: String(pop(frame, 30, l.at + 22, true)), transformOrigin: "left center" }}>
                      <Chip tone={l.tone}>{l.stamp}</Chip>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Window>
    </Scene>
  );
}

const DEVICE_CHIPS = ["iPhone 15 Pro · 3×", "Touch", "Slow 3G", "prefers-color-scheme: dark"];

export function Mobile({ index }: SceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: Math.max(0, frame - 28), fps, config: { damping: 18, stiffness: 90 } });
  const width = interpolate(p, [0, 1], [560, 214]);
  const narrow = width < 380;
  return (
    <Scene index={index} eyebrow="Emulate" title="Mobile simulator" text="Real viewport, pixel ratio and touch, plus throttled networks and media features. Presets for the phones you actually test on.">
      <Window url="acme.test">
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 28 }}>
          <div style={{ width, height: 300, borderRadius: narrow ? 26 : 10, border: `${narrow ? 6 : 1}px solid ${narrow ? T.surface3 : T.line2}`, background: T.ground, overflow: "hidden", position: "relative", transition: "none" }}>
            <div style={{ height: 34, borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: T.hi }} />
              <span style={{ flex: 1 }} />
              {!narrow && ["Docs", "Pricing", "Sign in"].map((n) => <span key={n} style={{ width: 34, height: 6, borderRadius: 3, background: T.surface3 }} />)}
              {narrow && <span style={{ width: 14, height: 10, borderTop: `2px solid ${T.ink3}`, borderBottom: `2px solid ${T.ink3}` }} />}
            </div>
            <div style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ width: narrow ? "100%" : (width - 40) / 3, height: narrow ? 58 : 110, borderRadius: 8, background: T.surface2, border: `1px solid ${T.line}` }} />
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 190 }}>
            {DEVICE_CHIPS.map((c, i) => (
              <Reveal key={c} at={58 + i * 6}>
                <Chip tone={i === 0 ? "hi" : "quiet"} style={{ height: 26, fontSize: 11 }}>
                  {c}
                </Chip>
              </Reveal>
            ))}
          </div>
        </div>
      </Window>
    </Scene>
  );
}
