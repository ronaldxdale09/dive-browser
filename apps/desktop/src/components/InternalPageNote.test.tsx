import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { isInternalPage } from "./InternalPageNote";
import { MetaPanel } from "./MetaPanel";
import { VitalsPanel } from "./VitalsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dock panels with no tab", () => {
  it("drop the last page's numbers when the welcome screen shows", async () => {
    vi.spyOn(ipc, "tabVitals").mockResolvedValue({ ttfb: 10, fcp: 20, lcp: 30, cls: 0, inp: null, dcl: 40, load: 50, transfer_size: 100, lcp_element: "img.hero" });
    const tab = { id: "t1", workspace_id: "w", url: "https://example.com/", title: "Example", favicon: null, pinned: false, created_at: "", last_active_at: "", closed_at: null, position: 0 } as never;
    useBrowser.setState({ tabs: [tab], activeTab: "t1", loading: {} });
    render(<VitalsPanel />);
    expect(await screen.findByText("LCP element: img.hero")).toBeTruthy();
    act(() => useBrowser.setState({ tabs: [], activeTab: null }));
    expect(screen.getByText("Open a tab to measure its Web Vitals.")).toBeTruthy();
    expect(screen.queryByText("LCP element: img.hero")).toBeNull();
  });
});

describe("dock panels on Dive's own pages", () => {
  it("knows an internal page", () => {
    expect(isInternalPage("dive://screen")).toBe(true);
    expect(isInternalPage("https://example.com/")).toBe(false);
    expect(isInternalPage(undefined)).toBe(false);
  });

  it("say so instead of asking the page for metrics or metadata", () => {
    const vitals = vi.spyOn(ipc, "tabVitals");
    const meta = vi.spyOn(ipc, "tabMeta");
    const tab = { id: "t1", workspace_id: "w", url: "dive://screen", title: "DiveScreen", favicon: null, pinned: false, created_at: "", last_active_at: "", closed_at: null, position: 0 } as never;
    useBrowser.setState({ tabs: [tab], activeTab: "t1" });
    render(<><VitalsPanel /><MetaPanel /></>);
    expect(screen.getAllByText(/one of Dive’s own pages/).length).toBe(2);
    expect(vitals).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
  });
});
