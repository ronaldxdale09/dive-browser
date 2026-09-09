import { prettyUrl } from "../lib/prettyUrl";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, TabLoad } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { Popout } from "./Popout";

vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, tabInfo: vi.fn(), windowCommand: vi.fn(), popoutReady: vi.fn() } };
});

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

let stateEvent: (payload: import("../lib/ipc").CoreEvent) => void;
let menuEvent: (command: string) => void;
beforeEach(() => {
  vi.mocked(ipc.tabInfo).mockResolvedValue(tab);
  vi.mocked(ipc.popoutReady).mockResolvedValue(false);
  vi.mocked(ipc.windowCommand).mockResolvedValue(null);
  vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
  vi.spyOn(ipc, "tabHistory").mockResolvedValue({ generation: "g", current_index: 1, entries: [{ id: 1, url: "https://one.test", title: "One" }, { id: 2, url: tab.url, title: "Example" }] });
  vi.spyOn(events.tabHistoryChanged, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.tabLoad, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.stateChanged, "listen").mockImplementation(async (callback) => {
    stateEvent = (payload) => callback({ event: "state-changed", id: 0, payload });
    return () => undefined;
  });
  vi.spyOn(events.menuCommand, "listen").mockImplementation(async (callback) => {
    menuEvent = (payload) => callback({ event: "menu-command", id: 0, payload });
    return () => undefined;
  });
  useBrowser.setState({ tabs: [tab], error: null, boot: vi.fn().mockResolvedValue(undefined) });
  usePrefs.setState({ load: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowserState, true);
  usePrefs.setState(initialPrefsState, true);
  vi.restoreAllMocks();
});

describe("detached Dive window", () => {
  it("renders a full browser chrome with a non-window-draggable tab and a dedicated drag surface", () => {
    vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab], boot: vi.fn().mockResolvedValue(undefined) });

    const { container } = render(<Popout tabId="a" />);

    expect(screen.getByRole("tablist", { name: "Window tabs" })).toBeTruthy();
    const windowTab = screen.getByRole("tab", { name: "Example" });
    expect(windowTab.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(screen.getByRole("navigation", { name: "Browser controls" })).toBeTruthy();
    expect(container.querySelectorAll('[data-tauri-drag-region="true"]')).toHaveLength(1);
  });

  it("explains a failed page load the way the main window does, with its own retry", async () => {
    const reload = vi.spyOn(ipc, "tabReload").mockResolvedValue(null as never);
    let onLoad: ((e: { payload: TabLoad }) => void) | null = null;
    vi.spyOn(events.tabLoad, "listen").mockImplementation(async (callback) => {
      onLoad = callback as typeof onLoad;
      return () => undefined;
    });
    render(<Popout tabId={tab.id} />);
    await waitFor(() => expect(onLoad).not.toBeNull());
    act(() => onLoad!({ payload: { tab_id: tab.id, phase: "failed", url: "http://localhost:5180/", error: "net::ERR_CONNECTION_REFUSED" } }));
    const panel = await screen.findByRole("alert", { name: "Connection refused" });
    expect(panel.textContent).toContain("net::ERR_CONNECTION_REFUSED");
    // No raw code in the generic banner.
    expect(useBrowser.getState().error).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledWith(tab.id);
    // The next navigation takes the panel down.
    act(() => onLoad!({ payload: { tab_id: tab.id, phase: "started", url: "http://localhost:5180/", error: null } }));
    expect(screen.queryByRole("alert", { name: "Connection refused" })).toBeNull();
  });

  it("surfaces rejected toolbar commands instead of dropping them", async () => {
    vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
    vi.spyOn(ipc, "tabBack").mockRejectedValue(new Error("renderer unavailable"));
    useBrowser.setState({ tabs: [tab], error: null, boot: vi.fn().mockResolvedValue(undefined) });
    usePrefs.setState({ load: vi.fn().mockResolvedValue(undefined) });

    render(<Popout tabId="a" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("renderer unavailable"));
  });
});


