# Dive Browser: Architecture and Product Plan

Date: 2026-09-03. Stack: Tauri v2 (Rust) + CEF (Chromium Embedded Framework) + React 19 + Tailwind v4.

Dive is a developer-focused, multi-workspace Chromium browser with a built-in dev toolkit and an AI agent that does more than chat.

## Verified implementation status (2026-09-04)

The original phase plan below is retained as architecture/product history; it is no longer a statement that the repository is unscaffolded. The current production-readiness evidence is maintained in [`docs/production-readiness.md`](production-readiness.md).

- The macOS private Probe passes the expanded lifecycle check: popup, permissions/camera result, PDF, localhost, offline recovery, real YouTube playback, tab discard/wake and renderer recovery.
- Current measured targets pass: CDP p95 `0.419 ms`, warm startup p95 `217.30 ms`, and deterministic 20-tab reclaim `108%` of measured growth.
- Static and automated gates pass: strict Rust formatting/Clippy, 325 Rust tests, monorepo typecheck/lint, and 474 frontend tests in the post-report shared-tree rerun.
- The current release is not signable from this host: updater signing requires CI-held secrets, Windows/Linux live evidence is absent, `cargo-audit` is unavailable, and concurrent recording bindings must be committed atomically before the generated-file check can pass.
- Ownership-gated work remains for optimistic navigation/reorder rollback, Library row windowing and error states, plus a unified reduced-motion-aware close lifecycle for anchored popovers. These are explicit deferrals in the readiness ledger, not shipped claims.

---

## 1. Summary of decisions

| Decision | Choice | Why |
|---|---|---|
| Engine integration | Build on the official `tauri-apps/tauri` `feat/cef` branch (`tauri-runtime-cef`), vendored and pinned via `[patch.crates-io]` | It already provides CEF child webviews, per-webview request contexts, CDP plumbing, reparenting, macOS helper bundling and Windows/Linux bundling. Gluing the `cef` crate onto stock Tauri means owning all of that yourself. |
| Rendering model | "Everything CEF": the React chrome is one Alloy-style CEF webview, each tab is a sibling child CEF view | One engine, one process model, full Chrome DevTools Protocol (CDP) everywhere. Two engines (WKWebView + CEF) doubles memory and gives the worst overlay problems. |
| Overlays | Anything that must draw over page content (omnibox dropdown, command palette, tab previews, agent cursor) renders in a dedicated transparent CEF child or OS popup window | Native child views cannot be painted over by HTML in a sibling. Off-screen rendering (OSR) into wgpu is phase 2 once CEF accelerated paint stabilizes. |
| Workspaces | One `CefRequestContext` with its own `cache_path` per workspace | Native cookie/storage/service-worker isolation. Same mechanism gives the agent its own isolated profile. |
| Extensions | Not supported at launch | CEF removed the Alloy extension API; Chrome extensions only work with Chrome-style windows that show Chrome's own UI. Replace the important ones (ad block, content scripts, React DevTools) with native features. |
| Ad blocking | Brave's `adblock` crate in `CefResourceRequestHandler::OnBeforeResourceLoad` | Rust-native, uBlock syntax, cosmetic filtering. Low effort. |
| AI runtime | Rust core owns CDP tools, MCP client/server (`rmcp`), credentials and the agent loop. LLM calls go over raw HTTP to the Anthropic Messages API (streaming, Claude Opus 5, adaptive thinking), behind a provider trait so OpenAI-compatible and local Ollama endpoints plug in | Keeps keys and tool execution out of the renderer, avoids a 100 MB Node sidecar, and CEF gives direct in-process CDP which is exactly the latency win Browser Use and Stagehand chased. |
| Data | `rusqlite` (bundled, WAL) behind typed Tauri commands, `keyring` for secrets, `tauri-plugin-store` for UI prefs | Simple, fast, no JS-exposed SQL surface. |
| UI stack | React 19, Tailwind v4, Zustand, TanStack Query/Table/Virtual, shadcn/ui, cmdk, react-resizable-panels, dnd-kit, tldraw for annotation | Proven for the exact widgets a browser chrome needs. Vivaldi has shipped a React chrome for a decade. |

