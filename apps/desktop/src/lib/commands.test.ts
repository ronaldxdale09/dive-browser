import { afterEach, describe, expect, it, vi } from "vitest";
import menuSource from "../../src-tauri/src/menu.rs?raw";
import { SHORTCUTS, UI_COMMANDS, chordOf } from "./commands";
import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import type { Tab } from "./ipc";

const tab = (id: string): Tab => ({
  id, workspace_id: "w", tier: "today", url: "https://x", title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

afterEach(() => {
  vi.restoreAllMocks();
  useBrowser.setState({ tabs: [], activeTab: null });
});

describe("command dispatch", () => {
  it("every shortcut points at a chrome-side handler", () => {
    for (const id of Object.values(SHORTCUTS)) expect(UI_COMMANDS[id], id).toBeTypeOf("function");
  });

  it("every native menu item points at a chrome-side handler", () => {
    // The menu carries the same chords for when the page, not the chrome, has
    // focus; an id that drifts out of UI_COMMANDS would be a dead menu entry.
    const ids = [...menuSource.matchAll(/item\(\s*(?:app,\s*)?"([\w.]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(UI_COMMANDS[id], id).toBeTypeOf("function");
  });

  it("parses chords", () => {
    expect(chordOf(new KeyboardEvent("keydown", { key: "S", metaKey: true, shiftKey: true }))).toBe("mod+shift+s");
    expect(chordOf(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe("mod+k");
    expect(chordOf(new KeyboardEvent("keydown", { key: "k" }))).toBeNull();
    expect(chordOf(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))).toBeNull();
  });

  it("steps to the next and previous tab, wrapping at both ends", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab("a"), tab("b"), tab("c")], activeTab: "c" });

    await UI_COMMANDS["tab.next"]!();
    expect(activate).toHaveBeenLastCalledWith("a");

    useBrowser.setState({ activeTab: "a" });
    await UI_COMMANDS["tab.prev"]!();
    expect(activate).toHaveBeenLastCalledWith("c");
  });

  it("does nothing when stepping with no tabs open", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    await UI_COMMANDS["tab.next"]!();
    expect(activate).not.toHaveBeenCalled();
  });
});
