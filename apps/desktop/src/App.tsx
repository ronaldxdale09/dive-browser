import { windowDrag } from "./lib/windowDrag";
import { isPrivateWindow } from "./lib/privateMode";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Rail, RAIL_WIDTH, RailToggle } from "./components/Rail";
import { Wordmark } from "./components/Wordmark";
import { BuildBadge } from "./components/BuildBadge";
import { PAGE_ID, TabStrip } from "./components/TabStrip";
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
import { SessionRecoveryCard } from "./components/SessionRecoveryCard";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { UpdateDialog } from "./components/UpdateDialog";
import { clampSize, dockLimitsFor } from "./lib/resize";
import { useBrowser } from "./store/browser";
import { useLayout } from "./store/layout";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "./store/prefs";
import { useShortcuts } from "./lib/shortcuts";
import { useCoversContent } from "./lib/overlay";
import { useChromeLayout, useViewportSize } from "./lib/adaptiveLayout";
import { DialogLoading, LiveRegions, PanelSkeleton, ToastViewport } from "./components/ChromeFeedback";
import { usePicker } from "./store/simulator";
import { startUpdateWatch } from "./store/updates";
import { useTabAudio } from "./store/tabAudio";
import { TaskManager } from "./components/TaskManager";
import { bootSubtitles } from "./store/subtitles";
import { useRecording } from "./store/recording";
import { useRecorder } from "./store/recorder";
import { WindowControls } from "./components/WindowControls";
import { AgentAnnouncer } from "./components/agent/AgentAnnouncer";
import { WindowResizeEdges } from "./components/WindowResizeEdges";
import { isWindows } from "./lib/commands";
import { listenForAgentPresence } from "./store/agentPresence";
import { listenForEmulation } from "./store/emulation";
import { listenForUpdateProgress } from "./store/updates";

const AgentDock = lazy(() => import("./components/AgentDock").then(({ AgentDock }) => ({ default: AgentDock })));
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
// The palette brings cmdk and its Radix dialog with it, which kept them in the
// startup chunk. It is lazy like the other dialogs and fetched once the window
// is idle, so the first ⌘T or ⌘K does not wait on the network.
const loadPalette = () => import("./components/Palette");
const Palette = lazy(() => loadPalette().then(({ Palette }) => ({ default: Palette })));

