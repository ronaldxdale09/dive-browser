import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play } from "lucide-react";
import { Icon } from "../components/Icon";
import { recordingClock } from "../lib/recordingFormat";
import { RATIO_VALUE, contentBox, outputTime, sourceTime } from "./math";
import { previewNeedsFrame } from "./previewLoop";
import { leasePreviewMedia } from "./previewMedia";
import { Renderer } from "./render";
import { useEditor } from "./store";
import type { Project } from "./model";

/**
 * The preview: a canvas the renderer paints, kept in step with a hidden
 * video element that plays the recording. Playback runs in output time so
 * trims are skipped and speed regions play at their speed. The selected
 * zoom's focus and any selected annotation can be dragged here.
 */
export function Stage() {
  const project = useEditor((s) => s.project);
  const playable = useEditor((s) => s.playable);
  const playing = useEditor((s) => s.playing);
  const segments = useEditor((s) => s.segments);
  const duration = useEditor((s) => s.duration);
  const cursorRaw = useEditor((s) => s.cursorRaw);
  const cursorSmooth = useEditor((s) => s.cursorSmooth);
  const selection = useEditor((s) => s.selection);
  const setPlaying = useEditor((s) => s.setPlaying);
  const seek = useEditor((s) => s.seek);
  const update = useEditor((s) => s.update);
  const checkpoint = useEditor((s) => s.checkpoint);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const currentTimeLabel = useRef<HTMLSpanElement>(null);
  const positionControl = useRef<HTMLInputElement>(null);
  const renderer = useRef(new Renderer());
  const [size, setSize] = useState({ w: 960, h: 540 });
  const [fill, setFill] = useState(false);
  const ratio = project ? (RATIO_VALUE[project.editor.aspectRatio] ?? project.media.width / Math.max(1, project.media.height)) : 16 / 9;

  // Fit the canvas to the stage at the project's ratio.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const pad = fill ? 0 : 20;
      let w = r.width - pad * 2;
      let h = w / ratio;
      if (h > r.height - pad * 2) {
        h = r.height - pad * 2;
        w = h * ratio;
      }
      const next = { w: Math.max(160, Math.floor(w)), h: Math.max(90, Math.floor(h)) };
      setSize((current) => (current.w === next.w && current.h === next.h ? current : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio, fill]);

  // Draw loop: while playing, advance in output time with the clock, seek
  // the video to the matching source time; otherwise draw the playhead.
  // The project is read from the store inside each tick, so edits (a
  // dragged focus, a new padding) redraw without tearing the loop down.
  const hasProject = project !== null;
  useEffect(() => {
    const cv = canvas.current;
    const v = video.current;
    const opened = useEditor.getState().project;
    if (!cv || !v || !hasProject || !opened) return;
    const ctx = cv.getContext("2d", { willReadFrequently: opened.editor.annotations.some((a) => a.type === "blur") });
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let outMs = outputTime(segments, useEditor.getState().playhead);
    const scale = window.devicePixelRatio || 1;
    const W = Math.round(size.w * scale);
    const H = Math.round(size.h * scale);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const drawAt = (current: Project, srcMs: number, isPlaying: boolean) => {
      renderer.current.draw(ctx, current, v.readyState >= 2 ? v : null, srcMs, cursorSmooth, cursorRaw, { width: W, height: H, playing: isPlaying });
    };
    const paintControls = (positionMs: number) => {
      if (currentTimeLabel.current) currentTimeLabel.current.textContent = recordingClock(positionMs / 1000);
      if (positionControl.current) positionControl.current.value = String(Math.min(duration, positionMs));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      raf = 0;
      const state = useEditor.getState();
      const current = state.project;
      if (state.exporting || !current) {
        last = now;
        return;
      }
      if (state.playing) {
        outMs += now - last;
        if (outMs >= duration) {
          outMs = duration;
          setPlaying(false);
        }
        const src = sourceTime(segments, outMs) ?? current.media.durationMs;
        const seg = segments.find((s) => outMs >= s.outStartMs && outMs < s.outEndMs);
        const rate = seg?.speed ?? 1;
        if (v.paused) void v.play().catch(() => undefined);
        if (v.playbackRate !== rate) v.playbackRate = Math.min(16, Math.max(0.0625, rate));
        if (Math.abs(v.currentTime * 1000 - src) > 120) v.currentTime = src / 1000;
        useEditor.setState({ playhead: src });
        paintControls(outMs);
        drawAt(current, src, true);
      } else {
        if (!v.paused) v.pause();
        const src = state.playhead;
        outMs = outputTime(segments, src);
        if (Math.abs(v.currentTime * 1000 - src) > 8) v.currentTime = src / 1000;
        paintControls(outMs);
        drawAt(current, src, false);
      }
      last = now;
      if (previewNeedsFrame(state.playing, v.readyState, v.seeking)) schedule();
    };
    const unsubscribe = useEditor.subscribe((state, previous) => {
      if (state.exporting !== previous.exporting && !state.exporting) {
        renderer.current.snap();
        schedule();
      } else if (state.playing !== previous.playing) {
        outMs = outputTime(segments, state.playhead);
        last = performance.now();
        schedule();
      } else if (state.playhead !== previous.playhead && !state.playing) {
        renderer.current.snap();
        schedule();
      } else if (state.project !== previous.project) {
        schedule();
      }
    });
    v.addEventListener("loadeddata", schedule);
    v.addEventListener("seeked", schedule);
    schedule();
    return () => {
      unsubscribe();
      v.removeEventListener("loadeddata", schedule);
      v.removeEventListener("seeked", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasProject, segments, duration, cursorRaw, cursorSmooth, size, setPlaying]);

  // The stage owns one media resource and lends only that live element to
  // export. Cleanup must not clear a replacement stage's borrowed pointer.
  const setVideoEl = useEditor((s) => s.setVideoEl);
  useEffect(() => {
    const v = video.current;
    if (!v || !playable) return;
    const generation = useEditor.getState().generation;
    const isCurrent = () => {
      const state = useEditor.getState();
      return state.generation === generation && state.videoEl === v;
    };
    setVideoEl(v);
    const release = leasePreviewMedia(v, playable, {
      isCurrent,
      generation,
      onError: () => {
        console.error("[divescreen] preview media failed", {
          code: v.error?.code ?? null,
          readyState: v.readyState,
          networkState: v.networkState,
        });
        useEditor.setState({ playing: false, error: "Dive could not load this recording preview. The original file is still safe." });
      },
    });
    return () => {
      release();
      if (isCurrent()) setVideoEl(null);
    };
  }, [playable, setVideoEl]);

  if (!project) return null;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sel = selection;
    if (!sel || (sel.kind !== "zoom" && sel.kind !== "annotation")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    checkpoint();
    const move = (ev: PointerEvent) => {
      const nx = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const ny = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      if (sel.kind === "zoom") {
        const f = stageToFrame(project, nx, ny, rect.width, rect.height);
        update((ed) => ({ ...ed, zooms: ed.zooms.map((z) => (z.id === sel.id ? { ...z, focus: f, focusMode: "manual", source: "manual" } : z)) }), false);
      } else {
        update((ed) => ({ ...ed, annotations: ed.annotations.map((a) => (a.id === sel.id ? { ...a, position: { x: nx * 100, y: ny * 100 } } : a)) }), false);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e.nativeEvent);
  };

  const selZoom = selection?.kind === "zoom" ? project.editor.zooms.find((z) => z.id === selection.id) : undefined;
  const focusDot = selZoom ? frameToStage(project, selZoom.focus.cx, selZoom.focus.cy, size.w, size.h) : null;
  const outNow = outputTime(segments, useEditor.getState().playhead);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-line bg-surface">
      <div ref={wrap} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-t-2xl">
        <div className="relative" style={{ width: size.w, height: size.h }}>
          <canvas ref={canvas} onPointerDown={onPointerDown} className={`h-full w-full rounded-xl ${selection?.kind === "zoom" || selection?.kind === "annotation" ? "cursor-crosshair" : ""}`} style={{ width: size.w, height: size.h }} aria-label="Preview" />
          {focusDot && !(project.editor.autoFocusAll || selZoom?.focusMode === "auto") && (
            <span aria-hidden className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-highlight bg-highlight/30 shadow" style={{ left: focusDot.x, top: focusDot.y }} />
          )}
          <video
            ref={video}
            muted
            playsInline
            preload="auto"
            className="pointer-events-none absolute -left-[9999px] size-px opacity-0"
          />
        </div>
      </div>
      {/* Playback bar, the way a player has one: play, time, scrubber, length. */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-5">
        <button type="button" aria-label={playing ? "Pause" : "Play"} title="Space" onClick={() => setPlaying(!playing)} className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-ground transition hover:brightness-90">
          <Icon icon={playing ? Pause : Play} size={15} className="fill-current" />
        </button>
        <span ref={currentTimeLabel} className="w-10 font-mono text-[11px] tabular-nums text-ink-2">{recordingClock(outNow / 1000)}</span>
        <input ref={positionControl} type="range" aria-label="Position" min={0} max={Math.max(1, duration)} step={1} defaultValue={Math.min(duration, outNow)} onChange={(e) => seek(sourceTime(segments, Number(e.target.value)) ?? 0)} className="h-1 flex-1 accent-ink" />
        <span className="w-10 text-right font-mono text-[11px] tabular-nums text-ink-3">{recordingClock(duration / 1000)}</span>
        <button type="button" aria-label={fill ? "Fit preview" : "Fill preview"} onClick={() => setFill(!fill)} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink">
          <Icon icon={fill ? Minimize2 : Maximize2} size={14} />
        </button>
      </div>
    </div>
  );
}

/** Stage-normalised point to frame-normalised, through padding and crop. */
function stageToFrame(project: Project, nx: number, ny: number, w: number, h: number): { cx: number; cy: number } {
  const e = project.editor;
  const box = contentBox(w, h, e.padding, project.media.width * e.crop.width, project.media.height * e.crop.height);
  const px = Math.min(1, Math.max(0, (nx * w - box.x) / box.w));
  const py = Math.min(1, Math.max(0, (ny * h - box.y) / box.h));
  return { cx: px, cy: py };
}

function frameToStage(project: Project, cx: number, cy: number, w: number, h: number): { x: number; y: number } {
  const e = project.editor;
  const box = contentBox(w, h, e.padding, project.media.width * e.crop.width, project.media.height * e.crop.height);
  return { x: box.x + cx * box.w, y: box.y + cy * box.h };
}
