# DiveScreen export audio correction

Scope: `apps/desktop/src-tauri/src/screen.rs` only. No IPC types, frontend project model, generated bindings, save/cancel behavior or permission diagnostics changed. No native application build/launch by this subagent.

The editor stages video-only WebM as ffmpeg input0, then supplies the original recording as input1 for sound. The audio filter incorrectly selected input0. It now selects input1, and native source probing gates audio preservation so microphone-off recordings export without a phantom audio track. Nonzero ffprobe status is an explicit error rather than being interpreted as absent audio. GIF keeps its existing silent path. A private `finish_in(dir,...)` helper runs the exact production finishing pipeline in a disposable fixture directory without changing production output paths.

## Evidence

- Standalone real ffmpeg RED: original filter fails exit234, “matches no streams”; `target/screen-export-audio-regression/standalone-red.log`.
- Production Rust RED, root-run: three selected real-media tests; audio and silent MP4 fail; GIF passes. `target/screen-export-audio-regression/rust-red.log` (original `/tmp/dive-screen-audio-red.log`).
- Production Rust GREEN, root-run: all five selected tests pass (two existing unit tests plus three real-media regressions). `target/screen-export-audio-regression/rust-green.log` (original `/tmp/dive-screen-audio-green.log`).
- Real fixtures exercise a video-only staged2s WebM, source4s MP4 with440/880/1760Hz intervals, and retained1–2s at1× plus2–4s at2×. Decoded output must be approximately2s, retain880Hz then1760Hz, and match declared dimensions/audio presence. Separate silent MP4 and GIF cases assert no audio stream.
- A fourth ignored regression was added after that green run: corrupt the source container, require explicit ffprobe failure, and assert no edited output file was created. Root final run passed all six tests; `/tmp/dive-screen-audio-final.log`.
- All external-media regressions are explicitly `#[ignore = "requires ffmpeg and ffprobe; run explicitly with --ignored"]`; invocation fails clearly if either executable is missing. They do not silently skip. Root command: `cargo test -p dive-desktop --lib screen::tests -- --include-ignored --nocapture`.
- Local rustfmt and `git diff --check` pass. Root reports strict Clippy/workspace tests and release build passed (bundle SHA prefix3bc7e739). Exact-binary editor export/playback remains root-owned; the final malformed-source test passed.

## Native fixture import, no OS devices

Use the disposable process's actual data root (`state.rs:77`, DIVE_DATA_DIR when set). Place `<stem>.mp4` in `captures/`, and a same-stem, same-duration decodable VP9 WebM in `captures/.previews/`. The companion must represent the original full clip, unlike the2s staged render used by the finishing regression. No event/project sidecar is required: the editor builds a fresh project from ffprobe metadata. Open Library → Recordings → Edit `<stem>` in DiveScreen, or MainMenu → Edit Latest Recording after making it the newest editable file. This exercises the ordinary route and controls, without microphone requests. Source: `screen.rs` recordings_list/companion, `components/Library.tsx:323`, `MainMenu.tsx:222`, `internal/InternalPage.tsx:21`.

Potential independent playback boundary: `captureMediaUrl` uses the asset protocol, while tauri.conf.json currently scopes assets to `$APPDATA/captures/**` and `.previews/**`. No dynamic asset-scope override for DIVE_DATA_DIR was found. A disposable data root outside actual Tauri APPDATA may therefore fail video loading even when native metadata succeeds. Confirm actual scope before interpreting a decode/403 failure as audio-export regression; no wildcard or harness changes were made here.

The other Task9 audit findings (autosave loss and stale source/write identity) are addressed by the subsequent frontend lifecycle slice; see task-9-screen-lifecycle-report.md. Export cancellation/resource cleanup and dialog keyboard behavior remain OPEN and unchanged. Native editor UI, microphone capture and output system-player behavior are not claimed qualified by these ffmpeg tests.


## Native workflow qualification

Run11 exact3bc7e7395ebb56329f4effd4f153187e478a1a6f93617881e927a965a11620c0 rendered browser/page, listed seeded recordings, then failed to open the Audio preview. Native log line29 reports Tauri asset scope denial for the disposable profile's .previews/Audio-fixture.webm; the editor showed its recovery screen. Normal Quit/helper drain passed130.82seconds. This was a profile asset-scope failure, independent of the corrected audio filter.

Added capture_scope startup setup after state initialization, before creating chrome. It validates both canonical managed capture and preview directories before granting either, rejects an escaping preview-directory symlink, and adds the active capture root plus its explicit hidden preview root to Tauri's existing scope. It does not replace the existing static capture grants or allow the full profile. Three filesystem tests and source review passed. These unit tests validate path selection, not HTTP response semantics.

Run12 exactfc5ff06fbe940939a9370c949057d5b7efc6eeb1b127ceaf787af7c872e1ca92 rendered the complete editor/preview. Computer use played the Audio fixture to its3second endpoint, tested Export initial focus, backward Tab wrap, Escape dismissal/trigger restoration, then exported audio MP4 at Source resolution, silent MP4 at Source resolution and GIF at15fps. Each completed with visible saved filename/dimensions and focused Done. FFprobe confirms3seconds: audio MP4640x360H.264+AAC, silent MP4640x360H.264 with no audio, GIF1280x720with no audio. Evidence target/screen-ui-12/{audio-export-probe,silent-export-probe,gif-export-probe}.json and saved output files under recordings/. The decoded audio/trim/speed regression remains the automated real-media test, not a native listening claim.

Padding changed50to83, followed immediately by an Alpha tab switch and return; the saved sidecar and reopened editor both showed83. The CUA action duration does not establish the exact sub600ms debounce boundary; controlled delayed-IPC tests cover that boundary. A companion symlink to an owned fixture outside captures was denied in the native asset log and showed the recovery screen; switching back to the valid Audio editor rendered normally. Normal Quit/helper drain passed446.16seconds. No manual diagnostics were enabled in this run.

This build predates the final copied-sidecar identity correction; that correction awaits its separate exact-binary native run. Export Cancel completion/resource cleanup, external Open/Finder actions, exact HTTP range responses, full editor control coverage, recording entry and crash-safe sidecar replacement remain open.
