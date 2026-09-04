# DIVE browser review — 5 September 2026

DIVE has a capable foundation and an unusually broad developer toolkit. The highest-value next phase is to make everyday navigation, long sessions, permissions, recovery, and releases predictable, while making the interface easier to learn. Preserve the workspace model, local developer tools, capture editor, and restrained visual style.

This is an audit and proposed roadmap; no application fixes were made.

**Scope and evidence**

Reviewed the architecture from startup and persistence through React chrome, native page views, navigation, workspaces/profiles, developer feeds, permissions, extensions, capture/media, tab discard, crash recovery, and release checks. Initial HEAD was `8d64584`. Source review is not an exhaustive proof of every function or website.

The existing release executable and installed executable had identical SHA-256: `ea9255a01663db622357f4b40b29bbf7d6cc04c1265c4d577a26f413f390fc78`. Runtime tests used that existing release bundle with disposable profiles. It was not rebuilt from a frozen audit snapshot. An unrelated subtitle-script edit appeared during the audit; it and the pre-existing untracked signing script were preserved.

Native computer-use inspection timed out twice. Visual observations use the checked-in interface screenshot and current component/styles source; they are not current pixel-level verification. Real page/runtime tests used the application's MCP test harness.

| Fresh check | Result and limit |
| --- | --- |
| `pnpm check` | Exit 0: formatting, TypeScript, ESLint, 601 frontend tests in 85 files, Vite build, strict Clippy, and 364 Rust/integration tests. Concurrent edits prevent treating this as certification of a frozen release tree. |
| Production JavaScript audit | No known advisories reported across 88 production dependencies. This does not cover all native/Chromium dependencies. |
| Default live harness, 2-second sweep | Failed after popup return: camera-test locator missing; a discard sweep occurred just before the failure. This is timing sensitivity, not proof of a camera API defect. |
| Same release, 10-second sweep | Passed navigation/text, nonblank screenshot, tracked popup, denied camera/microphone, PDF screenshot, offline recovery, discard/wake, and one renderer-crash/sibling check. YouTube was explicitly skipped. |
| CDP in passing live run | 100 samples; p50 0.421 ms, p95 3.605 ms, maximum 9.333 ms. One local run, not navigation latency or a general responsiveness benchmark. |
| 20-tab memory fixture | Process-tree RSS: baseline 1,448,000 KiB, loaded 4,408,096 KiB, after 19 discards 928,368 KiB. About 4.20 → 0.89 GiB. Artificial allocations and a test-specific process model; not everyday browsing RAM. |
| Memory benchmark completion | Measurements completed, then the process remained alive after `exit requested`; the harness was stopped. Do not report the whole benchmark as passed. |
| Startup harness | Standard run stalled on first launch. A temporary diagnostic version without `--single-process` also failed to finish. Its report had `chrome_paint_ms: null`, so no valid startup percentile is claimed. |
| Startup harness negative control | `DIVE_BIN=/usr/bin/false BENCH_COLD_RUNS=1 BENCH_WARM_RUNS=1` still exited 0 and printed PASS with zero records. Confirmed false-success bug. |
| Signing | Installed app has Developer ID signing; strict/deep signature verification passed. `stapler validate` reported no stapled ticket. This does not prove notarization was never performed; clean-machine installation and update remain unverified. |

Raw logs are retained under [target/audit-20260905](/Users/dvle/Documents/GitHub/dive-browser/target/audit-20260905). Only audit-owned test processes were stopped.

**How the browser fits together**

React 19 and Zustand provide the browser controls. Typed Tauri IPC connects them to Rust. `TabHost` owns CEF page views, separate from the chrome view; this explains the special handling needed for dialogs over page content. `dive-core` keeps tabs, workspaces, profiles, settings, and history in SQLite. Each container supplies a Chromium profile directory. CDP sessions drive automation and developer tools. Separate modules handle privacy, permissions, recordings, subtitles, housekeeping, and recovery. The agent and loopback MCP server reuse browser capabilities.

Useful existing safeguards include SQLite WAL and migration backups, main-thread checks for native view operations, documented lock ordering, CDP call timeouts, bounded event collections, rollback for several optimistic UI actions, lazy optional panels, focus traps, reduced-motion handling, and authenticated loopback MCP with Origin checks. These are foundations to retain.

