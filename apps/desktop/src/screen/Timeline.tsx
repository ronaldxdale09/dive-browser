import { ChevronDown, Crosshair, EyeOff, Gauge, MessageSquare, MousePointer2, Scissors, Wand2, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "../components/Icon";
import { Tooltip } from "../components/Tooltip";
import { recordingClock } from "../lib/recordingFormat";
import { zoomScale } from "./math";
import { ASPECT_RATIOS } from "./model";
import type { Selection } from "./store";
import { placeRegion, useEditor } from "./store";

/**
 * The timeline: a toolbar to add things, a fine ruler in source time, and
 * one lane each for zooms, cuts, notes and speed. Items are pills you drag
 * to move and drag by their edges to resize, snapping to neighbours and
 * the playhead. Dragging across empty lane draws a new item there.
 * Ctrl+scroll zooms the view, plain scroll pans.
 */
type Kind = Exclude<Selection, null>["kind"];

const LANES: { kind: Kind; icon: LucideIcon; pill: string; ring: string; text: string }[] = [
  { kind: "zoom", icon: ZoomIn, pill: "bg-emerald-500/25 border-emerald-500/70", ring: "ring-emerald-400", text: "text-emerald-100" },
  { kind: "trim", icon: Scissors, pill: "bg-red-500/25 border-red-500/70", ring: "ring-red-400", text: "text-red-100" },
  { kind: "annotation", icon: MessageSquare, pill: "bg-yellow-500/25 border-yellow-500/70", ring: "ring-yellow-300", text: "text-yellow-50" },
  { kind: "speed", icon: Gauge, pill: "bg-orange-500/25 border-orange-500/70", ring: "ring-orange-400", text: "text-orange-50" },
];

const LANE_H = 40;
const PAD = 14;

export function Timeline() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const seek = useEditor((s) => s.seek);
  const update = useEditor((s) => s.update);
  const checkpoint = useEditor((s) => s.checkpoint);
  const addZoom = useEditor((s) => s.addZoom);
  const addTrim = useEditor((s) => s.addTrim);
  const addSpeed = useEditor((s) => s.addSpeed);
  const addAnnotation = useEditor((s) => s.addAnnotation);
  const autoZoom = useEditor((s) => s.autoZoom);
  const hasPointer = useEditor((s) => s.cursorRaw.length > 0);
  const root = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ start: 0, span: 0 });
  const [width, setWidth] = useState(800);
  const [draft, setDraft] = useState<{ kind: Kind; startMs: number; endMs: number } | null>(null);
  const total = project?.media.durationMs ?? 0;
  const span = view.span || total;
  const start = view.start;
  const inner = width - PAD * 2;
  const pxPerMs = inner / Math.max(1, span);
  const toX = (ms: number) => PAD + (ms - start) * pxPerMs;
  const toMs = (x: number) => start + (x - PAD) / pxPerMs;

  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The playback loop moves this one compositor layer directly. Subscribing
  // the component to playhead would rebuild the ruler and every lane at 60 Hz.
  useEffect(() => {
    const paint = (sourceMs: number) => {
      const x = PAD + (sourceMs - start) * ((width - PAD * 2) / Math.max(1, span));
      if (playheadRef.current) playheadRef.current.style.transform = `translate3d(${x - 1}px, 0, 0)`;
    };
    paint(useEditor.getState().playhead);
    return useEditor.subscribe((state, previous) => {
      if (state.playhead !== previous.playhead) paint(state.playhead);
    });
  }, [start, span, width]);

  if (!project) return null;
  const e = project.editor;

  const onWheel = (ev: React.WheelEvent) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const at = toMs(ev.clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0));
      const factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(total, Math.max(300, span * factor));
      const s = Math.min(Math.max(0, at - (at - start) * (next / span)), Math.max(0, total - next));
      setView({ start: s, span: next });
    } else if (span < total) {
      ev.preventDefault();
      const s = Math.min(Math.max(0, start + (ev.deltaY + ev.deltaX) / pxPerMs), Math.max(0, total - span));
      setView({ start: s, span });
    }
  };

  const atClient = (x: number) => Math.max(0, Math.min(total, toMs(x - (lanesRef.current?.getBoundingClientRect().left ?? 0))));

  const scrub = (ev: React.PointerEvent) => {
    seek(atClient(ev.clientX));
    const move = (m: PointerEvent) => seek(atClient(m.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** On an empty lane: a click scrubs, a drag draws a new item of that lane's kind. */
  const laneDown = (kind: Kind) => (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    const x0 = ev.clientX;
    const t0 = atClient(x0);
    let drawing = false;
    seek(t0);
    select(null);
    const move = (m: PointerEvent) => {
      const t = atClient(m.clientX);
      if (!drawing && Math.abs(m.clientX - x0) > 6) drawing = true;
      if (drawing) setDraft({ kind, startMs: Math.min(t0, t), endMs: Math.max(t0, t) });
      else seek(t);
    };
    const up = (m: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (!drawing) return;
      const t = atClient(m.clientX);
      const s = Math.min(t0, t);
      const en = Math.max(t0, t);
      if (en - s < 150) return;
      const list = kind === "zoom" ? e.zooms : kind === "trim" ? e.trims : kind === "speed" ? e.speeds : [];
      if (kind !== "annotation" && list.some((o) => s < o.endMs && en > o.startMs)) return;
      useEditor.setState({ playhead: s });
      if (kind === "zoom") addZoom(s);
      else if (kind === "trim") addTrim(s);
      else if (kind === "speed") addSpeed(s);
      else addAnnotation("text", s);
      // The store placed it with a default length; stretch it to the drawn one.
      const sel = useEditor.getState().selection;
      if (sel) {
        update((ed) => {
          const fix = <T extends { id: string; startMs: number; endMs: number }>(arr: T[]) => arr.map((i) => (i.id === sel.id ? { ...i, startMs: s, endMs: en } : i));
          return { ...ed, zooms: fix(ed.zooms), trims: fix(ed.trims), speeds: fix(ed.speeds), annotations: fix(ed.annotations) };
        }, false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const snapPoints = (kind: string, id: string): number[] => {
    const pts = [useEditor.getState().playhead, 0, total];
    const all = [...e.zooms.map((z) => ({ kind: "zoom", ...z })), ...e.trims.map((t) => ({ kind: "trim", ...t })), ...e.speeds.map((s) => ({ kind: "speed", ...s })), ...e.annotations.map((a) => ({ kind: "annotation", ...a }))];
    for (const it of all) if (!(it.kind === kind && it.id === id)) pts.push(it.startMs, it.endMs);
    return pts;
  };
  const snap = (ms: number, pts: number[]) => {
    const threshold = Math.max(50, span * 0.01);
    let best = ms;
    let dist = threshold;
    for (const p of pts) {
      const d = Math.abs(p - ms);
      if (d < dist) {
        dist = d;
        best = p;
      }
    }
    return best;
  };

  const dragItem = (kind: Kind, id: string, mode: "move" | "start" | "end") => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    select({ kind, id });
    const list = kind === "zoom" ? e.zooms : kind === "trim" ? e.trims : kind === "speed" ? e.speeds : e.annotations;
    const item = list.find((i) => i.id === id);
    if (!item) return;
    const others = list.filter((i) => i.id !== id);
    const exclusive = kind !== "annotation";
    const origin = { startMs: item.startMs, endMs: item.endMs };
    const x0 = ev.clientX;
    const pts = snapPoints(kind, id);
    checkpoint();
    const move = (m: PointerEvent) => {
      const d = (m.clientX - x0) / pxPerMs;
      let s = origin.startMs;
      let en = origin.endMs;
      if (mode === "move") {
        s = snap(origin.startMs + d, pts);
        en = s + (origin.endMs - origin.startMs);
        if (en > total) {
          en = total;
          s = en - (origin.endMs - origin.startMs);
        }
        if (s < 0) {
          s = 0;
          en = origin.endMs - origin.startMs;
        }
      } else if (mode === "start") s = Math.min(snap(origin.startMs + d, pts), origin.endMs - 100);
      else en = Math.max(snap(origin.endMs + d, pts), origin.startMs + 100);
      s = Math.max(0, s);
      en = Math.min(total, en);
      if (exclusive && others.some((o) => s < o.endMs && en > o.startMs)) return;
      update((ed) => {
        const patch = <T extends { id: string; startMs: number; endMs: number }>(arr: T[]) => arr.map((i) => (i.id === id ? { ...i, startMs: s, endMs: en } : i));
        switch (kind) {
          case "zoom":
            return { ...ed, zooms: patch(ed.zooms).map((z) => (z.id === id ? { ...z, source: "manual" as const } : z)) };
          case "trim":
            return { ...ed, trims: patch(ed.trims) };
          case "speed":
            return { ...ed, speeds: patch(ed.speeds) };
          default:
            return { ...ed, annotations: patch(ed.annotations) };
        }
      }, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const { major, minor } = tickMarks(start, span, inner);
  const items = (kind: Kind): { id: string; startMs: number; endMs: number; label: string; follow?: boolean }[] =>
    kind === "zoom"
      ? e.zooms.map((z) => ({ id: z.id, startMs: z.startMs, endMs: z.endMs, label: `${zoomScale(z).toFixed(2)}×`, follow: project.editor.autoFocusAll || z.focusMode === "auto" }))
      : kind === "trim"
        ? e.trims.map((t) => ({ id: t.id, startMs: t.startMs, endMs: t.endMs, label: "Trim" }))
        : kind === "speed"
          ? e.speeds.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, label: `${s.speed}×` }))
          : e.annotations.map((a) => ({ id: a.id, startMs: a.startMs, endMs: a.endMs, label: a.type === "text" ? (a.text ?? "Text") : a.type === "blur" ? "Blur" : a.type === "arrow" ? "Arrow" : "Picture" }));

  return (
    <div ref={root} className="flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface select-none" onWheel={onWheel}>
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
        <Tool icon={ZoomIn} label="Add zoom at the playhead" shortcut="Z" onClick={() => addZoom()} />
        <Tool icon={Wand2} label="Suggest zooms where the pointer lingered" disabled={!hasPointer} onClick={autoZoom} />
        <Tool icon={Crosshair} label={e.autoFocusAll ? "Zooms follow the pointer: on" : "Zooms follow the pointer: off"} active={e.autoFocusAll} disabled={!hasPointer} onClick={() => update((ed) => ({ ...ed, autoFocusAll: !ed.autoFocusAll }))} />
        <Tool icon={Scissors} label="Add a cut" shortcut="T" onClick={() => addTrim()} />
        <Tool icon={MessageSquare} label="Add text" shortcut="A" onClick={() => addAnnotation("text")} />
        <Tool icon={Gauge} label="Change speed" shortcut="S" onClick={() => addSpeed()} />
        <Tool icon={EyeOff} label="Blur an area" shortcut="B" onClick={() => addAnnotation("blur")} />
        <span className="mx-2 h-5 w-px bg-line-2" />
        <label className="relative flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
          <select aria-label="Aspect ratio" value={e.aspectRatio} onChange={(ev) => update((ed) => ({ ...ed, aspectRatio: ev.target.value as typeof ed.aspectRatio }))} className="appearance-none bg-transparent pr-4 outline-none">
            {ASPECT_RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} size={12} className="pointer-events-none absolute right-1.5 text-ink-3" />
        </label>
        <span className="flex-1" />
        <span className="hidden items-center gap-2 text-[10.5px] text-ink-3 md:flex">
          <kbd className="rounded border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono">Scroll</kbd> Pan
          <kbd className="ml-2 rounded border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono">⌘ + Scroll</kbd> Zoom
          <span className="ml-2">Drag on a lane to draw</span>
        </span>
      </div>

      <div ref={lanesRef} className="relative min-h-0 flex-1">
        {/* Ruler */}
        <div className="relative h-8 cursor-ew-resize" onPointerDown={scrub}>
          {minor.map((t) => (
            <span key={`m${t}`} aria-hidden className="absolute bottom-0 h-1.5 border-l border-line-2" style={{ left: toX(t) }} />
          ))}
          {major.map((t) => (
            <span key={t} className="absolute top-1 -translate-x-1/2 font-mono text-[10px] text-ink-3" style={{ left: toX(t) }}>
              {stamp(t)}
            </span>
          ))}
          {major.map((t) => (
            <span key={`l${t}`} aria-hidden className="absolute bottom-0 h-2.5 border-l border-line-2" style={{ left: toX(t) }} />
          ))}
        </div>
        {/* Lanes */}
        {LANES.map((lane) => (
          <div key={lane.kind} className="relative border-t border-line/60" style={{ height: LANE_H }} onPointerDown={laneDown(lane.kind)}>
            {items(lane.kind).map((it) => {
              const picked = selection?.kind === lane.kind && selection.id === it.id;
              const x = toX(it.startMs);
              const w = Math.max(8, (it.endMs - it.startMs) * pxPerMs);
              if (x + w < PAD || x > width - PAD) return null;
              return (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${lane.kind} ${it.label}`}
                  onPointerDown={dragItem(lane.kind, it.id, "move")}
                  className={`absolute top-1.5 flex h-7 cursor-grab items-center justify-center gap-1.5 overflow-hidden rounded-lg border px-3 text-[11px] whitespace-nowrap ${lane.pill} ${lane.text} ${picked ? `ring-2 ${lane.ring}` : ""}`}
                  style={{ left: Math.max(PAD, x), width: Math.min(w, width - PAD - Math.max(PAD, x)) }}
                >
                  <span aria-hidden onPointerDown={dragItem(lane.kind, it.id, "start")} className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize" />
                  <Icon icon={lane.icon} size={12} />
                  <span className="truncate">{it.label}</span>
                  {it.follow && <Icon icon={MousePointer2} size={11} />}
                  {lane.kind === "zoom" && e.zooms.find((z) => z.id === it.id)?.source === "auto" && <Icon icon={Wand2} size={10} className="opacity-70" />}
                  <span aria-hidden onPointerDown={dragItem(lane.kind, it.id, "end")} className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize" />
                </div>
              );
            })}
            {draft?.kind === lane.kind && (
              <div aria-hidden className={`absolute top-1.5 h-7 rounded-lg border border-dashed ${lane.pill} opacity-80`} style={{ left: toX(draft.startMs), width: Math.max(4, (draft.endMs - draft.startMs) * pxPerMs) }} />
            )}
          </div>
        ))}
        {/* Playhead */}
        <div ref={playheadRef} aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-0.5 bg-violet-500 will-change-transform" style={{ transform: `translate3d(${toX(useEditor.getState().playhead) - 1}px, 0, 0)` }}>
          <span className="absolute -top-0.5 -left-[7px] size-4 rounded-sm bg-violet-500" style={{ clipPath: "polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)" }} />
        </div>
      </div>
    </div>
  );
}

function Tool({ icon, label, shortcut, disabled, active, onClick }: { icon: LucideIcon; label: string; shortcut?: string; disabled?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button type="button" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`grid size-8 place-items-center rounded-lg transition-colors disabled:opacity-35 disabled:hover:bg-transparent ${active ? "bg-emerald-500/20 text-emerald-300" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
        <Icon icon={icon} size={15} />
      </button>
    </Tooltip>
  );
}

/** m:ss, with tenths when the view is tight. */
function stamp(ms: number) {
  const base = recordingClock(Math.floor(ms / 1000));
  const tenth = Math.round((ms % 1000) / 100);
  return tenth ? `${base}.${tenth}` : `${base}.0`;
}

function tickMarks(start: number, span: number, px: number): { major: number[]; minor: number[] } {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];
  const wanted = span / Math.max(1, px / 110);
  const step = steps.find((s) => s >= wanted) ?? 600_000;
  const major: number[] = [];
  const minor: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= start + span; t += step) major.push(t);
  const sub = step / 5;
  for (let t = Math.ceil(start / sub) * sub; t <= start + span; t += sub) if (Math.abs(t / step - Math.round(t / step)) > 1e-6) minor.push(t);
  return { major, minor };
}

export { placeRegion };
