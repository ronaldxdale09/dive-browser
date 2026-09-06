# Memory reclaim process attribution

Memory harness now retains sorted PID/parent/RSS/role samples for the disposable process tree only. Command arguments are used transiently to identify known Chromium roles and are not persisted. Run metadata including exact binary fingerprint is written before launch so failed measurements remain attributable. Metric formula, shipping process model, threshold and native workload are unchanged.

Two process-tree/privacy regressions and three existing complete/failure/hang harness regressions passed: `/tmp/dive-memory-process-green.log`.

Exact native126e9c7322a0d16eee3580c4d33bc838406c70e5ea402c286b6007eeeebb290c, 8same-site tabs,10s settling,30% threshold: native workload closed7tabs, registry/wake verified, app exited naturally/helpers drained; memory gate FAILED at26.2% of resident growth reclaimed. Evidence `target/memory-probe-1788564761164084000` and `/tmp/dive-memory-process-native.log`.

At representative baseline/loaded/swept snapshots the process-tree RSS was774928/1485840/1299392KiB. Largest newly appeared renderer PID40562 decreased667056→500976KiB; browser233936→239712KiB; chrome renderer203600→205712KiB. This identifies retained renderer memory as the primary next investigation, but does not distinguish reachable JS, V8/Blink allocator retention or caches. Other snapshot roles are retained in rss-samples.jsonl. No causal speedup/reclaim claim against earlier runs: source versions and sampling differed. The30%gate stays unchanged and Task7 remains open.
