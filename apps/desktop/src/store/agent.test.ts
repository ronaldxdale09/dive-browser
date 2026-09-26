import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDelta, coalesceDeltas, isReady, NOT_RUN, parseThread, settledForStorage, STREAM_FLUSH_MS, threadTitle, turnsFor, useAgent } from "./agent";
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
    expect(applyDelta(base, { type: "error", data: { message: "boom", kind: "auth" } })[1]).toMatchObject({ pending: false, error: "boom", errorKind: "auth" });
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
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu1", name: "page_click", input: '{"ref":"e1"}', action: true, locator: null, caution: null } });
    m = applyDelta(m, { type: "tool_done", data: { id: "tu1", summary: "clicked", error: false } });
    expect(m[1]?.steps).toHaveLength(1);
    expect(m[1]?.steps?.[0]).toMatchObject({ id: "tu1", name: "page_click", action: true, summary: "clicked", error: false });
  });
});

describe("approval", () => {
  it("marks a step as awaiting and clears it when done", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu2", name: "tab_navigate", input: "{}", action: true, locator: null, caution: null } });
    m = applyDelta(m, { type: "needs_approval", data: { id: "tu2", name: "tab_navigate", input: "{}", action: true, locator: null, caution: null } });
    expect(m[1]?.steps?.[0]?.awaiting).toBe(true);
    m = applyDelta(m, { type: "tool_done", data: { id: "tu2", summary: "denied", error: true } });
    expect(m[1]?.steps?.[0]).toMatchObject({ awaiting: false, error: true });
  });
  it("clears a dangling approval when the reply ends or fails", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "tu3", name: "page_type", input: "{}", action: true, locator: null, caution: null } });
    m = applyDelta(m, { type: "needs_approval", data: { id: "tu3", name: "page_type", input: "{}", action: true, locator: null, caution: null } });
    expect(applyDelta(m, { type: "done", data: "stopped" })[1]?.steps?.[0]?.awaiting).toBe(false);
    expect(applyDelta(m, { type: "error", data: { message: "gone", kind: "other" } })[1]?.steps?.[0]?.awaiting).toBe(false);
  });
  it("stops a step that never ran from spinning once the reply is over", () => {
    let m = applyDelta(base, { type: "tool_call", data: { id: "a", name: "page_text", input: "{}", action: false, locator: null, caution: null } });
    m = applyDelta(m, { type: "tool_done", data: { id: "a", summary: "ok", error: false } });
    m = applyDelta(m, { type: "tool_call", data: { id: "b", name: "page_click", input: "{}", action: true, locator: null, caution: null } });
    for (const end of [{ type: "done", data: "stopped" }, { type: "error", data: { message: "limit", kind: "other" } }] as ChatDeltaOut[]) {
      const steps = applyDelta(m, end)[1]?.steps;
      expect(steps?.[0]).toMatchObject({ summary: "ok", error: false });
      expect(steps?.[1]).toMatchObject({ summary: NOT_RUN, error: true, awaiting: false });
    }
  });
});

describe("status", () => {
  it("is shown while the run waits and never becomes reply text", () => {
    let m = applyDelta(base, { type: "status", data: "The provider is busy; trying again in 3s." });
    expect(m[1]).toMatchObject({ status: "The provider is busy; trying again in 3s.", content: "" });
    m = applyDelta(m, { type: "text", data: "Answer" });
    expect(m[1]?.status).toBeUndefined();
    expect(m[1]?.content).toBe("Answer");
    const stopped = applyDelta(applyDelta(base, { type: "status", data: "waiting" }), { type: "done", data: "stopped" });
    expect(stopped[1]).toMatchObject({ stopped: true, content: "" });
    expect(stopped[1]?.status).toBeUndefined();
    expect(settledForStorage([{ id: "x", role: "assistant", content: "a", status: "waiting" }])[0]).not.toHaveProperty("status");
  });
});

describe("turnsFor", () => {
  it("leaves out a reply that was stopped before it said anything, and failed ones", () => {
    const turns = turnsFor([
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "", stopped: true },
      { id: "3", role: "user", content: "again" },
      { id: "4", role: "assistant", content: "half an answer", stopped: true },
      { id: "5", role: "assistant", content: "partial", error: "boom" },
      { id: "6", role: "user", content: "last" },
    ]);
    expect(turns).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "again" },
      { role: "assistant", content: "half an answer" },
      { role: "user", content: "last" },
    ]);
  });
});

