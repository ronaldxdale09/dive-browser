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

/** Seek a video element and wait until the frame at that time is decoded. */
function seekTo(video: HTMLVideoElement, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = ms / 1000;
    if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return resolve();
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("the video could not be read at that point"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = target;
  });
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
  const release = () => {
    if (borrowed) {
      borrowed.pause();
      return;
    }
    video.remove();
  };
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
  try {
    // Never `load()` an element that already has the clip: re-opening the
    // decoder is exactly what fails.
    if (video.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (video.readyState >= 2) resolve();
        };
        video.addEventListener("loadeddata", done);
        video.addEventListener("canplay", done);
        video.addEventListener("error", () => reject(new Error("the video could not be opened")), { once: true });
        if (!borrowed) video.load();
        window.setTimeout(() => {
          if (video.readyState < 2) void video.play().then(() => video.pause()).catch(() => undefined);
        }, 400);
        window.setTimeout(() => reject(new Error("the video took too long to open")), 20_000);
      });
    }
    await seekTo(video, 0);
    video.pause();
  } catch (err) {
    release();
    throw err;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: e.annotations.some((a) => a.type === "blur") });
  if (!ctx) throw new Error("no canvas");
  const renderer = new Renderer();

  const codec = "vp09.00.10.08";
  const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps });
  if (!support.supported) throw new Error("this build cannot encode video");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "V_VP9", width, height, frameRate: fps }, firstTimestampBehavior: "offset" });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => (encodeError = err),
  });
  encoder.configure({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps, latencyMode: "quality" });

  renderer.snap();
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) {
      encoder.close();
      release();
      throw new Error("export cancelled");
    }
    if (encodeError) throw encodeError;
    const outMs = (i / fps) * 1000;
    const srcMs = sourceTime(segments, outMs) ?? project.media.durationMs;
    await seekTo(video, srcMs);
    renderer.draw(ctx, project, video, srcMs, cursorSmooth, cursorRaw, { width, height, playing: true });
    const frame = new VideoFrame(canvas, { timestamp: Math.round(outMs * 1000), duration: Math.round(1_000_000 / fps) });
    // Back-pressure: let the encoder drain rather than piling frames up.
    while (encoder.encodeQueueSize > 24) await new Promise((r) => setTimeout(r, 4));
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    if (i % 3 === 0) onProgress({ phase: "rendering", progress: (i + 1) / frames, frame: i + 1, frames });
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  release();
  const webm = new Uint8Array(target.buffer);

  onProgress({ phase: "uploading", progress: 0 });
  const staged = await ipc.screenExportBegin();
  const CHUNK = 6 * 1024 * 1024;
  for (let offset = 0; offset < webm.length; offset += CHUNK) {
    if (signal?.aborted) throw new Error("export cancelled");
    const piece = webm.subarray(offset, Math.min(webm.length, offset + CHUNK));
    await ipc.screenExportAppend(staged, toBase64(piece));
    onProgress({ phase: "uploading", progress: Math.min(1, (offset + piece.length) / webm.length) });
  }

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
  onProgress({ phase: "done", progress: 1 });
  return result;
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
