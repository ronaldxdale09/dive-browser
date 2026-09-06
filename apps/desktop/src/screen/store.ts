import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { captureMediaUrl } from "../lib/mediaUrl";
import { useBrowser } from "../store/browser";
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
  /** Playable file as a scoped, streamable asset URL. */
  playable: string | null;
  loading: string | null;
  error: string | null;
  saveError: string | null;
  /** Ownership of the mounted editor, including same-source replacements. */
  generation: number;
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
  /** The stage's video element, lent to the exporter: the embedded
   * Chromium refuses a second decoder on the same clip. */
  videoEl: HTMLVideoElement | null;
  setVideoEl: (v: HTMLVideoElement | null) => void;
  /** An export is driving the video; the stage keeps its hands off. */
  exporting: boolean;
  setExporting: (v: boolean) => void;

  open: (source: string) => Promise<void>;
  close: (generation?: number) => void;
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
let nextRevision = 0;
let activeRevision = 0;
interface Draft { project: Project; revision: number; error: string | null }
const drafts = new Map<string, Draft>();
const writes = new Map<string, { revision: number; promise: Promise<void> }>();

function remember(source: string, project: Project): Draft {
  const draft = { project, revision: ++nextRevision, error: drafts.get(source)?.error ?? null };
  activeRevision = draft.revision;
  drafts.set(source, draft);
  return draft;
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void useEditor.getState().save(), 600);
}

