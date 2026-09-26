import { afterEach, describe, expect, it, vi } from "vitest";
import { installChromeErrorReporting, reportChromeError, resetChromeErrorReporting } from "./chromeErrors";
import { ipc } from "./ipc";

afterEach(() => {
  resetChromeErrorReporting();
  vi.restoreAllMocks();
});

describe("chrome error reporting", () => {
  it("sends an error's message and stack to the host log", () => {
    const logged = vi.spyOn(ipc, "logChromeError").mockResolvedValue(undefined);
    const error = new Error("boom");
    reportChromeError("render", error, "in <Settings>");
    expect(logged).toHaveBeenCalledWith("render", "boom", expect.stringContaining("in <Settings>"));
  });

  it("forwards uncaught errors and unhandled rejections, once however often it is installed", () => {
    const logged = vi.spyOn(ipc, "logChromeError").mockResolvedValue(undefined);
    const target = new EventTarget() as unknown as Window;
    installChromeErrorReporting(target);
    installChromeErrorReporting(target);
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("thrown"), message: "thrown", filename: "", lineno: 0, colno: 0 }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "nobody awaited" }));
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenNthCalledWith(1, "uncaught", "thrown", expect.anything());
    expect(logged).toHaveBeenNthCalledWith(2, "unhandled rejection", "nobody awaited", null);
  });

  it("never throws from inside an error handler", () => {
    vi.spyOn(ipc, "logChromeError").mockImplementation(() => {
      throw new Error("ipc gone");
    });
    expect(() => reportChromeError("render", "x")).not.toThrow();
  });
});
