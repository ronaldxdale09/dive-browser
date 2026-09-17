import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "build.tsx"), "utf8");

describe("feature tour agent scene", () => {
  it("does not claim the agent asks before anything irreversible", () => {
    expect(source).not.toMatch(/asks before anything irreversible/);
    expect(source).toMatch(/floor, not a guarantee/);
  });
});
