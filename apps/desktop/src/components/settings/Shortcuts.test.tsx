import { describe, expect, it } from "vitest";
import { chromeChords } from "./Shortcuts";

describe("Settings › Shortcuts chrome rows", () => {
  it("lists chrome-only chords, skips what the host binds, and folds the workspace jumps", () => {
    const rows = chromeChords([{ id: "tab.close", title: "Close tab", keybinding: "mod+w", scope: "tab" }]);
    const titles = rows.map((r) => r.title);
    expect(titles).not.toContain("Close tab");
    expect(titles).toContain("Pin or unpin tab");
    expect(titles).toContain("Move tab to its own window");
    expect(titles).toContain("New workspace");
    expect(titles.filter((t) => t === "Switch to workspace 1–9")).toHaveLength(1);
    expect(rows.find((r) => r.title === "Pin or unpin tab")?.keys).toMatch(/P$/);
  });
});
