/**
 * Thin façade over the generated tauri-specta bindings so components never
 * import the generated file directly. Regenerate with `cargo test -p dive-desktop`.
 */
import { Channel } from "@tauri-apps/api/core";
import { commands, events } from "../generated/bindings";

/** Shape tauri-specta returns for fallible commands. */
type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export { events };
export type { Snapshot, Tab, Workspace, Command, CoreEvent, Bounds, WorkspaceDraft, ConsoleEntry, Level, NetworkEvent, Device, MediaOverrides, ChatDelta, ChatTurn, StorageSnapshot, Cookie, MetaSnapshot, A11yReport, Violation, FindResult, DownloadNotice, AppInfo, Vitals, Original, DevServer, ShareInfo, ReplayRequest, ReplayResponse, RecordedStep, RecorderEvent, HistoryEntry, Bookmark } from "../generated/bindings";

/** Unwrap a specta `Result`, throwing the app error message on failure. */
export function unwrap<T, E extends { message: string }>(r: Result<T, E>): T {
  if (r.status === "ok") return r.data;
  throw new Error(r.error.message);
}

type WorkspaceDraftInput = { name: string; color: string };
export type ReplayRequestInput = { method: string; url: string; headers: Record<string, string>; body: string | null; with_cookies: boolean; captured_host: string };
type ChatTurnInput = { role: string; content: string };
export type ChatDeltaOut =
  | { type: "text"; data: string }
  | { type: "tool_call"; data: { id: string; name: string; input: string; action: boolean; locator: string | null } }
  | { type: "needs_approval"; data: { id: string; name: string; input: string; action: boolean; locator: string | null } }
  | { type: "tool_done"; data: { id: string; summary: string; error: boolean } }
  | { type: "done"; data: string }
  | { type: "error"; data: string };
export type DeviceInput = { width: number; height: number; dpr: number; mobile: boolean; touch: boolean; user_agent: string; platform: string };
export type MediaInput = { color_scheme: string | null; reduced_motion: string | null; media_type: string | null };

export const ipc = {
  snapshot: async () => unwrap(await commands.snapshot()),
  workspaceActivate: async (id: string) => unwrap(await commands.workspaceActivate(id)),
  workspaceCreate: async (draft: WorkspaceDraftInput, separateContainer: boolean) =>
    unwrap(await commands.workspaceCreate(draft, separateContainer)),
  workspaceUpdate: async (id: string, draft: WorkspaceDraftInput) => unwrap(await commands.workspaceUpdate(id, draft)),
  workspaceDelete: async (id: string) => unwrap(await commands.workspaceDelete(id)),
  tabOpen: async (workspaceId: string, url: string) => unwrap(await commands.tabOpen(workspaceId, url)),
  tabClose: async (id: string) => unwrap(await commands.tabClose(id)),
  tabActivate: async (id: string) => unwrap(await commands.tabActivate(id)),
  tabNavigate: async (id: string, url: string) => unwrap(await commands.tabNavigate(id, url)),
  tabReorder: async (workspaceId: string, ordered: string[]) => unwrap(await commands.tabReorder(workspaceId, ordered)),
  tabSetPinned: async (id: string, pinned: boolean) => unwrap(await commands.tabSetPinned(id, pinned)),
  tabBack: async (id: string) => unwrap(await commands.tabBack(id)),
  tabForward: async (id: string) => unwrap(await commands.tabForward(id)),
  tabReload: async (id: string) => unwrap(await commands.tabReload(id)),
  tabCapture: async (id: string, fullPage: boolean) => unwrap(await commands.tabCapture(id, fullPage)),
  tabStorage: async (id: string) => unwrap(await commands.tabStorage(id)),
  tabMeta: async (id: string) => unwrap(await commands.tabMeta(id)),
  resolveFrame: async (tabId: string, url: string, line: number, column: number | null) => unwrap(await commands.resolveFrame(tabId, url, line, column)),
  tabVitals: async (id: string) => unwrap(await commands.tabVitals(id)),
  tabFind: async (id: string, query: string, index: number) => unwrap(await commands.tabFind(id, query, index)),
  tabA11y: async (id: string, axeSource: string) => unwrap(await commands.tabA11y(id, axeSource)),
  tabEmulate: async (id: string, device: DeviceInput | null) => unwrap(await commands.tabEmulate(id, device)),
  tabMedia: async (id: string, media: MediaInput) => unwrap(await commands.tabMedia(id, media)),
  setContentBounds: async (b: { x: number; y: number; width: number; height: number }) =>
    unwrap(await commands.layoutSetContentBounds(b)),
  commandsList: () => commands.commandsList(),
  appInfo: () => commands.appInfo(),
  tabRecordStart: async (id: string) => unwrap(await commands.tabRecordStart(id)),
  tabRecordStop: (id: string) => commands.tabRecordStop(id),
  tabOpenapi: async (id: string) => unwrap(await commands.tabOpenapi(id)),
  requestCaptured: async (tabId: string, requestId: string) => unwrap(await commands.requestCaptured(tabId, requestId)),
  requestReplay: async (tabId: string, request: ReplayRequestInput) => unwrap(await commands.requestReplay(tabId, request)),
  devServers: () => commands.devServers(),
  bookmarkToggle: async (id: string) => unwrap(await commands.bookmarkToggle(id)),
  bookmarkStatus: async (url: string) => unwrap(await commands.bookmarkStatus(url)),
  bookmarksSearch: async (query: string, limit = 20) => unwrap(await commands.bookmarksSearch(query, limit)),
  historySearch: async (query: string, limit = 20) => unwrap(await commands.historySearch(query, limit)),
  shareUrl: async (url: string) => unwrap(await commands.shareUrl(url)),
  agentKeySet: async (key: string) => unwrap(await commands.agentKeySet(key)),
  agentKeyPresent: () => commands.agentKeyPresent(),
  agentApprove: async (id: string, allow: boolean) => unwrap(await commands.agentApprove(id, allow)),
  /** Stream a reply; `onDelta` fires for each piece. Resolves when the stream ends. */
  agentSend: async (turns: ChatTurnInput[], tabId: string | null, onDelta: (d: ChatDeltaOut) => void) => {
    const channel = new Channel<ChatDeltaOut>();
    channel.onmessage = onDelta;
    unwrap(await commands.agentSend(turns, tabId, channel));
  },
  commandRun: async (id: string, args: unknown = null): Promise<unknown> =>
    JSON.parse(unwrap(await commands.commandRun(id, args === null ? null : JSON.stringify(args)))),
};
