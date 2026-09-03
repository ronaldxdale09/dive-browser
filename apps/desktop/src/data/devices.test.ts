import { describe, expect, it } from "vitest";
import { DEVICES, DEVICE_GROUPS, browserFor, customDevice, deviceById, devicesIn, rotate, searchDevices, stripsFor, userAgentFor } from "./devices";

describe("device presets", () => {
  it("have unique ids and sane dimensions", () => {
    const ids = new Set(DEVICES.map((d) => d.id));
    expect(ids.size).toBe(DEVICES.length);
    for (const d of DEVICES) {
      expect(d.width, d.id).toBeGreaterThan(200);
      expect(d.height, d.id).toBeGreaterThan(200);
      expect(d.dpr, d.id).toBeGreaterThanOrEqual(1);
      if (d.mobile) expect(d.userAgent, d.id).toContain("Mobile");
    }
  });

  it("belong to a listed group, and every group has a device", () => {
    const groups = new Set(DEVICE_GROUPS.map((g) => g.id));
    for (const d of DEVICES) expect(groups.has(d.group), d.id).toBe(true);
    for (const g of DEVICE_GROUPS) expect(devicesIn(g.id).length, g.id).toBeGreaterThan(0);
  });

  it("rotates", () => {
    const d = deviceById("iphone-15")!;
    expect(rotate(d)).toMatchObject({ width: 852, height: 393 });
  });

  it("builds a user agent the page will recognise as the device", () => {
    expect(userAgentFor({ kind: "ios", version: "18_0" }).userAgent).toMatch(/iPhone OS 18_0 .* Version\/18\.0 Mobile/);
    expect(userAgentFor({ kind: "android", model: "Pixel 8" }).userAgent).toContain("Android 15; Pixel 8");
    expect(userAgentFor({ kind: "ipad" })).toMatchObject({ platform: "iOS" });
    // A laptop keeps Dive's own UA so server-side detection sees a desktop.
    expect(userAgentFor({ kind: "desktop", platform: "Windows" })).toEqual({ userAgent: "", platform: "Windows" });
  });

  it("knows which browser's bars go with each frame", () => {
    expect(browserFor("island")).toBe("safari");
    expect(browserFor("punch")).toBe("chrome");
    expect(browserFor("laptop")).toBe("none");
  });

  it("has landscape strips that differ from portrait where the real device does", () => {
    const portrait = stripsFor("island", false);
    const landscape = stripsFor("island", true);
    expect(portrait.status).toBe(59);
    // The island moves to the side; the status bar goes away.
    expect(landscape.status).toBe(0);
    expect(landscape.left).toBe(59);
  });

  it("searches by name, id and size", () => {
    expect(searchDevices("pixel").every((d) => d.name.toLowerCase().includes("pixel"))).toBe(true);
    expect(searchDevices("393x852").map((d) => d.id)).toContain("iphone-15");
    expect(searchDevices("iphone-se").map((d) => d.id)).toEqual(["iphone-se"]);
    expect(searchDevices("")).toHaveLength(DEVICES.length);
  });

  it("makes a custom size that never pretends to be a phone", () => {
    const custom = customDevice(1000, 700);
    expect(custom).toMatchObject({ id: "custom", width: 1000, height: 700, mobile: false, touch: false, userAgent: "" });
  });
});
