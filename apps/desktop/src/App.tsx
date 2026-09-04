import { lazy, Suspense, useEffect, useState } from "react";
import { Rail, RAIL_WIDTH } from "./components/Rail";
import { TabStrip } from "./components/TabStrip";
import { TabDnd } from "./components/TabDnd";
import { ProfileChip } from "./components/ProfileChip";
import { ProfileDialog } from "./components/ProfileDialog";
import { FeatureBar } from "./components/FeatureBar";
import { Toolbar } from "./components/Toolbar";
import { Content } from "./components/Content";
import { FindBar } from "./components/FindBar";
import { Splash } from "./components/Splash";
import { ResizeHandle } from "./components/ResizeHandle";
import { UpdateDialog } from "./components/UpdateDialog";
import { DOCK_LIMITS, SIDECAR_LIMITS } from "./lib/resize";
import { useBrowser } from "./store/browser";
import { useLayout } from "./store/layout";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "./store/prefs";
import { useShortcuts } from "./lib/shortcuts";
import { useChromeLayout } from "./lib/adaptiveLayout";
import { PanelSkeleton, ToastViewport } from "./components/ChromeFeedback";
import { usePicker } from "./store/simulator";
import { scheduleBootCheck } from "./store/updates";
import { bootSubtitles } from "./store/subtitles";
import { useRecording } from "./store/recording";
import { useRecorder } from "./store/recorder";

