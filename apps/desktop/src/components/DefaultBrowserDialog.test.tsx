import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultBrowserStatus } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDefaultBrowser } from "../store/defaultBrowser";
import { DefaultBrowserDialog, POLL_INTERVAL_MS, WAIT_TIMEOUT_MS, prettyBundleId } from "./DefaultBrowserDialog";

const notDefault: DefaultBrowserStatus = { supported: true, is_default: false, current: "com.apple.Safari" };
const isDefault: DefaultBrowserStatus = { supported: true, is_default: true, current: "com.dive.browser" };

function openWith(status: DefaultBrowserStatus) {
  useDefaultBrowser.setState({ status, phase: "idle", error: null });
  useBrowser.getState().toggle("defaultBrowser", true);
}

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "defaultBrowserStatus").mockResolvedValue(notDefault);
  vi.spyOn(ipc, "defaultBrowserSet").mockResolvedValue(notDefault);
  useBrowser.getState().toggle("defaultBrowser", false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DefaultBrowserDialog", () => {
  it("offers to make Dive the default and names the current browser", () => {
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    expect(screen.getByRole("dialog", { name: "Make Dive your default browser" })).toBeTruthy();
    expect(screen.getByText(/macOS will ask you to confirm/)).toBeTruthy();
    expect(screen.getByText("Currently: Safari")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("says so when Dive is already the default", () => {
    openWith(isDefault);
    render(<DefaultBrowserDialog />);
    expect(screen.getByRole("dialog", { name: "Dive is your default browser" })).toBeTruthy();
    expect(screen.getByText(/already open here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
  });

  it("asks the host on Make default and finishes at once when the answer is yes", async () => {
    vi.mocked(ipc.defaultBrowserSet).mockResolvedValue(isDefault);
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    expect(ipc.defaultBrowserSet).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Dive is now your default browser" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("waits for macOS and finishes when a polled status flips", async () => {
    vi.useFakeTimers();
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    });
    expect(screen.getByText(/Waiting for macOS/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(ipc.defaultBrowserStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Waiting for macOS/)).toBeTruthy();

    vi.mocked(ipc.defaultBrowserStatus).mockResolvedValue(isDefault);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(screen.getByRole("dialog", { name: "Dive is now your default browser" })).toBeTruthy();
    expect(useDefaultBrowser.getState().phase).toBe("done");
  });

  it("gives up after the timeout and points at System Settings", async () => {
    vi.useFakeTimers();
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS + POLL_INTERVAL_MS);
    });
    expect(screen.getByText(/Still not the default/)).toBeTruthy();
    expect(screen.getByText(/Desktop & Dock/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    const polls = vi.mocked(ipc.defaultBrowserStatus).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(vi.mocked(ipc.defaultBrowserStatus).mock.calls.length).toBe(polls);
  });

  it("shows the host's message when asking fails, with a way to retry", async () => {
    vi.mocked(ipc.defaultBrowserSet).mockRejectedValue(new Error("Launch Services refused"));
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Launch Services refused"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(ipc.defaultBrowserSet).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape and forgets the phase", async () => {
    openWith(notDefault);
    render(<DefaultBrowserDialog />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.defaultBrowser).toBe(false));
    expect(useDefaultBrowser.getState().phase).toBe("idle");
  });

  it("prettifies the browsers people actually have", () => {
    expect(prettyBundleId("com.apple.Safari")).toBe("Safari");
    expect(prettyBundleId("com.google.Chrome")).toBe("Chrome");
    expect(prettyBundleId("com.brave.Browser")).toBe("Brave");
    expect(prettyBundleId("org.mozilla.firefox")).toBe("Firefox");
    expect(prettyBundleId("com.vivaldi.Vivaldi")).toBe("com.vivaldi.Vivaldi");
  });
});
