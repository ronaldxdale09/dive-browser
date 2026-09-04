import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { Rail } from "./Rail";

const personal: Workspace = {
  id: "ws-1",
  name: "Personal",
  color: "#7FD8C8",
  icon: "aurora",
  container_id: "container-1",
  position: 0,
  created_at: "2026-09-03T00:00:00Z",
};
const client: Workspace = { ...personal, id: "ws-2", name: "Client", icon: "ember", container_id: "container-2", position: 1 };

beforeEach(() => {
  useBrowser.setState({
    workspaces: [personal, client],
    activeWorkspace: personal.id,
    counts: { [personal.id]: 3, [client.id]: 1 },
    editing: null,
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false },
  });
  usePrefs.setState({ prefs: { ...DEFAULT_PREFS, rail_expanded: true }, loaded: true });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Rail", () => {
  it("names each workspace and shows how many tabs it holds", () => {
    render(<Rail />);
    expect(screen.getByText("Workspaces")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Personal — 3 tabs/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Client — 1 tab, own cookies \(⌘2\)/ })).toBeTruthy();
  });

  it("switches workspace on click", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ activateWorkspace: activate });
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: /^Client/ }));
    expect(activate).toHaveBeenCalledWith(client.id);
  });

  it("collapses to marks alone, and the choice is a preference", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    usePrefs.setState({ update });
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspaces" }));
    expect(update).toHaveBeenCalledWith({ rail_expanded: false });

    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, rail_expanded: false } });
    await waitFor(() => expect(screen.queryByText("Workspaces")).toBeNull());
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.getByRole("button", { name: /^Personal — 3 tabs/ })).toBeTruthy();
  });

  it("confirms before deleting a workspace and its tabs", () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ deleteWorkspace: remove });
    render(<Rail />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Client/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete workspace" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete Client and close its 1 tab\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).toHaveBeenCalledWith(client.id);
  });

  it("offers editing from the context menu instead of opening the dialog on right-click", () => {
    render(<Rail />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Personal/ }));
    expect(useBrowser.getState().editing).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit workspace…" }));
    expect(useBrowser.getState().editing).toEqual({ id: personal.id });
  });
});
