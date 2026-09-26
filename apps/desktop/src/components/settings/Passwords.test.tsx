import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { Passwords, REVEAL_MS, describeCsvImport, describeExport, filterLogins, siteLabel, sortLogins } from "./Passwords";

const login: Credential = { id: "c1", profile_id: "p1", origin: "https://github.com", username: "dale", created_at: "2026-09-08T00:00:00Z", last_used_at: null, uses: 0 };
const initial = useBrowser.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  vi.spyOn(ipc, "passwordsList").mockResolvedValue([login]);
  vi.spyOn(ipc, "passwordsReveal").mockResolvedValue("hunter2");
  vi.spyOn(ipc, "passwordsDelete").mockResolvedValue(true);
  vi.spyOn(ipc, "passwordsCopy").mockResolvedValue(true);
  vi.spyOn(ipc, "passwordsSave").mockResolvedValue({ kind: "saved", credential: { ...login, id: "c2", origin: "https://example.org", username: "eve" }, replaced: false });
  vi.spyOn(ipc, "passwordsEdit").mockResolvedValue({ ...login, username: "dale@github.com" });
  vi.spyOn(ipc, "passwordsExport").mockResolvedValue({ path: "/tmp/Dive Passwords.csv", exported: 1, failed: 0 });
  vi.spyOn(ipc, "passwordsPickCsv").mockResolvedValue("/tmp/passwords.csv");
  vi.spyOn(ipc, "formsList").mockResolvedValue([]);
  vi.spyOn(ipc, "passwordsNeverList").mockResolvedValue(["https://bank.example"]);
  vi.spyOn(ipc, "passwordsNeverRemove").mockResolvedValue(true);
  vi.spyOn(ipc, "passwordsImportCsv").mockResolvedValue({ added: 2, skipped: 1, unreadable: 0, failed: 0, failure: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("Settings › Passwords", () => {
  it("shows the site without its scheme", () => {
    expect(siteLabel("https://accounts.google.com")).toBe("accounts.google.com");
    expect(siteLabel("http://localhost:3000")).toBe("localhost:3000");
  });

  it("lists logins with the password hidden until shown, and copies it", async () => {
    render(<Passwords />);
    expect(await screen.findByText("github.com")).toBeTruthy();
    expect(screen.getByLabelText("Password hidden").textContent).toBe("••••••••");
    fireEvent.click(screen.getByRole("button", { name: "Show password for dale" }));
    await waitFor(() => expect(screen.getByLabelText("Password").textContent).toBe("hunter2"));
    expect(ipc.passwordsReveal).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByRole("button", { name: "Hide password for dale" }));
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();
  });

  it("hides a shown password again after a while, and when the window loses focus", async () => {
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Show password for dale" }));
    await waitFor(() => expect(screen.getByLabelText("Password").textContent).toBe("hunter2"));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Show password for dale" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Password").textContent).toBe("hunter2");
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();
  });

  it("stays hidden when the OS check is cancelled", async () => {
    vi.mocked(ipc.passwordsReveal).mockResolvedValue(null);
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Show password for dale" }));
    await waitFor(() => expect(ipc.passwordsReveal).toHaveBeenCalled());
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("copies through the host, which checks the owner and clears the clipboard", async () => {
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy password for dale" }));
    await waitFor(() => expect(ipc.passwordsCopy).toHaveBeenCalledWith("c1"));
    expect(ipc.passwordsReveal).not.toHaveBeenCalled();
    await waitFor(() => expect(useBrowser.getState().notice).toContain("clears from the clipboard"));
  });

  it("asks before forgetting a login", async () => {
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget login for dale on github.com" }));
    expect(ipc.passwordsDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByText("github.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget login for dale on github.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget login for dale on github.com for good" }));
    await waitFor(() => expect(ipc.passwordsDelete).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("github.com")).toBeNull());
    expect(useBrowser.getState().notice).toContain("Forgot the login for github.com");
  });

  it("imports a CSV export and reports what came in", async () => {
    expect(describeCsvImport({ added: 1, skipped: 0, unreadable: 0, failed: 0, failure: null })).toBe("Imported 1 login");
    expect(describeCsvImport({ added: 12, skipped: 3, unreadable: 1, failed: 2, failure: "no" })).toBe("Imported 12 logins, 3 already here, 1 unreadable, 2 not saved");
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: /Import a CSV export/ }));
    await waitFor(() => expect(ipc.passwordsImportCsv).toHaveBeenCalledWith("/tmp/passwords.csv"));
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Imported 2 logins, 1 already here"));
    expect(ipc.passwordsList).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the file picker is cancelled", async () => {
    vi.mocked(ipc.passwordsPickCsv).mockResolvedValue(null);
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: /Import a CSV export/ }));
    await waitFor(() => expect(ipc.passwordsPickCsv).toHaveBeenCalled());
    expect(ipc.passwordsImportCsv).not.toHaveBeenCalled();
  });

  it("adds a login and lists it", async () => {
    vi.mocked(ipc.passwordsList).mockResolvedValue([]);
    render(<Passwords />);
    expect(await screen.findByText(/No logins saved yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "example.org" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "eve" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(ipc.passwordsSave).toHaveBeenCalledWith("example.org", "eve", "pw", false));
    expect(await screen.findByText("example.org")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add login" })).toBeNull();
  });

  it("asks before an added login replaces a saved password", async () => {
    vi.mocked(ipc.passwordsSave).mockResolvedValueOnce({ kind: "exists", origin: "https://github.com" }).mockResolvedValueOnce({ kind: "saved", credential: login, replaced: true });
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Add login" }));
    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "github.com" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dale" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    expect(await screen.findByText(/Replace the saved password\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace password" }));
    await waitFor(() => expect(ipc.passwordsSave).toHaveBeenLastCalledWith("github.com", "dale", "new", true));
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Replaced the saved password for github.com"));
  });

  it("keeps Settings open on Escape in the add form: a filled field clears, then the form closes", async () => {
    function SettingsHost() {
      const [open, setOpen] = useState(true);
      if (!open) return null;
      return (
        <div role="dialog" aria-label="Settings" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <Passwords />
        </div>
      );
    }
    render(<SettingsHost />);
    fireEvent.click(await screen.findByRole("button", { name: "Add login" }));
    const site = screen.getByLabelText("Site") as HTMLInputElement;
    fireEvent.change(site, { target: { value: "example.org" } });
    fireEvent.keyDown(site, { key: "Escape" });
    expect(site.value).toBe("");
    expect(screen.getByRole("form", { name: "Add login" })).toBeTruthy();
    fireEvent.keyDown(site, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Add login" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("edits a login's username and password", async () => {
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit login for dale on github.com" }));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dale@github.com" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(ipc.passwordsEdit).toHaveBeenCalledWith("c1", "dale@github.com", "s3cret"));
    expect(await screen.findByRole("button", { name: "Edit login for dale@github.com on github.com" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Edit login for github.com" })).toBeNull();
  });

  it("filters by site or username and sorts by the site shown", async () => {
    const local: Credential = { ...login, id: "c3", origin: "http://localhost:3000", username: "dev" };
    const amy: Credential = { ...login, id: "c4", origin: "https://accounts.example.com", username: "amy" };
    expect(sortLogins([login, local, amy]).map((c) => c.id)).toEqual(["c4", "c1", "c3"]);
    expect(filterLogins([login, local, amy], "LOCAL").map((c) => c.id)).toEqual(["c3"]);
    expect(filterLogins([login, local, amy], "amy").map((c) => c.id)).toEqual(["c4"]);
    vi.mocked(ipc.passwordsList).mockResolvedValue([amy, login, local]);
    render(<Passwords />);
    fireEvent.change(await screen.findByLabelText("Filter saved logins"), { target: { value: "git" } });
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.queryByText("localhost:3000")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter saved logins"), { target: { value: "nothing" } });
    expect(screen.getByText(/No saved login matches/)).toBeTruthy();
  });

  it("lists every login even when there are enough to window the list", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...login, id: `m${i}`, origin: `https://site${String(i).padStart(3, "0")}.test` }));
    vi.mocked(ipc.passwordsList).mockResolvedValue(many);
    render(<Passwords />);
    expect(await screen.findByText("site000.test")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter saved logins"), { target: { value: "site149" } });
    expect(screen.getByText("site149.test")).toBeTruthy();
  });

  it("warns that an export is plain text before asking the host for it", async () => {
    expect(describeExport({ path: "/x.csv", exported: 3, failed: 1 })).toMatch(/Exported 3 logins to \/x\.csv\. 1 could not be read/);
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: /Export passwords/ }));
    expect(screen.getByText(/every saved password in plain text/)).toBeTruthy();
    expect(ipc.passwordsExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export as CSV…" }));
    await waitFor(() => expect(ipc.passwordsExport).toHaveBeenCalled());
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Exported 1 login to /tmp/Dive Passwords.csv"));
  });

  it("lists sites never saved for and lets one ask again", async () => {
    render(<Passwords />);
    expect(await screen.findByText("bank.example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(ipc.passwordsNeverRemove).toHaveBeenCalledWith("https://bank.example");
    await waitFor(() => expect(screen.queryByText("bank.example")).toBeNull());
    expect(screen.queryByText("Never saved")).toBeNull();
  });

  it("does not say Chrome passwords are read directly on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Passwords />);
    expect(document.body.textContent).not.toMatch(/are read directly/);
    expect(document.body.textContent).toMatch(/AppData/);
  });

  it("does not say passwords live only in the macOS Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Passwords />);
    expect(document.body.textContent).not.toMatch(/macOS Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });
});
