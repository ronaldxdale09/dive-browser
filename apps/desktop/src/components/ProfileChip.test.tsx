import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, Workspace } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { ProfileChip } from "./ProfileChip";
import { ProfileDialog } from "./ProfileDialog";

const personal: Profile = { id: "p1", name: "Ronald", color: "#7FD8C8", avatar: "ronald", note: "", container_id: "c1", position: 0, created_at: "2026-09-04T00:00:00Z" };
const work: Profile = { ...personal, id: "p2", name: "Work", avatar: "work", note: "ronald@company.com", container_id: "c2", position: 1 };
const ws = (id: string, profile: string): Workspace => ({ id, name: id, color: "#0F6E75", icon: "layers", container_id: "c1", profile_id: profile, position: 0, created_at: "2026-09-04T00:00:00Z" });

beforeEach(() => {
  useBrowser.setState({ profiles: [personal, work], activeProfile: personal.id, workspaces: [ws("home", "p1"), ws("side", "p1"), ws("office", "p2")], activeWorkspace: "home", counts: { home: 3, side: 1, office: 2 }, editingProfile: null });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProfileChip", () => {
  it("names the profile you are in and lists the others with their workspaces", () => {
    render(<ProfileChip />);
    fireEvent.click(screen.getByRole("button", { name: "Profile: Ronald" }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(items[0]!.textContent).toContain("2 workspaces · 4 tabs");
    expect(items[1]!.textContent).toContain("ronald@company.com");
  });

  it("switches profile through the engine", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ activateProfile: activate });
    render(<ProfileChip />);
    fireEvent.click(screen.getByRole("button", { name: "Profile: Ronald" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Work/ }));
    expect(activate).toHaveBeenCalledWith("p2");
  });

  it("opens the dialog to make a profile, which needs a name and creates with a face", () => {
    const create = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ createProfile: create });
    render(
      <>
        <ProfileChip />
        <ProfileDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profile: Ronald" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New profile…" }));
    const dialog = screen.getByRole("dialog", { name: "New profile" });
    expect(dialog).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Create profile" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Ronald"), { target: { value: "Client" } });
    fireEvent.click(screen.getByRole("radio", { name: "Face kai" }));
    fireEvent.click(submit);
    expect(create).toHaveBeenCalledWith({ name: "Client", color: "#7FD8C8", avatar: "kai", note: "" });
  });

  it("refuses to delete the last profile but offers it otherwise", () => {
    useBrowser.setState({ editingProfile: { id: "p2" } });
    render(<ProfileDialog />);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    useBrowser.setState({ profiles: [personal], editingProfile: { id: "p1" } });
    render(<ProfileDialog />);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
