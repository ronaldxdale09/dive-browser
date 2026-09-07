import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateDialog } from "./UpdateDialog";
import { useUpdates } from "../store/updates";

beforeEach(() => {
  useUpdates.setState({
    status: "idle",
    update: null,
    error: null,
    installing: false,
    dismissed: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UpdateDialog", () => {
  it("does not render when status is idle or none", () => {
    const { container } = render(<UpdateDialog />);
    expect(container.firstChild).toBeNull();

    useUpdates.setState({ status: "none", update: null });
    expect(container.firstChild).toBeNull();
  });

  it("renders when update is available and not dismissed", () => {
    useUpdates.setState({
      status: "available",
      update: {
        version: "0.1.1-rc.0",
        notes: "Major performance upgrade and bug fixes.",
      },
      dismissed: false,
    });

    render(<UpdateDialog />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Update available")).toBeTruthy();
    expect(screen.getByText("v0.1.1-rc.0")).toBeTruthy();
    expect(screen.getByText("Major performance upgrade and bug fixes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /install and restart/i })).toBeTruthy();
  });

  it("dismisses when clicking later or close", () => {
    useUpdates.setState({
      status: "available",
      update: {
        version: "0.1.1-rc.0",
        notes: null,
      },
      dismissed: false,
    });

    render(<UpdateDialog />);
    const laterBtn = screen.getByRole("button", { name: /later/i });
    fireEvent.click(laterBtn);

    useUpdates.getState().dismiss();
    expect(useUpdates.getState().dismissed).toBe(true);
  });

  it("triggers install when clicking Install and restart", async () => {
    const installSpy = vi.fn().mockResolvedValue(undefined);
    useUpdates.setState({
      status: "available",
      update: {
        version: "0.1.1-rc.0",
        notes: null,
      },
      install: installSpy,
      dismissed: false,
    });

    render(<UpdateDialog />);
    const installBtn = screen.getByRole("button", { name: /install and restart/i });
    fireEvent.click(installBtn);
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
});
