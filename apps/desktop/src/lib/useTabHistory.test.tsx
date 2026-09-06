import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { events, ipc } from "./ipc";
import { useTabHistory } from "./useTabHistory";

vi.mock("./ipc", () => ({
  ipc: { tabHistory: vi.fn() },
  events: { tabHistoryChanged: { listen: vi.fn() } },
}));

const history = (index: number) => ({ generation: "view-1", current_index: index, entries: [
  { id: 10, url: "https://example.com/one", title: "One" },
  { id: 20, url: "https://example.com/two", title: "Two" },
] });
let changed: (event: { payload: { tab_id: string } }) => void;
const unlisten = vi.fn();
beforeEach(() => {
  vi.mocked(ipc.tabHistory).mockResolvedValue(history(0));
  vi.mocked(events.tabHistoryChanged.listen).mockImplementation(async (callback) => {
    changed = (event) => callback({ event: "tab-history-changed", id: 0, ...event });
    return unlisten;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("derives availability from the engine's current history index", async () => {
  const { result } = renderHook(() => useTabHistory("one", "https://example.com", false));
  expect(result.current.canBack).toBe(false);
  expect(result.current.canForward).toBe(false);
  await waitFor(() => expect(result.current.canForward).toBe(true));
  expect(result.current.canBack).toBe(false);
  vi.mocked(ipc.tabHistory).mockResolvedValue(history(1));
  act(() => changed({ payload: { tab_id: "one" } }));
  await waitFor(() => expect(result.current.canBack).toBe(true));
  expect(result.current.canForward).toBe(false);
});

it("refreshes same-URL history changes and ignores another tab's events", async () => {
  renderHook(() => useTabHistory("one", "https://example.com", false));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(1));
  act(() => changed({ payload: { tab_id: "other" } }));
  expect(ipc.tabHistory).toHaveBeenCalledTimes(1);
  act(() => changed({ payload: { tab_id: "one" } }));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(2));
});

it("does not expose a previous tab's history while the next request is pending", async () => {
  const { result, rerender } = renderHook(({ tab }) => useTabHistory(tab, "https://same.com", false), { initialProps: { tab: "one" } });
  await waitFor(() => expect(result.current.canForward).toBe(true));
  let resolve!: (value: ReturnType<typeof history>) => void;
  vi.mocked(ipc.tabHistory).mockImplementation(() => new Promise((done) => { resolve = done; }));
  rerender({ tab: "two" });
  expect(result.current.history).toBeNull();
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenLastCalledWith("two"));
  await act(async () => resolve(history(1)));
  expect(result.current.canBack).toBe(true);
});

it("coalesces pending refreshes, discards stale replies and clears availability on failure", async () => {
  let old!: (value: ReturnType<typeof history>) => void;
  vi.mocked(ipc.tabHistory).mockImplementationOnce(() => new Promise((done) => { old = done; }));
  const { result } = renderHook(() => useTabHistory("one", "https://example.com", false));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(1));
  vi.mocked(ipc.tabHistory).mockResolvedValue(history(1));
  act(() => changed({ payload: { tab_id: "one" } }));
  act(() => changed({ payload: { tab_id: "one" } }));
  expect(ipc.tabHistory).toHaveBeenCalledTimes(1);
  await act(async () => old(history(0)));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(2));
  expect(result.current.canBack).toBe(true);
  vi.mocked(ipc.tabHistory).mockRejectedValue(new Error("closed"));
  act(() => changed({ payload: { tab_id: "one" } }));
  await waitFor(() => expect(result.current.history).toBeNull());
  expect(result.current.canBack).toBe(false);
});

it("cleans up a subscription that finishes registering after unmount", async () => {
  let subscribed!: (value: () => void) => void;
  vi.mocked(events.tabHistoryChanged.listen).mockImplementation(() => new Promise((done) => { subscribed = done; }));
  const { unmount } = renderHook(() => useTabHistory("one", "https://example.com", false));
  unmount();
  await act(async () => subscribed(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});
