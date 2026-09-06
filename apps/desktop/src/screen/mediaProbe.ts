import { useEditor } from "./store";
export type MediaProbeEvent = "lease_setup" | "lease_release" | "media_error" | "export_begin" | "export_seek_failed" | "export_seek_timeout" | "export_seek_cancelled" | "export_end";
export type MediaProbePhase = "idle" | "preparing" | "seeking" | "rendering" | "draining" | "flushing" | "uploading" | "finishing" | "done";
interface MediaProbeRecord {
  atMs: number | null; event: MediaProbeEvent; phase: MediaProbePhase;
  generation: number | null; exporting: number; frame: number | null; targetMs: number | null;
  code: number | null; currentTime: number | null; seeking: number; paused: number; readyState: number; networkState: number;
}
declare global { interface Window { __diveScreenMediaProbe?: MediaProbeRecord[]; } }
const phases = new WeakMap<HTMLVideoElement, { phase: MediaProbePhase; frame: number | null; targetMs: number | null; generation: number | null }>();
const finite = (value: number | undefined | null): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Fixed diagnostic only: never copy src, metadata, error messages or arbitrary payloads. */
export function recordMediaProbe(video: HTMLVideoElement, event: MediaProbeEvent, generation?: number): void {
  if (window.__diveUiInputTimingEnabled !== true) return;
  const state = useEditor.getState();
  const context = phases.get(video);
  const record: MediaProbeRecord = {
    atMs: finite(performance.now()), event, phase: context?.phase ?? "idle",
    generation: generation !== undefined ? finite(generation) : context ? context.generation : finite(state.generation), exporting: Number(state.exporting),
    frame: context?.frame ?? null, targetMs: context?.targetMs ?? null,
    code: finite(video.error?.code), currentTime: finite(video.currentTime),
    seeking: Number(video.seeking), paused: Number(video.paused),
    readyState: video.readyState, networkState: video.networkState,
  };
  const ring = window.__diveScreenMediaProbe ??= [];
  ring.push(record);
  if (ring.length > 64) ring.splice(0, ring.length - 64);
  if (event === "export_end") phases.delete(video);
}

/** Updating context does not emit one entry per output frame. */
export function setMediaProbePhase(video: HTMLVideoElement, phase: MediaProbePhase, frame?: number, targetMs?: number): void {
  if (window.__diveUiInputTimingEnabled !== true) return;
  const previous = phases.get(video);
  const generation = phase === "preparing" || !previous ? finite(useEditor.getState().generation) : previous.generation;
  phases.set(video, { phase, frame: finite(frame), targetMs: finite(targetMs), generation });
}
