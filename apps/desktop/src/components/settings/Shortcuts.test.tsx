import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { chromeChords, Shortcuts } from "./Shortcuts";

const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

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

describe("Settings › Shortcuts", () => {
  it("does not claim every command is in the palette", () => {
    render(<Shortcuts />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Every command is also in the palette/);
    expect(text).toMatch(/commands that apply here/);
  });

  it("does not name ⌘K for the command palette on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Shortcuts />);
    expect(document.body.textContent).not.toMatch(/⌘K/);
    expect(document.body.textContent).toMatch(/Ctrl\+K/);
  });
});
