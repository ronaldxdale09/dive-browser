# DivePrivacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dive's short URL-glob blocker with a first-party, context-aware DivePrivacy blocker, isolated YouTube protection, site exceptions, accurate counters, and a polished DiceBear protection popover.

**Architecture:** A thread-safe `adblock-rust` matcher loads Dive-owned, bundled network assets into separate ad and tracker engines. The existing CDP Fetch listener remains the sole request-interception owner, evaluates explicit workspace rules first, then DivePrivacy, and emits typed category events only after a successful block. Conservative cosmetic rules and a fail-open YouTube script are installed per tab; the React chrome consumes typed status events and renders global, per-site, and YouTube controls.

**Tech Stack:** Rust 2024, `adblock` 0.13.3 without its single-thread feature, Tauri/CEF CDP Fetch and Runtime APIs, serde/specta, React 19, Zustand 5, Vitest, Tailwind CSS 4, DiceBear 9.4.3.

**Spec:** `docs/superpowers/specs/2026-09-04-diveprivacy-design.md`

## Global Constraints

- Dive owns and reviews every shipped rule; do not import, download, or copy EasyList, EasyPrivacy, uAssets, AdGuard, or other third-party filter data.
- The matcher dependency may parse the rules, but the rule corpus and product behavior remain first-party.
- All malformed inputs and CDP failures fail open; no paused request may be stranded.
- Never generically block main-frame documents, `googlevideo.com`, or ordinary media.
- Existing `block_trackers` and `blocked_patterns` data must migrate without loss.
- Existing workspace mock/rewrite/header rules remain authoritative and use the same Fetch listener.
- Avatar generation is local; the chrome must not call DiceBear's network API.
- Motion is limited to opacity/transform over 120-180ms and disabled by `prefers-reduced-motion`.
- Do not modify or revert unrelated files in the already-dirty worktree.
- Existing modified files must be staged with `git add -p` and reviewed with `git diff --cached`; never stage an entire pre-modified path.

## File map

- `apps/desktop/src-tauri/privacy/{ads.txt,trackers.txt,exceptions.txt,cosmetic.json,VERSION}` — Dive-owned, reviewable rule assets.
- `apps/desktop/src-tauri/src/privacy.rs` — engine construction, request decisions, status event, cosmetic/YouTube lifecycle, and pure tests.
- `apps/desktop/src-tauri/src/inject/youtube_privacy.js` — narrow, idempotent YouTube page-world hook.
- `apps/desktop/src-tauri/src/rules.rs` — the sole Fetch listener and precedence/fail-open policy.
- `apps/desktop/src-tauri/src/{state.rs,prefs.rs,engine.rs,commands.rs,lib.rs}` — state ownership, preferences, tab attachment, reapplication, module/event registration.
- `apps/desktop/src/generated/bindings.ts` and `apps/desktop/src/lib/ipc.ts` — generated and hand-written typed frontend bridge.
- `apps/desktop/src/store/privacy.ts` — per-tab category counters and event subscription.
- `apps/desktop/src/lib/privacyAvatar.ts` — memoized local DiceBear guardian.
- `apps/desktop/src/components/{ProtectionMenu.tsx,Toolbar.test.tsx,SettingsDialog.tsx,SettingsDialog.test.tsx}` — popover and settings UI with tests.
- `apps/desktop/src/lib/youtubePrivacy.test.ts` — jsdom behavioral tests for the injected hook.
- `apps/desktop/src/styles.css` — scoped popover motion keyframes and reduced-motion fallback.
- `scripts/fixtures/diveprivacy/{index.html,ordinary.js}` — deterministic live CEF smoke page.

---

### Task 1: Dive-owned rule assets and matcher

**Files:**
- Create: `apps/desktop/src-tauri/privacy/ads.txt`
- Create: `apps/desktop/src-tauri/privacy/trackers.txt`
- Create: `apps/desktop/src-tauri/privacy/exceptions.txt`
- Create: `apps/desktop/src-tauri/privacy/cosmetic.json`
- Create: `apps/desktop/src-tauri/privacy/VERSION`
- Create: `apps/desktop/src-tauri/src/privacy.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `PrivacyCategory::{Ads, Tracker}`, `PrivacyDecision::{Allow, Block(PrivacyCategory)}`, `RequestContext<'a>`, `DivePrivacy::new()`, `DivePrivacy::decide(&RequestContext)`, `DIVE_PRIVACY_VERSION`.
- Consumes: `adblock::{Engine, FilterSet, lists::ParseOptions, request::Request}`.

