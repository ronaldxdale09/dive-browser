/**
 * Thin façade over the generated tauri-specta bindings so components never
 * import the generated file directly. Regenerate with `cargo test -p dive-desktop`.
 */
import { commands, events } from "../generated/bindings";

/** Shape tauri-specta returns for fallible commands. */
type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export { events };
export type { Snapshot, Tab, Workspace, Command, CoreEvent, Bounds, WorkspaceDraft, ConsoleEntry, Level } from "../generated/bindings";

/** Unwrap a specta `Result`, throwing the app error message on failure. */
export function unwrap<T, E extends { message: string }>(r: Result<T, E>): T {
  if (r.status === "ok") return r.data;
  throw new Error(r.error.message);
}

type WorkspaceDraftInput = { name: string; color: string };

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
  tabBack: async (id: string) => unwrap(await commands.tabBack(id)),
  tabForward: async (id: string) => unwrap(await commands.tabForward(id)),
  tabReload: async (id: string) => unwrap(await commands.tabReload(id)),
  tabCapture: async (id: string, fullPage: boolean) => unwrap(await commands.tabCapture(id, fullPage)),
  setContentBounds: async (b: { x: number; y: number; width: number; height: number }) =>
    unwrap(await commands.layoutSetContentBounds(b)),
  commandsList: () => commands.commandsList(),
  commandRun: async (id: string, args: unknown = null): Promise<unknown> =>
    JSON.parse(unwrap(await commands.commandRun(id, args === null ? null : JSON.stringify(args)))),
};
