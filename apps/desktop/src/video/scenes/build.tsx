import { useCurrentFrame, useVideoConfig } from "remotion";
import { Chip, Pointer, Reveal, Scene, Skeleton, T, Typed, Window, pop, ramp, useScene } from "../primitives";

/** Scenes about how Dive is organised and who it talks to. */

const SPACES = [
  { name: "Home", tabs: 3, color: "#7FD8C8", own: false },
  { name: "Client", tabs: 2, color: "#F0B35E", own: true },
  { name: "Research", tabs: 1, color: "#B79CF0", own: true },
];
const TABS: Record<number, string[]> = { 0: ["Dashboard", "Docs", "Figma"], 1: ["client.dev", "Linear"] };

export function Workspaces() {
  const { frame } = useScene();
  const active = frame >= 52 ? 1 : 0;
  return (
    <Scene index={1} eyebrow="Organise" title="A workspace per project" text="Tabs, cookies and logins kept apart. Be signed in as two people at once without a second browser." keys="⌘1 – ⌘9">
      <Window>
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ width: 180, borderRight: `1px solid ${T.line}`, padding: "10px 8px", background: T.ground }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.12em", color: T.ink3, textTransform: "uppercase", padding: "0 8px 8px" }}>Workspaces</div>
            {SPACES.map((w, i) => (
              <Reveal key={w.name} at={6 + i * 4}>
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    height: 34,
                    padding: "0 8px",
                    borderRadius: 8,
                    marginBottom: 4,
                    background: i === active ? T.surface3 : "transparent",
                    color: i === active ? T.ink : T.ink2,
                    fontSize: 12.5,
                  }}
                >
                  {i === active && <span style={{ position: "absolute", left: -6, width: 3, height: 18, borderRadius: 2, background: T.hi }} />}
                  <Mark color={w.color} />
                  <span style={{ flex: 1 }}>{w.name}</span>
                  {w.own && <Shield />}
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink3 }}>{w.tabs}</span>
                </div>
              </Reveal>
            ))}
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <div key={active} style={{ display: "flex", gap: 6, padding: "10px 12px", borderBottom: `1px solid ${T.line}` }}>
              {(TABS[active] ?? []).map((t, i) => (
                <Reveal key={t} at={active ? 54 + i * 3 : 10 + i * 3} dx={8}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      height: 26,
                      padding: "0 10px",
                      borderRadius: 7,
                      background: i === 0 ? T.surface2 : "transparent",
                      border: `1px solid ${i === 0 ? T.line2 : "transparent"}`,
                      fontSize: 11.5,
                      color: i === 0 ? T.ink : T.ink2,
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: SPACES[active]!.color, opacity: 0.8 }} />
                    {t}
                  </span>
                </Reveal>
              ))}
            </div>
            <Skeleton top={70} left={24} lines={5} width={300} />
            <div style={{ position: "absolute", right: 24, top: 70, width: 150, height: 110, borderRadius: 10, background: T.surface2, border: `1px solid ${T.line}` }} />
          </div>
        </div>
        <Pointer path={[[18, 430, 230], [34, 96, 92]]} clicks={[50]} />
      </Window>
    </Scene>
  );
}

function Mark({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: size * 0.36,
        background: color,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <span style={{ position: "absolute", left: "18%", top: "22%", width: "38%", height: "38%", borderRadius: "50%", background: "#141414", opacity: 0.85 }} />
      <span style={{ position: "absolute", right: "12%", bottom: "12%", width: "34%", height: "34%", background: "#f4f4f4", transform: "rotate(45deg)", opacity: 0.9 }} />
    </span>
  );
}

