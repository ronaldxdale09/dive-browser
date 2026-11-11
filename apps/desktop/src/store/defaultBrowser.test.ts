import { afterEach, describe, expect, it } from "vitest";
import { DECLINE_REST_MS, declinedAt, rehydrateDefaultBrowser, useDefaultBrowser } from "./defaultBrowser";
import { resetUiStorage, uiStorage } from "../lib/uiStorage";

afterEach(() => {
  resetUiStorage();
  useDefaultBrowser.setState({ declined: false });
});

describe("default browser offer", () => {
  it("rests for two weeks after Not now, and remembers it across launches", () => {
    expect(useDefaultBrowser.getState().declined).toBe(false);
    useDefaultBrowser.getState().decline();
    expect(useDefaultBrowser.getState().declined).toBe(true);
    const stored = uiStorage.getItem("dive.defaultBrowser.declinedUntil");
    expect(localStorage.getItem("dive.defaultBrowser.declinedUntil")).toBeNull();
    expect(declinedAt(Date.now(), stored)).toBe(true);
    expect(declinedAt(Date.now() + DECLINE_REST_MS + 1, stored)).toBe(false);
    expect(declinedAt(Date.now(), null)).toBe(false);
    expect(declinedAt(Date.now(), "garbage")).toBe(false);
  });

  it("applies a saved Not now after the storage load, even to a store created before it", () => {
    // The store exists (as it does once App is preloaded) while storage is still empty.
    rehydrateDefaultBrowser();
    expect(useDefaultBrowser.getState().declined).toBe(false);
    uiStorage.setItem("dive.defaultBrowser.declinedUntil", String(Date.now() + DECLINE_REST_MS));
    expect(useDefaultBrowser.getState().declined).toBe(false);
    rehydrateDefaultBrowser();
    expect(useDefaultBrowser.getState().declined).toBe(true);
  });
});
