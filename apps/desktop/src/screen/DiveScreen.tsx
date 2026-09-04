import { Download, MessageSquare, MoveUpRight, Redo2, Scissors, Undo2, Wand2, Gauge, ZoomIn, EyeOff, Image as ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "../components/Icon";
import { Tooltip } from "../components/Tooltip";
import { ExportDialog } from "./ExportDialog";
import { SettingsPanel } from "./SettingsPanel";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { useEditor } from "./store";

/**
 * DiveScreen: the editor for a finished recording, in a tab of its own.
 * Stage and settings above, timeline below; everything saves as it goes.
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
    if (src && src !== source) void open(src);
    return () => {
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
      <div className="flex min-h-0 flex-1">
        <Stage />
        <SettingsPanel />
      </div>
      <div className="h-[212px] shrink-0 border-t border-line">
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
  const addZoom = useEditor((s) => s.addZoom);
  const addTrim = useEditor((s) => s.addTrim);
  const addSpeed = useEditor((s) => s.addSpeed);
  const addAnnotation = useEditor((s) => s.addAnnotation);
  const autoZoom = useEditor((s) => s.autoZoom);
  const hasPointer = useEditor((s) => s.cursorRaw.length > 0);
  const name = source?.split("/").pop() ?? "";
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
      <span className="mr-2 text-xs font-semibold">DiveScreen</span>
      <span className="truncate font-mono text-[11px] text-ink-3" title={source ?? ""}>
        {name}
      </span>
      <span className="ml-2 text-[10px] text-ink-3">{dirty ? "Saving…" : "Saved"}</span>
      <span className="flex-1" />
      <Tool icon={Undo2} label="Undo" shortcut="⌘Z" disabled={past === 0} onClick={undo} />
      <Tool icon={Redo2} label="Redo" shortcut="⇧⌘Z" disabled={future === 0} onClick={redo} />
      <span className="mx-2 h-4 w-px bg-line-2" />
      <Tool icon={ZoomIn} label="Add zoom" shortcut="Z" onClick={() => addZoom()} />
      <Tool icon={Wand2} label="Suggest zooms from the pointer" disabled={!hasPointer} onClick={autoZoom} />
      <Tool icon={Scissors} label="Cut a stretch" shortcut="T" onClick={() => addTrim()} />
      <Tool icon={Gauge} label="Change speed" shortcut="S" onClick={() => addSpeed()} />
      <Tool icon={MessageSquare} label="Add text" shortcut="A" onClick={() => addAnnotation("text")} />
      <Tool icon={MoveUpRight} label="Add arrow" onClick={() => addAnnotation("arrow")} />
      <Tool icon={ImageIcon} label="Add picture" onClick={() => addAnnotation("image")} />
      <Tool icon={EyeOff} label="Blur an area" shortcut="B" onClick={() => addAnnotation("blur")} />
      <span className="mx-2 h-4 w-px bg-line-2" />
      <button type="button" onClick={onExport} className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-accent-ink hover:brightness-110">
        <Icon icon={Download} size={13} /> Export
      </button>
    </div>
  );
}

function Tool({ icon, label, shortcut, disabled, onClick }: { icon: LucideIcon; label: string; shortcut?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent">
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
  return (
    <div className="grid h-full place-items-center text-sm text-ink-3">
      <p>Open a recording to edit it: record a tab, then choose “Edit in DiveScreen”.</p>
    </div>
  );
}
