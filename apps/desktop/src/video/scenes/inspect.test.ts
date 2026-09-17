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

  it("does not claim workspace rules intercept every request before it leaves", () => {
    expect(source).not.toMatch(/applied before the request leaves/);
    expect(source).toMatch(/media is not intercepted/i);
  });

  it("does not say the simulator is a real viewport", () => {
    expect(source).not.toMatch(/Real viewport/);
    expect(source).toMatch(/CSS viewport/);
    expect(source).toMatch(/scaled to fit/);
  });
});


