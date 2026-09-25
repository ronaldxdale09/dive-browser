import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { CredentialPrompt } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { useCredentialPrompt } from "../store/credentialPrompt";
import { CredentialPromptCard } from "./CredentialPromptCard";

const save: CredentialPrompt = { tab_id: "t1", kind: "save", origin: "https://github.com", username: "dale", token: "tok1" };
const missing: CredentialPrompt = { tab_id: "t1", kind: "missing", origin: "https://github.com", username: "eve", token: "c2" };
const initialBrowser = useBrowser.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  // The host saves only on a yes; a "not now" returns nothing.
  vi.spyOn(ipc, "passwordsAnswer").mockImplementation(async (_token, save) => (save ? { id: "c1", profile_id: "p1", origin: "https://github.com", username: "dale", created_at: "", last_used_at: null, uses: 0 } : null));
  vi.spyOn(ipc, "passwordsNever").mockResolvedValue("https://github.com");
  useCredentialPrompt.setState({ byTab: {}, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("CredentialPromptCard", () => {
  it("offers to save a submitted login for the active tab only, and saves it", async () => {
    useCredentialPrompt.setState({ byTab: { t1: save } });
    render(<CredentialPromptCard tabId="other" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    render(<CredentialPromptCard tabId="t1" />);
    const dialog = screen.getByRole("dialog", { name: "Save the password for github.com?" });
    expect(dialog.textContent).toContain("dale");
    expect(contentCoverDepth()).toBe(1);
    // It never takes the keyboard: the next Enter belongs to the page.
    expect(document.activeElement).toBe(document.body);
    expect(dialog.hasAttribute("data-overlay-passive")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", true));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(useBrowser.getState().notice).toContain("Saved the login for github.com"));
  });

  it("can refuse a site for good, and says where to undo it", async () => {
    useCredentialPrompt.setState({ byTab: { t1: save } });
    render(<CredentialPromptCard tabId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Never for this site" }));
    await waitFor(() => expect(ipc.passwordsNever).toHaveBeenCalledWith("tok1"));
    expect(ipc.passwordsAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(useBrowser.getState().notice).toContain("github.com"));
    expect(useBrowser.getState().notice).toContain("Settings › Passwords & forms");
    expect(screen.queryByRole("dialog")).toBeNull();
    // An update is for a site already saved: no "never" there.
    useCredentialPrompt.setState({ byTab: { t1: { ...save, kind: "update" } } });
    expect(screen.queryByRole("button", { name: "Never for this site" })).toBeNull();
  });

  it("lets the login go with Not now, and names an update as such", async () => {
    useCredentialPrompt.setState({ byTab: { t1: { ...save, kind: "update" } } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(screen.getByRole("dialog", { name: "Update the password for github.com?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", false));
    expect(useBrowser.getState().notice).toBeNull();
    cleanup();
    useCredentialPrompt.setState({ byTab: { t1: { ...save, kind: "update" } } });
    render(<CredentialPromptCard tabId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Updated the password for github.com"));
  });

  it("does not say a saved login lives only in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    useCredentialPrompt.setState({ byTab: { t1: save } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("closes on Escape as Not now, so the host lets the password go", async () => {
    useCredentialPrompt.setState({ byTab: { t1: save } });
    render(<CredentialPromptCard tabId="t1" />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useBrowser.getState().error).toBeNull();
  });

  it("moves below the find bar instead of covering it", () => {
    useBrowser.setState({ open: { ...useBrowser.getState().open, find: true } });
    useCredentialPrompt.setState({ byTab: { t1: save } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(screen.getByRole("dialog").style.top).toBe("52px");
  });

  it("lets a closed tab's login go instead of holding it", async () => {
    vi.spyOn(ipc, "passwordsAnswer").mockResolvedValue(null);
    useCredentialPrompt.setState({ listening: false });
    vi.spyOn(await import("../lib/ipc").then((m) => m.events.credentialPrompt), "listen").mockResolvedValue(() => undefined);
    useBrowser.setState({ tabs: [{ id: "t1", url: "https://github.com/login" } as never] });
    await useCredentialPrompt.getState().init();
    useCredentialPrompt.setState({ byTab: { t1: save } });
    useBrowser.setState({ tabs: [] });
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", false));
    expect(useCredentialPrompt.getState().byTab.t1).toBeUndefined();
  });

  it("offers to forget a login whose Keychain item is gone", async () => {
    const remove = vi.spyOn(ipc, "passwordsDelete").mockResolvedValue(true);
    useCredentialPrompt.setState({ byTab: { t1: missing } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(screen.getByRole("dialog", { name: "The Keychain no longer has the password for eve" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget login" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("c2"));
    await waitFor(() => expect(useBrowser.getState().notice).toContain("Forgot the login for eve"));
    expect(ipc.passwordsAnswer).not.toHaveBeenCalled();
  });

  it("names Credential Manager for a lost password on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    useCredentialPrompt.setState({ byTab: { t1: missing } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });
});
