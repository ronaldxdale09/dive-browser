import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { Popout } from "./Popout";

const initialBrowserState = useBrowser.getState();
const initialPrefsState = usePrefs.getState();
const tab: Tab = {
  id: "a",
  workspace_id: "w",
  tier: "today",
  url: "https://example.com",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-04T00:00:00Z",
};

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowserState, true);
  usePrefs.setState(initialPrefsState, true);
  vi.restoreAllMocks();
});

describe("detached Dive window", () => {
  it("renders a full browser chrome with a non-window-draggable tab and a dedicated drag surface", () => {
    vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
    vi.spyOn(events.menuCommand, "listen").mockResolvedValue(() => undefined);
    useBrowser.setState({ tabs: [tab], boot: vi.fn().mockResolvedValue(undefined) });

    const { container } = render(<Popout tabId="a" />);

    expect(screen.getByRole("tablist", { name: "Window tabs" })).toBeTruthy();
    const windowTab = screen.getByRole("tab", { name: "Example" });
    expect(windowTab.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(screen.getByRole("navigation", { name: "Browser controls" })).toBeTruthy();
    expect(container.querySelectorAll('[data-tauri-drag-region="true"]')).toHaveLength(1);
  });

  it("surfaces rejected toolbar commands instead of dropping them", async () => {
    vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
    vi.spyOn(ipc, "tabBack").mockRejectedValue(new Error("renderer unavailable"));
    vi.spyOn(events.menuCommand, "listen").mockResolvedValue(() => undefined);
    useBrowser.setState({ tabs: [tab], error: null, boot: vi.fn().mockResolvedValue(undefined) });
    usePrefs.setState({ load: vi.fn().mockResolvedValue(undefined) });

    render(<Popout tabId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(useBrowser.getState().error).toBe("renderer unavailable"));
  });
});
