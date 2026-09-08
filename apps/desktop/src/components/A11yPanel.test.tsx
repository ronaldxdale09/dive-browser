import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("reports a failed run as an alert", async () => {
    vi.spyOn(ipc, "tabA11y").mockRejectedValue(new Error("page went away"));
    render(<A11yPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("page went away"));
  });
});
