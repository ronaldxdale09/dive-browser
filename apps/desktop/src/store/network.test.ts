import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fold, selectFrames, selectRequests, useNetwork } from "./network";
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
