# Chromium partial media delivery


## Native run19: partial media delivery and export recovery qualified

Exact bundle `e21350eee78a5c49d34b54834b419094f8559634810d4b66815aed695b5e2fac`, PID14411, fixture49405, isolated profile/mock keychain. Pinned CEF calls Skip before GetResponseHeaders. Tauri already supplies the selected206body, so the adapter now acknowledges an exact matching positive Content-Range start without moving its cursor. Malformed ranges, mismatched lengths/positions, full responses and failures retain rejection. Three standalone regressions and source review pass; review verified the pinned loader ends its Skip loop after this full synchronous acknowledgment.

Computer use repeated copied-sidecar padding61 → real destination-directory save failure → padding83 → Alpha/DiveScreen roundtrip retaining draft/error → restored destination → Retry. The saved sidecar contains83 and actual opened source, with no temporary sibling. The first subsequent short MP4 export succeeded:3s640x360 H26430fps,128479bytes, no audio (correct silent fixture).

Long30s preview exported at1080p60. Keyboard Return activated focused Cancel during rendering (numeric traceframe897, while the earlier AX snapshot had shown112), returned configuration with export-cancelled feedback and Close focus, and immediate retry completed. Result `Long-fixture-edited-2026-09-05T12-13-38-958162Z.mp4`: ffprobe confirms30s1920x1080 H26460fps,7549080bytes, no audio. Instrumented export begin→done36.531s is one fixture observation, not a general benchmark. Done, Play, pause and scrub to~24s visibly worked afterward.

Gated Network evidence: all7 asset requests received206;6finished and1explicitlycanceled/aborted. Nonzero offsets262144,1024000,2048000 all completed. The2,658,630-byte long preview completed three consecutive selected ranges. No range failure, media error or seek timeout; no collector lag/cap (21/256records,7/64identities). This verifies the corrected adapter on the formerly failing workflow; it does not retroactively prove the exact missing Network event from native17. Evidence `target/screen-ui-19/{native.log,retry-evidence.json,network-summary.json,silent-mp4-probe.json,long-mp4-probe.json}`.

Full frontend756/Rust465/Python19 plus remaining canonical checks/build pass. Normal Quit/helper drain634.65s. Native ffmpeg/IPC cancellation and job-owned staging cleanup remain open for the next slice; this run qualifies render-phase cancellation only. Generic media-error wording, whole-app Quit draft flush, broad formats/codecs and the complete tools roadmap remain open.