- [ ] **Step 1: Add failing matcher tests**

Add tests to the new module before the implementation:

```rust
#[test]
fn classifies_ads_trackers_and_safe_requests() {
    let privacy = DivePrivacy::new();
    assert_eq!(privacy.decide(&ctx("https://ads.doubleclick.net/pagead/id", "https://news.test/", "script")), PrivacyDecision::Block(PrivacyCategory::Ads));
    assert_eq!(privacy.decide(&ctx("https://www.google-analytics.com/g/collect", "https://shop.test/", "xhr")), PrivacyDecision::Block(PrivacyCategory::Tracker));
    assert_eq!(privacy.decide(&ctx("https://cdn.shop.test/app.js", "https://shop.test/", "script")), PrivacyDecision::Allow);
}

#[test]
fn exceptions_and_documents_fail_open() {
    let privacy = DivePrivacy::from_text("||metrics.test^", "", "@@||metrics.test/required.js$script");
    assert_eq!(privacy.decide(&ctx("https://metrics.test/required.js", "https://app.test/", "script")), PrivacyDecision::Allow);
    assert_eq!(privacy.decide(&ctx("https://metrics.test/", "https://metrics.test/", "document")), PrivacyDecision::Allow);
    assert_eq!(privacy.decide(&ctx("not a url", "https://app.test/", "script")), PrivacyDecision::Allow);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p dive-desktop privacy::tests --lib`

Expected: compilation fails because `privacy` types and assets do not exist.

- [ ] **Step 3: Add the matcher dependency and minimal engine**

Add a thread-safe dependency:

```toml
adblock = { version = "0.13.3", default-features = false, features = ["embedded-domain-resolver", "full-regex-handling"] }
```

Implement two engines with the shared exception text appended to both:

```rust
pub struct RequestContext<'a> {
    pub url: &'a str,
    pub document_url: &'a str,
    pub resource_type: &'a str,
    pub method: &'a str,
}

pub fn decide(&self, context: &RequestContext<'_>) -> PrivacyDecision {
    if context.resource_type.eq_ignore_ascii_case("document") { return PrivacyDecision::Allow; }
    let Ok(request) = Request::new(context.url, context.document_url, context.resource_type, context.method) else { return PrivacyDecision::Allow; };
    if self.ads.check_network_request(&request).should_block() { return PrivacyDecision::Block(PrivacyCategory::Ads); }
    if self.trackers.check_network_request(&request).should_block() { return PrivacyDecision::Block(PrivacyCategory::Tracker); }
    PrivacyDecision::Allow
}
```

Start the rule corpus conservatively with independently authored rules for the following dedicated infrastructure: Google/DoubleClick, Amazon Ads, Microsoft Ads, Meta Ads, Criteo, Taboola, Outbrain, PubMatic, OpenX, Magnite/Rubicon, Index Exchange, Xandr/AppNexus, Media.net, Smart AdServer, Yieldmo, Casale, Adform, Teads, and Zedo for ads; Google Analytics, Adobe Analytics collection, Segment, Mixpanel, Amplitude, Hotjar, FullStory, New Relic browser collection, Datadog browser intake, Mouseflow, Crazy Egg, Heap, Matomo Cloud, Plausible hosted analytics, fingerprinting vendors, tracking pixels, and established browser cryptomining endpoints for trackers. Use hostname anchors plus `$third-party` where the vendor also serves functional first-party content; add narrower path/type rules where blocking the entire hostname would be unsafe. Each file must contain at least 60 independently reviewed network rules, every vendor cluster receives a provenance comment, and duplicate rules are rejected by a test. `exceptions.txt` begins empty except for compatibility cases demonstrated by a regression test. Set `VERSION` to `2026.09.04.1` and `cosmetic.json` to a valid empty-host map until Task 4.

- [ ] **Step 4: Run matcher tests and dependency policy checks**

Run: `cargo test -p dive-desktop privacy::tests --lib`

Expected: all matcher tests pass; normal application URLs and documents remain allowed.

- [ ] **Step 5: Commit the matcher slice**

