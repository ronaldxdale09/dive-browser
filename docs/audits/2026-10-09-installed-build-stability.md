# Installed build stability audit — 2026-10-09

Scope: the installed macOS Dive app, its October 3–8 logs, login forms,
native overlays, request recovery, tab lifecycle, and memory reclamation.
Existing startup telemetry work in the checkout was preserved.
Its public timeline helper needed a generic `BuildHasher` parameter to pass
the repository's existing Clippy rules. Four stale MCP integration tests
also sent browser `Origin` headers while expecting native-client success;
their native requests now omit that header, and the browser-origin rejection
test explicitly covers localhost. The production HTTP security policy was
unchanged.

## Original installed build

- `/Applications/Dive.app`, version `0.1.31`, Developer ID team `F67DX3M6QJ`.
- Signature timestamp: September 20, 2026, 18:49:45 local time.
- Executable SHA-256: `23a4de66c3d7539aac01c7f263c8a172b3ec9cad58c07c01f0fb77e5779380fc`.
- The installed executable does not contain the current native-autofill
  preference code. That fix entered the repository on September 27 in
  `1d75fced`. Sampled installed Chromium profile preference files also lack
  explicit disabled autofill preferences. Matching version labels therefore
  do not establish matching code.

## Findings and changes

| Finding | Evidence | Change |
| --- | --- | --- |
| Two suggestion lists can remain open on one login field | Reproduced with real injected scripts: history answers first, then saved accounts; both username/password and email/password forms, either script installation order | Account suggestions dismiss history, cancel its debounce, and invalidate replies already in flight |
| Repeated login reports replace the save token and emit the same card again | Host regression tests; old implementation fails duplicate-report and cross-tab ownership cases | Keep the existing answerable token for identical reports; replace only that tab's superseded prompt; preserve prompts belonging to other tabs/profiles |
| Unanswered and superseded prompts retain passwords in host memory | Old pruning ran only on a new submission or an answer, and kept superseded usernames | One pending secret per tab; periodic expiration after the existing 10-minute limit, normally within the next 60-second sweep |
| Closing an interactive dialog while a passive card remains leaves native keyboard focus in chrome | Focus-transition regression fails against the previous behavior | Return focus to the active page for the interactive-to-passive transition |
| Closed dialog masks can remain indefinitely when chrome animation frames pause | Native diagnostic: window visible/focused, chrome document `visibilityState=hidden`, dialog DOM removed but native focus/mask stale; paused-frame regressions fail before the fix | Flush DOM-driven mask changes in a microtask when hidden; use a bounded frame deadline when visible; cancel fallback work on teardown |
| Equal-sized nested overlay surfaces both disappear from the native input mask | Geometry regression returned no regions for identical dialog/menu bounds | Keep one representative surface; still exclude strictly contained duplicate regions |
| A late intercepted-request reply can trigger an unnecessary native stop | Two October 8 recovery warnings: fallback reports `Invalid state for continueInterceptedRequest`, then Dive stops loading | Treat that exact Chromium error as an already-resolved interception, including fallback replies; retain stop behavior for genuinely unresolved failures |
| The installed build can run Chromium's autocomplete alongside Dive's UI | Installed identity and missing preference code; repository already contains corrected preference writes | Rebuild from the current runtime so Chromium autocomplete is disabled through initialized request-context preferences |

