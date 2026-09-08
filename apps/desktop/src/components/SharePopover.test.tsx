import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { SharePopover } from "./SharePopover";
import { OPEN_SHARE } from "../lib/commands";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "http://localhost:3000/docs",
  title: "Docs",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-04T00:00:00Z",
};

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id });
  vi.spyOn(ipc, "shareUrl").mockResolvedValue({
    lan_url: "http://192.168.1.2:3000/docs",
    qr_svg: "<svg></svg>",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SharePopover", () => {
  it("opens when the page menu asks for a QR code", async () => {
    render(<SharePopover />);
    expect(screen.queryByRole("dialog")).toBeNull();
    window.dispatchEvent(new CustomEvent(OPEN_SHARE));
    expect(await screen.findByRole("dialog", { name: "Share" })).toBeTruthy();
  });

  it("names the QR code, says while the address is found, and announces a copy", async () => {
    let resolve!: (v: { lan_url: string; qr_svg: string }) => void;
    vi.mocked(ipc.shareUrl).mockReturnValue(new Promise((r) => (resolve = r)));
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(<SharePopover />);
    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    expect(screen.getByRole("status").textContent).toContain("Finding this Mac's address");
    resolve({ lan_url: "http://192.168.1.2:3000/docs", qr_svg: "<svg></svg>" });
    expect(await screen.findByRole("img", { name: "QR code for http://192.168.1.2:3000/docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("http://192.168.1.2:3000/docs"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("Link copied")).toBeTruthy();
  });

  it("shows a clipboard failure and leaves copy available for retry", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<SharePopover />);
    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    await screen.findByText("http://192.168.1.2:3000/docs");

    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.click(copy);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("clipboard unavailable"));
    expect((copy as HTMLButtonElement).disabled).toBe(false);
    expect(writeText).toHaveBeenCalledWith("http://192.168.1.2:3000/docs");
  });
});
