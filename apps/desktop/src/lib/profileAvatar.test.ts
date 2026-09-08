import { describe, expect, it } from "vitest";
import { colorName, PROFILE_COLORS } from "./profileAvatar";

describe("colorName", () => {
  it("names every offered swatch and leaves an unknown colour as it is", () => {
    for (const c of PROFILE_COLORS) expect(colorName(c)).not.toMatch(/^#/);
    expect(colorName("#7fd8c8")).toBe("Mint");
    expect(colorName("#123456")).toBe("#123456");
  });
});
