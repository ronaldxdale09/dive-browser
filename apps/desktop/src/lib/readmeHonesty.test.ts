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

  it("does not say updates install themselves in the background", () => {
    // updater_configured is the pubkey gate. A check does not install;
    // About's Install and restart does. Dev builds have no updater.
    expect(readme).not.toMatch(/installs them in the background/i);
    expect(readme).toMatch(/Installing one restarts Dive/);
  });

  it("does not say the privacy screenshot is blocking by default", () => {
    // Prefs::default().block_trackers is false. The popover can block
    // when the person turns it on; the caption must not upgrade that.
    expect(readme).not.toContain("DivePrivacy</b> blocking ads and trackers per site");
    expect(readme).toMatch(/off until you turn it on/i);
  });

  it("does not say DivePrivacy lists run as if they are on", () => {
    // Same default as the screenshot caption. The pipeline can apply the
    // lists; Prefs::default().block_trackers is false.
    expect(readme).not.toContain("ads and tracker lists run in the request pipeline");
    expect(readme).toContain("ads and tracker lists can run in the request pipeline");
  });

  it("does not present the macOS token path as the only MCP connect command", () => {
    // state.rs: macOS is ~/Library/Application Support/app.dive.browser;
    // Windows is %APPDATA%\dive. Developer already uses Get-Content there.
    // An unlabeled cat ~/Library snippet reads as the command for every OS.
    expect(readme).toMatch(/Get-Content/);
    expect(readme).toMatch(/%APPDATA%/);
    const catAt = readme.indexOf("$(cat ~/Library");
    expect(catAt).toBeGreaterThan(-1);
    expect(readme.slice(Math.max(0, catAt - 240), catAt)).toMatch(/macOS/i);
  });

  it("does not say every tab is reachable by MCP", () => {
    // AppBrowser::tabs filters TabState::Discarded. The sidecar already
    // says sleeping tabs are omitted; the README must not upgrade that.
    expect(readme).not.toMatch(/Every tab is also reachable/i);
    expect(readme).toMatch(/sleeping tabs/i);
  });
});
