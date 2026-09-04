/**
 * DiveScreen's project: everything the editor decides about a recording,
 * saved as JSON beside it. Times are milliseconds of *source* time (the
 * recording's own clock); trims and speed change how source time maps to
 * the finished video, see `math.ts`.
 */

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "4:5" | "16:10" | "native";
export const ASPECT_RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "native"];

export type FocusMode = "manual" | "auto";
export type ZoomSource = "manual" | "auto";

export interface ZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  /** 1 to 6; the scale table is in `math.ts`. */
  depth: number;
  /** Overrides the depth's scale when set: 1 to 5. */
  customScale?: number;
  /** Where the camera looks, 0 to 1 of the frame. */
  focus: { cx: number; cy: number };
  /** `auto`: the camera follows the recorded pointer instead. */
  focusMode: FocusMode;
  source: ZoomSource;
}

export interface TrimRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export interface SpeedRegion {
  id: string;
  startMs: number;
  endMs: number;
  /** 0.1 to 16. */
  speed: number;
}

export type AnnotationType = "text" | "arrow" | "image" | "blur";
export type TextAnimation = "none" | "fade" | "rise" | "pop" | "slide-left" | "typewriter" | "pulse";
export type ArrowDirection = "up" | "down" | "left" | "right" | "up-left" | "up-right" | "down-left" | "down-right";

