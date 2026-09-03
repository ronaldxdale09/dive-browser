import { describe, expect, it } from "vitest";
import { applyDelta } from "./agent";
import type { Message } from "./agent";

const base: Message[] = [
  { id: "1", role: "user", content: "hi" },
  { id: "2", role: "assistant", content: "", pending: true },
];

describe("applyDelta", () => {
  it("appends text and finishes", () => {
    let m = applyDelta(base, { type: "text", data: "Hel" });
    m = applyDelta(m, { type: "text", data: "lo" });
    expect(m[1]?.content).toBe("Hello");
    m = applyDelta(m, { type: "done", data: "end_turn" });
    expect(m[1]).toMatchObject({ pending: false });
    expect(m[1]?.error).toBeUndefined();
  });
  it("records errors and cut-offs", () => {
    expect(applyDelta(base, { type: "error", data: "boom" })[1]).toMatchObject({ pending: false, error: "boom" });
    expect(applyDelta(base, { type: "done", data: "max_tokens" })[1]?.error).toContain("length limit");
  });
  it("ignores deltas without a trailing assistant message", () => {
    const only = [base[0]!];
    expect(applyDelta(only, { type: "text", data: "x" })).toBe(only);
  });
});

describe("tool steps", () => {
  it("records calls and their results on the assistant message", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu1", name: "page_click", input: "{\"ref\":\"e1\"}", action: true, locator: null } });
    m = applyDelta(m, { type: "tool_done", data: { id: "tu1", summary: "clicked", error: false } });
    expect(m[1]?.steps).toHaveLength(1);
    expect(m[1]?.steps?.[0]).toMatchObject({ id: "tu1", name: "page_click", action: true, summary: "clicked", error: false });
  });
});

describe("approval", () => {
  it("marks a step as awaiting and clears it when done", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu2", name: "tab_navigate", input: "{}", action: true, locator: null } });
    m = applyDelta(m, { type: "needs_approval", data: { id: "tu2", name: "tab_navigate", input: "{}", action: true, locator: null } });
    expect(m[1]?.steps?.[0]?.awaiting).toBe(true);
    m = applyDelta(m, { type: "tool_done", data: { id: "tu2", summary: "denied", error: true } });
    expect(m[1]?.steps?.[0]).toMatchObject({ awaiting: false, error: true });
  });
});
