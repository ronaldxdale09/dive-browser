import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md"), "utf8");

describe("README memory claim", () => {
  it("does not say idle tabs drop a Chromium process", () => {
    // Discard tears down a Today tab's page view. The engine is
    // process-per-site, so a sibling on the same origin can keep the renderer.
    expect(readme).not.toMatch(/drop their Chromium process/i);
  });

  it("does not call Dive fast", () => {
    // docs/performance/RESULTS.md is a spent bank: startup and reload lose
    // to Chrome and Brave on the registered fixture. Do not re-score it.
    expect(readme).not.toMatch(/It is fast,/);
  });

  it("does not say fingerprinting scripts are blocked", () => {
    // DivePrivacy matches listed ad and tracker hosts. The tracker list
    // includes fingerprinting infrastructure. It does not block scripts
    // as a class and it is not a fingerprint randomizer.
    expect(readme).not.toMatch(/fingerprinting scripts/i);
  });
});
