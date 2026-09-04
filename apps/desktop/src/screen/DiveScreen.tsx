import { Download, FolderOpen, Redo2, RefreshCw, Save, Undo2, Video } from "lucide-react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "../components/Icon";
import { Tooltip } from "../components/Tooltip";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useRecording } from "../store/recording";
import { ExportDialog } from "./ExportDialog";
import { SettingsPanel } from "./SettingsPanel";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { useEditor } from "./store";

/**
 * DiveScreen: the editor for a finished recording, in a tab of its own.
 * A thin top bar; the stage and the settings panel side by side; the
 * timeline below. Everything saves as it goes.
 */
export function DiveScreen({ src, tabId }: { src: string | null; tabId: string }) {
  const open = useEditor((s) => s.open);
  const close = useEditor((s) => s.close);
  const source = useEditor((s) => s.source);
  const project = useEditor((s) => s.project);
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.error);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) console.debug("[divescreen] mount", src);
    if (src && src !== source) void open(src);
    return () => {
      if (import.meta.env.DEV) console.debug("[divescreen] unmount", src);
      if (src) close();
    };
    // Open once per source; the store guards against duplicate opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useShortcuts(project !== null && !exporting);

  if (!src) return <Empty />;
  if (error) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-ink-3">
        <div>
          <p className="text-ink">This recording could not be opened.</p>
          <p className="mt-1 text-xs">{error}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button type="button" onClick={() => void open(src)} className="flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-xs font-medium text-ground hover:brightness-90">
              <Icon icon={RefreshCw} size={13} /> Try again
            </button>
            <button type="button" onClick={() => void ipc.downloadsReveal(src).catch((cause) => useEditor.setState({ error: cause instanceof Error ? cause.message : String(cause) }))} className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-xs text-ink hover:bg-surface-3">
              <Icon icon={FolderOpen} size={13} /> Show file
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!project || loading) {
    return (
      <div className="grid h-full place-items-center text-sm text-ink-3" data-tab={tabId}>
        {loading ?? "Loading…"}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-ink" data-tab={tabId}>
      <TopBar onExport={() => setExporting(true)} />
      <div className="flex min-h-0 flex-1 gap-3 px-3">
        <Stage />
        <SettingsPanel onExport={() => setExporting(true)} />
      </div>
      <div className="h-[236px] shrink-0 p-3">
        <Timeline />
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  );
}

function TopBar({ onExport }: { onExport: () => void }) {
  const source = useEditor((s) => s.source);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);
  const dirty = useEditor((s) => s.dirty);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const save = useEditor((s) => s.save);
  const openSetup = useRecording((s) => s.openSetup);
  const name = source?.split("/").pop() ?? "";
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 px-4">
      <span className="mr-3 text-[13px] font-semibold tracking-tight">DiveScreen</span>
      <Bar icon={Video} label="Return to Recorder" onClick={() => openSetup()} />
      <Bar icon={FolderOpen} label="Show in Finder" onClick={() => source && void ipc.downloadsReveal(source).catch(() => undefined)} />
      <Bar icon={Save} label={dirty ? "Save Project" : "Saved"} onClick={() => void save()} />
      <span className="flex-1" />
      <span className="mr-3 truncate font-mono text-[11px] text-ink-3" title={source ?? ""}>
        {name}
      </span>
      <Tool icon={Undo2} label="Undo" shortcut="⌘Z" disabled={past === 0} onClick={undo} />
      <Tool icon={Redo2} label="Redo" shortcut="⇧⌘Z" disabled={future === 0} onClick={redo} />
      <button type="button" onClick={onExport} className="ml-2 flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-[12px] font-medium text-black hover:brightness-110">
        <Icon icon={Download} size={13} /> Export
      </button>
    </div>
  );
}

function Bar({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink">
      <Icon icon={icon} size={14} />
      {label}
    </button>
  );
}

function Tool({ icon, label, shortcut, disabled, onClick }: { icon: LucideIcon; label: string; shortcut?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent">
        <Icon icon={icon} size={14} />
      </button>
    </Tooltip>
  );
}

/** Keyboard: Space plays, Z/T/S/A/B add, Delete removes, ⌘Z undoes, arrows step. */
function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void s.save();
        return;
      }
      if (mod) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.setPlaying(!s.playing);
          break;
        case "z":
        case "Z":
          s.addZoom();
          break;
        case "t":
        case "T":
          s.addTrim();
          break;
        case "s":
        case "S":
          s.addSpeed();
          break;
        case "a":
        case "A":
          s.addAnnotation("text");
          break;
        case "b":
        case "B":
          s.addAnnotation("blur");
          break;
        case "Delete":
        case "Backspace":
          s.deleteSelected();
          break;
        case "ArrowLeft":
          e.preventDefault();
          s.seek(s.playhead - (e.shiftKey ? 1000 : 1000 / 60));
          break;
        case "ArrowRight":
          e.preventDefault();
          s.seek(s.playhead + (e.shiftKey ? 1000 : 1000 / 60));
          break;
        case "Escape":
          s.select(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

function Empty() {
  const openSetup = useRecording((s) => s.openSetup);
  const active = useBrowser((s) => s.activeTab);
  return (
    <div className="grid h-full place-items-center text-sm text-ink-3">
      <div className="text-center">
        <p>Open a recording to edit it.</p>
        <button type="button" disabled={!active} onClick={() => openSetup()} className="mt-3 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-ink hover:bg-surface-3 disabled:opacity-40">
          Record a tab
        </button>
      </div>
    </div>
  );
}
