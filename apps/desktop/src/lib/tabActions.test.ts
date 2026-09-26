import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentAnnouncements, resetAnnouncements } from "./announce";
import { UI_COMMANDS, SHORTCUTS, chromeCommands } from "./commands";
import type { Tab } from "./ipc";
import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import { useTabAudio } from "../store/tabAudio";

const tab = (id: string, position: number, tier: Tab["tier"] = "today"): Tab => ({
  id, workspace_id: "w", tier, url: `https://${id}.test/`, title: id.toUpperCase(), position, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

const initialBrowser = useBrowser.getState();
const run = (id: string) => UI_COMMANDS[id]!();

beforeEach(() => {
  vi.spyOn(ipc, "tabReorder").mockResolvedValue(null);
  vi.spyOn(ipc, "tabSetMuted").mockResolvedValue(null);
  useBrowser.setState({ tabs: [tab("p", 0, "pinned"), tab("a", 0), tab("b", 1), tab("c", 2)], activeTab: "b", activeWorkspace: "w", detached: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAnnouncements();
  useBrowser.setState(initialBrowser, true);
  useLayout.setState({ splits: {} });
  useTabAudio.setState({ byTab: {} });
});

describe("moving the active tab", () => {
  it("moves one place and says where it landed", async () => {
    await run("tab.moveLeft");
    expect(ipc.tabReorder).toHaveBeenCalledWith("w", ["p", "b", "a", "c"]);
    expect(currentAnnouncements().polite?.text).toBe("Moved to position 2 of 4");
    await run("tab.moveRight");
    expect(ipc.tabReorder).toHaveBeenLastCalledWith("w", ["p", "a", "b", "c"]);
  });

  it("keeps an unpinned tab out of the pinned ones, and says so at the ends", async () => {
    useBrowser.setState({ activeTab: "a" });
    await run("tab.moveLeft");
    expect(ipc.tabReorder).not.toHaveBeenCalled();
    expect(currentAnnouncements().polite?.text).toBe("Already the first tab");
    useBrowser.setState({ activeTab: "c" });
    await run("tab.moveRight");
    expect(currentAnnouncements().polite?.text).toBe("Already the last tab");
  });

  it("binds ⌘⌥⇧← and ⌘⌥⇧→, and offers the tab menu's actions in the palette", () => {
    expect(SHORTCUTS["mod+alt+shift+arrowleft"]).toBe("tab.moveLeft");
    expect(SHORTCUTS["mod+alt+shift+arrowright"]).toBe("tab.moveRight");
    const ids = chromeCommands().map((c) => c.id);
    for (const id of ["tab.mute", "tab.duplicate", "tab.split", "tab.essential", "tab.closeOthers", "tab.moveLeft", "tab.moveRight"]) expect(ids, id).toContain(id);
  });
});

describe("the tab menu's actions from the palette", () => {
  it("mutes and unmutes the active tab", async () => {
    await run("tab.mute");
    expect(ipc.tabSetMuted).toHaveBeenCalledWith("b", true);
    expect(currentAnnouncements().polite?.text).toBe("Muted B");
    await run("tab.mute");
    expect(ipc.tabSetMuted).toHaveBeenLastCalledWith("b", false);
  });

  it("duplicates, closes the others and makes the active tab essential", async () => {
    const duplicateTab = vi.fn().mockResolvedValue(undefined);
    const closeOtherTabs = vi.fn().mockResolvedValue(undefined);
    const setTier = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ duplicateTab, closeOtherTabs, setTier });
    await run("tab.duplicate");
    expect(duplicateTab).toHaveBeenCalledWith("b");
    await run("tab.closeOthers");
    expect(closeOtherTabs).toHaveBeenCalledWith("b");
    await run("tab.essential");
    expect(setTier).toHaveBeenCalledWith("b", "essential");
  });

  it("splits the active tab with its neighbour, and takes it out again", async () => {
    await run("tab.split");
    expect(useLayout.getState().splits["w"]?.tabs).toEqual(["b", "c"]);
    expect(currentAnnouncements().polite?.text).toBe("Split with C");
    await run("tab.split");
    expect(useLayout.getState().splits["w"]).toBeUndefined();
    expect(currentAnnouncements().polite?.text).toBe("Removed from split view");
  });
});
