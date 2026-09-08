import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { beginsAwaitedPage, fold, resetNavigationWaits, rowsSinceNavigation, selectFrames, selectRequests, useNetwork } from "./network";
import type { NetworkEvent } from "../lib/ipc";

type SentEvent = Extract<NetworkEvent, { type: "sent" }>;

const sent = (id: string, url: string, t = 1, tab = "t"): SentEvent => ({ type: "sent", data: { tab_id: tab, request_id: id, url, method: "GET", resource_type: "Fetch", headers: {}, post_data: null, timestamp: t, wall_time: 1_700_000_000 + t } });

describe("network fold", () => {
  it("builds a row through its lifecycle", () => {
    let rows = fold(undefined, sent("1", "https://a.dev/api"));
    rows = fold(rows, { type: "response", data: { tab_id: "t", request_id: "1", status: 200, mime_type: "application/json", from_cache: false, headers: {}, timestamp: 1.05 } });
    rows = fold(rows, { type: "finished", data: { tab_id: "t", request_id: "1", encoded_length: 512, timestamp: 1.25 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 200, mimeType: "application/json", size: 512, durationMs: 250 });
  });
  it("records failures and keeps the original start on redirect", () => {
    let rows = fold(undefined, sent("1", "https://a.dev/old", 1));
    rows = fold(rows, sent("1", "https://a.dev/new", 1.1));
    rows = fold(rows, { type: "failed", data: { tab_id: "t", request_id: "1", error: "net::ERR_FAILED", timestamp: 1.3 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "https://a.dev/new", startedAt: 1, error: "net::ERR_FAILED", durationMs: 300 });
    expect(fold(rows, { type: "finished", data: { tab_id: "t", request_id: "nope", encoded_length: 1, timestamp: 2 } })).toBe(rows);
  });

  it("shows no size for a blocked request even if the engine reported its error page's bytes", () => {
    let rows = fold(undefined, sent("1", "https://a.dev/api", 1));
    rows = fold(rows, { type: "finished", data: { tab_id: "t", request_id: "1", encoded_length: 179_500, timestamp: 1.2 } });
    rows = fold(rows, { type: "failed", data: { tab_id: "t", request_id: "1", error: "net::ERR_BLOCKED_BY_CLIENT", timestamp: 1.3 } });
    expect(rows[0]).toMatchObject({ error: "net::ERR_BLOCKED_BY_CLIENT", size: null });
  });

  it("lists sockets as rows and ignores frames in the row list", () => {
    let rows = fold(undefined, { type: "socket", data: { tab_id: "t", request_id: "s", url: "wss://a.dev/ws", timestamp: 1 } });
    rows = fold(rows, { type: "frame", data: { tab_id: "t", request_id: "s", direction: "received", payload: "hi", timestamp: 1.2 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: "WebSocket", method: "GET", url: "wss://a.dev/ws" });
  });

  it("drops frames when their request row is evicted", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    useNetwork.getState().apply({ type: "socket", data: { tab_id: "t", request_id: "old", url: "wss://a.dev/ws", timestamp: 1 } });
    useNetwork.getState().apply({ type: "frame", data: { tab_id: "t", request_id: "old", direction: "received", payload: "hi", timestamp: 1.1 } });
    for (let i = 0; i < 1000; i += 1) useNetwork.getState().apply(sent(String(i), `https://a.dev/${i}`));
    expect(selectFrames("t", "old")(useNetwork.getState())).toEqual([]);
  });
});

describe("selectRequests", () => {
  it("returns the same array for tab A after an event lands on tab B", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    useNetwork.getState().apply(sent("a1", "https://a.dev/1"));
    const before = selectRequests("t")(useNetwork.getState());
    const empty = selectRequests("never")(useNetwork.getState());

    useNetwork.getState().apply(sent("b1", "https://b.dev/1", 1, "other"));
    useNetwork.getState().apply({ type: "response", data: { tab_id: "other", request_id: "b1", status: 200, mime_type: "text/html", from_cache: false, headers: {}, timestamp: 2 } });

    expect(selectRequests("t")(useNetwork.getState())).toBe(before);
    expect(selectRequests("never")(useNetwork.getState())).toBe(empty);
    expect(selectRequests(null)(useNetwork.getState())).toBe(empty);
    expect(selectRequests("other")(useNetwork.getState())).toHaveLength(1);
  });

  it("does not re-render a subscriber of tab A for tab B's traffic", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    useNetwork.getState().apply(sent("a1", "https://a.dev/1"));
    let renders = 0;
    function Probe() {
      const rows = useNetwork(selectRequests("t"));
      renders += 1;
      return createElement("span", null, rows.length);
    }
    render(createElement(Probe));
    expect(renders).toBe(1);

    act(() => useNetwork.getState().apply(sent("b1", "https://b.dev/1", 1, "other")));
    expect(renders).toBe(1);

    act(() => useNetwork.getState().apply(sent("a2", "https://a.dev/2")));
    expect(renders).toBe(2);
    expect(screen.getByText("2")).toBeTruthy();
    cleanup();
  });
});