function Shield() {
  return (
    <svg width="11" height="12" viewBox="0 0 24 24" fill="none" stroke={T.ink3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

const TOOLS = ["page_state", "page_screenshot", "console_tail", "network_body", "page_click", "page_report"];

export function Mcp() {
  return (
    <Scene index={2} eyebrow="Connect" title="Built for coding agents" text="Claude Code, Cursor and Codex plug in over MCP and read your tabs, console, network and screenshots.">
      <Window url="MCP · 127.0.0.1:7391">
        <div style={{ position: "absolute", inset: 0, padding: "18px 22px", fontFamily: T.mono, fontSize: 12.5, lineHeight: 1.75, color: T.ink2 }}>
          <div>
            <span style={{ color: T.hi }}>$ </span>
            <Typed text="claude mcp add --transport http dive http://127.0.0.1:7391/mcp" start={4} cps={60} style={{ color: T.ink }} />
          </div>
          <Reveal at={44}>
            <div style={{ color: "#7fd8a0" }}>✓ Connected to Dive · 18 tools</div>
          </Reveal>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 0 10px" }}>
            {TOOLS.map((t, i) => (
              <Reveal key={t} at={50 + i * 2} dx={-6}>
                <Chip tone="hi">{t}</Chip>
              </Reveal>
            ))}
          </div>
          <div>
            <span style={{ color: T.hi }}>$ </span>
            <Typed text='claude "why is checkout failing?"' start={66} cps={48} style={{ color: T.ink }} />
          </div>
          <Reveal at={88}>
            <div>
              <span style={{ color: T.ink3 }}>▸ console_tail </span>→ 2 errors
            </div>
          </Reveal>
          <Reveal at={96}>
            <div>
              <span style={{ color: T.ink3 }}>▸ network_body </span>→ POST /api/checkout <span style={{ color: T.danger }}>500</span>
            </div>
          </Reveal>
          <div style={{ marginTop: 4, color: T.ink }}>
            <Typed text="The 500 is a missing Idempotency-Key header on the checkout POST — added it in api/checkout.ts:41." start={104} cps={55} />
          </div>
        </div>
      </Window>
    </Scene>
  );
}

export function AgentActs() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const allowed = frame >= 104;
  return (
    <Scene index={3} eyebrow="Delegate" title="An agent that acts" text="Ask in plain words. It inspects the page, fills, clicks and navigates — and asks before anything irreversible." keys="⌘J">
      <Window url="app.local/signup">
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ flex: 1, padding: "28px 34px" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Create your account</div>
            <Field label="Name" value="Ada Lovelace" start={26} />
            <Field label="Email" value="ada@acme.test" start={48} />
            <Field label="Password" value="••••••••••••" start={70} />
            <div
              style={{
                marginTop: 14,
                height: 32,
                width: 150,
                borderRadius: 16,
                background: allowed ? T.hi : T.surface3,
                color: allowed ? T.ground : T.ink2,
                display: "grid",
                placeItems: "center",
                fontSize: 12,
                fontWeight: 500,
                transform: `scale(${1 - 0.06 * pop(frame, fps, 104, true) * (frame < 112 ? 1 : 0)})`,
              }}
            >
              {frame >= 116 ? "Welcome, Ada" : "Create account"}
            </div>
          </div>
          <div style={{ width: 270, borderLeft: `1px solid ${T.line}`, padding: 14, display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5, background: T.ground }}>
            <Reveal at={6} dx={10}>
              <div style={{ alignSelf: "flex-end", marginLeft: 30, padding: "8px 10px", borderRadius: 12, background: T.surface3, color: T.ink }}>Fill the form with test data and submit it</div>
            </Reveal>
            <Step at={24} text="Typing into Name" />
            <Step at={46} text="Typing into Email" />
            <Step at={68} text="Typing into Password" />
            <Reveal at={88}>
              <div style={{ padding: 10, borderRadius: 10, border: `1px solid ${T.line2}`, background: T.surface }}>
                <div style={{ color: T.ink, marginBottom: 8 }}>Click “Create account”?</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ height: 24, padding: "0 12px", borderRadius: 12, background: allowed ? T.hi : T.surface3, color: allowed ? T.ground : T.ink, display: "grid", placeItems: "center", fontSize: 11 }}>
                    {allowed ? "Allowed" : "Allow"}
                  </span>
                  <span style={{ height: 24, padding: "0 12px", borderRadius: 12, border: `1px solid ${T.line2}`, color: T.ink2, display: "grid", placeItems: "center", fontSize: 11, opacity: allowed ? 0.4 : 1 }}>Deny</span>
                </div>
              </div>
            </Reveal>
            <Step at={116} text="Done — account created" ok />
          </div>
        </div>
        <Pointer path={[[86, 380, 300], [94, 520, 196]]} clicks={[104]} />
      </Window>
    </Scene>
  );
}

