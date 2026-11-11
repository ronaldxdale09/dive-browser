export type ExportStage = "prepare" | "seek" | "drain" | "draw" | "encode" | "upload" | "flush" | "finish";

/** Summed wall time per stage of one export. Numbers only: never a path, URL or message. */
export class ExportTimings {
  readonly totals: Record<ExportStage, number> = { prepare: 0, seek: 0, drain: 0, draw: 0, encode: 0, upload: 0, flush: 0, finish: 0 };
  uploadBytes = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}

  async time<T>(stage: ExportStage, work: () => Promise<T> | T): Promise<T> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.totals[stage] += this.now() - start;
    }
  }

  /** Synchronous work, timed without adding an await to the per-frame loop. */
  timeSync<T>(stage: ExportStage, work: () => T): T {
    const start = this.now();
    try {
      return work();
    } finally {
      this.totals[stage] += this.now() - start;
    }
  }

  summary(meta: { frames: number; fps: number; width: number; height: number; sourceWidth: number; sourceHeight: number; format: "mp4" | "gif" }) {
    return { ...meta, ...this.totals, uploadBytes: this.uploadBytes };
  }
}

export type ExportTimingsSummary = ReturnType<ExportTimings["summary"]>;

declare global { interface Window { __diveScreenExportTimings?: ExportTimingsSummary[]; } }

const KEPT = 8;

/** Keep the last 8 summaries, only while UI timing is switched on. */
export function publishExportTimings(summary: ExportTimingsSummary): void {
  if (window.__diveUiInputTimingEnabled !== true) return;
  const ring = window.__diveScreenExportTimings ??= [];
  ring.push(summary);
  if (ring.length > KEPT) ring.splice(0, ring.length - KEPT);
}
