import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { events, ipc } from "./ipc";
import { canGoBack, firstBackIndex, useTabHistory } from "./useTabHistory";

vi.mock("./ipc", () => ({
  ipc: { tabHistory: vi.fn() },
  events: { tabHistoryChanged: { listen: vi.fn() } },
}));

const history = (index: number) => ({ generation: "view-1", current_index: index, entries: [
  { id: 10, url: "https://example.com/one", title: "One" },
  { id: 20, url: "https://example.com/two", title: "Two" },
] });
type Moved = { tab_id: string; can_go_back: boolean; can_go_forward: boolean };
let changed: (event: { payload: Moved }) => void;
const unlisten = vi.fn();
beforeEach(() => {
  vi.mocked(ipc.tabHistory).mockResolvedValue(history(0));
  vi.mocked(events.tabHistoryChanged.listen).mockImplementation(async (callback) => {
    changed = (event) => callback({ event: "tab-history-changed", id: 0, ...event });
    return unlisten;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("reads the stack once when shown, then follows the engine's announcements without reading again", async () => {
  const { result, rerender } = renderHook(({ url }) => useTabHistory("one", url), { initialProps: { url: "https://example.com/one" } });
  expect(result.current.canBack).toBe(false);
  await waitFor(() => expect(result.current.canForward).toBe(true));
  act(() => changed({ payload: { tab_id: "one", can_go_back: true, can_go_forward: false } }));
  expect(result.current.canBack).toBe(true);
  expect(result.current.canForward).toBe(false);
  // Moving and loading are not reasons to read the stack again.
  rerender({ url: "https://example.com/two" });
  act(() => changed({ payload: { tab_id: "other", can_go_back: false, can_go_forward: true } }));
  expect(result.current.canBack).toBe(true);
  expect(ipc.tabHistory).toHaveBeenCalledTimes(1);
});

it("reads the entries on demand for the history menu", async () => {
  const { result } = renderHook(() => useTabHistory("one", "https://example.com/two"));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(1));
  vi.mocked(ipc.tabHistory).mockResolvedValue(history(1));
  await expect(result.current.loadHistory()).resolves.toEqual(history(1));
  vi.mocked(ipc.tabHistory).mockRejectedValue(new Error("closed"));
  await expect(result.current.loadHistory()).resolves.toBeNull();
});

it("prefers an announcement to a first read that answers after it", async () => {
  let first!: (value: ReturnType<typeof history>) => void;
  vi.mocked(ipc.tabHistory).mockImplementationOnce(() => new Promise((done) => { first = done; }));
  const { result } = renderHook(() => useTabHistory("one", "https://example.com"));
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(1));
  act(() => changed({ payload: { tab_id: "one", can_go_back: true, can_go_forward: false } }));
  await act(async () => first(history(0)));
  expect(result.current.canBack).toBe(true);
  expect(result.current.canForward).toBe(false);
});

it("does not expose a previous tab's availability while the next read is pending", async () => {
  const { result, rerender } = renderHook(({ tab }) => useTabHistory(tab, "https://same.com"), { initialProps: { tab: "one" } });
  await waitFor(() => expect(result.current.canForward).toBe(true));
  let resolve!: (value: ReturnType<typeof history>) => void;
  vi.mocked(ipc.tabHistory).mockImplementation(() => new Promise((done) => { resolve = done; }));
  rerender({ tab: "two" });
  expect(result.current.canForward).toBe(false);
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenLastCalledWith("two"));
  await act(async () => resolve(history(1)));
  expect(result.current.canBack).toBe(true);
});

it("clears availability when the first read fails, and for internal pages", async () => {
  vi.mocked(ipc.tabHistory).mockRejectedValue(new Error("closed"));
  const { result, rerender } = renderHook(({ url }) => useTabHistory("one", url), { initialProps: { url: "https://example.com" } });
  await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalledTimes(1));
  expect(result.current.canBack).toBe(false);
  act(() => changed({ payload: { tab_id: "one", can_go_back: true, can_go_forward: true } }));
  expect(result.current.canBack).toBe(true);
  rerender({ url: "dive://settings" });
  expect(result.current.canBack).toBe(false);
  await expect(result.current.loadHistory()).resolves.toBeNull();
});

it("cleans up a subscription that finishes registering after unmount", async () => {
  let subscribed!: (value: () => void) => void;
  vi.mocked(events.tabHistoryChanged.listen).mockImplementation(() => new Promise((done) => { subscribed = done; }));
  const { unmount } = renderHook(() => useTabHistory("one", "https://example.com"));
  unmount();
  await act(async () => subscribed(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});

it("does not offer Back to the blank page a new tab's view starts on", () => {
  const fresh = (index: number) => ({ generation: "view-1", current_index: index, entries: [
    { id: 1, url: "about:blank", title: "" },
    { id: 2, url: "https://example.com/one", title: "One" },
    { id: 3, url: "https://example.com/two", title: "Two" },
  ] });
  expect(firstBackIndex(fresh(1))).toBe(1);
  expect(canGoBack(fresh(1))).toBe(false);
  expect(canGoBack(fresh(2))).toBe(true);
  // A tab that is on about:blank itself has nothing before it either way.
  expect(canGoBack({ generation: "g", current_index: 0, entries: [{ id: 1, url: "about:blank", title: "" }] })).toBe(false);
  // A blank page the person went to later is a page like any other.
  expect(firstBackIndex({ generation: "g", current_index: 1, entries: [{ id: 1, url: "https://a.test/", title: "" }, { id: 2, url: "about:blank", title: "" }] })).toBe(0);
  expect(canGoBack(null)).toBe(false);
});
