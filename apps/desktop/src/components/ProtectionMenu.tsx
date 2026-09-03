import { Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBrowser } from "../store/browser";
import { selectRequests, useNetwork } from "../store/network";
import { usePrefs } from "../store/prefs";
import { FeatureButton } from "./FeatureBar";
import { Icon } from "./Icon";
import { Switch } from "./SettingsFields";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";

/**
 * Protection: the tracker blocker and its neighbours, one click from the
 * page they act on. The same preferences as Settings › Privacy; this is the
 * place to see them working — how many requests this tab lost to them.
 */
export function ProtectionMenu({ compact = false }: { compact?: boolean } = {}) {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const activeTab = useBrowser((s) => s.activeTab);
  const toggle = useBrowser((s) => s.toggle);
  const blocked = useNetwork((s) => selectRequests(activeTab)(s).filter((r) => r.error?.includes("BLOCKED_BY_CLIENT")).length);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const on = prefs.block_trackers;
  return (
    <div ref={ref} className="relative">
      <FeatureButton icon={on ? ShieldCheck : Shield} label="Protection" iconOnly={compact} tone={on ? "hi" : "quiet"} active={open} onClick={() => setOpen((o) => !o)}>
        {on && blocked > 0 && (
          <span className="ml-0.5 rounded-full bg-highlight-soft px-1.5 py-px font-mono text-[10px] leading-4 text-highlight" aria-label={`${blocked} blocked on this page`}>
            {blocked}
          </span>
        )}
      </FeatureButton>
      {open && (
        <div ref={panel} role="dialog" aria-label="Protection" className="absolute right-0 z-50 mt-1 w-80 rounded-xl border border-line-2 bg-surface p-1.5 text-xs shadow-2xl">
          <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5">
            <span className={`grid size-8 shrink-0 place-items-center rounded-full ${on ? "bg-highlight-soft text-highlight" : "bg-surface-3 text-ink-3"}`}>
              <Icon icon={on ? ShieldCheck : Shield} size={15} />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-ink">{on ? `${blocked} ${blocked === 1 ? "request" : "requests"} blocked on this page` : "Tracker blocking is off"}</span>
              <span className="block text-[10.5px] text-ink-3">{on ? "Analytics and ad hosts never leave the browser." : "Pages load exactly as they are served."}</span>
            </span>
          </div>
          <Toggle label="Block trackers and ads" hint="A short list of analytics and ad hosts; blocked requests still show in the Network panel." checked={prefs.block_trackers} onChange={(v) => void update({ block_trackers: v })} />
          <Toggle label="Send “Do Not Track”" hint="DNT: 1 and Sec-GPC: 1 on every request." checked={prefs.do_not_track} onChange={(v) => void update({ do_not_track: v })} />
          <Toggle label="Run page JavaScript" hint="Off loads every page script-free." checked={prefs.javascript} onChange={(v) => void update({ javascript: v })} />
          <div className="mt-1 flex items-center border-t border-line pt-1.5">
            <span className="px-2 text-[10.5px] text-ink-3">Applies to every workspace.</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                toggle("settings", true);
              }}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <Icon icon={SlidersHorizontal} size={12} /> All privacy settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-ink">{label}</span>
        <span className="block text-[10.5px] leading-relaxed text-ink-3">{hint}</span>
      </span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}
