import { describe, expect, it } from "vitest";
import { modelSize } from "./SubtitlesControls";

describe("modelSize", () => {
  it("says megabytes below a gigabyte and gigabytes from there", () => {
    expect(modelSize(75)).toBe("75 MB");
    expect(modelSize(148)).toBe("148 MB");
    expect(modelSize(1533)).toBe("1.5 GB");
  });
});
