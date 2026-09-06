# Changelog

All notable changes to Dive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); until 1.0 a minor
bump may change behaviour.

## [Unreleased]

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
