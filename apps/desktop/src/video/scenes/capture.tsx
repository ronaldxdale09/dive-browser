import { interpolate } from "remotion";
import { Chip, Pointer, Reveal, Scene, Skeleton, T, Typed, Window, pop, ramp, useScene } from "../primitives";

/** Scenes about getting something out of the browser: pixels, tests, reports. */

export function Recording() {
  const { frame, fps } = useScene();
  const seconds = Math.min(4, Math.floor(frame / fps));
  const bar = ramp(frame, 10, 100);
  const done = frame >= 96;
  return (
    <Scene index={8} eyebrow="Capture" title="Record a tab as a GIF" text="One chord starts recording, the same one stops it. The GIF lands on disk and in your clipboard, ready for the pull request." keys="⌘⇧R">
      <Window url="acme.test/analytics">
        <div style={{ position: "absolute", inset: 0, padding: "26px 30px" }}>
          <Skeleton lines={2} width={180} top={26} left={30} />
          <div style={{ position: "absolute", left: 30, right: 30, top: 80, height: 180, borderRadius: 12, border: `1px solid ${T.line}`, background: T.surface2, padding: 16, display: "flex", alignItems: "flex-end", gap: 10 }}>
            {[0.3, 0.55, 0.42, 0.7, 0.62, 0.88, 0.76, 0.95, 0.6, 0.8].map((h, i) => (
              <div key={i} style={{ flex: 1, height: `${h * 100 * ramp(frame, 8 + i * 5, 30 + i * 5)}%`, borderRadius: 4, background: i === 7 ? T.hi : T.surface3 }} />
            ))}
          </div>
          {!done && (
            <div style={{ position: "absolute", right: 18, top: 14, display: "flex", alignItems: "center", gap: 8, height: 26, padding: "0 10px", borderRadius: 13, background: "color-mix(in srgb, var(--color-danger) 18%, transparent)", color: T.danger, fontFamily: T.mono, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: T.danger, opacity: Math.floor(frame / 15) % 2 ? 0.35 : 1 }} />
              REC 00:0{seconds}
            </div>
          )}
          <div style={{ position: "absolute", left: 30, right: 30, bottom: 26, height: 3, borderRadius: 2, background: T.surface3 }}>
            <div style={{ width: `${bar * 100}%`, height: "100%", borderRadius: 2, background: done ? "#7fd8a0" : T.danger }} />
          </div>
          <Reveal at={96} dx={0} style={{ position: "absolute", left: "50%", bottom: 44, transform: "translateX(-50%)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 14, background: T.surface, border: `1px solid ${T.line2}`, boxShadow: "0 20px 50px -20px rgba(0,0,0,.7)" }}>
              <div style={{ width: 64, height: 40, borderRadius: 6, background: T.surface2, border: `1px solid ${T.line}`, display: "flex", alignItems: "flex-end", gap: 2, padding: 4 }}>
                {[0.4, 0.7, 0.55, 0.9, 0.65].map((h, i) => (
                  <span key={i} style={{ flex: 1, height: `${h * 100}%`, background: i === 3 ? T.hi : T.surface3, borderRadius: 1 }} />
                ))}
              </div>
              <div style={{ fontSize: 11.5 }}>
                <div style={{ color: T.ink, fontFamily: T.mono }}>dive-2026-09-04-analytics.gif</div>
                <div style={{ color: T.ink3, marginTop: 2 }}>1.4 MB · saved and copied to clipboard</div>
              </div>
              <Chip tone="ok">GIF</Chip>
            </div>
          </Reveal>
        </div>
      </Window>
    </Scene>
  );
}

export function FullPage() {
  const { frame } = useScene();
  const scroll = interpolate(ramp(frame, 10, 58), [0, 1], [0, -420]);
  const dash = ramp(frame, 70, 92);
  return (
    <Scene index={9} eyebrow="Capture" title="Full-page capture and annotate" text="The whole document in one image, then arrows, boxes and notes drawn right on it. Copied the moment you are done." keys="⌘⇧S">
      <Window url="acme.test/pricing">
        <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: scroll, height: 760, padding: "26px 40px" }}>
            <Skeleton lines={2} width={240} top={26} left={40} />
            <div style={{ position: "absolute", top: 90, left: 40, right: 40, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ height: 200, borderRadius: 12, border: `1px solid ${i === 1 ? T.hi : T.line}`, background: T.surface2, padding: 14 }}>
                  <div style={{ width: 60, height: 8, borderRadius: 4, background: T.surface3 }} />
                  <div style={{ width: 90, height: 22, borderRadius: 5, background: T.surface3, marginTop: 14 }} />
                  <div style={{ width: "100%", height: 30, borderRadius: 15, background: i === 1 ? T.hi : T.surface3, marginTop: 100, opacity: 0.9 }} />
                </div>
              ))}
            </div>
            <Skeleton lines={6} width={520} top={330} left={40} />
            <div style={{ position: "absolute", top: 470, left: 40, right: 40, height: 160, borderRadius: 12, background: T.surface2, border: `1px solid ${T.line}` }} />
            <Skeleton lines={3} width={520} top={660} left={40} />
          </div>
          {frame >= 12 && frame < 60 && (
            <div style={{ position: "absolute", left: 0, right: 0, top: interpolate(ramp(frame, 12, 58), [0, 1], [0, 340]), height: 2, background: T.hi, boxShadow: `0 0 18px ${T.hi}`, opacity: 0.8 }} />
          )}
          {/* Annotations sit on the block that is in view once the scroll
              settles (page y 470, i.e. `470 + scroll` on screen). */}
          <svg width="720" height="340" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <defs>
              <marker id="reel-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill={T.danger} />
              </marker>
            </defs>
            {dash > 0 && (
              <rect
                x={52}
                y={482 + scroll}
                width={300}
                height={136}
                rx={12}
                fill="none"
                stroke={T.danger}
                strokeWidth={2.5}
                strokeDasharray={872}
                strokeDashoffset={872 - 872 * dash}
              />
            )}
            {frame >= 90 && (
              <path
                d={`M 470 ${590 + scroll} L 366 ${556 + scroll}`}
                stroke={T.danger}
                strokeWidth={2.5}
                fill="none"
                strokeDasharray={120}
                strokeDashoffset={120 - 120 * ramp(frame, 90, 102)}
                markerEnd="url(#reel-arrow)"
              />
            )}
          </svg>
          {frame >= 102 && (
            <div style={{ position: "absolute", left: 478, top: 578 + scroll, fontFamily: T.sans, fontSize: 13, color: T.danger, fontWeight: 500, background: T.ground, padding: "2px 6px", borderRadius: 6 }}>
              <Typed text="off by 4px" start={102} cps={30} caret={false} />
            </div>
          )}
          <Reveal at={116} dx={0} style={{ position: "absolute", left: 16, bottom: 14 }}>
            <Chip tone="ok" style={{ height: 24 }}>
              ✓ Copied · capture-pricing-full.png
            </Chip>
          </Reveal>
        </div>
      </Window>
    </Scene>
  );
}

