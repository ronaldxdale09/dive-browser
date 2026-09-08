import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { usePrefs } from "../../store/prefs";
import { Privacy } from "./Privacy";

const initialPrefs = usePrefs.getState();

beforeEach(() => {
  vi.spyOn(ipc, "browsingDataClear").mockResolvedValue("Cleared history (3), form entries (2)");
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
});

describe("Settings › Privacy › Clear browsing data", () => {
  it("offers form entries and passes the choice to the host", async () => {
    render(<Privacy />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Form entries in this profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear now" }));
    await waitFor(() => expect(ipc.browsingDataClear).toHaveBeenCalledWith({ history: true, cookies: false, cache: false, site_data: false, forms: true }));
    expect((await screen.findByRole("status")).textContent).toContain("form entries (2)");
    expect(screen.getByText(/Saved passwords are not touched here/)).toBeTruthy();
  });
});