export function App() {
  const boot = useBrowser((s) => s.boot);
  const editing = useBrowser((s) => s.editing);
  const open = useBrowser((s) => s.open);
  // Keep the native page covered between navigation dialogs, including while
  // a replacement's lazy chunk is loading inside Suspense.
  // Every flag that gates a Suspense fallback below: the scrim is the dialog
  // as far as the page is concerned, and a dialog whose chunk is still loading
  // was drawn behind the page for exactly as long as the fetch took.
  useCoversContent(
    Boolean(
      open.palette || open.settings || open.library || open.shortcuts || open.extensions ||
      open.defaultBrowser || open.subtitles || open.import || open.apps,
    ),
  );
  const loadPrefs = usePrefs((s) => s.load);
  const railExpanded = usePrefs((s) => s.prefs.rail_expanded);
  const responsive = useChromeLayout();
  const pickerOpen = usePicker((s) => s.open);
  const recordingPhase = useRecording((s) => s.phase);
  const recorderOpen = useRecorder((s) => s.isOpen);
  const toggle = useBrowser((s) => s.toggle);
  useEffect(() => void boot(), [boot]);
  useEffect(() => whenIdle(() => void loadPalette()), []);
  // Watch the release channel: once after startup has settled, then on.
  useEffect(() => { if (!isPrivateWindow()) return startUpdateWatch(); }, []);
  // Subscribe once to the live-subtitles events.
  useEffect(() => void bootSubtitles(), []);
  // And once to "an agent is driving this tab", which marks the tab list.
  useEffect(() => listenForAgentPresence(), []);
  // An agent asking for a phone should put the phone on screen, not just tell
  // the page it is one.
  useEffect(() => listenForEmulation(), []);
  useEffect(() => listenForUpdateProgress(), []);
  // Which tabs are making a sound, so the strip can show and silence them.
  useEffect(() => void useTabAudio.getState().init(), []);
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
  // The page area is named by the tab it shows, the other half of the active
  // tab's aria-controls. Set on the element rather than rendered: following
  // the active tab from here re-rendered the whole chrome on every switch.
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    const name = (id: string | null) => {
      if (id) page.current?.setAttribute("aria-labelledby", `dive-tab-${id}`);
      else page.current?.removeAttribute("aria-labelledby");
    };
    name(useBrowser.getState().activeTab);
    return useBrowser.subscribe((s, prev) => {
      if (s.activeTab !== prev.activeTab) name(s.activeTab);
    });
  }, []);

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

  // macOS keeps its traffic lights in the frame's top-left, so the bar leaves
  // a gutter for them. Windows has none there -- its controls are on the
  // right, and the chrome draws them itself -- so that space would just be a
  // hole at the start of the row.
  const captionGutter = isWindows() ? "pl-2" : "pl-[84px]";

  return (
    <TabDnd>
    <div
      // Two shapes. With the rail listing the tabs there is one bar: the
      // rail is a full-height column with the traffic lights at its top, and
      // the main column has a single row of navigation, address, page
      // actions and the feature cluster. With the rail collapsed the tabs
      // need a row of their own across the top, above the toolbar. Rows and
      // the rail are in rem so the Interface size grows them with their
      // text; in px, text at 200% overflowed a bar that stayed 40px tall.
      // The bar only ever grows, and the traffic lights keep their place at
      // its top-left, so nothing in it is clipped.
      className={`grid h-full bg-ground text-ink ${oneBar ? "grid-rows-[2.75rem_minmax(0,1fr)]" : "grid-rows-[2.5rem_2.75rem_minmax(0,1fr)]"}`}
      // `--chrome-top`: where the chrome ends and a panel hung from it (the
      // main menu) begins, whichever shape the bar is in.
      style={{ gridTemplateColumns: `${railWidth / 16}rem minmax(0,1fr)`, "--chrome-top": oneBar ? "2.875rem" : "5.375rem" } as React.CSSProperties}
    >
      {/* Resize handles for the frameless Windows window; renders nothing
          elsewhere or while maximized. */}
      <WindowResizeEdges top={oneBar ? "2.75rem" : "5.25rem"} />
      {!oneBar && (
        <header aria-label="Title bar" className={`col-span-2 row-start-1 flex items-center gap-2 ${captionGutter}`} data-tauri-drag-region="true" {...windowDrag()}>
          {isPrivateWindow() && <span className="px-2 font-mono text-10 tracking-[0.12em] text-ink-2">DIVE</span>}
          <BuildBadge align="start" />
          <nav aria-label="Tabs" className="h-full min-w-0 flex-1">
            <TabStrip />
          </nav>
          <FeatureBar compact={responsive.collapseRail} />
          <WindowControls />
        </header>
      )}
      <div className={`relative col-start-1 bg-ground ${oneBar ? "row-span-2 row-start-1" : "row-span-2 row-start-2"}`}>
        {/* A full-height rail starts under the traffic lights: that strip is
            the window's handle, and the rail's own content begins below it. */}
        {oneBar && (
          <div className={`flex h-10 items-center gap-1.5 pr-2 ${captionGutter}`} data-tauri-drag-region="true" {...windowDrag()}>
            {/* With the rail wide there is room past the traffic lights for
                the collapse control and the name, on one row, the way every
                sidebar app does it. A narrow rail is all traffic lights up
                here, so it keeps its own control below. */}
            {effectiveRailExpanded && (
              <>
                <span data-tauri-drag-region="false" onMouseDown={(e) => e.stopPropagation()} className="shrink-0">
                  <RailToggle expanded />
                </span>
                <Wordmark />
              </>
            )}
            {!effectiveRailExpanded && isPrivateWindow() && <span className="ml-auto font-mono text-10 tracking-[0.12em] text-ink-2">DIVE</span>}
          </div>
        )}
        <div className={oneBar ? "h-[calc(100%-2.5rem)]" : "h-full"}>
          <Rail forceCollapsed={responsive.collapseRail} toggle={!(oneBar && effectiveRailExpanded)} />
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
        <header aria-label="Title bar" className="col-start-2 row-start-1 flex min-w-0 items-center" data-tauri-drag-region="true" {...windowDrag()}>
          {/* The build badge lives at the foot of an open rail; with the rail
              collapsed there is no room for it there, so it leads this row. */}
          {!effectiveRailExpanded && <span className="pl-2"><BuildBadge align="start" /></span>}
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
          <WindowControls />
        </header>
      ) : (
        <nav aria-label="Browser controls" className="col-start-2 row-start-2 min-w-0">
          <Toolbar compact={responsive.compactToolbar} />
        </nav>
      )}
      <main ref={page} id={PAGE_ID} className={`col-start-2 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] bg-line ${oneBar ? "row-start-2" : "row-start-3"}`}>
        <DockedPage showDock={showDock} onCloseDock={() => toggle("dock", false)}>
          {/* Find hangs over the page rather than taking a row of its own.
              A row pushed the whole page down by 44px on open and back up on
              close, which reflows the document you are searching and moves
              the match out from under the pointer. */}
          {open.find && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-end p-2">
              <div className="pointer-events-auto">
                <FindBar />
              </div>
            </div>
          )}
          <Content />
        </DockedPage>
      </main>
      {/* Over the page, not beside it: the agent is used in bursts, and the
          page it works on should stay the size it was. */}
      {showSidecar && (
        <PanelErrorBoundary label="Agent" fallback={<AgentUnavailable onClose={() => toggle("sidecar", false)} />}>
          <Suspense fallback={null}>
            <AgentDock inset={railWidth} />
          </Suspense>
        </PanelErrorBoundary>
      )}
      <Suspense fallback={(open.palette || open.settings || open.library || open.extensions || open.shortcuts || open.defaultBrowser || open.subtitles || open.import) ? <DialogLoading onClose={() => {
        for (const panel of ["palette", "settings", "library", "shortcuts", "defaultBrowser", "subtitles", "import"] as const) toggle(panel, false);
      }} /> : null}>
        {/* Each in its own boundary: one dialog that throws closes itself
            rather than taking the whole window's controls down. */}
        {open.palette && <IsolatedPanel label="Command palette" modal onClose={() => toggle("palette", false)}><Palette /></IsolatedPanel>}
        {open.settings && <IsolatedPanel label="Settings" modal onClose={() => toggle("settings", false)}><SettingsDialog /></IsolatedPanel>}
        {open.library && <IsolatedPanel label="Library" modal onClose={() => toggle("library", false)}><Library /></IsolatedPanel>}
        {open.shortcuts && <Shortcuts />}
        {open.apps && <AppsDialog />}
        {open.defaultBrowser && <DefaultBrowserDialog />}
        {open.subtitles && <Subtitles />}
        {open.import && <ImportDialog />}
      </Suspense>
      {open.extensions && <IsolatedPanel label="Extensions" modal onClose={() => toggle("extensions", false)}><Suspense fallback={<DialogLoading onClose={() => toggle("extensions", false)} />}><Extensions /></Suspense></IsolatedPanel>}
      <Splash />
      <Suspense fallback={(editing || recorderOpen || recordingPhase === "setup" || recordingPhase === "done") ? <DialogLoading onClose={() => {
        useBrowser.getState().setEditing(null);
        useRecorder.getState().setOpen(false);
        if (recordingPhase === "setup") useRecording.getState().closeSetup();
        if (recordingPhase === "done") useRecording.getState().dismiss();
      }} /> : null}>
        {editing && <WorkspaceDialog key={editing.id ?? "new"} />}
        <ProfileDialog />
        {recorderOpen && <RecorderModal />}
        {recordingPhase === "setup" && <RecordDialog />}
        {recordingPhase === "done" && <RecordingDoneDialog />}
      </Suspense>
      <LiveRegions />
      {!isPrivateWindow() && <AgentAnnouncer />}
      <BrowserToasts />
      <UpdateDialog />
      <SessionRecoveryCard />
      <TaskManager />
      <Suspense fallback={null}>
        <Onboarding />
      </Suspense>
    </div>
    </TabDnd>
  );
}

