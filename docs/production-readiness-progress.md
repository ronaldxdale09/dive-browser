# Production-readiness progress

Goal: implement every recommendation in docs/browser-review-2026-09-05.md and prove existing/new browser capabilities production-ready.
Plan: docs/superpowers/plans/2026-09-05-production-readiness.md
Worktree: /Users/dvle/.codex/worktrees/dive-production/dive-browser
Base: ee821fe

All tasks are OPEN unless evidence below explicitly marks them reviewed and verified. A partial test never closes a whole task.

| Task | State | Evidence required |
| --- | --- | --- |
| 1 CDP lifetime/overload/crash | In progress | behavioral regression tests, review, native churn |
| 2 benchmarks/shutdown | In progress | negative controls reject; real paint; normal exit/restart |
| 3 safe tab discard | In progress | races, every protection, wake/restoration |
| 4 navigation/permissions | Open | iframe/history/connection/origin isolation |
| 5 everyday chrome | Open | real UI at sizes/themes, keyboard and accessibility |
| 6 downloads/recovery/migration | Open | persisted and interrupted workflows, imports/backups |
| 7 performance | Open | reproducible shipping-runtime budgets and soak |
| 8 browser/privacy/compatibility/sync | Open | actual capability workflows and isolation |
| 9 developer tools/media polish | Open | all existing capabilities success/failure/cancel/restart |
| 10 release qualification | Open | full gates, clean install/update, frozen artifacts |

2026-09-05: Isolated worktree created on dale/production-readiness; original main and untracked signing script untouched. Audit report copied as approved requirements. No production-readiness completion claim.

2026-09-05 Task 1: committed 595049a and reviewer correction 2641e61. CDP closure/overload, media deadline, and crash scheduling regressions passed; review closed. Native churn remains pending.

2026-09-05 Task 2: old startup runner falsely accepted a failed launcher; old memory runner ignored the external deadline and hung. New negative controls reject incomplete records, failed processes, and hangs. Rebuilt isolated native runtime changes an observed >8s shutdown hang into graceful exit in 5.53s (target/shutdown-before.log and target/shutdown-after.log). This probe does not establish startup paint or feature correctness; actual telemetry and broader close/reattach/restart checks are in progress. Vendored runtime review found no confirmed regression.

2026-09-05 Task 2 follow-up: native popout close/reattach probe rejected stale Tauri window registrations, and observed requested exit code 1 returning status 0. Final window close now emits Destroyed once after CEF children close; run_return preserves the accepted code and the app flushes logs before exiting. Source review passed; rebuilt native probe is running. Startup telemetry and readiness-cleanup correction e66c536/d589e24 passed 16 Rust and 14 frontend tests; contract cleanup 6a15da1 removes obsolete fabricated evidence.

2026-09-05 Task 2 native verification: a captured shutdown stack proved the ad hoc test was waiting in SecKeychainItemCopyContent. Every disposable test launcher now explicitly uses the existing mock-keychain switch; ordinary browser launches retain system-keychain behavior. Ten Python harness regressions passed, including actual launch-environment checks. Exact binary e49aa8d505b6bc2ee1f692c2bc050ddd6429b58d0e5799c1af529818e0d27ad6 passed four native close/reattach/restart cycles (0.59–1.08s) and incomplete-startup exit-code control; evidence target/lifecycle-probes-1788552968370972000. Eight measured startup launches plus warmup all exited normally: cold median 712.37ms, warm median 690.62ms, controls-ready p95 839.44ms; evidence target/startup-probes-1788553019091293000. These are isolated local measurements, not a signed release qualification. Memory probe and broader verification remain pending.
