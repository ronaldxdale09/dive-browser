import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "bookends.tsx"), "utf8");

describe("feature tour outro", () => {
  it("does not claim every command or that everything is a keystroke", () => {
    expect(source).not.toMatch(/Everything is a keystroke away/);
    expect(source).not.toMatch(/every command/);
    expect(source).toMatch(/commands that apply here/);
  });
});
