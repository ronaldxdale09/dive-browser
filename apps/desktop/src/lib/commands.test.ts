import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import menuSource from "../../src-tauri/src/menu.rs?raw";
import { COMMAND_TITLES, SHORTCUTS, UI_COMMANDS, chordOf, chordsByCommand, chromeCommands, formatChord, isEditable, isMac, shortcutFor } from "./commands";
import { ipc } from "./ipc";
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
    expect(SHORTCUTS["mod+y"]).toBe("library.open");
    expect(SHORTCUTS["mod+/"]).toBe("shortcuts.open");
    expect(SHORTCUTS["mod+,"]).toBe("settings.open");
    expect(SHORTCUTS["mod+p"]).toBe("tab.print");
    expect(chordOf(key({ key: "/", metaKey: true }))).toBe("mod+/");
    expect(shortcutFor(key({ key: "y", metaKey: true, target: document.createElement("div") }))).toBe("library.open");
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
    await UI_COMMANDS["shortcuts.open"]!();
    await UI_COMMANDS["settings.open"]!();
    const { open } = useBrowser.getState();
    expect(open.library).toBe(true);
    expect(open.shortcuts).toBe(true);
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

  it("does nothing when stepping with no tabs open", async () => {
    const activate = vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
    await UI_COMMANDS["tab.next"]!();
    expect(activate).not.toHaveBeenCalled();
  });
});
