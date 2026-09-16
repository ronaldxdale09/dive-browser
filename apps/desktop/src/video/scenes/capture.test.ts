import { describe, expect, it } from "vitest";
import { sampleBugReportEnvironment } from "./capture";

describe("feature tour bug report", () => {
  it("does not present the sample environment as this window's Chromium viewport", () => {
    const detail = sampleBugReportEnvironment();
    expect(detail).not.toMatch(/Chromium 151/);
    expect(detail).not.toMatch(/1512/);
    expect(detail).toMatch(/^Dive on /);
    expect(detail).toMatch(/sample/i);
  });
});