/**
 * The page and, when open, the developer dock under it. The dock is capped by
 * the window's height, so this frame follows the window size rather than the
 * whole chrome re-rendering on every frame of a resize; the page passed in is
 * the same element each time and does not re-render with it.
 */
function DockedPage({ showDock, onCloseDock, children }: { showDock: boolean; onCloseDock: () => void; children: ReactNode }) {
  const dockHeight = useLayout((s) => s.dockHeight);
  const setDockHeight = useLayout((s) => s.setDockHeight);
  // The size under the pointer mid-drag; the store gets it on release.
  const [live, setLive] = useState<number | null>(null);
  // Followed only while the dock shows: nothing else here depends on it.
  const viewport = useViewportSize(showDock);
  // The remembered dock height is kept as a preference; what shows is capped
  // by the window, so a short window still has page to look at.
  const dockLimits = dockLimitsFor(viewport.height);
  const shownDockHeight = clampSize(live ?? dockHeight, dockLimits);
  return (
    <div
      className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] bg-line"
      style={{ gridTemplateRows: `minmax(0,1fr)${showDock ? ` auto ${shownDockHeight}px` : ""}` }}
    >
      {children}
      {showDock && (
        <ResizeHandle
          orientation="horizontal"
          label="Resize dock"
          value={shownDockHeight}
          limits={dockLimits}
          onResize={setLive}
          onCommit={(px) => {
            setLive(null);
            setDockHeight(px);
          }}
        />
      )}
      {showDock && <IsolatedPanel label="Developer dock" onClose={onCloseDock}><Suspense fallback={<PanelSkeleton label="developer dock" horizontal />}><Dock /></Suspense></IsolatedPanel>}
    </div>
  );
}

