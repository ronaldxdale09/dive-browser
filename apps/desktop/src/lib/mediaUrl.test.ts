import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMediaUrl } from "./mediaUrl";

describe("captureMediaUrl", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "isTauri");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("uses the scoped asset protocol in the desktop runtime", () => {
    Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`) },
      configurable: true,
    });

    expect(captureMediaUrl("/tmp/a recording.webm")).toBe("asset://localhost/%2Ftmp%2Fa%20recording.webm");
  });

  it("keeps paths readable in browser-only tests", () => {
    expect(captureMediaUrl("/tmp/recording.webm")).toBe("/tmp/recording.webm");
  });
});
