import { describe, expect, it } from "vitest";
import { reduceEvent, reduceWindowChange } from "./browser";
import type { Tab } from "../lib/ipc";

const tab = (id: string, url = "https://x"): Tab => ({
  id, workspace_id: "w", tier: "today", url, title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

describe("reduceEvent", () => {
  it("upserts tabs in place", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: null, detached: [] };
    const out = reduceEvent(base, { type: "tab_upserted", data: tab("a", "https://y") });
    expect(out.tabs?.map((t) => t.url)).toEqual(["https://y", "https://x"]);
  });

  it("closing the active tab clears the selection until the engine activates a replacement", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "b", activeWorkspace: "w", recordingTab: null, detached: [] };
    const out = reduceEvent(base, { type: "tab_closed", data: "b" });
    expect(out).toEqual({ tabs: [tab("a")], activeTab: null, recordingTab: null, detached: [] });
    expect(reduceEvent({ ...base, ...out }, { type: "tab_activated", data: "a" })).toEqual({ activeTab: "a" });
  });

  it("closing the tab being recorded drops the recording state", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: "b", detached: [] };
    expect(reduceEvent(base, { type: "tab_closed", data: "b" }).recordingTab).toBeNull();
    expect(reduceEvent(base, { type: "tab_closed", data: "a" }).recordingTab).toBe("b");
  });
});

describe("reduceWindowChange", () => {
  it("blanks the main window when the tab it showed leaves for its own window", () => {
    expect(reduceWindowChange({ detached: [], activeTab: "a" }, "a", true)).toEqual({ detached: ["a"], activeTab: null });
    expect(reduceWindowChange({ detached: [], activeTab: "b" }, "a", true)).toEqual({ detached: ["a"], activeTab: "b" });
  });

  it("forgets a tab that came back", () => {
    expect(reduceWindowChange({ detached: ["a", "b"], activeTab: null }, "a", false)).toEqual({ detached: ["b"], activeTab: null });
  });
});
