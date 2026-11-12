# Vendored Tauri CEF runtime

Source: https://github.com/tauri-apps/tauri/tree/713203057982a38d810f64fe0930c9f7670b3a0d/crates/tauri-runtime-cef

Pinned revision: `713203057982a38d810f64fe0930c9f7670b3a0d`.
License: Apache-2.0 OR MIT; both upstream licenses are included.

Manifest adaptation resolves inherited package metadata and the two sibling Tauri dependencies against the same pinned upstream revision. The local source changes are described below; other sources remain upstream.

## Inventory

`scripts/vendor-runtime-diff.sh` prints the current patch against the pinned
revision and writes it to `target/vendor-runtime.patch`. The crate is
formatted with upstream's `rustfmt.toml` (copied here) so that patch contains
only real changes; `pnpm test:runtime` checks the formatting.

### Files added by Dive
| File | Purpose | Section below |
|---|---|---|
| `src/cef_impl/client/js_dialog.rs` | JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) handed to the app instead of CEF's process-blocking native modal | [JS dialogs](#js-dialogs-and-page-events) |
| `src/cef_impl/client/page_events.rs` | Page lifecycle, find results, renderer death/hang and certificate errors handed to the application | [JS dialogs](#js-dialogs-and-page-events) |
| `src/cef_impl/client/permission_context.rs` | Chromium 151 native permission cache reconciliation | [Native permission cache reconciliation](#native-permission-cache-reconciliation-and-current-limits) |
| `src/cef_impl/partial_response.rs` | Range responses: CEF asks Skip before headers though protocol responses already contain the range | [Range responses and scheme workers](#range-responses-and-scheme-workers) |
| `src/cef_impl/scheme_workers.rs` | Worker threads that answer custom-scheme requests (was one OS thread per request) | [Range responses and scheme workers](#range-responses-and-scheme-workers) |
| `src/downloads.rs` | Download progress and cancellation (Tauri's `DownloadEvent` only has start/finish) | [Downloads](#downloads) |
| `src/native_deadlines.rs` | Cancellable native-loop deadlines without worker threads | [Deadlines, input trace and creation state](#native-deadlines-input-trace-and-browser-creation-state) |
| `src/native_input_trace.rs` | Opt-in, bounded input timing receipts (never serialises event/key/page data) | [Deadlines, input trace and creation state](#native-deadlines-input-trace-and-browser-creation-state) |
| `src/pending_creation.rs` | CEF-independent browser creation ownership state machine (Admission, ContextReady, Submitted, Attached, Retired) | [Deadlines, input trace and creation state](#native-deadlines-input-trace-and-browser-creation-state) |
| `src/platform/macos/overlay_input.rs` | Lets clicks reach the page through a chrome overlay's `CAShapeLayer` mask | [Overlay input](#overlay-input-macos-and-windows-modal) |
| `src/platform/windows/modal_input.rs` | Windows modal: keeps the page HWND visible, disables its input, forwards clicks to the chrome scrim | [Overlay input](#overlay-input-macos-and-windows-modal) |
| `src/reserved_shortcut.rs` | Reserved New Tab / Address accelerator policy | [Explicit detached-window New Tab route](#explicit-detached-window-new-tab-route) |
| `src/reserved_shortcut_native.rs` | Native owners for those shortcut bindings | [Explicit detached-window New Tab route](#explicit-detached-window-new-tab-route) |
| `src/webview_routing.rs` | Delivery policy for work queued before a browser changes native windows | [Deadlines, input trace and creation state](#native-deadlines-input-trace-and-browser-creation-state) |
| `build.rs` | Selects Common Controls v6 for the standalone Windows unit-test binary (behind `native-test-manifest`) | [Manifest](#manifest) |
| `windows-test.manifest` | The Common Controls v6 application manifest `build.rs` embeds | [Manifest](#manifest) |

### Upstream files Dive modifies
| File | What changed | Section below |
|---|---|---|
| `src/cef_impl/client/context_menu.rs` | Context-menu options and handler: Dive's own command/action set, link/image actions and new-tab dispositions | [Page events](#js-dialogs-and-page-events) |
| `src/cef_impl/client/display.rs` | Display handler ignores callbacks from browsers it does not own | [Page events](#js-dialogs-and-page-events) |
| `src/cef_impl/client/download.rs` | Reports progress, speed and interrupt reasons through `downloads.rs` | [Downloads](#downloads) |
| `src/cef_impl/client/keyboard.rs` | Reserved shortcut dispatch (Cmd+T / Cmd+L) and input trace points | [Explicit detached-window New Tab route](#explicit-detached-window-new-tab-route) |
| `src/cef_impl/client/life_span.rs` | Close acknowledgement, popup routing and permission revocation on closure | [Shutdown and close acks](#vendored-tauri-cef-runtime) |
| `src/cef_impl/client/mod.rs` | Wires the permission, JS dialog, find and page-event handlers into the client | [Native permission enforcement](#native-permission-enforcement) |
| `src/cef_impl/client/permission.rs` | Default-deny per-webview permission bridge replacing unconditional acceptance | [Native permission enforcement](#native-permission-enforcement) |
| `src/cef_impl/ipc.rs` | IPC URL derived from the live native main frame, not the renderer message | [IPC caller provenance](#ipc-caller-provenance) |
| `src/cef_impl/mod.rs` | Declares the `partial_response` module | [Range responses and scheme workers](#range-responses-and-scheme-workers) |
| `src/cef_impl/request_context.rs` | Request context setup: built-in autofill disabled, permission context initialisation | [Native permission cache reconciliation](#native-permission-cache-reconciliation-and-current-limits) |
| `src/cef_impl/request_handler.rs` | Navigation permission revocation, range responses, renderer unresponsive and certificate callbacks, asset scheme, HTML init-script injection through `dom_query` | [Native permission enforcement](#native-permission-enforcement); [HTML init-script injection](#html-init-script-injection) |
| `src/lib.rs` | Declares and re-exports the added modules | [Files added by Dive](#files-added-by-dive) |
| `src/platform/macos/mod.rs` | Declares `overlay_input` | [Overlay input](#overlay-input-macos-and-windows-modal) |
| `src/platform/macos/webview.rs` | Corner radius, chrome overlay mask, reparenting and visibility hooks including the accessibility reapply | [Accessibility](#accessibility-for-browsers-created-after-assistive-clients-attach) |
| `src/platform/windows/mod.rs` | Declares `modal_input`; Common Controls v6 harness test | [Overlay input](#overlay-input-macos-and-windows-modal) |
| `src/platform/windows/webview.rs` | Z-order pinning, chrome modal overlay and overlay mask | [Overlay input](#overlay-input-macos-and-windows-modal) |
| `src/runtime.rs` | Close/exit ordering, `CLOSE_ACK_GRACE`, exit code, native deadlines, accessibility request retention, no `--enable-media-stream` | [Shutdown and close acks](#vendored-tauri-cef-runtime) |
| `src/webview.rs` | Permission and context handles, creation state machine, shortcut bindings, accessibility, `html2::normalize_script_for_csp` import, many Dive webview operations | [Native permission enforcement](#native-permission-enforcement) |
| `src/window.rs` | Raw window handle replies without native access while a window is closing | [Shutdown and close acks](#vendored-tauri-cef-runtime) |

### Manifest
`Cargo.toml` differs from upstream in these ways only: inherited workspace metadata is resolved to literal values; `tauri-runtime` and `tauri-utils` point at the pinned git revision; `winit` is pinned to `=0.31.0-beta.2`; extra `windows` (`Win32_UI_HiDpi`) and `objc2` features (`objc2-core-graphics`, `CAShapeLayer`, `CATransaction`, `objc2-core-foundation`) are enabled; and the `native-test-manifest` feature lets only the standalone unit tests embed `windows-test.manifest` through `build.rs`.

## JS dialogs and page events

`src/cef_impl/client/js_dialog.rs` hands `alert`, `confirm`, `prompt` and `beforeunload` to the application instead of CEF's native modal. A native modal blocks the process's main thread, freezing every window and every automation call; a bridged dialog only pauses the page's script, as in Chrome, while the chrome shows its own card and answers it. `src/cef_impl/client/page_events.rs` delivers page lifecycle (the moment a page agrees to close after `beforeunload`), the engine's find-in-page results, renderer death or hang, and certificate errors. All arrive on CEF's UI thread, so application handlers must hand the work on rather than re-enter the runtime.

## Range responses and scheme workers

`src/cef_impl/partial_response.rs`: CEF asks Skip before response headers, although protocol responses already contain the selected range; this module reconciles the two so range requests are answered correctly. `src/cef_impl/scheme_workers.rs` answers custom-scheme requests (every IPC call and every asset served over the app's scheme) on a small set of kept threads instead of one OS thread per request. A request never waits for a kept thread, because synchronous commands run there and some wait on the main thread or on each other; when all are busy the request gets a thread of its own, as before.

## Downloads

`src/downloads.rs` carries progress and control for a download in flight. Tauri's `DownloadEvent` has only the request and the finish, so a long download reports nothing meanwhile. CEF knows received and total bytes and current speed and offers a callback that cancels, pauses and resumes; none of that fits Tauri's handler, so it flows through this process-global module (CEF has one browser process, one set of downloads and one listening application).

## Native deadlines, input trace and browser creation state

`src/native_deadlines.rs` provides cancellable deadlines for the native loop with no workers, threads or channel tombstones. `src/native_input_trace.rs` records opt-in, bounded timing receipts and never serialises an event, key or page data; `post_key` marks the renderer fallback, not execution of a native menu action. `src/pending_creation.rs` is the CEF-independent creation ownership state machine (Admission, ContextReady, Submitted, Attached, Retired): failure before submission is terminal and releases the parent, failure after submission retains the parent and a late completion is adopted for close only, and a pending reparent is rejected without changing either owner. `src/webview_routing.rs` defines the delivery policy for work queued before a browser changes native windows.

## Overlay input (macOS and Windows modal)

`src/platform/macos/overlay_input.rs`: while a chrome overlay is up, a `CAShapeLayer` mask punches the page rectangles out of the chrome view, but a layer mask clips only painting, so AppKit still hit-tested the chrome across its whole frame and the page went dead. `hitTest:` now returns nil inside a page hole, so the press falls through to the page view, as it does on Windows where the mask is a window region. `src/platform/windows/modal_input.rs`: regions clip painting and hit testing together, so a modal keeps the page HWND visible but disables its input and forwards clicks delivered to the parent through those holes to the trusted chrome scrim.

The runtime patch retains each window and its browser children while CEF closes asynchronously. On macOS and Windows, `do_close` queues destruction of the browser host; removing the window first loses that host lookup and can prevent `on_before_close` from acknowledging shutdown. Window close requests are idempotent, and bookkeeping is released after the final child acknowledges closure. Explicitly closing windows do not solicit another cancellable close request at that point. New windows, children, and reparent operations cannot enter a closing window or an exiting application.

Close requests are idempotent per browser as well as per window. CEF runs `do_close` for every `close_browser` call, and removing a browser's host view a second time while its first close was still in flight left that browser without an `on_before_close` acknowledgement; a popout whose tab was closed and whose window was then destroyed stayed registered forever and blocked exit. `AppWebview::request_close` issues the native close once, `WebviewMessage::Close` is a forced close (the embedder has already forgotten the view, so a page veto would orphan it), and the host view is removed at most once.

The runtime also stops waiting for an acknowledgement that never comes. CEF confirms a close through `on_before_close` only when its host `NSView` deallocates, and a page view that was ever reparented between windows (a tab moved to or from its own window) keeps an extra AppKit reference to that view, so the confirmation never arrives: the window stayed registered with an empty content area and quitting hung. After the host view is removed the runtime waits `CLOSE_ACK_GRACE` (1.5 s), then retires the browser itself, remembers it so a late acknowledgement cannot retire it twice, and lets the window close or the application exit; CEF's own shutdown destroys whatever is left. A window entering its close is hidden immediately so the wait is never visible.

Remove this override only after the upstream replacement passes normal multi-process startup/exit, window-close, and restart checks on the exact shipped bundle. Do not replace graceful exit with forced process termination.

Native follow-up found that removing the native-id mapping swallowed Winit's later `Destroyed` event. Final window teardown now emits that event once to Tauri, releasing its window/webview registries. The runtime also retains an accepted exit code through the event loop and CEF shutdown instead of always returning zero from `run_return`.

DIVE separately defers its popout `reveal` work off CEF's load callback before scheduling Winit work. This avoids synchronous visibility getters while the external CEF message pump owns the main thread. The runtime's general `run_on_main_thread` inline semantics remain upstream-compatible because Tauri's synchronous wrappers depend on them.

## Native permission enforcement

`src/cef_impl/client/permission.rs` replaces unconditional CEF media/prompt acceptance with a default-deny, per-native-webview bridge. `src/webview.rs` exposes `set_permission_handler` on the existing `with_webview` platform handle and carries the bridge into each native browser; `client/mod.rs` shares it with the permission, navigation, and lifecycle handlers. `request_handler.rs` and `client/life_span.rs` revoke requests on native navigation/closure, including same-URL reloads. Frame-specific navigation cancels that frame and any request whose frame is unknown. Main-document navigation cancels all requests.

Evidence is the pinned cef 151.8.1 / cef-dll-sys 151.8.1+151.3.24 generated `cef_permission_handler_t` contract: media requests provide Browser, Frame, requesting_origin, requested_permissions and a retainable MediaAccessCallback; permission prompts provide Browser, prompt_id, requesting_origin and a retainable PermissionPromptCallback but **no frame**. The bridge preserves that distinction instead of fabricating frame identity. Unknown permission bits and invalid/non-HTTP(S) origins are denied in full. Supported media bits cover camera, microphone, and desktop capture; prompt bits cover camera, microphone, geolocation, notifications, and clipboard.

Original callbacks are retained for at most 30 seconds and resolved once on CEF's UI thread. Browser/frame validity, original document URLs, native navigation cancellation and a monotonic deadline guard answers. CEF prompt dismissal forgets the callback without invoking an already-dismissed native request. Without an installed application handler, requests are immediately denied. DIVE additionally checks the exact native view generation, authoritative profile/container scope, opaque pending ID and request liveness before persisting an answer.

`src/runtime.rs` no longer injects `--enable-media-stream`: the pinned CEF API explicitly states that this switch bypasses the media permission callback. Diagnostics cannot reintroduce it, `use-fake-ui-for-media-stream`, or `auto-accept-camera-and-microphone-capture`; those switches are filtered with a warning. Fake media devices remain usable for isolated tests because they do not bypass the permission decision.

The app no longer installs its renderer media wrapper or sends unscoped `Browser.setPermission` overrides. Permission enforcement occurs on the original native request, including iframe origins, with an explicit application-only clipboard policy for trusted chrome. Adapter tests cover permission masks, callback deadlines/duplicates, native dismissal, navigation cancellation and bypass-switch filtering. Real browser permission/OS-device behavior still requires qualification on the exact shipped bundle with an explicitly approved device policy.

## IPC caller provenance

`src/cef_impl/ipc.rs` ignores the URL in renderer process-message arguments and derives it from the valid native main frame. Subframes and invalid/missing native frames cannot inherit their containing webview's IPC identity. DIVE additionally restricts application commands and plugin capabilities to its actual chrome webviews and prevents those views from navigating to web content. Chrome popup links are routed into normal managed page tabs. This preserves the pinned Tauri remote-origin ACL check instead of treating renderer-provided URI metadata as native authority.
## Native permission cache reconciliation and current limits

Pinned CEF `2384915` / Chromium `151.0.7922.174` is the behavioral source, not only the generated API shape. [CEF permission_prompt.cc](https://github.com/chromiumembedded/cef/blob/2384915/libcef/browser/permission_prompt.cc) maps ACCEPT/DENY to Chromium's persistent delegate decisions and explicitly does not expose AcceptThisTime. Consequently page-duration prompt answers are rejected by DIVE; only the direct media callback supports DIVE's page lifetime. Default refusal, cancellation, invalidation, and timeout use DISMISS, while an explicit remembered block uses DENY. UI-thread replies resolve inline so a later Settings reset cannot be overtaken by an already accepted queued answer.

`client/permission_context.rs` initializes each actual shared RequestContext before native browser creation. It clears and verifies only the supported camera, microphone, scalar/structured geolocation, notifications, and clipboard default/exception/partitioned-exception preferences. It also removes only those permission types from legacy embargo data, preserving unrelated kinds and metadata. Failure prevents browser creation. Weak context leases compare `is_sharing_with` and avoid retaining closed browser contexts globally. The platform handle also exposes a weak permission-context handle. DIVE keeps these by authoritative scope independently of live tab sessions, so Settings still resets a context kept alive by a native timeout after its last tab closes; handles are deduplicated and expired entries pruned. DIVE v2 profile/container/origin decisions remain authoritative after migration; old unscoped entries remain stored for audit but never grant. Settings clears the exact native origin/type (including both geolocation formats), verifies ASK, and clears only that type's embargo before changing the DIVE decision.

Mappings come from Chromium's [content settings registry](https://github.com/chromium/chromium/blob/151.0.7922.174/components/content_settings/core/browser/content_settings_registry.cc), [permission settings registry](https://github.com/chromium/chromium/blob/151.0.7922.174/components/content_settings/core/browser/permission_settings_registry.cc), [website preference naming](https://github.com/chromium/chromium/blob/151.0.7922.174/components/content_settings/core/browser/website_settings_info.cc), and [permission embargo reset](https://github.com/chromium/chromium/blob/151.0.7922.174/components/permissions/permission_decision_auto_blocker.cc). Native readback is required because CEF's setting setters return void; setting reset is performed only on initialized UI contexts, where pinned RequestContextImpl dispatches inline.

Prompt callbacks are refused for multi-frame documents or requesting/top-origin mismatch. Direct media callbacks require the exposed frame URL origin to match requesting_origin, guarding CEF's documented implementation fallback to the main frame. **Remaining engine limitations:** CEF does not expose the prompt's original requesting frame, and Chromium can delegate an already remembered top-origin native grant to a subsequently inserted iframe without another prompt. Strict iframe-origin isolation and temporary native-prompt grants therefore remain open engine capability work. These checks do not claim OOPIF provenance or complete native permission qualification. Runtime tests must verify the pinned preference mappings and actual grant/revoke behavior before release.

Native ABI qualification found that cef151.8.1 `CefString::default()` converts to a NULL string-struct pointer. Required mutable error out-parameters now use allocated empty strings; empty embedding URLs are also explicit string structs. Settings cancels pending callbacks before its final native reset/readback because Chromium's synchronous DISMISS may update embargo data. UI dismissal survives a later reset or SQLite failure.


## Explicit detached-window New Tab route

`reserved_shortcut.rs`, `reserved_shortcut_native.rs`, and `webview.rs` extend the reserved macOS Cmd+T route with an opt-in cross-window binding. The ordinary route still requires the same native window. DIVE installs the exception only during a known detach, on the page and its popout chrome, pointing at the main chrome's existing launcher. Bind-time source-anchor validation rejects a delayed callback after page reattachment. Each route holds weak source, anchor, and target owners and snapshots their native window identities and reparent epochs. Dispatch validates current ownership, browser identity/liveness, and all snapshots. Reparent increments the epoch before moving the native view, so moving away and back does not revive an old binding. Window addresses are compared as identities and never dereferenced from stored snapshots.

The key callback uses only the per-view nonblocking binding lookup, weak upgrades, atomics, and live CEF/AppKit UI operations. It submits the fixed `dive-native-new-tab` event directly, then brings the selected main window forward and focuses its CEF chrome within the same native event turn. No renderer-selected target, arbitrary event payload, AppState lock, or webview-registry scan is introduced. Native shortcut/focus behavior remains a separate qualification gate.

Cmd+L has an independent binding and the fixed `dive-native-focus-address` event. Both event names are the constants `NEW_TAB_EVENT` and `FOCUS_ADDRESS_EVENT` in `reserved_shortcut_native.rs`, and the dispatch script is built from them with `format!`; `apps/desktop/src/lib/nativeEvents.test.ts` keeps the chrome's spelling equal to theirs. It always requires matching live native windows and captured reparent epochs; it cannot use the cross-window Cmd+T exception. Main and popout chrome bind to themselves, while each page binds to its current window's chrome. Page creation and reattachment bind the main chrome; detach binds the popout chrome. Exact macOS raw Cmd+L, without Control/Option/Shift, submits the event before focusing that CEF chrome. Missing or stale targets leave normal fallback available. This addresses native input arriving at the page while the asynchronous menu IPC route is still pending; rapid input delivery still requires qualification on the exact application binary.


## Accessibility for browsers created after assistive clients attach

macOS `AccessibilityChanged` previously updated only the browsers present in the runtime registry. New windows and page browsers reverted to CEF's default and had no platform HTML accessibility tree, even while rendered controls were visible. The runtime context now retains the latest optional accessibility request. The shared browser attachment path copies that request after deferred creation and applies it before registration, releasing the mutex before calling CEF. No request preserves CEF defaults; both enabled and explicitly disabled requests propagate to later browsers. Existing-browser updates remain unchanged. This follows CEF's per-browser [SetAccessibilityState contract](https://github.com/chromiumembedded/cef/blob/master/include/cef_browser.h). Native UI run 28 reproduced the missing popout chrome and page tree on the preceding binary; post-change native qualification is recorded in the production-readiness report.

Native runs 29/30 isolated a second issue: CEF's direct accessibility mode is overwritten by Chromium's [OnWebContentsRevealed](https://github.com/chromium/chromium/blob/151.0.7922.174/content/browser/accessibility/browser_accessibility_state_impl.cc#L605), which recomputes the mode from scoped clients. No macOS disable request occurred. A repeated enable request restored the page tree, while reattachment hid/revealed the page and lost it again. Each AppWebview now shares the same optional request and reapplies it after the runtime shows the native view. It does not disable hidden trees or force accessibility when there has been no request. Debug-level tracing uses `dive_native_accessibility` and contains only runtime view IDs and booleans.

## HTML init-script injection

HTML init-script injection uses tauri-utils `html-manipulation-2` (`dom_query`) instead of `html-manipulation` (`kuchikiki`), the parser `tauri-build` already compiles; this drops `kuchikiki`, the second `html5ever` and a second `selectors` from the build. `request_handler.rs` calls `html2::{parse_doc, append_script_to_head, serialize_doc}` (iterating in reverse, since the helper prepends) and `webview.rs` imports `html2::normalize_script_for_csp` (byte-identical to the `html` one). Behaviour is pinned by the `prepend_scripts_to_head` tests in `request_handler.rs`, including byte-exact script text, which the CSP hashes depend on. Upstream still uses `html-manipulation` at the pinned revision; keep this change when rebasing unless upstream has made the same move.

## Rebasing onto a newer upstream

CEF bumps follow the cadence in `RELEASING.md` -> *Updating CEF*.

1. Pick the new tauri revision (the `feat/cef` branch head or a tag) and note
   which `cef` crate version its `crates/tauri-runtime-cef/Cargo.toml` pins.
2. Run `scripts/vendor-runtime-diff.sh` on the current pin and keep
   `target/vendor-runtime.patch`.
3. Update the revision in the root `Cargo.toml` (`[patch.crates-io]` and the
   `tauri-runtime-cef` git dependency in `apps/desktop/src-tauri/Cargo.toml`)
   and in this file, then `cargo fetch`.
4. Replace `src/` with the new upstream `src/`, re-copy upstream's
   `rustfmt.toml`, and apply the saved patch with
   `patch -p<n> --merge < target/vendor-runtime.patch` (from the vendor dir);
   resolve conflicts file by file using the inventory above.
5. Re-apply the manifest adaptations listed under "Manifest".
6. `pnpm test:runtime`, `pnpm check`, then the native qualification checks
   named in the sections above (startup/exit, window close, restart,
   permissions, shortcuts) on the exact bundle before release.
7. Update the inventory tables and the pinned revision at the top.
