import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { Privacy, clearList, pruneQuestion, retentionOptions, shortensRetention } from "./Privacy";

const initialPrefs = usePrefs.getState();

beforeEach(() => {
  vi.spyOn(ipc, "browsingDataClear").mockResolvedValue({ summary: "Cleared 3 history entries and 2 form entries.", failures: [], restart_needed: false });
  vi.spyOn(ipc, "networkRestartNeeded").mockResolvedValue(false);
  vi.spyOn(ipc, "permissionsList").mockResolvedValue({ profile_name: "Personal", container_name: "Personal", legacy_ignored: false, permissions: [] });
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
});

describe("Settings › Privacy › Clear browsing data", () => {
  it("offers form entries, asks first, and passes the choice and range to the host", async () => {
    render(<Privacy />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Form entries in this profile" }));
    fireEvent.click(screen.getByLabelText("Time range"));
    fireEvent.click(screen.getByRole("option", { name: "The last hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear now…" }));
    // Nothing goes until the confirmation is answered.
    expect(ipc.browsingDataClear).not.toHaveBeenCalled();
    expect(screen.getByText(/Clear browsing and download history and form entries from the last hour\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(ipc.browsingDataClear).toHaveBeenCalledWith({ history: true, cookies: false, cache: false, site_data: false, forms: true, since_hours: 1 }),
    );
    expect((await screen.findByText(/2 form entries/)).getAttribute("role")).toBe("status");
    expect(screen.getByText(/Saved passwords are not touched here/)).toBeTruthy();
  });

  it("reports what could not be cleared beside what was, and offers the restart", async () => {
    vi.spyOn(ipc, "browsingDataClear").mockResolvedValue({
      summary: "Cleared 3 history entries and cookies. Restart Dive to finish the profiles that were not open.",
      failures: ["Cache: target closed"],
      restart_needed: true,
    });
    render(<Privacy />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Cookies and signed-in sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear now…" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText(/Cleared 3 history entries and cookies/)).toBeTruthy();
    const failure = screen.getByText(/Cache: target closed/);
    expect(failure.closest("[role=alert]")?.className).toContain("text-danger");
    expect(screen.getAllByRole("button", { name: "Restart now" }).length).toBeGreaterThan(0);
  });

  it("names what is about to go", () => {
    expect(clearList({ history: true, cookies: false, cache: true, site_data: false, forms: true })).toBe("browsing and download history, cached files and form entries");
    expect(clearList({ history: false, cookies: true, cache: false, site_data: false, forms: false })).toBe("cookies");
  });
});

describe("Settings › Privacy › history retention", () => {
  it("says how many visits a shorter window deletes, and deletes only on yes", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, history_days: 90 }, loaded: true });
    vi.spyOn(ipc, "historyPruneCount").mockResolvedValue(1204);
    const set = vi.spyOn(ipc, "prefsSet").mockImplementation(async (prefs) => prefs);
    render(<Privacy />);
    fireEvent.click(screen.getByLabelText("Keep history for"));
    fireEvent.click(screen.getByRole("option", { name: "30 days" }));
    expect(await screen.findByText(/Delete 1,204 visits older than 30 days\?/)).toBeTruthy();
    expect(ipc.historyPruneCount).toHaveBeenCalledWith(30);
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(usePrefs.getState().prefs.history_days).toBe(90);

    fireEvent.click(screen.getByLabelText("Keep history for"));
    fireEvent.click(screen.getByRole("option", { name: "30 days" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(usePrefs.getState().prefs.history_days).toBe(30));
  });

  it("keeps a longer window without asking, and shows a custom one as itself", () => {
    expect(shortensRetention(30, 90)).toBe(false);
    expect(shortensRetention(30, 0)).toBe(false);
    expect(shortensRetention(0, 30)).toBe(true);
    expect(shortensRetention(90, 7)).toBe(true);
    expect(retentionOptions(45).at(-1)).toEqual({ value: "45", label: "Custom (45 days)" });
    expect(retentionOptions(30).some((o) => o.label.startsWith("Custom"))).toBe(false);
    expect(pruneQuestion(1, 7)).toBe("Delete 1 visit older than 7 days?");
  });
});

describe("Settings › Privacy › network", () => {
  it("warns when a saved proxy will be ignored and offers a restart once it differs from the running one", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, proxy_mode: "manual", proxy_server: "not a host" }, loaded: true });
    vi.spyOn(ipc, "networkRestartNeeded").mockResolvedValue(true);
    render(<Privacy />);
    const field = screen.getByLabelText("Proxy address");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/Write it as host:port/)).toBeTruthy();
    expect(await screen.findByText(/saved but not in force yet/)).toBeTruthy();
  });
});
