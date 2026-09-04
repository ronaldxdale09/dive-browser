import { describe, expect, it } from "vitest";
import { privacyGuardian } from "./privacyAvatar";

describe("privacyGuardian", () => {
  it("returns one cached local SVG data URI", () => {
    expect(privacyGuardian()).toMatch(/^data:image\/svg\+xml/);
    expect(privacyGuardian()).toBe(privacyGuardian());
  });
});
