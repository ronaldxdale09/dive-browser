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

  it("does not claim every request has headers and bodies", () => {
    expect(source).not.toMatch(/Every request with headers, bodies/);
    expect(source).toMatch(/This page's requests/);
  });
});

