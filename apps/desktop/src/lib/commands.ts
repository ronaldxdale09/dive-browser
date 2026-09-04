import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import { useRecording } from "../store/recording";
import { usePicker } from "../store/simulator";
import type { Command } from "./ipc";

/** Rail positions a workspace chord can reach. */
const WORKSPACE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The one place chrome-side commands are dispatched. The palette and the
 * keyboard shortcuts both call this, so an id can never be handled by one
 * and forgotten by the other. Unknown ids go to the Rust registry, which
 * rejects chrome-owned ids loudly.
 */
export const UI_COMMANDS: Record<string, () => void | Promise<void>> = {
  "palette.open": () => useBrowser.getState().toggle("palette", true),
  "tabs.search": () => useBrowser.getState().toggle("palette", true),
  "tab.new": () => useBrowser.getState().toggle("palette", true),
  "window.new": () => openWindow(),
  "tab.close": () => {
    const { activeTab, closeTab } = useBrowser.getState();
    return activeTab ? closeTab(activeTab) : undefined;
  },
  "tab.reload": () => useBrowser.getState().reload(),
  "tab.devtools": () => useBrowser.getState().devtools(),
  "report.compose": () => useBrowser.getState().bugReport(),
  "screencast.toggle": () => useRecording.getState().toggle(),
  "zoom.in": () => useBrowser.getState().zoomStep(1),
  "zoom.out": () => useBrowser.getState().zoomStep(-1),
  "zoom.reset": () => useBrowser.getState().zoomStep(0),
  "sidecar.toggle": () => useBrowser.getState().toggle("sidecar"),
  "dock.toggle": () => useBrowser.getState().toggle("dock"),
  "simulator.toggle": () => usePicker.getState().toggle(),
  "subtitles.open": () => useBrowser.getState().toggle("subtitles", true),
  "capture.fullpage": () => useBrowser.getState().capture(true),
  "find.open": () => useBrowser.getState().toggle("find", true),
  "library.open": () => useBrowser.getState().toggle("library", true),
  "bookmarks.open": () => useBrowser.getState().openLibrary("bookmarks"),
  "history.open": () => useBrowser.getState().openLibrary("history"),
  "downloads.open": () => useBrowser.getState().openLibrary("downloads"),
  "browsing-data.open": () => useBrowser.getState().openSettings("privacy"),
  "bookmark.toggle": () => toggleBookmark(),
  "shortcuts.open": () => useBrowser.getState().toggle("shortcuts", true),
  "settings.open": () => useBrowser.getState().openSettings(),
  "tab.print": () => useBrowser.getState().print(),
  "tab.fillVideo": () => useBrowser.getState().fillVideo(),
  "tab.stop": () => useBrowser.getState().stop(),
  "address.focus": () => void window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS)),
  "tab.back": () => useBrowser.getState().back(),
  "tab.forward": () => useBrowser.getState().forward(),
  "tab.prev": () => stepTab(-1),
  "tab.next": () => stepTab(1),
  "workspace.new": () => useBrowser.getState().setEditing({ id: null }),
  "workspace.edit": () => {
    const { activeWorkspace, setEditing } = useBrowser.getState();
    if (activeWorkspace) setEditing({ id: activeWorkspace });
  },
  // ⌘1…⌘9 land on the workspace in that rail position, the way every other
  // browser's ⌘1…⌘9 lands on a tab.
  ...Object.fromEntries(WORKSPACE_SLOTS.map((n) => [`workspace.jump.${n}`, () => jumpToWorkspace(n - 1)])),
};

/** Create a blank tab and move it into its own browser window. */
async function openWindow() {
  const workspace = useBrowser.getState().activeWorkspace;
  if (!workspace) return;
  try {
    const tab = await ipc.tabOpen(workspace, "about:blank");
    await ipc.tabDetach(tab.id, null);
    useBrowser.setState({ error: null });
  } catch (error) {
    useBrowser.setState({ error: message(error) });
  }
}