---

## 2. Research findings that matter

### Engine feasibility (CEF + Rust + Tauri)
- `cef` crate (tauri-apps/cef-rs) is at 151.8.0 tracking CEF 151 / Chromium 151, releases land within days of upstream. Full auto-generated API coverage; safe layer is young.
- `feat/cef` branch of Tauri (last commit 2026-09-02) adds `tauri-runtime-cef` (winit windows, CEF browsers as native children, `RuntimeStyle { Alloy | Chrome }`, `SendDevToolsMessage` + observer, per-webview `RequestContext`, `Reparent`), `cef-helper`, CLI download and bundling. Not on crates.io yet. OpenHuman ships CEF 146 in production on a vendored fork.
- Known open bugs to verify in the spike: macOS arm64 windowed SIGSEGV (cef-rs #456), transparency black screen (#15718), IPC broken with DevTools open on Linux (#15764), Wayland/NVIDIA GPU-process failures, silent no-framework bundle when the CDN lookup fails (#15287).
- Alloy bootstrap is gone since CEF M128. Everything is Chrome bootstrap with per-browser `runtime_style`. Alloy style gives client-owned windows and custom dialogs; that is what a React chrome needs.
- Spotify CDN builds have no proprietary codecs (no H.264/AAC software decode) and Widevine is effectively gated. Do not promise Netflix. Hardware decode via OS APIs is possible with minor build changes.
- Binary: 115 to 150 MB compressed CEF per platform, 150 to 250 MB installer. Electron-class. No Chromium compile in CI.
- macOS needs four signed helper .app bundles and framework-first signing order for notarization. Windows sandbox mode means your app becomes a cdylib loaded by CEF's `bootstrap.exe`.

### Product patterns worth stealing
- Comet layout: horizontal tab strip, standard toolbar, "Assistant" button at the far right that opens a right-docked Sidecar panel (thread list, conversation, prompt box). Inline assistant on text selection. Sidecar reads the page through `Accessibility.getFullAXTree` serialized to YAML with ref IDs, and shows clicks in headed mode with pause/cancel.
- Arc/Zen/Sidekick all converged on three tab tiers: Essentials (global), Pinned (per workspace), Today (auto-archive after ~12h). Workspaces carry color, icon and a default container. Removing the command bar (Dia) was the loudest user complaint, so keep Cmd+K/Cmd+T fuzzy across tabs, history and actions.
- Zen split view (up to 4, drag-to-split, horizontal/vertical/grid) and Glance (modal link preview) are cheap and loved.
- qutebrowser: every keybinding is a named command string. Makes rebinding, palette and agent tool exposure free.
- Polypane/Sizzy/Responsively define the dev browser bar: synced multi-viewport panes with accurate UA/DPR/touch, auto breakpoint detection, dark/light side by side, media toggles, a11y tests, social/OG preview, isolated sessions, localhost/QR sharing. Responsively already ships an MCP server for coding agents.
- Brave Leo, BrowserOS, Nanobrowser prove demand for BYO keys and local models.

### Agent landscape (Sept 2026)
- The consumer "AI browser" wave partly collapsed: Atlas shut down, Project Mariner cancelled, Edge Copilot Mode folded in, Arc frozen. Survivors have distribution (Chrome, Edge) or a niche. The niche for Dive is developers.
- Where progress actually is: Browser Use moved to raw CDP; Stagehand caches actions server-side; Playwright MCP and Chrome DevTools MCP define the tool schema coding agents already speak; Claude's browser toolset and computer toolset are GA on the API.
- Failure modes: benchmarks at 90%+ but live sites with auth and writes at ~30%. Date pickers, canvas, shadow DOM, CAPTCHA, 2FA. Users say "clicks the wrong button and keeps clicking".
- Security: Comet was exploited via hidden Reddit text reading Gmail and OTPs. Fix pattern: instruction/content separation, per-site permissions, isolated agent profile with no credentials, confirmation on the "lethal trifecta" (private data + untrusted content + outbound write), action classifiers, rare prompts to avoid approval fatigue.
- WebMCP (`navigator.modelContext.registerTool`) is in Chrome 149 origin trial. An agent browser should discover and prefer site-declared tools.

---

## 3. Product definition

**Name:** Dive. **Audience:** web developers, designers who code, QA. **Promise:** the browser you already need open while coding, with the tools you keep installing as extensions built in, and an agent that can see the runtime and your repo.

Non-goals for v1: Chrome extensions, DRM video, mobile apps, cloud sync of browsing data.

### Layout (Comet as the reference, adapted for workspaces)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [WS rail]  Tab Tab Tab Tab  +                    [Agent] [Tools] [⋯]   │  <- title/tab strip (drag region)
│  ◀ ▶ ⟳   🔒 localhost:5173/dashboard        ⌘K   [📱][📷][⏺][🧩]           │  <- toolbar + omnibox + dev quick actions
├────┬───────────────────────────────────────────────────┬─────────────────────┤
│ W  │                                                   │  Agent Sidecar       │
│ S  │                Page content (CEF child view)      │  ─────────────────   │
│    │        or split view (up to 4 panes)              │  thread / trace      │
│ r  │        or device grid (synced viewports)          │  timeline / approvals│
│ a  │                                                   │                      │
│ i  │                                                   │  [prompt box]        │
│ l  ├───────────────────────────────────────────────────┤                      │
│    │  Dev dock: Console | Network | Storage | A11y ... │                      │
└────┴───────────────────────────────────────────────────┴─────────────────────┘
```

- **Left rail (48 px, collapsible):** workspace icons with color dot and unread badge. Click to switch, drag to reorder, long-press for container settings. Below: Essentials (global pinned apps).
- **Tab strip (top, horizontal by default, Comet style):** per-workspace tabs, three tiers rendered as groups (Pinned, Today, Archived hidden). Toggle to vertical sidebar mode for Arc/Zen users. Tab previews on hover.
- **Toolbar:** back/forward/reload, omnibox that is also the command palette (`⌘K` / `⌘T`), dev quick-actions (device simulator, capture, record, tools), Agent toggle at the far right.
- **Content area:** one CEF view, or split view (2 to 4), or device grid.
- **Right Sidecar (Agent):** resizable, collapsible, persists per workspace. Tabs inside it: Chat, Trace, Watchers, Skills.
- **Bottom Dev dock:** togglable panel with the built-in tool tabs. Chrome DevTools opens in its own window or docked via `ShowDevTools`.
- **Glance:** alt-click a link to preview it in a modal over the content (rendered in the overlay child).

### Data model

```
Workspace { id, name, color, icon, container_id, default_url, agent_policy, sidecar_state }
Container { id, name, cache_path, proxy?, persist_cookies }   // 1:1 CefRequestContext
Tab { id, workspace_id, tier: Essential|Pinned|Today, url, title, favicon, parent_tab?, group?, state: Active|Sleeping|Discarded, last_active_at }
Pane layout { workspace_id, mode: Single|Split(n)|Grid, pane_tabs[], sync: {nav, scroll, input} }
Session snapshot { workspace_id, tabs[], layout, scroll positions } written on every change (event log + periodic snapshot)
Command { id, title, keybinding?, scope, run }                 // everything is a command
```

Every user action is a named command. The palette, keybindings, the agent tool list and the MCP server all enumerate the same registry.

---

## 4. System architecture

### Process model
Chrome bootstrap: browser process (Rust + Tauri + React chrome renderer), GPU process, one renderer per site instance, utility processes, helper apps on macOS. CEF's external message pump is integrated into winit's event loop by `tauri-runtime-cef`.

### Rust crates (workspace)

```
apps/desktop            Tauri app: window setup, commands, menus, updater
crates/dive-core        Workspace/tab/container domain model, SQLite store, event bus, command registry
crates/dive-cdp         CdpSession over CefBrowserHost::SendDevToolsMessage + observer: id map, oneshot results, event broadcast, UI-thread marshalling via CefPostTask
crates/dive-net         CefResourceRequestHandler: adblock engine, mock/rewrite rules, HAR collector, throttling presets
crates/dive-capture     Screenshot (CDP), tab recording (screencast / OSR paint), native screen capture per OS, ffmpeg-sidecar encoding, gif
crates/dive-emulate     Device descriptors (vendored from DevTools EmulatedDevices), emulation presets, multi-pane sync bus
crates/dive-agent       Agent loop, provider trait (Anthropic first), tool registry, policy engine, trace store, checkpoints
crates/dive-mcp         MCP server (stdio + HTTP) exposing the browser, MCP client to user servers (GitHub, filesystem, Linear...)
crates/dive-devtools    axe-core runner, web-vitals injector, storage editors, localhost scanner, tunnel/QR
packages/ui             React chrome (Vite): shell, panels, palette, sidecar, dev dock
packages/devices        Device JSON + bezels, refreshed from upstream by script
packages/protocol       Shared TS types generated from Rust (ts-rs or specta)
```

### IPC
- Control plane: Tauri commands with typed payloads (specta/tauri-specta for end-to-end types).
- High-frequency push (network events, console, agent stream): `tauri::ipc::Channel`.
- Binary (screenshots, frames): `tauri::ipc::Response(Vec<u8>)` or a custom URI scheme the UI fetches, which is the fast path on Windows.
- Page-side hooks (scroll sync, web-vitals, WebMCP discovery): scripts injected with `Page.addScriptToEvaluateOnNewDocument`, talking back over a CEF V8 binding to Rust.

### The CDP layer is the foundation
Nearly every dev feature and every agent tool is a CDP call. Build `dive-cdp` first and build one composite "page state" RPC (AX tree with refs + DOMSnapshot + screenshot + URL/title + console tail) because agents read it every step.

---

## 5. Built-in developer toolkit

Ranked by value divided by effort. "Effort" is engineering weeks for one person after the CDP layer exists.

| # | Feature | How | Effort |
|---|---|---|---|
| 1 | Workspaces with cookie-isolated containers, Essentials/Pinned/Today, auto-archive | `CefRequestContext` per container, SQLite, tab sleeping heuristics (skip audio/notifying) | 3 |
| 2 | Omnibox command palette, every action a command, rebindable chords | cmdk + command registry | 1.5 |
| 3 | Full-page and element/region screenshot with annotation | `Page.getLayoutMetrics` + `captureScreenshot{captureBeyondViewport, clip}`, `DOM.getBoxModel` for elements, tldraw for markup, arboard/clipboard plugin, image crate | 2 |
| 4 | Device simulator | `Emulation.setDeviceMetricsOverride/UserAgentOverride(with userAgentMetadata)/TouchEmulation`, SVG bezels with safe-area insets from vendored DevTools device list | 2 |
| 5 | Synced multi-viewport grid (Polypane mode) | One CEF view per pane sharing a context, injected scroll/input broadcaster syncing by ratio, `Page.navigate` fan-out, echo guard | 3 |
| 6 | Media and environment toggles | `Emulation.setEmulatedMedia` (color-scheme, reduced-motion, print), locale, timezone, geolocation, `Network.emulateNetworkConditions` | 1 |
| 7 | Localhost detection, LAN/QR share, tunnel | Port scan + `lsof`/`ss`, framework probe (Vite/Next/webpack), `qrcode` crate, `cloudflared` sidecar or `bore` | 1.5 |
| 8 | Storage and cookie editor, JSON viewer, JWT decoder | `DOMStorage.*`, `Network.getCookies/setCookie`, `IndexedDB.*` | 1.5 |
| 9 | A11y audit and color-vision simulation | Inject axe-core via `Runtime.evaluate`, SVG filter overlays, `Accessibility.getFullAXTree` panel | 1.5 |
| 10 | Meta/SEO/OG social card preview | Parse head, render X/LinkedIn/Discord/Slack card templates | 1 |
| 11 | Split view up to 4 and Glance | Pane layout + overlay child | 2 |
| 12 | Web Vitals overlay and performance trace export | Inject `web-vitals` attribution build, `Tracing.*` to Perfetto-loadable JSON | 1.5 |
| 13 | Network inspector, HAR export, mock/rewrite rules, throttling | `Network.*` events for the inspector, `CefResourceRequestHandler` for block/mock/rewrite, hudsucker proxy optional | 4 |
| 14 | Screen recorder | Tier 1: tab recording from `Page.startScreencast` or OSR paint. Tier 2: native capture (screencapturekit, windows-capture, ashpd/PipeWire) + cpal mic + cursor track, ffmpeg-sidecar encode, gifski or ffmpeg palette for GIF, zoom/cursor effects composited at export like Cap | 6 |
| 15 | Mockup tools: element picker, rulers/guides, grid/flex overlays, pixel-perfect image overlay, eyedropper, design-to-Tailwind | `Overlay.setInspectMode`, `Overlay.setShowGridOverlays`, `CSS.getComputedStyleForNode` + OKLCH nearest-token mapping, overlay child for image | 3 |
| 16 | CSS/JS live edit with "apply to source" via source maps | `CSS.setStyleTexts`, source map resolve, filesystem write through MCP | 3 |
| 17 | Lighthouse | Node sidecar attached over `remote_debugging_port`, optional download | 2 |
| 18 | Per-site CSS/JS injection (Boosts) | Local only, never synced (Arc CVE-2024-45489 lesson) | 1.5 |
| 19 | Per-URL-pattern settings | Rule table applied at navigation | 1 |
| 20 | Ad/tracker blocking | `adblock` crate, cached serialized engine, cosmetic CSS injection | 1.5 |
| 21 | Framework devtools built in (React, Vue, Svelte, Solid) | Bundle the devtools frontends as native dock panels connected through the CDP session; turns the no-extensions gap into a strength | 3 |
| 22 | Request replay and edit | Right-click a request, edit headers/body, resend via `Fetch`/reqwest with the tab's cookies, diff the response | 2 |
| 23 | Project awareness with editor jump | Detect the repo behind localhost, read `package.json` scripts into the palette, stream the dev server log into the dock, click a stack frame to open VS Code/Cursor/Zed at the line | 2 |
| 24 | Multi-session login panes | Same app as admin, user and guest in three isolated panes at once, each pane its own `CefRequestContext`; Sizzy's most loved feature | 1.5 |
| 25 | Bug report composer | One click bundles screenshot, console, HAR, environment and recorder steps into a GitHub or Linear issue through MCP | 2 |
| 26 | Tailwind class inspector | Hover an element, map each utility class to its computed declarations via `CSS.getMatchedStylesForNode`, flag unused and overridden classes | 2 |
| 27 | WebSocket, SSE and GraphQL inspector | `Network.webSocketFrame*` and `eventSourceMessageReceived` decoded, GraphQL operations grouped by name with variables and timing | 2 |
| 28 | Visual regression | Baseline screenshots per route and viewport stored in the repo, pixel and layout diff on demand or from a Watcher | 2.5 |
| 29 | Environment switcher | Map localhost, staging and production for the same route; flip with one keystroke keeping the path and optionally the session | 1 |
| 30 | Vim mode and link hints | Modal keyboard layer over the command registry, hint labels rendered in the overlay child | 1.5 |

---

## 6. The Dive Agent: beyond chat

### Principle
The agent's edge is not a better chat box. It is that Dive owns the runtime (CDP), the session (isolated profile), and can reach the user's code (MCP). Chrome extensions cannot do any of those three.

### Surfaces
1. **Sidecar (right panel):** conversation, but every message can carry live context chips (this tab, selection, console errors, last N requests, a screenshot, a recording). Runs against the current tab under a policy.
2. **Agent Tab:** a badged tab in its own isolated container where long autonomous runs happen while the user keeps working. Plan first, then act. Ghost cursor shows actions. Pause, step, cancel.
3. **Watchers:** background agents attached to a tab or a URL that trigger on conditions (exception, failed request, layout shift, text changed, deploy finished) and post findings to the Sidecar.
4. **Skills:** saved, parameterized prompt plus tool bundles, sharable as files in the repo (`.dive/skills/*.md`).

### Tool set (exposed identically to the internal agent and over MCP)
`tabs.list/open/close/focus`, `page.state` (AX tree with refs + snapshot + screenshot), `page.find`, `page.click/type/scroll/select`, `page.form_input`, `page.evaluate` (off by default), `page.screenshot`, `console.tail`, `network.list/get/har`, `storage.get/set`, `emulate.device/media/network`, `capture.record.start/stop`, `perf.trace`, `a11y.audit`, `recorder.start/stop/export`, `diff.snapshot/compare`, `workspace.*`, plus every command in the command registry.

### The ten features, in build order
1. **Browser as MCP server.** Claude Code, Cursor and Codex connect to Dive over stdio/HTTP and get the tool set above. Fastest path to adoption because developers already run those agents. Copy the Chrome DevTools MCP and Playwright MCP schemas so existing prompts work.
2. **Isolated agent profile + trifecta guard.** Agent container has no cookies or passwords by default. Policy engine classifies each action (read / navigate / write / send / pay / download). Confirmation is required only when private data, untrusted content and an outbound write coincide, or the site is in a sensitive category. Credentials are handed to the user for entry, never to the model. Refuse `javascript:`, `file:`, `data:` and internal pages. Treat titles and URLs as untrusted.
3. **Runtime Watcher to repo-aware fix.** Subscribe to `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.loadingFailed`. Resolve source maps, read the source via the filesystem MCP server, propose a diff, apply into a git worktree on approval. Proactive, not on-demand.
4. **Agent Trace Timeline with checkpoints and undo.** Every action stores pre/post DOMSnapshot and screenshot. Navigation and form state can be restored; writes are flagged irreversible with compensating-action suggestions. Directly answers the "keeps clicking the wrong button" complaint.
5. **Traffic to OpenAPI, typed client and "explain this request".** Learn from `Network.*`, infer schemas, emit OpenAPI, a TypeScript fetch client, curl. Select a request and ask why it 401s.
6. **Recorder to parameterized macro to Playwright spec.** Record with AX-ref locators, extract variables, deterministic replay with agent fallback on failure, export `.spec.ts`.
7. **Page-state diff.** Snapshot A and B (DOM, computed styles, network, console) across a deploy or a code change. Agent explains regressions.
8. **Live DOM to your components.** Pick a region, produce React + Tailwind that reuses the user's design system discovered through the repo MCP server.
9. **A11y and performance audit with source patches.** axe and Lighthouse findings mapped to source through source maps.
10. **WebMCP-aware acting and a local model tier.** Prefer site-declared tools. Route DOM distillation and classification to a local Ollama model, reasoning to Claude, with per-run cost display and BYO key.

### Model layer
- Default: Claude Opus 5 through the Messages API over HTTPS from Rust, streaming SSE, `thinking: {type: "adaptive"}`, `output_config.effort` tuned per task (low for watchers and classification, high or xhigh for fix generation), prompt caching with the stable tool list and system prompt first, server-side refusal fallbacks enabled.
- Structured outputs for plans and diffs. Tool inputs parsed as JSON, never string-matched.
- Evaluate Claude's GA browser toolset and computer toolset as the action vocabulary before inventing one; where they fit, map their tool names onto the Dive tool set so prompts transfer.
- Provider trait so OpenAI-compatible endpoints and Ollama work with reduced features. Keys in the OS keychain.
- Context budget: send AX tree with refs (hundreds of tokens) by default, screenshots only for canvas or when refs fail, set-of-marks fallback.

---

## 7. Roadmap

### Phase 0: Spike (weeks 1 to 3)
Prove the risky assumptions before writing product code.
- Vendor `tauri@feat/cef`, pin `cef` to its version, boot a window with a React chrome webview and one tab child view on macOS arm64, Windows, Linux X11.
- `dive-cdp`: send `Page.navigate`, receive `Page.loadEventFired`, capture a full-page screenshot to clipboard.
- Reproduce or rule out cef-rs #456 (macOS arm64 crash after real login), #15718 transparency, #15764 IPC with DevTools.
- Transparent overlay child over the tab view for a dropdown; measure input latency.
- Bundle, sign and notarize on macOS with the four helpers; produce an NSIS installer and AppImage. Confirm the silent no-framework failure mode is guarded.
- Exit criteria: all three platforms load a page and screenshot it from a signed build. If macOS windowed mode is unstable, decide between OSR and waiting on upstream before Phase 1.

### Phase 1: Browser core (weeks 4 to 12)
Workspaces and containers, three-tier tabs, session persistence, omnibox palette with commands and keybindings, split view and Glance, downloads, find in page, context menus, settings, ad block, tab sleeping, updater, crash reporting. Ship as alpha to a small developer group.

### Phase 2: Dev toolkit v1 (weeks 13 to 22)
Screenshot + annotate, device simulator, synced grid, multi-session login panes, media/network toggles, localhost detection + QR + tunnel, project awareness with editor jump, environment switcher, storage editor, JSON/JWT, a11y audit, OG preview, Web Vitals, per-site injection, Vim mode and link hints. Public beta.

### Phase 3: Agent v1 (weeks 23 to 32)
MCP server, page-state RPC, Sidecar chat with context chips and actions, isolated agent container and policy engine, Trace Timeline with checkpoints, Watchers for console and network errors, first repo-aware fix flow. This is the launch moment.

### Phase 4: Deep tools (weeks 33 to 44)
Network inspector with HAR, request replay and edit, WebSocket/SSE/GraphQL inspector, mock and rewrite rules, traffic to OpenAPI, recorder to macro to Playwright, page-state diff, visual regression, bug report composer, framework devtools panels, Tailwind class inspector, screen recorder tier 1 then tier 2, mockup tools, live edit to source, Lighthouse sidecar.

### Phase 5: Polish and expansion
OSR compositing for canvas mode and tab previews, local model tier, WebMCP, design-to-components, encrypted settings sync, Skills marketplace as plain files.

---

## 8. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `feat/cef` is pre-release and moves under you | High | Vendor and pin. Budget one day per CEF major to rebase. Upstream fixes. |
| macOS arm64 windowed crash or notarization pain | Medium | Spike first. OSR fallback path designed in. |
| Overlay airspace bugs (dropdowns over content) | High | Overlay child from day one; never assume HTML can paint over a tab. |
| No extensions disappoints users | Medium | Ship the top five extension use cases natively; say so on the site. |
| No H.264 or Widevine | Certain | Document it. Hardware decode via OS APIs later; custom CEF build only if demand justifies 8 to 12 hour CI builds and licensing. |
| Installer size 150 to 250 MB | Certain | Delta updates via the updater, optional downloads for ffmpeg and Lighthouse. |
| Prompt injection against the agent | Certain | Isolated container, no credentials, trifecta guard, action classifier, content/instruction separation, allowlists. Never rely on the model alone. |
| Agent unreliability on complex sites | High | Plan-first, refs over pixels, deterministic macros with agent fallback, checkpoints and undo, small blast radius. |
| Screen recorder per-OS complexity | High | Tier 1 (tab recording via CDP/OSR) first; copy Cap's crate split for tier 2. |
| Windows IPC throughput | Medium | Custom URI scheme for binary payloads. |

---

## 9. Immediate next steps

1. Reconcile and commit the active recording/menu/Library/Toolbar work, including generated bindings, without mixing ownership boundaries.
2. Close the readiness ledger’s ownership-gated navigation/reorder rollback, Library windowing/error-state, and anchored-popover lifecycle deferrals test-first.
3. Add a pinned `cargo-audit` job and require the full static/test/generated-binding gates in CI.
4. Run the signed macOS notarization/install/update path and Windows/Linux CEF smoke matrix using CI-held release credentials.
5. Rerun the private Probe live, memory and startup checks from the exact release candidate before promotion.
