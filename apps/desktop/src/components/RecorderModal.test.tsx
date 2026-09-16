import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { useRecorder } from "../store/recorder";
import { RecorderModal } from "./RecorderModal";

beforeEach(() => {
  resetContentCover();
  useRecorder.setState({ isOpen: false, steps: [], recordingTab: null });
  useBrowser.setState({ tabs: [], activeTab: null, detached: [] });
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecorderModal", () => {
  it("leaves the page visible while it is closed", () => {
    // App mounts this unconditionally, so a cover taken while closed would
    // hide the content area for the life of the app -- the whole viewport
    // goes black with nothing on screen to explain it.
    render(<RecorderModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("does not name a detached tab as the recorded flow's page", () => {
    useBrowser.setState({
      tabs: [
        {
          id: "t1",
          workspace_id: "w",
          tier: "today",
          url: "https://torn.test/docs",
          title: "Torn-off docs",
          favicon: null,
          position: 0,
          state: "active",
          last_active_at: "2026-09-17T00:00:00Z",
        },
      ],
      activeTab: "t1",
      detached: ["t1"],
    });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    useRecorder.setState({ isOpen: true, steps: [], startUrl: null, startTitle: null });
    render(<RecorderModal />);
    const dialog = screen.getByRole("dialog", { name: "Recorded Playwright Test" });
    expect(dialog.textContent).not.toContain("Torn-off docs");
    expect(dialog.textContent).not.toContain("torn.test");
  });

  it("covers the page only while it is open, and releases it on close", async () => {
    render(<RecorderModal />);

    act(() => useRecorder.setState({ isOpen: true, steps: [] }));
    expect(screen.getByRole("dialog", { name: "Recorded Playwright Test" })).toBeTruthy();
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));

    act(() => useRecorder.setState({ isOpen: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });
});
