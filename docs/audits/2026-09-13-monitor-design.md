# Local responsiveness monitor design

Read-only investigation for required outcome 4 and Task 4, 2026-09-13. No application source edits, build, UI driving, or commits performed. Proposed behavior below still requires implementation and native evidence.

## Integration points

- Add `apps/desktop/src-tauri/src/responsiveness.rs` with a pure detector, platform clock, bounded writer and owned observer. Declare module in `lib.rs`.
- `lib.rs:388` setup has the first `AppHandle`. Start the observer after `state::init` and before `engine::create_main_window` to include startup UI work. The sender must enqueue from its dedicated OS thread, never from the setup thread. Own its guard in `run()` outside `App`/managed state, e.g. an `Arc<Mutex<Option<MonitorGuard>>>` used only by setup/run lifecycle; do not create an AppHandle-managed-state retention cycle.
- `lib.rs:445` `ExitRequested` can be vetoed during export cleanup. Do not stop monitoring merely on this event. On actual `RunEvent::Exit` signal stop without joining on UI. After `run_return` returns, join the observer before `drop(log_guard)`, `private_session::cleanup()` and `process::exit` (`lib.rs:498`). Also stop/join on build/setup errors. Avoid existing build-error direct `process::exit` bypassing the guard.
- `private_session::is_private()` (`private_session.rs:26`) is process-wide. Check it before deriving a persistence path, creating files, reading historical records or exporting. Private process must use an in-memory bounded sink or a disabled monitor, never even temporary diagnostic persistence. `state::data_root()` redirects private mode to its temporary root (`state.rs:86`); this redirection alone does not satisfy Task 4's no-persistence requirement.
- Existing daily logs use seven rotated files (`lib.rs:596`); panic hook persists arbitrary panic text to `crashes/` and is disabled in private mode (`lib.rs:640`). Preserve both existing behaviors, but keep new fixed-shape monitor data in its own capped files. Do not silently include old logs/panic bodies in a privacy-safe monitor export.
- `commands.rs:3232` `tab_bug_report` is the existing user-triggered report interface. It deliberately includes screenshot, console, requests and URL-derived names, so it is not the monitor's export mechanism. No general privacy-safe diagnostic bundle/export API was found in this scan. Provide a separate bounded reader/export helper (and only add UI/IPC if needed by the parent implementation), with fixed filenames independent of tabs. Recheck private mode at export. Never upload or copy diagnostics automatically.
- `ui_probe.rs:352` is opt-in and requires a disposable mock-keychain profile. It spawns a Tokio-on-OS-thread diagnostic worker and a second unowned 15-second watchdog (`:384-409`). Its heartbeat reflects diagnostic-worker progress, not a dedicated UI acknowledgement. It samples page/UI data, so do not turn it on in production or reuse its records as the monitor. Leave probe semantics intact.

## Clock contract and primary evidence

Inject `Clock::sample() -> { awake_ns, continuous_ns, wall_timestamp }`. Awake time is elapsed system working time, not UI-thread CPU time. Use only awake time for thresholds and durations; wall time is display metadata.

| Platform | Awake clock | Sleep-inclusive companion |
|---|---|---|
| macOS | `mach_absolute_time`, converted with `mach_timebase_info` using checked/u128 math | `mach_continuous_time`, same timebase |
| Windows | `QueryUnbiasedInterruptTimePrecise` | `QueryInterruptTimePrecise` |

