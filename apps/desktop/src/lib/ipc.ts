/**
 * Thin façade over the generated tauri-specta bindings so components never
 * import the generated file directly. Regenerate with `cargo test -p dive-desktop`.
 */
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { EventCallback } from "@tauri-apps/api/event";
import type { ChatDelta, SendOptions } from "../generated/bindings";
import type { ExtensionInfo, ExtensionList } from "../generated/bindings";
import { commands, events as generatedEvents } from "../generated/bindings";
import type { ClearRequest, Decision, Duration, Scope, ExportRequest, NetworkProfile, PaneBounds, Prefs, RecordOptions, Rule, TabTier } from "../generated/bindings";

/** Shape tauri-specta returns for fallible commands. */
type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

/** Menu commands address one chrome. Tauri global listeners receive even
 * emit_to events; using one here makes popouts echo main-window commands. */
export const events = {
  ...generatedEvents,
  menuCommand: {
    listen: (callback: EventCallback<string>) => generatedEvents.menuCommand(getCurrentWebview()).listen(callback),
    once: (callback: EventCallback<string>) => generatedEvents.menuCommand(getCurrentWebview()).once(callback),
  },
};
export type { NavigationEntry, NavigationHistory, Credential, CredentialPrompt, CsvImportSummary, FormEntry, JsDialogAsked, JsDialogClosed } from "../generated/bindings";
export type { ExtensionInfo, ExtensionList };
export type { WebApp, WebAppProbe } from "../generated/bindings";
export type { QuickLink, Prefs, ClearRequest, Rule, RuleAction, PrivacyCategory, PrivacyEvent, PrivacyInfo, NetworkProfile, Snapshot, Tab, Workspace, Command, CoreEvent, Bounds, WorkspaceDraft, ConsoleEntry, Level, NetworkEvent, Device, MediaOverrides, ChatDelta, ChatTurn, StorageSnapshot, Cookie, MetaSnapshot, A11yReport, Violation, FindResult, DownloadNotice, AppInfo, Vitals, Original, DevServer, DevServersChanged, ShareInfo, ReplayRequest, ReplayResponse, RequestDetail, RecordedStep, RecorderEvent, HistoryEntry, Bookmark, Pick, StyleChange_Serialize as StyleChange, InspectorSnapshot_Serialize as InspectorSnapshot, InspectEvent, TabCrashed, TabLoad, LoadPhase, PaneBounds, TabWindowChanged, RecordOptions, RecordingResult, RecordingCapabilities, RecordingEvent, Microphone, MediaInfo, ExportRequest, KeptSegment, RecordingInfo, ProviderInfo, Provider, ModelInfo, Usage, KeyCheck, SendOptions, SitePermission, PermissionList, Scope, Duration, PermissionDismissed, Decision, UpdateInfo, PermissionAsked, TabTier, DefaultBrowserStatus, Profile, ProfileId, ProfileDraft, SubtitleModel, SubtitleModelProgress, SubtitleCue, SubtitleState, ImportSource, ImportSummary } from "../generated/bindings";

/** Unwrap a specta `Result`, throwing the app error message on failure. */
export function unwrap<T, E extends { message: string }>(r: Result<T, E>): T {
  if (r.status === "ok") return r.data;
  throw new Error(r.error.message);
}

