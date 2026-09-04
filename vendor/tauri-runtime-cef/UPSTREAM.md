# Vendored Tauri CEF runtime

Source: https://github.com/tauri-apps/tauri/tree/713203057982a38d810f64fe0930c9f7670b3a0d/crates/tauri-runtime-cef

Pinned revision: `713203057982a38d810f64fe0930c9f7670b3a0d`.
License: Apache-2.0 OR MIT; both upstream licenses are included.

Manifest adaptation resolves inherited package metadata and the two sibling Tauri dependencies against the same pinned upstream revision. Other sources remain upstream except `src/runtime.rs`.

The runtime patch retains each window and its browser children while CEF closes asynchronously. On macOS and Windows, `do_close` queues destruction of the browser host; removing the window first loses that host lookup and can prevent `on_before_close` from acknowledging shutdown. Window close requests are idempotent, and bookkeeping is released after the final child acknowledges closure. Explicitly closing windows do not solicit another cancellable close request at that point. New windows, children, and reparent operations cannot enter a closing window or an exiting application.

Remove this override only after the upstream replacement passes normal multi-process startup/exit, window-close, and restart checks on the exact shipped bundle. Do not replace graceful exit with forced process termination.

Native follow-up found that removing the native-id mapping swallowed Winit's later `Destroyed` event. Final window teardown now emits that event once to Tauri, releasing its window/webview registries. The runtime also retains an accepted exit code through the event loop and CEF shutdown instead of always returning zero from `run_return`.

DIVE separately defers its popout `reveal` work off CEF's load callback before scheduling Winit work. This avoids synchronous visibility getters while the external CEF message pump owns the main thread. The runtime's general `run_on_main_thread` inline semantics remain upstream-compatible because Tauri's synchronous wrappers depend on them.
