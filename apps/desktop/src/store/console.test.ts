import { describe, expect, it, vi } from "vitest";
import { append, enqueueConsoleBatch, isNoise, selectEntries, useConsole } from "./console";
import type { ConsoleRow } from "./console";
import type { ConsoleEntry } from "../lib/ipc";

const entry = (i: number): ConsoleEntry => ({ tab_id: "t", level: "info", text: String(i), source: "console", url: null, line: null, column: null, timestamp: i });

describe("console buffer", () => {
  it("caps at 500 entries keeping the newest", () => {
    let list: ConsoleRow[] | undefined;
    for (let i = 0; i < 520; i++) list = append(list, entry(i));
    expect(list).toHaveLength(500);
    expect(list?.[0]?.text).toBe("20");
    expect(list?.at(-1)?.text).toBe("519");
  });
});

describe("noise filter", () => {
  it("ignores favicon failures only", () => {
    const e = entry(1);
    expect(isNoise({ ...e, level: "error", url: "https://a.dev/favicon.ico", text: "Failed to load resource" })).toBe(true);
    expect(isNoise({ ...e, level: "error", text: "TypeError: x" })).toBe(false);
    expect(isNoise({ ...e, level: "info", text: "favicon.ico" })).toBe(false);
  });
});

describe("selectEntries", () => {
  it("stamps a stable id on each entry and keeps tab A's list identical when tab B logs", () => {
    useConsole.setState({ byTab: {} });
    useConsole.getState().push(entry(1));
    const before = selectEntries("t")(useConsole.getState());
    const empty = selectEntries("never")(useConsole.getState());
    const [first] = before;
    expect(typeof first?.id).toBe("number");

    useConsole.getState().push({ ...entry(2), tab_id: "other" });
    expect(selectEntries("t")(useConsole.getState())).toBe(before);
    expect(selectEntries("never")(useConsole.getState())).toBe(empty);
    expect(selectEntries(null)(useConsole.getState())).toBe(empty);

    useConsole.getState().push(entry(3));
    const after = selectEntries("t")(useConsole.getState());
    expect(after).not.toBe(before);
    expect(after[0]).toBe(first);
    expect(after[1]?.id).not.toBe(first?.id);
  });
});

describe("console UI batches", () => {
  it("keeps native batch order in the frontend queue", () => {
    useConsole.setState({ byTab: {} });
    enqueueConsoleBatch([entry(1), entry(2), entry(3)]);
    useConsole.getState().flush();
    expect(useConsole.getState().byTab.t?.map((row) => row.text)).toEqual(["1", "2", "3"]);
  });

  it("applies an ordered native navigation reset without resurrecting old pending entries", () => {
    useConsole.setState({ byTab: {}, preserve: false });
    enqueueConsoleBatch([entry(1), entry(2)]);
    enqueueConsoleBatch({ reset: "t" });
    enqueueConsoleBatch([entry(3)]);
    useConsole.getState().flush();
    expect(useConsole.getState().byTab.t?.map((row) => row.text)).toEqual(["3"]);

    useConsole.setState({ byTab: {}, preserve: true });
    enqueueConsoleBatch([entry(4)]);
    enqueueConsoleBatch({ reset: "t" });
    enqueueConsoleBatch([entry(5)]);
    useConsole.getState().flush();
    expect(useConsole.getState().byTab.t?.map((row) => row.text)).toEqual(["4", "5"]);
  });

  it("flushes after33ms and preserves unaffected tab references", async () => {
    vi.useFakeTimers();
    try {
      useConsole.setState({ byTab: {} });
      const state = useConsole.getState();
      state.push({ ...entry(0), tab_id: "other" });
      const before = useConsole.getState().byTab.other;
      state.enqueue(entry(1));
      await vi.advanceTimersByTimeAsync(32);
      expect(useConsole.getState().byTab.t).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(useConsole.getState().byTab.t?.[0]?.text).toBe("1");
      expect(useConsole.getState().byTab.other).toBe(before);
    } finally { useConsole.getState().flush(); vi.useRealTimers(); }
  });

  it("publishes once per burst, keeps newest 500 in order and preserves stable IDs", () => {
    useConsole.setState({ byTab: {} });
    const state = useConsole.getState();
    state.push(entry(-1));
    const id = useConsole.getState().byTab.t![0]!.id;
    let notifications = 0;
    const unsubscribe = useConsole.subscribe(() => { notifications++; });
    for (let i = 0; i < 5000; i++) state.enqueue(entry(i));
    expect(notifications).toBe(0);
    state.flush();
    expect(notifications).toBe(1);
    const rows = useConsole.getState().byTab.t!;
    expect(rows).toHaveLength(500);
    expect(rows[0]?.text).toBe("4500");
    expect(rows.at(-1)?.text).toBe("4999");
    expect(rows[0]!.id).toBeGreaterThan(id);
    unsubscribe();
  });

  it("drops pending entries when a tab is cleared or removed", () => {
    useConsole.setState({ byTab: {} });
    const state = useConsole.getState();
    state.enqueue(entry(1));
    state.clear("t");
    state.flush();
    expect(useConsole.getState().byTab.t).toEqual([]);
    state.enqueue(entry(2));
    state.drop("t");
    state.flush();
    expect(useConsole.getState().byTab.t).toBeUndefined();
  });
});
