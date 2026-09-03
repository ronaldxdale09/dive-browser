import { describe, expect, it } from "vitest";
import { rate } from "./VitalsPanel";

describe("vitals rating", () => {
  it("applies Google thresholds", () => {
    expect(rate("lcp", 2000)).toBe("good");
    expect(rate("lcp", 3000)).toBe("needs-improvement");
    expect(rate("lcp", 5000)).toBe("poor");
    expect(rate("cls", 0.05)).toBe("good");
    expect(rate("inp", null)).toBe("unknown");
    expect(rate("load", 10)).toBe("unknown");
  });
});
