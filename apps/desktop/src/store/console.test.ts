import { describe, expect, it } from "vitest";
import { append, isNoise } from "./console";
import type { ConsoleEntry } from "../lib/ipc";

const entry = (i: number): ConsoleEntry => ({ tab_id: "t", level: "info", text: String(i), source: "console", url: null, line: null, column: null, timestamp: i });

describe("console buffer", () => {
  it("caps at 500 entries keeping the newest", () => {
    let list: ConsoleEntry[] | undefined;
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
