import { create } from "zustand";
import { DEVICES, customDevice, rotate } from "../data/devices";
import type { DevicePreset } from "../data/devices";
import { defaultMode, safeAreaFor, viewportFor } from "../components/simulator/geometry";
import type { UiMode, Zoom } from "../components/simulator/geometry";
import { ipc } from "../lib/ipc";
import type { DeviceInput, EnvironmentInput, MediaInput, NetworkProfile } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

export interface Media {
  colorScheme: "light" | "dark" | null;
  reducedMotion: boolean;
  print: boolean;
  /** `@media (display-mode: standalone)`: what an installed web app sees. */
  standalone: boolean;
}

/** A place and time for the page to believe in. */
export interface Environment {
  /** A preset id from `PLACES`, or null for the machine's own location. */
  place: string | null;
  timezone: string | null;
  locale: string | null;
}

/** Cities worth a click when checking a page that cares where it is. */
export const PLACES: { id: string; name: string; latitude: number; longitude: number; timezone: string; locale: string }[] = [
  { id: "san-francisco", name: "San Francisco", latitude: 37.7749, longitude: -122.4194, timezone: "America/Los_Angeles", locale: "en_US" },
  { id: "new-york", name: "New York", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York", locale: "en_US" },
  { id: "london", name: "London", latitude: 51.5074, longitude: -0.1278, timezone: "Europe/London", locale: "en_GB" },
  { id: "berlin", name: "Berlin", latitude: 52.52, longitude: 13.405, timezone: "Europe/Berlin", locale: "de_DE" },
  { id: "manila", name: "Manila", latitude: 14.5995, longitude: 120.9842, timezone: "Asia/Manila", locale: "en_PH" },
  { id: "tokyo", name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo", locale: "ja_JP" },
  { id: "sydney", name: "Sydney", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney", locale: "en_AU" },
  { id: "sao-paulo", name: "São Paulo", latitude: -23.5505, longitude: -46.6333, timezone: "America/Sao_Paulo", locale: "pt_BR" },
];

/** One device shown for a tab. */
export interface DeviceSelection {
  /** A catalog id, or `custom`. */
  deviceId: string;
  landscape: boolean;
  /** What Dive draws around the page. */
  ui: UiMode;
  zoom: Zoom;
  /** Custom size, when `deviceId` is `custom`. */
  custom?: { width: number; height: number };
}

interface EmulationState {
  /** Per tab: the device it is being shown on. Absent means no simulator. */
  byTab: Record<string, DeviceSelection>;
  /**
   * Per tab: the scale the stage settled on after measuring itself. Written
   * by the stage, read when the device is pushed to the engine.
   */
  scale: Record<string, number>;
  media: Record<string, Media>;
  /** Per tab throttling preset; absent means online at full speed. */
  throttle: Record<string, NetworkProfile>;
  environment: Record<string, Environment>;
  /** Devices used most recently, newest first, for the picker's quick row. */
  recent: string[];
  setThrottle: (tabId: string, profile: NetworkProfile | null) => Promise<void>;
  setDevice: (tabId: string, deviceId: string | null) => Promise<void>;
  setCustomSize: (tabId: string, width: number, height: number) => Promise<void>;
  toggleLandscape: (tabId: string) => Promise<void>;
  setUi: (tabId: string, ui: UiMode) => Promise<void>;
  setZoom: (tabId: string, zoom: Zoom) => void;
  /** The stage reports the scale it measured; pushes to the engine when it changed. */
  setScale: (tabId: string, scale: number) => Promise<void>;
  setMedia: (tabId: string, patch: Partial<Media>) => Promise<void>;
  setEnvironment: (tabId: string, patch: Partial<Environment>) => Promise<void>;
  /** Forget a closed tab. */
  drop: (tabId: string) => void;
}

const DEFAULT_MEDIA: Media = { colorScheme: null, reducedMotion: false, print: false, standalone: false };
const DEFAULT_ENVIRONMENT: Environment = { place: null, timezone: null, locale: null };
const RECENT_MAX = 6;

/** The preset a selection names, rotated if landscape. */
export function presetFor(sel: DeviceSelection): DevicePreset | undefined {
  const base = sel.deviceId === "custom" && sel.custom ? customDevice(sel.custom.width, sel.custom.height) : DEVICES.find((d) => d.id === sel.deviceId);
  if (!base) return undefined;
  return sel.landscape ? rotate(base) : base;
}

/** The unrotated preset a selection names. */
export function baseFor(sel: DeviceSelection): DevicePreset | undefined {
  return sel.deviceId === "custom" && sel.custom ? customDevice(sel.custom.width, sel.custom.height) : DEVICES.find((d) => d.id === sel.deviceId);
}

/**
 * What the engine is told. The viewport is the screen minus the strips Dive
 * draws, so `innerHeight` on an iPhone 15 in Safari is 659, as it is on the
 * phone; the scale is what makes that fit the window.
 */
export function toInput(sel: DeviceSelection, scale: number): DeviceInput | null {
  const base = baseFor(sel);
  if (!base) return null;
  const viewport = viewportFor(base, sel.landscape, sel.ui);
  const safe = safeAreaFor(base, sel.landscape, sel.ui);
  return {
    width: viewport.width,
    height: viewport.height,
    dpr: base.dpr,
    mobile: base.mobile,
    touch: base.touch,
    user_agent: base.userAgent,
    platform: base.platform,
    scale: Math.abs(scale - 1) < 1e-6 ? null : scale,
    safe_area: safe,
  };
}

export function toMediaInput(m: Media): MediaInput {
  return {
    color_scheme: m.colorScheme,
    reduced_motion: m.reducedMotion ? "reduce" : null,
    media_type: m.print ? "print" : null,
    display_mode: m.standalone ? "standalone" : null,
  };
}

export function toEnvironmentInput(e: Environment): EnvironmentInput {
  const place = e.place ? PLACES.find((p) => p.id === e.place) : undefined;
  return {
    geolocation: place ? { latitude: place.latitude, longitude: place.longitude, accuracy: 50 } : null,
    timezone: e.timezone ?? place?.timezone ?? null,
    locale: e.locale ?? place?.locale ?? null,
  };
}

/**
 * Whether moving from one device to another needs the page reloaded.
 *
 * Metrics, scale and insets take effect live. The user agent does not: the
 * server has already answered for the old one, and client-side sniffing ran
 * at load. Rotating, zooming and toggling the browser bars all keep the UA,
 * so they keep the page's state too.
 */
export function needsReload(previous: DeviceInput | null, next: DeviceInput | null): boolean {
  return (previous?.user_agent ?? "") !== (next?.user_agent ?? "") || (previous?.mobile ?? false) !== (next?.mobile ?? false);
}

/** Last payload pushed per tab, so an unchanged state is not re-sent. */
const pushed = new Map<string, { input: DeviceInput | null; key: string }>();

async function push(tabId: string, sel: DeviceSelection | undefined, scale: number) {
  const input = sel ? toInput(sel, scale) : null;
  const key = JSON.stringify(input);
  const last = pushed.get(tabId);
  if (last && last.key === key) return;
  const reload = needsReload(last?.input ?? null, input);
  pushed.set(tabId, { input, key });
  try {
    await ipc.tabEmulate(tabId, input, reload);
  } catch (e) {
    useBrowser.setState({ error: errorMessage(e) });
  }
}

/** Reset the dedupe memory; tests only. */
export function resetPushed() {
  pushed.clear();
}

function remember(recent: string[], id: string): string[] {
  if (id === "custom") return recent;
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
}

export const useEmulation = create<EmulationState>((set, get) => ({
  byTab: {},
  scale: {},
  media: {},
  throttle: {},
  environment: {},
  recent: [],
  setThrottle: async (tabId, profile) => {
    const next = { ...get().throttle };
    if (profile) next[tabId] = profile;
    else delete next[tabId];
    set({ throttle: next });
    try {
      await ipc.tabThrottle(tabId, profile);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  setDevice: async (tabId, deviceId) => {
    const byTab = { ...get().byTab };
    if (deviceId) {
      const device = DEVICES.find((d) => d.id === deviceId);
      if (!device) return;
      const current = byTab[tabId];
      byTab[tabId] = {
        deviceId,
        landscape: current?.landscape ?? false,
        // Keep a mode the person chose; otherwise start in the device's browser.
        ui: current && current.deviceId !== "custom" ? current.ui : defaultMode(device),
        zoom: current?.zoom ?? "fit",
      };
      set({ byTab, recent: remember(get().recent, deviceId) });
    } else {
      delete byTab[tabId];
      set({ byTab });
    }
    // The stage measures and reports the scale before the engine hears
    // about a new device; clearing goes straight through.
    if (!byTab[tabId]) await push(tabId, undefined, 1);
  },
  setCustomSize: async (tabId, width, height) => {
    const current = get().byTab[tabId];
    const sel: DeviceSelection = { deviceId: "custom", landscape: false, ui: "none", zoom: current?.zoom ?? "fit", custom: { width, height } };
    set({ byTab: { ...get().byTab, [tabId]: sel } });
    await push(tabId, sel, get().scale[tabId] ?? 1);
  },
  toggleLandscape: async (tabId) => {
    const cur = get().byTab[tabId];
    if (!cur) return;
    const sel = { ...cur, landscape: !cur.landscape };
    set({ byTab: { ...get().byTab, [tabId]: sel } });
    await push(tabId, sel, get().scale[tabId] ?? 1);
  },
  setUi: async (tabId, ui) => {
    const cur = get().byTab[tabId];
    if (!cur) return;
    const sel = { ...cur, ui };
    set({ byTab: { ...get().byTab, [tabId]: sel } });
    // Standalone is also a media feature: pages check display-mode to know
    // they are installed.
    await get().setMedia(tabId, { standalone: ui === "standalone" });
    await push(tabId, sel, get().scale[tabId] ?? 1);
  },
  setZoom: (tabId, zoom) => {
    const cur = get().byTab[tabId];
    if (!cur) return;
    set({ byTab: { ...get().byTab, [tabId]: { ...cur, zoom } } });
  },
  setScale: async (tabId, scale) => {
    const rounded = Math.round(scale * 1000) / 1000;
    if (get().scale[tabId] !== rounded) set({ scale: { ...get().scale, [tabId]: rounded } });
    await push(tabId, get().byTab[tabId], rounded);
  },
  setMedia: async (tabId, patch) => {
    const media = { ...(get().media[tabId] ?? DEFAULT_MEDIA), ...patch };
    set({ media: { ...get().media, [tabId]: media } });
    try {
      await ipc.tabMedia(tabId, toMediaInput(media));
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  setEnvironment: async (tabId, patch) => {
    const environment = { ...(get().environment[tabId] ?? DEFAULT_ENVIRONMENT), ...patch };
    set({ environment: { ...get().environment, [tabId]: environment } });
    try {
      await ipc.tabEnvironment(tabId, toEnvironmentInput(environment));
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  drop: (tabId) => {
    const strip = <T>(record: Record<string, T>) => {
      const next = { ...record };
      delete next[tabId];
      return next;
    };
    pushed.delete(tabId);
    set({ byTab: strip(get().byTab), scale: strip(get().scale), media: strip(get().media), throttle: strip(get().throttle), environment: strip(get().environment) });
  },
}));

export const selectMedia = (tabId: string | null) => (s: EmulationState) => (tabId ? (s.media[tabId] ?? DEFAULT_MEDIA) : DEFAULT_MEDIA);
export const selectThrottle = (tabId: string | null) => (s: EmulationState) => (tabId ? (s.throttle[tabId] ?? null) : null);
export const selectEnvironment = (tabId: string | null) => (s: EmulationState) => (tabId ? (s.environment[tabId] ?? DEFAULT_ENVIRONMENT) : DEFAULT_ENVIRONMENT);
export const selectDevice = (tabId: string | null) => (s: EmulationState) => (tabId ? s.byTab[tabId] : undefined);
