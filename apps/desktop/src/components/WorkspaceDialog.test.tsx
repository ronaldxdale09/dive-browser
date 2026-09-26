import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { WorkspaceDialog } from "./WorkspaceDialog";

const ws = (id: string, container_id: string): Workspace => ({ id, name: id, color: "#7FD8C8", icon: "dive", position: 0, container_id }) as unknown as Workspace;
const initial = useBrowser.getState();

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
});

describe("WorkspaceDialog", () => {
  it("tells an existing workspace whether its cookies are its own", () => {
    useBrowser.setState({ workspaces: [ws("home", "c1"), ws("client", "c2"), ws("side", "c2")], editing: { id: "client" } });
    render(<WorkspaceDialog />);
    expect(screen.getByText(/Shares cookies and logins with another workspace/)).toBeTruthy();
    cleanup();
    useBrowser.setState({ editing: { id: "home" } });
    render(<WorkspaceDialog />);
    expect(screen.getByText(/Its own cookies and logins/)).toBeTruthy();
    // The choice is made at creation: no checkbox to flip here.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the current colour and mark as selected even when they are not in the palette", () => {
    // The first workspace is created by the core with its own colour and mark.
    useBrowser.setState({ workspaces: [{ ...ws("home", "c1"), color: "#0F6E75", icon: "layers" }], editing: { id: "home" } });
    render(<WorkspaceDialog />);
    expect(screen.getByRole("radio", { name: "Current colour", checked: true })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "layers", checked: true })).toBeTruthy();
    cleanup();
    useBrowser.setState({ workspaces: [ws("home", "c1")], editing: { id: "home" } });
    render(<WorkspaceDialog />);
    expect(screen.getByRole("radio", { name: "Mint", checked: true })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Current colour" })).toBeNull();
  });

  it("creates once for a double Enter, and stays open with the name when the engine refuses", async () => {
    let refuse!: () => void;
    const create = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          refuse = () => {
            useBrowser.setState({ error: "workspace name is taken" });
            resolve(false);
          };
        }),
    );
    useBrowser.setState({ workspaces: [ws("home", "c1")], editing: { id: null }, createWorkspace: create });
    render(<WorkspaceDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Client, Side project/), { target: { value: "Client" } });
    const form = screen.getByRole("dialog", { name: "New workspace" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    refuse();
    expect((await screen.findByRole("alert")).textContent).toBe("workspace name is taken");
    expect((screen.getByPlaceholderText(/Client, Side project/) as HTMLInputElement).value).toBe("Client");
    expect(useBrowser.getState().editing).toEqual({ id: null });
  });
});
