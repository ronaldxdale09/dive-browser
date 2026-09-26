import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { SessionRecoveryCard } from "./SessionRecoveryCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionRecoveryCard", () => {
  it("stays out of the way after a normal start", async () => {
    const status = vi.spyOn(ipc, "sessionRecoveryStatus").mockResolvedValue(null);
    const { container } = render(<SessionRecoveryCard />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("asks after repeated unclean exits and restores on request", async () => {
    vi.spyOn(ipc, "sessionRecoveryStatus").mockResolvedValue({ crashes: 2, can_restore: true });
    const resolve = vi.spyOn(ipc, "sessionRecoveryResolve").mockResolvedValue(null);
    render(<SessionRecoveryCard />);
    expect(await screen.findByText("Dive quit unexpectedly")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore tabs" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("starts fresh without bringing the tab back", async () => {
    vi.spyOn(ipc, "sessionRecoveryStatus").mockResolvedValue({ crashes: 3, can_restore: true });
    const resolve = vi.spyOn(ipc, "sessionRecoveryResolve").mockResolvedValue(null);
    render(<SessionRecoveryCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(false));
  });
});
