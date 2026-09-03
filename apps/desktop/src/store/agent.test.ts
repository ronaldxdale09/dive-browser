import { describe, expect, it } from "vitest";
import { applyDelta, isReady } from "./agent";
import type { Message } from "./agent";
import type { ProviderInfo } from "../lib/ipc";

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
    expect(m[1]?.stopped).toBeUndefined();
  });
  it("collects reasoning separately from the answer", () => {
    let m = applyDelta(base, { type: "reasoning", data: "First, " });
    m = applyDelta(m, { type: "reasoning", data: "inspect." });
    m = applyDelta(m, { type: "text", data: "Done." });
    expect(m[1]?.reasoning).toBe("First, inspect.");
    expect(m[1]?.content).toBe("Done.");
  });
  it("records errors, cut-offs, refusals and stops", () => {
    expect(applyDelta(base, { type: "error", data: "boom" })[1]).toMatchObject({ pending: false, error: "boom" });
    expect(applyDelta(base, { type: "done", data: "max_tokens" })[1]?.error).toContain("length limit");
    expect(applyDelta(base, { type: "done", data: "refusal" })[1]?.error).toContain("declined");
    const stopped = applyDelta(base, { type: "done", data: "stopped" })[1];
    expect(stopped).toMatchObject({ pending: false, stopped: true });
    expect(stopped?.error).toBeUndefined();
  });
  it("keeps the latest usage totals", () => {
    let m = applyDelta(base, { type: "usage", data: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: null } });
    m = applyDelta(m, { type: "usage", data: { input_tokens: 30, output_tokens: 12, cache_read_tokens: 8, cost_usd: 0.002 } });
    expect(m[1]?.usage).toEqual({ input_tokens: 30, output_tokens: 12, cache_read_tokens: 8, cost_usd: 0.002 });
  });
  it("ignores deltas without a trailing assistant message", () => {
    const only = [base[0]!];
    expect(applyDelta(only, { type: "text", data: "x" })).toBe(only);
  });
});

describe("tool steps", () => {
  it("records calls and their results on the assistant message", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu1", name: "page_click", input: '{"ref":"e1"}', action: true, locator: null } });
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
  it("clears a dangling approval when the reply ends or fails", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu3", name: "page_type", input: "{}", action: true, locator: null } });
    m = applyDelta(m, { type: "needs_approval", data: { id: "tu3", name: "page_type", input: "{}", action: true, locator: null } });
    expect(applyDelta(m, { type: "done", data: "stopped" })[1]?.steps?.[0]?.awaiting).toBe(false);
    expect(applyDelta(m, { type: "error", data: "gone" })[1]?.steps?.[0]?.awaiting).toBe(false);
  });
});

describe("isReady", () => {
  const row = (over: Partial<ProviderInfo>): ProviderInfo => ({
    id: "openai",
    name: "OpenAI",
    wire: "open_ai",
    base_url: "https://api.openai.com/v1",
    key_url: "",
    key_hint: "",
    needs_key: true,
    lists_models: true,
    default_model: "gpt-5",
    note: "",
    ...over,
  });
  it("needs a stored key for hosted providers and none for local ones", () => {
    expect(isReady(row({}), [])).toBe(false);
    expect(isReady(row({}), ["openai"])).toBe(true);
    expect(isReady(row({ id: "ollama", needs_key: false }), [])).toBe(true);
    expect(isReady(undefined, ["openai"])).toBe(false);
  });
});
