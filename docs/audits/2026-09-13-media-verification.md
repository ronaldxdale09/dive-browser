# Native media verification — 2026-09-13

## Outcome and scope

The media task passes three consecutive fresh-profile macOS runs of the complete native resilience harness. Each run verifies actual trusted startup input, sustained local playback, the intended YouTube video, renderer recovery, discard/wake, PDF, popups, sandboxing and native lifecycle. Independent scoped review: spec PASS, quality PASS.

This qualifies the media fix on the identified optimized macOS bundle. It does not qualify the pending native-creation rewrite, Windows, the required two-hour workloads, or the overall 8/10 rating. The existing camera/microphone test requiring OS consent was skipped in all three runs and remains unverified.

## Confirmed causes and changes

1. The injected actionability check treated a zero-height BODY as an ordinary clip ancestor even when its overflow propagated to the viewport. The corrected generic overflow behavior allows the visible Play control to receive native input. Native local evidence proves the zero-height BODY case and trusted events; no website-specific visibility bypass was added.
2. The previous harness unconditionally clicked the transport toggle, which may mean Pause. The helper observes already-playing media and clicks only a visible startup control when paused.
3. Early trusted pointerdown reached the actual YouTube Play button, then YouTube replaced its document and appended only `themeRefresh=1`. The original strict helper correctly exposed this as `navigation_mismatch`. No-input and mute-only controls did not navigate. Inspection of the first-party script loaded in the test found YouTube's theme-mismatch redirect; this behavior is also documented in [Mozilla's primary compatibility investigation](https://bugzilla.mozilla.org/show_bug.cgi?id=1671032).

The navigation classifier now recognizes only the exact requested URL modulo fragment, or the same HTTPS `www.youtube.com/watch` URL with exactly one added `themeRefresh=1`. It requires a single unchanged video ID and rejects altered origin, port, path, duplicate parameters, unrelated query additions/removals and other video IDs. A reload resets the continuity window; no pre-reload progress counts toward success.

The observer additionally checks YouTube's player video ID and excludes ads or unidentified content from success. Playback requires at least 1.5 seconds of both wall time and media advancement on the same connected, ready, unpaused video in the same document. Actions remain globally bounded at two and every RPC uses the remaining overall deadline.

The local fixture asserts one actual startup click and ordered trusted pointerdown/up/click receipts, including target tag, ID, class, timestamps and coordinates within the observed button bounds. Missing, synthetic or mistargeted input fails the harness. Its real event handler starts the local WebM; the verifier does not invoke DOM click or play methods.

## Exact native evidence

Optimized local bundle, version 0.1.24, native production source `b54cf3595c7028d3195ad8b2780e4a0efd5fd41e` (later changes before these runs are scripts, tests and documentation):

- Binary: `target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop`
- SHA256: `e9be2d2aa8e01d28897c7f4bcdcf513942251fbf9a98f7027b2e7f9d56baf1e7`
- Machine-readable receipt: `target/readiness-8/media-native-qualification.json`
- Logs: `target/readiness-8/media-final-full-{1,2,3}.log`
- Full observations: `target/readiness-8/final{1,2,3}-media-playback-{local,youtube}.json`

| Fresh run | Local continuous advance | YouTube continuous advance | CDP p95 | Full harness |
| --- | ---: | ---: | ---: | --- |
| 1 | 1.654298 s | 1.686985 s | 1.211 ms | PASS |
| 2 | 1.656209 s | 1.698057 s | 1.063 ms | PASS |
| 3 | 1.664225 s | 1.678837 s | 1.094 ms | PASS |

Each run observed the theme reload, verified the intended video after replacement, used one trusted startup action per fixture/video, and reported no local input assertion errors. The native lifecycle subphase includes four normal quit/window-close cycles and an intentional incomplete-startup failure. All owned harness processes were cleaned up by its exit trap.

## Regression checks

- 25 focused Python media tests passed; 56 total Python tests passed.
- Four tests execute the exact injected observer expression, including stable/replaced identity, media state/bounds, content/ad identification and synthetic-event rejection.
- TypeScript checking, scoped ESLint and diff whitespace checks passed.
- Red results were recorded before implementing the navigation exception, content checks and input validator. Negative cases cover wrong videos/origins/queries, document replacement, ads, missing identity, synthetic input, wrong targets, missing events and insufficient playback.

The earlier viewport task separately passed 63 injected visibility/locator tests and native causal verification. Every affected native check must run again after the creation lifecycle changes and on Windows before overall qualification.
