import { describe, expect, it } from "vitest";
import { reduceEvent } from "./browser";
import type { Tab } from "../lib/ipc";

const tab = (id: string, url = "https://x"): Tab => ({
  id, workspace_id: "w", tier: "today", url, title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

describe("reduceEvent", () => {
  it("upserts tabs in place", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: null };
    const out = reduceEvent(base, { type: "tab_upserted", data: tab("a", "https://y") });
    expect(out.tabs?.map((t) => t.url)).toEqual(["https://y", "https://x"]);
  });

  it("closing the active tab clears the selection until the engine activates a replacement", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "b", activeWorkspace: "w", recordingTab: null };
    const out = reduceEvent(base, { type: "tab_closed", data: "b" });
    expect(out).toEqual({ tabs: [tab("a")], activeTab: null, recordingTab: null });
    expect(reduceEvent({ ...base, ...out }, { type: "tab_activated", data: "a" })).toEqual({ activeTab: "a" });
  });

  it("closing the tab being recorded drops the recording state", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: "b" };
    expect(reduceEvent(base, { type: "tab_closed", data: "b" }).recordingTab).toBeNull();
    expect(reduceEvent(base, { type: "tab_closed", data: "a" }).recordingTab).toBe("b");
  });
});