/** The notice and error toasts, subscribed here so a toast re-renders itself and not the whole chrome. */
function BrowserToasts() {
  const error = useBrowser((s) => s.error);
  const notice = useBrowser((s) => s.notice);
  const noticeAction = useBrowser((s) => s.noticeAction);
  return (
    <ToastViewport
      notice={notice}
      noticeAction={noticeAction}
      error={error}
      onDismissNotice={() => useBrowser.setState({ notice: null, noticeAction: null })}
      onDismissError={() => useBrowser.setState({ error: null })}
    />
  );
}

/**
 * The agent's composer failed. It floats where the composer does, over the
 * page, so it says so there and can be closed; the rest of the window keeps
 * working.
 */
function AgentUnavailable({ onClose }: { onClose: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[45] flex justify-center px-4 pb-4">
      <div data-native-overlay role="alert" className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-line-2 bg-surface p-4 text-sm text-ink-2 shadow-2xl">
        <p>Agent is unavailable. You can keep browsing.</p>
        <button type="button" onClick={onClose} aria-label="Close Agent" className="min-h-9 rounded-lg border border-line-2 px-3 text-sm text-ink hover:bg-surface-3">
          Close
        </button>
      </div>
    </div>
  );
}

/** Run `task` once the window has nothing more pressing to do; returns the cancel. */
function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(task, { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 2000);
  return () => clearTimeout(id);
}
