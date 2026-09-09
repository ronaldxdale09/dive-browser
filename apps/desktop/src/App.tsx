import { isPrivateWindow } from "./lib/privateMode";
import { lazy, Suspense, useEffect, useState } from "react";
import { Rail, RAIL_WIDTH } from "./components/Rail";
import { TabStrip } from "./components/TabStrip";
import { TabDnd } from "./components/TabDnd";
import { ProfileDialog } from "./components/ProfileDialog";
import { FeatureBar } from "./components/FeatureBar";
import { BrowserActions, Toolbar } from "./components/Toolbar";
import { AppsDialog } from "./components/AppsDialog";
import { Content } from "./components/Content";
import { FindBar } from "./components/FindBar";
import { Splash } from "./components/Splash";
import { ResizeHandle } from "./components/ResizeHandle";
import { IsolatedPanel } from "./components/IsolatedPanel";
import { UpdateDialog } from "./components/UpdateDialog";
import { SIDECAR_LIMITS, clampSize, dockLimitsFor } from "./lib/resize";
import { useBrowser } from "./store/browser";
import { useLayout } from "./store/layout";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "./store/prefs";
import { useShortcuts } from "./lib/shortcuts";
import { useCoversContent } from "./lib/overlay";
import { Palette } from "./components/Palette";
import { useChromeLayout, useViewportSize } from "./lib/adaptiveLayout";
import { PanelSkeleton, ToastViewport } from "./components/ChromeFeedback";
import { usePicker } from "./store/simulator";
import { scheduleBootCheck } from "./store/updates";
import { bootSubtitles } from "./store/subtitles";
import { useRecording } from "./store/recording";
import { useRecorder } from "./store/recorder";