**Priority 1: protect ongoing work and make lifecycle behavior reliable**

| Finding | User impact | Improvement and proof required |
| --- | --- | --- |
| Sweep decisions become stale during asynchronous probes. [housekeeping.rs:128](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/housekeeping.rs:128), [store.rs:864](/Users/dvle/Documents/GitHub/dive-browser/crates/dive-core/src/store.rs:864) | A tab activated or pinned after the sweep's initial snapshot can still be discarded. The final database update checks neither its new tier nor activity timestamp. | Revalidate visibility, tier, activity generation, and protected work immediately before closing. Test activation and pinning while a sweep probe is suspended. Source-confirmed race; the live harness failure is not a conclusive reproduction of this particular interleaving. |
| Discard protection is incomplete. [housekeeping.rs:143](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/housekeeping.rs:143) | Current signals cover visible tabs, Dive recordings, agents, local servers, and top-document audio/video. Downloads, inspection, WebRTC/capture, Web Audio, iframe media, and unsaved form work are not represented. Probe failure is treated as silence. | Track explicit native activity and dirty-page state; preserve tabs when protection signals are unknown. Add “Keep this site active” and explain why a tab is protected. Current default is 30 minutes; reconcile it with the previously approved one-hour policy. |
| Session closure does not wake all subscribers. [session.rs:193](/Users/dvle/Documents/GitHub/dive-browser/crates/dive-cdp/src/session.rs:193), [crash.rs:147](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/crash.rs:147) | Watchers retain a session that owns the broadcast sender, then await channel closure. Closing and reopening tabs can leave dormant tasks and retained handles. | Add an explicit cancellation/closed signal for every watcher and body job. Run repeated open/close/discard cycles and verify task counts and memory settle. Ownership issue confirmed in source; retained native-memory magnitude is unmeasured. |
| Benchmark-owned app instances fail to finish shutdown. | The memory probe logged an exit request but stayed alive; startup probes also stalled. Quit/restart/update may share relevant runtime paths, but normal UI Quit was not tested. | Trace CEF shutdown and outstanding views/tasks with an external timeout; test ordinary Quit, update restart, active download, recording, and crash recovery separately. Preserve diagnostics when a deadline expires. |

**Priority 2: correct failure states and permissions**

- **A failed iframe can mark the whole page failed.** [loading.rs:119](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/loading.rs:119) treats every noncancelled failed `Document` request as the main-page failure. Correlate request IDs with the main frame. Verify an unavailable embedded widget leaves the main page usable.
- **A rapid second crash can be mistaken for the first crash.** The same-tab deduplication window is one second, while the first reload starts after 250 ms. A crashing reload can therefore be suppressed and leave a stale “recovering” state. Deduplicate by renderer/recovery generation. [crash.rs:106](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/crash.rs:106)
- **Permission handling can stop after event overload.** `while let Ok(event)` exits on broadcast lag, while the injected permission promise has no timeout. Handle lag explicitly and reject unresolved requests with a recoverable error. [permissions.rs:270](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/permissions.rs:270), [media-guard.js:23](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/inject/media-guard.js:23)
- **Permission approval currently requires another request/reload.** The initial request is denied and the later Allow choice is remembered. For calls and screen sharing, work toward resolving the original request where the runtime permits it; otherwise explain the next action clearly. Offer temporary permissions and scope saved decisions to the intended profile/container. Current storage keys use only origin and permission kind. [permissions.rs:107](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/permissions.rs:107)
- **Keep optional-tool failures local.** The current React error boundary wraps the entire interface. Add boundaries around the developer dock, agent, editors, and extension manager so an optional panel failure does not replace all browser controls. [main.tsx:17](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/main.tsx:17)

**UI: preserve the design, improve hierarchy and consistency**

The checked-in dark screenshot shows a coherent graphite palette, restrained accent, and clear separation of rail, tabs, and page. The opportunity is primarily information hierarchy and control behavior.

