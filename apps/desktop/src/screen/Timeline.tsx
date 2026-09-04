import { useEffect, useRef, useState } from "react";
import type { Selection } from "./store";
import { useEditor } from "./store";
import { recordingClock } from "../lib/recordingFormat";
import { zoomScale } from "./math";

/**
 * The timeline: rows for zooms, trims, speed and annotations over a ruler in
 * source time, with a playhead to scrub. Items drag to move and drag their
 * edges to resize, snapping to neighbours and the playhead. Ctrl+scroll
 * zooms the view, Shift+scroll pans.
 */
const ROWS: { kind: Exclude<Selection, null>["kind"]; label: string; color: string }[] = [
  { kind: "zoom", label: "Zoom", color: "bg-highlight/70 ring-highlight" },
  { kind: "trim", label: "Trim", color: "bg-danger/60 ring-danger" },
  { kind: "speed", label: "Speed", color: "bg-amber-400/60 ring-amber-400" },
  { kind: "annotation", label: "Notes", color: "bg-violet-400/60 ring-violet-400" },
];

const LEFT = 64;

export function Timeline() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const seek = useEditor((s) => s.seek);
  const update = useEditor((s) => s.update);
  const checkpoint = useEditor((s) => s.checkpoint);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ start: 0, span: 0 });
  const [width, setWidth] = useState(800);
  const total = project?.media.durationMs ?? 0;
  const span = view.span || total;
  const start = view.start;
  const pxPerMs = (width - LEFT) / Math.max(1, span);
  const toX = (ms: number) => LEFT + (ms - start) * pxPerMs;
  const toMs = (x: number) => start + (x - LEFT) / pxPerMs;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!project) return null;
  const e = project.editor;

  const onWheel = (ev: React.WheelEvent) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const at = toMs(ev.clientX - (root.current?.getBoundingClientRect().left ?? 0));
      const factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(total, Math.max(300, span * factor));
      const s = Math.min(Math.max(0, at - (at - start) * (next / span)), Math.max(0, total - next));
      setView({ start: s, span: next });
    } else if (ev.shiftKey) {
      ev.preventDefault();
      const s = Math.min(Math.max(0, start + (ev.deltaY + ev.deltaX) / pxPerMs), Math.max(0, total - span));
      setView({ start: s, span });
    }
  };

  const scrub = (ev: React.PointerEvent) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const at = (x: number) => Math.max(0, Math.min(total, toMs(x - rect.left)));
    seek(at(ev.clientX));
    const move = (m: PointerEvent) => seek(at(m.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Snap candidates: other items' edges and the playhead. */
  const snapPoints = (kind: string, id: string): number[] => {
    const pts = [playhead, 0, total];
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

  const dragItem = (kind: Exclude<Selection, null>["kind"], id: string, mode: "move" | "start" | "end") => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    select({ kind, id });
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
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

  const ticks = tickMarks(start, span, width - LEFT);

  return (
    <div ref={root} className="relative flex h-full min-w-0 select-none flex-col overflow-hidden bg-surface text-[10px]" onWheel={onWheel}>
      {/* Ruler */}
      <div className="relative h-6 shrink-0 border-b border-line" onPointerDown={scrub}>
        {ticks.map((t) => (
          <span key={t} className="absolute top-0 h-full border-l border-line-2 pl-1 font-mono text-ink-3" style={{ left: toX(t) }}>
            {recordingClock(t / 1000)}
          </span>
        ))}
      </div>
      <div className="relative flex-1">
        {ROWS.map((row) => {
          const items: { id: string; startMs: number; endMs: number; label: string }[] =
            row.kind === "zoom"
              ? e.zooms.map((z, i) => ({ id: z.id, startMs: z.startMs, endMs: z.endMs, label: `${z.source === "auto" ? "✦ " : ""}Zoom ${i + 1} · ${zoomScale(z).toFixed(1)}×${project.editor.autoFocusAll || z.focusMode === "auto" ? " · follow" : ""}` }))
              : row.kind === "trim"
                ? e.trims.map((t, i) => ({ id: t.id, startMs: t.startMs, endMs: t.endMs, label: `Cut ${i + 1}` }))
                : row.kind === "speed"
                  ? e.speeds.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, label: `${s.speed}×` }))
                  : e.annotations.map((a) => ({ id: a.id, startMs: a.startMs, endMs: a.endMs, label: a.type === "text" ? (a.text ?? "Text") : a.type }));
          return (
            <div key={row.kind} className="relative h-9 border-b border-line" onPointerDown={scrub}>
              <span className="absolute top-0 left-0 z-10 flex h-full w-16 items-center border-r border-line bg-surface px-2 font-medium tracking-wide text-ink-3 uppercase">{row.label}</span>
              {items.map((it) => {
                const picked = selection?.kind === row.kind && selection.id === it.id;
                const x = toX(it.startMs);
                const w = Math.max(6, (it.endMs - it.startMs) * pxPerMs);
                if (x + w < LEFT || x > width) return null;
                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={-1}
                    aria-label={it.label}
                    onPointerDown={dragItem(row.kind, it.id, "move")}
                    className={`absolute top-1.5 flex h-6 cursor-grab items-center overflow-hidden rounded-md px-2 text-ink whitespace-nowrap ${row.color.split(" ")[0]} ${picked ? `ring-2 ${row.color.split(" ")[1]}` : ""}`}
                    style={{ left: Math.max(LEFT, x), width: Math.min(w, width - Math.max(LEFT, x)) }}
                  >
                    <span aria-hidden onPointerDown={dragItem(row.kind, it.id, "start")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
                    <span className="truncate">{it.label}</span>
                    <span aria-hidden onPointerDown={dragItem(row.kind, it.id, "end")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
                  </div>
                );
              })}
            </div>
          );
        })}
        {/* Playhead */}
        <div aria-hidden className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-ink" style={{ left: toX(playhead) }}>
          <span className="absolute -top-0 -left-1.5 size-3 rotate-45 bg-ink" />
        </div>
      </div>
    </div>
  );
}

function tickMarks(start: number, span: number, px: number): number[] {
  const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];
  const wanted = span / Math.max(1, px / 90);
  const step = steps.find((s) => s >= wanted) ?? 600_000;
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= start + span; t += step) out.push(t);
  return out;
}
