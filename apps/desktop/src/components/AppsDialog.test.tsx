import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { appsFor, searchApps } from "../lib/apps";
import { useBrowser } from "../store/browser";
import { usePicker } from "../store/simulator";
import { AppsDialog } from "./AppsDialog";

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "appInfo").mockResolvedValue({ version: "0.1.17", build: { channel: "beta", number: "1", built_at: 0 } } as never);
  useBrowser.setState({ activeTab: "t1", open: { ...useBrowser.getState().open, apps: true, dock: false, sidecar: false } });
  usePicker.setState({ open: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppsDialog", () => {
  it("lists every feature with a line on what it is for and its shortcut, and launches one", () => {
    render(<AppsDialog />);
    expect(screen.getByRole("dialog", { name: "Apps" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search apps" }));
    const dock = screen.getByRole("button", { name: /^Developer dock/ });
    expect(dock.textContent).toContain("⌘⇧D");
    expect(dock.textContent).toContain("Network, console");
    fireEvent.click(dock);
    expect(useBrowser.getState().open.dock).toBe(true);
  });

  it("filters by category and by search, and Enter opens the first match", async () => {
    render(<AppsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Developer" }));
    expect(screen.queryByRole("button", { name: /^DiveScreen/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Device simulator/ })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Search apps" });
    fireEvent.change(search, { target: { value: "simul" } });
    // A search looks across every shelf.
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("button", { name: /^(Device simulator|DiveScreen|Screenshot)/ }).length).toBe(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(usePicker.getState().open).toBe(true);
    await waitFor(() => expect(useBrowser.getState().open.apps).toBe(false));
  });

  it("greys out what needs a tab when none is open, and the arrows skip those", () => {
    useBrowser.setState({ activeTab: null });
    render(<AppsDialog />);
    expect((screen.getByRole("button", { name: /^Screenshot/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^Bookmarks/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search apps" }), { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).getAttribute("data-app")).toBe("recordings");
  });

  it("walks the grid with the arrow keys", () => {
    render(<AppsDialog />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search apps" }), { key: "ArrowDown" });
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute("data-app")).toBe("divescreen");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect((document.activeElement as HTMLElement).getAttribute("data-app")).toBe("screenshot");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).getAttribute("data-app")).toBe(appsFor()[1 + 3]!.id);
  });

  it("keeps the private window's list to what a private window allows", () => {
    const ids = appsFor(true).map((a) => a.id);
    expect(ids).not.toContain("agent");
    expect(ids).not.toContain("passwords");
    expect(ids).toContain("dock");
    expect(searchApps(appsFor(false), "loom").map((a) => a.id)).toEqual(["divescreen"]);
  });
});
