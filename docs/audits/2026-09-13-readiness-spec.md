# DIVE readiness target

The objective is to improve DIVE from the earlier qualitative 6/10 assessment to an evidence-backed 8/10 in stability, reliability, and production readiness. A score is an engineering judgment, not a measured probability of failure. Missing Windows evidence, failed media checks, or a short soak cannot qualify the target.

## Required outcomes

1. Native CEF browser creation does not synchronously wait or pump a nested CEF loop on the application UI thread. Pending creation has explicit ownership, cancellation, failure delivery, and shutdown accounting. Browser data, permissions, initialization scripts, private context isolation, reparenting and renderer recovery remain correct.
2. The automated YouTube check exercises actual trusted input and proves sustained playback of the intended video. Diagnose click targeting, player state and document replacement before changing the assertion. Local media fixtures cover the causal regression independently of the external service. Do not skip or weaken the failing check to obtain a pass.
3. Native macOS and Windows verification covers dialogs, popups, dropdowns, rounded corners and transparent corner hit testing, keyboard dismissal, nested transitions, busy renderers, new tabs, detached windows, close/reopen, and renderer recovery. Record screenshots and outcomes against identified binaries. Windows build-only CI is insufficient.
4. Bounded local crash/hang diagnostics detect sustained UI-thread unresponsiveness, record recovery and duration, and avoid false positives for machine suspend. Do not upload telemetry or collect page URLs, text, credentials or private browsing content. A stalled UI must not stall the observer; only one pending heartbeat is permitted.
5. Run at least two continuous hours of mixed local workload on each platform after the final relevant code changes. Include repeated create/close, navigation, background/discard/wake, telemetry load, rendering and periodic recovery. Record elapsed time, operation counts, failures, process tree RSS, UI heartbeat latency, and owned process cleanup. Fail on unexpected app exit, unrecovered hangs, corrupted persistent state, or failed operations. Investigate sustained memory growth against repeated equivalent quiescent checkpoints.
6. Pass `pnpm check`, exact-binary native resilience tests including YouTube, platform builds, and focused regression tests. Final documentation maps every requirement to authoritative evidence, identifies skipped/ignored checks and remaining limitations, and assigns a rating only after those results exist.

## Provisional performance acceptance budgets

These are project acceptance targets selected before changes, not industry standards: native creation admission must return without awaiting CEF callbacks; no unresponsive UI interval of two seconds or longer during ordinary creation/churn; UI heartbeat p95 at most 100 ms under the defined local workload, with suspend and intentional fault injection reported separately. Measure at least 100 creation operations. Timing budgets do not exempt functional failures.

## Execution boundaries

Worktree: `/Users/dvle/Documents/GitHub/dive-browser-readiness`, branch `dale/readiness-8`, base `15395813720f152733da4eed55b5c1407cfd5b8b`. Use disposable test profiles and mock keychains; preserve installed browsers and unrelated worktrees. Keep sandbox, privacy protection, GPU settings and discard policy intact. Build optimized native bundles for final tests. Earlier release evidence is a baseline only.

## Initial evidence

- The clean source at the base still calls `browser_host_create_browser_sync`, `wait_for_deferred_init`, and a blocking receive in `vendor/tauri-runtime-cef/src/webview.rs`.
- `scripts/live-check.sh` clicks `.ytp-play-button` unconditionally after muting; this control can represent Pause or be hidden while a large Play button is visible.
- A local Windows 11 Parallels VM exists and was suspended at inventory time. Its usable build and desktop state must be checked before relying on it.
- Existing panic reports and daily logs are present; the opt-in UI diagnostic watchdog is not production hang monitoring.
