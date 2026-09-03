import { describe, expect, it } from "vitest";
import { append } from "./console";
import type { ConsoleEntry } from "../lib/ipc";

const entry = (i: number): ConsoleEntry => ({ tab_id: "t", level: "info", text: String(i), source: "console", url: null, line: null, timestamp: i });

describe("console buffer", () => {
  it("caps at 500 entries keeping the newest", () => {
    let list: ConsoleEntry[] | undefined;
    for (let i = 0; i < 520; i++) list = append(list, entry(i));
    expect(list).toHaveLength(500);
    expect(list?.[0]?.text).toBe("20");
    expect(list?.at(-1)?.text).toBe("519");
  });
});
