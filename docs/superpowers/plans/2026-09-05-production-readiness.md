# Production-readiness implementation

Spec: docs/browser-review-2026-09-05.md, approved by the user's active goal.
Base: ee821fe. Workspace: /Users/dvle/.codex/worktrees/dive-production/dive-browser.

## Global constraints
Preserve every existing browser/developer/media capability. Use the pinned CEF API; do not invent freeze, permission, download, or extension APIs. Protect unrelated work in the original checkout. No production-profile testing, no uploaded private data. All completion claims require fresh matching evidence. Do not mark the overall goal done while any requirement below is open. Security-sensitive services and production publication require concrete reviewable artifacts and appropriate authorization. Local implementation and tests are authorized.

Ruling: use a separate worktree outside the source checkout to preserve concurrent main-branch work without modifying its ignore rules. Cost: final integration must reconcile any later main changes.

## Task 1: CDP subscriber lifetime and overload recovery
Own crates/dive-cdp/src/session.rs, apps/desktop/src-tauri/src/cdp_feed.rs, crash.rs, permissions.rs, and inject/media-guard.js plus directly related tests. Ensure session.close wakes existing and future event receivers, preserves pending-call cancellation, and rejects late events. Prefer an event receiver abstraction whose recv returns Closed on explicit session closure so all current consumers benefit without duplicated cancellation loops. Test closure while receiver waits, closure before subscribe, repeat closure, and pending RPC cleanup. Permission consumers must continue after Lagged and exit on Closed; injected permission requests must settle on deadline and release pending entries. Fix crash dedup so a distinct crash following a recovery attempt is not dropped by time-only dedup; retain duplicate-signal suppression and bounded retries. Add behavior regression tests and run cargo test -p dive-cdp plus focused desktop permission/crash tests and injected-script Vitest tests. Do not edit engine/lib/startup/housekeeping/store/network in this task. Commit owned changes and report results for review.

## Task 2: trustworthy benchmarks and native shutdown
Own scripts/benchmark-startup.sh, scripts/benchmark-memory.sh, new benchmark helpers/tests, startup instrumentation, and native shutdown integration. First reproduce false PASS using /usr/bin/false and missing paint with a controlled fixture. Require the requested number of finite complete records, actual first-paint and usable-control markers, nonzero exit on missing/invalid records, per-process external timeout, retained stderr, and safe cleanup. Use the shipping process model, never --single-process. Diagnose native exit from recorded exit request through CEF browser-close callbacks; implement a real lifecycle fix and test Quit/restart with fresh profiles. Do not mask app shutdown failure by treating watchdog kills as success.

## Task 3: atomic safe tab discard
Recheck candidate tier/activity/visibility and protected work at final commit. Set the approved one-hour default. Track downloads, inspection, native media/capture, WebRTC/WebAudio and dirty forms; unknown probes preserve tabs. Provide keep-site-active controls and explain protection. Test pin/activate during a suspended probe, protected activities, failed probe, discard/wake and existing scroll restoration.

## Task 4: navigation and permissions correctness
Correlate main-frame failures by request ID, expose actual navigation history, site connection information, profile-scoped temporary/persistent permissions, resolve original requests where supported, and contain optional-panel failures. Verify iframe failures, rapid navigation, denial/allow/retry, container separation and renderer recovery.

## Task 5: everyday browser chrome
Shared address/palette suggestion engine; full editable URL, correct copy/Escape, Back/Forward availability/history, site information panel, dedicated all-tabs search, audio/mute and sleeping indicators, customizable toolbar, reliable compact overlays, theme token pairing, settings search, readable/focusable controls, clear profile/workspace identity. Verify minimum/normal/large sizes, keyboard and screen reader, theme/density, native overlay coverage.

## Task 6: downloads, recovery and migration
Persistent download records/progress/cancel/retry/interrupted recovery and supported pause/resume. Session recovery after unclean exit, lazy restoration, split/detached/profile/navigation preservation, portable workspace export/import and bookmark import/export with guided migration. Verify interrupted/restarted/malformed/duplicate cases and preserve current data.

## Task 7: measured performance
Move avatar generation off startup without losing saved visuals; bound JSON capture before allocation and concurrency; coalesce frontend telemetry without losing backend data; quiet recurring new tab and optional tour; benchmark 1/10/30 tabs on shipping process model and tab churn. Measure startup, usable controls, tab switching, CPU/energy, RAM/task drift, large responses and busy WebSocket pages.

## Task 8: browser capabilities and privacy
Implement reader mode, full-page translation, picture-in-picture/media controls and PDF conveniences. Complete private browsing across Chromium and DIVE-owned state, logs, permissions and AI context. Build extension compatibility catalogue and prove password-manager/passkey workflows, native messaging where needed. Implement optional sync with encryption/conflict/recovery semantics after reliable portable backups. No compatibility labels without real evidence.

## Task 9: developer workflow polish
Saved device comparisons, workspace-associated network sessions, reproducible redacted bug reports; verify every existing developer tool, capture editor, recorder, agent, subtitles, privacy and extension action across success/failure/cancel/restart states.

## Task 10: release qualification
Full automated gates, adversarial/regression suites, representative real websites (auth, DRM/media, WebRTC, uploads/PDF/extensions), bounded overnight soak, crash/disk/network/suspend tests, dependency/runtime patch review, frozen build fingerprint, clean-machine signed/notarized install and previous-version updater recovery. Verify declared platforms only and update documentation to the actual evidence. Reconcile with main, review, and produce release artifacts only after all preceding requirements pass.
