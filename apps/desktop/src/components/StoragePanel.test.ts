import { describe, expect, it } from "vitest";
import { sortRows } from "./StoragePanel";

describe("sortRows", () => {
  it("orders by key, then by where the cookie lives, without touching the input", () => {
    const row = (key: string, value: string, meta: string) => ({ key, value, meta });
    const rows = [row("theme", "dark", "example.com/"), row("extra", "2", "example.com/"), row("session", "b", "example.com/app"), row("session", "a", "example.com/")];
    expect(sortRows(rows).map((r) => [r.key, r.value, r.meta].join("|"))).toEqual(["extra|2|example.com/", "session|a|example.com/", "session|b|example.com/app", "theme|dark|example.com/"]);
    expect(rows[0]?.key).toBe("theme");
  });
});
