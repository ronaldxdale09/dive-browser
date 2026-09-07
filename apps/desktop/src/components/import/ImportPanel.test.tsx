import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportSource } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowserImport } from "../../store/browserImport";
import { ImportPanel, describeOutcome } from "./ImportPanel";

const brave: ImportSource = { id: "brave:Default", browser: "brave", name: "Brave", family: "chromium", profile: null, dir: "/x/brave", access: "denied", icon: null };
const chrome: ImportSource = { id: "chrome:Profile 1", browser: "chrome", name: "Chrome", family: "chromium", profile: "Work", dir: "/x/chrome", access: "ok", icon: "data:image/png;base64,AAAA" };
const initial = useBrowserImport.getState();

afterEach(() => {
  cleanup();
  useBrowserImport.setState(initial, true);
  vi.restoreAllMocks();
});

describe("ImportPanel", () => {
  it("says so when there is nothing to import from", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([]);
    render(<ImportPanel />);
    expect(await screen.findByText("No other browsers with data were found")).toBeTruthy();
  });

  it("lists profiles by name, imports from the chosen one and reports the outcome", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([brave, chrome]);
    const run = vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 1, history: 2500 });
    render(<ImportPanel />);
    const chromeRow = await screen.findByRole("radio", { name: "Chrome · Work" });
    // The readable browser is chosen first, even though Brave is listed first.
    expect(chromeRow.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Import from Chrome" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("chrome:Profile 1", true, true));
    expect((await screen.findByRole("status")).textContent).toContain("Brought in 1 bookmark and 2,500 pages of history from Chrome");
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

  it("says when a second import finds nothing new", async () => {
    vi.spyOn(ipc, "browserImportSources").mockResolvedValue([chrome]);
    vi.spyOn(ipc, "browserImportRun").mockResolvedValue({ bookmarks: 0, history: 0 });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Import from Chrome" }));
    expect((await screen.findByRole("status")).textContent).toContain("Nothing new from Chrome");
  });

  it("phrases the outcome for what was asked", () => {
    expect(describeOutcome(3, 0, true, false)).toBe("3 bookmarks");
    expect(describeOutcome(1, 1, true, true)).toBe("1 bookmark and 1 page of history");
  });
});
