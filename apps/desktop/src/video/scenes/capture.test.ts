import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sampleBugReportEnvironment } from "./capture";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "capture.tsx"), "utf8");

describe("feature tour bug report", () => {
  it("does not present the sample environment as this window's Chromium viewport", () => {
    const detail = sampleBugReportEnvironment();
    expect(detail).not.toMatch(/Chromium 151/);
    expect(detail).not.toMatch(/1512/);
    expect(detail).toMatch(/^Dive on /);
    expect(detail).toMatch(/sample/i);
  });
});

describe("feature tour recording scene", () => {
  it("does not say the GIF lands in the clipboard", () => {
    expect(source).not.toMatch(/lands on disk and in your clipboard/);
    expect(source).not.toMatch(/saved and copied to clipboard/);
    expect(source).toMatch(/lands on disk/);
  });
});