export interface AnnotationRegion {
  id: string;
  type: AnnotationType;
  startMs: number;
  endMs: number;
  /** Centre, in percent of the canvas. */
  position: { x: number; y: number };
  /** Size, in percent of the canvas. */
  size: { width: number; height: number };
  text?: string;
  /** Data URL of an uploaded picture. */
  image?: string;
  style: {
    color: string;
    background: string;
    fontSize: number;
    fontFamily: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    align: "left" | "center" | "right";
    animation: TextAnimation;
    /** Arrow only. */
    direction: ArrowDirection;
    strokeWidth: number;
    /** Blur only: mosaic block size in canvas pixels at 1080p. */
    blockSize: number;
    shape: "rectangle" | "oval";
  };
  zIndex: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ExportFormat = "mp4" | "gif";
export type ExportResolution = "720p" | "1080p" | "source";

export interface Project {
  version: 1;
  media: {
    /** The recording (MP4 or GIF) the project belongs to. */
    source: string;
    /** The decodable companion the editor plays. */
    playable: string | null;
    /** Pointer track sidecar, when the recording has one. */
    events: string | null;
    durationMs: number;
    width: number;
    height: number;
  };
  editor: {
    /** `#hex`, `linear-gradient(...)`, a bundled wallpaper id, or a data URL. */
    wallpaper: string;
    blurBackground: boolean;
    /** 0 to 100. */
    padding: number;
    /** 0 to 64. */
    roundness: number;
    /** 0 to 1. */
    shadow: number;
    aspectRatio: AspectRatio;
    crop: CropRegion;
    zooms: ZoomRegion[];
    trims: TrimRegion[];
    speeds: SpeedRegion[];
    annotations: AnnotationRegion[];
    autoZoom: boolean;
    autoFocusAll: boolean;
    cursor: {
      show: boolean;
      /** 0.5 to 10. */
      size: number;
      /** 0 to 1. */
      smoothing: number;
      /** 0 to 5. */
      clickBounce: number;
      /** Draw a ring where clicks happen. */
      clickRing: boolean;
      /** Let the cursor overflow into the padding. */
      clipToCanvas: boolean;
    };
    export: {
      format: ExportFormat;
      resolution: ExportResolution;
      fps: 30 | 60;
      gifFps: 10 | 15 | 20;
    };
  };
}

export const WALLPAPERS: { id: string; name: string; css: string }[] = [
  { id: "aurora", name: "Aurora", css: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)" },
  { id: "sunset", name: "Sunset", css: "linear-gradient(135deg, #f6d365 0%, #fda085 100%)" },
  { id: "orchid", name: "Orchid", css: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)" },
  { id: "ocean", name: "Ocean", css: "linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)" },
  { id: "ember", name: "Ember", css: "linear-gradient(135deg, #ff512f 0%, #dd2476 100%)" },
  { id: "mint", name: "Mint", css: "linear-gradient(135deg, #11998e 0%, #38ef7d 100%)" },
  { id: "dusk", name: "Dusk", css: "linear-gradient(160deg, #1e1e2f 0%, #3a2f5b 60%, #6d4c8f 100%)" },
  { id: "graphite", name: "Graphite", css: "linear-gradient(135deg, #232526 0%, #414345 100%)" },
  { id: "peach", name: "Peach", css: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { id: "sky", name: "Sky", css: "linear-gradient(180deg, #89f7fe 0%, #66a6ff 100%)" },
  { id: "midnight", name: "Midnight", css: "radial-gradient(ellipse at 30% 20%, #1b2a49 0%, #0b1020 70%)" },
  { id: "candy", name: "Candy", css: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)" },
];

export const SOLID_COLORS = ["#000000", "#111111", "#1f1f1f", "#ffffff", "#f3f3f1", "#0f766e", "#1d4ed8", "#7c3aed", "#be185d", "#b45309"];

export const DEFAULT_ANNOTATION_STYLE: AnnotationRegion["style"] = {
  color: "#ffffff",
  background: "transparent",
  fontSize: 32,
  fontFamily: "Inter, system-ui, sans-serif",
  bold: true,
  italic: false,
  underline: false,
  align: "center",
  animation: "fade",
  direction: "right",
  strokeWidth: 4,
  blockSize: 12,
  shape: "rectangle",
};

export function defaultEditor(): Project["editor"] {
  return {
    wallpaper: "aurora",
    blurBackground: false,
    padding: 50,
    roundness: 12,
    shadow: 0.35,
    aspectRatio: "16:9",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    zooms: [],
    trims: [],
    speeds: [],
    annotations: [],
    autoZoom: true,
    autoFocusAll: false,
    cursor: { show: true, size: 3, smoothing: 0.67, clickBounce: 2.5, clickRing: true, clipToCanvas: false },
    export: { format: "mp4", resolution: "1080p", fps: 30, gifFps: 15 },
  };
}

export function newProject(media: Project["media"]): Project {
  return { version: 1, media, editor: defaultEditor() };
}

let counter = 0;
/** Ids that are unique within a session and readable in a file. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/**
 * Read a saved project leniently: every field gets a default and a range,
 * so an older or hand-edited file still opens.
 */
export function normalizeProject(raw: unknown, fallbackMedia: Project["media"]): Project {
  const r = (raw ?? {}) as Partial<Project>;
  const d = defaultEditor();
  const e = { ...d, ...((r.editor ?? {}) as Partial<Project["editor"]>) };
  const media = { ...fallbackMedia, ...((r.media ?? {}) as Partial<Project["media"]>) };
  const dur = Math.max(0, media.durationMs);
  const region = <T extends { startMs: number; endMs: number }>(x: T): T | null => {
    const startMs = clamp(x.startMs, 0, dur);
    const endMs = clamp(x.endMs, startMs + 1, Math.max(startMs + 1, dur));
    return endMs > startMs ? { ...x, startMs, endMs } : null;
  };
  const zooms = (Array.isArray(e.zooms) ? e.zooms : [])
    .map((z) => region(z as ZoomRegion))
    .filter((z): z is ZoomRegion => z !== null)
    .map((z) => ({
      id: String(z.id ?? newId("zoom")),
      startMs: z.startMs,
      endMs: z.endMs,
      depth: clamp(Math.round(z.depth ?? 3), 1, 6),
      ...(z.customScale !== undefined ? { customScale: clamp(z.customScale, 1, 5) } : {}),
      focus: { cx: clamp(z.focus?.cx ?? 0.5, 0, 1), cy: clamp(z.focus?.cy ?? 0.5, 0, 1) },
      focusMode: (z.focusMode === "auto" ? "auto" : "manual") as FocusMode,
      source: (z.source === "auto" ? "auto" : "manual") as ZoomSource,
    }));
  const trims = (Array.isArray(e.trims) ? e.trims : [])
    .map((t) => region(t as TrimRegion))
    .filter((t): t is TrimRegion => t !== null)
    .map((t) => ({ id: String(t.id ?? newId("trim")), startMs: t.startMs, endMs: t.endMs }));
  const speeds = (Array.isArray(e.speeds) ? e.speeds : [])
    .map((s) => region(s as SpeedRegion))
    .filter((s): s is SpeedRegion => s !== null)
    .map((s) => ({ id: String(s.id ?? newId("speed")), startMs: s.startMs, endMs: s.endMs, speed: clamp(s.speed ?? 1.5, 0.1, 16) }));
  const annotations = (Array.isArray(e.annotations) ? e.annotations : [])
    .map((a) => region(a as AnnotationRegion))
    .filter((a): a is AnnotationRegion => a !== null)
    .map((a, i) => ({
      id: String(a.id ?? newId("note")),
      type: (["text", "arrow", "image", "blur"].includes(a.type) ? a.type : "text") as AnnotationType,
      startMs: a.startMs,
      endMs: a.endMs,
      position: { x: clamp(a.position?.x ?? 50, 0, 100), y: clamp(a.position?.y ?? 50, 0, 100) },
      size: { width: clamp(a.size?.width ?? 30, 1, 200), height: clamp(a.size?.height ?? 20, 1, 200) },
      ...(a.text !== undefined ? { text: String(a.text) } : {}),
      ...(a.image !== undefined ? { image: String(a.image) } : {}),
      style: { ...DEFAULT_ANNOTATION_STYLE, ...(a.style ?? {}) },
      zIndex: Number.isFinite(a.zIndex) ? a.zIndex : i,
    }));
  const crop = e.crop ?? d.crop;
  return {
    version: 1,
    media,
    editor: {
      wallpaper: typeof e.wallpaper === "string" && e.wallpaper ? e.wallpaper : d.wallpaper,
      blurBackground: Boolean(e.blurBackground),
      padding: clamp(e.padding, 0, 100),
      roundness: clamp(e.roundness, 0, 64),
      shadow: clamp(e.shadow, 0, 1),
      aspectRatio: ASPECT_RATIOS.includes(e.aspectRatio) ? e.aspectRatio : "16:9",
      crop: {
        x: clamp(crop.x, 0, 0.99),
        y: clamp(crop.y, 0, 0.99),
        width: clamp(crop.width, 0.01, 1),
        height: clamp(crop.height, 0.01, 1),
      },
      zooms,
      trims,
      speeds,
      annotations,
      autoZoom: e.autoZoom !== false,
      autoFocusAll: Boolean(e.autoFocusAll),
      cursor: {
        show: e.cursor?.show !== false,
        size: clamp(e.cursor?.size ?? d.cursor.size, 0.5, 10),
        smoothing: clamp(e.cursor?.smoothing ?? d.cursor.smoothing, 0, 1),
        clickBounce: clamp(e.cursor?.clickBounce ?? d.cursor.clickBounce, 0, 5),
        clickRing: e.cursor?.clickRing !== false,
        clipToCanvas: Boolean(e.cursor?.clipToCanvas),
      },
      export: {
        format: e.export?.format === "gif" ? "gif" : "mp4",
        resolution: (["720p", "1080p", "source"] as ExportResolution[]).includes(e.export?.resolution ?? "1080p") ? (e.export?.resolution ?? "1080p") : "1080p",
        fps: e.export?.fps === 60 ? 60 : 30,
        gifFps: ([10, 15, 20] as const).includes(e.export?.gifFps ?? 15) ? (e.export?.gifFps ?? 15) : 15,
      },
    },
  };
}

/** The pointer track written by the recorder beside a page recording. */
export interface TrackedEvent {
  k: "m" | "c" | "k" | "s" | "v";
  /** Seconds of media time. */
  t: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  dpr?: number;
  b?: number;
}

export interface RecordingEvents {
  viewport: [number, number];
  dpr: number;
  events: TrackedEvent[];
}

/** A pointer sample in the recording's normalised frame. */
export interface CursorSample {
  timeMs: number;
  /** 0 to 1 across the picture. */
  cx: number;
  cy: number;
  click?: boolean;
}

/** Turn the recorder's track into normalised samples, clicks marked. */
export function cursorSamples(track: RecordingEvents | null): CursorSample[] {
  if (!track) return [];
  const [w, h] = track.viewport;
  if (!w || !h) return [];
  const out: CursorSample[] = [];
  for (const e of track.events) {
    if ((e.k !== "m" && e.k !== "c") || e.x === undefined || e.y === undefined) continue;
    out.push({ timeMs: e.t * 1000, cx: clamp(e.x / w, 0, 1), cy: clamp(e.y / h, 0, 1), ...(e.k === "c" ? { click: true } : {}) });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}
