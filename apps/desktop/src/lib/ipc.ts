/**
 * Thin façade over the generated tauri-specta bindings so components never
 * import the generated file directly. Regenerate with `cargo test -p dive-desktop`.
 */
import { Channel } from "@tauri-apps/api/core";
import type { ChatDelta, SendOptions } from "../generated/bindings";
import { commands, events } from "../generated/bindings";
import type { ClearRequest, Decision, ExportRequest, NetworkProfile, PaneBounds, Prefs, RecordOptions, Rule, TabTier } from "../generated/bindings";

/** Shape tauri-specta returns for fallible commands. */
type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export { events };
export type { Prefs, ClearRequest, Rule, RuleAction, PrivacyCategory, PrivacyEvent, PrivacyInfo, NetworkProfile, Snapshot, Tab, Workspace, Command, CoreEvent, Bounds, WorkspaceDraft, ConsoleEntry, Level, NetworkEvent, Device, MediaOverrides, ChatDelta, ChatTurn, StorageSnapshot, Cookie, MetaSnapshot, A11yReport, Violation, FindResult, DownloadNotice, AppInfo, Vitals, Original, DevServer, DevServersChanged, ShareInfo, ReplayRequest, ReplayResponse, RecordedStep, RecorderEvent, HistoryEntry, Bookmark, Pick, StyleChange_Serialize as StyleChange, InspectorSnapshot_Serialize as InspectorSnapshot, InspectEvent, TabCrashed, TabLoad, LoadPhase, PaneBounds, TabWindowChanged, RecordOptions, RecordingResult, RecordingCapabilities, RecordingEvent, Microphone, MediaInfo, ExportRequest, KeptSegment, ProviderInfo, Provider, ModelInfo, Usage, KeyCheck, SendOptions, SitePermission, Decision, UpdateInfo, PermissionAsked, TabTier } from "../generated/bindings";

/** Unwrap a specta `Result`, throwing the app error message on failure. */
export function unwrap<T, E extends { message: string }>(r: Result<T, E>): T {
  if (r.status === "ok") return r.data;
  throw new Error(r.error.message);
}

type WorkspaceDraftInput = { name: string; color: string; icon: string };
export type ReplayRequestInput = { method: string; url: string; headers: Record<string, string>; body: string | null; with_cookies: boolean; captured_host: string };
type ChatTurnInput = { role: string; content: string };
export type ChatDeltaOut = ChatDelta;
export type InsetsInput = { top: number; bottom: number; left: number; right: number };
export type DeviceInput = {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  user_agent: string;
  platform: string;
  /** Draw the viewport at this fraction of its size; `innerWidth` is unaffected. */
  scale: number | null;
  /** What `env(safe-area-inset-*)` reports. */
  safe_area: InsetsInput | null;
};
export type MediaInput = { color_scheme: string | null; reduced_motion: string | null; media_type: string | null; display_mode: string | null };
export type GeolocationInput = { latitude: number; longitude: number; accuracy: number };
export type EnvironmentInput = { geolocation: GeolocationInput | null; timezone: string | null; locale: string | null };

