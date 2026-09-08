import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { VitalsPanel } from "./VitalsPanel";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", loading: {} });
  vi.spyOn(ipc, "tabVitals").mockResolvedValue({ ttfb: 945, fcp: 1440, lcp: 1440, cls: 0.002, inp: null, dcl: 1500, load: 2410, transfer_size: 53248, lcp_element: "p.intro" });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("VitalsPanel", () => {
  it("says the rating in words, explains a missing INP, and reveals the LCP element", async () => {
    const reveal = vi.spyOn(ipc, "tabA11yReveal").mockResolvedValue(true);
    render(<VitalsPanel />);
    const lcp = await screen.findByRole("button", { name: "Show the LCP element p.intro in the page" });
    expect(screen.getAllByText("good").length).toBe(3);
    expect(screen.getByText("needs work")).toBeTruthy();
    expect(screen.getByText("no input yet")).toBeTruthy();
    expect(screen.getByLabelText("Time to First Byte: 945 ms, needs work")).toBeTruthy();
    fireEvent.click(lcp);
    expect(reveal).toHaveBeenCalledWith("t1", "p.intro");
    reveal.mockResolvedValue(false);
    fireEvent.click(lcp);
    expect(await screen.findByText("(not on the page now)")).toBeTruthy();
  });
});
