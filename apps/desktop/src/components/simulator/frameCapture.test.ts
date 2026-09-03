import { describe, expect, it } from "vitest";
import { deviceById } from "../../data/devices";
import { displayHost, formatClock } from "./Chrome";
import { captureRatio, framedSize } from "./frameCapture";

describe("framed capture", () => {
  it("sizes the image to the screen plus bezel, at the capture's ratio", () => {
    const iphone = deviceById("iphone-15")!;
    const size = framedSize(iphone, false, 3);
    expect(size).toEqual({
      width: (393 + 24) * 3,
      height: (852 + 24) * 3,
      bezel: { sides: 36, top: 36, bottom: 36 },
    });
  });

  it("reads the ratio off the capture rather than trusting the preset", () => {
    // A 1179-wide capture of a 393-wide viewport is 3x.
    expect(captureRatio(1179, 393)).toBe(3);
    // A capture taken before emulation applied is 1x, and must not be
    // stretched.
    expect(captureRatio(393, 393)).toBe(1);
    expect(captureRatio(100, 0)).toBe(1);
  });

  it("rotates with the device", () => {
    const iphone = deviceById("iphone-15")!;
    const size = framedSize(iphone, true, 1);
    expect(size.width).toBeGreaterThan(size.height);
  });
});

describe("bar text", () => {
  it("shows the host the way a phone's address bar does", () => {
    expect(displayHost("https://www.x.com/home?x=1")).toBe("x.com");
    expect(displayHost("http://localhost:5173/settings")).toBe("localhost");
    expect(displayHost("about:blank")).toBe("");
    expect(displayHost("not a url")).toBe("not a url");
  });

  it("formats the clock like iOS and like Android", () => {
    const morning = new Date(2026, 8, 4, 9, 5);
    expect(formatClock(morning)).toBe("9:05");
    expect(formatClock(morning, true)).toBe("09:05");
    const midnight = new Date(2026, 8, 4, 0, 30);
    expect(formatClock(midnight)).toBe("12:30");
    const evening = new Date(2026, 8, 4, 21, 0);
    expect(formatClock(evening)).toBe("9:00");
    expect(formatClock(evening, true)).toBe("21:00");
  });
});
