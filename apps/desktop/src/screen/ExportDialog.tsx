import { Check, Download, ExternalLink, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { ipc } from "../lib/ipc";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { RecordingResult } from "../lib/ipc";
import { recordingBytes, recordingClock } from "../lib/recordingFormat";
import { exportProject } from "./export";
import type { ExportProgress } from "./export";
import { outputSize } from "./math";
import { useEditor } from "./store";

// Object identity is the run token; a new editor generation can replace an
// old native finish, but only the matching run may release global ownership.
interface ExportOwner { generation: number }
let exportOwner: ExportOwner | null = null;

/**
 * Export: choose the file, watch it render, then open it or find it. The
 * render runs in the chrome and never blocks the editor's own state.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const playable = useEditor((s) => s.playable);
  const segments = useEditor((s) => s.segments);
  const duration = useEditor((s) => s.duration);
  const cursorRaw = useEditor((s) => s.cursorRaw);
  const cursorSmooth = useEditor((s) => s.cursorSmooth);
  const update = useEditor((s) => s.update);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const runOwner = useRef<ExportOwner | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abort.current?.abort(); };
  }, []);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const busy = progress !== null && progress.phase !== "done";
  useFocusTrap(dialog, { active: Boolean(project), onEscape: () => { if (!busy) onClose(); } });
  useEffect(() => {
    if (busy) cancelButton.current?.focus({ preventScroll: true });
    else if (result) doneButton.current?.focus({ preventScroll: true });
    else if (dialog.current && !dialog.current.contains(document.activeElement)) dialog.current.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [busy, result]);
  if (!project) return null;
  const ex = project.editor.export;
  const gif = ex.format === "gif";
  const size = outputSize(project.editor.aspectRatio, gif ? "720p" : ex.resolution, project.media);
  const set = (p: Partial<typeof ex>) => update((e) => ({ ...e, export: { ...e.export, ...p } }));

  const run = async () => {
    const store = useEditor.getState();
    if (!playable || store.project !== project || store.playable !== playable) return;
    if (runOwner.current) return;
    if (exportOwner?.generation === store.generation) {
      setError("Another export for this recording is still finishing. Try again when it completes.");
      return;
    }
    const owner: ExportOwner = { generation: store.generation };
    exportOwner = owner;
    runOwner.current = owner;
    const current = () => mounted.current && runOwner.current === owner && exportOwner === owner && useEditor.getState().generation === owner.generation;
    setError(null);
    setResult(null);
    abort.current = new AbortController();
    store.setPlaying(false);
    store.setExporting(true);
    try {
      const r = await exportProject({ project, playable, segments, cursorRaw, cursorSmooth, onProgress: (value) => { if (current()) setProgress(value); }, signal: abort.current.signal, video: store.videoEl });
      if (current()) setResult(r);
    } catch (e) {
      if (current()) {
        console.error("[divescreen] export failed", e);
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (exportOwner === owner) {
        exportOwner = null;
        if (useEditor.getState().generation === owner.generation) useEditor.getState().setExporting(false);
      }
      if (runOwner.current === owner) runOwner.current = null;
    }
  };

  const label = progress?.phase === "rendering" ? `Rendering frame ${progress.frame} of ${progress.frames}` : progress?.phase === "uploading" ? "Handing the frames to the engine" : progress?.phase === "finishing" ? "Encoding with the sound" : "Preparing";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={() => !busy && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Export" onMouseDown={(e) => e.stopPropagation()} className="w-[520px] max-w-[calc(100vw-32px)] rounded-2xl border border-line-2 bg-surface p-5 shadow-2xl">
        <header className="mb-4 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-highlight-soft text-highlight">
            <Icon icon={Download} size={17} />
          </span>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">Export</h2>
            <p className="text-[11px] text-ink-3">
              {size.width}×{size.height} · {recordingClock(duration / 1000)} · {gif ? `GIF at ${ex.gifFps} fps` : `MP4 at ${ex.fps} fps`}
            </p>
          </div>
          {!busy && (
            <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
              <Icon icon={X} size={14} />
            </button>
          )}
        </header>

        {!result && !busy && (
          <div className="flex flex-col gap-3 text-xs">
            <Row label="Format">
              <Seg value={ex.format} options={[{ value: "mp4", label: "Video (MP4)" }, { value: "gif", label: "GIF" }]} onChange={(format) => set({ format })} />
            </Row>
            {gif ? (
              <Row label="Frame rate">
                <Seg value={ex.gifFps} options={[10, 15, 20].map((v) => ({ value: v as 10 | 15 | 20, label: `${v} fps` }))} onChange={(gifFps) => set({ gifFps })} />
              </Row>
            ) : (
              <>
                <Row label="Resolution">
                  <Seg value={ex.resolution} options={[{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }, { value: "source", label: "Source" }]} onChange={(resolution) => set({ resolution })} />
                </Row>
                <Row label="Frame rate">
                  <Seg value={ex.fps} options={[{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} onChange={(fps) => set({ fps })} />
                </Row>
              </>
            )}
            {error && <p className="text-danger">{error}</p>}
            <button type="button" onClick={() => void run()} className="mt-1 h-9 rounded-lg bg-accent text-xs font-medium text-accent-ink hover:brightness-110">
              Export
            </button>
          </div>
        )}

        {busy && progress && (
          <div className="flex flex-col gap-3 text-xs">
            <p className="text-ink-2">{label}…</p>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-highlight transition-[width]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
            </div>
            <button ref={cancelButton} type="button" onClick={() => abort.current?.abort()} className="h-8 self-end rounded-lg px-3 text-ink-2 hover:bg-surface-2 hover:text-ink">
              Cancel
            </button>
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-3 text-xs">
            <p className="flex items-center gap-2 text-ink">
              <Icon icon={Check} size={14} className="text-highlight" />
              Saved {result.path.split("/").pop()} · {recordingBytes(result.bytes ?? 0)} · {result.width}×{result.height}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void ipc.recordingOpen(result.path)} className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-ink hover:bg-surface-3">
                <Icon icon={ExternalLink} size={13} /> Open
              </button>
              <button type="button" onClick={() => void ipc.downloadsReveal(result.path)} className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-ink hover:bg-surface-3">
                <Icon icon={FolderOpen} size={13} /> Show in Finder
              </button>
              <span className="flex-1" />
              <button ref={doneButton} type="button" onClick={onClose} className="h-8 rounded-lg bg-accent px-4 font-medium text-accent-ink">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_1fr] items-center gap-3">
      <span className="text-ink-2">{label}</span>
      {children}
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="grid gap-1 rounded-lg bg-surface-2 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)} className={`h-7 rounded-md text-[11px] ${o.value === value ? "bg-surface text-ink shadow-sm ring-1 ring-line-2" : "text-ink-2 hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
