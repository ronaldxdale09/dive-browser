# Production audit and improvement mission for Dive

Use this as the prompt for a long-running session (`/auto-pilot` or `/loop`) on the Dive browser at this repository. It asks for a complete audit first, then fixes in order of user impact, with verification gates after every change. Nothing is marked done without evidence.

---

You are working on Dive, a developer browser: Tauri v2 on the CEF branch (Chromium 151), Rust workspace (`crates/dive-core`, `dive-cdp`, `dive-mcp`, `dive-agent`, app crate in `apps/desktop/src-tauri`), React 19 + TypeScript + Zustand + Tailwind 4 frontend in `apps/desktop/src`. Read `RELEASING.md`, `docs/PLAN.md` and the memory notes before touching anything. The goal is a browser where every feature, dialog, panel, process and background job is production ready: no crash, no hang, no dead control, no silent failure, no unreadable state, and no visible jank.

## Ground rules

1. **Evidence over claims.** A feature is "done" only when a test, a script, or a live check proves it. Say plainly what you could not verify.
2. **Never break the running app.** Another session may be editing this tree and running the user's app. Do not run `tauri dev`, do not `pkill` anything named Dive, and do not use bare `cargo fmt` (use `rustfmt --edition 2024 <your files>`). Verify against a private instance: copy `target/debug/bundle/macos/Dive.app` to your scratchpad as `Probe.app`, keep the executable named `dive-desktop`, drop in a fresh `target/debug/dive-desktop`, and launch with `DIVE_DATA_DIR=<tmp> DIVE_MCP_PORT=<free port> DIVE_WINDOW_HIDDEN=1`. Drive it with `scripts/mcp-call.py`.
3. **Gates after every change**, all green before you move on: `cargo fmt --all -- --check` (your files), `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, and `git diff --exit-code -- apps/desktop/src/generated` after the Rust tests regenerate bindings. Then `scripts/live-check.sh` and `scripts/benchmark-memory.sh` against the Probe bundle.
4. **Under CEF, Tauri IPC commands run on worker threads.** Anything that creates, shows or moves a native view goes through `on_main` in `commands.rs`. Lock order is host, then store; never hold a lock across an await.
5. **A CEF browser-process crash is symbolised, not guessed at.** Pull the `release_symbols` for the exact build from `cef-builds.spotifycdn.com/index.json`, take `imageOffset` values from the `.ips` report, and resolve them with `lldb --batch ... image lookup -a`. Look for Chrome-UI assumptions reachable from a feature that is on by default and disable that feature in `startup::DISABLED_FEATURES`.
6. **Commit per phase** with explicit file paths, a message that states what changed and how it was verified, and push to the current branch. Never commit another session's half-finished files without saying so.
7. Small, reversible steps. If a change needs a schema migration, append to `MIGRATIONS` and pin its checksum in the append-only test.

## Phase A: inventory (read only, produce a table)

Walk every surface and write one row per item with: name, entry point (file:line), how a user reaches it, current state (works / partial / broken / missing), and the evidence you used.

- **Chrome surfaces:** Rail, TabStrip (essentials, pinned, today, sleeping, detached, drag), Toolbar (omnibox, back/forward, reload/stop, bookmark, share, capture, devtools, device, agent), FeatureBar, Dock and every panel in it (Console, Network with frames and replay, Storage, A11y, Meta, Vitals, Rules, dev servers), Sidecar and the agent Thread and Setup, Palette, Library, Settings (every section and control), Shortcuts, Welcome, Splash, Annotator, RecorderModal, ReplayEditor, SharePopover, DownloadsMenu, ProtectionMenu, WorkspaceDialog, WorkspaceChip, SplitView, Popout windows, DeviceStage simulator, DiveScreen recorder, permission and crash banners, the navigation error page, toasts.
- **Engine processes:** tab lifecycle (open, activate, discard, wake, close, detach, attach), session restore, housekeeping sweep and its keep rules, crash recovery, downloads, permissions, per-site zoom, window bounds, dev server discovery, screencast and screen recording, the MCP server and every tool, the agent runner and every tool, keychain access, updater, logging, panic hook, database migrations and backups.
- **Cross-cutting:** keyboard shortcuts and native menu parity, focus management and Escape in every overlay, reduced motion, contrast, dark and light theme, narrow window behaviour at 720 px, empty states, loading states, error states, offline behaviour, first run, quit and relaunch.

For each row also record the three questions a user would ask: does it do what the label says, what happens when it fails, and can I get out of it with the keyboard.

## Phase B: analysis

From the inventory, list defects and gaps grouped as: crashes and hangs; data loss or silent failure; dead or misleading controls; missing states (loading, empty, error); accessibility and keyboard; performance (re-render storms, unbounded lists, main-thread work, memory growth, startup time); consistency (naming, spacing, icon and colour tokens, copy tone); platform gaps (Windows and Linux `cfg` sites, signing, updater). Rank by user impact times frequency. Cite file:line for each. Do not include generic advice; every item must be something you observed in this codebase or the running Probe instance.

## Phase C: improve, in ranked order

Work the list top down. For each item:

1. Write the failing test or the live-check step first when possible.
2. Make the smallest change that fixes the behaviour, matching the existing patterns (pure reducers in stores, `on_main` hops, `useCoversContent` for anything drawn over the page, `useFocusTrap` and `useFadeClose` for dialogs, `motion-reduce:` variants, persisted UI state in `store/layout.ts`).
3. Run the gates. Run the live check when the engine or a tab lifecycle path changed. Run the memory harness when discard, sweep or view lifecycle changed.
4. Record the before and after in the commit message.

Specific outcomes expected by the end of Phase C, each with its proof:

- Every dialog and menu: opens with focus inside, cycles with Tab, closes on Escape, restores focus, covers the page correctly, fades under normal motion and not under reduced motion. Proof: component tests.
- Every list that can exceed a screen (network, console, history, bookmarks, tabs, palette results) is windowed or capped and re-renders only its own tab's changes. Proof: tests asserting mounted-row counts and referential stability.
- Every async action shows a pending state, a success state and an error state with a retry where retry makes sense. Proof: tests with rejected IPC mocks.
- Every native menu item, palette command and keyboard chord agree with each other and with the cheatsheet. Proof: the existing menu-parity test extended to the palette and chord map.
- Tab switch, workspace switch and omnibox submit are optimistic and roll back on failure. Proof: store tests.
- Startup under 600 ms warm on the benchmark, CDP p95 under 5 ms in the live check, 20-tab discard reclaims at least 30 percent of growth in the memory harness, no `unwrap` or `expect` outside tests in the app crate.
- Zero clippy warnings, zero TypeScript or ESLint warnings, every test green, bindings committed.
- YouTube video playback, a page that opens a popup, a page that requests camera, a PDF link, a `localhost` dev server, an offline navigation and a renderer kill all behave and are covered by `scripts/live-check.sh`.

## Phase D: report

Finish with a short report: the inventory table, the ranked defect list with each item marked fixed / deferred (with reason), the final gate output, live-check and harness numbers, and the exact commits. Update the plan artifact if one exists. Stop only when every item is fixed or explicitly deferred with a reason the user can act on.