export const ipc = {
  snapshot: async () => unwrap(await commands.snapshot()),
  workspaceActivate: async (id: string) => unwrap(await commands.workspaceActivate(id)),
  workspaceCreate: async (draft: WorkspaceDraftInput, separateContainer: boolean) =>
    unwrap(await commands.workspaceCreate(draft, separateContainer)),
  workspaceUpdate: async (id: string, draft: WorkspaceDraftInput) => unwrap(await commands.workspaceUpdate(id, draft)),
  workspaceDelete: async (id: string) => unwrap(await commands.workspaceDelete(id)),
  workspaceReorder: async (ordered: string[]) => unwrap(await commands.workspaceReorder(ordered)),
  workspaceTabCounts: async () => unwrap(await commands.workspaceTabCounts()),
  tabOpen: async (workspaceId: string, url: string) => unwrap(await commands.tabOpen(workspaceId, url)),
  tabClose: async (id: string) => unwrap(await commands.tabClose(id)),
  tabActivate: async (id: string) => unwrap(await commands.tabActivate(id)),
  tabNavigate: async (id: string, url: string) => unwrap(await commands.tabNavigate(id, url)),
  tabReorder: async (workspaceId: string, ordered: string[]) => unwrap(await commands.tabReorder(workspaceId, ordered)),
  tabSetPinned: async (id: string, pinned: boolean) => unwrap(await commands.tabSetPinned(id, pinned)),
  tabBack: async (id: string) => unwrap(await commands.tabBack(id)),
  tabForward: async (id: string) => unwrap(await commands.tabForward(id)),
  tabReload: async (id: string) => unwrap(await commands.tabReload(id)),
  tabStop: async (id: string) => unwrap(await commands.tabStop(id)),
  tabPrint: async (id: string) => unwrap(await commands.tabPrint(id)),
  tabSetTier: async (id: string, tier: TabTier) => unwrap(await commands.tabSetTier(id, tier)),
  tabZoom: async (id: string, factor: number) => unwrap(await commands.tabZoom(id, factor)),
  tabDevtools: async (id: string) => unwrap(await commands.tabDevtools(id)),
  tabScreencastStart: async (id: string, options: RecordOptions) => unwrap(await commands.tabScreencastStart(id, options)),
  tabScreencastPause: async (id: string, paused: boolean) => unwrap(await commands.tabScreencastPause(id, paused)),
  tabScreencastStop: async (id: string) => unwrap(await commands.tabScreencastStop(id)),
  tabScreencastCancel: async (id: string) => unwrap(await commands.tabScreencastCancel(id)),
  recordingCapabilities: async () => unwrap(await commands.recordingCapabilities()),
  recordingRead: async (path: string) => unwrap(await commands.recordingRead(path)),
  recordingOpen: async (path: string) => unwrap(await commands.recordingOpen(path)),
  recordingDelete: async (path: string) => unwrap(await commands.recordingDelete(path)),
  screenMediaInfo: async (source: string) => unwrap(await commands.screenMediaInfo(source)),
  screenProjectRead: async (source: string) => unwrap(await commands.screenProjectRead(source)),
  screenProjectWrite: async (source: string, json: string) => unwrap(await commands.screenProjectWrite(source, json)),
  fileSize: async (path: string) => unwrap(await commands.fileSize(path)),
  fileReadChunk: async (path: string, offset: number, len: number) => unwrap(await commands.fileReadChunk(path, offset, len)),
  screenExportBegin: async () => unwrap(await commands.screenExportBegin()),
  screenExportAppend: async (path: string, base64: string) => unwrap(await commands.screenExportAppend(path, base64)),
  screenExportFinish: async (request: ExportRequest) => unwrap(await commands.screenExportFinish(request)),
  tabCapture: async (id: string, fullPage: boolean) => unwrap(await commands.tabCapture(id, fullPage)),
  captureRead: async (path: string) => unwrap(await commands.captureRead(path)),
  captureSave: async (pngBase64: string) => unwrap(await commands.captureSave(pngBase64)),
  tabStorage: async (id: string) => unwrap(await commands.tabStorage(id)),
  tabMeta: async (id: string) => unwrap(await commands.tabMeta(id)),
  resolveFrame: async (tabId: string, url: string, line: number, column: number | null) => unwrap(await commands.resolveFrame(tabId, url, line, column)),
  tabVitals: async (id: string) => unwrap(await commands.tabVitals(id)),
  tabFind: async (id: string, query: string, index: number) => unwrap(await commands.tabFind(id, query, index)),
  tabA11y: async (id: string, axeSource: string) => unwrap(await commands.tabA11y(id, axeSource)),
  /** `reload` only when the user agent changed; rotating or zooming keeps the page's state. */
  tabEmulate: async (id: string, device: DeviceInput | null, reload: boolean) => unwrap(await commands.tabEmulate(id, device, reload)),
  tabEnvironment: async (id: string, environment: EnvironmentInput) => unwrap(await commands.tabEnvironment(id, environment)),
  devicePresets: () => commands.devicePresets(),
  tabMedia: async (id: string, media: MediaInput) => unwrap(await commands.tabMedia(id, media)),
  tabThrottle: async (id: string, profile: NetworkProfile | null) => unwrap(await commands.tabThrottle(id, profile)),
  setContentBounds: async (b: { x: number; y: number; width: number; height: number }) =>
    unwrap(await commands.layoutSetContentBounds(b)),
  prepareContentCover: async () => unwrap(await commands.layoutPrepareContentCover()),
  setContentCovered: async (covered: boolean) => unwrap(await commands.layoutSetContentCovered(covered)),
  /** Show these tabs side by side; an empty list returns to a single page. */
  setPanes: async (panes: PaneBounds[]) => unwrap(await commands.layoutSetPanes(panes)),
  /** Tear a tab off into its own window, placed under `at` (window-relative logical px) when given. */
  tabDetach: async (id: string, at: { x: number; y: number } | null) => unwrap(await commands.tabDetach(id, at ? [at.x, at.y] : null)),
  tabAttach: async (id: string) => unwrap(await commands.tabAttach(id)),
  popoutSetBounds: async (id: string, b: { x: number; y: number; width: number; height: number }) => unwrap(await commands.popoutSetBounds(id, b)),
  commandsList: () => commands.commandsList(),
  appInfo: () => commands.appInfo(),
  privacyInfo: () => commands.privacyInfo(),
  prefsGet: () => commands.prefsGet(),
  prefsSet: async (prefs: Prefs) => unwrap(await commands.prefsSet(prefs)),
  browsingDataClear: async (what: ClearRequest) => unwrap(await commands.browsingDataClear(what)),
  downloadsReveal: async (path: string | null) => unwrap(await commands.downloadsReveal(path)),
  tabRecordStart: async (id: string) => unwrap(await commands.tabRecordStart(id)),
  tabRecordStop: (id: string) => commands.tabRecordStop(id),
  tabOpenapi: async (id: string) => unwrap(await commands.tabOpenapi(id)),
  tabHar: async (id: string) => unwrap(await commands.tabHar(id)),
  rulesList: (workspace: string) => commands.rulesList(workspace),
  rulesSet: async (workspace: string, rules: Rule[]) => unwrap(await commands.rulesSet(workspace, rules)),
  tabBugReport: async (id: string) => unwrap(await commands.tabBugReport(id)),
  requestCaptured: async (tabId: string, requestId: string) => unwrap(await commands.requestCaptured(tabId, requestId)),
  requestReplay: async (tabId: string, request: ReplayRequestInput) => unwrap(await commands.requestReplay(tabId, request)),
  devServers: async () => unwrap(await commands.devServers()),
  devServersWatch: async (on: boolean) => unwrap(await commands.devServersWatch(on)),
  tabInspectStart: async (id: string) => unwrap(await commands.tabInspectStart(id)),
  tabInspectCancel: async (id: string) => unwrap(await commands.tabInspectCancel(id)),
  tabInspectState: (id: string) => commands.tabInspectState(id),
  tabInspectStyle: async (id: string, property: string, value: string) =>
    unwrap(await commands.tabInspectStyle(id, property, value)),
  tabInspectRevert: async (id: string) => unwrap(await commands.tabInspectRevert(id)),
  bookmarkToggle: async (id: string) => unwrap(await commands.bookmarkToggle(id)),
  bookmarkStatus: async (url: string) => unwrap(await commands.bookmarkStatus(url)),
  bookmarkRemove: async (url: string) => unwrap(await commands.bookmarkRemove(url)),
  bookmarksSearch: async (query: string, limit = 20) => unwrap(await commands.bookmarksSearch(query, limit)),
  permissionSet: async (origin: string, kind: string, decision: Decision) => unwrap(await commands.permissionSet(origin, kind, decision)),
  permissionsList: async () => unwrap(await commands.permissionsList()),
  /** The update the release channel offers, or null when current or when this build has no updater. */
  updateCheck: async () => unwrap(await commands.updateCheck()),
  updateInstall: async () => unwrap(await commands.updateInstall()),
  historySearch: async (query: string, limit = 20) => unwrap(await commands.historySearch(query, limit)),
  shareUrl: async (url: string) => unwrap(await commands.shareUrl(url)),
  agentProviders: () => commands.agentProviders(),
  agentKeys: () => commands.agentKeys(),
  agentKeySet: async (provider: string, key: string) => unwrap(await commands.agentKeySet(provider, key)),
  agentKeyPresent: async (provider: string) => unwrap(await commands.agentKeyPresent(provider)),
  agentKeyVerify: async (provider: string, key: string | null) => unwrap(await commands.agentKeyVerify(provider, key)),
  agentModels: async (provider: string, refresh = false) => unwrap(await commands.agentModels(provider, refresh)),
  agentApprove: async (id: string, allow: boolean) => unwrap(await commands.agentApprove(id, allow)),
  agentStop: async (runId: string) => unwrap(await commands.agentStop(runId)),
  /** Stream a reply; `onDelta` fires for each piece. Resolves when the stream ends. */
  agentSend: async (runId: string, turns: ChatTurnInput[], tabId: string | null, options: SendOptions, onDelta: (d: ChatDeltaOut) => void) => {
    const channel = new Channel<ChatDeltaOut>();
    channel.onmessage = onDelta;
    unwrap(await commands.agentSend(runId, turns, tabId, options, channel));
  },
  commandRun: async (id: string, args: unknown = null): Promise<unknown> =>
    JSON.parse(unwrap(await commands.commandRun(id, args === null ? null : JSON.stringify(args)))),
};
