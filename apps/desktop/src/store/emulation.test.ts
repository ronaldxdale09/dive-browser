import { describe, expect, it } from "vitest";
import { toInput, toMediaInput } from "./emulation";
import { deviceById } from "../data/devices";

describe("emulation payloads", () => {
  it("maps a preset to the IPC shape", () => {
    const d = toInput(deviceById("pixel-8")!);
    expect(d).toMatchObject({ width: 412, height: 915, dpr: 2.625, mobile: true, touch: true, platform: "Android" });
    expect(d.user_agent).toContain("Pixel 8");
  });
  it("maps media toggles", () => {
    expect(toMediaInput({ colorScheme: "dark", reducedMotion: true, print: false })).toEqual({ color_scheme: "dark", reduced_motion: "reduce", media_type: null });
    expect(toMediaInput({ colorScheme: null, reducedMotion: false, print: true })).toEqual({ color_scheme: null, reduced_motion: null, media_type: "print" });
  });
});
