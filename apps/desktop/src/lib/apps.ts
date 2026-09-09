import { Bot, Bug, Captions, Camera, KeyRound, LibraryBig, PanelBottom, Puzzle, ScrollText, ShieldCheck, Smartphone, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { COMMAND_TITLES, chordsByCommand, formatChord, runCommand } from "./commands";
import { isPrivateWindow } from "./privateMode";

/**
 * Dive's apps: the named tools that make it more than a browser, one card
 * each, with a line on what it is for and the shortcut that reaches it.
 * Commands (find, print, new window, settings) are not apps and stay in
 * the menu and the palette. Each card runs a registry command, so this
 * list cannot drift from what the menus do.
 */
export type AppCategory = "capture" | "page" | "developer" | "yours";

export const APP_CATEGORIES: { id: AppCategory; name: string }[] = [
  { id: "capture", name: "Capture" },
  { id: "page", name: "On the page" },
  { id: "developer", name: "Developer" },
  { id: "yours", name: "Yours" },
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
  { id: "divescreen", name: "DiveScreen", blurb: "Record a tab as video or GIF, then crop, zoom and polish it into a demo.", icon: Video, category: "capture", command: "screencast.toggle", keywords: "record screen loom demo gif video", needsTab: true },
  { id: "screenshot", name: "Screenshot", blurb: "Capture the full page and annotate it.", icon: Camera, category: "capture", command: "capture.fullpage", keywords: "snapshot image annotate capture", needsTab: true },
  { id: "recorder", name: "Test recorder", blurb: "Turn what you do in a tab into a Playwright test.", icon: ScrollText, category: "capture", command: "recorder.toggle", keywords: "playwright e2e spec steps macro", needsTab: true },
  { id: "agent", name: "Agent", blurb: "A model that reads and operates the page beside you, with your own key or a local model.", icon: Bot, category: "page", command: "sidecar.toggle", keywords: "ai assistant chat claude ollama" },
  { id: "subtitles", name: "Live subtitles", blurb: "Captions for any video, transcribed on this machine.", icon: Captions, category: "page", command: "subtitles.open", keywords: "captions transcribe whisper", needsTab: true },
  { id: "dock", name: "Developer dock", blurb: "Network, console, storage, accessibility, vitals and mock rules, beside the page.", icon: PanelBottom, category: "developer", command: "dock.toggle", keywords: "console network har mock rules a11y vitals storage" },
  { id: "devtools", name: "DevTools", blurb: "Chrome's full inspector, in its own window.", icon: Bug, category: "developer", command: "tab.devtools", keywords: "inspect elements", needsTab: true },
  { id: "simulator", name: "Device simulator", blurb: "Phones and tablets with real frames, touch and throttling.", icon: Smartphone, category: "developer", command: "simulator.toggle", keywords: "mobile responsive emulate iphone", needsTab: true },
  { id: "extensions", name: "Extensions", blurb: "Chrome extensions loaded into Dive.", icon: Puzzle, category: "developer", command: "extensions.open", keywords: "addons plugins" },
  { id: "privacy", name: "DivePrivacy", blurb: "Ads, trackers and fingerprinting blocked in the engine, with per-site controls.", icon: ShieldCheck, category: "yours", command: "settings.privacy", keywords: "tracking blocker ads shield" },
  { id: "passwords", name: "Passwords & forms", blurb: "Saved logins and form entries, kept in the Keychain.", icon: KeyRound, category: "yours", command: "settings.passwords", keywords: "logins autofill keychain" },
  { id: "library", name: "Library", blurb: "Bookmarks, history, downloads and recordings, by profile.", icon: LibraryBig, category: "yours", command: "library.open", keywords: "bookmarks history downloads recordings" },
];

/** Registry ids some cards run that the command list itself does not carry. */
const EXTRA: Record<string, () => void> = {};

/** Register a chrome-side action for a card whose command lives outside the registry. */
export function registerAppAction(command: string, run: () => void) {
  EXTRA[command] = run;
}

/** The cards this window can show: a private window keeps its own list short. */
export function appsFor(privateWindow = isPrivateWindow()): AppEntry[] {
  const refused = new Set(["sidecar.toggle", "extensions.open", "subtitles.open", "settings.passwords", "library.open"]);
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