```bash
git add apps/desktop/src-tauri/privacy apps/desktop/src-tauri/src/privacy.rs
git add -p apps/desktop/src-tauri/Cargo.toml Cargo.lock apps/desktop/src-tauri/src/lib.rs
git diff --cached
git commit -m "feat: add DivePrivacy matcher and owned rules"
```

### Task 2: Preferences and exact-host exceptions

**Files:**
- Modify: `apps/desktop/src-tauri/src/prefs.rs`
- Modify: `apps/desktop/src/store/prefs.ts`
- Modify: `apps/desktop/src/components/SettingsDialog.test.tsx`

**Interfaces:**
- Produces: `Prefs.youtube_protection: bool`, `Prefs.privacy_exceptions: Vec<String>`, `Prefs::privacy_enabled_for(&str) -> bool`, `normalize_privacy_exceptions(Vec<String>) -> Vec<String>`.
- Consumes: existing `parse_stored`, `Prefs::clamp`, and optimistic `usePrefs.update` flow.

- [ ] **Step 1: Write failing preference migration and validation tests**

```rust
#[test]
fn old_profiles_receive_diveprivacy_defaults() {
    let prefs = parse_stored(r#"{"block_trackers":true}"#).unwrap();
    assert!(prefs.youtube_protection);
    assert!(prefs.privacy_exceptions.is_empty());
}

#[test]
fn privacy_exceptions_are_exact_hosts() {
    let prefs = Prefs { privacy_exceptions: vec!["Example.COM.".into(), "https://bad.test/path".into(), "*.wide.test".into(), "example.com".into()], ..Prefs::default() }.clamp();
    assert_eq!(prefs.privacy_exceptions, vec!["example.com"]);
    assert!(!prefs.privacy_enabled_for("https://example.com/page"));
    assert!(prefs.privacy_enabled_for("https://sub.example.com/page"));
}
```

Update the frontend fixture test to expect both new fields in `DEFAULT_PREFS`.

- [ ] **Step 2: Run focused Rust and frontend tests and verify RED**

Run: `cargo test -p dive-desktop prefs::tests --lib && pnpm --filter @dive/desktop test -- src/store/prefs.test.ts`

Expected: compile/assertion failures for the missing fields.

- [ ] **Step 3: Implement schema-compatible defaults and normalization**

Add fields with serde defaults and cap exceptions at 200. Normalize with `url::Host::parse`, rejecting strings containing `/`, `*`, whitespace, or an empty label; lowercase, strip the terminal dot, sort, and deduplicate. Implement `privacy_enabled_for` by parsing the document URL and comparing only its exact hostname. Remove `TRACKERS` from `blocked_urls()` so `Network.setBlockedURLs` contains user patterns only.

Update `DEFAULT_PREFS`:

```ts
youtube_protection: true,
privacy_exceptions: [],
```

- [ ] **Step 4: Run preference tests and verify GREEN**

Run: `cargo test -p dive-desktop prefs::tests --lib && pnpm --filter @dive/desktop test -- src/store/prefs.test.ts src/components/SettingsDialog.test.tsx`

Expected: all focused tests pass and partial stored blobs receive the new defaults.

- [ ] **Step 5: Commit preference migration**

```bash
git add -p apps/desktop/src-tauri/src/prefs.rs apps/desktop/src/store/prefs.ts apps/desktop/src/components/SettingsDialog.test.tsx
git diff --cached
git commit -m "feat: add DivePrivacy preferences and site exceptions"
```

### Task 3: Unified interception and typed block events

**Files:**
- Modify: `apps/desktop/src-tauri/src/privacy.rs`
- Modify: `apps/desktop/src-tauri/src/rules.rs`
- Modify: `apps/desktop/src-tauri/src/state.rs`
- Modify: `apps/desktop/src-tauri/src/engine.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/generated/bindings.ts`
- Modify: `apps/desktop/src/lib/ipc.ts`

**Interfaces:**
- Produces: `PrivacyEvent::{Blocked { tab_id, category }, YouTube { tab_id, count }}`, `PrivacyInfo { version: String, ad_rules: u32, tracker_rules: u32, cosmetic_hosts: u32 }`, `privacy_info() -> PrivacyInfo`, `interception_required(rules: &[Rule], prefs: &Prefs) -> bool`, `decide_paused_request(...) -> InterceptAction`.
- Consumes: `AppState.privacy`, stored tab URL, workspace rules, and `Fetch.requestPaused` events.

