import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { A11yPanel } from "./A11yPanel";

vi.mock("axe-core/axe.min.js?raw", () => ({ default: "/* axe */" }));

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1" });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("A11yPanel", () => {
  it("announces the result of a run, counts one violation in the singular, and lists it", async () => {
    vi.spyOn(ipc, "tabA11y").mockResolvedValue({
      violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternative text", help_url: "https://x/image-alt", targets: ["img"], notes: [""], count: 1 }],
      passes: 14,
      incomplete: 0,
    });
    render(<A11yPanel />);
    expect(screen.getByText("Run axe-core against the current page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    expect((await screen.findByRole("status")).textContent).toBe("1 violation · 14 passed · 0 to review");
    expect(screen.getByText("Images must have alternative text")).toBeTruthy();
    expect(ipc.tabA11y).toHaveBeenCalledWith("t1", "/* axe */");
  });

  it("opens rule docs as a Dive tab and reveals a target in the page", async () => {
    vi.spyOn(ipc, "tabA11y").mockResolvedValue({
      violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternative text", help_url: "https://x/image-alt", targets: ["img"], notes: [""], count: 1 }],
      passes: 14,
      incomplete: 0,
    });
    const reveal = vi.spyOn(ipc, "tabA11yReveal").mockResolvedValue(true);
    const openTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ openTab });
    render(<A11yPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Docs for image-alt" }));
    expect(openTab).toHaveBeenCalledWith("https://x/image-alt");
    fireEvent.click(screen.getByRole("button", { name: "Show img in the page" }));
    expect(reveal).toHaveBeenCalledWith("t1", "img");
    await waitFor(() => expect(screen.queryByText(/Not on the page/)).toBeNull());
    reveal.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Show img in the page" }));
    expect(await screen.findByText("Not on the page any more. Run the audit again.")).toBeTruthy();
  });

  it("keeps a report with the tab it was run on", async () => {
    vi.spyOn(ipc, "tabA11y").mockResolvedValue({ violations: [], passes: 3, incomplete: 0 });
    const other = { ...tab, id: "t2", url: "https://b.test/" };
    useBrowser.setState({ tabs: [tab, other], activeTab: "t1" });
    render(<A11yPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    expect((await screen.findByRole("status")).textContent).toBe("0 violations · 3 passed · 0 to review");
    act(() => useBrowser.setState({ activeTab: "t2" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Run axe-core against the current page.")).toBeTruthy();
    act(() => useBrowser.setState({ activeTab: "t1" }));
    expect(screen.getByRole("status").textContent).toBe("0 violations · 3 passed · 0 to review");
  });

  it("reports a failed run as an alert", async () => {
    vi.spyOn(ipc, "tabA11y").mockRejectedValue(new Error("page went away"));
    render(<A11yPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("page went away"));
  });
});
