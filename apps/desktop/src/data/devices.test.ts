import { describe, expect, it } from "vitest";
import { DEVICES, deviceById, rotate } from "./devices";

describe("device presets", () => {
  it("have unique ids and sane dimensions", () => {
    const ids = new Set(DEVICES.map((d) => d.id));
    expect(ids.size).toBe(DEVICES.length);
    for (const d of DEVICES) {
      expect(d.width).toBeGreaterThan(300);
      expect(d.height).toBeGreaterThan(300);
      expect(d.dpr).toBeGreaterThanOrEqual(1);
      if (d.mobile) expect(d.userAgent).toContain("Mobile");
    }
  });
  it("rotates", () => {
    const d = deviceById("iphone-15")!;
    expect(rotate(d)).toMatchObject({ width: 852, height: 393 });
  });
});
