import { create } from "zustand";
import { DEVICES, rotate } from "../data/devices";
import type { DevicePreset } from "../data/devices";
import { ipc } from "../lib/ipc";
import type { DeviceInput, MediaInput, NetworkProfile } from "../lib/ipc";
import { useBrowser } from "./browser";

export interface Media {
  colorScheme: "light" | "dark" | null;
  reducedMotion: boolean;
  print: boolean;
}

interface EmulationState {
  /** Per tab: chosen preset id and orientation. */
  byTab: Record<string, { deviceId: string; landscape: boolean }>;
  media: Record<string, Media>;
  /** Per tab throttling preset; absent means online at full speed. */
  throttle: Record<string, NetworkProfile>;
  setThrottle: (tabId: string, profile: NetworkProfile | null) => Promise<void>;
  setDevice: (tabId: string, deviceId: string | null) => Promise<void>;
  toggleLandscape: (tabId: string) => Promise<void>;
  setMedia: (tabId: string, patch: Partial<Media>) => Promise<void>;
}

export function toInput(d: DevicePreset): DeviceInput {
  return { width: d.width, height: d.height, dpr: d.dpr, mobile: d.mobile, touch: d.touch, user_agent: d.userAgent, platform: d.platform };
}

export function toMediaInput(m: Media): MediaInput {
  return { color_scheme: m.colorScheme, reduced_motion: m.reducedMotion ? "reduce" : null, media_type: m.print ? "print" : null };
}

const DEFAULT_MEDIA: Media = { colorScheme: null, reducedMotion: false, print: false };

async function push(tabId: string, sel: { deviceId: string; landscape: boolean } | undefined) {
  const preset = sel ? DEVICES.find((d) => d.id === sel.deviceId) : undefined;
  const device = preset ? toInput(sel?.landscape ? rotate(preset) : preset) : null;
  try {
    await ipc.tabEmulate(tabId, device);
  } catch (e) {
    useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

export const useEmulation = create<EmulationState>((set, get) => ({
  byTab: {},
  media: {},
  throttle: {},
  setThrottle: async (tabId, profile) => {
    const next = { ...get().throttle };
    if (profile) next[tabId] = profile;
    else delete next[tabId];
    set({ throttle: next });
    try {
      await ipc.tabThrottle(tabId, profile);
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  setDevice: async (tabId, deviceId) => {
    const next = { ...get().byTab };
    if (deviceId) next[tabId] = { deviceId, landscape: next[tabId]?.landscape ?? false };
    else delete next[tabId];
    set({ byTab: next });
    await push(tabId, next[tabId]);
  },
  toggleLandscape: async (tabId) => {
    const cur = get().byTab[tabId];
    if (!cur) return;
    const sel = { ...cur, landscape: !cur.landscape };
    set({ byTab: { ...get().byTab, [tabId]: sel } });
    await push(tabId, sel);
  },
  setMedia: async (tabId, patch) => {
    const media = { ...(get().media[tabId] ?? DEFAULT_MEDIA), ...patch };
    set({ media: { ...get().media, [tabId]: media } });
    try {
      await ipc.tabMedia(tabId, toMediaInput(media));
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

export const selectMedia = (tabId: string | null) => (s: EmulationState) => (tabId ? (s.media[tabId] ?? DEFAULT_MEDIA) : DEFAULT_MEDIA);
export const selectThrottle = (tabId: string | null) => (s: EmulationState) => (tabId ? (s.throttle[tabId] ?? null) : null);