- [ ] **Step 1: Add failing precedence and interception-planning tests**

```rust
#[test]
fn fetch_is_enabled_for_rules_or_diveprivacy() {
    assert!(!interception_required(&[], &Prefs::default()));
    assert!(interception_required(&[rule("*", RuleAction::Block)], &Prefs::default()));
    assert!(interception_required(&[], &Prefs { block_trackers: true, ..Prefs::default() }));
}

#[test]
fn workspace_rule_precedes_privacy() {
    let rules = vec![rule("*://ads.doubleclick.net/*", RuleAction::Mock { status: 204, content_type: "text/plain".into(), body: String::new() })];
    assert!(matches!(decide_paused_request(&rules, &privacy(), &enabled_prefs(), &paused_ad()), InterceptAction::Mock { .. }));
}
```

- [ ] **Step 2: Run rule tests and verify RED**

Run: `cargo test -p dive-desktop rules::tests --lib`

Expected: missing planner/decision types.

- [ ] **Step 3: Implement a single decision pipeline**

Store `DivePrivacy` in `AppState`. Change `rules::apply` to receive both rules and prefs, enabling Fetch if either needs it. Refactor the event loop so it creates one pure `InterceptAction` before sending exactly one terminal CDP command. Use the stored tab URL as `document_url`, the paused event's `resourceType`, and the request method. A successful DivePrivacy `Fetch.failRequest` emits:

```rust
PrivacyEvent::Blocked { tab_id, category }.emit(&app)
```

On listener lag, disable and re-enable Fetch from current rules and preferences. On any non-continue action failure, call `Fetch.continueRequest`. Update initial tab attachment, `prefs_set`, and `rules_set` to reapply the shared interception state.

- [ ] **Step 4: Register/export the typed event and verify GREEN**

Add `crate::privacy::PrivacyEvent` to `collect_events!`, add the side-effect-free `privacy_info` command to `collect_commands!`, and export both from `ipc.ts`. `PrivacyInfo` reports only bundled metadata and never URLs or browsing history. Then run:

`cargo test -p dive-desktop rules::tests --lib commands::tests::export_bindings`

Expected: precedence tests pass and generated bindings include `PrivacyEvent`, `PrivacyInfo`, `privacyInfo()`, and the event listener.

- [ ] **Step 5: Commit unified interception**

```bash
git add -p apps/desktop/src-tauri/src/{privacy.rs,rules.rs,state.rs,engine.rs,commands.rs,lib.rs} apps/desktop/src/generated/bindings.ts apps/desktop/src/lib/ipc.ts
git diff --cached
git commit -m "feat: enforce DivePrivacy through one request pipeline"
```

### Task 4: Cosmetic filtering and fail-open YouTube protection

**Files:**
- Create: `apps/desktop/src-tauri/src/inject/youtube_privacy.js`
- Create: `apps/desktop/src/lib/youtubePrivacy.test.ts`
- Modify: `apps/desktop/src-tauri/privacy/cosmetic.json`
- Modify: `apps/desktop/src-tauri/src/privacy.rs`
- Modify: `apps/desktop/src-tauri/src/engine.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `privacy::attach_page`, `privacy::apply_page`, `privacy::map_binding_event`, page global `window.__divePrivacy` with `install()`, `configure()`, `dispose()`, and test-only `sanitize()`.
- Consumes: current prefs/site exception, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`, `Runtime.bindingCalled`.

- [ ] **Step 1: Write failing jsdom tests for the injected script**

Load the script as text, evaluate it once, and assert:

```ts
expect(window.__divePrivacy.sanitize({ adPlacements: [1], videoDetails: { videoId: "abc" } })).toEqual({ videoDetails: { videoId: "abc" } });
expect(window.__divePrivacy.sanitize("not-an-object")).toBe("not-an-object");
const first = window.fetch;
window.__divePrivacy.install();
expect(window.fetch).toBe(first); // second install is idempotent
window.__divePrivacy.dispose();
expect(window.fetch).toBe(nativeFetch);
```

Add a DOM fixture with `.ad-showing`, a skip button, and a video; assert the skip button is clicked and original volume, mute, and playback rate are restored after the class is removed.

- [ ] **Step 2: Run the script test and verify RED**

Run: `pnpm --filter @dive/desktop test -- src/lib/youtubePrivacy.test.ts`