describe("network UI batches", () => {
  it("flushes on its real 33ms schedule without mutating the published frame snapshot", async () => {
    vi.useFakeTimers();
    try {
      useNetwork.setState({ byTab: {}, frames: {} });
      const state = useNetwork.getState();
      state.apply({ type: "socket", data: { tab_id: "t", request_id: "s", url: "wss://a.dev", timestamp: 1 } });
      state.apply({ type: "frame", data: { tab_id: "t", request_id: "s", direction: "received", payload: "before", timestamp: 2 } });
      const published = selectFrames("t", "s")(useNetwork.getState());
      state.enqueue({ type: "frame", data: { tab_id: "t", request_id: "s", direction: "received", payload: "after", timestamp: 3 } });
      await vi.advanceTimersByTimeAsync(32);
      expect(selectFrames("t", "s")(useNetwork.getState())).toBe(published);
      expect(published).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(selectFrames("t", "s")(useNetwork.getState()).map((row) => row.payload)).toEqual(["before", "after"]);
      expect(published).toHaveLength(1);
    } finally { useNetwork.getState().flush(); vi.useRealTimers(); }
  });

  it("publishes a burst once while retaining final request state and ordered frames", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    let notifications = 0;
    const unsubscribe = useNetwork.subscribe(() => { notifications++; });
    const state = useNetwork.getState();
    state.enqueue(sent("burst", "https://a.dev/api"));
    state.enqueue({ type: "response", data: { tab_id: "t", request_id: "burst", status: 200, mime_type: "application/json", from_cache: false, headers: {}, timestamp: 1.05 } });
    state.enqueue({ type: "finished", data: { tab_id: "t", request_id: "burst", encoded_length: 512, timestamp: 1.25 } });
    state.enqueue({ type: "socket", data: { tab_id: "t", request_id: "s", url: "wss://a.dev/ws", timestamp: 2 } });
    for (let i = 0; i < 5000; i++) state.enqueue({ type: "frame", data: { tab_id: "t", request_id: "s", direction: "received", payload: String(i), timestamp: i } });
    expect(notifications).toBe(0);
    state.flush();
    expect(notifications).toBe(1);
    expect(selectRequests("t")(useNetwork.getState())[0]).toMatchObject({ status: 200, size: 512, durationMs: 250 });
    const frames = selectFrames("t", "s")(useNetwork.getState());
    expect(frames).toHaveLength(200);
    expect(frames[0]?.payload).toBe("4800");
    expect(frames.at(-1)?.payload).toBe("4999");
    unsubscribe();
  });

  it("cannot resurrect cleared or closed tabs from a pending burst", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    const state = useNetwork.getState();
    state.enqueue(sent("old", "https://a.dev/old"));
    state.enqueue(sent("other", "https://a.dev/other", 1, "other"));
    state.drop("t");
    state.flush();
    expect(useNetwork.getState().byTab.t).toBeUndefined();
    expect(useNetwork.getState().byTab.other).toHaveLength(1);
    state.enqueue(sent("old", "https://a.dev/old", 1, "other"));
    state.clear("other");
    state.flush();
    expect(useNetwork.getState().byTab.other).toEqual([]);
  });

  it("rejects late frames for evicted requests and keeps unaffected tab references", () => {
    useNetwork.setState({ byTab: {}, frames: {} });
    const state = useNetwork.getState();
    state.apply(sent("untouched", "https://a.dev", 1, "other"));
    const before = useNetwork.getState().byTab.other;
    state.enqueue({ type: "socket", data: { tab_id: "t", request_id: "old", url: "wss://a.dev/ws", timestamp: 1 } });
    for (let i = 0; i < 1001; i++) state.enqueue(sent(String(i), "https://a.dev"));
    state.enqueue({ type: "frame", data: { tab_id: "t", request_id: "old", direction: "received", payload: "late", timestamp: 2 } });
    state.flush();
    expect(selectRequests("t")(useNetwork.getState())).toHaveLength(1000);
    expect(selectFrames("t", "old")(useNetwork.getState())).toEqual([]);
    expect(useNetwork.getState().byTab.other).toBe(before);
  });
});

