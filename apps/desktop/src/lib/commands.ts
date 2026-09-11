import { isPrivateWindow } from "./privateMode";
import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import { usePrefs } from "../store/prefs";
import { useRecording } from "../store/recording";
import { useRecorder } from "../store/recorder";
import { usePicker } from "../store/simulator";
import type { Command } from "./ipc";
import { traceInputCommand } from "./inputTimingProbe";
import { errorMessage } from "./errors";
import { orderTabs } from "./tabOrder";

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
  "tabs.search": () => useBrowser.getState().openPalette("tabs"),
  "tab.new": () => useBrowser.getState().toggle("palette", true),
  "window.new": () => openWindow(),
  "private.exit": () => ipc.windowExitPrivate().then(() => undefined).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) })),
  "window.private": () => ipc.windowPrivate().then(() => undefined).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) })),
  "tab.close": () => {
    const { activeTab, closeTab } = useBrowser.getState();
    return activeTab ? closeTab(activeTab) : (isPrivateWindow() ? ipc.windowClose().then(() => undefined) : undefined);
  },
  "tab.reopen": () => useBrowser.getState().reopenClosedTab(),
  "tab.pin": () => {
    const { tabs, activeTab, setPinned } = useBrowser.getState();
    const tab = tabs.find((t) => t.id === activeTab);
    return tab && tab.tier !== "essential" ? setPinned(tab.id, tab.tier !== "pinned") : undefined;
  },
  "tab.detach": () => {
    const { activeTab, detached, detachTab, attachTab } = useBrowser.getState();
    if (!activeTab) return;
    return detached.includes(activeTab) ? attachTab(activeTab) : detachTab(activeTab, null);
  },
  "tab.reload": () => useBrowser.getState().reload(),
  "tab.home": () => {
    // A configured home page is where Home goes; without one, the welcome screen.
    const homepage = usePrefs.getState().prefs.homepage.trim();
    const { activeTab, navigate, openTab, showHome } = useBrowser.getState();
    if (!homepage) return showHome();
    return activeTab ? navigate(homepage) : openTab(homepage);
  },
  "tab.devtools": () => useBrowser.getState().devtools(),
  "report.compose": () => useBrowser.getState().bugReport(),
  "screencast.toggle": () => useRecording.getState().toggle(),
  "zoom.in": () => useBrowser.getState().zoomStep(1),
  "zoom.out": () => useBrowser.getState().zoomStep(-1),
  "zoom.reset": () => useBrowser.getState().zoomStep(0),
  "sidecar.toggle": () => useBrowser.getState().toggle("sidecar"),
  "sidecar.open": () => useBrowser.getState().toggle("sidecar", true),
  "share.open": () => void window.dispatchEvent(new CustomEvent(OPEN_SHARE)),
  "dock.toggle": () => useBrowser.getState().toggle("dock"),
  // Open the dock straight at one panel: an app in the launcher should land
  // on its own tool, not on whichever panel was last used.
  "stack.open": () => {
    useLayout.getState().setDockPanel("stack");
    useBrowser.getState().toggle("dock", true);
  },
  "color.open": () => {
    useLayout.getState().setDockPanel("color");
    useBrowser.getState().toggle("dock", true);
  },
  "simulator.toggle": () => usePicker.getState().toggle(),
  "subtitles.open": () => useBrowser.getState().toggle("subtitles", true),
  // Records clicks and typing in the current tab as Playwright steps; the
  // second call stops and opens the spec.
  "recorder.toggle": async () => {
    const recorder = useRecorder.getState();
    if (recorder.recordingTab) {
      await recorder.stop();
      if (useRecorder.getState().steps.length === 0) useBrowser.getState().notify("Nothing was recorded. Click or type on the page while recording.", 5000);
      return;
    }
    const tab = useBrowser.getState().activeTab;
    if (!tab) {
      useBrowser.getState().notify("Open a tab to record steps in.");
      return;
    }
    await recorder.start(tab);
    if (useRecorder.getState().recordingTab === tab) useBrowser.getState().notify("Recording steps. Use the page, then choose Stop recording steps.", 5000);
  },
  "import.open": () => useBrowser.getState().toggle("import", true),
  "apps.open": () => useBrowser.getState().toggle("apps", true),
  "extensions.open": () => useBrowser.getState().toggle("extensions", true),
  "capture.fullpage": () => useBrowser.getState().capture(true),
  "find.open": () => useBrowser.getState().toggle("find", true),
  "library.open": () => useBrowser.getState().toggle("library", true),
  "bookmarks.open": () => useBrowser.getState().openLibrary("bookmarks"),
  "history.open": () => useBrowser.getState().openLibrary("history"),
  "downloads.open": () => useBrowser.getState().openLibrary("downloads"),
  "browsing-data.open": () => useBrowser.getState().openSettings("privacy", "clear-browsing-data"),
  "bookmark.toggle": () => toggleBookmark(),
  "shortcuts.open": () => useBrowser.getState().toggle("shortcuts", true),
  "settings.open": () => useBrowser.getState().openSettings(),
  "settings.general": () => useBrowser.getState().openSettings("general"),
  "settings.appearance": () => useBrowser.getState().openSettings("appearance"),
  "settings.privacy": () => useBrowser.getState().openSettings("privacy"),
  "settings.passwords": () => useBrowser.getState().openSettings("passwords"),
  "settings.developer": () => useBrowser.getState().openSettings("developer"),
  "settings.agent": () => useBrowser.getState().openSettings("agent"),
  "settings.subtitles": () => useBrowser.getState().openSettings("subtitles"),
  "default-browser.open": () => useBrowser.getState().toggle("defaultBrowser", true),
  "about.open": () => useBrowser.getState().openSettings("about"),
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
  try {
    await ipc.windowOpen();
    useBrowser.setState({ error: null });
  } catch (error) {
    useBrowser.setState({ error: errorMessage(error) });
  }
}

