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
});