const STEPS = [
  { at: 22, code: "await page.getByLabel('Email').fill('dev@acme.test');" },
  { at: 52, code: "await page.getByLabel('Password').fill(process.env.PW);" },
  { at: 82, code: "await page.getByRole('button', { name: 'Sign in' }).click();" },
  { at: 104, code: "await expect(page).toHaveURL('/dashboard');" },
];

export function Recorder() {
  const { frame, fps } = useScene();
  const finished = frame >= 110;
  return (
    <Scene index={10} eyebrow="Automate" title="Recorder to Playwright" text="Click through a flow once. Dive picks stable locators — roles, labels, test ids — and writes the test you would have written.">
      <Window url="acme.test/login">
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ flex: 1, padding: "30px 34px" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Sign in</div>
            <Input label="Email" value="dev@acme.test" start={22} active={frame >= 20 && frame < 50} />
            <Input label="Password" value="••••••••••" start={52} active={frame >= 50 && frame < 80} />
            <div style={{ marginTop: 14, width: 110, height: 30, borderRadius: 15, background: T.hi, color: T.ground, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 500, transform: `scale(${1 - 0.07 * (frame >= 82 && frame < 92 ? 1 - (frame - 82) / 10 : 0)})` }}>
              Sign in
            </div>
          </div>
          <div style={{ width: 330, borderLeft: `1px solid ${T.line}`, background: T.ground, padding: 14, fontFamily: T.mono, fontSize: 10.5, lineHeight: 1.7 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: finished ? "#7fd8a0" : T.danger, opacity: finished || Math.floor(frame / 15) % 2 ? 1 : 0.35 }} />
              <span style={{ color: T.ink2, fontSize: 10.5 }}>{finished ? "Playwright · copied" : `Recording · ${STEPS.filter((s) => frame >= s.at).length} steps`}</span>
            </div>
            <div style={{ color: T.ink3 }}>test('sign in', async ({'{'} page {'}'}) =&gt; {'{'}</div>
            {STEPS.map((s) => (
              <div key={s.code} style={{ paddingLeft: 14, color: T.ink, opacity: frame >= s.at ? 1 : 0, transform: `translateY(${(1 - pop(frame, fps, s.at)) * 6}px)` }}>
                <Typed text={s.code} start={s.at} cps={90} caret={false} />
              </div>
            ))}
            <div style={{ color: T.ink3 }}>{'}'});</div>
          </div>
        </div>
        <Pointer path={[[10, 300, 280], [18, 120, 102], [46, 120, 102], [50, 120, 170], [76, 120, 170], [80, 80, 236]]} clicks={[20, 50, 82]} />
      </Window>
    </Scene>
  );
}

