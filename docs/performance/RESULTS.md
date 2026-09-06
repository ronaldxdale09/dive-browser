# DIVE performance: verified development candidate

2026-09-07 · `dale/performance-goal` · **Optimization stopped at the user's request: DIVE does not yet outperform Chrome and Brave overall.**

The sandbox-enabled app passed repository, Fetch and native checks. A new rotating-order batch completed three fresh-profile runs per browser with persistent CDP sessions and explicit viewport assertions. DIVE uses **30.5% less ten-tab RAM than Brave**, but loses one-tab memory, visible reload readiness and startup. These are measurements of a local workload, not universal browsing claims.

| Metric (median) | DIVE | Chrome for Testing | Brave |
| --- | ---: | ---: | ---: |
| RAM, one local tab | 383.2 MB | 538.7 MB | **355.2 MB** |
| RAM, ten local tabs | **1006.5 MB** | 1607.3 MB | 1448.0 MB |
| Reload: loadEventEnd | 79.7 ms | **11.2 ms** | 13.5 ms |
| Reload: visible double-rAF readiness | 101.6 ms | **65.6 ms** | 85.0 ms |
| Direct launch → visible page | 0.760 s | 0.650 s | **0.510 s** |
| Complete installed bundle | **371.0 MB** | 371.7 MB | 468.5 MB |

Brave leads one-tab RAM by 28.0 MB, visible reload readiness by 16.6 ms, and startup by 250 ms. The workload completes the same rows and retained allocations in all browsers. No flags disable permissions, accessibility, privacy capabilities, sandboxing or developer feeds for these measurements.

## Method and correction

- Apple M5, Mac17,2, 24 GiB, macOS 27.0 build 26A5416b; native arm64 graphical builds.
- DIVE 0.1.13 / CEF 151.3.24, Chromium 151.0.7922.174; Chrome for Testing 152.0.7977.82; Brave 152.1.94.121. This is not headless Chrome or another Chrome release.
- Fresh private profiles, rotating browser order, default features. DIVE's tracker blocking defaults off; privacy-enabled behavior is checked separately. No forced collection or experimental flag override in scored runs.
- Each page retains 32 MiB and 5,000 DOM rows. Ten tabs share one local origin. Memory sums macOS physical footprint for the whole owned process tree, including UI and helpers; it is not RSS. Decimal MB.
- One-tab phase settles eight seconds; ten-tab phase ten seconds; five samples per phase. Persistent CDP sessions preserve 1280×720 / DPR 1. Assertions check one-tab dimensions, every reload and all ten tabs.
- Ten reloads per run. Both loadEventEnd and post-load visible double-requestAnimationFrame readiness are retained; each reload finishes the latter before another starts. The second animation frame is a rendering-readiness proxy, not physical display scan-out measurement. Reported values are medians within runs, then across runs.
- Startup is process spawn to document load, visible native viewport at least 400×300, then two animation frames and a host receipt. OS caches and unrelated host activity are uncontrolled. Initial native geometry differs with browser chrome and is recorded.
- **Earlier matrix superseded:** short-lived CDP calls did not reliably preserve dimensions. A new assertion caught Chrome reverting to native 1280×677 after disconnection. Earlier load-only pacing also allowed the next reload before visible readiness. Historical results and failures remain in the investigation history; they must not be pooled with this method or used as final matched-viewport marketing claims. Original-source control must be rerun with this method before fresh before/after improvement percentages are claimed.
- Native traces expose different placement of expensive OS permission-status work in Chromium 151 and 152. LoadEventEnd alone does not represent completion of all browser or rendering work. No permission checks were removed.
- Mixed-site workloads, extended browsing, battery life and final broad responsiveness qualification remain outstanding. Earlier Speedometer runs do not qualify this exact candidate.

Run ranges (all samples retained):

| Metric | DIVE | Chrome | Brave |
| --- | ---: | ---: | ---: |
| One-tab MB | 379.0–383.4 | 537.0–542.5 | 354.0–356.4 |
| Ten-tab MB | 1002.2–1009.1 | 1588.6–2089.0 | 1445.5–1449.8 |
| Load event ms | 76.5–80.5 | 11.1–11.2 | 13.2–13.6 |
| Visible readiness ms | 101.5–108.7 | 64.3–66.3 | 84.8–85.2 |
| Startup ms | 681.9–989.5 | 649.6–691.4 | 508.9–530.4 |

## Latest controlled foreground comparison

After the user made the Mac available, all twelve launches completed: three fresh profiles each for the qualified CEF151 build, the experimental CEF152 bundle, Chrome for Testing and Brave. Method `4-appkit-foreground-visible-reload` uses the same AppKit-only foreground precondition for every browser and checks exact owned PID, active/hidden state and page visibility. It does not invoke Accessibility APIs. All successful and failed prior batches remain separate; these results are not pooled with method2 above.

| Median | DIVE CEF151 | DIVE CEF152 experimental | Chrome for Testing | Brave |
| --- | ---: | ---: | ---: | ---: |
| One-tab memory | 363.65 MB | 357.29 MB | 542.80 MB | 351.35 MB |
| Ten-tab memory | 1014.41 MB | 1009.20 MB | 1611.23 MB | 1488.02 MB |
| Reload load event | 177.95 ms | 95.85 ms | 24.35 ms | 31.35 ms |
| Reload visible double-rAF | 201.60 ms | 118.15 ms | 96.55 ms | 113.90 ms |
| Launch to visible page | 952.82 ms | 854.73 ms | 700.94 ms | 546.57 ms |

