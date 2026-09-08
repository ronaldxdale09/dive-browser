import { useDismiss } from "../lib/useDismiss";
import { Megaphone, Play, Radar, Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCoversContent } from "../lib/overlay";
import { privacyGuardian } from "../lib/privacyAvatar";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { selectPrivacyCounts, usePrivacy } from "../store/privacy";
import { usePrefs } from "../store/prefs";
import { FeatureButton } from "./FeatureBar";
import { Icon } from "./Icon";
import { Switch } from "./SettingsFields";

/** DivePrivacy status and recovery controls for the active page. */
export function ProtectionMenu({ compact = false }: { compact?: boolean } = {}) {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const tabs = useBrowser((s) => s.tabs);
  const activeTab = useBrowser((s) => s.activeTab);
  const openSettings = useBrowser((s) => s.openSettings);
  const counts = usePrivacy(selectPrivacyCounts(activeTab));
  const info = usePrivacy((s) => s.info);
  const infoError = usePrivacy((s) => s.infoError);
  const eventError = usePrivacy((s) => s.eventError);
  const loadInfo = usePrivacy((s) => s.loadInfo);
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const [siteSaving, setSiteSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const siteControl = useRef<HTMLSpanElement>(null);
  const previousGlobalOn = useRef(prefs.block_trackers);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, onEscape: () => setOpen(false) });

  const tab = tabs.find((candidate) => candidate.id === activeTab);
  const host = pageHost(tab?.url);
  const globalOn = prefs.block_trackers;
  const paused = host !== null && prefs.privacy_exceptions.includes(host);
  const siteOn = globalOn && host !== null && !paused;
  const youtubeSite = host === "www.youtube.com" || host === "m.youtube.com";
  const youtubeActive = siteOn && youtubeSite && prefs.youtube_protection;
  const total = counts.ads + counts.trackers + counts.youtube;
  const headline = !globalOn ? "DivePrivacy is off" : !host ? "Protection unavailable here" : paused ? "Protection paused here" : "Protected on this site";
  // Paused, the zeros mean nothing was looked at, not that the site is clean.
  const summary = !globalOn ? "Turn it on to block ads and trackers" : eventError ? "Activity unavailable" : paused ? "Nothing is blocked while paused" : total === 0 ? "Clean so far" : `${total} privacy actions so far`;

  useEffect(() => {
    if (open && !info) void loadInfo().catch(() => undefined);
  }, [info, loadInfo, open]);

  useEffect(() => {
    if (open && globalOn && !previousGlobalOn.current && !panel.current?.contains(document.activeElement)) {
      siteControl.current?.querySelector("button")?.focus({ preventScroll: true });
    }
    previousGlobalOn.current = globalOn;
  }, [globalOn, open]);

  useDismiss(root, open, dismiss);

  const changeSite = async (enabled: boolean) => {
    if (!activeTab || !host || !globalOn || siteSaving) return;
    setSiteSaving(true);
    const exceptions = enabled
      ? prefs.privacy_exceptions.filter((exception) => exception !== host)
      : [...prefs.privacy_exceptions.filter((exception) => exception !== host), host];
    try {
      await update({ privacy_exceptions: exceptions });
    } finally {
      setSiteSaving(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <FeatureButton
        icon={globalOn ? ShieldCheck : Shield}
        label="Protection"
        // The icon alone cannot show a pause; the tooltip and name say so.
        {...(globalOn && paused ? { tip: "Protection paused on this site" } : {})}
        iconOnly={compact}
        tone={siteOn ? "hi" : "quiet"}
        active={open}
        hasPopup="dialog"
        onClick={() => setOpen((value) => !value)}
        tooltipAlign="end"
      >
        {globalOn && total > 0 && (
          <span
            key={total}
            className="privacy-count privacy-motion ml-0.5 rounded-full bg-highlight-soft px-1.5 py-px font-mono text-[10px] leading-4 text-highlight"
            aria-label={`${total} privacy actions on this page`}
          >
            {total}
          </span>
        )}
      </FeatureButton>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="DivePrivacy protection"
          aria-modal="true"
          className="privacy-card privacy-motion absolute right-0 z-50 mt-1 w-[360px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border border-line-2 bg-surface text-xs shadow-2xl"
        >
          <header className="flex items-center gap-3.5 bg-surface-2/70 px-4 py-4">
            <div className="relative grid size-14 shrink-0 place-items-center">
              <span
                data-testid="privacy-halo"
                aria-hidden="true"
                className={`absolute inset-1 rounded-full border border-highlight/70 bg-highlight/20 ${siteOn ? "privacy-halo privacy-motion" : ""}`}
              />
              <img src={privacyGuardian()} alt="Dive Privacy guardian" className="relative size-12 rounded-full bg-surface-3" />
              <span aria-hidden="true" className={`absolute right-0.5 bottom-0.5 size-3 rounded-full border-2 border-surface-2 ${siteOn ? "bg-highlight" : "bg-ink-3"}`} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{headline}</h3>
              <p className={`privacy-count privacy-motion mt-0.5 text-[11px] ${total > 0 ? "text-highlight" : "text-ink-3"}`} aria-live="polite">
                {summary}
              </p>
              {host && <p className="mt-1 truncate font-mono text-[10px] text-ink-3">{host}</p>}
            </div>
          </header>

          <section aria-label="Protection layers" className="px-3 py-2">
            <Layer icon={Megaphone} label="Ads blocked" value={String(counts.ads)} countKey={counts.ads} />
            <Layer icon={Radar} label="Trackers stopped" value={String(counts.trackers)} countKey={counts.trackers} />
            <Layer
              icon={Play}
              label="YouTube protection"
              value={!youtubeSite ? "" : youtubeActive ? "Active" : "Inactive"}
              note={youtubeSite ? undefined : "Applies on youtube.com"}
              control={
                // The preference keeps its value on every site; the switch only
                // turns muted where it cannot change what the page sees.
                <span aria-disabled={!youtubeSite || undefined} title={youtubeSite ? undefined : "Applies on youtube.com"}>
                  <Switch
                    label="YouTube protection"
                    checked={prefs.youtube_protection}
                    disabled={!youtubeSite}
                    onChange={(youtube_protection) => void update({ youtube_protection })}
                  />
                </span>
              }
            />
          </section>

          <section className="border-t border-line px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">Protection on this site</p>
                <p className="mt-0.5 text-[10.5px] text-ink-3">
                  {!host ? "Site controls unavailable" : paused ? `Resume on ${host}` : `Pause only on ${host}`}
                </p>
              </div>
              <span ref={siteControl} className="shrink-0">
                <Switch label="Protection on this site" checked={siteOn} disabled={!globalOn || !host || siteSaving} onChange={(enabled) => void changeSite(enabled)} />
              </span>
            </div>

            {!globalOn && (
              <div className="privacy-layer privacy-motion mt-3 flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">DivePrivacy protection</p>
                  <p className="mt-0.5 text-[10.5px] text-ink-3">Enable curated protection across workspaces.</p>
                </div>
                <Switch label="DivePrivacy protection" checked={false} onChange={(block_trackers) => void update({ block_trackers })} />
              </div>
            )}
          </section>

          <footer className="flex items-center gap-2 border-t border-line bg-surface-2/45 px-3 py-2">
            <span className="font-mono text-[9.5px] text-ink-3">{infoError ? "Rules unavailable" : `Rules ${info?.version ?? "bundled"}`}</span>
            <span className="min-w-0 flex-1 text-[9.5px] leading-tight text-ink-3">Across workspaces; site pauses stay host-specific.</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings("privacy");
              }}
              className="privacy-motion flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[10.5px] text-ink-2 hover:bg-surface-3 hover:text-ink"
            >
              <Icon icon={SlidersHorizontal} size={12} /> All privacy settings
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function Layer({
  icon,
  label,
  value,
  note,
  countKey,
  control,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  /** A line under the label, for a layer that does not apply here. */
  note?: string | undefined;
  countKey?: number;
  control?: ReactNode;
}) {
  return (
    <div className="privacy-layer privacy-motion flex min-h-10 items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-surface-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
        <Icon icon={icon} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ink-2">{label}</span>
        {note && <span className="block text-[10.5px] text-ink-3">{note}</span>}
      </span>
      <span key={countKey} className={`privacy-motion text-[11px] ${countKey === undefined ? "text-ink-3" : "privacy-count font-mono tabular-nums text-ink"}`}>
        {value}
      </span>
      {control}
    </div>
  );
}

/** Only ordinary web pages have an exact host that the backend can except. */
function pageHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}