Expected: the script/global is missing.

- [ ] **Step 3: Implement the narrow YouTube hook**

Capture native `fetch` and XHR methods once. Delegate non-player URLs unchanged. For same-origin paths ending in `/youtubei/v1/player`, clone JSON payloads, recursively remove only `adPlacements`, `playerAds`, and `adSlots`, and construct an equivalent response. Catch every parse/clone error and return the untouched response. Observe YouTube SPA navigation and `.html5-video-player.ad-showing`; prefer clicking visible skip controls, otherwise accelerate only during the ad and restore media state on exit. `dispose()` disconnects observers and restores wrapped functions.

Populate `cosmetic.json` only with exact-host, high-confidence selectors authored from observed page DOM for YouTube player ad overlays/promoted shelves and Google search top/bottom ad containers. Generate CSS through JSON serialization, use a fixed `data-dive-privacy` style marker, and remove it on disable. Do not include generic class-substring selectors.

- [ ] **Step 4: Attach, configure, and report YouTube interventions**

On every CEF tab, add a unique binding, register the script before navigation, and evaluate it in the current document. Parse only bounded JSON binding payloads shaped as `{ kind: "youtube", count: 1 }`; emit `PrivacyEvent::YouTube { tab_id, count }`. Preference and site-exception changes call `configure` immediately and reload only for site pause/resume.

- [ ] **Step 5: Run script and Rust lifecycle tests**

Run: `pnpm --filter @dive/desktop test -- src/lib/youtubePrivacy.test.ts && cargo test -p dive-desktop privacy::tests --lib`

Expected: sanitization is narrow/idempotent, cleanup restores native functions, and malformed binding events are ignored.

- [ ] **Step 6: Commit page protection**

```bash
git add apps/desktop/src-tauri/src/inject/youtube_privacy.js apps/desktop/src/lib/youtubePrivacy.test.ts
git add -p apps/desktop/src-tauri/privacy/cosmetic.json apps/desktop/src-tauri/src/{privacy.rs,engine.rs,commands.rs}
git diff --cached
git commit -m "feat: add cosmetic and YouTube privacy layers"
```

### Task 5: Frontend privacy state and local guardian avatar

**Files:**
- Create: `apps/desktop/src/store/privacy.ts`
- Create: `apps/desktop/src/store/privacy.test.ts`
- Create: `apps/desktop/src/lib/privacyAvatar.ts`
- Create: `apps/desktop/src/lib/privacyAvatar.test.ts`
- Modify: `apps/desktop/src/store/browser.ts`

**Interfaces:**
- Produces: `usePrivacy` with `loadInfo(): Promise<void>`, `listenPrivacy()`, `selectPrivacyCounts(tabId)`, `clearPrivacy(tabId)`, `privacyGuardian(): string`.
- Consumes: generated `events.privacyEvent`, `ipc.privacyInfo`, tab load lifecycle, DiceBear `botttsNeutral`.

- [ ] **Step 1: Write failing reducer and avatar tests**

```ts
expect(foldPrivacy(undefined, { type: "blocked", data: { tab_id: "t", category: "ads" } })).toEqual({ ads: 1, trackers: 0, youtube: 0 });
expect(foldPrivacy({ ads: 1, trackers: 0, youtube: 0 }, { type: "youtube", data: { tab_id: "t", count: 2 } })).toEqual({ ads: 1, trackers: 0, youtube: 2 });
expect(privacyGuardian()).toMatch(/^data:image\/svg\+xml/);
expect(privacyGuardian()).toBe(privacyGuardian());
await usePrivacy.getState().loadInfo();
expect(usePrivacy.getState().info?.version).toBe("2026.09.04.1");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @dive/desktop test -- src/store/privacy.test.ts src/lib/privacyAvatar.test.ts`

Expected: missing modules/functions.

- [ ] **Step 3: Implement the store and guardian**

Use a per-tab `{ ads, trackers, youtube }` record capped at safe integers. Subscribe once with the same singleton-promise pattern as the network store. Load bundled version/count metadata once through `ipc.privacyInfo`. Clear counts on a main-frame `started` load and drop counts when a tab closes. Generate `botttsNeutral` locally with seed `Dive Privacy`, 96px SVG, transparent background, mint/graphite palette, and a module cache.

- [ ] **Step 4: Run state tests and verify GREEN**