1. Make the toolbar customizable. Navigation, address, site controls, bookmarks, and downloads are everyday actions; developer utilities can be pinned or grouped. Keep one obvious route to each feature, with descriptive labels available on first use.
2. Strengthen active-tab and focus states, particularly when many tabs collapse to favicons. Offer a dedicated searchable tab list with workspace labels, recent order, audio state, and sleeping state. The current “All tabs” button opens the broader command palette.
3. Finish responsive overlay behavior. `ToolbarMore` does not call the native-page covering hook or trap focus, although its tray extends into the content area. Because native pages paint above chrome, this is a likely occlusion problem requiring native verification. [Toolbar.tsx:126](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/components/Toolbar.tsx:126)
4. Enforce paired theme tokens. The extension “Load unpacked” button uses `bg-accent text-white`; the default dark accent is near-white. Use `text-accent-ink` and check every theme/state. This source mismatch is confirmed; current pixels were not measured. [Extensions.tsx:45](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/components/Extensions.tsx:45)
5. Add settings search. There are already nine settings sections; searchable labels and synonyms would reduce hunting. Retain density and font controls and validate actual layouts at minimum window size and enlarged UI text.
6. Make core controls comfortable without enlarging every panel. Icon buttons are 28 px, with many 10–11 px captions. Test with users and keyboard/screen-reader navigation. Do not label the whole UI inaccessible based only on size: focus traps, names, and contrast-aware tokens already exist. Use the [W3C contrast criteria](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) for text checks.

**UX: make common actions behave like users expect**

| Journey | Current behavior | Recommended next step |
| --- | --- | --- |
| Enter an address | Toolbar input navigates, while history/bookmark/tab suggestions live in a separate palette. Focus resets the draft to the URL, but rendering still substitutes the shortened display when equal. | Share a suggestion engine between address bar and palette; show the full editable URL on focus; preserve copy behavior; make Escape predictable. [Toolbar.tsx:82](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/components/Toolbar.tsx:82) |
| Understand site security | HTTPS text prefix selects a decorative lock; HTTP gets a search icon. | Clickable site information with connection state, permissions, cookies/data, and clear insecure-HTTP indication. Do not represent URL scheme alone as full connection verification. Chromium's [URL-display guidance](https://github.com/chromium/chromium/blob/main/docs/security/url_display_guidelines/url_display_guidelines.md) supports visible origin and meaningful insecurity indicators. |
| Back/forward | Both buttons are enabled whenever a current tab exists. | Bind availability to real navigation history; consider long-press history menus. [Toolbar.tsx:63](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/components/Toolbar.tsx:63) |
| Download a file | Session-only list capped at 50 entries; started/finished/failed states with folder reveal. | Persist download history, byte progress, cancellation, retry, and interrupted-download recovery. Add pause/resume only where the engine supports it reliably. [downloads.ts:18](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/store/downloads.ts:18) |
| Return to the browser | URL/tab persistence and scroll restoration exist; these do not establish full restoration of page JS/form state or back/forward stacks. | Recovery page after an unclean exit, lazy tab restoration, session export/backup, and explicit tests for split views, detached windows, active profile, and history stacks. |
| Start a new session | Welcome screen describes the product, with animations and feature reel. | First-run setup can teach the product; recurring new-tab use should prioritize search, recent tabs, bookmarks, local servers, and resume-work actions. Keep the tour available on demand. [Welcome.tsx:41](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/components/Welcome.tsx:41) |
| Choose profile/workspace | Profiles and optionally isolated workspaces both affect logins. | Clearly label shared versus separate logins during creation and switching. Explain essentials' scope. Keep permission and data-clear behavior consistent with that model. |

**Performance: reduce work, then measure the actual user paths**

