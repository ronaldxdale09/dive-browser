import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { WorkspaceChip } from "./WorkspaceChip";

const personal: Workspace = {
  id: "ws-1",
  name: "Personal",
  color: "#7FD8C8",
  icon: "aurora",
  container_id: "container-1",
  profile_id: "profile-1",
  position: 0,
  created_at: "2026-09-03T00:00:00Z",
};
const client: Workspace = { ...personal, id: "ws-2", name: "Client", icon: "ember", container_id: "container-2", position: 1 };

beforeEach(() => {
  useBrowser.setState({
    workspaces: [personal, client],
    activeWorkspace: personal.id,
    counts: { [personal.id]: 2, [client.id]: 0 },
    editing: null,
  });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceChip", () => {
  it("says which workspace the tabs belong to", () => {
    render(<WorkspaceChip />);
    expect(screen.getByRole("button", { name: "Workspace: Personal" })).toBeTruthy();
  });

  it("switches from the menu and offers a new workspace", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ activateWorkspace: activate });
    render(<WorkspaceChip />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace: Personal" }));

    expect(screen.getByRole("menuitemradio", { name: /Personal/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Client/ }));
    expect(activate).toHaveBeenCalledWith(client.id);

    fireEvent.click(screen.getByRole("button", { name: "Workspace: Personal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New workspace/ }));
    expect(useBrowser.getState().editing).toEqual({ id: null });
  });

  it("renders nothing until a workspace is active", () => {
    useBrowser.setState({ activeWorkspace: null });
    const { container } = render(<WorkspaceChip />);
    expect(container.firstChild).toBeNull();
  });
});
