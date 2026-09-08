import { Bot, Clapperboard, Globe, LayoutGrid, PanelBottom, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, useRef } from "react";
import { useDefaultBrowser } from "../../store/defaultBrowser";
import { useOnboarding } from "../../store/onboarding";
import { usePrefs } from "../../store/prefs";
import { Icon } from "../Icon";
import { Switch } from "../SettingsFields";
import { StepActions, stepLabel } from "./Shell";

const FeatureReel = lazy(() => import("../FeatureReel").then(({ FeatureReel }) => ({ default: FeatureReel })));

/** What is inside, four lines: each names the surfaces that go together. */
export const FEATURES: { icon: LucideIcon; title: string; text: string; keys: string }[] = [
  { icon: LayoutGrid, title: "Workspaces and profiles", text: "Tabs per project, logins per person.", keys: "⌘1–9" },
  { icon: Bot, title: "Agent and coding agents", text: "In your tabs, or over MCP from Claude Code.", keys: "⌘J" },
  { icon: PanelBottom, title: "Developer dock and simulator", text: "Network, console, rules, phone frames.", keys: "⌘⇧D" },
  { icon: Clapperboard, title: "Record, DiveScreen, subtitles", text: "Record a tab, cut a demo, add captions.", keys: "⌘⇧R" },
];

/**
 * What Dive can do in four lines, and two choices worth making now:
 * protection on, and Dive as the default browser. Finishing writes the choices and
 * hands over to the welcome screen.
 */
export function FeaturesStep() {
  // A new step announces itself: focus lands on its heading, not on the
  // chrome behind the dialog, so the keyboard and a screen reader follow.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const finish = useOnboarding((s) => s.finish);
  const blockTrackers = usePrefs((s) => s.prefs.block_trackers);
  const update = usePrefs((s) => s.update);
  // Preselected: someone who installs a browser with a privacy shield wants it on.
  const [protect, setProtect] = useState(true);
  const [tour, setTour] = useState(false);
  const status = useDefaultBrowser((s) => s.status);
  const phase = useDefaultBrowser((s) => s.phase);
  const refresh = useDefaultBrowser((s) => s.refresh);
  const makeDefault = useDefaultBrowser((s) => s.makeDefault);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const isDefault = status?.is_default === true;
  const canAsk = status?.supported !== false && !isDefault && phase !== "asking";

  const done = async () => {
    if (protect !== blockTrackers) await update({ block_trackers: protect });
    await finish();
  };

  return (
    <div>
      <p className="font-mono text-[10.5px] tracking-[0.18em] text-highlight uppercase">{stepLabel("features")}</p>
      <h2 ref={heading} tabIndex={-1} className="mt-1 text-lg font-semibold tracking-[-0.02em] outline-none">What's inside</h2>
      <p className="mt-0.5 text-xs text-ink-3">Everything is a keystroke away, and ⌘K finds the rest.</p>
      <ul className="mt-4 divide-y divide-line" aria-label="Features">
        {FEATURES.map((f, i) => (
          <li key={f.title} className="feature-card flex items-center gap-3 py-2" style={{ "--i": i } as React.CSSProperties}>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-highlight-soft text-highlight">
              <Icon icon={f.icon} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className="font-medium text-ink">{f.title}</span>
              <span className="text-ink-3"> · {f.text}</span>
            </span>
            <kbd className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">{f.keys}</kbd>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-[10px] tracking-[0.16em] text-ink-3 uppercase">Set up now</p>
      <div className="mt-1 divide-y divide-line">
        <div className="flex items-center gap-3 py-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-highlight-soft text-highlight">
            <Icon icon={ShieldCheck} size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">
            <span className="text-ink">Block ads and trackers</span>
            <span className="text-ink-3"> · In the engine, pausable per site.</span>
          </span>
          <Switch label="Block ads and trackers" checked={protect} onChange={setProtect} />
        </div>
        <div className="flex items-center gap-3 py-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-highlight-soft text-highlight">
            <Icon icon={Globe} size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">
            <span className="text-ink">{isDefault ? "Dive is your default browser" : "Open links from other apps in Dive"}</span>
            <span className="text-ink-3">{isDefault ? " · Links already open here." : phase === "waiting" ? " · macOS is asking you to confirm." : " · macOS will ask to confirm."}</span>
          </span>
          {!isDefault && (
            <button type="button" disabled={!canAsk} onClick={() => void makeDefault()} className="pressable h-7 shrink-0 rounded-full border border-line-2 px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40">
              {phase === "asking" ? "Asking…" : "Set as default"}
            </button>
          )}
        </div>
      </div>
      <button type="button" onClick={() => setTour((t) => !t)} aria-expanded={tour} className="mt-3 text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
        {tour ? "Hide the tour" : "Watch the one-minute tour"}
      </button>
      {tour && (
        <div className="mt-2">
          <Suspense fallback={<div role="status" aria-label="Loading feature tour" className="aspect-[8/3] w-full rounded-2xl bg-surface-2/50" />}>
            <FeatureReel />
          </Suspense>
        </div>
      )}
      <StepActions primary="Start browsing" onPrimary={() => void done()} />
    </div>
  );
}