/** Toggle the active page's bookmark and confirm the result visibly. */
async function toggleBookmark() {
  const tab = useBrowser.getState().activeTab;
  if (!tab) return;
  try {
    const saved = await ipc.bookmarkToggle(tab);
    useBrowser.setState({ error: null, notice: saved ? "Bookmark saved" : "Bookmark removed" });
    setTimeout(() => useBrowser.setState({ notice: null }), 3000);
  } catch (error) {
    useBrowser.setState({ error: message(error) });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Activate the workspace sitting at `index` in the rail, if there is one. */
function jumpToWorkspace(index: number) {
  const { workspaces, activeWorkspace, activateWorkspace, activeProfile } = useBrowser.getState();
  const target = workspaces.filter((w) => !activeProfile || w.profile_id === activeProfile)[index];
  return target && target.id !== activeWorkspace ? activateWorkspace(target.id) : undefined;
}

/** Asks the toolbar to select its address field; the Toolbar listens for it. */
export const FOCUS_ADDRESS = "dive:focus-address";

/** Activate the tab `delta` places away, wrapping at both ends. */
function stepTab(delta: number) {
  const { tabs, activeTab, activateTab } = useBrowser.getState();
  if (tabs.length === 0) return;
  const from = tabs.findIndex((t) => t.id === activeTab);
  const next = tabs[(((from < 0 ? 0 : from + delta) % tabs.length) + tabs.length) % tabs.length];
  return next ? activateTab(next.id) : undefined;
}

export function runCommand(id: string): void {
  const handler = UI_COMMANDS[id];
  if (handler) {
    void handler();
    return;
  }
  void ipc.commandRun(id).catch((e: unknown) => {
    useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
  });
}

/** Default chords, parsed from the same notation Rust reports ("mod+shift+s"). */
export const SHORTCUTS: Record<string, string> = {
  "mod+k": "palette.open",
  "mod+shift+a": "tabs.search",
  "mod+n": "window.new",
  "mod+t": "tab.new",
  "mod+w": "tab.close",
  "mod+r": "tab.reload",
  "mod+alt+i": "tab.devtools",
  "mod+shift+b": "report.compose",
  "mod+shift+r": "screencast.toggle",
  "mod+=": "zoom.in",
  "mod+-": "zoom.out",
  "mod+0": "zoom.reset",
  "mod+j": "sidecar.toggle",
  "mod+shift+d": "dock.toggle",
  "mod+shift+m": "simulator.toggle",
  "mod+shift+u": "subtitles.open",
  "mod+shift+s": "capture.fullpage",
  "mod+f": "find.open",
  "mod+d": "bookmark.toggle",
  "mod+y": "history.open",
  "mod+alt+b": "bookmarks.open",
  "mod+shift+j": "downloads.open",
  "mod+shift+backspace": "browsing-data.open",
  "mod+shift+delete": "browsing-data.open",
  "mod+/": "shortcuts.open",
  "mod+,": "settings.open",
  "mod+p": "tab.print",
  "mod+shift+f": "tab.fillVideo",
  "mod+l": "address.focus",
  "mod+[": "tab.back",
  "mod+]": "tab.forward",
  "mod+shift+[": "tab.prev",
  "mod+shift+]": "tab.next",
  "ctrl+tab": "tab.next",
  "ctrl+shift+tab": "tab.prev",
  "mod+shift+n": "workspace.new",
  "mod+shift+e": "workspace.edit",
  ...Object.fromEntries(WORKSPACE_SLOTS.map((n) => [`mod+${n}`, `workspace.jump.${n}`])),
};

/**
 * What every chrome-side command is called, for the palette and the shortcut
 * cheatsheet. The host's registry names the ones it knows about; these cover
 * the ids that never reach it.
 */
export const COMMAND_TITLES: Record<string, string> = {
  "palette.open": "Command palette",
  "tabs.search": "Search tabs",
  "window.new": "New window",
  "tab.new": "New tab",
  "tab.close": "Close tab",
  "tab.reload": "Reload",
  "tab.stop": "Stop loading",
  "tab.print": "Print…",
  "tab.fillVideo": "Fill tab with video",
  "tab.devtools": "Open DevTools",
  "report.compose": "Copy bug report",
  "screencast.toggle": "Record tab / stop",
  "zoom.in": "Zoom in",
  "zoom.out": "Zoom out",
  "zoom.reset": "Reset zoom",
  "sidecar.toggle": "Toggle agent sidecar",
  "dock.toggle": "Toggle dev dock",
  "simulator.toggle": "Toggle device simulator",
  "subtitles.open": "Live subtitles",
  "capture.fullpage": "Capture full page",
  "find.open": "Find in page",
  "address.focus": "Focus the address bar",
  "library.open": "Library: bookmarks and history",
  "bookmarks.open": "Bookmarks",
  "history.open": "History",
  "downloads.open": "Downloads",
  "browsing-data.open": "Delete browsing data…",
  "bookmark.toggle": "Bookmark this page",
  "shortcuts.open": "Keyboard shortcuts",
  "settings.open": "Settings",
  "tab.back": "Back",
  "tab.forward": "Forward",
  "tab.prev": "Previous tab",
  "tab.next": "Next tab",
  "workspace.new": "New workspace",
  "workspace.edit": "Edit current workspace",
  ...Object.fromEntries(WORKSPACE_SLOTS.map((n) => [`workspace.jump.${n}`, `Switch to workspace ${n}`])),
};

/** The first chord bound to each command, by command id. */
export function chordsByCommand(shortcuts: Record<string, string> = SHORTCUTS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [chord, id] of Object.entries(shortcuts)) out[id] ??= chord;
  return out;
}

/**
 * Commands that run in the chrome and that the host's registry does not
 * list, so the palette has to add them itself. Anything the host already
 * names is left out to avoid two rows for one command.
 */
export function chromeCommands(known: Command[] = []): Command[] {
  const seen = new Set(known.map((c) => c.id));
  const chords = chordsByCommand();
  return Object.keys(UI_COMMANDS)
    .filter((id) => !seen.has(id) && id in COMMAND_TITLES && !id.startsWith("workspace.jump."))
    .map((id) => ({ id, title: COMMAND_TITLES[id]!, keybinding: chords[id] ?? null, scope: "global" as const }));
}

const MAC_GLYPHS: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", meta: "⌘" };
const OTHER_NAMES: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", meta: "Win" };
const KEY_NAMES: Record<string, string> = { tab: "Tab", escape: "Esc", enter: "↵", backspace: "⌫", delete: "⌦", space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn" };

/**
 * A chord in the notation people read: "mod+shift+s" is ⌘⇧S on a Mac and
 * Ctrl+Shift+S elsewhere.
 */
export function formatChord(chord: string, mac: boolean = isMac()): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  // The chrome's own tooltips spell ⌘⇧S and ⌘⌥I, so the platform key leads.
  const order = ["mod", "meta", "ctrl", "alt", "shift"];
  const mods = parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const keyName = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  if (mac) return mods.map((m) => MAC_GLYPHS[m] ?? m).join("") + keyName;
  return [...mods.map((m) => OTHER_NAMES[m] ?? m), keyName].join("+");
}

/**
 * Browser-global chords that keep working while the omnibox or another field
 * has focus. Everything else is the field's own business there: ⌘A selects
 * its text, Enter submits it, and a bare letter is typing.
 */
const CHORDS_IN_FIELDS = new Set([
  "mod+l",
  "mod+k",
  "mod+n",
  "mod+t",
  "mod+w",
  "mod+r",
  "mod+d",
  "mod+y",
  "mod+alt+b",
  "mod+shift+a",
  "mod+shift+j",
  "mod+shift+t",
  "mod+shift+backspace",
  "mod+shift+delete",
  "mod+shift+[",
  "mod+shift+]",
  "ctrl+tab",
  "ctrl+shift+tab",
]);

/** Keys that are not characters but still make sense in a chord. */
const NAMED_KEYS = new Set(["escape", "enter", "tab", "backspace", "delete", "home", "end", "pageup", "pagedown", "arrowleft", "arrowright", "arrowup", "arrowdown", "space"]);

/** `mod` is ⌘ on macOS and Ctrl elsewhere; the other one is spelled out. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Whether a key event happened inside something the user types into. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // jsdom never fills in `isContentEditable`; the attribute is the fallback.
  if (typeof target.isContentEditable === "boolean") return target.isContentEditable;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * The chord for a key event in the notation Rust reports ("mod+shift+s"), or
 * null when the event is not one: a bare character, a modifier on its own.
 * A named key (Escape, F5, Tab…) is a chord even without a modifier.
 */
export function chordOf(e: KeyboardEvent): string | null {
  const key = keyOf(e);
  if (!key) return null;
  const mac = isMac();
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  const named = key.length > 1;
  if (!mod && !other && !named) return null;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (other) parts.push(mac ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** The key's name for a chord, or null when it cannot be part of one. */
function keyOf(e: KeyboardEvent): string | null {
  // Shift changes what `key` reports for punctuation (⌘⇧] arrives as "}"),
  // so the brackets go by physical position.
  if (e.code === "BracketLeft") return "[";
  if (e.code === "BracketRight") return "]";
  const key = e.key;
  if (key === " ") return "space";
  if (key.length === 1) return key.toLowerCase();
  const lower = key.toLowerCase();
  if (NAMED_KEYS.has(lower) || /^f\d{1,2}$/.test(lower)) return lower;
  return null;
}

/**
 * The command a key event should run, or null. Inside a field only the
 * explicitly global browser chords apply.
 */
export function shortcutFor(e: KeyboardEvent, shortcuts: Record<string, string> = SHORTCUTS): string | null {
  const chord = chordOf(e);
  if (!chord) return null;
  if (isEditable(e.target) && !CHORDS_IN_FIELDS.has(chord)) return null;
  return shortcuts[chord] ?? null;
}
