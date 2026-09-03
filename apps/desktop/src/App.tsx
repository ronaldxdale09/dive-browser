import { useEffect } from "react";
import { Rail } from "./components/Rail";
import { TabStrip } from "./components/TabStrip";
import { Toolbar } from "./components/Toolbar";
import { Content } from "./components/Content";
import { Sidecar } from "./components/Sidecar";
import { Dock } from "./components/Dock";
import { Palette } from "./components/Palette";
import { useBrowser } from "./store/browser";
import { useShortcuts } from "./lib/shortcuts";

export function App() {
  const boot = useBrowser((s) => s.boot);
  const error = useBrowser((s) => s.error);
  const open = useBrowser((s) => s.open);
  useEffect(() => void boot(), [boot]);
  useShortcuts();

  return (
    <div className="grid h-full grid-cols-[52px_minmax(0,1fr)] grid-rows-[40px_44px_minmax(0,1fr)] bg-ground text-ink">
      <div className="row-span-3 border-r border-line bg-ground">
        <Rail />
      </div>
      <div className="col-start-2 row-start-1" data-tauri-drag-region>
        <TabStrip />
      </div>
      <div className="col-start-2 row-start-2">
        <Toolbar />
      </div>
      <div className="col-start-2 row-start-3 grid min-h-0 gap-px bg-line pl-px" style={{ gridTemplateColumns: open.sidecar ? "minmax(0,1fr) 360px" : "minmax(0,1fr)" }}>
        <div className="grid min-h-0 gap-px bg-line" style={{ gridTemplateRows: open.dock ? "minmax(0,1fr) 240px" : "minmax(0,1fr)" }}>
          <Content />
          {open.dock && <Dock />}
        </div>
        {open.sidecar && <Sidecar />}
      </div>
      {open.palette && <Palette />}
      {error && (
        <div role="alert" className="fixed bottom-3 left-16 rounded-full border border-line-2 bg-surface-2 px-3 py-1.5 text-xs text-ink-2 shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
