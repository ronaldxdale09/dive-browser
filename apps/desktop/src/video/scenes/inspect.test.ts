import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "inspect.tsx"), "utf8");

describe("feature tour inspect scene", () => {
  it("does not claim the dock shows every cookie", () => {
    expect(source).not.toMatch(/every cookie/);
    expect(source).toMatch(/this page's cookies/);
  });
});
