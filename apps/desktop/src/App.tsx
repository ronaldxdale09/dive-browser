import { useEffect } from "react";
import { Rail, RAIL_WIDTH } from "./components/Rail";
import { TabStrip } from "./components/TabStrip";
import { WorkspaceChip } from "./components/WorkspaceChip";
import { Toolbar } from "./components/Toolbar";
import { Content } from "./components/Content";
import { Sidecar } from "./components/Sidecar";
import { Dock } from "./components/Dock";
import { Palette } from "./components/Palette";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { FindBar } from "./components/FindBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Annotator } from "./components/Annotator";
import { Splash } from "./components/Splash";
import { useBrowser } from "./store/browser";
import { usePrefs, watchSystemTheme } from "./store/prefs";
import { useShortcuts } from "./lib/shortcuts";

export function App() {
  const boot = useBrowser((s) => s.boot);
  const error = useBrowser((s) => s.error);
  const notice = useBrowser((s) => s.notice);
  const annotating = useBrowser((s) => s.annotating);
  const editing = useBrowser((s) => s.editing);
  const open = useBrowser((s) => s.open);
  const loadPrefs = usePrefs((s) => s.load);
  const railExpanded = usePrefs((s) => s.prefs.rail_expanded);
  useEffect(() => void boot(), [boot]);
  // Theme and accent live in the preferences, so they land on the document
  // root as soon as the chrome can read them.
  useEffect(() => {
    void loadPrefs();
    return watchSystemTheme();
  }, [loadPrefs]);
  useShortcuts();

  return (
    <div
      className="grid h-full grid-rows-[40px_44px_minmax(0,1fr)] bg-ground text-ink"
      style={{ gridTemplateColumns: `${railExpanded ? RAIL_WIDTH.expanded : RAIL_WIDTH.collapsed}px minmax(0,1fr)` }}
    >
      {/* Title-bar row: the workspace you are in, then its tabs, beside the
          traffic lights (overlay title bar). */}
      <div className="col-span-2 row-start-1 flex items-center gap-2 pl-[84px]">
        <WorkspaceChip />
        <div className="h-full min-w-0 flex-1">
          <TabStrip />
        </div>
      </div>
      <div className="relative col-start-1 row-span-2 row-start-2 bg-ground">
        <Rail />
        {/* The rail cannot reach the title bar -- the traffic lights own that
            corner -- so a plain right border begins as a hairline hanging in
            mid-air under the tab strip. Fading it in over the first few pixels
            lets the edge arrive instead of looking sheared off. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-px"
          style={{ background: "linear-gradient(to bottom, transparent, var(--color-line) 20px)" }}
        />
      </div>
      <div className="col-start-2 row-start-2">
        <Toolbar />
      </div>
      <div className="col-start-2 row-start-3 grid min-h-0 gap-px bg-line" style={{ gridTemplateColumns: open.sidecar ? "minmax(0,1fr) 360px" : "minmax(0,1fr)" }}>
        <div
          className="relative grid min-h-0 gap-px bg-line"
          style={{ gridTemplateRows: `${open.find ? "44px " : ""}minmax(0,1fr)${open.dock ? " 240px" : ""}` }}
        >
          {open.find && <FindBar />}
          <Content />
          {open.dock && <Dock />}
        </div>
        {open.sidecar && <Sidecar />}
      </div>
      {open.palette && <Palette />}
      {open.settings && <SettingsDialog />}
      {annotating && <Annotator path={annotating} />}
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
