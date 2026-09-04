# DivePrivacy design

**Date:** 2026-09-04

## Intent

Replace Dive's 16-entry URL-glob blocker with a first-party privacy system that blocks common advertising, analytics, fingerprinting, telemetry, cryptomining, and popup infrastructure without making normal browsing brittle. The feature must feel native to Dive, remain local by default, coexist with developer request rules, and give users a fast escape hatch when a site breaks.

Dive owns and reviews every shipped rule. EasyList, EasyPrivacy, uAssets, AdGuard filters, and similar third-party lists are research references only; their rules are not imported, downloaded, or copied into DivePrivacy.

## Research basis

The implementation follows four mature patterns while keeping its own rules and product behavior:

- Brave's [`adblock-rust`](https://github.com/brave/adblock-rust) provides a maintained, high-performance parser and matcher for ABP-compatible network and cosmetic syntax. Dive uses the library, not Brave's filter lists.
- [uBlock Origin's filtering architecture](https://github.com/gorhill/uBlock/wiki/Overview-of-uBlock%27s-network-filtering-engine%3A-details) separates network filtering from cosmetic filtering and preserves exception rules. Dive adopts that separation.
- [uBlock Origin's per-site controls](https://github.com/gorhill/uBlock/wiki/Per-site-switches) demonstrate that users need immediate site-level recovery when filtering causes breakage. Dive exposes that control in the toolbar popover.
- Brave explicitly treats fast-changing rules for sites such as YouTube as risky and worthy of isolated rollout and QA. Dive therefore keeps YouTube handling in a fail-open compatibility module rather than placing broad media rules in the general list. See [Brave issue 36244](https://github.com/brave/brave-browser/issues/36244).

## Product principles

1. **Prevent the request when possible.** Cosmetic hiding is a complement, not a substitute for network privacy.
2. **Fail open.** A malformed rule, unavailable page context, script exception, or interception error must allow the request or page to continue.
3. **Never block ordinary documents or media generically.** Broad rules that can strand navigation or video playback are excluded.
4. **Make breakage reversible in one click.** A host-specific exception takes effect immediately and reloads the page.
5. **Report observed behavior.** A zero counter means "clean so far," not that the browser proved a page safe.
6. **Stay first-party and local.** No remote avatar call, filter subscription, analytics, or unsigned runtime rule update.

## Scope

### Included

- Dive-owned network rules for common ad, tracking, fingerprinting, telemetry, cryptomining, and popup endpoints.
- Correct request matching using URL, current document URL, request type, method, and first/third-party context.
- Explicit allow rules for known compatibility exceptions.
- Conservative, Dive-owned cosmetic selectors for high-confidence ad containers.
- A separately gated YouTube compatibility module.
- Global enablement, YouTube enablement, and exact-host site exceptions.
- Per-tab blocked counts by category.
- A redesigned protection popover with a locally generated DiceBear guardian avatar and reduced-motion-safe animation.
- Unit, integration, UI, and live smoke verification.

### Excluded

- Importing or subscribing to third-party filter lists.
- Claiming malware protection or complete anonymity. DivePrivacy is not a threat-intelligence service, VPN, DNS filter, or fingerprint randomizer.
- Copying rules or scriptlets from GPL filter repositories.
- Generic cookie-banner removal, paywall bypass, or social-widget removal.
- Blocking YouTube's `googlevideo.com` media delivery wholesale.
- Unsigned background filter updates. DivePrivacy rules ship with signed Dive application releases.

## Rule ownership and packaging

Rules live as human-reviewable assets in the repository:

```text
apps/desktop/src-tauri/privacy/
  ads.txt
  trackers.txt
  exceptions.txt
  cosmetic.json
  VERSION
```

Each network rule has an adjacent comment describing the vendor or behavior it targets. Rules must be independently written from public endpoint behavior, vendor documentation, or reproducible traffic observations. The initial set prioritizes broad coverage of established third-party infrastructure over fragile site-specific patterns.

`VERSION` is displayed in diagnostics and updated whenever the rule assets change. The assets are compiled into the application with `include_str!`, so they are available offline and covered by the signed application artifact. A later signed component-update channel is deliberately left out of this change.

The rules use the interoperable subset of ABP syntax supported by `adblock-rust`: hostname anchors, URL patterns, request-type options, third-party constraints, domain constraints, and exceptions. Procedural scriptlets and response-rewrite syntax are not accepted in the general rule files.

## Backend architecture

### DivePrivacy engine

A new `privacy` Rust module owns a `DivePrivacyEngine` initialized once in `AppState`. It builds independent matcher instances for `ads` and `trackers`, then loads the shared exception rules into both. Separate engines make category reporting deterministic without enabling debug metadata in production.

The engine exposes a pure decision API:

```rust
decide(RequestContext) -> PrivacyDecision
```

`RequestContext` contains the request URL, top-level document URL, CDP resource type, and HTTP method. `PrivacyDecision` is `Allow`, `BlockAds`, or `BlockTracker`. Invalid URLs and unknown resource types return `Allow`.

The engine never blocks a main-frame `Document` request. Exact-host site exceptions are checked before the matchers. An exception disables DivePrivacy for that site only; developer-defined workspace request rules remain active.

### One interception owner

The existing workspace mock/rewrite system already uses CDP `Fetch.requestPaused`. DivePrivacy must not install a second competing listener. `rules.rs` becomes the single interception owner and enables `Fetch` whenever either workspace rules or DivePrivacy is active.

For every paused request the pipeline is:

1. Resolve the current tab and document context.
2. Check whether DivePrivacy is globally enabled and the exact page host is not excepted.
3. Evaluate an explicit workspace developer rule. A matching custom block, mock, or header rule wins because it represents deliberate developer intent.
4. If no workspace rule matches, evaluate DivePrivacy.
5. Fail a blocked request with `BlockedByClient`; otherwise continue it.
6. If any decision or CDP command fails, attempt `Fetch.continueRequest` so the page cannot remain suspended.

Preference changes re-evaluate whether interception is needed on all open tabs. This replaces the hard-coded tracker portion of `Network.setBlockedURLs`; custom user URL globs may continue using that fast Chromium path.

### Status and counts

The backend emits a typed `PrivacyEvent` only after a DivePrivacy block decision is successfully sent to CDP:

```text
blocked { tab_id, category: ads | tracker }
```

The frontend privacy store keeps per-tab session counts and clears them with the existing network log lifecycle. YouTube removals are counted separately by page-script messages. The popover can therefore distinguish ads, trackers, and YouTube interventions without guessing from generic network errors.

No blocked URL is persisted or sent elsewhere by the privacy feature.

## Cosmetic filtering

`cosmetic.json` maps exact hosts to conservative CSS selectors. The backend selects the applicable rules and installs a generated script with `Page.addScriptToEvaluateOnNewDocument`; it also evaluates the script in the current document when protection is turned on.

The script inserts one style element bearing a Dive-owned marker. It does not use generic selectors such as `[class*=ad]`, inspect text content, or remove arbitrary nodes. Disabling protection or adding a site exception removes the style immediately. Cosmetic hits are not included in the blocked-request count because CSS matching does not prove an element represented an ad.

## YouTube compatibility module

YouTube handling is isolated from the general filter assets and enabled only for supported YouTube hosts when both global protection and `youtube_protection` are on.

It uses three progressively less invasive defenses:

1. Install an early, idempotent page-world hook that examines only same-origin YouTube player API JSON and removes known advertisement metadata fields before the player consumes them.
2. Sanitize already-present initial player data during document startup and YouTube SPA navigation.
3. As a fallback, observe the player for an explicit ad-playing state, activate an available skip control, and accelerate only the active advertisement. Original volume, mute state, and playback rate are restored when the state ends.

The module may wrap `fetch` and `XMLHttpRequest` only long enough to inspect responses from the narrow YouTube player API boundary; every other request delegates directly to the captured native function, with its receiver and arguments preserved. It must not replace `Response`, general media methods, or unrelated globals. Any parsing error returns the untouched payload. It does not block `googlevideo.com`, authentication, comments, captions, thumbnails, or ordinary player API requests.

YouTube is a moving target, so the UI says "YouTube protection active" rather than promising every ad will always be removed. The module has its own toggle and can be disabled without weakening general tracker protection.

## Preferences and compatibility

The persisted preference schema adds:

- `youtube_protection: bool`, default `true`.
- `privacy_exceptions: Vec<String>`, exact normalized hostnames, capped and validated.

The existing `block_trackers` key remains the global master switch to preserve stored profiles and generated API compatibility. Its documentation and labels change to "DivePrivacy protection." Existing `blocked_patterns` remain independent custom URL globs.

Site exceptions are normalized through URL parsing, lowercased, stripped of a terminal dot, deduplicated, and capped. IP literals are allowed as exact values. Wildcards, paths, and public-suffix-wide exceptions are rejected.

## Popover design

The toolbar button remains a shield and keeps the compact numeric badge. The open popover becomes a 360px protection card with three regions.

### Guardian header

- A deterministic DiceBear `botttsNeutral` avatar seeded with `Dive Privacy`, rendered locally as a data URI and cached.
- A mint halo and status dot indicate active protection. The halo uses one restrained opacity/scale cycle and does not loop continuously.
- Headline states `Protected on this site`, `Protection paused here`, or `DivePrivacy is off`.
- Supporting text reports the observed total for the current page and uses `Clean so far` at zero.

### Protection layers

Three compact rows show:

- Ads blocked: observed network count.
- Trackers stopped: observed network count.
- YouTube protection: active, inactive, or unavailable for the current site.

The main switch controls protection for the current site. When global protection is on, toggling it off adds the exact current hostname to exceptions and reloads; toggling it on removes the exception and reloads. A smaller global control appears when DivePrivacy is completely off. YouTube has its own switch.

### Footer

The footer links to all privacy settings and displays the bundled DivePrivacy version. It explains that settings apply across workspaces while site exceptions are host-specific.

Popover entry, avatar halo, count changes, row reveals, hover, and switch feedback use opacity and transform transitions between 120-180ms. `prefers-reduced-motion` disables nonessential motion. Keyboard focus remains trapped while open, Escape closes it, outside click closes it, and focus returns to the trigger.

## Settings design

Settings > Privacy renames the global control to `DivePrivacy protection`, adds the YouTube toggle, lists site exceptions with remove buttons, and retains custom blocked patterns in an advanced subsection. Copy clearly separates DivePrivacy's curated rules from user-provided URL globs.

## Testing strategy

### Rust unit tests

- Valid ad and tracker rules block their intended request types.
- Exceptions override a block.
- First/third-party and domain-scoped behavior use the document URL correctly.
- Main-frame documents, malformed URLs, unknown types, and malformed rules fail open.
- Site exception normalization rejects unsafe wildcard/path entries and deduplicates hosts.
- Preference migration fills new fields for older stored blobs.
- Interception planning enables `Fetch` for workspace rules or DivePrivacy and disables it for neither.
- Workspace rules take precedence and every error branch continues a paused request.

### Local integration tests

A deterministic local fixture loads ordinary content alongside routes named and structured as ads, analytics, pixels, fingerprint probes, and media. Tests assert that targeted requests fail with `BlockedByClient`, ordinary scripts/media succeed, counts use the correct category, and a site exception restores requests after reload.

### Frontend tests

- The popover renders all global, site, YouTube, zero-state, and counted states.
- The DiceBear avatar is a local data URI.
- Site toggles persist the exact host and request a reload.
- Counts update from typed privacy events and do not count generic failures.
- Focus trap, Escape, trigger focus return, reduced-motion classes, and settings navigation work.
- Preferences remain optimistic but roll back or surface the existing app error if persistence fails.

### YouTube tests

- Player-response sanitization removes only recognized ad metadata and preserves all other keys.
- Invalid JSON and unknown response shapes are returned unchanged.
- Initialization is idempotent across SPA navigation.
- Skip fallback acts only while the player advertises an ad state and restores media state afterward.
- Turning protection off removes observers and stops further intervention.

### Completion checks

- Run the focused Rust and Vitest suites first, then the full frontend test, typecheck, lint, build, Rust test, formatting, and clippy checks.
- Rebuild and restart the CEF desktop app.
- Visually inspect the popover at normal and compact widths in dark and light themes.
- Smoke-test a representative content site, a local blocking fixture, YouTube navigation/playback, site pause/resume, and custom workspace request rules.
- Report YouTube results as an observed smoke result, not a permanent guarantee, because ad delivery varies by geography, account, inventory, and experiments.

## Rollout and failure behavior

This change replaces only the built-in tracker list. Existing user preferences and custom blocked patterns migrate without data loss. If the DivePrivacy engine cannot initialize, the app logs the error, leaves browsing functional, and reports protection unavailable in the UI. If the YouTube script fails, ordinary playback continues.

The first rule set should be deliberately conservative. False-positive recovery and normal playback are release blockers; maximizing the number shown in the counter is not.
