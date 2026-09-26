import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { ExternalLinkAsked } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { useExternalLink } from "../store/externalLink";
import { ExternalLinkDialog } from "./ExternalLinkDialog";

const asked: ExternalLinkAsked = { tab_id: "t1", token: "tok1", app: "Claude", scheme: "claude", target: "claude://login", origin: "claude.ai" };

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "externalLinkOpen").mockResolvedValue(null);
  vi.spyOn(ipc, "externalLinkDismiss").mockResolvedValue(undefined);
  useExternalLink.setState({ questions: [], listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useExternalLink.setState({ questions: [], listening: false });
  useBrowser.setState({ detached: [] });
  vi.restoreAllMocks();
});

describe("ExternalLinkDialog", () => {
  it("names the app and the site, and opens on a yes", async () => {
    useExternalLink.setState({ questions: [asked] });
    render(<ExternalLinkDialog />);
    const dialog = screen.getByRole("dialog", { name: "Open Claude?" });
    expect(dialog.textContent).toContain("claude.ai wants to open this application");
    // Where the link goes, without the codes in the rest of it.
    expect(dialog.textContent).toContain("claude://login");
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Claude" })));
    fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
    // Without the tick, the site is not remembered.
    await waitFor(() => expect(ipc.externalLinkOpen).toHaveBeenCalledWith("tok1", false));
    expect(useExternalLink.getState().questions).toEqual([]);
  });

  it("remembers the site only when asked to", async () => {
    useExternalLink.setState({ questions: [asked] });
    render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
    await waitFor(() => expect(ipc.externalLinkOpen).toHaveBeenCalledWith("tok1", true));
  });

  it("lets the link go on cancel, and tells the host so", async () => {
    useExternalLink.setState({ questions: [asked] });
    render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(ipc.externalLinkDismiss).toHaveBeenCalledWith("tok1"));
    expect(ipc.externalLinkOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The cover is released with it; a stuck cover blacks out the page.
    await waitFor(() => expect(contentCoverDepth()).toBe(0));
  });

  it("asks without an app name when the system knows no handler", () => {
    useExternalLink.setState({ questions: [{ ...asked, app: null }] });
    render(<ExternalLinkDialog />);
    const dialog = screen.getByRole("dialog", { name: "Open this link in another app?" });
    expect(dialog.textContent).toContain("claude.ai wants to open a claude: link");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("starts each question with the tick cleared", () => {
    useExternalLink.setState({ questions: [asked] });
    const { rerender } = render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    useExternalLink.setState({ questions: [{ ...asked, token: "tok2" }] });
    rerender(<ExternalLinkDialog />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("asks in the window that shows the page", () => {
    // The main window leaves a torn-off tab's question to that tab's window.
    useBrowser.setState({ detached: ["t1"] });
    useExternalLink.setState({ questions: [asked] });
    const { rerender } = render(<ExternalLinkDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<ExternalLinkDialog tabId="t1" />);
    expect(screen.getByRole("dialog", { name: "Open Claude?" })).toBeTruthy();
    // A detached window shows its own tab's question only.
    rerender(<ExternalLinkDialog tabId="t2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the newest question among this window's tabs", () => {
    useExternalLink.setState({ questions: [asked, { ...asked, tab_id: "t2", token: "tok2", app: "Zoom", scheme: "zoommtg" }] });
    render(<ExternalLinkDialog />);
    expect(screen.getByRole("dialog", { name: "Open Zoom?" })).toBeTruthy();
  });
});
