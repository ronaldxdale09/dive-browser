/**
 * Export: render every output frame offline through the same `Renderer`
 * the stage uses, encode them with WebCodecs (VP9) into a WebM, stream that
 * to the engine, and let ffmpeg finish the MP4 or GIF with the source's
 * sound cut and sped to match.
 */
import { Muxer, ArrayBufferTarget } from "webm-muxer";
import { ipc } from "../lib/ipc";
import type { RecordingResult } from "../lib/ipc";
import { outputSize, sourceTime } from "./math";
import type { Segment } from "./math";
import type { CursorSample, Project } from "./model";
import { Renderer } from "./render";
import { recordMediaProbe, setMediaProbePhase } from "./mediaProbe";

export interface ExportProgress {
  phase: "preparing" | "rendering" | "uploading" | "finishing" | "done";
  /** 0 to 1 within the phase. */
  progress: number;
  frame?: number;
  frames?: number;
}

export interface ExportInput {
  project: Project;
  playable: string;
  segments: Segment[];
  cursorRaw: CursorSample[];
  cursorSmooth: CursorSample[];
  onProgress: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /** The stage's element, when there is one: a second decoder on the same clip fails. */
  video?: HTMLVideoElement | null;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("export cancelled");
}

/** Each wait owns and removes its timer/abort listener, including late rejection. */
async function bounded<T>(operation: Promise<T>, phase: string, milliseconds: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("export cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error(`${phase} timed out`)), milliseconds);
    if (signal?.aborted) abort();
  });
  try {
    const result = await Promise.race([operation, interruption]);
    checkCancelled(signal);
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function ready(video: HTMLVideoElement, owned: boolean, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  if (video.readyState >= 2) return;
  let active = true;
  let nudge: ReturnType<typeof setTimeout> | undefined;
  let done = () => {};
  let fail = () => {};
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      done = () => { if (video.readyState >= 2) resolve(); };
      fail = () => reject(new Error("the video could not be opened"));
      video.addEventListener("loadeddata", done);
      video.addEventListener("canplay", done);
      video.addEventListener("error", fail);
      if (owned) video.load();
      nudge = setTimeout(() => {
        if (active && !signal?.aborted && video.readyState < 2) {
          void video.play().then(() => { if (active && !signal?.aborted) video.pause(); }).catch(() => undefined);
        }
      }, 400);
    }), "opening video", 20_000, signal);
  } finally {
    active = false;
    clearTimeout(nudge);
    video.removeEventListener("loadeddata", done);
    video.removeEventListener("canplay", done);
    video.removeEventListener("error", fail);
  }
}

/** Seek a video element and wait until the frame at that time is decoded. */
async function seekTo(video: HTMLVideoElement, ms: number, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const target = ms / 1000;
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return;
  let done = () => {};
  let fail = () => {};
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = () => reject(new Error("the video could not be read at that point"));
      video.addEventListener("seeked", done);
      video.addEventListener("error", fail);
      video.currentTime = target;
    }), "seeking video", 10_000, signal);
  } catch (error) {
    const event = signal?.aborted ? "export_seek_cancelled" : error instanceof Error && error.message === "seeking video timed out" ? "export_seek_timeout" : "export_seek_failed";
    recordMediaProbe(video, event);
    throw error;
  } finally {
    video.removeEventListener("seeked", done);
    video.removeEventListener("error", fail);
  }
}

async function drain(encoder: VideoEncoder, checkError: () => void, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  checkError();
  if (encoder.encodeQueueSize <= 24) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      timer = setInterval(() => {
        try {
          checkError();
          if (encoder.encodeQueueSize <= 24) resolve();
        } catch (error) { reject(error); }
      }, 4);
    }), "draining video encoder", 10_000, signal);
  } finally {
    clearInterval(timer);
  }
}

