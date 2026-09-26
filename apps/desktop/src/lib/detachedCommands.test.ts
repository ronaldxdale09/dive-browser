import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import menuSource from "../../src-tauri/src/menu.rs?raw";
import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import { runDetachedCommand } from "./detachedCommands";

/** The commands menu.rs sends a focused detached window. */
function popoutCommands(): string[] {
  const block = /const POPOUT_COMMANDS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(menuSource)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const initial = useBrowser.getState();

beforeEach(() => {
  for (const name of ["tabClose", "tabReload", "tabBack", "tabForward", "tabDevtools", "pageSave", "tabZoom"] as const) {
    vi.spyOn(ipc, name).mockResolvedValue(null as never);
  }
});

afterEach(() => {
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("runDetachedCommand", () => {
  it("carries out every command the native menu sends a detached window", () => {
    const commands = popoutCommands();
    expect(commands.length).toBeGreaterThan(5);
    for (const command of commands) expect(runDetachedCommand(command, "t1", () => undefined), command).toBe(true);
  });

  it("acts on its own tab, not the main window's active one", async () => {
    useBrowser.setState({ activeTab: "main-tab", defaultZoom: 1 });
    runDetachedCommand("page.save", "t1");
    expect(ipc.pageSave).toHaveBeenCalledWith("t1");
    runDetachedCommand("zoom.in", "t1");
    await vi.waitFor(() => expect(ipc.tabZoom).toHaveBeenCalledWith("t1", expect.any(Number)));
    runDetachedCommand("find.open", "t1");
    expect(useBrowser.getState().open.find).toBe(true);
  });

  it("leaves commands it has no way to carry out alone", () => {
    expect(runDetachedCommand("bookmark.toggle", "t1")).toBe(false);
    expect(runDetachedCommand("sidecar.toggle", "t1")).toBe(false);
    // An app window has no address bar to focus.
    expect(runDetachedCommand("address.focus", "t1")).toBe(false);
  });
});
