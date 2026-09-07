import { create } from "zustand";
import { errorMessage } from "../lib/errors";
import { ipc } from "../lib/ipc";
import type { ImportSource, ImportSummary } from "../lib/ipc";

/** What the last import brought in, and from where. */
export interface ImportOutcome {
  source: ImportSource;
  summary: ImportSummary;
}

interface BrowserImportState {
  /** `null` until the first look; then every browser profile found. */
  sources: ImportSource[] | null;
  loading: boolean;
  selected: string | null;
  bookmarks: boolean;
  history: boolean;
  importing: boolean;
  outcome: ImportOutcome | null;
  error: string | null;
  /** The browser the dialog should start on, set by whoever opens it. */
  preferBrowser: string | null;
  setPreferBrowser: (browser: string | null) => void;
  /** Look for browsers; `prefer` picks a browser id (`brave`) when it is there. */
  load: (prefer?: string) => Promise<void>;
  select: (id: string) => void;
  setBookmarks: (v: boolean) => void;
  setHistory: (v: boolean) => void;
  /** Ask macOS for the folder; the source comes back with its access re-checked. */
  grant: (id: string) => Promise<void>;
  openPrivacySettings: () => Promise<void>;
  run: () => Promise<void>;
  reset: () => void;
}

/** The bundle id macOS reports as the default browser, as our browser id. */
export function browserForBundle(bundleId: string | null | undefined): string | null {
  switch ((bundleId ?? "").toLowerCase()) {
    case "com.google.chrome":
      return "chrome";
    case "com.brave.browser":
      return "brave";
    case "com.microsoft.edgemac":
      return "edge";
    case "company.thebrowser.browser":
      return "arc";
    case "com.vivaldi.vivaldi":
      return "vivaldi";
    case "com.operasoftware.opera":
      return "opera";
    case "org.chromium.chromium":
      return "chromium";
    case "org.mozilla.firefox":
      return "firefox";
    case "com.apple.safari":
      return "safari";
    default:
      return null;
  }
}

/**
 * The row to start on: the preferred browser, else the first that can be
 * read, else the first whose app is still installed (a data folder can
 * outlive its browser), else the first.
 */
export function pickSource(sources: ImportSource[], prefer?: string | null): string | null {
  const preferred = prefer ? sources.find((s) => s.browser === prefer) : undefined;
  return (preferred ?? sources.find((s) => s.access === "ok") ?? sources.find((s) => s.icon) ?? sources[0])?.id ?? null;
}

export const useBrowserImport = create<BrowserImportState>((set, get) => ({
  sources: null,
  loading: false,
  selected: null,
  bookmarks: true,
  history: true,
  importing: false,
  outcome: null,
  error: null,
  preferBrowser: null,
  setPreferBrowser: (preferBrowser) => set({ preferBrowser }),
  load: async (prefer) => {
    set({ loading: true, error: null });
    try {
      const sources = await ipc.browserImportSources();
      // Whoever opened the panel with a browser in mind wins over a row
      // picked earlier; otherwise an earlier pick survives a reload.
      const current = get().selected;
      const wanted = prefer && sources.some((s) => s.browser === prefer);
      const selected = !wanted && current && sources.some((s) => s.id === current) ? current : pickSource(sources, prefer);
      set({ sources, selected, loading: false });
    } catch (e) {
      set({ sources: [], loading: false, error: errorMessage(e) });
    }
  },
  select: (selected) => set({ selected, outcome: null, error: null }),
  setBookmarks: (bookmarks) => set({ bookmarks }),
  setHistory: (history) => set({ history }),
  grant: async (id) => {
    set({ error: null });
    try {
      const updated = await ipc.browserImportGrant(id);
      if (!updated) return;
      set((s) => ({ sources: (s.sources ?? []).map((x) => (x.id === updated.id ? updated : x)), selected: updated.id }));
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },
  openPrivacySettings: async () => {
    try {
      await ipc.browserImportOpenPrivacy();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },
  run: async () => {
    const { selected, sources, bookmarks, history, importing } = get();
    const source = sources?.find((s) => s.id === selected);
    if (!source || importing || (!bookmarks && !history)) return;
    set({ importing: true, error: null, outcome: null });
    try {
      const summary = await ipc.browserImportRun(source.id, bookmarks, history);
      set({ importing: false, outcome: { source, summary } });
    } catch (e) {
      set({ importing: false, error: errorMessage(e) });
    }
  },
  reset: () => set({ outcome: null, error: null }),
}));
