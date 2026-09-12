# Nonblocking native CEF browser creation

Read-only source investigation, 2026-09-13. No production edits, builds, or native verification performed. Paths below are relative to this checkout. Recommendations are architectural proposals, not verified runtime behavior.

## Finding and recommended contract

Use CEF's asynchronous `browser_host_create_browser`, driven by the normal external message pump, and represent creation explicitly in runtime state. Make the synchronous Tauri build result mean **creation admitted and dispatcher registered**, then expose native readiness/failure separately. A pending dispatcher must handle commands before the browser exists. This contract change must be documented and reflected in application cleanup; it is not a drop-in substitution of the CEF function.

The alternative is adding asynchronous APIs through vendored Tauri and rewriting all engine creation callers into continuations. Simply moving existing `add_child` to a worker does not solve this: Tauri schedules its work onto the main thread, and the runtime still synchronously waits there. The pending-dispatcher approach has a smaller application footprint, provided every synchronous response-bearing message is audited.

Current blocking chain:

- `webview.rs:1374`, `create_webview_detached`, sends `CreateWebview` and waits on `result_rx.recv()`.
- `runtime.rs:265`, `send_message`, executes inline on the main thread when its dispatch slot is active. `runtime.rs:297` explains why Tauri's own `Window::add_child` requires this inline behavior.
- `runtime.rs:675` immediately sends the result of synchronous `create_webview`.
- `webview.rs:709` installs a request-context continuation; `:734` calls `browser_host_create_browser_sync`; `:841` pumps/sleeps until initialized; `:852` waits for browser delivery.
- `cef_impl/request_context.rs:164` defines a 15-second deadline, but `wait_for_deferred_init` enters a nested CEF pump plus 1 ms sleeps on UI. It is not ordinary winit event processing and retains the surrounding engine call stack/locks. The synchronous CEF call itself can exceed the deadline because the loop cannot interrupt its callback.

Installed primary API evidence: `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cef-dll-sys-151.1.0+151.3.12/src/bindings/x86_64_pc_windows_msvc.rs:9015` documents that asynchronous creation copies its arguments, creates the native window on UI, may be invoked on any browser-process thread, and does not block. The wrapper is `cef-151.1.0+151.3.12/src/bindings/x86_64_pc_windows_msvc.rs:57546`. This removes waiting from the caller; CEF still performs actual native creation on UI, so responsiveness must be measured, not assumed to become perfect.

Current-lock verification by root: the active build uses `cef 151.8.1+151.3.24`, not the older installed binding mentioned above. Its `aarch64_apple_darwin.rs:57534` wrapper exposes the same asynchronous function; `cef-dll-sys 151.8.1+151.3.24` at lines 25894–25902 explicitly documents copied arguments, UI-thread native creation, and nonblocking submission. The architectural recommendation therefore matches the locked dependency.

## Runtime state and completion flow

1. Allocate process-unique webview ID and reserve a pending record owned by the runtime. Keep owner window ID, immutable creation parent, lifecycle state, request-context ownership, prepared scripts/protocols, permission/context-menu/dialog/shortcut bridges, listener and CDP handler collections, desired geometry/visibility/theme, deferred messages, and a readiness/failure signal. Track a generation/token as well if IDs can ever be reused; current unique IDs are preferable.
2. Validate parent existence, closing/exiting state and request attributes synchronously. Register native windows before starting their initial child. Reply to the existing result channel only after admission is committed. No UI `recv` may depend on later CEF progress.
3. Create a request context and retain it in the pending record. Preserve custom-scheme registration and proxy setup from `request_context_from_webview_attributes` (`cef_impl/request_context.rs:351`). Use `on_request_context_initialized` to enqueue a typed `RequestContextReady` message via sender/proxy, never inline `context.send_message` from a CEF callback.
4. On that runtime message, recheck cancellation/closing, initialize the permission lease and apply the latest theme on CEF UI. Refuse creation on permission initialization failure. Build fresh window information from the still-live native parent, then call asynchronous CEF creation with the inert initial document. A rejected submission resolves failure; an accepted submission remains outstanding until its callback is handled, including after cancellation/timeouts.
5. Extend the shared client and life-span handler state (`cef_impl/client/mod.rs:122`, `life_span.rs:62`) with a one-shot creation token. `on_after_created` clones the browser into `BrowserCreated(id, browser)` and wakes the event loop. Handler factories can be called repeatedly, so one-shot ownership must live in shared client state rather than a newly allocated handler-local option. Do not attach children or call back into runtime inline from CEF.
6. On completion, construct `AppWebview`, register scheme entries by actual browser ID, install its DevTools observer, and atomically transfer pending ownership into the live child. Apply current bounds, visibility, accessibility, and z-order. Drain initialization operations before initial navigation. If canceled, register enough live bookkeeping for `do_close` to find and destroy the child host, then close immediately without real navigation. Resolve readiness once; retain close accounting until acknowledgement.
7. Arm deadline messages keyed by creation ID rather than sleeping or nested pumping. Deadline expires caller readiness and cancels future navigation, but is not proof that an accepted CEF creation no longer exists. A late browser must be adopted and drained safely.

