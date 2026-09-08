import { describe, expect, it } from "vitest";
import { sortRows } from "./StoragePanel";

describe("sortRows", () => {
  it("orders by key, then by where the cookie lives, without touching the input", () => {
    const rows: [string, string, string][] = [
      ["theme", "dark", "example.com/"],
      ["extra", "2", "example.com/"],
      ["session", "b", "example.com/app"],
      ["session", "a", "example.com/"],
    ];
    expect(sortRows(rows).map((r) => r.join("|"))).toEqual(["extra|2|example.com/", "session|a|example.com/", "session|b|example.com/app", "theme|dark|example.com/"]);
    expect(rows[0]?.[0]).toBe("theme");
  });
});
