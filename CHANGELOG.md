# Changelog

All notable changes to Dive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); until 1.0 a minor
bump may change behaviour.

## [Unreleased]

### Added
- Private windows (⇧⌘N, File menu, browser menu and palette): a separate
  off-the-record process with an in-memory database and no logging, MCP,
  extensions, agent credentials or update checks; muted violet chrome with a
  Private badge, Exit private mode, and a normal-profile lock so window
  requests land in the right process. New workspace moves to ⌃⌥⇧N.
- First-run onboarding: a five-second Remotion intro, a Start Dive screen,
  then profile, workspace and a look at the features with DivePrivacy and
  default-browser choices; a new `onboarded` preference records it, and
  Settings › About › Reset Dive plays it again.
- Import bookmarks and history from Chrome, Brave, Edge, Arc, Vivaldi,
  Opera, Firefox and Safari: a step in onboarding, an offer on the
  default-browser dialog, Settings › General › Import, and a palette
  command. Folders macOS protects are unlocked by giving Dive Full Disk
  Access in System Settings; passwords and cookies are not read.
- A Home button beside Reload (⌘⇧H) shows the welcome screen without
  closing any tab; clicking a tab brings its page back.
- Address bar suggestions: open tabs, bookmarks and history under the bar
  while typing, with keyboard navigation.
- Bookmark popover to rename or remove a bookmark; `bookmark_rename` command.
- Tab menu shows shortcuts; pin (⌘⇧P) and move to window (⌘⌥N) bindings.
- A DEV or BETA build badge in the title bar with version, build number and
  build time.

### Changed
- The download folder setting lives under General; About says plainly
  whether updates apply to this build; the Developer MCP command shows a
  short token path.
- Empty states share one component across the Library and popovers.
- The default-browser offer is a compact card that hides once Dive is the
  default; the console error count no longer sits on the Agent button.
- Live subtitles remember the chosen model and select a downloaded one when
  the remembered choice is not on disk.

### Fixed
- The developer dock is capped by the window height, so a dock sized on a
  tall window leaves at least a readable strip of page on a short one; the
  resize handle stops at the same ceiling.
- Vitals shows DOMContentLoaded and Load as pending instead of "0 ms"
  while a page is still loading, and reads them again when it finishes.
- The Meta panel's social card loads the page's `og:image` (relative paths
  resolve against the page) and draws the search-result title in a link
  colour that reads in both themes.
- DiveScreen exports are named "clip (edited).mp4", counting up on a clash,
  instead of carrying a timestamp and a job id.
- HAR exports, OpenAPI specs and bug reports are named after the page and
  the time ("github.com requests 2026-09-07 18.19.30.har") instead of a
  timestamp with a random suffix.
- Private windows' Settings no longer list the Agent and Live subtitles
  sections or the import group, none of which can work there.
- Bringing a tab back from its own window no longer deletes it: the popout
  window's close, raised by the reattach itself, was treated as closing the
  tab.
- Browser, AI provider and assistant marks are the official logos from
  svgl.app, with light and dark drawings where the brand has them, in the
  import step, the agent setup and the rail's AI shortcuts.
- The Live subtitles dialog closes on Escape before any model is downloaded;
  a dialog whose primary button is disabled no longer leaves focus outside
  its trap.
- After a failed load the address bar shows the address that failed, so it
  can be corrected in place, and a new tab is named after its host while the
  first page loads instead of "about:blank".
- The update card uses the theme's colours; it had referenced tokens that do
  not exist and rendered without a background.
- A failed agent reply offers "Change model or key" inline.
- The feature tour scrolls to the top of the page when opened.
- The main menu, agent setup and DiveScreen cursor controls use sentence
  case like the rest of the chrome; palette commands are named after the
  surface they open ("Developer dock", not "Toggle dev dock").
- MCP and agent page input fail at once with a reason while a dialog covers
  the page, instead of timing out; local providers (Ollama, LM Studio) select
  an installed model when the configured default is missing.
