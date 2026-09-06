# DiveScreen preview media ownership

Scope: `screen/Stage.tsx`, new `screen/previewMedia.ts`, and `screen/Stage.lifecycle.test.tsx`. Store, DiveScreen, exporter, IPC and native implementation are unchanged by this slice.

Native run14 proved copied-sidecar recovery and save retry, then a subsequent MP4 export triggered the existing preview decode-error UI without an output file. This does not establish a specific native decoder failure. The source did show that Stage detached its video without explicitly releasing the media resource, and a pending metadata play() callback could pause a replacement resource.

Pinned Chromium151 `third_party/blink/renderer/core/html/media/html_media_element.cc` at932 and5031 handles DOM removal by scheduling a pause, not clearing the player. `load()` at1078 invokes the media load algorithm, which calls ResetMediaPlayerAndMediaSource at1161. Primary source: https://github.com/chromium/chromium/blob/151.0.7922.174/third_party/blink/renderer/core/html/media/html_media_element.cc . The app therefore now owns src and teardown in one media lease: pause, remove src, load to release, cancel metadata timer and remove the lease's error listener. Setup restores the next src itself, avoiding React assigning it before old cleanup removes it.

Lease identity plus editor generation/borrowed element checks reject stale errors and metadata continuations. Cleanup clears the borrowed store pointer only when it still names this generation's element. The current-resource error preserves the existing user-facing decode failure and logs only numeric code, readyState and networkState. Review removed the free-form MediaError.message so no URL or media content can enter this diagnostic.

Four meaningful Stage regressions failed RED and passed GREEN: resource explicitly unloaded after unmount; delayed old play() does not pause replacement source; stale-generation event/cleanup cannot affect replacement pointer/error; actual current error logs bounded facts and preserves UI behavior. Two existing performance/preview-loop checks also pass (6tests total). Scoped ESLint and full frontend typecheck pass. Logs: `/tmp/dive-screen-stage-red.log`, `/tmp/dive-screen-stage-green.log`; copies in `target/screen-stage-regression/`.

No app builds/native launches by this subagent. Root must repeat reopen→save failure→retry→export to qualify native behavior. Export's unbounded seek/drain waits and incomplete cancellation/finally cleanup remain separate OPEN findings; this patch does not claim to fix them or prove the cause of run14.


## Native run16: cleanup does not resolve the transient export failure

Exact bundle71532b430d6d6401d36e302909b1d91e8ad2457086797652927ca745c40eb48e (Stage cleanup + direct shortcut; old exporter and non-atomic project writer). Isolated profile/fixtures and mock keychain; PID80865, port62721. Copied sidecar opened padding61; forced destination-directory write failure retained padding83 through Alpha→DiveScreen; restored destination and Retry saved83 against actual current recording path. `target/screen-ui-16/retry-evidence.json`.

Export GIF-setting→MP4 Source30 stalled at progress1/90 then generic media error replaced the editor. This UI labels all media errors as decode errors, so actual native error class is not known. Progress updates every3 frames; frame1 completed, an early seek is a candidate. No scope denial was logged. Stage cleanup therefore does NOT qualify as a fix for this native failure. Cancel attempt used a stale AX ID after error UI appeared and is not a cancellation result.

Try again reopened preview with Export dialog retained. Retry MP4 succeeded, producing3s H264640x360 with no audio (correct for silent fixture). Done→Alpha→DiveScreen→MP4 again succeeded, with a distinct output filename. Both focused Done on completion. Evidence `recovered-mp4-probe.json`, `mp4-1-probe.json`, `mp4-2-probe.json`, and two files in recordings. Same-file recovery and a successful plain tab roundtrip narrow the trigger but do not establish root cause. Bounded media-state/native-error diagnostics are the next step.

Run16 normal Quit and owned helper drain passed in464.29s (session duration, not export latency). No test process left running.


## Native run17: precise network classification and bounded export recovery

