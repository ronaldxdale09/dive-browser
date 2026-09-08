import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import menuSource from "../../src-tauri/src/menu.rs?raw";
import { COMMAND_TITLES, SHORTCUTS, UI_COMMANDS, chordOf, chordsByCommand, chromeCommands, formatChord, isEditable, isMac, runCommand, shortcutFor } from "./commands";
import { events, ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import type { Tab } from "./ipc";

const tab = (id: string): Tab => ({
  id, workspace_id: "w", tier: "today", url: "https://x", title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

function platform(p: string) {
  Object.defineProperty(navigator, "platform", { value: p, configurable: true });
}

beforeEach(() => platform("MacIntel"));

afterEach(() => {
  vi.restoreAllMocks();
  useBrowser.setState({ tabs: [], activeTab: null });
  platform("");
  Reflect.deleteProperty(window, "__DIVE_PRIVATE__");
});

const key = (init: KeyboardEventInit & { target?: HTMLElement }) => {
  const { target, ...rest } = init;
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  if (target) {
    document.body.appendChild(target);
    target.dispatchEvent(e);
    target.remove();
  }
  return e;
};

describe("command dispatch", () => {
  it("closes an empty private window with the close-tab command", async () => {
    Object.defineProperty(window, "__DIVE_PRIVATE__", {value:true, configurable:true});
    const close = vi.spyOn(ipc, "windowClose").mockResolvedValue(null);
    useBrowser.setState({activeTab:null, tabs:[]});
    await UI_COMMANDS["tab.close"]!();
    expect(close).toHaveBeenCalledOnce();
  });
  it("sends New Window and New private window to separate native commands", async () => {
    Object.defineProperty(window, "__DIVE_PRIVATE__", {value:true, configurable:true});
    const normal = vi.spyOn(ipc, "windowOpen").mockResolvedValue(null);
    const privateWindow = vi.spyOn(ipc, "windowPrivate").mockResolvedValue(null);
    await UI_COMMANDS["window.new"]!();
    expect(normal).toHaveBeenCalledOnce();
    expect(privateWindow).not.toHaveBeenCalled();
    await UI_COMMANDS["window.private"]!();
    expect(privateWindow).toHaveBeenCalledOnce();
  });
  it("keeps live subtitles out of a private window", () => {
    Object.defineProperty(window, "__DIVE_PRIVATE__", {value:true, configurable:true});
    const notify = vi.spyOn(useBrowser.getState(), "notify").mockImplementation(() => undefined);
    useBrowser.setState({ notify, open: { ...useBrowser.getState().open, subtitles: false } });
    try {
      runCommand("subtitles.open");
      expect(notify).toHaveBeenCalledWith("Use a normal window for this action.");
      expect(useBrowser.getState().open.subtitles).toBe(false);
      expect(chromeCommands().some((c) => c.id === "subtitles.open")).toBe(false);
    } finally {
      notify.mockRestore();
      useBrowser.setState({ notify: useBrowser.getInitialState().notify });
      Reflect.deleteProperty(window, "__DIVE_PRIVATE__");
    }
    expect(chromeCommands().some((c) => c.id === "subtitles.open")).toBe(true);
  });
  it("records steps in the active tab and stops into the spec on the second call", async () => {
    const { useRecorder } = await import("../store/recorder");
    vi.spyOn(events.recorderEvent, "listen").mockResolvedValue(() => undefined);
    const start = vi.spyOn(ipc, "tabRecordStart").mockResolvedValue(null);
    const stop = vi.spyOn(ipc, "tabRecordStop").mockResolvedValue([{ kind: "click", locator: "role=button[name='Go']", value: null, url: "https://a.dev/", at: 1 }] as never);
    useBrowser.setState({ activeTab: "t1", tabs: [{ id: "t1", url: "https://example.com/", title: "Example Domain" } as unknown as Tab] });
    await UI_COMMANDS["recorder.toggle"]!();
    expect(start).toHaveBeenCalledWith("t1");
    expect(useRecorder.getState().recordingTab).toBe("t1");
    expect(useRecorder.getState().startUrl).toBe("https://example.com/");
    await UI_COMMANDS["recorder.toggle"]!();
    expect(stop).toHaveBeenCalledWith("t1");
    expect(useRecorder.getState().recordingTab).toBeNull();
    expect(useRecorder.getState().isOpen).toBe(true);
    useRecorder.getState().clear();
  });
  it("says so when a recording stops with nothing in it", async () => {
    const { useRecorder } = await import("../store/recorder");
    vi.spyOn(events.recorderEvent, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(ipc, "tabRecordStart").mockResolvedValue(null);
    vi.spyOn(ipc, "tabRecordStop").mockResolvedValue([]);
    const notify = vi.fn();
    useBrowser.setState({ activeTab: "t1", tabs: [{ id: "t1", url: "https://example.com/", title: "Example Domain" } as unknown as Tab], notify });
    await UI_COMMANDS["recorder.toggle"]!();
    await UI_COMMANDS["recorder.toggle"]!();
    expect(useRecorder.getState().isOpen).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("Nothing was recorded. Click or type on the page while recording.", 5000);
    useRecorder.getState().clear();
    useBrowser.setState({ notify: useBrowser.getInitialState().notify });
  });
  it("every shortcut points at a chrome-side handler", () => {
    for (const id of Object.values(SHORTCUTS)) expect(UI_COMMANDS[id], id).toBeTypeOf("function");
  });

  it("every native menu item points at a chrome-side handler", () => {
    // The menu carries the same chords for when the page, not the chrome, has
    // focus; an id that drifts out of UI_COMMANDS would be a dead menu entry.
    const ids = [...menuSource.matchAll(/item\(\s*(?:app,\s*)?"([\w.]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(UI_COMMANDS[id], id).toBeTypeOf("function");
  });

  it("names every chrome-side command", () => {
    for (const id of Object.keys(UI_COMMANDS)) expect(COMMAND_TITLES[id], id).toBeTypeOf("string");
  });

  it("binds the library, cheatsheet, settings and print", () => {
    expect(SHORTCUTS["mod+y"]).toBe("history.open");
    expect(SHORTCUTS["mod+/"]).toBe("shortcuts.open");
    expect(SHORTCUTS["mod+,"]).toBe("settings.open");
    expect(SHORTCUTS["mod+p"]).toBe("tab.print");
    expect(chordOf(key({ key: "/", metaKey: true }))).toBe("mod+/");
    expect(shortcutFor(key({ key: "y", metaKey: true, target: document.createElement("div") }))).toBe("history.open");
  });

  it("provides the useful non-conflicting Chrome and Brave shortcuts", () => {
    expect(SHORTCUTS["mod+n"]).toBe("window.new");
    expect(SHORTCUTS["mod+t"]).toBe("tab.new");
    expect(SHORTCUTS["mod+d"]).toBe("bookmark.toggle");
    expect(SHORTCUTS["mod+shift+a"]).toBe("tabs.search");
    expect(SHORTCUTS["mod+y"]).toBe("history.open");
    expect(SHORTCUTS["mod+alt+b"]).toBe("bookmarks.open");
    expect(SHORTCUTS["mod+shift+j"]).toBe("downloads.open");
    expect(SHORTCUTS["mod+shift+delete"]).toBe("browsing-data.open");
  });

  it("binds pinning and detaching the active tab, clear of the native menu's ⌘⇧N", async () => {
    expect(SHORTCUTS["mod+shift+p"]).toBe("tab.pin");
    expect(SHORTCUTS["mod+alt+n"]).toBe("tab.detach");
    expect(SHORTCUTS["mod+shift+n"]).toBe("window.private");
    expect(SHORTCUTS["mod+alt+shift+n"]).toBe("workspace.new");
    expect(COMMAND_TITLES["tab.pin"]).toBeTypeOf("string");
    expect(COMMAND_TITLES["tab.detach"]).toBeTypeOf("string");

    const setPinned = vi.fn().mockResolvedValue(undefined);
    const detachTab = vi.fn().mockResolvedValue(undefined);
    const attachTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [tab("a"), { ...tab("p"), tier: "pinned" }, { ...tab("e"), tier: "essential" }], activeTab: "a", detached: [], setPinned, detachTab, attachTab });
    await UI_COMMANDS["tab.pin"]!();
    expect(setPinned).toHaveBeenCalledWith("a", true);
    useBrowser.setState({ activeTab: "p" });
    await UI_COMMANDS["tab.pin"]!();
    expect(setPinned).toHaveBeenCalledWith("p", false);
    useBrowser.setState({ activeTab: "e" });
    await UI_COMMANDS["tab.pin"]!();
    expect(setPinned).toHaveBeenCalledTimes(2);

    useBrowser.setState({ activeTab: "a" });
    await UI_COMMANDS["tab.detach"]!();
    expect(detachTab).toHaveBeenCalledWith("a", null);
    useBrowser.setState({ detached: ["a"] });
    await UI_COMMANDS["tab.detach"]!();
    expect(attachTab).toHaveBeenCalledWith("a");
    useBrowser.setState({ detached: [] });
  });

  it("opens a fresh window using the engine's authoritative workspace", async () => {
    const open = vi.spyOn(ipc, "windowOpen").mockResolvedValue(null);
    useBrowser.setState({ activeWorkspace: null });
    await UI_COMMANDS["window.new"]!();
    expect(open).toHaveBeenCalledOnce();
  });

  it("routes browser library and tab-search commands to their exact surfaces", async () => {
    await UI_COMMANDS["tabs.search"]!();
    expect(useBrowser.getState().open.palette).toBe(true);

    await UI_COMMANDS["history.open"]!();
    expect(useBrowser.getState().libraryTab).toBe("history");
    await UI_COMMANDS["bookmarks.open"]!();
    expect(useBrowser.getState().libraryTab).toBe("bookmarks");
    await UI_COMMANDS["downloads.open"]!();
    expect(useBrowser.getState().libraryTab).toBe("downloads");

    await UI_COMMANDS["browsing-data.open"]!();
    expect(useBrowser.getState().settingsSection).toBe("privacy");
    expect(useBrowser.getState().open.settings).toBe(true);
  });

  it("toggles a bookmark and gives visible confirmation", async () => {
    vi.spyOn(ipc, "bookmarkToggle").mockResolvedValue(true);
    useBrowser.setState({ tabs: [tab("a")], activeTab: "a" });

    await UI_COMMANDS["bookmark.toggle"]!();

    expect(useBrowser.getState().notice).toBe("Bookmark saved");
  });

  it("routes the new commands to the store", async () => {
    const print = vi.spyOn(ipc, "tabPrint").mockResolvedValue(null);
    const stop = vi.spyOn(ipc, "tabStop").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab("a")], activeTab: "a" });
    await UI_COMMANDS["tab.print"]!();
    await UI_COMMANDS["tab.stop"]!();
    expect(print).toHaveBeenCalledWith("a");
    expect(stop).toHaveBeenCalledWith("a");
    await UI_COMMANDS["library.open"]!();
    expect(useBrowser.getState().open).toMatchObject({ library: true, shortcuts: false, settings: false });
    await UI_COMMANDS["shortcuts.open"]!();
    expect(useBrowser.getState().open).toMatchObject({ library: false, shortcuts: true, settings: false });
    await UI_COMMANDS["settings.open"]!();
    const { open } = useBrowser.getState();
    expect(open.library).toBe(false);
    expect(open.shortcuts).toBe(false);
    expect(open.settings).toBe(true);
    useBrowser.setState({ open: { ...open, library: false, shortcuts: false, settings: false } });
  });

  it("formats chords for each platform", () => {
    expect(formatChord("mod+shift+s", true)).toBe("⌘⇧S");
    expect(formatChord("mod+alt+i", true)).toBe("⌘⌥I");
    expect(formatChord("ctrl+shift+tab", true)).toBe("⌃⇧Tab");
    expect(formatChord("mod+/", true)).toBe("⌘/");
    expect(formatChord("mod+shift+]", true)).toBe("⌘⇧]");
    expect(formatChord("mod+shift+s", false)).toBe("Ctrl+Shift+S");
    expect(formatChord("ctrl+tab", false)).toBe("Ctrl+Tab");
    expect(formatChord("mod+t")).toBe("⌘T");
  });

  it("offers the palette only the chrome commands the host does not list", () => {
    const known = [{ id: "tab.new", title: "New tab", keybinding: "mod+t", scope: "workspace" as const }];
    const extra = chromeCommands(known);
    const ids = extra.map((c) => c.id);
    expect(ids).not.toContain("tab.new");
    expect(ids).toContain("tab.print");
    expect(ids).toContain("library.open");
    expect(ids.some((id) => id.startsWith("workspace.jump."))).toBe(false);
    expect(extra.find((c) => c.id === "tab.print")).toEqual({ id: "tab.print", title: "Print…", keybinding: "mod+p", scope: "global" });
    expect(chordsByCommand()["tab.next"]).toBe("mod+shift+]");
  });

  it("parses chords", () => {
    const primary = isMac() ? { metaKey: true } : { ctrlKey: true };
    const secondary = isMac() ? { ctrlKey: true } : { metaKey: true };
    expect(chordOf(key({ key: "S", shiftKey: true, ...primary }))).toBe("mod+shift+s");
    expect(chordOf(key({ key: "i", altKey: true, ...primary }))).toBe("mod+alt+i");
    expect(chordOf(key({ key: "k", ...secondary }))).toBe(`${isMac() ? "ctrl" : "meta"}+k`);
    expect(chordOf(key({ key: "k" }))).toBeNull();
    expect(chordOf(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(chordOf(key({ key: "Enter" }))).toBe("enter");
  });

  it("keeps Ctrl apart from ⌘ on macOS, and the other way round elsewhere", () => {
    expect(chordOf(key({ key: "k", ctrlKey: true }))).toBe("ctrl+k");
    expect(chordOf(key({ key: "k", metaKey: true }))).toBe("mod+k");
    expect(shortcutFor(key({ key: "k", ctrlKey: true }))).toBeNull();
    platform("Win32");
    expect(chordOf(key({ key: "k", ctrlKey: true }))).toBe("mod+k");
    expect(chordOf(key({ key: "k", metaKey: true }))).toBe("meta+k");
  });

  it("accepts named keys, with or without a modifier", () => {
    expect(chordOf(key({ key: "Enter", metaKey: true }))).toBe("mod+enter");
    expect(chordOf(key({ key: "Escape" }))).toBe("escape");
    expect(chordOf(key({ key: "F5" }))).toBe("f5");
    expect(chordOf(key({ key: "ArrowLeft", metaKey: true }))).toBe("mod+arrowleft");
    expect(chordOf(key({ key: "Tab", ctrlKey: true }))).toBe("ctrl+tab");
    expect(chordOf(key({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+tab");
  });

  it("reads the brackets by position, since shift turns ] into }", () => {
    expect(chordOf(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }))).toBe("mod+shift+]");
    expect(chordOf(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }))).toBe("mod+shift+[");
    expect(SHORTCUTS["mod+shift+]"]).toBe("tab.next");
    expect(SHORTCUTS["mod+shift+["]).toBe("tab.prev");
    expect(SHORTCUTS["ctrl+tab"]).toBe("tab.next");
    expect(SHORTCUTS["ctrl+shift+tab"]).toBe("tab.prev");
  });

  it("leaves a field alone except for the navigation chords", () => {
    const input = document.createElement("input");
    expect(isEditable(input)).toBe(true);
    expect(isEditable(document.createElement("button"))).toBe(false);
    expect(isEditable(document.createElement("select"))).toBe(true);
    expect(isEditable(document.createElement("textarea"))).toBe(true);
    // Typing, selecting all and submitting belong to the field.
    expect(shortcutFor(key({ key: "f", metaKey: true, target: input }))).toBeNull();
    expect(shortcutFor(key({ key: "Enter", target: input }))).toBeNull();
    expect(shortcutFor(key({ key: "Escape", target: input }))).toBeNull();
    // The omnibox still hands over the address bar, palette and tab chords.
    expect(shortcutFor(key({ key: "l", metaKey: true, target: input }))).toBe("address.focus");
    expect(shortcutFor(key({ key: "k", metaKey: true, target: input }))).toBe("palette.open");
    expect(shortcutFor(key({ key: "t", metaKey: true, target: input }))).toBe("tab.new");
    expect(shortcutFor(key({ key: "w", metaKey: true, target: input }))).toBe("tab.close");
    expect(shortcutFor(key({ key: "r", metaKey: true, target: input }))).toBe("tab.reload");
    expect(shortcutFor(key({ key: "n", metaKey: true, target: input }))).toBe("window.new");
    expect(shortcutFor(key({ key: "d", metaKey: true, target: input }))).toBe("bookmark.toggle");
    expect(shortcutFor(key({ key: "A", metaKey: true, shiftKey: true, target: input }))).toBe("tabs.search");
    expect(shortcutFor(key({ key: "Delete", metaKey: true, shiftKey: true, target: input }))).toBe("browsing-data.open");
    expect(shortcutFor(key({ key: "Tab", ctrlKey: true, target: input }))).toBe("tab.next");
    // Outside a field everything applies.
    expect(shortcutFor(key({ key: "f", metaKey: true, target: document.createElement("div") }))).toBe("find.open");
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isEditable(editable)).toBe(true);
    expect(shortcutFor(key({ key: "f", metaKey: true, target: editable }))).toBeNull();
  });

  it("steps to the next and previous tab, wrapping at both ends", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab("a"), tab("b"), tab("c")], activeTab: "c" });

    await UI_COMMANDS["tab.next"]!();
    expect(activate).toHaveBeenLastCalledWith("a");

    useBrowser.setState({ activeTab: "a" });
    await UI_COMMANDS["tab.prev"]!();
    expect(activate).toHaveBeenLastCalledWith("c");
  });

  it("steps in the strip's order, skipping essentials and tabs in their own window", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    // Store order is arrival order; the strip shows pinned first, then by position.
    useBrowser.setState({
      tabs: [
        { ...tab("late"), position: 2 },
        { ...tab("essential"), tier: "essential", position: 0 },
        { ...tab("early"), position: 1 },
        { ...tab("popout"), position: 3 },
        { ...tab("pinned"), tier: "pinned", position: 5 },
      ],
      detached: ["popout"],
      activeTab: "late",
    });

    await UI_COMMANDS["tab.next"]!();
    expect(activate).toHaveBeenLastCalledWith("pinned");

    useBrowser.setState({ activeTab: "pinned" });
    await UI_COMMANDS["tab.next"]!();
    expect(activate).toHaveBeenLastCalledWith("early");

    useBrowser.setState({ activeTab: "early" });
    await UI_COMMANDS["tab.prev"]!();
    expect(activate).toHaveBeenLastCalledWith("pinned");
    useBrowser.setState({ detached: [] });
  });

  it("does nothing when stepping with no tabs open", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    await UI_COMMANDS["tab.next"]!();
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("fill video", () => {
  it("is bound to mod+shift+f and titled for the palette", async () => {
    const { SHORTCUTS, COMMAND_TITLES } = await import("./commands");
    expect(SHORTCUTS["mod+shift+f"]).toBe("tab.fillVideo");
    expect(COMMAND_TITLES["tab.fillVideo"]).toBe("Fill tab with video");
  });
});
