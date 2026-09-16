import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { MetaPanel } from "./MetaPanel";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", loading: {} });
  vi.spyOn(ipc, "tabMeta").mockResolvedValue({
    title: "Hello page",
    description: "A description",
    canonical: "https://a.test/",
    lang: "en",
    viewport: null,
    robots: null,
    og: {},
    twitter: {},
    icons: [],
  });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("MetaPanel", () => {
  it("does not show a detached tab's metadata as this window's dock", () => {
    useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: ["t1"], loading: {} });
    render(<MetaPanel />);
    expect(screen.getByText("Open a tab to inspect its metadata.")).toBeTruthy();
    expect(screen.queryByText("Hello page")).toBeNull();
    expect(ipc.tabMeta).not.toHaveBeenCalled();
  });

  it("does not keep the last title when this tab is sleeping", async () => {
    render(<MetaPanel />);
    expect((await screen.findAllByText("Hello page")).length).toBeGreaterThan(0);
    await act(async () => {
      useBrowser.setState({ tabs: [{ ...tab, state: "discarded" }], activeTab: "t1" });
    });
    expect(screen.queryAllByText("Hello page")).toHaveLength(0);
    expect(screen.getByText(/sleeping/i)).toBeTruthy();
  });
});