Run: `pnpm --filter @dive/desktop test -- src/store/privacy.test.ts src/lib/privacyAvatar.test.ts src/store/browser.test.ts`

Expected: category counts, reset/drop lifecycle, and avatar caching pass.

- [ ] **Step 5: Commit frontend state**

```bash
git add apps/desktop/src/store/{privacy.ts,privacy.test.ts} apps/desktop/src/lib/{privacyAvatar.ts,privacyAvatar.test.ts}
git add -p apps/desktop/src/store/browser.ts
git diff --cached
git commit -m "feat: track DivePrivacy results in the chrome"
```

### Task 6: Protection popover redesign

**Files:**
- Modify: `apps/desktop/src/components/ProtectionMenu.tsx`
- Modify: `apps/desktop/src/components/Toolbar.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `usePrivacy`, active tab URL, `privacyGuardian`, `usePrefs.update`, `ipc.tabReload`, existing `useCoversContent` and focus trap.
- Produces: accessible 360px protection card and exact-host pause/resume behavior.

- [ ] **Step 1: Replace the old toolbar test with failing product-state tests**

Cover these assertions:

```ts
expect(screen.getByText("Clean so far")).toBeTruthy();
expect(screen.getByAltText("Dive Privacy guardian").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
expect(screen.getByText("Ads blocked").nextSibling?.textContent).toBe("2");
expect(screen.getByText("Trackers stopped").nextSibling?.textContent).toBe("1");
expect(screen.getByText("YouTube protection").nextSibling?.textContent).toBe("Unavailable here");
```

Click `Protection on this site`, assert `prefsSet` receives `privacy_exceptions: ["example.com"]`, then assert `tabReload(tab.id)`. Add inverse resume, global-off, YouTube-host, Escape, and trigger-focus tests.

- [ ] **Step 2: Run the component test and verify RED**

Run: `pnpm --filter @dive/desktop test -- src/components/Toolbar.test.tsx`

Expected: old copy/layout and missing state controls fail.

- [ ] **Step 3: Build the guardian card**

Render a local avatar, one-shot halo, status dot, honest headline, animated numeric badge, three layer rows, site switch, YouTube switch, global enable affordance, ruleset version, and settings link. Resolve the active tab with `tabs.find(tab => tab.id === activeTab)`, derive the exact host with `new URL`, and disable site controls for internal/invalid URLs. Await preference persistence before calling `ipc.tabReload`; surface failure through the existing store error path and do not reload.

Use only scoped classes/keyframes:

```css
@keyframes privacy-arrive { from { opacity: 0; transform: translateY(-4px) scale(.985); } }
@keyframes privacy-halo { 0% { opacity: 0; transform: scale(.8); } 55% { opacity: .5; } 100% { opacity: 0; transform: scale(1.35); } }
@media (prefers-reduced-motion: reduce) { .privacy-motion { animation: none !important; transition: none !important; } }
```

- [ ] **Step 4: Run UI tests and accessibility assertions**

Run: `pnpm --filter @dive/desktop test -- src/components/Toolbar.test.tsx src/components/FeatureBar.test.tsx`

Expected: all toolbar and protection states pass without regressing overlay coverage.

- [ ] **Step 5: Commit the popover**

```bash
git add -p apps/desktop/src/components/{ProtectionMenu.tsx,Toolbar.test.tsx} apps/desktop/src/styles.css
git diff --cached
git commit -m "feat: redesign the DivePrivacy popover"
```

### Task 7: Privacy settings controls

**Files:**
- Modify: `apps/desktop/src/components/SettingsDialog.tsx`
- Modify: `apps/desktop/src/components/SettingsDialog.test.tsx`

**Interfaces:**
- Consumes: `Prefs.block_trackers`, `Prefs.youtube_protection`, `Prefs.privacy_exceptions`, `usePrivacy.info`, existing `Switch`, `Row`, and `Group`.
- Produces: global DivePrivacy control, YouTube control, host-exception list/removal, and advanced custom patterns copy.

- [ ] **Step 1: Write failing settings tests**

```ts
expect(screen.getByRole("switch", { name: "DivePrivacy protection" })).toBeTruthy();
expect(screen.getByRole("switch", { name: "YouTube protection" })).toBeTruthy();
expect(screen.getByText("example.com")).toBeTruthy();
fireEvent.click(screen.getByRole("button", { name: "Resume protection on example.com" }));
await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith(expect.objectContaining({ privacy_exceptions: [] })));
```

- [ ] **Step 2: Run settings tests and verify RED**

Run: `pnpm --filter @dive/desktop test -- src/components/SettingsDialog.test.tsx`

Expected: missing labels and exception controls.

- [ ] **Step 3: Implement settings UI**

Rename the master label and explanatory copy, add the YouTube switch disabled when global protection is off, render exception chips with remove buttons, and label custom blocked patterns as `Custom URL rules` in an advanced group. Show the bundled ruleset version without implying a network subscription.

- [ ] **Step 4: Run settings tests and verify GREEN**

Run: `pnpm --filter @dive/desktop test -- src/components/SettingsDialog.test.tsx`

Expected: all legacy settings behavior plus new controls pass.

- [ ] **Step 5: Commit settings UI**

```bash
git add -p apps/desktop/src/components/{SettingsDialog.tsx,SettingsDialog.test.tsx}
git diff --cached
git commit -m "feat: expose DivePrivacy settings and exceptions"
```

### Task 8: End-to-end verification, visual QA, and restart

**Files:**
- Create: `scripts/fixtures/diveprivacy/index.html`
- Create: `scripts/fixtures/diveprivacy/ordinary.js`
- Modify if needed from observed defects only: files touched in Tasks 1-7.
- Do not add a claim-only fixture that bypasses the production matcher.

**Interfaces:**
- Consumes: the complete DivePrivacy stack.
- Produces: verified build, live app, and an evidence-based handoff with explicit YouTube limitations.

- [ ] **Step 1: Run the complete automated checks**

```bash
pnpm --filter @dive/desktop test
pnpm --filter @dive/desktop typecheck
pnpm --filter @dive/desktop lint
pnpm --filter @dive/desktop exec vite build
cargo test -p dive-desktop
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: new tests pass. Record pre-existing unrelated failures separately; do not hide or rewrite them.