The request-recovery interpretation follows Chromium's
[interceptor implementation](https://chromium.googlesource.com/chromium/src/+/lkgr/content/browser/devtools/devtools_url_loader_interceptor.cc):
the exact error indicates that the request is no longer waiting for resolution.
Chromium's [autofill preferences](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/autofill/core/common/autofill_prefs.cc)
also tie generic autocomplete to the profile-autofill preference.

## Log review

| Log date | Lines | WARN | ERROR | Protocol overflows | Request-recovery stops | Memory-pressure notices | Renderer crashes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| October 3 | 18,827 | 153 | 23 | 1 | 0 | 0 | 0 |
| October 4 | 4,835 | 45 | 13 | 0 | 0 | 0 | 0 |
| October 5 | 1,138 | 6 | 0 | 0 | 0 | 0 | 0 |
| October 6 | 5,007 | 44 | 1 | 1 | 0 | 0 | 0 |
| October 7 | 8,125 | 40 | 3 | 1 | 0 | 0 | 0 |
| October 8 | 4,282 | 4 | 0 | 0 | 2 | 0 | 0 |

Most warnings/errors concern failed automation selectors, tool timeouts,
or channel shutdown, rather than independently confirmed browser bugs.
Three genuine protocol ingress overflows terminated tab protocol sessions.
The historical logs do not establish which message or workload exhausted
the existing 4,096-message / 64-MiB budget. This cause remains unresolved;
raising that budget without evidence would undermine memory protection.
URLs, account names, passwords, and raw user browsing logs are omitted here.

## Installed memory baseline

The exact installed binary passed a disposable-profile 12-tab loopback
workload with native heap/renderer retirement evidence enabled:

- Baseline process-tree RSS: 645,616 KiB.
- Loaded RSS: 1,167,952 KiB.
- RSS after discarding 11 background tabs: 835,184 KiB.
- Reclaimed: 332,768 KiB (325 MiB), 63.71% of workload growth.
- Completed normally in 44.21 seconds; no custom process-model overrides.

This verifies short-run tab discard and memory reclamation. It does not
establish the absence of leaks during hours of arbitrary browsing.

An intermediate rebuilt candidate also passed the same 12-tab workload:
741,600-KiB baseline, 1,442,976-KiB loaded, 814,080-KiB after discarding 11
tabs; 628,896 KiB (614 MiB), or 89.67% of growth, reclaimed in 43.62 seconds.
Its higher baseline/loaded RSS means these single runs should not be used
to claim a proportional reduction in browser memory consumption.

The final installed binary passed: 731,216-KiB baseline, 1,471,216-KiB
loaded, 487,872-KiB after discarding 11 tabs; 983,344 KiB (960 MiB)
reclaimed in 43.30 seconds. The swept sample was below the startup baseline;
its reported 132.88% of growth is a property of these samples, not a claim
of a greater-than-complete workload reduction. Native close/retirement and
heap target evidence corroborated discarding, and the application exited
normally. No process-model overrides were used.

## Validation and delivery

The final optimized build was signed with the existing Developer ID identity:
`F67DX3M6QJ`. Executable SHA-256:
`254e37c0573bed65f12ce33f56e55a8fab0ae887ba4102f4ee92c1b9a45fd28e`.
The existing public updater key is compiled in; updater archive generation
was not requested. This local build was not notarized or published.

The refreshed MCP integration suite passed all 60 tests with performance
assertions enabled. Its 32-client / 320-call loopback workload measured
2.03-ms median and 3.10-ms p95; this measures HTTP against the fake browser,
not native CEF page latency.

`pnpm check` passed: 65 Python probe tests, 2,005 frontend tests (one existing
skip), all workspace tests, and 82 runtime tests. The desktop Rust suite
passed 760 tests with six existing ignored tests. Type checking, lint,
formatting, Clippy with warnings denied, and the production frontend build
also passed. The focused credential/overlay regression run passed 38 tests.

The exact installed binary passed `scripts/live-check.sh`: every owned
renderer sandboxed, popup becomes a real tab, PDF rendering, offline recovery,
trusted local media playback, in-flight tool protection, discard/wake,
isolated renderer crash with sibling/control identity preserved, history and
cross-workspace reattachment, and four normal quit/window-close runs
(3.82–4.38 seconds). In-process CDP measured 100 samples: 0.104-ms median,
0.204-ms p95, and 0.537-ms maximum. YouTube was explicitly skipped; camera
and microphone checks require existing OS consent and were skipped.

Native UI interaction on the installed build, using a disposable profile
and synthetic login data, showed one saved-account chooser on both username
and email fields, one save card after repeated submission, and working page
clicks and typing while the card remained. Opening and closing a JavaScript
alert above that card restored page input. The diagnostic confirmed chrome
did not retain keyboard focus after dismissal. The hidden-document and
paused-frame cases also have automated regressions.

Some local native-probe stderr still reports Chromium's macOS process
requirement error `-67030`. Disk signature verification passed, and macOS
dynamic verification independently passed for all five sampled running
processes after normal launch, including the browser and helpers. This
warning's cause remains unverified; no security checks were weakened.

The signed app is installed at `/Applications/Dive.app` and reopened through
LaunchServices in the normal user profile, with no test-profile, mock-keychain,
UI-probe, or stress environment variables. The profile database passed
`quick_check`; the current and backup counts match: 342 saved credentials,
10 tabs, one profile, and six workspaces. Only aggregate counts were inspected.
The previous app, a consistent database backup, and the complete profile are
preserved at:

`/Users/dvle/Library/Application Support/Dive Backups/20261009-005433-stability`.

Local evidence files are under `target/issue-audit/`; they are generated and
are not committed. Final lifecycle evidence is in
`target/lifecycle-probes-1791480271315993000/`; final memory evidence is in
`target/memory-probe-1791480295535463000/`. Source changes preserve the
preexisting startup changes, including renderer boot timing and benchmark
budgets. The subsequent release preparation also updates `rustls` from
0.23.43 to the patched 0.23.45 for
[RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285).
The initial local binary fingerprint above predates that dependency update;
release artifacts require their own exact-binary verification.

Cross-platform installers, a published updater release, and long-running
real-site memory soak coverage are outside this local macOS qualification.