Rust explicitly leaves `Instant` suspend accounting unspecified across platforms and versions. It cannot establish this contract. [Rust Instant documentation](https://doc.rust-lang.org/std/time/struct.Instant.html)

Apple's published Mach header distinguishes continuous time as advancing during sleep. The same declaration is installed locally at `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/mach/mach_time.h:53-62`. [Apple Mach header](https://github.com/apple/darwin-xnu/blob/main/osfmk/mach/mach_time.h)

Microsoft defines unbiased interrupt time as excluding sleep/hibernation; interrupt time accounts for those states. Both are independent of user/system-clock changes. Precise versions return 100 ns units and support Windows 10 onward. [Interrupt time semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/interrupt-time), [unbiased precise API](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttimeprecise), [interrupt precise API](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryinterrupttimeprecise)

Local `windows-0.61.3` bindings expose both functions in `Windows/Win32/System/WindowsProgramming/mod.rs:752,776`. Add `Win32_System_WindowsProgramming` to the existing Windows dependency feature list if using those wrappers. Avoid assuming `QueryPerformanceCounter` excludes suspend. Use checked conversion of 100 ns ticks; avoid narrowing overflow.

Read the two clocks closely together; use repeated/bracketed readings or a small documented sampling uncertainty for their difference. A significant positive increase in `(continuous - awake)` identifies sleep. Never infer suspend solely from a >N-second observer scheduling gap: real system contention or process suspension also delays the observer. Negative/jumping OS clocks are a distinct `clock_discontinuity`, not a fake recovery or hang. Wall-clock adjustments do not affect the detector.

These APIs describe OS system sleep. A hypervisor pausing a guest can present different clock behavior; verify the actual Parallels Windows guest and host suspend/resume, rather than claiming generic VM-pause detection. Process-wide debugger pauses are also not necessarily system sleep.

## One-outstanding-ack state machine

Use one named `std::thread::Builder` observer, a wakeable stop channel, and one pending `Arc<Ack>` token at a time. Observer owns all detector state and file I/O. UI closure owns only its small acknowledgement token: no AppState, browser handle, host mutex, string formatting, disk, JS, CDP, IPC round trip, or Tokio dependency.

Every one second (no catch-up burst), if no token is outstanding, allocate its monotonically increasing sequence and enqueue a UI closure with `app.run_on_main_thread`. From this dedicated non-main thread, current runtime dispatch queues and wakes rather than executing inline. Enqueue success means pending; enqueue failure records a fixed `dispatch_failed` event and stops or enters a bounded retry policy, never treats it as UI recovery.

Before enqueueing, establish the pending token and send time. The UI callback acknowledges with Release; observer uses Acquire. It must not wait on any monitor mutex. On each observer tick:

1. Sample clocks and check actual suspend/discontinuity before classifying age.
2. If pending age is at least two awake seconds and unacknowledged, emit exactly one `hang_started` record. Continue observing that same token without enqueuing another callback.
3. On acknowledgement emit one `hang_recovered` if this token crossed the threshold; include its awake duration. Clear the pending token only after acknowledgement is consumed, then admit a later sample. A never-recovered hang remains recorded without duplicate `hang_started` every second.
4. On stop, emit `monitor_stopped` (with pending age if useful) and leave any queued closure holding only an inert token. Do not wait for UI acknowledgement and do not enqueue a final callback.

Precise duration needs one design decision: a callback containing only `AtomicBool::store` permits only an interval-censored latency, because observation can be up to one sample late. It cannot support p95 <=100 ms or accurately classify an ack that happened just before two seconds. Recommended minimal callback reads the cheap awake OS clock and publishes an `AtomicU64` timestamp (0 sentinel, encoded nonzero value), optionally with a sequence. This remains a lock-free atomic acknowledgement and adds no application work. If the plan is interpreted as prohibiting even a clock read, store duration bounds and exclude these coarse records from the 100 ms performance assertion; obtain precise soak latency separately. Do not present observer-observation time as exact acknowledgement time.

An ack can arrive after two seconds but before the observer next runs: use its published timestamp to emit the started/recovered pair once, even though the observer never saw it pending beyond threshold. A 1-second send cadence also means a stall beginning between samples may be detected up to roughly one sample plus the threshold later; document this sampling limit.

On confirmed system suspend, retain the single outstanding token. Never clear it and issue another while its old closure is still queued. With an accurate sleep-excluding clock, retain awake age and exclude sleep naturally. A pending healthy UI ack immediately after resume does not accumulate hours of hang duration. A real preexisting hang can remain open across sleep, with recovery duration excluding sleep. For conservative resume grace, mark only the resumed sample contaminated until its existing ack arrives; bound grace so an actually stuck UI after resume still reports. Test this explicitly rather than skipping every late observer tick indefinitely.

## Bounded data and owned shutdown

Proposed record schema contains exactly `timestamp`, `duration_ms`, fixed enum `kind`, and compile-time `app_version`; use `Option<u64>` duration where inapplicable. No dynamically derived reason/message, path, tab/window ID, origin, title, URL, memory dump, screenshot, stack or credentials. Suggested kinds: `monitor_started`, `hang_started`, `hang_recovered`, `suspend_gap`, `clock_discontinuity`, `dispatch_failed`, `monitor_stopped`. A timestamp for display may jump; the monotonic duration must not.

Suggested retention: `responsiveness/current.jsonl` plus `previous.jsonl`, each capped at 256 KiB (maximum 512 KiB total), and maximum serialized line length (e.g. 256 bytes). Rotate before append, fixed filenames, no per-event files. On startup prune/rotate only these owned paths, cap reads, tolerate truncated final JSON line, reject oversized or unexpected records. Keep a separate fixed-size in-memory sample ring only if needed, never unbounded per-second records. Private mode does not touch files at all. On full disk/permissions/write failure, disable persistence with a bounded in-memory status; do not crash, busy-loop or repeatedly log error strings.

`MonitorGuard` owns stop sender and `JoinHandle`. `request_stop()` must wake a one-second `recv_timeout` immediately; `join()` runs after the event loop, not inside UI callbacks. Observer closures must not depend on UI executing to stop. A join ownership test should prove termination with a permanently unacknowledged closure. An OS thread cannot be safely force-killed in Rust: blocking filesystem I/O can still delay its join. Keep disk work small and local; if unconditional bounded shutdown under stalled storage is required, this one-thread writer design cannot guarantee it. Do not hide an abandoned thread behind a fake timeout-success result.

The in-process observer detects UI-only hangs while it is schedulable. It cannot persist a last event after process termination, detect every native crash, or diagnose a completely frozen process/OS. Keep existing panic and renderer crash recovery in place; do not call an unclean previous session a proven crash without external evidence. Root soak process monitoring supplies unexpected-exit evidence.

## Regression matrix

Pure detector/adapter tests with injected clocks and sink:

- Normal ack before, exactly at and after 2000 ms; ack between observer ticks; timestamp publication ordering.
- Sixty seconds permanently stalled UI: exactly one callback enqueued and one start record; recovery emits one duration and resumes sampling.
- Suspend before ack, during hang, repeated sleep, and recover after wake: exclude sleep duration, no duplicated token, no false normal hang; a post-resume stuck UI still reports.
- Observer delayed while system awake: do not classify as suspend. Wall time forward/backward changes must not affect threshold. Clock regression/conversion overflow stays bounded and explicitly classified.
- Stop with pending ack, late callback after stop, repeated stop, failed enqueue, setup failure, vetoed ExitRequested and actual Exit: owned worker terminates with no UI dependency.
- Rotation boundary, corrupted tail, oversized line, full disk, unreadable folder, bounded in-memory retention; exported record key/value allowlist excludes arbitrary strings.
- Private mode produces no directory/files, reads no prior normal diagnostic file and refuses persistence/export even if DIVE_DATA_DIR points at a normal profile.

Native verification on each identified macOS and Windows binary: inject >=3-second main-thread stall in disposable profile, observe start while UI is stalled and recovery after release; verify many concurrent normal operations cause no queue buildup; test actual machine sleep/resume, then final shutdown ownership. Keep fault injection gated to explicit disposable-profile diagnostics. No native result is established by this design report.

## Implemented source and native runner contract

Task 4 implements the design in `apps/desktop/src-tauri/src/responsiveness.rs`, integrated before main-window creation. Source tests and native qualification are separate evidence: this document does not establish Windows execution, native fault recovery, suspend/resume behavior, or a completed soak.

The observer writes `<data-root>/responsiveness/current.jsonl` and `previous.jsonl`, each capped at 262,144 bytes. Normal acknowledgements are persisted as `heartbeat`; a threshold-crossing acknowledgement emits `hang_started` if needed and then `hang_recovered`, with one start per outstanding token. `timestamp` is the observer's Unix milliseconds; `duration_ms` is the ceiling of the exact awake-clock duration in nanoseconds. Each record contains only those two fields, enum `kind`, and the compiled `app_version`. A 256-record in-memory ring survives persistence failure for the lifetime of the worker. Persistence failures disable further writes rather than retrying. Clock failure or discontinuity emits a fixed failure kind and stops monitoring; it must fail qualification rather than count as healthy. `monitor_stopped` is emitted on worker termination. Existing panic and renderer-crash reporting remains separate.

For a two-hour soak, periodically read both capped files in previous/current order and retain suffix/prefix overlap across snapshots; timestamps are not unique IDs, particularly when multiple lifecycle events occur in the same millisecond or wall time changes. Rotation copies the full current file into the fixed previous file before truncating current, so readers can briefly see overlap or a partial previous copy. Retry a snapshot when its suffix is inconsistent. Do not treat raw record count or distinct timestamps as operation count. Retention intentionally does not guarantee that an entire soak fits on disk. The Rust local reader skips incomplete lines, oversized files/lines, unknown keys/kinds and records from a different compiled version; no IPC export or telemetry upload exists.

Compute ordinary acknowledgement latency from `heartbeat` and ordinary `hang_recovered` records. Exclude intentional-fault samples and samples whose outstanding token spans a `suspend_gap`, and report exclusions explicitly. Every ordinary `hang_started` still violates the two-second responsiveness target even if it later recovers. Machine sleep is excluded by the awake clock; OS clock-pair sampling uncertainty is bracketed and included when classifying a sleep gap. Observer scheduling delay while awake is not classified as sleep. One-second sampling permits roughly one additional second before detecting a stall that starts between sends.

Native fault injection requires all of:

- `DIVE_RESPONSIVENESS_DIAGNOSTIC=1`
- `DIVE_DISPOSABLE_PROFILE=1`
- `DIVE_USE_MOCK_KEYCHAIN=1`
- An explicit `DIVE_DATA_DIR` resolving to a strict descendant of the process's OS temporary directory and matching the actual data root.
- A nonprivate process (`DIVE_PRIVATE_SESSION` must not be `1`).

After the diagnostic process starts, create an **empty regular file** at `<profile>/responsiveness/stall.request`. The observer removes it once at the next eligible heartbeat and queues a fixed four-second UI-thread stall. Nonempty files, directories and symbolic links are rejected. There is no request body, arbitrary duration, network endpoint, extra observer thread or unbounded queue. `fault_injected` precedes the detected hang/recovery records, followed by `fault_acknowledged`; these records delimit the intentional fault for the runner. Normal production sessions never inspect this request path, and private processes do not derive diagnostic paths, start the monitor, read history or persist records.

The UI acknowledgement callback performs only a cached OS awake-clock read and atomic publication, except for that explicitly gated fault sleep. Disk work happens after dispatch on the observer, so write latency does not inflate recorded UI latency. The observer is signalled only on actual `RunEvent::Exit` and joined after the event loop, before logger/private cleanup. Setup/build failures drop and join the same guard. A queued callback may outlive the observer safely. Small local filesystem operations can nevertheless block in the OS; this design cannot guarantee a deadline for shutdown under completely stalled storage.
