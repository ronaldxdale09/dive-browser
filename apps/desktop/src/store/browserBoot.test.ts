import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const { events, ipc } = await import("../lib/ipc");
  const names = ["stateChanged", "tabLoad", "tabCrashed", "permissionAsked", "permissionDismissed", "tabWindowChanged", "downloadNotice", "consoleEntry", "networkEvent", "privacyEvent"] as const;
  const listeners = Object.fromEntries(names.map((name) => [name, vi.spyOn(events[name], "listen").mockResolvedValue(() => undefined)]));
  const snapshot = vi.spyOn(ipc, "snapshot").mockResolvedValue({ workspaces: [], active_workspace: null, tabs: [], active_tab: null, detached: [], profiles: [], active_profile: null });
  vi.spyOn(ipc, "workspaceTabCounts").mockResolvedValue([]);
  const { usePrivacy } = await import("./privacy");
  vi.spyOn(usePrivacy.getState(), "loadInfo").mockResolvedValue(undefined);
  const { useBrowser } = await import("./browser");
  return { listeners, snapshot, useBrowser };
}

function deferredListener() {
  let resolve!: (unlisten: () => void) => void;
  const promise = new Promise<() => void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("browser startup subscriptions", () => {
  it("starts independent subscriptions together but waits for all before its snapshot", async () => {
    const { listeners, snapshot, useBrowser } = await setup();
    const pending = deferredListener();
    listeners.stateChanged!.mockReturnValue(pending.promise);
    const boot = useBrowser.getState().boot();
    try {
      await Promise.resolve();
      for (const listener of Object.values(listeners)) expect.soft(listener).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled();
      expect(useBrowser.getState().ready).toBe(false);
    } finally {
      pending.resolve(() => undefined);
      await boot;
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useBrowser.getState().error).toBeNull();
    expect(useBrowser.getState().ready).toBe(true);
  });

  it("keeps a failed batch in flight until pending subscriptions settle, then retries only failures", async () => {
    const { listeners, snapshot, useBrowser } = await setup();
    const pending = deferredListener();
    listeners.stateChanged!.mockRejectedValueOnce(new Error("state subscription failed"));
    listeners.tabLoad!.mockReturnValue(pending.promise);
    const boot = useBrowser.getState().boot();
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect.soft(useBrowser.getState().boot()).toBe(boot);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      pending.resolve(() => undefined);
      await boot;
    }
    expect.soft(useBrowser.getState().error).toContain("state subscription failed");
    await useBrowser.getState().boot();
    expect(listeners.stateChanged).toHaveBeenCalledTimes(2);
    for (const [name, listener] of Object.entries(listeners)) {
      if (name !== "stateChanged") expect(listener).toHaveBeenCalledTimes(1);
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useBrowser.getState().error).toBeNull();
  });

  it.each(["consoleEntry", "networkEvent"] as const)("retries a failed %s subscription without duplicating successful feeds", async (name) => {
    const { listeners, snapshot, useBrowser } = await setup();
    listeners[name]!.mockRejectedValueOnce(new Error(`${name} subscription failed`));
    await useBrowser.getState().boot();
    expect(useBrowser.getState().error).toContain(`${name} subscription failed`);
    expect(snapshot).not.toHaveBeenCalled();
    await useBrowser.getState().boot();
    expect(listeners[name]).toHaveBeenCalledTimes(2);
    for (const [other, listener] of Object.entries(listeners)) {
      if (other !== name) expect(listener).toHaveBeenCalledTimes(1);
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useBrowser.getState().error).toBeNull();
  });

});
