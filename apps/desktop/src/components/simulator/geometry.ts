/**
 * The arithmetic behind the device stage: how big the frame is, where the
 * page sits inside it, and what viewport the page is told it has.
 *
 * Two facts drive every number here.
 *
 * The page is a native child webview, and those paint above the chrome, so
 * nothing Dive draws can overlap it. The status bar, the notch, and the
 * browser's own bars are therefore strips *around* the page rectangle, not
 * layers over it. That happens to be the truthful layout anyway: Safari on an
 * iPhone 15 gives a page 393×659, not the 393×852 of the screen, and a
 * simulator that hands over the whole screen misreports every `100vh`.
 *
 * The frame has to fit the space it is given. A 932-tall phone does not fit
 * a laptop window, so the whole thing is scaled and the engine is told the
 * scale, which is what keeps `window.innerWidth` at the device's real value
 * while the pixels on screen are smaller.
 */
import type { DevicePreset, FrameKind, Insets } from "../../data/devices";
import { stripsFor } from "../../data/devices";

/** What Dive draws around the page. */
export type UiMode =
  /** The device's browser: status bar plus Safari or Chrome bars. */
  | "browser"
  /** An installed web app: status bar and home indicator only. */
  | "standalone"
  /** Nothing: the page gets the whole screen. For laptops and custom sizes. */
  | "none";

export type Zoom = "fit" | 25 | 50 | 75 | 100;

/** Thickness of the bezel around the screen, in device CSS pixels. */
export interface Bezel {
  sides: number;
  top: number;
  bottom: number;
}

/** Everything the stage needs to draw one device and position its page. */
export interface Layout {
  /** Device CSS pixel → chrome pixel. */
  scale: number;
  /** Screen size in device pixels, rotated for landscape. */
  screen: { width: number; height: number };
  /** Strips around the page, in device pixels. */
  strips: Insets;
  /** Viewport the page is told it has, in device CSS pixels. */
  viewport: { width: number; height: number };
  /** Bezel in device pixels. */
  bezel: Bezel;
  /** Outer frame size in chrome pixels, bezel included. */
  outer: { width: number; height: number };
}

/** Space kept around the frame so it does not touch the stage edges. */
export const STAGE_PADDING = 24;

/** Smallest scale worth rendering: below this the page is unreadable. */
const MIN_SCALE = 0.15;

export function bezelFor(frame: FrameKind): Bezel {
  switch (frame) {
    case "island":
    case "notch":
      return { sides: 12, top: 12, bottom: 12 };
    case "home":
      // A classic iPhone carries a forehead and a chin with the home button.
      return { sides: 18, top: 72, bottom: 72 };
    case "punch":
      return { sides: 9, top: 9, bottom: 9 };
    case "bezel":
      return { sides: 22, top: 22, bottom: 22 };
    case "laptop":
      return { sides: 14, top: 14, bottom: 30 };
  }
}

/** Screen size in device pixels for an orientation. */
export function screenFor(device: DevicePreset, landscape: boolean): { width: number; height: number } {
  return landscape ? { width: device.height, height: device.width } : { width: device.width, height: device.height };
}

/** The strips around the page for a device, orientation and UI mode. */
export function stripsAround(device: DevicePreset, landscape: boolean, mode: UiMode): Insets {
  if (mode === "none" || device.frame === "laptop") return { top: 0, bottom: 0, left: 0, right: 0 };
  const ui = stripsFor(device.frame, landscape);
  if (mode === "browser") {
    // The browser's bars sit on top of the notch region; the page never
    // reaches the edges, so it has no side insets to worry about.
    return { top: ui.status + ui.top, bottom: ui.bottom, left: 0, right: 0 };
  }
  return { top: ui.status, bottom: ui.home, left: ui.left, right: ui.right };
}

/** The viewport the page will report, in device CSS pixels. */
export function viewportFor(device: DevicePreset, landscape: boolean, mode: UiMode): { width: number; height: number } {
  const screen = screenFor(device, landscape);
  const strips = stripsAround(device, landscape, mode);
  return {
    width: Math.max(1, screen.width - strips.left - strips.right),
    height: Math.max(1, screen.height - strips.top - strips.bottom),
  };
}

/**
 * Safe-area insets to tell the page about.
 *
 * In browser mode the bars cover the notch and the home indicator, so a page
 * sees zero insets, which is what Safari reports. In standalone mode the page
 * would extend under both, so it is told their sizes even though Dive draws
 * them as strips: that is what lets `env(safe-area-inset-bottom)` padding be
 * checked at all.
 */
export function safeAreaFor(device: DevicePreset, landscape: boolean, mode: UiMode): Insets {
  if (mode !== "standalone" || device.frame === "laptop") return { top: 0, bottom: 0, left: 0, right: 0 };
  if (!landscape) return device.safeArea;
  const ui = stripsFor(device.frame, true);
  return { top: 0, bottom: ui.home, left: ui.left, right: ui.right };
}

/** Scale that fits a frame into `available` chrome pixels, or a fixed zoom. */
export function scaleFor(
  screen: { width: number; height: number },
  bezel: Bezel,
  available: { width: number; height: number },
  zoom: Zoom,
): number {
  if (zoom !== "fit") return zoom / 100;
  const outerW = screen.width + bezel.sides * 2;
  const outerH = screen.height + bezel.top + bezel.bottom;
  const fit = Math.min(
    1,
    (available.width - STAGE_PADDING * 2) / outerW,
    (available.height - STAGE_PADDING * 2) / outerH,
  );
  return Math.max(MIN_SCALE, Number.isFinite(fit) ? fit : MIN_SCALE);
}

/** The complete layout for one device on the stage. */
export function layoutFor(
  device: DevicePreset,
  landscape: boolean,
  mode: UiMode,
  zoom: Zoom,
  available: { width: number; height: number },
): Layout {
  const screen = screenFor(device, landscape);
  const bezel = bezelFor(device.frame);
  const scale = scaleFor(screen, bezel, available, zoom);
  return {
    scale,
    screen,
    strips: stripsAround(device, landscape, mode),
    viewport: viewportFor(device, landscape, mode),
    bezel,
    outer: {
      width: Math.round((screen.width + bezel.sides * 2) * scale),
      height: Math.round((screen.height + bezel.top + bezel.bottom) * scale),
    },
  };
}

/** The UI mode a device starts in: its browser, or nothing for a laptop. */
export function defaultMode(device: DevicePreset): UiMode {
  return device.frame === "laptop" ? "none" : "browser";
}
