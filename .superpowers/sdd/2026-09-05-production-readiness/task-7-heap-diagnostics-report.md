# Read-only native memory diagnostics

Opt-in DIVE_STRESS_HEAP_METRICS collects Runtime.getIsolateId, Runtime.getHeapUsage and Memory.getDOMCounters from existing tab CDP sessions. Shared isolates are sampled once. Every sample is bounded by a10-second overall deadline and requires numeric, nonnegative metrics. Missing data fails; the harness requires ordered loaded/swept/settled records. The diagnostic requires an explicit test profile and mock keychain. No extra views, garbage collection, pressure, purge or shipping process-model changes are introduced. The normal30-percent RSS gate and workload remain unchanged.

Sources: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage (isolate-wide heap, not per Runtime); https://chromedevtools.github.io/devtools-protocol/tot/Memory/#method-getDOMCounters.

Three focused Rust tests cover exact read-only method sequence/shared-isolate deduplication, invalid metrics and closed/missing sessions. Full workspace Rust437 and Python16 pass, strict Clippy and source review pass. Frontend source unchanged in this slice.

Native binary7d78efac3be32ecdb87febc4f62cf7d502b6c03231d1a1046bbb9a2d0a8a41bd, eight local same-site tabs,10-second initial settle. Evidence target/memory-probe-1788587734185702000, /tmp/dive-heap-native.log. Native close registry, exact persisted-URL wake, normal exit and helper drain passed. RSS reclamation FAILS at0.1 percent of growth against unchanged30 percent target.

One shared isolate was reported throughout. Loaded/swept/settled DOM counters remained10 documents,80,195 nodes and228 JS listeners. Backing storage268,452,810→268,452,844→268,452,844 bytes; embedder heap221,538,168→221,664,792→221,664,792 bytes. This establishes that page-associated DOM/backing storage remains during this observation window; it does not distinguish delayed collection from retained references, prove a leak, or explain total process RSS. This run must not be presented as an optimization or a passing memory gate.

The same binary separately passed four supported lifecycle/history/IPC/permission-cache cycles2.60/1.99/2.04/2.01seconds plus incomplete-startup exit1 (target/lifecycle-probes-1788587789614189000). The hidden permission WebUI crash diagnostic was not enabled. Memory root cause, longer-run tab churn/energy and release qualification remain open.
