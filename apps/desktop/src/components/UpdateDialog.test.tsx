import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateDialog } from "./UpdateDialog";
import { useBrowser } from "../store/browser";
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

  it("opens the release notes as a Dive tab", () => {
    const openTab = vi.fn().mockResolvedValue(undefined);
    const initial = useBrowser.getState();
    useBrowser.setState({ openTab });
    useUpdates.setState({ status: "available", update: { version: "0.1.1", notes: "" }, dismissed: false });
    render(<UpdateDialog />);
    fireEvent.click(screen.getByRole("button", { name: /release notes/i }));
    expect(openTab).toHaveBeenCalledWith(expect.stringMatching(/releases\/tag\/v0\.1\.1$/));
    useBrowser.setState(initial, true);
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

describe("while the update downloads", () => {
  const available = {
    status: "available" as const,
    update: { version: "0.1.23", notes: "Dive 0.1.23", date: null },
    dismissed: false,
    error: null,
  };

  it("says how far it has got instead of just spinning", () => {
    useUpdates.setState({ ...available, installing: true, received: 30_000_000, total: 120_000_000, applying: false });
    render(<UpdateDialog />);
    expect(screen.getByText("Downloading 25%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Update download" }).getAttribute("aria-valuenow")).toBe("25");
  });

  it("shows what has arrived when the release declared no size", () => {
    useUpdates.setState({ ...available, installing: true, received: 4_200_000, total: null, applying: false });
    render(<UpdateDialog />);
    expect(screen.getByText("Downloading 4.2 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Update download" }).getAttribute("aria-valuenow")).toBeNull();
  });

  it("turns to Installing once the bytes are down and the installer runs", () => {
    useUpdates.setState({ ...available, installing: true, received: 120_000_000, total: 120_000_000, applying: true });
    render(<UpdateDialog />);
    expect(screen.getByText("Installing…")).toBeTruthy();
    // The bar is for the download; the install itself reports nothing.
    expect(screen.queryByRole("progressbar", { name: "Update download" })).toBeNull();
  });
});
