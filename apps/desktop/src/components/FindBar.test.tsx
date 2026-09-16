import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { FindBar } from "./FindBar";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", toggle: vi.fn() });
  vi.spyOn(ipc, "tabFind").mockResolvedValue({ current: 1, total: 3 });
  vi.spyOn(ipc, "tabFocus").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("FindBar", () => {
  it("does not keep a detached tab's match count as this window's", async () => {
    render(<FindBar />);
    fireEvent.change(screen.getByLabelText("Find in page"), { target: { value: "hello" } });
    expect(await screen.findByLabelText("Match 1 of 3")).toBeTruthy();
    const calls = vi.mocked(ipc.tabFind).mock.calls.length;
    act(() => useBrowser.setState({ detached: ["t1"] }));
    await waitFor(() => expect(screen.queryByLabelText("Match 1 of 3")).toBeNull());
    expect(screen.queryByText("1/3")).toBeNull();
    expect(screen.queryByText("0/0")).toBeNull();
    expect(screen.queryByLabelText("No matches")).toBeNull();
    expect(vi.mocked(ipc.tabFind).mock.calls.slice(calls).every((c) => c[0] !== "t1" || c[1] === "")).toBe(true);
  });

  it("does not keep the last match count when this tab is sleeping", async () => {
    render(<FindBar />);
    fireEvent.change(screen.getByLabelText("Find in page"), { target: { value: "hello" } });
    expect(await screen.findByLabelText("Match 1 of 3")).toBeTruthy();
    act(() => useBrowser.setState({ tabs: [{ ...tab, state: "discarded" }], activeTab: "t1" }));
    await waitFor(() => expect(screen.queryByLabelText("Match 1 of 3")).toBeNull());
    expect(screen.queryByText("1/3")).toBeNull();
  });
});
