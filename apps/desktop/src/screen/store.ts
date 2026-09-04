import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { buildSegments, outputDuration, smoothCursorPath, suggestZooms } from "./math";
import type { Segment } from "./math";
import { cursorSamples, newId, newProject, normalizeProject, DEFAULT_ANNOTATION_STYLE } from "./model";
import type { AnnotationRegion, AnnotationType, CursorSample, Project, RecordingEvents, SpeedRegion, TrimRegion, ZoomRegion } from "./model";

/**
 * The editor's state for one recording: the project, what is selected,
 * where the playhead is, and an undo history over the project. Saved to
 * the project file a moment after every change.
 */

export type Selection = { kind: "zoom" | "trim" | "speed" | "annotation"; id: string } | null;

export interface EditorState {
  source: string | null;
  project: Project | null;
  /** Playable file as a blob URL, once loaded. */
  playable: string | null;
  loading: string | null;
  error: string | null;
  /** Raw and smoothed pointer paths. */
  cursorRaw: CursorSample[];
  cursorSmooth: CursorSample[];
  segments: Segment[];
  /** Output length, ms. */
  duration: number;
  /** Playhead, in source time. */
  playhead: number;
  playing: boolean;
  selection: Selection;
  past: Project["editor"][];
  future: Project["editor"][];
  dirty: boolean;
  saved: boolean;

  open: (source: string) => Promise<void>;
  close: () => void;
  /** Change the project; `history` false for drags in progress. */
  update: (fn: (e: Project["editor"]) => Project["editor"], history?: boolean) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  seek: (srcMs: number) => void;
  setPlaying: (v: boolean) => void;
  addZoom: (atMs?: number) => void;
  addTrim: (atMs?: number) => void;
  addSpeed: (atMs?: number) => void;
  addAnnotation: (type: AnnotationType, atMs?: number) => void;
  deleteSelected: () => void;
  autoZoom: () => void;
  save: () => Promise<void>;
}

const MAX_HISTORY = 80;
let saveTimer = 0;

/** Default length of a new region: 5% of the video, 1 to 30 s. */
export function defaultRegionLength(durationMs: number): number {
  return Math.min(30_000, Math.max(1_000, durationMs * 0.05));
}

/** A free slot for a region of `length` at `at`, or null when it overlaps. */
export function placeRegion(at: number, length: number, durationMs: number, others: { startMs: number; endMs: number }[]): { startMs: number; endMs: number } | null {
  const startMs = Math.max(0, Math.min(at, durationMs - 100));
  const endMs = Math.min(durationMs, startMs + length);
  if (endMs - startMs < 100) return null;
  if (others.some((o) => startMs < o.endMs && endMs > o.startMs)) return null;
  return { startMs, endMs };
}

function derive(project: Project, smoothing: number, raw: CursorSample[]) {
  const segments = buildSegments(project.media.durationMs, project.editor.trims, project.editor.speeds);
  return { segments, duration: outputDuration(segments), cursorSmooth: smoothCursorPath(raw, smoothing) };
}