export async function exportProject(input: ExportInput): Promise<RecordingResult> {
  const { project, playable, segments, cursorRaw, cursorSmooth, onProgress, signal } = input;
  const e = project.editor;
  const gif = e.export.format === "gif";
  const fps = gif ? e.export.gifFps : e.export.fps;
  const { width, height } = outputSize(e.aspectRatio, gif ? "720p" : e.export.resolution, project.media);
  const durationMs = segments.length ? segments[segments.length - 1]!.outEndMs : 0;
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
  onProgress({ phase: "preparing", progress: 0 });

  // Borrow the stage's element when it is there; otherwise make one in the
  // document (hidden) and nudge it with a play/pause, since a detached
  // element never fetches its metadata under the embedded Chromium.
  const borrowed = input.video ?? null;
  const video = borrowed ?? document.createElement("video");
  let released = false;
  let encoder: VideoEncoder | undefined;
  const release = () => {
    if (released) return;
    released = true;
    video.pause();
    if (!borrowed) {
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
  };
  try {
    checkCancelled(signal);
    setMediaProbePhase(video, "preparing");
    recordMediaProbe(video, "export_begin");
    if (!borrowed) {
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      document.body.appendChild(video);
      video.src = playable;
    } else {
      video.pause();
    }
    // Never reload the Stage's existing decoder.
    await ready(video, !borrowed, signal);
    setMediaProbePhase(video, "seeking", 0, 0);
    await seekTo(video, 0, signal);
    video.pause();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: e.annotations.some((a) => a.type === "blur") });
    if (!ctx) throw new Error("no canvas");
    const renderer = new Renderer();

    const codec = "vp09.00.10.08";
    const support = await bounded(VideoEncoder.isConfigSupported({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps }), "configuring video encoder", 10_000, signal);
    if (!support.supported) throw new Error("this build cannot encode video");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "V_VP9", width, height, frameRate: fps }, firstTimestampBehavior: "offset" });
    let encodeError: Error | null = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => (encodeError = err),
    });
    encoder.configure({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps, latencyMode: "quality" });

    renderer.snap();
    for (let i = 0; i < frames; i++) {
      checkCancelled(signal);
      if (encodeError) throw encodeError;
      const outMs = (i / fps) * 1000;
      const srcMs = sourceTime(segments, outMs) ?? project.media.durationMs;
      setMediaProbePhase(video, "seeking", i + 1, srcMs);
      await seekTo(video, srcMs, signal);
      setMediaProbePhase(video, "draining", i + 1, srcMs);
      await drain(encoder, () => { if (encodeError) throw encodeError; }, signal);
      setMediaProbePhase(video, "rendering", i + 1, srcMs);
      renderer.draw(ctx, project, video, srcMs, cursorSmooth, cursorRaw, { width, height, playing: true });
      const frame = new VideoFrame(canvas, { timestamp: Math.round(outMs * 1000), duration: Math.round(1_000_000 / fps) });
      try {
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      } finally {
        frame.close();
      }
      if (i % 3 === 0) onProgress({ phase: "rendering", progress: (i + 1) / frames, frame: i + 1, frames });
    }
    setMediaProbePhase(video, "flushing");
    await bounded(encoder.flush(), "flushing video encoder", 10_000, signal);
    if (encodeError) throw encodeError;
    encoder.close();
    muxer.finalize();
    release();
    const webm = new Uint8Array(target.buffer);

    checkCancelled(signal);
    setMediaProbePhase(video, "uploading");
    onProgress({ phase: "uploading", progress: 0 });
    const staged = await ipc.screenExportBegin();
    const CHUNK = 6 * 1024 * 1024;
    for (let offset = 0; offset < webm.length; offset += CHUNK) {
      checkCancelled(signal);
      const piece = webm.subarray(offset, Math.min(webm.length, offset + CHUNK));
      await ipc.screenExportAppend(staged, toBase64(piece));
      onProgress({ phase: "uploading", progress: Math.min(1, (offset + piece.length) / webm.length) });
    }

    // IPC has no native cancellation contract yet. Do not race a write or ffmpeg
    // against AbortSignal and imply that its native work has stopped.
    checkCancelled(signal);
    setMediaProbePhase(video, "finishing");
    onProgress({ phase: "finishing", progress: 0 });
    const result = await ipc.screenExportFinish({
      staged,
      source: project.media.source,
      format: gif ? "gif" : "mp4",
      fps,
      gif_fps: e.export.gifFps,
      segments: segments.map((s) => ({ src_start_ms: s.srcStartMs, src_end_ms: s.srcEndMs, speed: s.speed })),
      with_audio: !gif,
    });
    setMediaProbePhase(video, "done");
    onProgress({ phase: "done", progress: 1 });
    return result;
  } finally {
    recordMediaProbe(video, "export_end");
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } finally {
      release();
    }
  }
}

function bitrateFor(w: number, h: number, fps: number): number {
  const px = w * h;
  const base = px <= 1280 * 720 ? 6_000_000 : px <= 1920 * 1080 ? 12_000_000 : 24_000_000;
  return Math.round(base * (fps > 30 ? 1.4 : 1));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  return btoa(s);
}