const Sidecar = lazy(() => import("./components/Sidecar").then(({ Sidecar }) => ({ default: Sidecar })));
const Dock = lazy(() => import("./components/Dock").then(({ Dock }) => ({ default: Dock })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then(({ SettingsDialog }) => ({ default: SettingsDialog })));
const Library = lazy(() => import("./components/Library").then(({ Library }) => ({ default: Library })));
const Extensions = lazy(() => import("./components/Extensions").then(({ Extensions }) => ({ default: Extensions })));
const Shortcuts = lazy(() => import("./components/Shortcuts").then(({ Shortcuts }) => ({ default: Shortcuts })));
const WorkspaceDialog = lazy(() => import("./components/WorkspaceDialog").then(({ WorkspaceDialog }) => ({ default: WorkspaceDialog })));
const RecorderModal = lazy(() => import("./components/RecorderModal").then(({ RecorderModal }) => ({ default: RecorderModal })));
const RecordDialog = lazy(() => import("./components/record/RecordDialog").then(({ RecordDialog }) => ({ default: RecordDialog })));
const DefaultBrowserDialog = lazy(() => import("./components/DefaultBrowserDialog").then(({ DefaultBrowserDialog }) => ({ default: DefaultBrowserDialog })));
const Subtitles = lazy(() => import("./components/Subtitles").then(({ Subtitles }) => ({ default: Subtitles })));
const ImportDialog = lazy(() => import("./components/ImportDialog").then(({ ImportDialog }) => ({ default: ImportDialog })));
const Onboarding = lazy(() => import("./components/onboarding/Onboarding").then(({ Onboarding }) => ({ default: Onboarding })));
const RecordingDoneDialog = lazy(() => import("./components/record/RecordingDoneDialog").then(({ RecordingDoneDialog }) => ({ default: RecordingDoneDialog })));

export function App() {
  const boot = useBrowser((s) => s.boot);
  const error = useBrowser((s) => s.error);
  const notice = useBrowser((s) => s.notice);
  const noticeAction = useBrowser((s) => s.noticeAction);
  const editing = useBrowser((s) => s.editing);
  const open = useBrowser((s) => s.open);
  // Keep the native page covered between navigation dialogs, including while
  // a replacement's lazy chunk is loading inside Suspense.
  useCoversContent(open.palette || open.settings || open.library || open.shortcuts);
  const loadPrefs = usePrefs((s) => s.load);
  const railExpanded = usePrefs((s) => s.prefs.rail_expanded);
  const responsive = useChromeLayout();
  const viewport = useViewportSize();
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
  useEffect(() => { if (!isPrivateWindow()) return scheduleBootCheck(); }, []);
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
  // The expanded rail lists the tabs, so the title bar has nothing of its
  // own to show and folds into the toolbar.
  const oneBar = effectiveRailExpanded;
  const showSidecar = open.sidecar && !(responsive.singleAuxPanel && pickerOpen);
  // On compact windows one auxiliary surface gets the available space. The
  // agent wins while explicitly open; the dock preference is left intact and
  // returns when the sidecar closes.
  const showDock = open.dock && !(responsive.singleAuxPanel && (showSidecar || pickerOpen));
  const shownSidecarWidth = Math.min(live.sidecar ?? sidecarWidth, Math.max(280, viewport.width - railWidth - 360));
  // The remembered dock height is kept as a preference; what shows is capped
  // by the window, so a short window still has page to look at.
  const dockLimits = dockLimitsFor(viewport.height);
  const shownDockHeight = clampSize(live.dock ?? dockHeight, dockLimits);

  return (
    <TabDnd>
    <div
      // Two shapes. With the rail listing the tabs there is one bar: the
      // rail is a full-height column with the traffic lights at its top, and
      // the main column has a single row of navigation, address, page
      // actions and the feature cluster. With the rail collapsed the tabs
      // need a row of their own across the top, above the toolbar.
      className={`grid h-full bg-ground text-ink ${oneBar ? "grid-rows-[44px_minmax(0,1fr)]" : "grid-rows-[40px_44px_minmax(0,1fr)]"}`}
      // `--chrome-top`: where the chrome ends and a panel hung from it (the
      // main menu) begins, whichever shape the bar is in.
      style={{ gridTemplateColumns: `${railWidth}px minmax(0,1fr)`, "--chrome-top": oneBar ? "46px" : "86px" } as React.CSSProperties}
    >
      {!oneBar && (
        <header className="col-span-2 row-start-1 flex items-center gap-2 pl-[84px]">
          {isPrivateWindow() && <span className="px-2 font-mono text-[10px] tracking-[0.12em] text-ink-2">DIVE</span>}
          <div className="h-full min-w-0 flex-1">
            <TabStrip />
          </div>
          <FeatureBar compact={responsive.collapseRail} />
        </header>
      )}
      <div className={`relative col-start-1 bg-ground ${oneBar ? "row-span-2 row-start-1" : "row-span-2 row-start-2"}`}>
        {/* A full-height rail starts under the traffic lights: that strip is
            the window's handle, and the rail's own content begins below it. */}
        {oneBar && (
          <div className="flex h-10 items-center justify-end pr-3" data-tauri-drag-region="true">
            {isPrivateWindow() && <span className="font-mono text-[10px] tracking-[0.12em] text-ink-2">DIVE</span>}
          </div>
        )}
        <div className={oneBar ? "h-[calc(100%-40px)]" : "h-full"}>
          <Rail forceCollapsed={responsive.collapseRail} />
        </div>
        {/* A rail that stops short of the title bar -- the traffic lights own
            that corner -- would begin its right border as a hairline hanging
            in mid-air under the tab strip. Fading it in over the first few
            pixels lets the edge arrive instead of looking sheared off. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-px"
          style={{ background: oneBar ? "var(--color-line)" : "linear-gradient(to bottom, transparent, var(--color-line) 20px)" }}
        />
      </div>
      {oneBar ? (
        <header className="col-start-2 row-start-1 flex min-w-0 items-center">
          {/* Left to right: navigation and the address, the page's actions,
              the feature cluster, then the browser's own controls in the
              corner where every browser keeps its menu. */}
          <nav aria-label="Browser controls" className="h-full min-w-0 flex-1">
            <Toolbar compact={responsive.compactToolbar} trailing={false} />
          </nav>
          <span className="mr-1 h-4 w-px shrink-0 bg-line-2" aria-hidden />
          <FeatureBar compact={responsive.collapseRail} />
          <span className="mr-1 h-4 w-px shrink-0 bg-line-2" aria-hidden />
          <div className="pr-2">
            <BrowserActions />
          </div>
        </header>
      ) : (
        <nav aria-label="Browser controls" className="col-start-2 row-start-2 min-w-0">
          <Toolbar compact={responsive.compactToolbar} />
        </nav>
      )}
      <main className={`col-start-2 grid min-h-0 min-w-0 bg-line ${oneBar ? "row-start-2" : "row-start-3"}`} style={{ gridTemplateColumns: showSidecar ? `minmax(0,1fr) auto ${shownSidecarWidth}px` : "minmax(0,1fr)" }}>
        <div
          className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] bg-line"
          style={{ gridTemplateRows: `${open.find ? "44px " : ""}minmax(0,1fr)${showDock ? ` auto ${shownDockHeight}px` : ""}` }}
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
              value={shownDockHeight}
              limits={dockLimits}
              onResize={(px) => setLive((l) => ({ ...l, dock: px }))}
              onCommit={(px) => {
                setLive((l) => ({ ...l, dock: null }));
                setDockHeight(px);
              }}
            />
          )}
          {showDock && <IsolatedPanel label="Developer dock" onClose={() => toggle("dock", false)}><Suspense fallback={<PanelSkeleton label="developer dock" horizontal />}><Dock /></Suspense></IsolatedPanel>}
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
        {showSidecar && <IsolatedPanel label="Agent" onClose={() => toggle("sidecar", false)}><Suspense fallback={<PanelSkeleton label="agent" />}><Sidecar /></Suspense></IsolatedPanel>}
      </main>
      <Suspense fallback={(open.palette || open.settings || open.library || open.extensions || open.shortcuts || open.defaultBrowser || open.subtitles || open.import) ? <div className="fixed inset-0 z-40 bg-ground/75 backdrop-blur-sm" aria-label="Loading dialog" /> : null}>
        {open.palette && <Palette />}
        {open.settings && <SettingsDialog />}
        {open.library && <Library />}
        {open.shortcuts && <Shortcuts />}
        {open.apps && <AppsDialog />}
        {open.defaultBrowser && <DefaultBrowserDialog />}
        {open.subtitles && <Subtitles />}
        {open.import && <ImportDialog />}
      </Suspense>
      {open.extensions && <IsolatedPanel label="Extensions" modal onClose={() => toggle("extensions", false)}><Suspense fallback={<div className="fixed inset-0 z-50 bg-ground/75 backdrop-blur-sm" aria-label="Loading extensions" />}><Extensions /></Suspense></IsolatedPanel>}
      <Splash />
      <Suspense fallback={(editing || recorderOpen || recordingPhase === "setup" || recordingPhase === "done") ? <div className="fixed inset-0 z-40 bg-ground/75 backdrop-blur-sm" aria-label="Loading dialog" /> : null}>
        {editing && <WorkspaceDialog key={editing.id ?? "new"} />}
        <ProfileDialog />
        {recorderOpen && <RecorderModal />}
        {recordingPhase === "setup" && <RecordDialog />}
        {recordingPhase === "done" && <RecordingDoneDialog />}
      </Suspense>
      <ToastViewport
        notice={notice}
        noticeAction={noticeAction}
        error={error}
        onDismissNotice={() => useBrowser.setState({ notice: null, noticeAction: null })}
        onDismissError={() => useBrowser.setState({ error: null })}
      />
      <UpdateDialog />
      <Suspense fallback={null}>
        <Onboarding />
      </Suspense>
    </div>
    </TabDnd>
  );
}