export const useEditor = create<EditorState>((set, get) => ({
  source: null,
  project: null,
  playable: null,
  loading: null,
  error: null,
  cursorRaw: [],
  cursorSmooth: [],
  segments: [],
  duration: 0,
  playhead: 0,
  playing: false,
  selection: null,
  past: [],
  future: [],
  dirty: false,
  saved: false,

  open: async (source) => {
    get().close();
    set({ source, loading: "Reading the recording…", error: null });
    try {
      const info = await ipc.screenMediaInfo(source);
      const media: Project["media"] = { source, playable: info.playable, events: info.events, durationMs: info.duration_ms ?? 0, width: info.width, height: info.height };
      const saved = await ipc.screenProjectRead(source);
      const project = saved ? normalizeProject(JSON.parse(saved), media) : newProject(media);
      let track: RecordingEvents | null = null;
      if (info.events) {
        try {
          track = JSON.parse(await readText(info.events)) as RecordingEvents;
        } catch {
          track = null;
        }
      }
      const raw = cursorSamples(track);
      set({ loading: "Loading the video…" });
      const playableFile = info.playable ?? (source.endsWith(".gif") ? null : null);
      if (!playableFile) throw new Error("This recording has no playable copy to edit. Record again with the video format.");
      const url = await readBlobUrl(playableFile, source.endsWith(".webm") ? "video/webm" : "video/webm");
      const derived = derive(project, project.editor.cursor.smoothing, raw);
      set({ project, playable: url, cursorRaw: raw, ...derived, loading: null, playhead: 0, past: [], future: [], saved: Boolean(saved) });
      // A fresh project gets automatic zooms from the pointer's dwells.
      if (!saved && project.editor.autoZoom && raw.length) get().autoZoom();
    } catch (e) {
      set({ loading: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  close: () => {
    const { playable } = get();
    if (playable) URL.revokeObjectURL(playable);
    window.clearTimeout(saveTimer);
    set({ source: null, project: null, playable: null, cursorRaw: [], cursorSmooth: [], segments: [], duration: 0, playhead: 0, playing: false, selection: null, past: [], future: [], dirty: false });
  },

  update: (fn, history = true) => {
    const { project, past, cursorRaw } = get();
    if (!project) return;
    const editor = fn(project.editor);
    if (editor === project.editor) return;
    const next = { ...project, editor };
    const smoothingChanged = editor.cursor.smoothing !== project.editor.cursor.smoothing;
    const timeChanged = editor.trims !== project.editor.trims || editor.speeds !== project.editor.speeds;
    set({
      project: next,
      dirty: true,
      ...(history ? { past: [...past.slice(-MAX_HISTORY + 1), project.editor], future: [] } : {}),
      ...(timeChanged || smoothingChanged ? derive(next, editor.cursor.smoothing, cursorRaw) : {}),
    });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().save(), 600);
  },
  checkpoint: () => {
    const { project, past } = get();
    if (project) set({ past: [...past.slice(-MAX_HISTORY + 1), project.editor], future: [] });
  },
  undo: () => {
    const { project, past, future, cursorRaw } = get();
    if (!project || past.length === 0) return;
    const editor = past[past.length - 1]!;
    const next = { ...project, editor };
    set({ project: next, past: past.slice(0, -1), future: [project.editor, ...future], dirty: true, ...derive(next, editor.cursor.smoothing, cursorRaw) });
    saveTimer = window.setTimeout(() => void get().save(), 600);
  },
  redo: () => {
    const { project, past, future, cursorRaw } = get();
    if (!project || future.length === 0) return;
    const editor = future[0]!;
    const next = { ...project, editor };
    set({ project: next, past: [...past, project.editor], future: future.slice(1), dirty: true, ...derive(next, editor.cursor.smoothing, cursorRaw) });
    saveTimer = window.setTimeout(() => void get().save(), 600);
  },
  select: (selection) => set({ selection }),
  seek: (srcMs) => {
    const { project } = get();
    set({ playhead: Math.max(0, Math.min(project?.media.durationMs ?? 0, srcMs)) });
  },
  setPlaying: (playing) => set({ playing }),

  addZoom: (atMs) => {
    const { project, playhead } = get();
    if (!project) return;
    const slot = placeRegion(atMs ?? playhead, defaultRegionLength(project.media.durationMs), project.media.durationMs, project.editor.zooms);
    if (!slot) return;
    const z: ZoomRegion = { id: newId("zoom"), ...slot, depth: 3, focus: { cx: 0.5, cy: 0.5 }, focusMode: "manual", source: "manual" };
    get().update((e) => ({ ...e, zooms: [...e.zooms, z] }));
    set({ selection: { kind: "zoom", id: z.id } });
  },
  addTrim: (atMs) => {
    const { project, playhead } = get();
    if (!project) return;
    const slot = placeRegion(atMs ?? playhead, defaultRegionLength(project.media.durationMs), project.media.durationMs, project.editor.trims);
    if (!slot) return;
    const t: TrimRegion = { id: newId("trim"), ...slot };
    get().update((e) => ({ ...e, trims: [...e.trims, t] }));
    set({ selection: { kind: "trim", id: t.id } });
  },
  addSpeed: (atMs) => {
    const { project, playhead } = get();
    if (!project) return;
    const slot = placeRegion(atMs ?? playhead, defaultRegionLength(project.media.durationMs), project.media.durationMs, project.editor.speeds);
    if (!slot) return;
    const s: SpeedRegion = { id: newId("speed"), ...slot, speed: 1.5 };
    get().update((e) => ({ ...e, speeds: [...e.speeds, s] }));
    set({ selection: { kind: "speed", id: s.id } });
  },
  addAnnotation: (type, atMs) => {
    const { project, playhead } = get();
    if (!project) return;
    const at = atMs ?? playhead;
    const endMs = Math.min(project.media.durationMs, at + Math.max(2_000, defaultRegionLength(project.media.durationMs)));
    const a: AnnotationRegion = {
      id: newId("note"),
      type,
      startMs: Math.max(0, Math.min(at, project.media.durationMs - 100)),
      endMs,
      position: { x: 50, y: type === "text" ? 82 : 50 },
      size: type === "arrow" ? { width: 14, height: 14 } : type === "blur" ? { width: 25, height: 25 } : { width: 40, height: 14 },
      ...(type === "text" ? { text: "Your note" } : {}),
      style: { ...DEFAULT_ANNOTATION_STYLE },
      zIndex: project.editor.annotations.length,
    };
    get().update((e) => ({ ...e, annotations: [...e.annotations, a] }));
    set({ selection: { kind: "annotation", id: a.id } });
  },
  deleteSelected: () => {
    const { selection } = get();
    if (!selection) return;
    get().update((e) => {
      switch (selection.kind) {
        case "zoom":
          return { ...e, zooms: e.zooms.filter((z) => z.id !== selection.id) };
        case "trim":
          return { ...e, trims: e.trims.filter((t) => t.id !== selection.id) };
        case "speed":
          return { ...e, speeds: e.speeds.filter((s) => s.id !== selection.id) };
        case "annotation":
          return { ...e, annotations: e.annotations.filter((a) => a.id !== selection.id) };
      }
    });
    set({ selection: null });
  },
  autoZoom: () => {
    const { project, cursorRaw } = get();
    if (!project) return;
    const made = suggestZooms(cursorRaw, project.media.durationMs, project.editor.zooms, (startMs, endMs, cx, cy) => ({
      id: newId("zoom"),
      startMs,
      endMs,
      depth: 3,
      focus: { cx, cy },
      focusMode: project.editor.autoFocusAll ? "auto" : "manual",
      source: "auto",
    }));
    if (made.length) get().update((e) => ({ ...e, zooms: [...e.zooms, ...made] }));
  },
  save: async () => {
    const { source, project } = get();
    if (!source || !project) return;
    try {
      await ipc.screenProjectWrite(source, JSON.stringify(project, null, 2));
      set({ dirty: false, saved: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** Read a captured file in pieces into a blob URL. */
export async function readBlobUrl(path: string, mime: string): Promise<string> {
  const size = await ipc.fileSize(path);
  if (size === null) throw new Error(`Could not read file size: ${path}`);
  const CHUNK = 8 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += CHUNK) {
    const b64 = await ipc.fileReadChunk(path, offset, Math.min(CHUNK, size - offset));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
  }
  return URL.createObjectURL(new Blob(parts as BlobPart[], { type: mime }));
}

async function readText(path: string): Promise<string> {
  const size = await ipc.fileSize(path);
  if (size === null) throw new Error(`Could not read file size: ${path}`);
  let out = "";
  const CHUNK = 8 * 1024 * 1024;
  for (let offset = 0; offset < size; offset += CHUNK) {
    const b64 = await ipc.fileReadChunk(path, offset, Math.min(CHUNK, size - offset));
    out += new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }
  return out;
}
