import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportSource } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { browserForBundle, pickSource, useBrowserImport } from "./browserImport";

const brave: ImportSource = { id: "brave:Default", browser: "brave", name: "Brave", family: "chromium", profile: null, dir: "/x/brave", access: "denied", icon: null };
const chrome: ImportSource = { id: "chrome:Default", browser: "chrome", name: "Chrome", family: "chromium", profile: null, dir: "/x/chrome", access: "ok", icon: "data:image/png;base64,AAAA" };
const initial = useBrowserImport.getState();

afterEach(() => {
  useBrowserImport.setState(initial, true);
  vi.restoreAllMocks();
});

describe("browser import", () => {
  it("maps the default browser's bundle id and picks a readable row first", () => {
    expect(browserForBundle("com.brave.Browser")).toBe("brave");
    expect(browserForBundle("app.dive.browser")).toBeNull();
    expect(pickSource([brave, chrome])).toBe("chrome:Default");
    expect(pickSource([brave, chrome], "brave")).toBe("brave:Default");
    // Neither readable: the one whose app is still installed comes first.
    expect(pickSource([{ ...chrome, access: "denied", icon: null }, { ...brave, icon: "data:image/png;base64,AA" }])).toBe("brave:Default");
    expect(pickSource([])).toBeNull();
  });

  it("loads sources, imports from the chosen one and reports what came in", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave, chrome]);
    const run = vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 12, history: 340 });
    await useBrowserImport.getState().load();
    expect(useBrowserImport.getState().selected).toBe("chrome:Default");
    // Opened again for a particular browser, that browser wins over the earlier pick.
    await useBrowserImport.getState().load("brave");
    expect(useBrowserImport.getState().selected).toBe("brave:Default");
    useBrowserImport.getState().select("chrome:Default");
    useBrowserImport.getState().setHistory(false);
    await useBrowserImport.getState().run();
    expect(run).toHaveBeenCalledWith("chrome:Default", true, false);
    expect(useBrowserImport.getState().outcome).toEqual({ source: chrome, summary: { bookmarks: 12, history: 340 } });
  });

  it("does not run for a source macOS has not allowed, and updates it once allowed", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave]);
    const run = vi.spyOn(ipc, "browserImportRun");
    vi.spyOn(ipc, "browserImportGrant").mockResolvedValue({ ...brave, access: "ok" });
    await useBrowserImport.getState().load();
    await useBrowserImport.getState().run();
    // The store leaves the gate to the panel; the panel disables Import while
    // access is denied, so a run with the source still denied is the host's
    // call to refuse. Here it simply proceeds once access is granted.
    await useBrowserImport.getState().grant("brave:Default");
    expect(useBrowserImport.getState().sources?.[0]?.access).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a failure readable", async () => {
    vi.spyOn(ipc, "browserImportSources").mockRejectedValue(new Error("no home"));
    await useBrowserImport.getState().load();
    expect(useBrowserImport.getState().sources).toEqual([]);
    expect(useBrowserImport.getState().error).toBe("no home");
  });
});
