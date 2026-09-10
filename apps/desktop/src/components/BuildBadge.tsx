import { useDismiss } from "../lib/useDismiss";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { errorMessage } from "../lib/errors";
import type { AppInfo } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { copyText } from "../lib/clipboard";

/**
 * Which build this is: DEV for a checkout run through `tauri dev`, BETA for a
 * release. Sits in the title bar as a quiet pill; clicking it shows the
 * version, build number, commit and when it was compiled, for bug reports.
 */
export function BuildBadge({ align = "end", side = "below" }: {
  /** Which edge the details panel hangs from: `start` when the badge sits at the left of a bar. */
  align?: "start" | "end";
  /** Which way the panel opens: `above` when the badge sits at the foot of the rail. */
  side?: "below" | "above";
} = {}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });

  useEffect(() => {
    let alive = true;
    void ipc
      .appInfo()
      .then((v) => alive && setInfo(v))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);

  useDismiss(ref, open, dismiss);

  const channel = info?.build.channel ?? (import.meta.env.DEV ? "dev" : "beta");
  const dev = channel === "dev";
  const label = dev ? "DEV" : "BETA";
  // A beta build is the normal state of this app, so its badge is furniture:
  // neutral, the same weight as the labels around it. DEV keeps amber, since
  // running a development build by accident is worth catching the eye. Amber,
  // not red: red beside a Capture control reads as "recording".
  const tone = dev
    ? "border-warn/40 bg-warn/15 text-warn hover:bg-warn/25 aria-expanded:bg-warn/25"
    : "border-line-2 bg-surface-2 text-ink-3 hover:bg-surface-3 hover:text-ink-2 aria-expanded:bg-surface-3 aria-expanded:text-ink-2";
  const dot = dev ? "bg-warn" : "bg-ink-3/60";
  const built = info ? formatBuilt(info.build.built_at ?? 0) : null;
  const summary = info ? `Dive ${info.version} (${label.toLowerCase()} build ${info.build.number}, built ${built ?? "unknown"})` : "";

  const copy = () => {
    copyText(summary)
      .then(() => useBrowser.getState().notify("Build details copied"))
      .catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };

  return (
    <div ref={ref} className="relative">
      <Tooltip label={dev ? "Development build · details" : "Beta release · details"} side="bottom" align={align}>
        <button
          type="button"
          aria-label={`${dev ? "Development" : "Beta"} build`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`pressable flex h-5 shrink-0 items-center gap-1.5 rounded-md border px-1.5 font-mono text-[10px] font-semibold tracking-[0.1em] transition-[color,background-color,transform] ${tone}`}
        >
          <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
          {label}
        </button>
      </Tooltip>
      {open && (
        <div ref={panel} role="dialog" aria-label="Build details" className={`absolute z-50 w-64 max-w-[calc(100vw-16px)] rounded-xl border border-line-2 bg-surface p-1.5 text-xs shadow-2xl ${align === "start" ? "left-0" : "right-0"} ${side === "above" ? "bottom-full mb-1.5" : "mt-1.5"}`}>
          <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
            <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
            <span className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{dev ? "Development build" : "Beta release"}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 py-1">
            <Fact label="Version" value={info?.version} />
            <Fact label="Build" value={info?.build.number} />
            <Fact label="Built" value={built} />
          </dl>
          <div className="mt-1 flex justify-end border-t border-line-2 px-1 pt-1.5">
            <button type="button" onClick={copy} disabled={!info} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
              <Icon icon={Copy} size={12} /> Copy details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-ink select-text" title={value ?? undefined}>
        {value ?? "…"}
      </dd>
    </>
  );
}

/** The build time in the viewer's locale, or null when the build has none. */
export function formatBuilt(unixSeconds: number): string | null {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