function Input({ label, value, start, active }: { label: string; value: string; start: number; active: boolean }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, color: T.ink3, marginBottom: 4 }}>{label}</div>
      <div style={{ height: 30, width: 230, borderRadius: 8, border: `1px solid ${active ? T.hi : T.line2}`, background: T.surface2, display: "flex", alignItems: "center", padding: "0 10px", fontFamily: T.mono, fontSize: 12, color: T.ink }}>
        <Typed text={value} start={start} cps={36} caret={active} />
      </div>
    </div>
  );
}

const PARTS = [
  { at: 12, icon: "▣", label: "Screenshot", detail: "checkout.png · annotated" },
  { at: 26, icon: "✕", label: "Console", detail: "1 error · TypeError at Checkout.tsx:48", danger: true },
  { at: 40, icon: "↯", label: "Network", detail: "1 failed · POST /api/checkout 500", danger: true },
  { at: 54, icon: "≡", label: "Steps to reproduce", detail: "4 recorded interactions" },
  { at: 68, icon: "⌂", label: "Environment", detail: "Chromium 151 · macOS 15 · 1512×982" },
];

export function BugReport() {
  const { frame } = useScene();
  const copied = frame >= 92;
  return (
    <Scene index={11} eyebrow="Report" title="Bug report composer" text="Screenshot, console errors, failed requests, the steps you took and the environment — bundled into Markdown you can paste anywhere." keys="⌘⇧B">
      <Window bare>
        <div style={{ position: "absolute", inset: 0, padding: "22px 28px", display: "flex", gap: 24 }}>
          <div style={{ flex: 1 }}>
            <Reveal at={2}>
              <div style={{ fontFamily: T.mono, fontSize: 15, color: T.ink, marginBottom: 14 }}>
                <span style={{ color: T.ink3 }}># </span>Checkout returns 500 for repeat orders
              </div>
            </Reveal>
            {PARTS.map((p) => (
              <Reveal key={p.label} at={p.at}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, height: 40, borderBottom: `1px solid ${T.line}` }}>
                  <span style={{ width: 24, height: 24, borderRadius: 6, background: p.danger ? "color-mix(in srgb, var(--color-danger) 18%, transparent)" : T.hiSoft, color: p.danger ? T.danger : T.hi, display: "grid", placeItems: "center", fontSize: 12 }}>
                    {p.icon}
                  </span>
                  <span style={{ fontSize: 12.5, color: T.ink, width: 140 }}>{p.label}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink3 }}>{p.detail}</span>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal at={80} dx={16} style={{ width: 200, alignSelf: "center" }}>
            <div style={{ padding: 16, borderRadius: 14, border: `1px solid ${T.line2}`, background: T.ground, textAlign: "center" }}>
              <div style={{ width: 44, height: 44, borderRadius: 22, margin: "0 auto 10px", background: copied ? "#7fd8a0" : T.surface3, color: T.ground, display: "grid", placeItems: "center", fontSize: 20, transform: `scale(${copied ? pop(frame, 30, 92, true) : 1})` }}>
                {copied ? "✓" : "…"}
              </div>
              <div style={{ fontSize: 12.5, color: T.ink }}>{copied ? "Copied as Markdown" : "Composing…"}</div>
              <div style={{ fontSize: 10.5, color: T.ink3, marginTop: 4 }}>{copied ? "Paste into Linear, GitHub or Slack" : "Gathering the last 60 s"}</div>
            </div>
          </Reveal>
        </div>
      </Window>
    </Scene>
  );
}