/** Toggle the active page's bookmark and confirm the result visibly. */
async function toggleBookmark() {
  const tab = useBrowser.getState().activeTab;
  if (!tab) return;
  try {
    const saved = await ipc.bookmarkToggle(tab);
    window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED));
    useBrowser.setState({ error: null });
    // Saved from the keyboard, the name is the page's; offer the popover to change it.
    if (saved) useBrowser.getState().notify("Bookmark saved", 4000, { label: "Edit", run: () => window.dispatchEvent(new CustomEvent(EDIT_BOOKMARK)) });
    else useBrowser.getState().notify("Bookmark removed");
  } catch (error) {
    useBrowser.setState({ error: errorMessage(error) });
  }
}

/** Activate the workspace sitting at `index` in the rail, if there is one. */
function jumpToWorkspace(index: number) {
  const { workspaces, activeWorkspace, activateWorkspace, activeProfile } = useBrowser.getState();
  const target = workspaces.filter((w) => !activeProfile || w.profile_id === activeProfile)[index];
  return target && target.id !== activeWorkspace ? activateWorkspace(target.id) : undefined;
}

/** Asks the toolbar to select its address field; the Toolbar listens for it. */
export const FOCUS_ADDRESS = "dive:focus-address";
/** Open the star's popover on the active page's bookmark (the notice's Edit action). */
export const EDIT_BOOKMARK = "dive:edit-bookmark";
/** Opens the share popover (QR code and LAN address) for the current page. */
export const OPEN_SHARE = "dive:open-share";
/** A bookmark was added, renamed or removed somewhere; anything showing bookmark state re-reads it. */
export const BOOKMARKS_CHANGED = "dive:bookmarks-changed";

/**
 * Activate the tab `delta` places away, wrapping at both ends. Walks the
 * strip's order (pinned first, then by position) and skips tabs that live in
 * their own window, so the chord lands where the eye expects.
 */
function stepTab(delta: number) {
  const { tabs: all, detached, activeTab, activateTab } = useBrowser.getState();
  const tabs = orderTabs(all).filter((t) => !detached.includes(t.id));
  if (tabs.length === 0) return;
  const from = tabs.findIndex((t) => t.id === activeTab);
  const next = tabs[(((from < 0 ? 0 : from + delta) % tabs.length) + tabs.length) % tabs.length];
  return next ? activateTab(next.id) : undefined;
}

/** Commands a private window refuses; the menu and palette hide them too. */
const PRIVATE_REFUSED = ["sidecar.toggle", "sidecar.open", "extensions.open", "workspace.new", "bookmark.toggle", "subtitles.open", "bookmarks.open", "history.open", "settings.passwords", "settings.agent", "settings.subtitles", "default-browser.open"];

export function runCommand(id: string, source: "keyboard" | "native-menu" | "command" = "command"): void {
  traceInputCommand(id, source);
  if (isPrivateWindow() && PRIVATE_REFUSED.includes(id)) {
    useBrowser.getState().notify("Use a normal window for this action.");
    return;
  }
  const handler = UI_COMMANDS[id];
  if (handler) {
    void handler();
    return;
  }
  void ipc.commandRun(id).catch((e: unknown) => {
    useBrowser.setState({ error: errorMessage(e) });
  });
}

