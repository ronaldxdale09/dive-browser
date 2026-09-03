import { describe, expect, it } from "vitest";
import { needsReload, presetFor, toEnvironmentInput, toInput, toMediaInput } from "./emulation";
import type { DeviceSelection } from "./emulation";
import { deviceById } from "../data/devices";

const iphone: DeviceSelection = { deviceId: "iphone-15", landscape: false, ui: "browser", zoom: "fit" };

describe("emulation payloads", () => {
  it("tells the engine the viewport the device's browser would give, not the screen", () => {
    const d = toInput(iphone, 1)!;
    expect(d).toMatchObject({ width: 393, height: 659, dpr: 3, mobile: true, touch: true, platform: "iOS" });
    expect(d.user_agent).toContain("iPhone");
    // Browser mode: Safari's bars cover the notch, so the page sees no insets.
    expect(d.safe_area).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    // A scale of 1 is the default and is left out.
    expect(d.scale).toBeNull();
  });

  it("carries the scale the stage measured", () => {
    expect(toInput(iphone, 0.5)!.scale).toBe(0.5);
  });

  it("gives a standalone app its insets", () => {
    const d = toInput({ ...iphone, ui: "standalone" }, 1)!;
    expect(d.height).toBe(759);
    expect(d.safe_area).toEqual({ top: 59, bottom: 34, left: 0, right: 0 });
  });

  it("rotates before subtracting the strips", () => {
    const d = toInput({ ...iphone, landscape: true }, 1)!;
    expect([d.width, d.height]).toEqual([852, 322]);
  });

  it("maps a custom size to a bare viewport", () => {
    const d = toInput({ deviceId: "custom", landscape: false, ui: "none", zoom: "fit", custom: { width: 1000, height: 700 } }, 1)!;
    expect(d).toMatchObject({ width: 1000, height: 700, mobile: false, touch: false, user_agent: "" });
  });

  it("returns null for a device that is not in the catalog", () => {
    expect(toInput({ ...iphone, deviceId: "nokia-3310" }, 1)).toBeNull();
    expect(presetFor({ ...iphone, deviceId: "nokia-3310" })).toBeUndefined();
  });

  it("maps media toggles, including display-mode for installed apps", () => {
    expect(toMediaInput({ colorScheme: "dark", reducedMotion: true, print: false, standalone: false })).toEqual({ color_scheme: "dark", reduced_motion: "reduce", media_type: null, display_mode: null });
    expect(toMediaInput({ colorScheme: null, reducedMotion: false, print: true, standalone: true })).toEqual({ color_scheme: null, reduced_motion: null, media_type: "print", display_mode: "standalone" });
  });

  it("expands a place into a position, time zone and locale", () => {
    const env = toEnvironmentInput({ place: "tokyo", timezone: null, locale: null });
    expect(env.geolocation).toMatchObject({ latitude: 35.6762, longitude: 139.6503 });
    expect(env.timezone).toBe("Asia/Tokyo");
    expect(env.locale).toBe("ja_JP");
    // An explicit zone wins over the place's.
    expect(toEnvironmentInput({ place: "tokyo", timezone: "UTC", locale: null }).timezone).toBe("UTC");
    expect(toEnvironmentInput({ place: null, timezone: null, locale: null })).toEqual({ geolocation: null, timezone: null, locale: null });
  });
});

describe("reload decision", () => {
  const pixel = toInput({ ...iphone, deviceId: "pixel-8" }, 1);
  const phone = toInput(iphone, 1);

  it("reloads when the user agent changes", () => {
    expect(needsReload(null, phone)).toBe(true);
    expect(needsReload(phone, pixel)).toBe(true);
    expect(needsReload(phone, null)).toBe(true);
  });

  it("does not reload for a rotation, a zoom or a different set of bars", () => {
    expect(needsReload(phone, toInput({ ...iphone, landscape: true }, 1))).toBe(false);
    expect(needsReload(phone, toInput(iphone, 0.5))).toBe(false);
    expect(needsReload(phone, toInput({ ...iphone, ui: "standalone" }, 1))).toBe(false);
  });

  it("reloads between two laptops only if mobile-ness changes", () => {
    const laptop = toInput({ ...iphone, deviceId: "laptop", ui: "none" }, 1);
    const desktop = toInput({ ...iphone, deviceId: "desktop", ui: "none" }, 1);
    expect(needsReload(laptop, desktop)).toBe(false);
    expect(deviceById("laptop")!.userAgent).toBe("");
  });
});