- The permission bar keeps its explanation in a tooltip; the saved-recording
  footer stays on one line.
- The tab context menu closes on Escape and on a press elsewhere.
- The palette no longer lists open pages under History as well as Tabs.
- "About Dive" opens Settings → About instead of the stock macOS panel.
- Popout address bars show the same trimmed address as the main window.
- Canceled requests show as canceled in the Network dock, not as failures.
- Window frame is remembered on resize, move and quit; the rail's collapsed
  state survives a click made before preferences finish loading.
- Cursor controls in DiveScreen are greyed out for recordings without a
  pointer track.

### Added
- DiveScreen can open any video file (MP4, MOV, WebM, MKV, M4V, AVI, GIF):
  "Open Video…" in the editor, the Library's Recordings tab and the main menu
  copies the file into the captures folder and makes the playable companion.
- Export streams its rendered video to the engine as it encodes instead of
  holding the whole file in renderer memory; exports over 20 minutes are
  refused up front.

### Fixed
- Closing a tab's own window (or a tab that had been in one) no longer leaves
  an empty window behind or blocks quitting: the vendored CEF runtime issues
  each native close once and stops waiting for an acknowledgement CEF never
  sends for a reparented view.
- Closing the main window while popout windows are open quits the app instead
  of leaving a headless process.
- A lock-order inversion between the snapshot command and tab activation that
  could freeze the main thread.
- Layout and visibility commands now run on the main thread, so overlays can
  no longer race a tab switch and show two pages at once.
- MCP clients and the agent can only open http(s) pages, never local files.
- Workspace rules no longer put media streams back under request interception.
- One malformed preference no longer resets every preference.
- Clearing history also clears cached site icons.
- Glob rules match hosts containing the pattern's suffix correctly.
- Agent tool calls with malformed arguments surface an error instead of
  running with empty input; OpenAI-compatible streams that end without a
  `[DONE]` marker still deliver the reply.
- Databases from a newer build are refused instead of being written to;
  removing a tab's scroll state is transactional and cascades.
- Boot no longer registers duplicate event listeners after a chrome remount;
  notification toasts no longer cancel each other.

### Changed
- Tab strip rows, agent thread messages and Markdown rendering are memoised.
- `SettingsDialog` split into per-section components; dead `Annotator`,
  `WorkspaceChip` and `skills` store removed; `dive-mcp` split into modules.
- SQLite runs with `synchronous=NORMAL` under WAL.
- Release tooling now stamps the crashpad `crash_reporter.cfg` alongside the
  other version manifests, and the signing-secrets helper takes its identity
  and certificate path from the environment instead of hardcoding them.
- Repository cleanup for open-source publication: internal working notes
  removed, design notes moved to `docs/design/`, contributor documentation
  (CEF setup, feature flags, data locations, MCP connection) added.

## [0.1.4] - 2026-09-06

### Added
- Local live subtitles powered by whisper.cpp, with verified model downloads
  and an in-page caption overlay.
- Agent page reading as Markdown rather than flattened text.
- `cargo deny` licence and dependency-source policy in CI; `LICENSE`,
  `SECURITY.md` and `CONTRIBUTING.md`.
- Native permission enforcement (camera, microphone, prompts) in the vendored
  CEF runtime, with per-origin remembered decisions.

### Changed
- Release pipeline rebuilt so a release is proven (built, signed, verified)
  before the tag and version bump are recorded on `main`.
- Idle tab discard now confirms native close and protects active work
  (media, capture, unsaved forms, downloads, agent runs).
- Renderer crash recovery is bound to native view generations.

### Fixed
- Chromium media range requests and editor export recovery.
- Native New Tab input routing and first-open responsiveness.
- Navigation dialogs replaced without uncovering the page underneath.
- Discarded tabs restored correctly and counted in workspaces.
- Editor exports tracked as browser downloads; provider setup waits for
  confirmed activation.

[Unreleased]: https://github.com/ronaldxdale09/dive-browser/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/ronaldxdale09/dive-browser/releases/tag/v0.1.4