1. **Remove avatar generation from startup.** The fresh main App chunk is 549.00 kB minified (170.49 kB gzip). Source-map attribution contains approximately 443 kB of original DiceBear source; this is not its compressed contribution. Cache/generated SVGs for existing profiles and lazy-load customization can preserve the visuals while shrinking startup work. [profileAvatar.ts:1](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/lib/profileAvatar.ts:1)
2. **Make response-body capture selective and bounded before allocation.** Every completed JSON response starts `Network.getResponseBody`; the full payload arrives before a 64K-character truncation. Add concurrency, byte, and per-tab budgets; fetch larger bodies on demand. Retain inexpensive metadata for the always-available developer workflow. [network.rs:121](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/network.rs:121)
3. **Batch UI telemetry.** Console/network events currently update Zustand individually and copy bounded arrays/maps. Coalesce rendering updates while keeping backend capture accurate; prioritize the visible tab/panel. Benchmark a busy WebSocket page and many background tabs. This is a source-based optimization candidate; no measured CPU saving is claimed. [network.ts:77](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src/store/network.ts:77)
4. **Keep animation optional and idle work near zero.** The old unrestricted-animation diagnosis is stale: character updates are now capped at 15 Hz, the orb respects hidden/reduced-motion states, and the feature reel is deferred. Prefer a quiet returning-user new tab and measure energy/CPU before more animation work.
5. **Benchmark the shipping process model.** Production requests process-per-site with a renderer limit of six; the memory fixture overrides this with process-per-tab. Do not use that fixture to claim production RAM savings or same-site crash isolation. Add same-origin siblings, cross-origin pages, and multiple profiles to the matrix. [startup.rs:348](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/startup.rs:348)
6. **Repair benchmark integrity first.** Fail if expected records, paint markers, or process completion are missing; remove the fake zero defaults; apply an external watchdog; retain stderr. Measure cold/warm launch, first usable controls, tab-switch p95, 1/10/30-tab RSS, idle CPU, and long-session drift against a fixed machine and workload. Setup duration alone is not evidence of zero UI blocking. [benchmark-startup.sh:60](/Users/dvle/Documents/GitHub/dive-browser/scripts/benchmark-startup.sh:60)

**Browser features worth adding or completing, in order**

| Order | Capability | Why it matters |
| --- | --- | --- |
| 1 | Unified omnibox, site information, persistent downloads, audio indicators/mute, safer session recovery | High-frequency daily use; builds confidence before adding specialist features. |
| 2 | Bookmark import/export and a guided migration flow | Makes switching from an existing browser practical. |
| 3 | Proven password-manager integration and passkey/WebAuthn compatibility | Test real authentication workflows and required extension/native-messaging support. Embedded Chromium alone does not prove integration works. Prefer proven integrations before building a password vault. |
| 4 | A complete private-browsing contract | A Chromium incognito container alone is insufficient: DIVE also persists URLs/history in its own database. Define history, sessions, downloads, captures, logs, permissions, and AI data behavior before exposing a private mode. [engine.rs:956](/Users/dvle/Documents/GitHub/dive-browser/apps/desktop/src-tauri/src/engine.rs:956) |
| 5 | An extension compatibility catalogue | Unpacked MV2/MV3 loading already exists and requires restart. Verify a small useful set end to end; the UI explicitly says Web Store installation and Google-only services are unavailable. Avoid implying Chrome parity. |
| 6 | Reader mode, page translation, picture-in-picture/media controls, PDF conveniences | Valuable general-browser capabilities after the daily essentials. Live subtitle translation already exists; full-page translation is a separate feature. |
| 7 | Portable workspace backups, then optional sync | Begin with recoverable local export/import; cross-device sync adds identity, encryption, conflicts, and recovery obligations. |
| 8 | Deeper developer workflows using existing tools | Saved device comparison sets, reproducible bug-report bundles with redaction, and network sessions tied to workspaces. The existing toolkit makes these natural extensions. |

“Add” here means no first-class implementation was found in the reviewed surfaces; it does not mean the underlying engine lacks every related API. Validate before estimating implementation.

**Release and reliability acceptance criteria**

- Keep the existing automated gate, but add targeted scenarios for the identified races and failure paths. A green suite does not exercise these missing cases automatically.
- Require a frozen source/build fingerprint, native runtime version, and artifact hash in release evidence. Verify install, launch, Quit, previous-version update, failed update, restart, and rollback/recovery on a clean machine. Signing, notarization, and updater signatures are separate checks.
- Add bounded overnight soak tests covering tab churn, network loss, suspend/resume, disk pressure, downloads, camera/microphone, media playback, and profile switching. Track memory/task drift and recovery outcomes.
- Verify representative authentication, video/DRM, WebRTC, extension, PDF, and upload workflows. They were not established by the local fixture run. Also avoid claiming Windows/Linux support from the current macOS-only CI/release matrix.
- Update documentation claims to match evidence. For example, the README's “exact” navigation-history restoration and broad privacy guarantees exceed what this audit proved; its fixed test counts already differ from the fresh suite.

Recommended delivery order: lifecycle/data preservation and honest gates → navigation/download/site-control UX → measured performance improvements → migration and compatibility → additional features. This ordering improves confidence in every existing feature as well as the new ones.
