import { describe, expect, it } from "vitest";
import { previewNeedsFrame } from "./previewLoop";

describe("previewNeedsFrame", () => {
  it("keeps drawing only while playback or media work is active", () => {
    expect(previewNeedsFrame(true, 4, false)).toBe(true);
    expect(previewNeedsFrame(false, 1, false)).toBe(true);
    expect(previewNeedsFrame(false, 4, true)).toBe(true);
    expect(previewNeedsFrame(false, 4, false)).toBe(false);
  });
});
