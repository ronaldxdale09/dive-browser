import { Check, Copy, Pipette, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { ipc } from "../lib/ipc";
import type { ColorFormats, Palette, PaletteEntry } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { copyText } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { InternalPageNote, isInternalPage } from "./InternalPageNote";

/**
 * A contrast ratio as a number. The bindings type these as `number | null`
 * because JSON cannot carry NaN, so a missing value is treated as the worst
 * case rather than rendered as "null".
 */
function ratioOf(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

/** WCAG's thresholds for normal-size text. */
function grade(ratio: number): { label: string; tone: string } {
  if (ratio >= 7) return { label: "AAA", tone: "text-highlight" };
  if (ratio >= 4.5) return { label: "AA", tone: "text-highlight" };
  if (ratio >= 3) return { label: "AA large", tone: "text-warn" };
  return { label: "fails", tone: "text-danger" };
}

/**
 * The page's colours: an eyedropper over any pixel, and the palette the page
 * actually paints, ranked by use.
 *
 * The eyedropper is Chromium's own, so it reads a pixel inside a canvas, a
 * video frame or a gradient — the places a DOM-reading extension is blind to.
 * Every colour carries its contrast against white and black, because the next
 * question after "what colour is that" is almost always "can I put text on it".
 */
export function ColorPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url ?? "");
  // Keyed by the URL it was read from, so navigating away drops the palette
  // without an effect that clears state on every render pass.
  const [palettes, setPalettes] = useState<Record<string, Palette>>({});
  const [picked, setPicked] = useState<ColorFormats | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!activeTab) return;
    setBusy(true);
    setError(null);
    try {
      const found = await ipc.tabPalette(activeTab);
      setPalettes((p) => ({ ...p, [url]: found }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [activeTab, url]);

  const pick = useCallback(async () => {
    if (!activeTab) return;
    setError(null);
    try {
      const colour = await ipc.tabEyedropper(activeTab);
      // A dismissed eyedropper is an outcome, not a failure: say nothing.
      if (!colour) return;
      setPicked(colour);
      setRecent((r) => [colour.hex, ...r.filter((h) => h !== colour.hex)].slice(0, 12));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [activeTab]);

  const palette = palettes[url] ?? null;

  if (isInternalPage(url)) return <InternalPageNote what="Colours" />;

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => void pick()}
          disabled={!activeTab}
          className="flex h-7 items-center gap-1.5 rounded-lg bg-highlight px-2.5 text-[11px] font-medium text-ground hover:opacity-90 disabled:opacity-50"
        >
          <Icon icon={Pipette} size={12} />
          Pick a colour
        </button>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy || !activeTab}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[11px] text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          <Icon icon={RefreshCw} size={12} className={busy ? "animate-spin" : undefined} />
          {palette ? "Scan again" : "Page palette"}
        </button>
        {palette && <span className="text-[11px] text-ink-3">{palette.colors.length} colours · {palette.scanned} elements</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p role="alert" className="mb-2 text-danger">{error}</p>}
        {picked && <Picked colour={picked} />}

        {recent.length > 1 && (
          <section className="mt-3">
            <h3 className="mb-1 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">Recent</h3>
            <div className="flex flex-wrap gap-1">
              {recent.map((hex) => (
                <Tooltip key={hex} label={hex} side="top">
                  <button
                    type="button"
                    aria-label={hex}
                    onClick={() => void copyText(hex)}
                    className="size-6 rounded-md ring-1 ring-line-2"
                    style={{ background: hex }}
                  />
                </Tooltip>
              ))}
            </div>
          </section>
        )}

        {!palette && !picked && !error && (
          <p className="px-1 py-6 text-center text-ink-3">
            Pick a colour from anywhere on the page, or read the palette it uses.
          </p>
        )}

        {palette && (
          <section className="mt-3">
            <h3 className="mb-1 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">
              Palette{palette.theme_color ? ` · theme ${palette.theme_color}` : ""}
            </h3>
            <p className="mb-1.5 text-[11px] text-ink-3">Most used first. Click to copy.</p>
            <div className="flex flex-col gap-0.5">
              {palette.colors.map((c) => <Swatch key={`${c.hex}-${c.alpha}-${c.role}`} entry={c} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Picked({ colour }: { colour: ColorFormats }) {
  const onWhite = ratioOf(colour.on_white);
  const onBlack = ratioOf(colour.on_black);
  const white = grade(onWhite);
  const black = grade(onBlack);
  return (
    <section aria-label="Picked colour" className="rounded-xl border border-line-2 bg-surface-2 p-2.5">
      <div className="flex items-center gap-3">
        <span className="size-12 shrink-0 rounded-lg ring-1 ring-line-2" style={{ background: colour.hex }} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <CopyRow value={colour.hex} />
          <CopyRow value={colour.rgb} />
          <CopyRow value={colour.hsl} />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 border-t border-line pt-2 text-[11px]">
        <span className="text-ink-3">Contrast</span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-white ring-1 ring-line-2" aria-hidden />
          <span className="font-mono text-ink-2">{onWhite.toFixed(2)}</span>
          <span className={white.tone}>{white.label}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-black ring-1 ring-line-2" aria-hidden />
          <span className="font-mono text-ink-2">{onBlack.toFixed(2)}</span>
          <span className={black.tone}>{black.label}</span>
        </span>
      </div>
    </section>
  );
}

function CopyRow({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      onClick={() => {
        void copyText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[11px] text-ink hover:bg-surface-3"
    >
      <span className="truncate">{value}</span>
      <Icon icon={done ? Check : Copy} size={10} className={done ? "text-highlight" : "text-ink-3 opacity-0 group-hover:opacity-100"} />
    </button>
  );
}

function Swatch({ entry }: { entry: PaletteEntry }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${entry.hex}`}
      onClick={() => {
        void copyText(entry.hex).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
    >
      <span className="size-5 shrink-0 rounded-md ring-1 ring-line-2" style={{ background: entry.hex, opacity: entry.alpha ?? 1 }} />
      <span className="font-mono text-[11px] text-ink">{entry.hex}</span>
      <span className="rounded bg-surface-2 px-1 text-[10px] text-ink-3">{entry.role}</span>
      <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-ink-3">
        {done ? "copied" : `${entry.count}×${entry.sample ? ` · ${entry.sample}` : ""}`}
      </span>
    </button>
  );
}