type WorkspaceDraftInput = { name: string; color: string; icon: string };
export type ProfileDraftInput = { name: string; color: string; avatar: string; note: string };
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
  setOverlayRegions: async (regions: { x: number; y: number; width: number; height: number }[], active: boolean) => unwrap(await commands.layoutSetOverlayRegions(regions, active)),
  keepSitesList: async (profile: string) => unwrap(await commands.keepSitesList(profile)),
  keepSiteSet: async (profile: string, url: string, keep: boolean) => unwrap(await commands.keepSiteSet(profile, url, keep)),
  snapshot: async () => unwrap(await commands.snapshot()),
  tabInfo: async (id: string) => unwrap(await commands.tabInfo(id)),
  windowOpen: async () => unwrap(await commands.windowOpen()),
  windowExitPrivate: async () => unwrap(await commands.windowExitPrivate()),
  windowClose: async () => unwrap(await commands.windowClose()),
  windowPrivate: async () => unwrap(await commands.windowPrivate()),
  popoutReady: async (id: string) => unwrap(await commands.popoutReady(id)),
  // Installed web apps.
  webappProbe: async (id: string) => unwrap(await commands.webappProbe(id)),
  webappInstall: async (id: string) => unwrap(await commands.webappInstall(id)),
  webappsList: async () => unwrap(await commands.webappsList()),
  webappOpen: async (appId: string) => unwrap(await commands.webappOpen(appId)),
  webappUninstall: async (appId: string) => unwrap(await commands.webappUninstall(appId)),
  webappForTab: async (id: string) => unwrap(await commands.webappForTab(id)),
  webappForWindow: async (appId: string) => unwrap(await commands.webappForWindow(appId)),
  webappIcon: async (appId: string) => unwrap(await commands.webappIcon(appId)),
  windowCommand: async (command: "tab.new" | "window.new") => unwrap(await commands.windowCommand(command)),
  workspaceActivate: async (id: string) => unwrap(await commands.workspaceActivate(id)),
  profilesList: async () => unwrap(await commands.profilesList()),
  profileCreate: async (draft: ProfileDraftInput) => unwrap(await commands.profileCreate(draft)),
  profileUpdate: async (id: string, draft: ProfileDraftInput) => unwrap(await commands.profileUpdate(id, draft)),
  profileActivate: async (id: string) => unwrap(await commands.profileActivate(id)),
  profileDelete: async (id: string) => unwrap(await commands.profileDelete(id)),
  workspaceCreate: async (draft: WorkspaceDraftInput, separateContainer: boolean) =>
    unwrap(await commands.workspaceCreate(draft, separateContainer)),
  workspaceUpdate: async (id: string, draft: WorkspaceDraftInput) => unwrap(await commands.workspaceUpdate(id, draft)),
  workspaceDelete: async (id: string) => unwrap(await commands.workspaceDelete(id)),
  workspaceReorder: async (ordered: string[]) => unwrap(await commands.workspaceReorder(ordered)),
  workspaceTabCounts: async () => unwrap(await commands.workspaceTabCounts()),
  tabOpen: async (workspaceId: string, url: string) => unwrap(await commands.tabOpen(workspaceId, url)),
  tabClose: async (id: string) => unwrap(await commands.tabClose(id)),
  tabScrollPosition: async (id: string) => unwrap(await commands.tabScrollPosition(id)),
  tabRestoreScroll: async (id: string, x: number, y: number) => unwrap(await commands.tabRestoreScroll(id, x, y)),
  tabActivate: async (id: string) => unwrap(await commands.tabActivate(id)),
  tabDeactivate: async () => unwrap(await commands.tabDeactivate()),
  uiStateLoad: async () => unwrap(await commands.uiStateLoad()),
  uiStateSet: async (key: string, value: string | null) => unwrap(await commands.uiStateSet(key, value)),
  tabNavigate: async (id: string, url: string) => unwrap(await commands.tabNavigate(id, url)),
  tabReorder: async (workspaceId: string, ordered: string[]) => unwrap(await commands.tabReorder(workspaceId, ordered)),
  tabSetPinned: async (id: string, pinned: boolean) => unwrap(await commands.tabSetPinned(id, pinned)),
  tabBack: async (id: string) => unwrap(await commands.tabBack(id)),
  tabForward: async (id: string) => unwrap(await commands.tabForward(id)),
  tabHistory: async (id: string) => unwrap(await commands.tabHistory(id)),
  tabHistoryNavigate: async (id: string, generation: string, entryId: number) => unwrap(await commands.tabHistoryNavigate(id, generation, entryId)),
  tabReload: async (id: string) => unwrap(await commands.tabReload(id)),
  tabStop: async (id: string) => unwrap(await commands.tabStop(id)),
  tabPrint: async (id: string) => unwrap(await commands.tabPrint(id)),
  tabFillVideo: async (id: string) => unwrap(await commands.tabFillVideo(id)),
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
  recordingsList: async () => unwrap(await commands.recordingsList()),
  screenMediaInfo: async (source: string) => unwrap(await commands.screenMediaInfo(source)),
  /** Pick a video file and copy it into the captures directory with a playable companion; null when dismissed. */
  screenImportVideo: async () => unwrap(await commands.screenImportVideo()),
  screenImportPath: async (path: string) => unwrap(await commands.screenImportPath(path)),
  screenProjectRead: async (source: string) => unwrap(await commands.screenProjectRead(source)),
  screenProjectWrite: async (source: string, json: string) => unwrap(await commands.screenProjectWrite(source, json)),
  fileSize: async (path: string) => unwrap(await commands.fileSize(path)),
  fileReadChunk: async (path: string, offset: number, len: number) => unwrap(await commands.fileReadChunk(path, offset, len)),
  screenExportBegin: async () => unwrap(await commands.screenExportBegin()),
  screenExportAppend: async (jobId: string, offset: number, base64: string) => unwrap(await commands.screenExportAppend(jobId, offset, base64)),
  screenExportCancel: async (jobId: string) => unwrap(await commands.screenExportCancel(jobId)),
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
  tabA11yReveal: async (id: string, selector: string) => unwrap(await commands.tabA11yReveal(id, selector)),
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
  setContentCornerRadius: async (radius: number) => unwrap(await commands.layoutSetCornerRadius(radius)),
  setWindowBackground: async (hex: string) => unwrap(await commands.windowSetBackground(hex)),
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
  pagesScheme: async (scheme: "dark" | "light") => unwrap(await commands.pagesScheme(scheme)),
  clipboardWriteText: async (text: string) => unwrap(await commands.clipboardWriteText(text)),
  browsingDataClear: async (what: ClearRequest) => unwrap(await commands.browsingDataClear(what)),
  downloadsReveal: async (path: string | null) => unwrap(await commands.downloadsReveal(path)),
  downloadsOpen: async (path: string) => unwrap(await commands.downloadsOpen(path)),
  tabFocus: async (id: string) => unwrap(await commands.tabFocus(id)),
  mcpToken: async () => unwrap(await commands.mcpToken()),
  tabStorageDelete: async (id: string, section: "cookies" | "local" | "session", key: string, domain: string | null, path: string | null) =>
    unwrap(await commands.tabStorageDelete(id, section, key, domain, path)),
  tabRecordStart: async (id: string) => unwrap(await commands.tabRecordStart(id)),
  tabRecordStop: (id: string) => commands.tabRecordStop(id),
  tabOpenapi: async (id: string) => unwrap(await commands.tabOpenapi(id)),
  tabHar: async (id: string) => unwrap(await commands.tabHar(id)),
  rulesList: (workspace: string) => commands.rulesList(workspace),
  rulesSet: async (workspace: string, rules: Rule[]) => unwrap(await commands.rulesSet(workspace, rules)),
  tabBugReport: async (id: string) => unwrap(await commands.tabBugReport(id)),
  requestCaptured: async (tabId: string, requestId: string) => unwrap(await commands.requestCaptured(tabId, requestId)),
  requestDetail: async (tabId: string, requestId: string) => unwrap(await commands.requestDetail(tabId, requestId)),
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
  bookmarkRename: async (url: string, title: string) => unwrap(await commands.bookmarkRename(url, title)),
  bookmarksSearch: async (query: string, limit = 20) => unwrap(await commands.bookmarksSearch(query, limit)),
  passwordsList: async () => unwrap(await commands.passwordsList()),
  passwordsForUrl: async (url: string) => unwrap(await commands.passwordsForUrl(url)),
  passwordsSave: async (url: string, username: string, password: string) => unwrap(await commands.passwordsSave(url, username, password)),
  passwordsReveal: async (id: string) => unwrap(await commands.passwordsReveal(id)),
  passwordsDelete: async (id: string) => unwrap(await commands.passwordsDelete(id)),
  passwordsUsed: async (id: string) => unwrap(await commands.passwordsUsed(id)),
  passwordsAnswer: async (token: string, save: boolean) => unwrap(await commands.passwordsAnswer(token, save)),
  passwordsFill: async (tabId: string, id: string) => unwrap(await commands.passwordsFill(tabId, id)),
  passwordsNever: async (token: string) => unwrap(await commands.passwordsNever(token)),
  passwordsNeverList: async () => unwrap(await commands.passwordsNeverList()),
  passwordsNeverRemove: async (origin: string) => unwrap(await commands.passwordsNeverRemove(origin)),
  passwordsPickCsv: async () => commands.passwordsPickCsv(),
  passwordsImportCsv: async (path: string) => unwrap(await commands.passwordsImportCsv(path)),
  permissionSet: async (scope: Scope, origin: string, kind: string, decision: Decision) => unwrap(await commands.permissionSet(scope, origin, kind, decision)),
  permissionReply: async (tabId: string, requestId: string, decision: Decision, duration: Duration) => unwrap(await commands.permissionReply(tabId, requestId, decision, duration)),
  jsDialogAnswer: async (tabId: string, dialogId: string, accept: boolean, text: string | null) => unwrap(await commands.jsDialogAnswer(tabId, dialogId, accept, text)),
  permissionsList: async () => unwrap(await commands.permissionsList()),
  extensionsList: async () => unwrap(await commands.extensionsList()),
  extensionPick: () => commands.extensionPick(),
  extensionImport: async (path: string) => unwrap(await commands.extensionImport(path)),
  extensionSetEnabled: async (id: string, enabled: boolean) => unwrap(await commands.extensionSetEnabled(id, enabled)),
  extensionRemove: async (id: string) => unwrap(await commands.extensionRemove(id)),
  appRestart: () => commands.appRestart(),
  /** The update the release channel offers, or null when current or when this build has no updater. */
  updateCheck: async () => unwrap(await commands.updateCheck()),
  defaultBrowserStatus: () => commands.defaultBrowserStatus(),
  defaultBrowserSet: async () => unwrap(await commands.defaultBrowserSet()),
  browserImportSources: async () => unwrap(await commands.browserImportSources()),
  browserImportRun: async (id: string, bookmarks: boolean, history: boolean, passwords = false, forms = false) => unwrap(await commands.browserImportRun(id, { bookmarks, history, passwords, forms })),
  formsList: async () => unwrap(await commands.formsList()),
  formsDelete: async (id: string) => unwrap(await commands.formsDelete(id)),
  formsClear: async () => unwrap(await commands.formsClear()),
  browserImportOpenPrivacy: async () => unwrap(await commands.browserImportOpenPrivacy()),
  updateInstall: async () => unwrap(await commands.updateInstall()),
  historySearch: async (query: string, limit = 20) => unwrap(await commands.historySearch(query, limit)),
  historyRemove: async (url: string) => unwrap(await commands.historyRemove(url)),
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
  /** The local subtitle models and whether each is downloaded. */
  subtitleModels: () => commands.subtitleModels(),
  /** Start downloading a model; progress arrives on `events.subtitleModelProgress`. */
  subtitleModelDownload: async (id: string) => unwrap(await commands.subtitleModelDownload(id)),
  /** Start live subtitles on a tab. `language` is an ISO code or "auto"; `translate` renders English. */
  subtitleStart: async (id: string, model: string, language: string, translate: boolean) =>
    unwrap(await commands.subtitleStart(id, model, language, translate)),
  subtitleStop: (id: string) => commands.subtitleStop(id),
  subtitleRunning: (id: string) => commands.subtitleRunning(id),
  commandRun: async (id: string, args: unknown = null): Promise<unknown> =>
    JSON.parse(unwrap(await commands.commandRun(id, args === null ? null : JSON.stringify(args)))),
};
