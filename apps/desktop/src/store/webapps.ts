import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { WebApp, WebAppProbe } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { forgetWebAppIcon } from "../lib/useWebAppIcon";

/** Fired on `window` when the installed apps change, so lists and buttons refresh. */
export const WEBAPPS_CHANGED = "dive-webapps-changed";

/** What the address bar knows about one tab's page: probed once per URL. */
export interface TabProbe {
  url: string;
  probe: WebAppProbe | null;
}

interface WebAppsState {
  /** Installed apps for the profile, most recently opened first. */
  apps: WebApp[];
  loaded: boolean;
  /** The last probe per tab, keyed by tab id, remembered with the URL it was for. */
  probes: Record<string, TabProbe>;
  /** True while an install is in flight; the dialog disables its button. */
  installing: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Probe `tabId` at `url`; a repeat for the same URL is answered from memory. */
  probe: (tabId: string, url: string) => Promise<WebAppProbe | null>;
  forgetTab: (tabId: string) => void;
  install: (tabId: string) => Promise<WebApp | null>;
  open: (appId: string) => Promise<void>;
  uninstall: (appId: string) => Promise<void>;
}

function announce() {
  window.dispatchEvent(new Event(WEBAPPS_CHANGED));
}

export const useWebApps = create<WebAppsState>((set, get) => ({
  apps: [],
  loaded: false,
  probes: {},
  installing: false,
  error: null,

  load: async () => {
    try {
      const apps = await ipc.webappsList();
      set({ apps, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  },

  probe: async (tabId, url) => {
    const known = get().probes[tabId];
    if (known && known.url === url) return known.probe;
    // Only http(s) pages have manifests; skipping the round trip keeps the
    // chrome quiet on internal pages and blank tabs.
    if (!/^https?:\/\//.test(url)) {
      set((s) => ({ probes: { ...s.probes, [tabId]: { url, probe: null } } }));
      return null;
    }
    try {
      const probe = await ipc.webappProbe(tabId);
      // The tab may have moved on while the probe ran; the result belongs
      // to the URL it was asked for, not wherever the tab is now.
      set((s) => ({ probes: { ...s.probes, [tabId]: { url, probe } } }));
      return probe;
    } catch {
      set((s) => ({ probes: { ...s.probes, [tabId]: { url, probe: null } } }));
      return null;
    }
  },

  forgetTab: (tabId) =>
    set((s) => {
      if (!(tabId in s.probes)) return s;
      const probes = { ...s.probes };
      delete probes[tabId];
      return { probes };
    }),

  install: async (tabId) => {
    if (get().installing) return null;
    set({ installing: true, error: null });
    try {
      const app = await ipc.webappInstall(tabId);
      // The tab became the app's window, so its probe is stale on purpose.
      get().forgetTab(tabId);
      await get().load();
      announce();
      return app;
    } catch (e) {
      set({ error: errorMessage(e) });
      return null;
    } finally {
      set({ installing: false });
    }
  },

  open: async (appId) => {
    try {
      await ipc.webappOpen(appId);
      await get().load();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  uninstall: async (appId) => {
    try {
      await ipc.webappUninstall(appId);
      forgetWebAppIcon(appId);
      // Any tab that resolved to this app should be asked again.
      set({ probes: {} });
      await get().load();
      announce();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },
}));

/** Whether `url` is inside `scope`: a prefix match on the absolute URL, as the spec defines it. */
export function inScope(url: string, scope: string): boolean {
  return url.startsWith(scope);
}

/** The origin of a URL for display, or the URL itself when it is not one. */
export function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