/** Default chords, parsed from the same notation Rust reports ("mod+shift+s"). */
export const SHORTCUTS: Record<string, string> = {
  // The toolbar advertises Esc on the stop button. It is dispatched only when
  // nothing else owns the key -- see `useShortcuts`.
  escape: "tab.stop",
  "mod+k": "palette.open",
  "mod+shift+space": "apps.open",
  "mod+shift+a": "tabs.search",
  "mod+n": "window.new",
  "mod+t": "tab.new",
  "mod+w": "tab.close",
  "mod+shift+p": "tab.pin",
  "mod+shift+t": "tab.reopen",
  // ⇧⌘N opens a private window; detaching a tab keeps the ⌥ variant.
  "mod+alt+n": "tab.detach",
  "mod+r": "tab.reload",
  "mod+shift+h": "tab.home",
  "mod+alt+i": "tab.devtools",
  "mod+shift+b": "report.compose",
  "mod+shift+r": "screencast.toggle",
  "mod+=": "zoom.in",
  // ⌘+ is ⌘⇧= on most keyboards, and + on a numeric keypad.
  "mod+shift+=": "zoom.in",
  "mod++": "zoom.in",
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
  "mod+shift+n": "window.private",
  "mod+alt+shift+n": "workspace.new",
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
  "apps.open": "Apps: everything Dive can do",
  "extensions.open": "Extensions",
  "tabs.search": "Search tabs",
  "window.new": "New window",
  "window.private": "New private window",
  "private.exit": "Exit private mode",
  "tab.new": "New tab",
  "tab.close": "Close tab",
  "tab.pin": "Pin or unpin tab",
  "tab.reopen": "Reopen closed tab",
  "tab.detach": "Move tab to its own window",
  "tab.reload": "Reload",
  "tab.home": "Home",
  "tab.stop": "Stop loading",
  "tab.print": "Print…",
  "tab.fillVideo": "Fill tab with video",
  "tab.devtools": "Open DevTools",
  "report.compose": "Copy bug report",
  "screencast.toggle": "Record a video",
  "zoom.in": "Zoom in",
  "zoom.out": "Zoom out",
  "zoom.reset": "Reset zoom",
  "sidecar.toggle": "Agent",
  "sidecar.open": "Open the agent",
  "share.open": "Share this page: QR code and address for your phone",
  "dock.toggle": "Developer dock",
  "stack.open": "Tech stack",
  "color.open": "Colour picker",
  "simulator.toggle": "Device simulator",
  "subtitles.open": "Live subtitles",
  "recorder.toggle": "Record steps as a Playwright test",
  "import.open": "Import from another browser: bookmarks, history, passwords, form entries…",
  "capture.fullpage": "Capture full page",
  "find.open": "Find in page",
  "address.focus": "Focus the address bar",
  "library.open": "Library: bookmarks and history",
  "bookmarks.open": "Bookmarks",
  "history.open": "History",
  "downloads.open": "Downloads",
  "browsing-data.open": "Clear browsing data…",
  "bookmark.toggle": "Bookmark this page",
  "shortcuts.open": "Keyboard shortcuts",
  "settings.open": "Settings",
  "settings.general": "Settings: General (startup, search, zoom)",
  "settings.appearance": "Settings: Appearance (theme, accent, density)",
  "settings.privacy": "Settings: Privacy (tracking, permissions, clear data)",
  "settings.passwords": "Settings: Passwords & forms (saved logins, form entries, never saved)",
  "settings.developer": "Settings: Developer (dev servers, dock)",
  "settings.agent": "Settings: Agent (model providers, keys)",
  "settings.subtitles": "Settings: Live subtitles",
  "default-browser.open": "Make Dive the default browser…",
  "about.open": "About Dive",
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
    .filter((id) => !seen.has(id) && id in COMMAND_TITLES && !id.startsWith("workspace.jump.") && (id !== "private.exit" || isPrivateWindow()) && !(isPrivateWindow() && PRIVATE_REFUSED.includes(id)))
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
 * A chord written in macOS glyphs, spelled for the platform it is shown on.
 *
 * Most of the chrome writes its shortcuts inline as `⌘R` rather than going
 * through `formatChord`, which is fine on macOS and wrong everywhere else: a
 * Windows build was telling people to press ⌘T. Translating at the point of
 * display fixes every one of those at once, and leaves a chord that is
 * already plain text alone.
 */
export function displayChord(chord: string, mac: boolean = isMac()): string {
  if (mac) return chord;
  const named: Record<string, string> = { "⌘": "Ctrl+", "⌃": "Ctrl+", "⌥": "Alt+", "⇧": "Shift+" };
  const spelled = chord.replace(/[⌘⌃⌥⇧]/g, (glyph) => named[glyph] ?? glyph);
  // ⌫ and ⌦ are glyphs for keys Windows spells out.
  return spelled.replace(/⌫/g, "Backspace").replace(/⌦/g, "Delete").replace(/⎋/g, "Esc");
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
  // Zoom is about the page, never the field, so it applies while the menu,
  // the palette or the find bar holds focus, as it does in Chrome.
  "mod+=",
  "mod+shift+=",
  "mod++",
  "mod+-",
  "mod+0",
]);

/** Keys that are not characters but still make sense in a chord. */
const NAMED_KEYS = new Set(["escape", "enter", "tab", "backspace", "delete", "home", "end", "pageup", "pagedown", "arrowleft", "arrowright", "arrowup", "arrowdown", "space"]);

/** `mod` is ⌘ on macOS and Ctrl elsewhere; the other one is spelled out. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Whether the chrome is drawing its own window controls.
 *
 * macOS has traffic lights in the frame; Windows would give us a second title
 * bar above our own, so the frame is off there and the chrome draws the
 * controls itself.
 */
export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/.test(navigator.platform || navigator.userAgent);
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
  // ⌘⇧= is how "⌘+" is typed; report the key, not the shifted character.
  if (e.code === "Equal") return "=";
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
