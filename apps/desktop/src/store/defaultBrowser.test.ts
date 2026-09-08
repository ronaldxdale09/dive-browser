import { afterEach, describe, expect, it } from "vitest";
import { DECLINE_REST_MS, declinedAt, useDefaultBrowser } from "./defaultBrowser";

afterEach(() => {
  localStorage.clear();
  useDefaultBrowser.setState({ declined: false });
});

describe("default browser offer", () => {
  it("rests for two weeks after Not now, and remembers it across launches", () => {
    expect(useDefaultBrowser.getState().declined).toBe(false);
    useDefaultBrowser.getState().decline();
    expect(useDefaultBrowser.getState().declined).toBe(true);
    const stored = localStorage.getItem("dive.defaultBrowser.declinedUntil");
    expect(declinedAt(Date.now(), stored)).toBe(true);
    expect(declinedAt(Date.now() + DECLINE_REST_MS + 1, stored)).toBe(false);
    expect(declinedAt(Date.now(), null)).toBe(false);
    expect(declinedAt(Date.now(), "garbage")).toBe(false);
  });
});
