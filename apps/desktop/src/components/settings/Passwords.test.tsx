import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { Passwords, siteLabel } from "./Passwords";

const login: Credential = { id: "c1", profile_id: "p1", origin: "https://github.com", username: "dale", created_at: "2026-09-08T00:00:00Z", last_used_at: null, uses: 0 };
const initial = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "passwordsList").mockResolvedValue([login]);
  vi.spyOn(ipc, "passwordsReveal").mockResolvedValue("hunter2");
  vi.spyOn(ipc, "passwordsDelete").mockResolvedValue(true);
  vi.spyOn(ipc, "passwordsSave").mockResolvedValue({ ...login, id: "c2", origin: "https://example.org", username: "eve" });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
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

  it("forgets a login and confirms it", async () => {
    render(<Passwords />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget login for dale on github.com" }));
    await waitFor(() => expect(ipc.passwordsDelete).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("github.com")).toBeNull());
    expect(useBrowser.getState().notice).toContain("Forgot the login for github.com");
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
    await waitFor(() => expect(ipc.passwordsSave).toHaveBeenCalledWith("example.org", "eve", "pw"));
    expect(await screen.findByText("example.org")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add login" })).toBeNull();
  });
});
