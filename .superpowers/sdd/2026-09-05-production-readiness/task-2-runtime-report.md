# Task 2 runtime and probe implementation

The pinned CEF runtime is vendored with provenance and licenses. Windows and browser children remain registered through asynchronous native close acknowledgement; final window destruction reaches Tauri once, and accepted nonzero exit status survives CEF shutdown. Popout reveal leaves the CEF load callback before requesting synchronous Winit visibility state. General run_on_main_thread semantics stay compatible with upstream synchronous wrappers. The application flushes logging after run_return and propagates failure status.

Startup and memory launchers now reject crashes, incomplete records, deadlines, and leftover helpers; retain evidence; fingerprint the executable; and measure the normal process model. Native lifecycle checks cover close-popout, sibling CDP, detach/reattach, Quit with detached window, main-window close, repeated profile restart, and incomplete startup returning exit1. All disposable launchers use the existing mock keychain, preventing repeated ad hoc tests from requesting Chromium Safe Storage credentials.

## Evidence

- Earlier native close failures exposed lost host bookkeeping, missing Destroyed delivery, ignored exit status, and a popout reveal main-thread deadlock. These are fixed and independently source-reviewed.
- A further timeout stack includes Security SecKeychainItemCopyContent. Setting the supported mock-keychain environment in every disposable launcher resolved this interference without changing normal browser keychain behavior.
- 11 Python process regressions pass (/tmp/dive-probes-keychain-tests.log), including invalid paint/readiness records, hang, crash, retained output, successful measurements, actual mock-keychain launch environments, and helpers remaining after either expected success or expected failure.
- Reviewer found expected exit1 bypassed helper drainage; expected_exit_code now goes through normal drainage. New regression fails before the change, then passes. Native negative startup rerun passes after the correction.
- Exact executable SHA256 e49aa8d505b6bc2ee1f692c2bc050ddd6429b58d0e5799c1af529818e0d27ad6: target/lifecycle-probes-1788553154890627000, four native runs normal exit (0.66–1.04s) plus native incomplete-startup exit1.
- target/startup-probes-1788553019091293000: 3 cold + 5 warm samples plus warmup, all normal exit. Cold median712.37ms, warm median690.62ms, controls-ready p95 839.44ms.
- target/memory-probe-1788553041524586000: 8 real tabs, 7 reported discarded, normal exit; harness correctly FAILS 30% reclaim threshold with 0.0% measured reclaim. Task3 native discard and Task7 memory optimization remain OPEN. No passing memory summary was emitted.

## Limits

This is a local ad hoc bundle. It is not signed/notarized release qualification. Full gate must be rerun after concurrent Task3 integration; final native performance must be rerun against the final executable. Native memory reclaim is an observed unresolved failure, not a benchmark-script success claim. The mock keychain deliberately does not test production keychain encryption/continuity.
