import { describe, expect, it } from "vitest";
import { engineLabel } from "./About";

describe("About engine line", () => {
  it("names the Chromium major from the user agent", () => {
    expect(engineLabel("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")).toBe("Chromium 151 · CEF");
    expect(engineLabel("Mozilla/5.0 (X11) Gecko/20100101 Firefox/130.0")).toBe("CEF");
  });
});
