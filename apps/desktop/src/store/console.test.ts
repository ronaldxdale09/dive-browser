import { describe, expect, it } from "vitest";
import { append, isNoise, selectEntries, useConsole } from "./console";
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
