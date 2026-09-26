import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportSource } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowserImport } from "../../store/browserImport";
import { ImportPanel, describeOutcome } from "./ImportPanel";

const brave: ImportSource = { id: "brave:Default", browser: "brave", name: "Brave", family: "chromium", profile: null, dir: "/x/brave", access: "denied", passwords: true, forms: true, icon: null };
const chrome: ImportSource = { id: "chrome:Profile 1", browser: "chrome", name: "Chrome", family: "chromium", profile: "Work", dir: "/x/chrome", access: "ok", passwords: true, forms: true, icon: "data:image/png;base64,AAAA" };
const initial = useBrowserImport.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

afterEach(() => {
  cleanup();
  useBrowserImport.setState(initial, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("ImportPanel", () => {
  it("says so when there is nothing to import from", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([]);
    render(<ImportPanel />);
    expect(await screen.findByText("No other browsers with data were found")).toBeTruthy();
  });

  it("lists profiles by name, imports from the chosen one and reports the outcome", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave, chrome]);
    const run = vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 1, history: 2500, passwords: 0, forms: 0, warnings: [] });
    render(<ImportPanel />);
    const chromeRow = await screen.findByRole("radio", { name: "Chrome · Work" });
    // The readable browser is chosen first, even though Brave is listed first.
    expect(chromeRow.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Import from Chrome" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("chrome:Profile 1", true, true, true, true));
    expect((await screen.findByRole("status")).textContent).toContain("Brought in 1 bookmark, 2,500 pages of history, 0 passwords and 0 form entries from Chrome");
  });

  it("explains a protected folder, sends to System Settings and looks again", async () => {
    const sources = vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave]);
    const privacy = vi.spyOn(ipc, "browserImportOpenPrivacy").mockResolvedValue(null);
    render(<ImportPanel />);
    expect(await screen.findByText(/keeps Brave’s files private/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import from Brave" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow access in System Settings…" }));
    expect(privacy).toHaveBeenCalledTimes(1);
    // Back from System Settings with access granted: the row unlocks on focus.
    sources.mockResolvedValue([{ ...brave, access: "ok" }]);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Import from Brave" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/keeps Brave’s files private/)).toBeNull();
  });

  it("keeps what came in and says what did not when the keychain is refused", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([chrome]);
    vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 3, history: 10, passwords: 0, forms: 0, warnings: ["Passwords were not imported: macOS did not hand over Chrome's password key."] });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from Chrome" }));
    expect((await screen.findByRole("status")).textContent).toContain("Brought in 3 bookmarks");
    expect(screen.getByRole("alert", { name: "Not imported" }).textContent).toContain("Passwords were not imported");
  });

  it("tells a failed look for browsers from finding none, and looks again", async () => {
    const sources = vi.spyOn(ipc, "browserImportSources").mockRejectedValue(new Error("no home folder"));
    render(<ImportPanel />);
    expect(await screen.findByText("Dive could not look for other browsers")).toBeTruthy();
    expect(screen.getByText("no home folder")).toBeTruthy();
    expect(screen.queryByText("No other browsers with data were found")).toBeNull();
    sources.mockResolvedValue([chrome]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio", { name: "Chrome · Work" })).toBeTruthy();
  });

  it("says when a second import finds nothing new", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([chrome]);
    vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 0, history: 0, passwords: 0, forms: 0, warnings: [] });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from Chrome" }));
    expect((await screen.findByRole("status")).textContent).toContain("Nothing new from Chrome");
  });

  it("phrases the outcome for what was asked", () => {
    expect(describeOutcome(3, 0, true, false)).toBe("3 bookmarks");
    expect(describeOutcome(1, 1, true, true)).toBe("1 bookmark and 1 page of history");
    expect(describeOutcome(2, 0, true, true, 5, true)).toBe("2 bookmarks, 0 pages of history and 5 passwords");
    expect(describeOutcome(0, 0, false, false, 0, false, 1, true)).toBe("1 form entry");
    expect(describeOutcome(0, 0, false, false, 1, true)).toBe("1 password");
  });

  it("does not say Safari is looked for on Windows", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([]);
    render(<ImportPanel />);
    expect(await screen.findByText("No other browsers with data were found")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Safari are looked for/);
    expect(document.body.textContent).toMatch(/AppData/);
  });

  it("does not say it is looking for browsers on this Mac on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    vi.spyOn(ipc, "browserImportSources").mockImplementation(() => new Promise(() => {}));
    render(<ImportPanel />);
    expect(document.body.textContent).toMatch(/Looking for other browsers/);
    expect(document.body.textContent).not.toMatch(/this Mac/);
  });

  it("does not say imported passwords go into the Keychain on Windows", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([chrome]);
    render(<ImportPanel />);
    expect(await screen.findByRole("radio", { name: "Chrome · Work" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).not.toMatch(/macOS/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("does not send Windows to System Settings for Full Disk Access", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave]);
    render(<ImportPanel />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/System Settings/);
    expect(screen.queryByRole("button", { name: /Allow access/ })).toBeNull();
  });
});
