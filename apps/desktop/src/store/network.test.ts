import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
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