const Sidecar = lazy(() => import("./components/Sidecar").then(({ Sidecar }) => ({ default: Sidecar })));
const Dock = lazy(() => import("./components/Dock").then(({ Dock }) => ({ default: Dock })));
const Palette = lazy(() => import("./components/Palette").then(({ Palette }) => ({ default: Palette })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then(({ SettingsDialog }) => ({ default: SettingsDialog })));
const Annotator = lazy(() => import("./components/Annotator").then(({ Annotator }) => ({ default: Annotator })));
const Library = lazy(() => import("./components/Library").then(({ Library }) => ({ default: Library })));
const Extensions = lazy(() => import("./components/Extensions").then(({ Extensions }) => ({ default: Extensions })));
const Shortcuts = lazy(() => import("./components/Shortcuts").then(({ Shortcuts }) => ({ default: Shortcuts })));
const WorkspaceDialog = lazy(() => import("./components/WorkspaceDialog").then(({ WorkspaceDialog }) => ({ default: WorkspaceDialog })));
const RecorderModal = lazy(() => import("./components/RecorderModal").then(({ RecorderModal }) => ({ default: RecorderModal })));
const RecordDialog = lazy(() => import("./components/record/RecordDialog").then(({ RecordDialog }) => ({ default: RecordDialog })));
const DefaultBrowserDialog = lazy(() => import("./components/DefaultBrowserDialog").then(({ DefaultBrowserDialog }) => ({ default: DefaultBrowserDialog })));
const Subtitles = lazy(() => import("./components/Subtitles").then(({ Subtitles }) => ({ default: Subtitles })));
const RecordingDoneDialog = lazy(() => import("./components/record/RecordingDoneDialog").then(({ RecordingDoneDialog }) => ({ default: RecordingDoneDialog })));

export function App() {
  const boot = useBrowser((s) => s.boot);
  const error = useBrowser((s) => s.error);
  const notice = useBrowser((s) => s.notice);
  const annotating = useBrowser((s) => s.annotating);
  const editing = useBrowser((s) => s.editing);
  const open = useBrowser((s) => s.open);
  const loadPrefs = usePrefs((s) => s.load);
  const railExpanded = usePrefs((s) => s.prefs.rail_expanded);
  const responsive = useChromeLayout();
  const pickerOpen = usePicker((s) => s.open);
  const recordingPhase = useRecording((s) => s.phase);
  const recorderOpen = useRecorder((s) => s.isOpen);
  const toggle = useBrowser((s) => s.toggle);
  const dockHeight = useLayout((s) => s.dockHeight);
  const sidecarWidth = useLayout((s) => s.sidecarWidth);
  const setDockHeight = useLayout((s) => s.setDockHeight);
  const setSidecarWidth = useLayout((s) => s.setSidecarWidth);
  // The size under the pointer mid-drag; the store gets it on release.
  const [live, setLive] = useState<{ dock: number | null; sidecar: number | null }>({ dock: null, sidecar: null });
  useEffect(() => void boot(), [boot]);
  // One look at the release channel, well after startup has settled.
  useEffect(() => scheduleBootCheck(), []);
  // Subscribe once to the live-subtitles events.
  useEffect(() => void bootSubtitles(), []);
  // Which panels were open last time is remembered here rather than in the
  // browser store, whose `open` map is per-window state. Applied once at
  // boot, then followed.
  useEffect(() => {
    const remembered = useLayout.getState().openPanels;
    for (const panel of ["sidecar", "dock"] as const) toggle(panel, remembered[panel]);
    return useBrowser.subscribe((s, prev) => {
      if (s.open !== prev.open) useLayout.getState().setOpenPanels({ sidecar: s.open.sidecar, dock: s.open.dock });
    });
  }, [toggle]);
  // Theme and accent live in the preferences, so they land on the document
  // root as soon as the chrome can read them.
  useEffect(() => {
    void loadPrefs();
    const stopTheme = watchSystemTheme();
    const stopMotion = watchReducedMotion();
    return () => {
      stopTheme();
      stopMotion();
    };
  }, [loadPrefs]);
  useShortcuts();

  const effectiveRailExpanded = railExpanded && !responsive.collapseRail;
  const railWidth = effectiveRailExpanded ? RAIL_WIDTH.expanded : RAIL_WIDTH.collapsed;
  const showSidecar = open.sidecar && !(responsive.singleAuxPanel && pickerOpen);
  // On compact windows one auxiliary surface gets the available space. The
  // agent wins while explicitly open; the dock preference is left intact and
  // returns when the sidecar closes.
  const showDock = open.dock && !(responsive.singleAuxPanel && (showSidecar || pickerOpen));
  const shownSidecarWidth = Math.min(live.sidecar ?? sidecarWidth, Math.max(280, window.innerWidth - railWidth - 360));

  return (
    <TabDnd>
    <div
      className="grid h-full grid-rows-[40px_44px_minmax(0,1fr)] bg-ground text-ink"
      style={{ gridTemplateColumns: `${railWidth}px minmax(0,1fr)` }}
    >
      {/* Title-bar row: the workspace you are in, then its tabs, beside the
          traffic lights (overlay title bar). */}
      <header className="col-span-2 row-start-1 flex items-center gap-2 pl-[84px]">
        <ProfileChip />
        <div className="h-full min-w-0 flex-1">
          <TabStrip />
        </div>
        <FeatureBar compact={responsive.collapseRail} />
      </header>
      <div className="relative col-start-1 row-span-2 row-start-2 bg-ground">
        <Rail forceCollapsed={responsive.collapseRail} />
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
      <nav aria-label="Browser controls" className="col-start-2 row-start-2 min-w-0">
        <Toolbar compact={responsive.compactToolbar} />
      </nav>
      <main className="col-start-2 row-start-3 grid min-h-0 min-w-0 bg-line" style={{ gridTemplateColumns: showSidecar ? `minmax(0,1fr) auto ${shownSidecarWidth}px` : "minmax(0,1fr)" }}>
        <div
          className="relative grid min-h-0 bg-line"
          style={{ gridTemplateRows: `${open.find ? "44px " : ""}minmax(0,1fr)${showDock ? ` auto ${live.dock ?? dockHeight}px` : ""}` }}
        >
          {open.find && (
            <div className="min-h-0 border-b border-line">
              <FindBar />
            </div>
          )}
          <Content />
          {showDock && (
            <ResizeHandle
              orientation="horizontal"
              label="Resize dock"
              value={live.dock ?? dockHeight}
              limits={DOCK_LIMITS}
              onResize={(px) => setLive((l) => ({ ...l, dock: px }))}
              onCommit={(px) => {
                setLive((l) => ({ ...l, dock: null }));
                setDockHeight(px);
              }}
            />
          )}
          <Suspense fallback={showDock ? <PanelSkeleton label="developer dock" horizontal /> : null}>{showDock && <Dock />}</Suspense>
        </div>
        {showSidecar && (
          <ResizeHandle
            orientation="vertical"
            label="Resize agent panel"
            value={live.sidecar ?? sidecarWidth}
            limits={SIDECAR_LIMITS}
            onResize={(px) => setLive((l) => ({ ...l, sidecar: px }))}
            onCommit={(px) => {
              setLive((l) => ({ ...l, sidecar: null }));
              setSidecarWidth(px);
            }}
          />
        )}
        <Suspense fallback={showSidecar ? <PanelSkeleton label="agent" /> : null}>{showSidecar && <Sidecar />}</Suspense>
      </main>
      <Suspense fallback={(open.palette || open.settings || open.library || open.extensions || open.shortcuts || open.defaultBrowser || open.subtitles || annotating) ? <div className="fixed inset-0 z-40 bg-ground/75 backdrop-blur-sm" aria-label="Loading dialog" /> : null}>
        {open.palette && <Palette />}\n        {open.settings && <SettingsDialog />}\n        {open.library && <Library />}\n        {open.extensions && <Extensions />}\n        {open.shortcuts && <Shortcuts />}\n        {open.defaultBrowser && <DefaultBrowserDialog />}\n        {open.subtitles && <Subtitles />}\n        {annotating && <Annotator path={annotating} />}\n      </Suspense>
      <Splash />
      <Suspense fallback={(editing || recorderOpen || recordingPhase === "setup" || recordingPhase === "done") ? <div className="fixed inset-0 z-40 bg-ground/75 backdrop-blur-sm" aria-label="Loading dialog" /> : null}>
        {editing && <WorkspaceDialog key={editing.id ?? "new"} />}\n        <ProfileDialog />
        {recorderOpen && <RecorderModal />}\n        {recordingPhase === "setup" && <RecordDialog />}\n        {recordingPhase === "done" && <RecordingDoneDialog />}\n      </Suspense>
      <ToastViewport
        notice={notice}
        error={error}
        onDismissNotice={() => useBrowser.setState({ notice: null })}
        onDismissError={() => useBrowser.setState({ error: null })}
      />
      <UpdateDialog />
    </div>
    </TabDnd>
  );
}
