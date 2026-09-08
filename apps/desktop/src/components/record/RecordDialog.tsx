import { AppWindow, Check, FileText, Loader2, Mic, MicOff, Timer, Video } from "lucide-react";
import { useRef } from "react";
import type { ReactNode } from "react";
import { useCoversContent } from "../../lib/overlay";
import { useFadeClose } from "../../lib/useFadeClose";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useBrowser } from "../../store/browser";
import { describeLimits, effectiveSettings, useRecording } from "../../store/recording";
import type { RecordSettings } from "../../store/recording";
import { Favicon } from "../Favicon";
import { Icon } from "../Icon";
import { orderTabs, tabLabel } from "../TabStrip";

/**
 * Everything decided before a recording starts, in one place: which tab,
 * what kind of file, how smooth, with a voice or not. Opens from the Record
 * button and from ⌘⇧R; Enter starts, Escape leaves.
 */
export function RecordDialog() {
  const phase = useRecording((s) => s.phase);
  const tab = useRecording((s) => s.tab);
  const settings = useRecording((s) => s.settings);
  const caps = useRecording((s) => s.caps);
  const error = useRecording((s) => s.error);
  const setTab = useRecording((s) => s.setTab);
  const setSettings = useRecording((s) => s.setSettings);
  const start = useRecording((s) => s.start);
  const closeSetup = useRecording((s) => s.closeSetup);
  const tabs = useBrowser((s) => s.tabs);
  const detached = useBrowser((s) => s.detached);
  const starting = phase === "starting";
  const open = phase === "setup" || starting;
  useCoversContent(open);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { active: open, initialFocus: primary });
  const { close, className } = useFadeClose(closeSetup);

  // The chosen tab may have closed while the dialog was open; the first
  // remaining one stands in until a choice is made.
  const choices = orderTabs(tabs).filter((t) => !detached.includes(t.id));
  const chosen = choices.some((t) => t.id === tab) ? tab : (choices[0]?.id ?? null);

  if (!open) return null;
  const live = effectiveSettings(settings, caps);
  const canVideo = caps?.ffmpeg ?? true;
  const mics = caps?.microphones ?? [];
  const noMic = !canVideo || live.format === "gif";

  return (
    <div ref={root} className={`fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] ${className}`} onMouseDown={close}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New recording"
        aria-busy={starting}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen) return;
          if (chosen !== tab) setTab(chosen);
          void start();
        }}
        className="mx-auto mt-16 flex w-[600px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/15 text-danger">
            <Icon icon={Video} size={17} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">New recording</h2>
            <p className="text-[11px] text-ink-3">Record what happens in a tab and get a file you can share.</p>
          </div>
        </header>

        {/* `minmax(0, 1fr)`: a long tab title must truncate, not widen the
            column until the settings fall off the dialog's edge. */}
        <div className="grid grid-cols-[minmax(0,1fr)_236px] gap-0">
          <section className="flex min-h-0 min-w-0 flex-col border-r border-line p-4">
            <Label>Tab to record</Label>
            <div role="radiogroup" aria-label="Tab to record" className="scroll-hidden mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {choices.map((t) => {
                const picked = t.id === chosen;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    onClick={() => setTab(t.id)}
                    className={`flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${picked ? "bg-surface-2 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
                  >
                    <Favicon src={t.favicon} size={14} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{tabLabel(t)}</span>
                      <span className="block truncate text-[10.5px] text-ink-3">{host(t.url)}</span>
                    </span>
                    {picked && <Icon icon={Check} size={13} className="shrink-0 text-highlight" />}
                  </button>
                );
              })}
            </div>
            {choices.length === 0 && <p className="mt-2 text-xs text-ink-3">Open a page first.</p>}
          </section>

          <section className="flex min-w-0 flex-col gap-4 p-4">
            <Field label="Capture">
              <Segmented
                value={live.source}
                onChange={(source) => setSettings({ source })}
                options={[
                  { value: "page", label: "Page", hint: "Just the web page, sharp and steady", icon: FileText },
                  { value: "window", label: "Window", hint: canVideo ? "Dive's whole window as on screen, with the pointer" : "Needs ffmpeg", disabled: !canVideo, icon: AppWindow },
                ]}
              />
            </Field>
            <Field label="Format">
              <Segmented
                value={live.format}
                onChange={(format) => setSettings({ format })}
                options={[
                  { value: "mp4", label: "Video", hint: canVideo ? "MP4, H.264" : "Needs ffmpeg", disabled: !canVideo },
                  { value: "gif", label: "GIF", hint: "Looping, up to 1 min" },
                ]}
              />
            </Field>
            <Field label="Frame rate">
              <Segmented
                value={live.fps}
                onChange={(fps) => setSettings({ fps })}
                options={[
                  { value: 15, label: "15 fps", hint: "Smaller file" },
                  { value: 30, label: "30 fps", hint: "Smoother" },
                ]}
              />
            </Field>
            <Field label="Size">
              <Segmented
                value={live.width}
                onChange={(width) => setSettings({ width })}
                options={[
                  { value: 1280, label: "720p", hint: "Up to 1280 wide" },
                  { value: 1920, label: "1080p", hint: "Up to 1920 wide" },
                ]}
              />
            </Field>
            <Field label="Microphone">
              <div className="relative">
                <Icon icon={live.microphone ? Mic : MicOff} size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
                <select
                  aria-label="Microphone"
                  value={live.microphone ?? ""}
                  disabled={noMic}
                  onChange={(e) => setSettings({ microphone: e.target.value || null })}
                  className="h-8 w-full appearance-none rounded-lg border border-line bg-surface-2 pr-2 pl-8 text-xs text-ink outline-none focus:border-highlight/60 disabled:opacity-50"
                >
                  <option value="">Off</option>
                  {mics.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-1 text-[10.5px] text-ink-3">
                {!canVideo ? "Install ffmpeg for video and voice." : live.format === "gif" ? "A GIF has no sound." : mics.length === 0 ? "No microphone found." : "Your voice, in sync with the page."}
              </p>
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={settings.countdown} onChange={(e) => setSettings({ countdown: e.target.checked })} className="accent-highlight" />
              <Icon icon={Timer} size={13} className="text-ink-3" />
              Count down from 3
            </label>
          </section>
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-5 py-3">
          <p className="min-w-0 flex-1 text-[11px] text-ink-3">{error ? <span className="text-danger">{error}</span> : describeLimits(live, caps)}</p>
          <button type="button" disabled={starting} onClick={close} className="h-8 rounded-lg px-3 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
            Cancel
          </button>
          <button ref={primary} type="submit" disabled={!chosen || starting} className="flex h-8 min-w-32 items-center justify-center gap-1.5 rounded-lg bg-danger px-3.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-60">
            {starting ? <Icon icon={Loader2} size={13} className="motion-safe:animate-spin" /> : <span className="size-2 rounded-full bg-white" aria-hidden />}
            {starting ? "Preparing…" : "Start recording"}
            {!starting && <kbd className="ml-1 font-mono text-[10px] opacity-70">⏎</kbd>}
          </button>
        </footer>
      </form>
    </div>
  );
}

function host(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">{children}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string; hint?: string; disabled?: boolean; icon?: typeof Check }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-xs leading-none transition-colors disabled:opacity-40 ${o.value === value ? "bg-surface text-ink shadow-sm ring-1 ring-line-2" : "text-ink-2 hover:text-ink"}`}
        >
          {o.icon && <Icon icon={o.icon} size={12} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type { RecordSettings };
