# Task 2 report: Reliable automated media interaction

## Status

**DONE_WITH_CONCERNS**

The deterministic helper, local causal fixture, harness integration, and behavioral tests are complete in commit `259e7e7`. Native execution of the new helper remains the acceptance boundary and is delegated to root as required by the task split. Root independently reported that the optimized `b54cf359` bundle locator-clicked both the zero-height BODY fixture and YouTube with trusted input, but that is supporting locator evidence rather than execution evidence for this new helper.

Task 1 reviewer follow-up is separately committed as `d16c75c`. It adds the requested decisive regression for an `overflow:hidden`, stale zero-sized root box with a non-clipping BODY and visible button. No production injected or Rust source was changed.

## Implementation

- `scripts/media-playback-check.py` implements the required CLI and emits one JSON evidence object on success or failure. It loads the bearer token without printing it, uses the caller's overall deadline for every MCP HTTP call, and returns nonzero for invalid arguments, initialization/RPC/action failures, navigation mismatch, player error, action exhaustion, or timeout.
- Observation records include the intended startup target locator and bounds, viewport and scroll position, opaque document/video identity, video connection/readiness/paused/error/timing state, and actual trusted pointer event targets. Observed page and media URLs are not retained in evidence.
- The state machine never clicks a playing video or a transport toggle. While paused it may click only a visible startup overlay (`.ytp-large-play-button` or the fixture's `[data-startup-play]`) through MCP `page_click`, with a global two-action bound. It does not call DOM `.click()` or `video.play()`.
- Success requires at least 1.5 seconds of both wall-clock and media-time advancement while the same connected video remains ready and unpaused. Missing, detached, paused, unready, ended, replaced, reloaded-document, backward, or seek-jump observations reset the continuous window.
- `scripts/fixtures/media-playback.html` reproduces the zero-height scrolling BODY with a visible startup control. Its page-owned trusted click handler starts a four-second local WebM. `scripts/live-check.sh` verifies this fixture first, then YouTube, and preserves JSON evidence in `target/readiness-8/` on success and failure.

## TDD and verification evidence

Red phases were observed for the missing helper; the unbounded third action; empty MCP notification response; missing-video continuity bridge; same-URL document identity reuse; per-RPC 60-second timeout; lost diagnostics after RPC timeout; malformed CLI output; and invalid detached/paused window baselines. Each failed for the intended behavioral reason before its implementation change.

Final checks:

```text
python3 -m unittest scripts/tests/test_media_playback_check.py
17 tests passed

python3 -m unittest discover -s scripts/tests -p 'test_*.py'
47 tests passed

pnpm --filter @dive/desktop exec vitest run src/test/injectedVisibility.test.ts src/test/injected.test.ts
2 files passed; 63 tests passed

bash -n scripts/live-check.sh
python3 -m py_compile scripts/media-playback-check.py scripts/tests/test_media_playback_check.py
ffprobe: media-playback.webm duration=4.000000
git diff --check
all passed
```

The full Python suite emitted its existing best-effort `sample` timeout/missing-tool diagnostics; the suite still exited 0.

## Exact native command

Run the complete harness three times. Each invocation creates a fresh disposable profile; per-run logs retain the JSON evidence even though the convenience JSON files use stable names.

```bash
cd /Users/dvle/Documents/GitHub/dive-browser-readiness
for run in 1 2 3; do
  DIVE_BIN="$PWD/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" \
    scripts/live-check.sh >"target/readiness-8/media-live-check-${run}.log" 2>&1 || exit 1
done
```

For an already-running disposable instance and known tab, invoke only the helper:

```bash
python3 /Users/dvle/Documents/GitHub/dive-browser-readiness/scripts/media-playback-check.py \
  --data-dir DIR --port PORT --tab-id ID \
  --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

## Remaining concerns

- The new helper has not yet produced native JSON evidence in this implementation task. Root must execute it against the optimized bundle and retain the result before Task 2 can be called complete.
- Windows native execution and the required two-hour continuous workload remain outside this task's execution split and are still required for the overall readiness rating.
