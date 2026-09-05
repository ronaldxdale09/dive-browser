# Read-only native memory diagnostics

Opt-in DIVE_STRESS_HEAP_METRICS collects Runtime.getIsolateId, Runtime.getHeapUsage and Memory.getDOMCounters from existing tab CDP sessions. Shared isolates are sampled once. Every sample is bounded by a10-second overall deadline and requires numeric, nonnegative metrics. Missing data fails; the harness requires ordered loaded/swept/settled records. The diagnostic requires an explicit test profile and mock keychain. No extra views, garbage collection, pressure, purge or shipping process-model changes are introduced. The normal30-percent RSS gate and workload remain unchanged.

Sources: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage (isolate-wide heap, not per Runtime); https://chromedevtools.github.io/devtools-protocol/tot/Memory/#method-getDOMCounters.

Three focused Rust tests cover exact read-only method sequence/shared-isolate deduplication, invalid metrics and closed/missing sessions. Full workspace Rust437 and Python16 pass, strict Clippy and source review pass. Frontend source unchanged in this slice.

Native binary7d78efac3be32ecdb87febc4f62cf7d502b6c03231d1a1046bbb9a2d0a8a41bd, eight local same-site tabs,10-second initial settle. Evidence target/memory-probe-1788587734185702000, /tmp/dive-heap-native.log. Native close registry, exact persisted-URL wake, normal exit and helper drain passed. RSS reclamation FAILS at0.1 percent of growth against unchanged30 percent target.

One shared isolate was reported throughout. Loaded/swept/settled DOM counters remained10 documents,80,195 nodes and228 JS listeners. Backing storage268,452,810→268,452,844→268,452,844 bytes; embedder heap221,538,168→221,664,792→221,664,792 bytes. This establishes that page-associated DOM/backing storage remains during this observation window; it does not distinguish delayed collection from retained references, prove a leak, or explain total process RSS. This run must not be presented as an optimization or a passing memory gate.

The same binary separately passed four supported lifecycle/history/IPC/permission-cache cycles2.60/1.99/2.04/2.01seconds plus incomplete-startup exit1 (target/lifecycle-probes-1788587789614189000). The hidden permission WebUI crash diagnostic was not enabled. Memory root cause, longer-run tab churn/energy and release qualification remain open.


## Native closure corroboration, 2026-09-05

The actual automatic-discard path is housekeeping.rs, not just TabHost::close: it directly requests CloseBrowser(true), waits for native Browser::is_valid() to become false, then unregisters the old Tauri label. An initial read-only review missed that path. The new diagnostic corroborates the existing native safeguard; it does not fix a registry-only discard bug.

Added debug-only numeric native close stages (request, do_close, host removal return, OnBeforeClose, runtime retirement with live-browser/native-child counts). The memory harness enables the log target only with its optional heap diagnostic. Target.getTargets now records bounded IDs/types while excluding titles/URLs; it shares the existing ten-second overall diagnostic deadline. No GC, pressure, renderer-model or workload change. The diagnostic-mode harness additionally requires unique before-close then retirement receipts before swept heap sampling, enough page targets removed, and an unchanged nonempty final page set. This is aggregate corroboration, not a direct mapping from target IDs to webview IDs.

Source: https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-getTargets. Pinned CEF 2384915b7b1f0fe5ad1107e48d80c34e86b698d7 macOS native view deallocation calls WindowDestroyed, which completes Alloy browser destruction; no additional force-close call was indicated or introduced.

Exact binary4b109f921c410594ff36a7508e9abea1701e993a7c22b14b363668aa28cdb9df (local ad hoc test bundle) completed target/memory-probe-1788592465701919000: eight tabs, seven native retirements07:14:54.50–54.83UTC, swept sample07:14:59.88UTC, native children/live browsers9→2, page targets9→2→2. Normal persisted-URL wake/exit/helper drain passed. CUA observed the rendered eight-tab fixture without changing it. RSS795200→1534800→1029552KiB,68.31% of growth reclaimed, passing30%. This run used accessibility observation and is not a controlled before/after optimization comparison. The shared isolate still reported11documents/80200nodes and~256MiB backing storage through settling. Native closure completed despite those heap counters; no surviving-WebContents or leak conclusion follows.

A ten-tab run target/memory-probe-1788592703467737000 also passed56.25%, but overlapped root Rust/Clippy verification during early phases and is recorded as diagnostic only. A separate run without concurrent root compilation is required for the performance table.

Validation: four focused Rust diagnostics tests; workspace library tests438pass; strict Clippy pass; nine Python memory-harness tests pass, independently repeated by reviewer. Source review clear. Frontend unchanged. Earlier0.1% and26.2% failures remain relevant; no consistency or production-ready claim.


Separate same-binary runs with no concurrent root compilation:

| Workload | Baseline / loaded / swept RSS KiB | Reclaim | Result / evidence |
| --- | --- | --- | --- |
| 10 tabs, 9 discards | 786560 / 1490400 / 1333600 | 22.28% | FAIL30%; target/memory-probe-1788592771526310000 |
| 30 tabs, 29 discards | 780624 / 2298384 / 1108800 | 78.38% | PASS; target/memory-probe-1788592853490650000 |

Both completed native closure/target corroboration, URL wake, natural exit and helper drain. Thirty-tab page targets31→2→2; DOM32documents/300701nodes→17/170391→1/10023; backing storage1006663974→604003612→33578234bytes. This demonstrates that normal collection can release discarded-document storage after completed native teardown; it is inconsistent with claiming these specific objects permanently leak. Ten-tab counters remained high during the observation window. Repeatable reclaim, realistic multi-origin/long-session workloads and CPU/energy remain open; no threshold was lowered and no collection was forced.

Same4b109f92 bundle passed four supported native permission/history/IPC/tab/window checks2.20/1.87/2.15/1.84seconds plus incomplete-startup exit1; target/lifecycle-probes-1788592962644556000. No keychain prompts or real profile use.