CEF151 uses 31.8% less ten-tab memory than Brave and 37.0% less than Chrome in this specific workload. CEF152 remains experimental and is excluded from the merge/release source. No overall performance win is established. Raw results, ranges and receipts: `target/performance-goal/quiet-runtime-matrix/` and `quiet-runtime-summary.json`. The source startup-subscription change was made after these exact binaries were built; this table does not measure that additional change.

The final startup-subscription experiment passed unit and repository gates but a fresh custom-avatar lifecycle check observed worker startup 0.4 ms before first contentful paint. With further optimization stopped by the user, that experiment and its console/network retry changes were reverted. The merged application source retains the previously qualified implementation; no speedup is claimed for the rejected startup experiment.

## Implemented changes

- Delay welcome artwork until session restoration confirms there is no active tab.
- Use V8's existing idle reducer sooner and stop retaining an unused spare renderer. Preserve site isolation and developer feeds.
- Skip Document interception when no enabled workspace rule needs it; preserve applicable filtering.
- Make embedded production UI source maps opt-in with `DIVE_UI_SOURCEMAPS=1`.
- Poll detached video only while filled, deduplicate media tracking with weak membership, and coalesce activity invalidations until the next synchronous snapshot. Input after a snapshot still invalidates immediately.
- Initialize native pages with usable window-derived bounds rather than 1×1.
- Protect pages throughout MCP operations, including waits and cancellation; retry only known transient navigation errors.
- Resolve the initial App/Popout module through a cancellable async loader, preserving code splitting and the recovery boundary.
- Bundle exact existing default DiceBear artwork; custom values retain worker generation and persistence.
- Parse quoted diagnostic Chromium flags through the already-used open-source `shlex` dependency. This fixes profiling configuration, not production performance by itself.
- Explicitly enable the pinned CEF runtime's native sandbox feature. macOS Seatbelt queries returned false for both renderers before the change and true afterward. The live gate now checks every owned renderer. Earlier report wording that the original build had sandboxing enabled was incorrect; IPC/origin permissions and process sandboxing are separate properties.

## Validation and evidence

`pnpm check` passed: **909 frontend, 527 Rust, 30 Python tests**, formatting, typecheck, lint, Vite build and strict Clippy; one frontend skip and six Rust ignores. Exact-binary Fetch and full native checks passed, covering permission denial, PDF, offline recovery, sustained YouTube playback, tool protection, discard/wake, renderer crash isolation, four lifecycle cycles, and bundled/warm/custom-cold/custom-warm avatars. CDP p95: **0.218 ms**, 100 samples.

The old YouTube probe could pass after only 0.2 seconds of playback even if the video then paused. Both sandboxed and unsandboxed diagnostics exhibited that behavior. The stronger probe clicks the visible Play control and requires more than 1.5 seconds advancement with playback still running. Failed earlier runs remain recorded.

Computer use verified local animated video, form input, YouTube playback through 16 seconds, fill mode, Escape restoration and normal Quit on the sandboxed build. Background AX/screenshots sometimes show blank content until the window is raised; focus/occlusion behavior remains an investigation item. macOS is the verified platform; other platforms and production keychain continuity are not qualified by these disposable-profile checks.

- Candidate: `target/performance-goal/sandbox/Dive.app`
- Main binary SHA-256: `ad7db95d46abb3bc5af424539ed883d24a68b4116d03483583f26d13a74fa94f`
- Base: `ec39bb275b735bf442fdef002f6be70d025c3969` plus the uncommitted performance patch.
- Current raw runs: `target/performance-goal/visible-reload-persistent-matrix/`; summary: `visible-reload-persistent-summary.json`. Method: `2-visible-reload-persistent-cdp`. Historical superseded batches: `sandbox-matrix/`, `control-visible/`.
- Gate logs: `sandbox-check.log`, `sandbox-fetch.log`, `sandbox-live.log` under `target/performance-goal/`.
- Lifecycle evidence: `target/lifecycle-probes-1788708603970419000/`.
- Sandbox before/after receipts: `target/performance-goal/sandbox-before/` and `sandbox-after/`.
- Reproduce with `scripts/browser-comparison.mjs`, explicit exact browser binaries, `BENCH_RUNS=3`, and a fresh `BENCH_OUTPUT`. Metadata fingerprints the harness, helper, main binaries, fixture, host and configuration. Frameworks are version-identified rather than fully content-hashed.

Work remains uncommitted, uninstalled and unreleased. See [upstream references](upstream-references.md) and the [investigation history](2026-09-06-goal.md). Allocator, bridge-filter and extra message-pump experiments were not retained. The working source and restored default local release bundle use the qualified sandbox implementation; experimental bundles under target remain unqualified.

## Current runtime investigation

An isolated CEF152.0.5 / Chromium152.0.7977.54 bundle passed the expanded native and Fetch gates, but remains experimental. Repeated comparison failures showed a complete document with both the page and chrome hidden. Live native window Raise restored the original navigation and its missing frame receipt; DevTools focus alone did not. This demonstrates a window-visibility dependency, without yet explaining every failure.

An Accessibility-based foreground diagnostic is a separate workload: its Chrome/Brave memory results were substantially higher than earlier runs, and that incomplete batch is not a default-browser score. An AppKit-only helper now validates the exact owned executable and requires the target PID to be foreground; a new diagnostic is checking that approach. Do not replace the verified table above with partial or rescued samples.

A separate 8 ms CEF fallback timer trial showed no visible reload advantage and increased measured idle CPU in completed samples; it was rejected. CPU counters were calibrated against getrusage and now include the Apple Silicon Mach timebase conversion. Working vendor source and default local bundles remain restored to the qualified implementation.
