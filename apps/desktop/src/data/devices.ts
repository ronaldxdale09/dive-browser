/**
 * Device presets for the simulator, read from `devices.json`.
 *
 * The JSON is the single catalog: the host reads the same file for
 * `page_resize`, so an agent and the device picker cannot disagree about what
 * "iPhone 15" means. Everything derived — user agents, the strips Dive draws
 * around the page, safe-area insets — is computed here from the fields the
 * JSON carries, with the same rules the host applies in `emulate.rs`.
 *
 * Sizes are CSS pixels as the device's own browser reports them, which is
 * what a media query sees; DPR is what the screenshot is captured at.
 */
import catalog from "./devices.json";

export type DeviceGroup = "apple-phone" | "android-phone" | "foldable" | "tablet" | "laptop";

/** How the bezel is drawn, and which browser bars go with it. */
export type FrameKind = "island" | "notch" | "home" | "punch" | "bezel" | "laptop";

/** Which browser's bars are drawn around the page. */
export type BrowserKind = "safari" | "chrome" | "none";

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DevicePreset {
  id: string;
  name: string;
  group: DeviceGroup;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string;
  platform: "iOS" | "Android" | "macOS" | "Windows";
  frame: FrameKind;
  /** Screen corner radius in device CSS pixels. */
  radius: number;
  /** Safe-area insets a page would see in portrait with `viewport-fit=cover`. */
  safeArea: Insets;
}

/** The strips around the page, in device CSS pixels, for one orientation. */
export interface UiStrips {
  /** Status bar (clock, signal, battery). */
  status: number;
  /** The browser's own top bar. */
  top: number;
  /** The browser's own bottom bar; Safari's includes the home indicator. */
  bottom: number;
  /** Home-indicator strip, drawn in standalone mode instead of `bottom`. */
  home: number;
  /** Landscape safe-area insets beside the notch or island. */
  left: number;
  right: number;
}

type UaSpec =
  | { kind: "ios"; version: string }
  | { kind: "ipad" }
  | { kind: "android"; model: string }
  | { kind: "desktop"; platform: "macOS" | "Windows" };

interface RawDevice {
  id: string;
  name: string;
  group: DeviceGroup;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  ua: UaSpec;
  frame: FrameKind;
  radius: number;
  safeArea: Insets;
}

interface Catalog {
  groups: { id: DeviceGroup; name: string }[];
  ui: Record<FrameKind, { browser: BrowserKind; portrait: UiStrips; landscape: UiStrips }>;
  devices: RawDevice[];
}

const data = catalog as unknown as Catalog;

/** Mirrors `ios_ua` in emulate.rs. */
function iosUa(version: string): string {
  const major = version.split("_")[0] ?? "18";
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${major}.0 Mobile/15E148 Safari/604.1`;
}

const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Mirrors `android_ua` in emulate.rs. */
function androidUa(model: string): string {
  return `Mozilla/5.0 (Linux; Android 15; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36`;
}

/** The user agent for a catalog entry. Desktops keep Dive's own. */
export function userAgentFor(ua: UaSpec): { userAgent: string; platform: DevicePreset["platform"] } {
  switch (ua.kind) {
    case "ios":
      return { userAgent: iosUa(ua.version), platform: "iOS" };
    case "ipad":
      return { userAgent: IPAD_UA, platform: "iOS" };
    case "android":
      return { userAgent: androidUa(ua.model), platform: "Android" };
    case "desktop":
      return { userAgent: "", platform: ua.platform };
  }
}

export const DEVICES: DevicePreset[] = data.devices.map((d) => {
  const { userAgent, platform } = userAgentFor(d.ua);
  return {
    id: d.id,
    name: d.name,
    group: d.group,
    width: d.width,
    height: d.height,
    dpr: d.dpr,
    mobile: d.mobile,
    touch: d.touch,
    userAgent,
    platform,
    frame: d.frame,
    radius: d.radius,
    safeArea: d.safeArea,
  };
});

export const DEVICE_GROUPS: { id: DeviceGroup; name: string }[] = data.groups;

export function deviceById(id: string): DevicePreset | undefined {
  return DEVICES.find((d) => d.id === id);
}

/** Devices in a group, in catalog order. */
export function devicesIn(group: DeviceGroup): DevicePreset[] {
  return DEVICES.filter((d) => d.group === group);
}

/** Swap width and height for landscape. */
export function rotate(d: DevicePreset): DevicePreset {
  return { ...d, width: d.height, height: d.width };
}

/** Which browser's bars belong on a frame. */
export function browserFor(frame: FrameKind): BrowserKind {
  return data.ui[frame].browser;
}

/** The strips around the page for a frame in one orientation. */
export function stripsFor(frame: FrameKind, landscape: boolean): UiStrips {
  return data.ui[frame][landscape ? "landscape" : "portrait"];
}

/**
 * A custom size as a preset, for the "Responsive" entry: the chrome's own
 * user agent, no touch, and a plain bezel.
 */
export function customDevice(width: number, height: number): DevicePreset {
  return {
    id: "custom",
    name: "Custom",
    group: "laptop",
    width,
    height,
    dpr: 1,
    mobile: false,
    touch: false,
    userAgent: "",
    platform: "macOS",
    frame: "laptop",
    radius: 4,
    safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
  };
}

/** Case-insensitive match on name, id or size, for the picker's search box. */
export function searchDevices(query: string): DevicePreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return DEVICES;
  return DEVICES.filter(
    (d) =>
      d.name.toLowerCase().includes(q) ||
      d.id.includes(q) ||
      `${d.width}x${d.height}`.includes(q) ||
      `${d.width}×${d.height}`.includes(q),
  );
}
