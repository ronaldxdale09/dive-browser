import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { EventCallback } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { runCommand } from "../lib/commands";
import { resetContentCover, useCoversContent } from "../lib/overlay";
import { useShortcuts } from "../lib/shortcuts";
import { useBrowser } from "../store/browser";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { Palette } from "./Palette";
import { SettingsDialog } from "./SettingsDialog";

let nativeCommand: EventCallback<string>;
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

// Use the real dialogs and shared shortcut hook in the same order as App.
function NavigationDialogs({ palette: PaletteComponent = Palette }: { palette?: ComponentType }) {
  useShortcuts();
  const open = useBrowser((s) => s.open);
  useCoversContent(open.palette || open.settings || open.library || open.shortcuts);
  return <Suspense fallback={<div role="status">Loading navigation dialog</div>}>{open.palette && <PaletteComponent />}{open.settings && <SettingsDialog />}</Suspense>;
}

beforeEach(() => {
  useBrowser.setState(useBrowser.getInitialState());
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "appInfo").mockResolvedValue({ version: "0.1.0", build: { channel: "dev", number: "1", commit: "abc1234", built_at: 0 }, data_dir: "/tmp/dive", mcp_url: "", mcp_token_path: "", simulate: null });
  vi.spyOn(ipc, "prefsGet").mockResolvedValue(DEFAULT_PREFS);
  vi.spyOn(ipc, "prefsSet").mockImplementation(async (prefs) => prefs);
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
  vi.spyOn(ipc, "devServersWatch").mockResolvedValue([]);
  vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([]);
  vi.spyOn(ipc, "historySearch").mockResolvedValue([]);
  vi.spyOn(events.devServersChanged, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.menuCommand, "listen").mockImplementation(async (callback) => {
    nativeCommand = callback;
    return () => undefined;
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  window.__diveInputTimingProbe?.stop();
  delete window.__diveUiInputTimingEnabled;
  resetContentCover();
  useBrowser.setState(useBrowser.getInitialState());
  vi.restoreAllMocks();
  if (scrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
});

describe("foreground navigation dialogs", () => {
  it("selects the entire focused Palette query synchronously before replacement typing", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    useBrowser.getState().toggle("palette", true);
    render(<NavigationDialogs />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "previous query" } });
    input.setSelectionRange(input.value.length, input.value.length);
    const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 14]);
    input.setRangeText("h", input.selectionStart!, input.selectionEnd!, "end");
    fireEvent.input(input);
    expect(input.value).toBe("h");
  });

  it.each(["keyboard", "native menu"])("replaces Settings with a focused New tab dialog via %s", async (source) => {
    window.__diveUiInputTimingEnabled = true;
    const timing = window.__diveInputTimingProbe!;
    timing.start();
    useBrowser.getState().openSettings();
    render(<NavigationDialogs />);
    const settingsField = screen.getByRole("textbox", { name: "Home page" });
    settingsField.focus();
    expect(document.activeElement).toBe(settingsField);
    await waitFor(() => expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true]]));

    if (source === "keyboard") {
      fireEvent.keyDown(settingsField, { key: "t", metaKey: true });
    } else {
      act(() => nativeCommand({ event: "menu-command", id: 1, payload: "tab.new" }));
    }

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const trace = timing.snapshot().events;
    expect(trace.find((event) => event.kind === "command")).toMatchObject({ command: "tab.new", source: source === "keyboard" ? "keyboard" : "native-menu" });
    const mounted = trace.findIndex((event) => event.kind === "palette-mounted");
    const focused = trace.findIndex((event) => event.kind === "focusin" && event.target?.role === "combobox");
    expect(mounted).toBeGreaterThan(-1);
    expect(focused).toBeGreaterThan(mounted);
    expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true]]);
    fireEvent.change(input, { target: { value: "https://fixture.test/new" } });
    expect(input.value).toBe("https://fixture.test/new");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useBrowser.getState().open.settings).toBe(false);
    expect(useBrowser.getState().open.palette).toBe(false);
    await waitFor(() => expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true], [false]]));
  });

  it("mounts and focuses New tab before the direct native event returns", () => {
    useBrowser.getState().openSettings();
    render(<NavigationDialogs />);
    screen.getByRole("textbox", { name: "Home page" }).focus();
    act(() => {
      window.dispatchEvent(new Event("dive-native-new-tab"));
      // Assert inside the event turn: an eventual React commit is too late
      // when the following native key event is already queued for chrome.
      const input = screen.getByRole("combobox");
      expect(document.activeElement).toBe(input);
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
      fireEvent.change(input, { target: { value: "immediate native input" } });
      expect((input as HTMLInputElement).value).toBe("immediate native input");
    });
  });

  it("removes the direct native listener when chrome unmounts", () => {
    const { unmount } = render(<NavigationDialogs />);
    unmount();
    act(() => window.dispatchEvent(new Event("dive-native-new-tab")));
    expect(useBrowser.getState().open.palette).toBe(false);
  });

  it("keeps native content covered while the replacement dialog's lazy chunk loads", async () => {
    let loadPalette!: (value: { default: typeof Palette }) => void;
    const paletteModule = new Promise<{ default: typeof Palette }>((resolve) => { loadPalette = resolve; });
    const LazyPalette = lazy(() => paletteModule);
    useBrowser.getState().openSettings();
    render(<NavigationDialogs palette={LazyPalette} />);
    await waitFor(() => expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true]]));

    act(() => runCommand("tab.new"));
    expect(screen.getByRole("status").textContent).toBe("Loading navigation dialog");
    expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true]]);
    await act(async () => loadPalette({ default: Palette }));

    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true]]);
    expect(ipc.prepareContentCover).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(vi.mocked(ipc.setContentCovered).mock.calls).toEqual([[true], [false]]));
  });

  it.each(["tab.new", "palette.open", "tabs.search", "plus"])("uses the same replacement policy for %s", (source) => {
    useBrowser.getState().openSettings("privacy");
    if (source === "plus") useBrowser.getState().toggle("palette", true);
    else runCommand(source);
    expect(useBrowser.getState().open.settings).toBe(false);
    expect(useBrowser.getState().open.palette).toBe(true);
  });

  it("shares the policy across navigation dialogs without resetting panels or drafts", () => {
    const preserved = { sidecar: true, dock: true, find: true, extensions: true, subtitles: true, defaultBrowser: true };
    const drafts = { editing: { id: null }, editingProfile: { id: null }, recordingTab: "recorded" };
    useBrowser.setState({ ...drafts, open: { ...useBrowser.getState().open, ...preserved, menu: true } });
    const transitions = [
      ["settings", () => useBrowser.getState().openSettings("privacy")],
      ["palette", () => useBrowser.getState().toggle("palette", true)],
      ["library", () => useBrowser.getState().openLibrary("history")],
      ["shortcuts", () => useBrowser.getState().toggle("shortcuts")],
      ["settings", () => useBrowser.getState().toggle("settings", true)],
      ["library", () => useBrowser.getState().toggle("library", true)],
    ] as const;
    for (const [selected, open] of transitions) {
      open();
      const state = useBrowser.getState();
      for (const panel of ["settings", "palette", "library", "shortcuts"] as const) {
        expect(state.open[panel], `${selected}: ${panel}`).toBe(panel === selected);
      }
      expect(state.open).toMatchObject({ ...preserved, menu: false });
      expect(state).toMatchObject(drafts);
    }
    expect(useBrowser.getState().settingsSection).toBe("privacy");
    expect(useBrowser.getState().libraryTab).toBe("history");
    useBrowser.getState().toggle("library", false);
    expect(useBrowser.getState().open).toMatchObject({ ...preserved, library: false, settings: false, palette: false, shortcuts: false });
  });
});