Suggested states: `WaitingForContext -> SubmittedToCef -> Attached`; cancellation/failure states must distinguish whether CEF accepted creation. Maintain explicit pending creation records and live browser identity sets; avoid independent counters that can drift.

## Pending dispatcher semantics: critical deadlock audit

`WebviewMessage` is enumerated in `webview.rs:266`. Do not just enqueue every message: getters and registration APIs synchronously await answers.

- `OnDevToolsProtocol`: register the handler in pending-owned shared storage and acknowledge immediately. `CefWebviewDispatcher::on_dev_tools_protocol` blocks at `webview.rs:1370`, and engine `attach_cdp` calls it on main (`engine.rs:1620`, `:1696`). Queuing its acknowledgement until browser-ready recreates the freeze/deadlock.
- `AddEventListener`: install immediately. Keep collection ownership intact across pending-to-live transition.
- `Hide`, `Show`, bounds/position/size, auto-resize, zoom, background: update desired state immediately. Geometry getters can return explicitly defined pending logical state; browser-only getters must fail immediately with a documented not-ready error instead of waiting on UI. Audit Tauri caller expectations before choosing each behavior.
- `WithWebview`: defer callback execution until native ready and preserve order. It currently routes as owner-specific work (`webview.rs:348`), unlike CDP/browser-owned operations. Failure must release captured resources; offer an explicit readiness Result for callers needing observable completion.
- `SendDevToolsMessage`: bounded ordered buffering is possible; registration precedes sending, and pending failure must close the CDP session rather than letting commands time out invisibly. Its dispatch method already returns enqueue acceptance (`webview.rs:1348`).
- `Navigate`, script calls, cookies and other browser operations: preserve ordering and response completion; every response channel must receive a result or be dropped on cancellation. Never silently keep a synchronous UI getter queued behind readiness.
- `Close`: cancel pending creation immediately even while exiting. Current `handle_webview_message` returns early on `state.exiting` (`webview.rs:873`), so lifecycle cancellation must be processed before that guard.
- `Reparent`: recommended initial policy is explicit immediate not-ready failure while pending, then application continuation once ready. If supporting pending reparent, distinguish immutable CEF parent (after submission) from desired owner, pin both windows, and perform the actual native move on completion before success acknowledgement. Simply rewriting window ID before CEF uses its captured parent handle is unsafe.

Preserve `webview_routing::resolve_owner` rules (`webview.rs:879`): browser-owned work follows unique ID after reparent; stale geometry/focus must not apply in the new window. Extend lookup to pending records rather than falling through and dropping their commands.

## Lifecycle races that must be resolved

**Close before context initialization:** mark canceled, suppress submission in the later callback, release cancellable continuation captures, finish readiness with failure. A context handler/holder cycle currently exists until callback delivery (`request_context.rs:389` onward); provide explicit cleanup ownership for failure/abandonment rather than retaining captured clients forever.

**Close after CEF submission, before callback:** parent NSView/HWND must remain alive. On arrival, count/register the browser and close it through normal host destruction. On macOS and Windows `do_close` returns 1 and posts `DestroyWebviewHostWindow` (`life_span.rs:150`); discarding the browser directly leaves no runtime child to destroy. Preserve exactly-once `request_close` and `destroy_host_window_once` (`webview.rs:409`, `:421`).

**Window close/shutdown:** `close_window` tests only `children.is_empty()` (`runtime.rs:948`), while `exit_if_done` tests only `live_browsers` (`:1064`). Both must include outstanding accepted creation, and `close_all_browsers` must cancel pending records. A window with no attached children but pending create cannot be dropped. Current final acknowledgement grace is already a best-effort fallback, not evidence all CEF objects are closed; do not reuse it as permission to drop accepted creation parents. An unresolved accepted create should remain retained while normal pumping continues; report/debug the failure separately.

**Duplicate/late lifecycle events:** `retire_browser` currently decrements `live_browsers` even if it did not find a child (`runtime.rs:929`). Fix identity-based exactly-once retirement before introducing additional completion/timeout events. A late close for a canceled or failed browser must not retire an unrelated live count.

**Initial chrome/window:** `window.rs:509` builds the initial child before inserting native window/maps, relying on synchronous failure rollback. Insert first and track ownership of initial-child creation; asynchronous failure needs explicit window destruction and Tauri registry notification. Empty windows intentionally created before `add_child` must not be auto-closed during the gap. Keep startup exit decisions aware of pending window initialization.

