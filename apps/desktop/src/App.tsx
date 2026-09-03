import { useEffect } from "react";
import { Rail } from "./components/Rail";
import { TabStrip } from "./components/TabStrip";
import { Toolbar } from "./components/Toolbar";
import { Content } from "./components/Content";
import { Sidecar } from "./components/Sidecar";
import { Dock } from "./components/Dock";
import { Palette } from "./components/Palette";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { FindBar } from "./components/FindBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Splash } from "./components/Splash";
import { useBrowser } from "./store/browser";
import { useShortcuts } from "./lib/shortcuts";

export function App() {
  const boot = useBrowser((s) => s.boot);
  const error = useBrowser((s) => s.error);
  const notice = useBrowser((s) => s.notice);
  const editing = useBrowser((s) => s.editing);
  const open = useBrowser((s) => s.open);
  useEffect(() => void boot(), [boot]);
  useShortcuts();

  return (
    <div className="grid h-full grid-cols-[52px_minmax(0,1fr)] grid-rows-[40px_44px_minmax(0,1fr)] bg-ground text-ink">
      {/* Title-bar row: tabs sit beside the traffic lights (overlay title bar). */}
      <div className="col-span-2 row-start-1 pl-[84px]" data-tauri-drag-region>
        <TabStrip />
      </div>
      <div className="col-start-1 row-span-2 row-start-2 border-r border-line bg-ground">
        <Rail />
      </div>
      <div className="col-start-2 row-start-2">
        <Toolbar />
      </div>
      <div className="col-start-2 row-start-3 grid min-h-0 gap-px bg-line pl-px" style={{ gridTemplateColumns: open.sidecar ? "minmax(0,1fr) 360px" : "minmax(0,1fr)" }}>
        <div className="relative grid min-h-0 gap-px bg-line" style={{ gridTemplateRows: open.dock ? "minmax(0,1fr) 240px" : "minmax(0,1fr)" }}>
          {open.find && <FindBar />}
          <Content />
          {open.dock && <Dock />}
        </div>
        {open.sidecar && <Sidecar />}
      </div>
      {open.palette && <Palette />}
      {open.settings && <SettingsDialog />}
      <Splash />
      <WorkspaceDialog key={editing?.id ?? (editing ? "new" : "closed")} />
      {notice && (
        <div role="status" className="fixed bottom-3 left-16 rounded-full border border-line-2 bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-ink-2 shadow-lg">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="fixed bottom-3 left-16 rounded-full border border-line-2 bg-surface-2 px-3 py-1.5 text-xs text-ink-2 shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
