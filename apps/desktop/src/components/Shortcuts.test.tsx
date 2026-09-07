import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHORTCUTS } from "../lib/commands";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Shortcuts, groupShortcuts } from "./Shortcuts";

const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ ...initial, open: { ...initial.open, shortcuts: true } }, true);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "commandsList").mockResolvedValue([
    { id: "tab.new", title: "New tab", keybinding: "mod+t", scope: "workspace" },
    { id: "host.only", title: "Host-only thing", keybinding: "mod+shift+g", scope: "global" },
  ]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("groupShortcuts", () => {
  it("covers every chord in the map exactly once, folding ⌘1…⌘9 into one row", () => {
    const areas = groupShortcuts(SHORTCUTS);
    const rows = areas.flatMap((a) => a.rows);
    const chords = rows.flatMap((r) => r.chords);
    const jump = rows.find((r) => r.id === "workspace.jump");
    expect(jump?.title).toBe("Switch to workspace 1–9");
    expect(jump?.chords).toEqual(["mod+1 … mod+9"]);
    const expected = Object.keys(SHORTCUTS).filter((c) => !/^mod\+[1-9]$/.test(c));
    expect(chords.filter((c) => c !== "mod+1 … mod+9").sort()).toEqual(expected.sort());
    // Every row has a human title, not a bare id.
    for (const r of rows) expect(r.title, r.id).not.toBe(r.id);
    expect(areas.map((a) => a.title)).toEqual(["Tabs", "Workspaces", "Page", "Capture and record", "Panels and tools"]);
  });

  it("lists two chords for a command bound twice and prefers the host's title", () => {
    const rows = groupShortcuts(SHORTCUTS, [{ id: "tab.next", title: "Next tab (host)", keybinding: "mod+shift+]", scope: "tab" }]).flatMap((a) => a.rows);
    const next = rows.find((r) => r.id === "tab.next");
    expect(next?.chords).toEqual(["mod+shift+]", "ctrl+tab"]);
    expect(next?.title).toBe("Next tab (host)");
  });

  it("adds a host command with a keybinding the chrome map lacks", () => {
    const rows = groupShortcuts({}, [{ id: "host.only", title: "Host-only thing", keybinding: "mod+shift+g", scope: "global" }]).flatMap((a) => a.rows);
    expect(rows).toEqual([{ id: "host.only", title: "Host-only thing", chords: ["mod+shift+g"] }]);
  });
});

describe("Shortcuts dialog", () => {
  it("covers the page and renders areas with Mac glyphs", async () => {
    render(<Shortcuts />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(contentCoverDepth()).toBe(1);
    expect(screen.getByRole("region", { name: "Tabs" })).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByText("⌘Y")).toBeTruthy();
    expect(screen.getByText("⌘/")).toBeTruthy();
    expect(screen.getByText("⌘⇧S")).toBeTruthy();
    expect(screen.getByText("⌘1 … ⌘9")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Host-only thing")).toBeTruthy());
    expect(screen.getByText("⌘⇧G")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    render(<Shortcuts />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Close shortcuts" }), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.shortcuts).toBe(false));
  });
});