describe("navigation", () => {
  // Sent "just now" in wall-clock terms; the fixed 2023 wall time of `sent` reads as long ago.
  const now = () => Date.now() / 1000;
  const doc = (id: string, url: string, t: number, wall = now()): SentEvent => ({ ...sent(id, url, t), data: { ...sent(id, url, t).data, resource_type: "Document", wall_time: wall } });

  it("keeps the newest document request and what followed it", () => {
    let rows = fold(undefined, doc("1", "https://a.dev/", 1));
    rows = fold(rows, sent("2", "https://a.dev/app.js", 2));
    rows = fold(rows, doc("3", "https://a.dev/next", 3));
    rows = fold(rows, sent("4", "https://a.dev/next.css", 4));
    expect(rowsSinceNavigation(rows).map((r) => r.id)).toEqual(["3", "4"]);
    // A first page, or a list without a document request, keeps everything.
    expect(rowsSinceNavigation(rows.slice(0, 2)).map((r) => r.id)).toEqual(["1", "2"]);
    expect(rowsSinceNavigation([rows[1]!, rows[3]!]).map((r) => r.id)).toEqual(["2", "4"]);
  });

  it("trims a tab's rows when its main frame starts loading, unless the log is preserved", () => {
    resetNavigationWaits();
    useNetwork.setState({ byTab: {}, frames: {}, preserve: false });
    const s = useNetwork.getState();
    s.apply(doc("1", "https://a.dev/", 1));
    s.apply(sent("2", "https://a.dev/app.js", 2));
    s.apply(doc("3", "https://a.dev/next", 3));
    s.navigated("t", "https://a.dev/next");
    expect(useNetwork.getState().byTab.t!.map((r) => r.id)).toEqual(["3"]);
    s.apply(doc("4", "https://a.dev/again", 4));
    s.setPreserve(true);
    s.navigated("t", "https://a.dev/again");
    expect(useNetwork.getState().byTab.t!.map((r) => r.id)).toEqual(["3", "4"]);
  });

  it("treats a reload as a new page even though the address is the same", () => {
    resetNavigationWaits();
    useNetwork.setState({ byTab: {}, frames: {}, preserve: false });
    const s = useNetwork.getState();
    // The page loaded a minute ago; its document has the address the reload announces.
    s.apply(doc("1", "https://a.dev/json", 1, now() - 60));
    s.apply(sent("2", "https://a.dev/favicon.ico", 2));
    s.navigated("t", "https://a.dev/json");
    expect(useNetwork.getState().byTab.t ?? []).toEqual([]);
    s.apply(doc("3", "https://a.dev/json", 3));
    s.apply(sent("4", "https://a.dev/favicon.ico", 4));
    expect(useNetwork.getState().byTab.t!.map((r) => r.id)).toEqual(["3", "4"]);
  });

  it("waits for the document request when the load start arrives first", () => {
    resetNavigationWaits();
    useNetwork.setState({ byTab: {}, frames: {}, preserve: false });
    const s = useNetwork.getState();
    s.apply(doc("1", "https://a.dev/", 1));
    s.apply(sent("2", "https://a.dev/app.js", 2));
    // The engine says the main frame started loading /next; its request has
    // not been seen, so the page that was left goes at once.
    s.navigated("t", "https://a.dev/next");
    expect(useNetwork.getState().byTab.t ?? []).toEqual([]);
    expect(beginsAwaitedPage("t", sent("9", "https://a.dev/late.js", 2.5))).toBe(false);
    expect(beginsAwaitedPage("t", doc("3", "https://a.dev/next", 3))).toBe(true);
    s.apply(doc("3", "https://a.dev/next", 3));
    s.apply(sent("4", "https://a.dev/next.css", 4));
    expect(useNetwork.getState().byTab.t!.map((r) => r.id)).toEqual(["3", "4"]);
    // Once served, a later document request (an iframe, say) does not clear the page.
    s.apply(doc("5", "https://a.dev/frame", 5));
    expect(useNetwork.getState().byTab.t!.map((r) => r.id)).toEqual(["3", "4", "5"]);
    // A redirect lands on another address: the time window stands in, and it lapses.
    s.navigated("t", "https://a.dev/moved");
    expect(beginsAwaitedPage("t", doc("6", "https://a.dev/final", 6), Date.now() + 5000)).toBe(false);
  });
});
