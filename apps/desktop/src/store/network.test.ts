import { describe, expect, it } from "vitest";
import { fold } from "./network";
import type { NetworkEvent } from "../lib/ipc";

const sent = (id: string, url: string, t = 1): NetworkEvent => ({ type: "sent", data: { tab_id: "t", request_id: id, url, method: "GET", resource_type: "Fetch", timestamp: t } });

describe("network fold", () => {
  it("builds a row through its lifecycle", () => {
    let rows = fold(undefined, sent("1", "https://a.dev/api"));
    rows = fold(rows, { type: "response", data: { tab_id: "t", request_id: "1", status: 200, mime_type: "application/json", from_cache: false, timestamp: 1.05 } });
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
});
