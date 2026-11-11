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
            useBrowser.setState({ error: "workspace name is taken", errorField: "name" });
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
    const name = screen.getByPlaceholderText(/Client, Side project/) as HTMLInputElement;
    expect(name.value).toBe("Client");
    // The refusal is the name's: marked, described by it, and focused.
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    expect(document.activeElement).toBe(name);
    expect(useBrowser.getState().editing).toEqual({ id: null });
  });

  it("marks the name from the field the host named, not from the words of the reason", async () => {
    const refuse = (error: string, errorField: string | null) =>
      vi.fn(async () => {
        useBrowser.setState({ error, errorField });
        return false;
      });
    useBrowser.setState({ workspaces: [ws("home", "c1")], editing: { id: null }, createWorkspace: refuse("pick something shorter", "name") });
    render(<WorkspaceDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Client, Side project/), { target: { value: "Client" } });
    fireEvent.submit(screen.getByRole("dialog", { name: "New workspace" }));
    await screen.findByRole("alert");
    const name = screen.getByPlaceholderText(/Client, Side project/);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    cleanup();
    // The word "name" in a reason with no field is no longer enough.
    useBrowser.setState({ editing: { id: null }, createWorkspace: refuse("the name of the engine failed", null) });
    render(<WorkspaceDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Client, Side project/), { target: { value: "Client" } });
    fireEvent.submit(screen.getByRole("dialog", { name: "New workspace" }));
    await screen.findByRole("alert");
    expect(screen.getByPlaceholderText(/Client, Side project/).getAttribute("aria-invalid")).toBeNull();
  });
});
