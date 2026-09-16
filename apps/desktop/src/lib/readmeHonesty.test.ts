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

  it("says page_evaluate stays off unless DIVE_MCP_ALLOW_EVAL is set", () => {
    // crates/dive-mcp Config.allow_evaluate is false unless that env is set.
    // Settings › Developer already says so; the README connect path must too.
    expect(readme).toMatch(/DIVE_MCP_ALLOW_EVAL/);
    expect(readme).toMatch(/page_evaluate/i);
  });

  it("does not say private by default", () => {
    // Prefs::default().block_trackers is false. Skip and DIVE_SKIP_ONBOARDING
    // leave it off. FeaturesStep preselects protection but only writes on finish.
    expect(readme).not.toMatch(/private by default/i);
  });

  it("does not say fingerprinting scripts are blocked", () => {
    // DivePrivacy matches listed ad and tracker hosts. The tracker list
    // includes fingerprinting infrastructure. It does not block scripts
    // as a class and it is not a fingerprint randomizer.
    expect(readme).not.toMatch(/fingerprinting scripts/i);
  });

  it("does not send Windows install-as-app only to Applications and the Dock", () => {
    // webapp.rs: macOS is ~/Applications/Dive Apps; Windows is
    // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Dive Apps.
    expect(readme).not.toContain("~/Applications/Dive Apps` for Spotlight and the Dock");
    expect(readme).toContain("Start Menu");
  });

  it("says private windows do not serve MCP", () => {
    // lib.rs starts the server only when !is_private(). advertised_url
    // is empty in a private window. About and Developer already say so.
    expect(readme).toMatch(/private windows do not serve MCP/i);
  });

  it("does not say every tab is reachable by MCP", () => {
    // AppBrowser::tabs filters TabState::Discarded. The sidecar already
    // says sleeping tabs are omitted; the README must not upgrade that.
    expect(readme).not.toMatch(/Every tab is also reachable/i);
    expect(readme).toMatch(/sleeping tabs/i);
  });
});