**Incognito context sharing:** `INCOGNITO_CONTEXTS` stores weak owners only after synchronous completion (`webview.rs:818`, `:855`). Concurrent pending tabs would miss each other and create separate in-memory sessions. Publish a weak reference immediately when the context is created and hold its strong owner in pending state; transfer that same owner to live state. Registering the same data-directory grouping must be serialized without holding the global registry mutex across CEF callbacks. Preserve empty cache path for incognito, distinct keys for separate containers, and last-owner cleanup.

**Permissions and first navigation:** preserve `PermissionBridge::initialize_context` before CEF submission. `ContextLease::acquire` checks CEF UI, detects shared contexts and only resets native permissions on the first lease (`permission_context.rs:209`); do not move it onto a worker. Engine pages deliberately build blank, then await feeds, privacy, permission and preference setup before navigating (`engine.rs:597`, `:775`). Creation completion must not navigate directly to a user's real page. Chrome permission handlers (`permissions.rs:184`) must execute before trusted chrome first navigation.

**Initial scripts and blank recovery:** keep scheme registry insertion and DevTools observer installation before `load_initial_url_after_registering_initialization_scripts` (`webview.rs:2036`). `life_span.rs:21` currently runs an independent delayed blank reload to the original URL; it can bypass a slow script/permission readiness gate or navigate after cancellation. Remove that independent reload or bind it to the same readiness/cancellation token; recovery must not issue an alternate ungated load.

**Layout, focus, stacking:** preserve Windows Alloy runtime style (`webview.rs:668`) and deterministic child admission order, not callback completion order. Current `raise_to_top` + `children.push` orders siblings by creation; async completions can reverse it. Re-read scale, parent size and desired visibility at attachment. Reapply latest macOS accessibility state (`webview.rs:557`) and native shortcut routing only against ready actual windows.

## Application call sites

- Page creation: `apps/desktop/src-tauri/src/engine.rs:697`, `TabHost` child creation. It hides immediately, attaches CDP synchronously, schedules permission/privacy setup and then navigation. Ensure pending hide prevents flashing; carry tab/activity identity through readiness and cancel stale work after close/replacement. Async native failure must remove/mark the matching tab view and close its CDP session.
- Main window: `engine.rs:2043`, native `build` at `:2104`, chrome `add_child` at `:2122`, permission attachment at `:2138`. Startup must retain its window and finish chrome configuration before navigation. Do not create a main-thread readiness wait in setup.
- Popout: `engine.rs:1256` creates a guarded native window; `:1268` creates chrome; `:1299` attaches permission; `:1302` reparents the page; then the scope guard is disarmed. With admission semantics chrome failure can happen after the guard is disarmed: add asynchronous rollback restoring the page or safely closing only the failed destination. A pending page must await readiness before reparent under the recommended policy.
- MainThread token (`engine.rs:345`) and host mutex assumptions must remain; resume continuation work on main rather than moving the whole TabHost operation into a worker.

## Required regression evidence

1. Inject delayed request-context initialization and delayed `on_after_created`; main-window input/resize and existing-tab navigation remain responsive during new page/new-window creation on macOS and Windows.
2. Close pending tab before context ready, after submit, at callback delivery, and after attachment; duplicate close and late timeout/callback events; no orphan host, navigation, scheme entries or count drift.
3. Close last parent and quit with pending create; parent native handle remains valid until safe cancellation/close acknowledgement; pending failure does not prevent ordinary subsequent creation.
4. Synchronous failure admission, request-context failure, permission-reset failure, CEF rejection, timeout and late success all produce observable failure and release application/CDP resources exactly once.
5. Cold-profile initial chrome starts, IPC/document-start scripts work, initial page/network events are captured, and no real navigation precedes permission/privacy gates even beyond the old one-second blank reload threshold.
6. Two simultaneous incognito tabs with same key share session storage/cookies as expected; different keys isolate; last close erases session; failed/canceled first pending creation does not strand or split a surviving peer.
7. New Window/popout and move-back under delayed completion; stale queued browser work follows ID; stale geometry/focus stays rejected; destination close cannot steal a pending child; failed chrome rolls back safely.
8. Pending `OnDevToolsProtocol`, getters, `WithWebview`, hide/show, resize, zoom, listeners and CDP sends never block the UI; cancellation releases callbacks and closes sessions.
9. Out-of-order completion preserves Windows overlay stacking, Alloy parenting, current DPI/bounds; macOS visibility, accessibility and Cmd+T/address shortcuts operate on actual ready/reparented native views.

Unit tests should target a CEF-independent pending lifecycle reducer and response disposition rules, then exact-binary native scenarios validate actual platform behavior. Source inspection alone cannot establish responsiveness, host destruction or permission ordering.
