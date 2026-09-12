import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDelta, coalesceDeltas, isReady, STREAM_FLUSH_MS, useAgent } from "./agent";
import type { Message } from "./agent";
import type { ChatDeltaOut, ProviderInfo } from "../lib/ipc";
import { ipc } from "../lib/ipc";

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

describe("coalesceDeltas", () => {
  it("joins adjacent text and reasoning pieces but keeps a tool call between them", () => {
    const call: ChatDeltaOut = { type: "tool_call", data: { id: "t", name: "page_click", input: "{}", action: true, locator: null } };
    expect(coalesceDeltas([
      { type: "reasoning", data: "Fi" }, { type: "reasoning", data: "rst" },
      { type: "text", data: "a" }, { type: "text", data: "b" }, call, { type: "text", data: "c" },
    ])).toEqual([{ type: "reasoning", data: "First" }, { type: "text", data: "ab" }, call, { type: "text", data: "c" }]);
  });
});

describe("streaming", () => {
  const initial = useAgent.getState();
  beforeEach(() => {
    vi.useFakeTimers();
    useAgent.setState(initial, true);
  });
  afterEach(() => {
    useAgent.setState(initial, true);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes the store a few times a second, not per token, and loses nothing at the end", async () => {
    let finish!: () => void;
    let emit!: (d: ChatDeltaOut) => void;
    vi.spyOn(ipc, "agentSend").mockImplementation((_run, _turns, _tab, _options, onDelta) => {
      emit = onDelta;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const writes = vi.fn();
    const unsubscribe = useAgent.subscribe(writes);
    const sending = useAgent.getState().send("hi", null);
    await vi.advanceTimersByTimeAsync(0);
    writes.mockClear();

    for (const piece of ["Hel", "lo", ", ", "wor"]) emit({ type: "text", data: piece });
    expect(writes).not.toHaveBeenCalled();
    expect(useAgent.getState().messages.at(-1)?.content).toBe("");
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(useAgent.getState().messages.at(-1)?.content).toBe("Hello, wor");

    // A tool call is shown at once, with the text that was waiting before it.
    emit({ type: "text", data: "ld" });
    emit({ type: "tool_call", data: { id: "t1", name: "page_click", input: "{}", action: true, locator: null } });
    expect(useAgent.getState().messages.at(-1)).toMatchObject({ content: "Hello, world", steps: [{ id: "t1" }] });

    // Text still in the buffer when the stream ends is not dropped.
    emit({ type: "text", data: "!" });
    finish();
    await sending;
    expect(useAgent.getState().messages.at(-1)).toMatchObject({ content: "Hello, world!", pending: false });
    expect(useAgent.getState().busy).toBe(false);
    unsubscribe();
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