describe("detached page ownership and input", () => {
  it("loads its own page when the main workspace contains different tabs", async () => {
    useBrowser.setState({ tabs: [{ ...tab, id: "other", workspace_id: "other-workspace", title: "Other" }] });
    render(<Popout tabId="a" />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Example" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe(prettyUrl(tab.url));
    expect(ipc.tabInfo).toHaveBeenCalledWith("a");
  });

  it("keeps its identity when the main workspace snapshot is replaced", async () => {
    render(<Popout tabId="a" />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Example" })).toBeTruthy());
    act(() => useBrowser.setState({ activeWorkspace: "elsewhere", tabs: [] }));
    expect(screen.getByRole("tab", { name: "Example" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe(prettyUrl(tab.url));
  });

  it("keeps an unsubmitted address through redirects and restores the current address on Escape", async () => {
    render(<Popout tabId="a" />);
    const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    await act(async () => { input.focus(); });
    fireEvent.change(input, { target: { value: "https://draft.test/path" } });
    act(() => {
      useBrowser.setState({ tabs: [{ ...tab, url: "https://redirect.test/" }] });
      stateEvent?.({ type: "tab_upserted", data: { ...tab, url: "https://redirect.test/" } });
    });
    expect(input.value).toBe("https://draft.test/path");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("redirect.test");
    expect(document.activeElement).not.toBe(input);
  });

  it("selects the complete address again when CmdL arrives in an already focused field", async () => {
    render(<Popout tabId="a" />);
    const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    await act(async () => { input.focus(); });
    input.setSelectionRange(4, 4);
    act(() => menuEvent("address.focus"));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });

  it("synchronously focuses and selects its address on the native focus handoff", () => {
    render(<Popout tabId="a" />);
    const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    act(() => window.dispatchEvent(new Event("dive-native-focus-address")));
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    fireEvent.change(input, { target: { value: "new draft" } });
    input.setSelectionRange(4, 4);
    act(() => window.dispatchEvent(new Event("dive-native-focus-address")));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
  });

  it("does not let a late initial read overwrite a newer page event", async () => {
    let finish!: (value: Tab) => void;
    vi.mocked(ipc.tabInfo).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<Popout tabId="a" />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => stateEvent({ type: "tab_upserted", data: { ...tab, title: "Latest", url: "https://latest.test/" } }));
    await act(async () => finish(tab));
    expect(screen.getByRole("tab", { name: "Latest" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("latest.test");
  });

  it("opens a new tab in the main window without navigating the detached page", async () => {
    const navigate = vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
    render(<Popout tabId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "New tab in main window" }));
    await waitFor(() => expect(ipc.windowCommand).toHaveBeenCalledWith("tab.new"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes New Window menu commands and exposes routing failures", async () => {
    vi.mocked(ipc.windowCommand).mockRejectedValueOnce(new Error("main window unavailable"));
    render(<Popout tabId="a" />);
    await act(async () => menuEvent("window.new"));
    expect(ipc.windowCommand).toHaveBeenCalledWith("window.new");
    expect(screen.getByRole("alert").textContent).toContain("main window unavailable");
  });
});


describe("new window address readiness", () => {
  it("selects a newly created blank window address after the native ready receipt", async () => {
    useBrowser.setState({ tabs: [] });
    vi.mocked(ipc.tabInfo).mockResolvedValue({ ...tab, url: "about:blank", title: "" });
    vi.mocked(ipc.popoutReady).mockResolvedValue(true);
    render(<Popout tabId="a" />);
    const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Blank means blank: the placeholder shows and the tab reads as new.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Search or enter address");
    expect(screen.getByRole("tab", { name: "New tab" })).toBeTruthy();
  });

  it("does not overwrite selection when the ready receipt arrives after user input", async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(ipc.popoutReady).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<Popout tabId="a" />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    await act(async () => input.focus());
    fireEvent.keyDown(input, { key: "x" });
    fireEvent.change(input, { target: { value: "my draft" } });
    input.setSelectionRange(2, 2);
    await act(async () => finish(true));
    expect(input.value).toBe("my draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
  });
});


it("does not refocus a reattached page when an old popout navigation completes after unmount", async () => {
  let finish!: () => void;
  vi.spyOn(ipc, "tabNavigate").mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
  const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
  const view = render(<Popout tabId="a" />);
  const input = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
  await act(async () => input.focus());
  fireEvent.change(input, { target: { value: "https://next.test/" } });
  fireEvent.submit(input.closest("form")!);
  view.unmount();
  await act(async () => finish());
  expect(activate).not.toHaveBeenCalled();
});
