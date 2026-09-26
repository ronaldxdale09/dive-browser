import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { loadUiStorage, resetUiStorage, uiStorage } from "./uiStorage";

describe("uiStorage", () => {
  afterEach(() => {
    resetUiStorage();
    vi.restoreAllMocks();
  });

  it("writes a value through only when it changed", async () => {
    vi.spyOn(ipc, "uiStateLoad").mockResolvedValue([["dive.recording", '{"state":{"settings":{"fps":30}}}']]);
    const write = vi.spyOn(ipc, "uiStateSet").mockResolvedValue(null);
    expect(await loadUiStorage()).toBe(true);

    // What was read back is already stored.
    uiStorage.setItem("dive.recording", '{"state":{"settings":{"fps":30}}}');
    expect(write).not.toHaveBeenCalled();

    uiStorage.setItem("dive.recording", '{"state":{"settings":{"fps":60}}}');
    uiStorage.setItem("dive.recording", '{"state":{"settings":{"fps":60}}}');
    expect(write).toHaveBeenCalledTimes(1);
    expect(uiStorage.getItem("dive.recording")).toContain("60");
  });
});
