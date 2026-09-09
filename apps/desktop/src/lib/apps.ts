import { Bug, Camera, Captions, Clapperboard, Code, Download, Film, History, Import, Keyboard, KeyRound, LayoutPanelTop, PanelBottom, Puzzle, QrCode, ScrollText, Search, Settings2, Shield, ShieldCheck, Smartphone, Star, Trash2, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { COMMAND_TITLES, chordsByCommand, formatChord, runCommand } from "./commands";
import { isPrivateWindow } from "./privateMode";

/**
 * Everything Dive can do, as the Apps launcher shows it: one card per
 * feature with a name that matches the menus, a line on what it is for, and
 * the shortcut that reaches it. Each card runs a command from the registry,
 * so this list can never drift from what the palette and the menus do.
 */
export type AppCategory = "capture" | "page" | "developer" | "privacy" | "library" | "dive";

export const APP_CATEGORIES: { id: AppCategory; name: string }[] = [
  { id: "capture", name: "Capture" },
  { id: "page", name: "On the page" },
  { id: "developer", name: "Developer" },
  { id: "privacy", name: "Privacy" },
  { id: "library", name: "Library" },
  { id: "dive", name: "Dive" },
];

export interface AppEntry {
  id: string;
  name: string;
  /** One line on what it does, in the person's words. */
  blurb: string;
  icon: LucideIcon;
  category: AppCategory;
  /** The registry command it runs. */
  command: string;
  /** Words the search also matches. */
  keywords?: string;
  /** Needs a page to act on. */
  needsTab?: boolean;
}

const APPS: AppEntry[] = [
  { id: "divescreen", name: "DiveScreen", blurb: "Record a tab as video or GIF, then crop, zoom and polish it.", icon: Video, category: "capture", command: "screencast.toggle", keywords: "record screen loom demo gif", needsTab: true },
  { id: "screenshot", name: "Screenshot", blurb: "Capture the full page and annotate it.", icon: Camera, category: "capture", command: "capture.fullpage", keywords: "snapshot image annotate", needsTab: true },
  { id: "steps", name: "Record steps", blurb: "Turn what you do in a tab into a Playwright test.", icon: ScrollText, category: "capture", command: "recorder.toggle", keywords: "playwright e2e spec macro", needsTab: true },
  { id: "recordings", name: "Recordings", blurb: "Everything you have recorded, ready to edit or share.", icon: Clapperboard, category: "capture", command: "recordings.open", keywords: "videos gifs" },
  { id: "agent", name: "Agent", blurb: "A model that reads and operates the page beside you.", icon: Code, category: "page", command: "sidecar.toggle", keywords: "ai assistant chat claude" },
  { id: "subtitles", name: "Live subtitles", blurb: "Captions for any video, transcribed on this machine.", icon: Captions, category: "page", command: "subtitles.open", keywords: "captions transcribe whisper", needsTab: true },
  { id: "share", name: "Share to your phone", blurb: "A QR code and address for the page you are on.", icon: QrCode, category: "page", command: "share.open", keywords: "qr code send", needsTab: true },
  { id: "find", name: "Find in page", blurb: "Search the text of the page.", icon: Search, category: "page", command: "find.open", needsTab: true },
  { id: "dock", name: "Developer dock", blurb: "Network, console, storage, accessibility, vitals and rules, beside the page.", icon: PanelBottom, category: "developer", command: "dock.toggle", keywords: "console network har mock rules a11y vitals" },
  { id: "devtools", name: "DevTools", blurb: "Chrome's full inspector, in its own window.", icon: Bug, category: "developer", command: "tab.devtools", keywords: "inspect elements", needsTab: true },
  { id: "simulator", name: "Device simulator", blurb: "Phones and tablets with real frames, touch and throttling.", icon: Smartphone, category: "developer", command: "simulator.toggle", keywords: "mobile responsive emulate iphone", needsTab: true },
  { id: "extensions", name: "Extensions", blurb: "Chrome extensions loaded into Dive.", icon: Puzzle, category: "developer", command: "extensions.open", keywords: "addons plugins" },
  { id: "report", name: "Bug report", blurb: "Copy a report with the console, requests and a screenshot.", icon: LayoutPanelTop, category: "developer", command: "report.compose", keywords: "issue compose", needsTab: true },
  { id: "privacy", name: "DivePrivacy", blurb: "Ads, trackers and fingerprinting blocked in the engine, per site.", icon: ShieldCheck, category: "privacy", command: "settings.privacy", keywords: "tracking blocker ads" },
  { id: "passwords", name: "Passwords & forms", blurb: "Saved logins and form entries, kept in the Keychain.", icon: KeyRound, category: "privacy", command: "settings.passwords", keywords: "logins autofill keychain" },
  { id: "private", name: "Private window", blurb: "A window that forgets everything when it closes.", icon: Shield, category: "privacy", command: "window.private", keywords: "incognito" },
  { id: "clear", name: "Clear browsing data", blurb: "Cookies, cache and history, by profile.", icon: Trash2, category: "privacy", command: "browsing-data.open", keywords: "cookies cache delete" },
  { id: "bookmarks", name: "Bookmarks", blurb: "Pages you kept.", icon: Star, category: "library", command: "bookmarks.open", keywords: "favorites saved" },
  { id: "history", name: "History", blurb: "Where you have been, by profile.", icon: History, category: "library", command: "history.open", keywords: "visited recent" },
  { id: "downloads", name: "Downloads", blurb: "Files this session saved, and where they went.", icon: Download, category: "library", command: "downloads.open", keywords: "files" },
  { id: "import", name: "Import browser data", blurb: "Bookmarks, history, passwords and form entries from Chrome, Brave, Safari or Firefox.", icon: Import, category: "library", command: "import.open", keywords: "migrate chrome brave safari firefox" },
  { id: "editor", name: "Open a video in DiveScreen", blurb: "Edit an MP4, MOV, WebM or GIF from disk.", icon: Film, category: "capture", command: "divescreen.import", keywords: "video file editor" },
  { id: "settings", name: "Settings", blurb: "Startup, search, appearance, agent providers and more.", icon: Settings2, category: "dive", command: "settings.open", keywords: "preferences options" },
  { id: "shortcuts", name: "Keyboard shortcuts", blurb: "Every chord Dive answers to.", icon: Keyboard, category: "dive", command: "shortcuts.open", keywords: "keys hotkeys" },
  { id: "palette", name: "Command palette", blurb: "Type to reach any command, tab or address.", icon: Search, category: "dive", command: "palette.open", keywords: "search everything" },
];

/** Registry ids some cards run that the command list itself does not carry. */
const EXTRA: Record<string, () => void> = {};

/** Register a chrome-side action for a card whose command lives outside the registry. */
export function registerAppAction(command: string, run: () => void) {
  EXTRA[command] = run;
}

/** The cards this window can show: a private window keeps its own list short. */
export function appsFor(privateWindow = isPrivateWindow()): AppEntry[] {
  const refused = new Set(["sidecar.toggle", "extensions.open", "subtitles.open", "bookmarks.open", "history.open", "settings.passwords", "window.private", "import.open"]);
  return APPS.filter((a) => !privateWindow || !refused.has(a.command));
}

/** The shortcut a card shows, in the platform's notation, if its command has one. */
export function chordOf(app: AppEntry): string | undefined {
  const chord = chordsByCommand()[app.command];
  return chord ? formatChord(chord) : undefined;
}

/** Cards whose name, blurb, keywords or command title match `query`, in catalog order. */
export function searchApps(apps: AppEntry[], query: string): AppEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return apps;
  return apps.filter((a) => `${a.name} ${a.blurb} ${a.keywords ?? ""} ${COMMAND_TITLES[a.command] ?? ""}`.toLowerCase().includes(q));
}

/** Run a card. */
export function launchApp(app: AppEntry) {
  const extra = EXTRA[app.command];
  if (extra) extra();
  else runCommand(app.command);
}