function Field({ label, value, start }: { label: string; value: string; start: number }) {
  const frame = useCurrentFrame();
  const focused = frame >= start && frame < start + 22;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, color: T.ink3, marginBottom: 4 }}>{label}</div>
      <div
        style={{
          height: 30,
          width: 240,
          borderRadius: 8,
          border: `1px solid ${focused ? T.hi : T.line2}`,
          background: T.surface2,
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          fontSize: 12,
          color: T.ink,
          fontFamily: T.mono,
        }}
      >
        <Typed text={value} start={start} cps={40} caret={focused} />
      </div>
    </div>
  );
}

function Step({ at, text, ok = false }: { at: number; text: string; ok?: boolean }) {
  return (
    <Reveal at={at}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: ok ? "#7fd8a0" : T.ink2 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: ok ? "#7fd8a0" : T.hi }} />
        {text}
      </div>
    </Reveal>
  );
}

const SERVERS = [
  { port: 3000, framework: "Next.js", title: "Acme dashboard" },
  { port: 5173, framework: "Vite", title: "design-system" },
  { port: 8080, framework: "Go", title: "api" },
];

export function Localhost() {
  const { frame } = useScene();
  const qr = ramp(frame, 58, 92);
  return (
    <Scene index={12} eyebrow="Share" title="Localhost, found and shared" text="Dev servers show up in the palette by themselves. Any page becomes a QR code that opens on your phone over the LAN.">
      <Window bare>
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ flex: 1, padding: 14 }}>
            <div style={{ height: 40, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
              <span style={{ color: T.ink3 }}>⌕</span>
              <Typed text="local" start={4} cps={20} style={{ color: T.ink }} />
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.1em", color: T.ink3, textTransform: "uppercase", padding: "14px 12px 6px" }}>Local servers</div>
            {SERVERS.map((s, i) => (
              <Reveal key={s.port} at={14 + i * 6}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, height: 34, padding: "0 12px", borderRadius: 8, background: i === 0 && frame > 40 ? T.surface3 : "transparent", fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: T.hi }} />
                  <span style={{ fontFamily: T.mono, color: T.ink }}>localhost:{s.port}</span>
                  <span style={{ color: T.ink2 }}>{s.framework}</span>
                  <span style={{ marginLeft: "auto", color: T.ink3, fontSize: 11 }}>{s.title}</span>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal at={56} dx={20} style={{ width: 250, borderLeft: `1px solid ${T.line}`, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, background: T.ground }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.1em", color: T.ink3, textTransform: "uppercase", alignSelf: "flex-start" }}>Open on your phone</div>
            <div style={{ background: "#fff", padding: 10, borderRadius: 10 }}>
              <Qr size={150} progress={qr} />
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink }}>192.168.1.24:3000</div>
            <div style={{ fontSize: 10.5, color: T.ink3, textAlign: "center" }}>Same Wi‑Fi, no tunnel.</div>
          </Reveal>
        </div>
        <Pointer path={[[36, 300, 260], [46, 120, 86]]} clicks={[54]} />
      </Window>
    </Scene>
  );
}

/** A QR-looking code: real finder patterns, deterministic noise for the rest. */
function Qr({ size, progress }: { size: number; progress: number }) {
  const n = 21;
  const cell = size / n;
  const cells: { x: number; y: number }[] = [];
  const finder = (x: number, y: number) => {
    const inA = (x >= 0 && x < 7 && y >= 0 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    if (!inA) return null;
    const lx = x < 7 ? x : x - (n - 7);
    const ly = y < 7 ? y : y - (n - 7);
    const ring = lx === 0 || ly === 0 || lx === 6 || ly === 6;
    const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
    return ring || core;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = finder(x, y);
      const on = f === null ? ((x * 7 + y * 13 + ((x * y) % 5)) * 2654435761) % 7 < 3 : f;
      if (on) cells.push({ x, y });
    }
  }
  const shown = Math.floor(cells.length * progress);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {cells.slice(0, shown).map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x * cell} y={c.y * cell} width={cell + 0.3} height={cell + 0.3} fill="#111" />
      ))}
    </svg>
  );
}