describe("coalesceDeltas", () => {
  it("joins adjacent text and reasoning pieces but keeps a tool call between them", () => {
    const call: ChatDeltaOut = { type: "tool_call", data: { id: "t", name: "page_click", input: "{}", action: true, locator: null, caution: null } };
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
    emit({ type: "tool_call", data: { id: "t1", name: "page_click", input: "{}", action: true, locator: null, caution: null } });
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

describe("a page that addresses the agent", () => {
  it("is reported once per reply, however many reads saw it", () => {
    const note = 'evil.dev told the agent to ignore its instructions: "ignore previous instructions"';
    let m = applyDelta(base, { type: "flagged", data: note });
    expect(m[1]?.flagged).toEqual([note]);
    m = applyDelta(m, { type: "flagged", data: note });
    expect(m[1]?.flagged).toEqual([note]);
    m = applyDelta(m, { type: "flagged", data: "other.dev tried to give the agent a new role: \"you are now\"" });
    expect(m[1]?.flagged).toHaveLength(2);
  });
});

describe("a conversation that belongs to a tab", () => {
  const initial = useAgent.getState();

  afterEach(() => {
    useAgent.setState(initial, true);
    vi.restoreAllMocks();
  });

  it("keeps only what is worth reading back", () => {
    const kept = settledForStorage([
      { id: "1", role: "user", content: "hi" },
      { id: "2", role: "assistant", content: "there", pending: true, steps: [{ id: "s", name: "page_click", input: "{}", action: true, awaiting: true }] },
      // A reply that never arrived is not a conversation.
      { id: "3", role: "assistant", content: "", pending: true },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[1]).not.toHaveProperty("pending");
    expect(kept[1]?.steps?.[0]).not.toHaveProperty("awaiting");
    expect(threadTitle(kept)).toBe("hi");
  });

  it("survives a saved document it cannot read", () => {
    expect(parseThread("not json")).toEqual([]);
    expect(parseThread('{"role":"user"}')).toEqual([]);
    expect(parseThread('[{"id":"1","role":"user","content":"hi"}]')).toHaveLength(1);
  });

  it("writes the tab it is leaving back and reads the one it arrives at", async () => {
    const save = vi.spyOn(ipc, "agentThreadSave").mockResolvedValue(null);
    const load = vi.spyOn(ipc, "agentThreadLoad").mockResolvedValue({
      tab_id: "tab-2",
      title: "older",
      messages: '[{"id":"9","role":"user","content":"older"}]',
      updated_at: "2026-09-01T00:00:00Z",
    });
    useAgent.setState({ tabId: "tab-1", messages: [{ id: "1", role: "user", content: "about this page" }] });

    await useAgent.getState().loadFor("tab-2");
    expect(save).toHaveBeenCalledWith("tab-1", "about this page", expect.stringContaining("about this page"));
    expect(load).toHaveBeenCalledWith("tab-2");
    expect(useAgent.getState().messages).toEqual([{ id: "9", role: "user", content: "older" }]);

    // Arriving where we already are changes nothing.
    load.mockClear();
    await useAgent.getState().loadFor("tab-2");
    expect(load).not.toHaveBeenCalled();
  });

  it("does not write back a conversation that only was looked at", async () => {
    const save = vi.spyOn(ipc, "agentThreadSave").mockResolvedValue(null);
    vi.spyOn(ipc, "agentThreadLoad").mockImplementation((tab) =>
      Promise.resolve({ tab_id: tab, title: "kept", messages: `[{"id":"${tab}","role":"user","content":"kept"}]`, updated_at: "2026-09-01T00:00:00Z" }),
    );
    useAgent.setState({ tabId: null, messages: [] });
    await useAgent.getState().loadFor("tab-a");
    await useAgent.getState().loadFor("tab-b");
    await useAgent.getState().loadFor("tab-a");
    expect(save).not.toHaveBeenCalled();

    // Once it changes, leaving writes it, once.
    useAgent.setState((s) => ({ messages: [...s.messages, { id: "n", role: "user", content: "more" }] }));
    await useAgent.getState().loadFor("tab-b");
    await useAgent.getState().loadFor("tab-a");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("tab-a", "kept", expect.stringContaining("more"));
  });

  it("leaves a run in flight alone", async () => {
    const load = vi.spyOn(ipc, "agentThreadLoad").mockResolvedValue(null);
    useAgent.setState({ tabId: "tab-1", busy: true, messages: [{ id: "1", role: "user", content: "working" }] });
    await useAgent.getState().loadFor("tab-2");
    expect(load).not.toHaveBeenCalled();
    expect(useAgent.getState().tabId).toBe("tab-1");
    expect(useAgent.getState().messages).toHaveLength(1);
    // ...but remembers where the person went, and goes there after.
    expect(useAgent.getState().wantedTab).toBe("tab-2");
    await useAgent.getState().loadFor("tab-1");
    expect(useAgent.getState().wantedTab).toBeUndefined();
  });

  it("follows the person to the tab they moved to once the run ends", async () => {
    vi.spyOn(ipc, "agentThreadSave").mockResolvedValue(null);
    const load = vi.spyOn(ipc, "agentThreadLoad").mockResolvedValue(null);
    let finish!: () => void;
    vi.spyOn(ipc, "agentSend").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    useAgent.setState({ tabId: "tab-1", messages: [] });
    const sending = useAgent.getState().send("look", "tab-1");
    await Promise.resolve();
    await useAgent.getState().loadFor("tab-2");
    expect(useAgent.getState().tabId).toBe("tab-1");
    finish();
    await sending;
    await vi.waitFor(() => expect(useAgent.getState().tabId).toBe("tab-2"));
    expect(load).toHaveBeenCalledWith("tab-2");
  });

  it("asks in the conversation of the tab it was asked for, not the one on screen", async () => {
    const save = vi.spyOn(ipc, "agentThreadSave").mockResolvedValue(null);
    vi.spyOn(ipc, "agentThreadLoad").mockResolvedValue({
      tab_id: "tab-2",
      title: "earlier",
      messages: '[{"id":"9","role":"user","content":"earlier"},{"id":"10","role":"assistant","content":"answer"}]',
      updated_at: "2026-09-01T00:00:00Z",
    });
    const send = vi.spyOn(ipc, "agentSend").mockResolvedValue(undefined);
    useAgent.setState({ tabId: "tab-1", messages: [{ id: "1", role: "user", content: "about tab one" }] });
    await useAgent.getState().send("explain this request", "tab-2");
    const turns = send.mock.calls[0]?.[1];
    expect(turns?.map((t) => t.content)).toEqual(["earlier", "answer", "explain this request"]);
    expect(useAgent.getState().tabId).toBe("tab-2");
    // Tab one's conversation was written back under tab one, and the new
    // question is kept under tab two.
    expect(save).toHaveBeenCalledWith("tab-1", "about tab one", expect.any(String));
    expect(save).toHaveBeenLastCalledWith("tab-2", "earlier", expect.stringContaining("explain this request"));
  });

  it("asks a failed question again without the reply that failed", async () => {
    vi.spyOn(ipc, "agentThreadSave").mockResolvedValue(null);
    const send = vi.spyOn(ipc, "agentSend").mockResolvedValue(undefined);
    useAgent.setState({
      tabId: "tab-1",
      messages: [
        { id: "1", role: "user", content: "why" },
        { id: "2", role: "assistant", content: "", error: "overloaded", errorKind: "other" },
      ],
    });
    await useAgent.getState().retry("tab-1");
    expect(send.mock.calls[0]?.[1]).toEqual([{ role: "user", content: "why" }]);
    const messages = useAgent.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.error).toBeUndefined();
  });

  it("says so when a conversation cannot be saved", async () => {
    vi.spyOn(ipc, "agentThreadSave").mockRejectedValue(new Error("disk full"));
    vi.spyOn(ipc, "agentThreadLoad").mockResolvedValue(null);
    const notify = vi.fn();
    const { useBrowser } = await import("./browser");
    useBrowser.setState({ notify });
    useAgent.setState({ tabId: "tab-1", messages: [{ id: "1", role: "user", content: "keep me" }] });
    await useAgent.getState().loadFor("tab-2");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), expect.any(Number)));
  });

  it("forgets the kept conversation when the thread is cleared", () => {
    const forget = vi.spyOn(ipc, "agentThreadClear").mockResolvedValue(true);
    useAgent.setState({ tabId: "tab-1", messages: [{ id: "1", role: "user", content: "hi" }] });
    useAgent.getState().clear();
    expect(useAgent.getState().messages).toEqual([]);
    expect(forget).toHaveBeenCalledWith("tab-1");
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
