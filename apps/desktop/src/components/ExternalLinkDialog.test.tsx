import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { ExternalLinkAsked } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useExternalLink } from "../store/externalLink";
import { ExternalLinkDialog } from "./ExternalLinkDialog";

const asked: ExternalLinkAsked = { tab_id: "t1", token: "tok1", app: "Claude", scheme: "claude", origin: "claude.ai" };

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "externalLinkOpen").mockResolvedValue(null);
  vi.spyOn(ipc, "externalLinkDismiss").mockResolvedValue(undefined);
  useExternalLink.setState({ asked: null, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useExternalLink.setState({ asked: null, listening: false });
  vi.restoreAllMocks();
});

describe("ExternalLinkDialog", () => {
  it("names the app and the site, and opens on a yes", async () => {
    useExternalLink.setState({ asked });
    render(<ExternalLinkDialog />);
    const dialog = screen.getByRole("dialog", { name: "Open Claude?" });
    expect(dialog.textContent).toContain("claude.ai wants to open this application");
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Claude" })));
    fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
    // Without the tick, the site is not remembered.
    await waitFor(() => expect(ipc.externalLinkOpen).toHaveBeenCalledWith("tok1", false));
    expect(useExternalLink.getState().asked).toBeNull();
  });

  it("remembers the site only when asked to", async () => {
    useExternalLink.setState({ asked });
    render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
    await waitFor(() => expect(ipc.externalLinkOpen).toHaveBeenCalledWith("tok1", true));
  });

  it("lets the link go on cancel, and tells the host so", async () => {
    useExternalLink.setState({ asked });
    render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(ipc.externalLinkDismiss).toHaveBeenCalledWith("tok1"));
    expect(ipc.externalLinkOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The cover is released with it; a stuck cover blacks out the page.
    await waitFor(() => expect(contentCoverDepth()).toBe(0));
  });

  it("asks without an app name when the system knows no handler", () => {
    useExternalLink.setState({ asked: { ...asked, app: null } });
    render(<ExternalLinkDialog />);
    const dialog = screen.getByRole("dialog", { name: "Open this link in another app?" });
    expect(dialog.textContent).toContain("claude.ai wants to open a claude: link");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("starts each question with the tick cleared", () => {
    useExternalLink.setState({ asked });
    const { rerender } = render(<ExternalLinkDialog />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    useExternalLink.setState({ asked: { ...asked, token: "tok2" } });
    rerender(<ExternalLinkDialog />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });
});