- [ ] **Step 2: Run deterministic local matcher and interception smoke checks**

Create a static fixture whose page sets `window.ordinaryLoaded = false`, loads `ordinary.js` to turn it true, and requests one pixel from `https://ads.doubleclick.net/diveprivacy-fixture.gif` and one script from `https://www.google-analytics.com/diveprivacy-fixture.js`. Serve it with `python3 -m http.server 18765 --directory scripts/fixtures/diveprivacy`, open `http://127.0.0.1:18765/` in the rebuilt CEF app with protection enabled, and confirm `window.ordinaryLoaded === true`. Confirm the two remote requests fail as `BlockedByClient`, popover categories increment, pausing `127.0.0.1` restores attempted network access after reload, and a workspace mock rule still wins. Stop only the fixture server after the check.

- [ ] **Step 3: Rebuild and restart Dive**

Stop only the known development app process/session, preserve unrelated background Dive processes, then run `pnpm --filter @dive/desktop dev`. Wait for the CEF window and restored tab before testing.

- [ ] **Step 4: Perform visual and interaction QA**

Inspect dark and light themes at normal and compact widths. Verify avatar rendering, no remote request for it, entry/halo/count motion, reduced-motion suppression, keyboard focus, Escape, site pause/resume, global enablement, YouTube status, settings navigation, and the native-page snapshot beneath the open popover.

- [ ] **Step 5: Perform live browsing and YouTube smoke checks**

Open representative content pages and YouTube. Verify navigation, sign-in-neutral playback, captions, seek, volume, comments, SPA video changes, and ordinary media remain functional. If an ad is served, record whether metadata pruning or fallback skipping acts and whether the category count changes. Never report "YouTube ads guaranteed blocked" when no ad was delivered during the run.

- [ ] **Step 6: Commit only defect fixes and prepare the handoff**

```bash
git add scripts/fixtures/diveprivacy/index.html scripts/fixtures/diveprivacy/ordinary.js
git add -p apps/desktop/src-tauri/src/privacy.rs apps/desktop/src-tauri/src/rules.rs apps/desktop/src/components/ProtectionMenu.tsx apps/desktop/src/components/SettingsDialog.tsx apps/desktop/src/styles.css
git diff --cached
git commit -m "fix: harden DivePrivacy after live verification"
```

Report the ruleset version, focused/full check results, live scenarios observed, current development process, and any pre-existing unrelated failures.