Exact bundlece4e233992003177b1ec79d46357a4b898a7f99bbda5ca016282cb1bbf066a46; PID94632, port63914, mock keychain/disposable profile, original UI rendered before manual diagnostics. Media domain reported enabled. Includes atomic sidecar replacement, bounded export waits/finally cleanup, generation/token-owned ExportDialog and fixed diagnostic media ring. Full frontend749/Rust460/Python19 plus typecheck/lint/format/Vite/strictClippy/build pass (one test numeric-literal style corrected before remaining Rust gate).

Copied-sidecar61→forced directory writefailure→padding83→tabroundtrip→restore→Retry saved current identity83 with no temporary staging leftovers. GIFsetting→MP4Source30 then succeeded on first attempt, valid3s640x360 H264 silent output. `target/screen-ui-17/retry-evidence.json` and `silent-mp4-probe.json`. Diagnostic export begin→done~786ms is one instrumented local fixture run, not a benchmark or general performance claim.

Long30s recording at1080p60 reproduced early seek failure: generation8 export began readyState4/networkState2; frame2 target16.667ms remained seeking1, readyState1/networkState2. New10s deadline returned usable export dialog with explicit seek timeout and focusClose, rather than indefinitely spinning. A later native media error was code2 (MEDIA_ERR_NETWORK), so existing UI's blanket decode-failure copy was misleading. Media domain emitted no retained playerErrorsRaised receipt; error class comes from the frontend element before teardown. Root collected fixed numeric ring and native screenshot.

Cancel attempts are NOT qualified: one AX Cancel ID was stale after timeout, another keyboard attempt used unsupported tool key Space, and subsequent recovery transitioned back to error before a clear cancellation action. No long edited output was produced. The one successful silent output remains valid. Normal Quit/helperdrain486.69s. The original transient media cause stays open pending adapter range-read correction and native Network evidence.


## Native run19: partial media delivery and export recovery qualified

Exact bundle `e21350eee78a5c49d34b54834b419094f8559634810d4b66815aed695b5e2fac`, PID14411, fixture49405, isolated profile/mock keychain. Pinned CEF calls Skip before GetResponseHeaders. Tauri already supplies the selected206body, so the adapter now acknowledges an exact matching positive Content-Range start without moving its cursor. Malformed ranges, mismatched lengths/positions, full responses and failures retain rejection. Three standalone regressions and source review pass; review verified the pinned loader ends its Skip loop after this full synchronous acknowledgment.

Computer use repeated copied-sidecar padding61 → real destination-directory save failure → padding83 → Alpha/DiveScreen roundtrip retaining draft/error → restored destination → Retry. The saved sidecar contains83 and actual opened source, with no temporary sibling. The first subsequent short MP4 export succeeded:3s640x360 H26430fps,128479bytes, no audio (correct silent fixture).

Long30s preview exported at1080p60. Keyboard Return activated focused Cancel during rendering (numeric traceframe897, while the earlier AX snapshot had shown112), returned configuration with export-cancelled feedback and Close focus, and immediate retry completed. Result `Long-fixture-edited-2026-09-05T12-13-38-958162Z.mp4`: ffprobe confirms30s1920x1080 H26460fps,7549080bytes, no audio. Instrumented export begin→done36.531s is one fixture observation, not a general benchmark. Done, Play, pause and scrub to~24s visibly worked afterward.

Gated Network evidence: all7 asset requests received206;6finished and1explicitlycanceled/aborted. Nonzero offsets262144,1024000,2048000 all completed. The2,658,630-byte long preview completed three consecutive selected ranges. No range failure, media error or seek timeout; no collector lag/cap (21/256records,7/64identities). This verifies the corrected adapter on the formerly failing workflow; it does not retroactively prove the exact missing Network event from native17. Evidence `target/screen-ui-19/{native.log,retry-evidence.json,network-summary.json,silent-mp4-probe.json,long-mp4-probe.json}`.

Full frontend756/Rust465/Python19 plus remaining canonical checks/build pass. Normal Quit/helper drain634.65s. Native ffmpeg/IPC cancellation and job-owned staging cleanup remain open for the next slice; this run qualifies render-phase cancellation only. Generic media-error wording, whole-app Quit draft flush, broad formats/codecs and the complete tools roadmap remain open.