/** Capture the project before queueing: later editor state cannot change its file or payload. */
function writeDraft(source: string, draft: Draft, generation: number): Promise<void> {
  const queued = writes.get(source);
  if (queued && queued.revision >= draft.revision) return queued.promise;
  const json = JSON.stringify(draft.project, null, 2);
  const current = () => {
    const state = useEditor.getState();
    return state.source === source && state.generation === generation && activeRevision === draft.revision;
  };
  const promise = (queued?.promise ?? Promise.resolve()).then(async () => {
    try {
      await ipc.screenProjectWrite(source, json);
      if (drafts.get(source)?.revision === draft.revision) drafts.delete(source);
      if (current()) useEditor.setState({ dirty: false, saved: true, saveError: null });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      if (drafts.get(source)?.revision === draft.revision) drafts.set(source, { ...draft, error });
      if (current()) useEditor.setState({ saveError: error });
      else if (drafts.get(source)?.revision === draft.revision) {
        useBrowser.setState({ error: `Edits to ${source.split("/").pop() ?? source} could not be saved: ${error}. Reopen the recording to retry.` });
      }
    }
  }).finally(() => {
    if (writes.get(source)?.promise === promise) writes.delete(source);
  });
  writes.set(source, { revision: draft.revision, promise });
  return promise;
}

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
  saveError: null,
  generation: 0,
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
  videoEl: null,
  setVideoEl: (videoEl) => set({ videoEl }),
  exporting: false,
  setExporting: (exporting) => set({ exporting }),

  open: async (source) => {
    get().close();
    const generation = get().generation + 1;
    const current = () => get().generation === generation && get().source === source;
    set({ generation, source, loading: "Reading the recording…", error: null, saveError: null });
    try {
      // A tab can reopen before its unmount save reaches disk. On failure the
      // retained draft below takes precedence over the older sidecar.
      const pending = writes.get(source);
      if (pending) await pending.promise;
      if (!current()) return;
      const info = await ipc.screenMediaInfo(source);
      if (!current()) return;
      const media: Project["media"] = { source, playable: info.playable, events: info.events, durationMs: info.duration_ms ?? 0, width: info.width, height: info.height };
      const draft = drafts.get(source);
      const saved = draft ? null : await ipc.screenProjectRead(source);
      if (!current()) return;
      const stored = draft?.project ?? (saved ? JSON.parse(saved) as Partial<Project> | null : null);
      // A copied or stale sidecar owns edits, never the opened file's identity
      // or dimensions. Apply current media before normalization clamps regions.
      const project = stored ? normalizeProject({ ...stored, media }, media) : newProject(media);
      let track: RecordingEvents | null = null;
      if (info.events) {
        try {
          track = JSON.parse(await readText(info.events)) as RecordingEvents;
        } catch {
          track = null;
        }
      }
      if (!current()) return;
      const raw = cursorSamples(track);
      const playableFile = info.playable;
      if (!playableFile) throw new Error("This recording has no playable copy to edit. Record again with the video format.");
      // Chromium can reuse its separate media buffer cache for the same URL
      // despite no-store. A reopened/repaired companion needs a new cache key;
      // the revision belongs only to this preview lease, never the saved path.
      const url = new URL(captureMediaUrl(playableFile), window.location.href);
      url.searchParams.set("dive-screen-revision", String(generation));
      const derived = derive(project, project.editor.cursor.smoothing, raw);
      activeRevision = draft?.revision ?? ++nextRevision;
      if (draft) drafts.set(source, { ...draft, project });
      set({ project, playable: url.href, cursorRaw: raw, ...derived, loading: null, playhead: 0, past: [], future: [], saved: Boolean(saved), dirty: Boolean(draft), saveError: draft?.error ?? null });
      if (!saved && !draft && project.editor.autoZoom && raw.length) get().autoZoom();
    } catch (e) {
      if (current()) set({ loading: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  close: (generation) => {
    const state = get();
    if (generation !== undefined && state.generation !== generation) return;
    // save() captures and queues the dirty snapshot synchronously, before the
    // editor is cleared. React unmount need not wait for native disk I/O.
    if (state.dirty) void state.save();
    if (state.playable?.startsWith("blob:")) URL.revokeObjectURL(state.playable);
    window.clearTimeout(saveTimer);
    set({ generation: state.generation + 1, source: null, project: null, playable: null, loading: null, error: null, saveError: null, cursorRaw: [], cursorSmooth: [], segments: [], duration: 0, playhead: 0, playing: false, selection: null, past: [], future: [], dirty: false, saved: false, videoEl: null, exporting: false });
  },

  update: (fn, history = true) => {
    const { source, project, past, cursorRaw } = get();
    if (!source || !project) return;
    const editor = fn(project.editor);
    if (editor === project.editor) return;
    const next = { ...project, editor };
    remember(source, next);
    const smoothingChanged = editor.cursor.smoothing !== project.editor.cursor.smoothing;
    const timeChanged = editor.trims !== project.editor.trims || editor.speeds !== project.editor.speeds;
    set({
      project: next,
      dirty: true,
      ...(history ? { past: [...past.slice(-MAX_HISTORY + 1), project.editor], future: [] } : {}),
      ...(timeChanged || smoothingChanged ? derive(next, editor.cursor.smoothing, cursorRaw) : {}),
    });
    scheduleSave();
  },
  checkpoint: () => {
    const { project, past } = get();
    if (project) set({ past: [...past.slice(-MAX_HISTORY + 1), project.editor], future: [] });
  },
  undo: () => {
    const { source, project, past, future, cursorRaw } = get();
    if (!source || !project || past.length === 0) return;
    const editor = past[past.length - 1]!;
    const next = { ...project, editor };
    remember(source, next);
    set({ project: next, past: past.slice(0, -1), future: [project.editor, ...future], dirty: true, ...derive(next, editor.cursor.smoothing, cursorRaw) });
    scheduleSave();
  },
  redo: () => {
    const { source, project, past, future, cursorRaw } = get();
    if (!source || !project || future.length === 0) return;
    const editor = future[0]!;
    const next = { ...project, editor };
    remember(source, next);
    set({ project: next, past: [...past, project.editor], future: future.slice(1), dirty: true, ...derive(next, editor.cursor.smoothing, cursorRaw) });
    scheduleSave();
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
    const { source, project, generation } = get();
    if (!source || !project) return;
    window.clearTimeout(saveTimer);
    const retained = drafts.get(source);
    const draft = retained?.project === project ? retained : remember(source, project);
    set({ dirty: true });
    await writeDraft(source, draft, generation);
  },
}));

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

// Reachable from the DevTools console while developing.
if (import.meta.env.DEV) (window as unknown as { __diveEditor?: typeof useEditor }).__diveEditor = useEditor;
