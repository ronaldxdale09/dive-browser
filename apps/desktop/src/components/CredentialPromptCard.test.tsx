import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { CredentialPrompt } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { useCredentialPrompt } from "../store/credentialPrompt";
import { CredentialPromptCard } from "./CredentialPromptCard";

const save: CredentialPrompt = { tab_id: "t1", kind: "save", origin: "https://github.com", username: "dale", usernames: [], token: "tok1" };
const initialBrowser = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  // The host saves only on a yes; a "not now" returns nothing.
  vi.spyOn(ipc, "passwordsAnswer").mockImplementation(async (_token, save) => (save ? { id: "c1", profile_id: "p1", origin: "https://github.com", username: "dale", created_at: "", last_used_at: null, uses: 0 } : null));
  vi.spyOn(ipc, "passwordsForUrl").mockResolvedValue([
    { id: "c1", profile_id: "p1", origin: "https://github.com", username: "dale", created_at: "", last_used_at: null, uses: 0 },
    { id: "c2", profile_id: "p1", origin: "https://github.com", username: "eve", created_at: "", last_used_at: null, uses: 0 },
  ]);
  vi.spyOn(ipc, "passwordsFill").mockResolvedValue(null);
  useCredentialPrompt.setState({ byTab: {}, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" })));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", true));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(useBrowser.getState().notice).toContain("Saved the login for github.com"));
  });

  it("lets the login go with Not now, and names an update as such", async () => {
    useCredentialPrompt.setState({ byTab: { t1: { ...save, kind: "update" } } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(screen.getByRole("dialog", { name: "Update the password for github.com?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(ipc.passwordsAnswer).toHaveBeenCalledWith("tok1", false));
    expect(useBrowser.getState().notice).toBeNull();
  });

  it("fills the chosen login when several are saved", async () => {
    useCredentialPrompt.setState({ byTab: { t1: { ...save, kind: "pick", username: "", usernames: ["dale", "eve"], token: "" } } });
    render(<CredentialPromptCard tabId="t1" />);
    expect(screen.getByRole("dialog", { name: "Sign in to github.com as" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "eve" }));
    await waitFor(() => expect(ipc.passwordsFill).toHaveBeenCalledWith("t1", "c2"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
