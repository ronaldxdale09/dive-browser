import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { IconButton } from "../components/Icon";
import { recordingClock } from "../lib/recordingFormat";
import { RATIO_VALUE, contentBox, outputTime, sourceTime } from "./math";
import { Renderer } from "./render";
import { useEditor } from "./store";
import { previewNeedsFrame } from "./previewLoop";
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
  const playhead = useEditor((s) => s.playhead);
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
  const renderer = useRef(new Renderer());
  const [size, setSize] = useState({ w: 960, h: 540 });
  const ratio = project ? (RATIO_VALUE[project.editor.aspectRatio] ?? project.media.width / Math.max(1, project.media.height)) : 16 / 9;
  // While playing, store updates move the playhead every frame and must not
  // restart this effect. While paused, a seek needs exactly one fresh draw.
  const idlePlayhead = playing ? null : playhead;

  // Fit the canvas to the stage at the project's ratio.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const pad = 24;
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
  }, [ratio]);

  // Draw loop: while playing, advance in output time with the clock, seek
  // the video to the matching source time; otherwise draw the playhead.
  useEffect(() => {
    const cv = canvas.current;
    const v = video.current;
    if (!cv || !v || !project) return;
    const ctx = cv.getContext("2d", { willReadFrequently: project.editor.annotations.some((a) => a.type === "blur") });
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
    const drawAt = (srcMs: number, isPlaying: boolean) => {
      renderer.current.draw(ctx, project, v.readyState >= 2 ? v : null, srcMs, cursorSmooth, cursorRaw, { width: W, height: H, playing: isPlaying });
    };
    const tick = (now: number) => {
      const state = useEditor.getState();
      if (state.playing) {
        outMs += now - last;
        if (outMs >= duration) {
          outMs = duration;
          setPlaying(false);
        }
        const src = sourceTime(segments, outMs) ?? project.media.durationMs;
        // Keep the video near the wanted source time; let it run between
        // seeks so decoding stays smooth.
        const seg = segments.find((s) => outMs >= s.outStartMs && outMs < s.outEndMs);
        const rate = seg?.speed ?? 1;
        if (v.paused) void v.play().catch(() => undefined);
        if (v.playbackRate !== rate) v.playbackRate = Math.min(16, Math.max(0.0625, rate));
        if (Math.abs(v.currentTime * 1000 - src) > 120) v.currentTime = src / 1000;
        useEditor.setState({ playhead: src });
        drawAt(src, true);
      } else {
        if (!v.paused) v.pause();
        const src = state.playhead;
        outMs = outputTime(segments, src);
        if (Math.abs(v.currentTime * 1000 - src) > 8) v.currentTime = src / 1000;
        drawAt(src, false);
      }
      last = now;
      const current = useEditor.getState();
      if (previewNeedsFrame(current.playing, v.readyState, v.seeking)) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [project, segments, duration, cursorRaw, cursorSmooth, size, setPlaying, playing, idlePlayhead]);

  // A seek from the timeline lands the camera rather than chasing.
  useEffect(() => {
    if (!playing) renderer.current.snap();
  }, [playhead, playing]);

  if (!project) return null;

  // Dragging on the stage: the selected zoom's focus, or a selected annotation.
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={wrap} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-ground">
        <div className="relative" style={{ width: size.w, height: size.h }}>
          <canvas ref={canvas} onPointerDown={onPointerDown} className={`h-full w-full rounded-lg shadow-2xl ${selection?.kind === "zoom" || selection?.kind === "annotation" ? "cursor-crosshair" : ""}`} style={{ width: size.w, height: size.h }} aria-label="Preview" />
          {focusDot && !(project.editor.autoFocusAll || selZoom?.focusMode === "auto") && (
            <span aria-hidden className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-highlight bg-highlight/30 shadow" style={{ left: focusDot.x, top: focusDot.y }} />
          )}
          <video ref={video} src={playable ?? undefined} muted playsInline preload="auto" className="pointer-events-none absolute -left-[9999px] size-px opacity-0" />
        </div>
      </div>
      <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line px-3">
        <IconButton icon={SkipBack} label="Back a second" onClick={() => seek(Math.max(0, playhead - 1000))} />
        <IconButton icon={playing ? Pause : Play} label={playing ? "Pause" : "Play"} shortcut="Space" onClick={() => setPlaying(!playing)} />
        <IconButton icon={SkipForward} label="Forward a second" onClick={() => seek(playhead + 1000)} />
        <span className="ml-2 font-mono text-[11px] tabular-nums text-ink-2">
          {recordingClock(outputTime(segments, playhead) / 1000)} <span className="text-ink-3">/ {recordingClock(duration / 1000)}</span>
        </span>
        <span className="flex-1" />
        <span className="text-[11px] text-ink-3">{project.media.width}×{project.media.height} source</span>
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
