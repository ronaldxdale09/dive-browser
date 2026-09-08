#!/usr/bin/env bash
# live-check.sh — drive the real Dive app end to end through its MCP server.
#
# Starts a private instance against a local HTTP server, then checks: a tab
# opens and its text reads back; popup, camera, PDF, localhost and offline
# paths behave; a screenshot comes back; a background tab is discarded by the
# sweep and wakes with its page on activation; and the in-process CDP round
# trip stays inside its budget. A separate disposable native lifecycle phase
# crashes exactly one isolated renderer and proves unchanged control documents.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP="${SCRIPT_DIR}/mcp-call.py"
PORT="${LIVE_MCP_PORT:-7493}"
CDP_P95_BUDGET_MS="${CDP_P95_BUDGET_MS:-5}"
YOUTUBE_URL="${LIVE_YOUTUBE_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dive-live.XXXXXX")"
SITE_DIR="${DATA_DIR}/site"
LOG="${REPO_ROOT}/target/live-check.log"
mkdir -p "${SITE_DIR}" "${REPO_ROOT}/target"

if [[ -n "${DIVE_BIN:-}" && -x "${DIVE_BIN}" ]]; then
    BIN="${DIVE_BIN}"
elif [[ -x "${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
elif [[ -x "${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
else
    echo "no Dive app bundle found; set DIVE_BIN" >&2
    exit 1
fi

fail() { echo "!! $*" >&2; plain_log | tail -30 >&2; exit 1; }
plain_log() { sed -e $'s/\x1b\[[0-9;]*m//g' "${LOG}"; }
mcp() { python3 "${MCP}" --data-dir "${DATA_DIR}" --port "${PORT}" "$@"; }
step() { echo ">> $*"; }
tab_state() {
    # Read the disposable profile without waking a discarded renderer.
    python3 - "${DATA_DIR}/dive.db" "$1" <<'PY'
import sqlite3, sys
with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as db:
    row = db.execute("SELECT state FROM tabs WHERE id = ?", (sys.argv[2],)).fetchone()
    print(row[0] if row else "missing")
PY
}

# Two pages on a local server, so nothing here depends on the network.
cat >"${SITE_DIR}/a.html" <<'HTML'
<!doctype html><title>Page A</title><body style="height:4000px"><h1>Page A</h1><p>alpha content</p></body>
HTML
cat >"${SITE_DIR}/b.html" <<'HTML'
<!doctype html><title>Page B</title><body><h1>Page B</h1><p>bravo content</p>
<a href="/popup.html" target="_blank">Open popup</a><button id="camera">Request camera</button><button id="microphone">Request microphone</button><output id="result"></output>
<script>
document.getElementById('camera').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(track => track.stop());
    result.textContent = 'camera request handled: allowed';
  } catch (error) {
    result.textContent = `camera request handled: ${error.name}`;
  }
};
document.getElementById('microphone').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    result.textContent = 'microphone request handled: allowed';
  } catch (error) {
    result.textContent = `microphone request handled: ${error.name}`;
  }
};
</script></body>
HTML
cat >"${SITE_DIR}/popup.html" <<'HTML'
<!doctype html><title>Popup</title><body><h1>Popup opened</h1></body>
HTML
cat >"${SITE_DIR}/offline.html" <<'HTML'
<!doctype html><title>Offline target</title><body><h1>Offline recovery target</h1></body>
HTML
python3 - "${SITE_DIR}/sample.pdf" <<'PY'
import pathlib, sys

objects = [
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
    b"4 0 obj<</Length 48>>stream\nBT /F1 18 Tf 40 80 Td (Dive PDF fixture) Tj ET\nendstream endobj\n",
    b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for obj in objects:
    offsets.append(len(pdf))
    pdf.extend(obj)
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode())
pdf.extend(b"0000000000 65535 f \n")
for offset in offsets:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode())
pathlib.Path(sys.argv[1]).write_bytes(pdf)
PY
python3 -u "${SCRIPT_DIR}/loopback_server.py" "${SITE_DIR}" >"${DATA_DIR}/http.log" 2>&1 &
HTTP=$!
for _ in $(seq 1 40); do
    SITE_PORT=$(sed -n 's/.*port \([0-9]*\).*/\1/p' "${DATA_DIR}/http.log" | head -1)
    [[ -n "${SITE_PORT}" ]] && break; sleep 0.25
done
[[ -n "${SITE_PORT:-}" ]] || { kill "${HTTP}"; fail "local http server did not start"; }
SITE="http://localhost:${SITE_PORT}"

cleanup() {
    if [[ -n "${TOOL_WAIT:-}" ]]; then
        kill "${TOOL_WAIT}" 2>/dev/null || true
        wait "${TOOL_WAIT}" 2>/dev/null || true
        TOOL_WAIT=""
    fi
    if [[ -n "${APP:-}" ]]; then
        kill "${APP}" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "${APP}" 2>/dev/null || break
            sleep 0.1
        done
        kill -9 "${APP}" 2>/dev/null || true
    fi
    if [[ -n "${HTTP:-}" ]]; then
        kill "${HTTP}" 2>/dev/null || true
        wait "${HTTP}" 2>/dev/null || true
        HTTP=""
    fi
    if [[ -n "${APP:-}" ]]; then
        wait "${APP}" 2>/dev/null || true
        APP=""
    fi
    rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

APP_ARGS=()
if [[ "$(uname -s)" == "Darwin" ]]; then
    APP_ARGS=(-ApplePersistenceIgnoreState YES)
fi
step "starting ${BIN}"
NO_COLOR=1 DIVE_USE_MOCK_KEYCHAIN=1 DIVE_SKIP_ONBOARDING=1 DIVE_DATA_DIR="${DATA_DIR}" DIVE_MCP_PORT="${PORT}" DIVE_OPEN_URL="${SITE}/a.html" \
DIVE_MAX_IDLE_SECS=0 DIVE_SWEEP_SECS="${DIVE_SWEEP_SECS:-2}" DIVE_DISCARD_LOCAL_TABS=1 DIVE_CDP_BENCH=1 DIVE_MCP_ALLOW_EVAL=1 \
DIVE_CHROMIUM_FLAGS="${DIVE_CHROMIUM_FLAGS:-} --disable-popup-blocking" RUST_LOG="${RUST_LOG:-info},dive_desktop_lib=info" \
    "${BIN}" "${APP_ARGS[@]}" >"${LOG}" 2>&1 &
APP=$!

for _ in $(seq 1 120); do
    if [[ -f "${DATA_DIR}/mcp-token" ]] && mcp list >/dev/null 2>&1; then break; fi
    kill -0 "${APP}" 2>/dev/null || fail "app exited during startup"
    sleep 0.5
done
mcp list >/dev/null 2>&1 || fail "MCP server never answered on ${PORT}"

step "tab opens and reads back"
TABS=$(mcp call tabs_list)
A_ID=$(python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin) if x["url"].endswith("a.html")]; print(t[0]["id"] if t else "")' <<<"${TABS}")
[[ -n "${A_ID}" ]] || fail "startup tab for a.html is missing: ${TABS}"
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 15000}" >/dev/null || fail "startup page A never loaded"
B=$(mcp call tab_open "{\"url\": \"${SITE}/b.html\"}")
B_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${B}")
mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null || fail "page B could not be activated"
mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"bravo content\", \"timeout_ms\": 15000}" >/dev/null || fail "page B never showed its text"
mcp call page_text "{\"tab_id\": \"${B_ID}\"}" | grep -q "bravo content" || fail "page_text for B is wrong"

step "screenshot comes back"
SHOT=""
for _ in $(seq 1 20); do
    SHOT=$(mcp call page_screenshot "{\"tab_id\": \"${B_ID}\"}") || fail "page screenshot failed"
    if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("image_bytes",0) > 1000, d' <<<"${SHOT}" 2>/dev/null; then
        break
    fi
    # DOM readiness can precede CEF's first composited frame on a cold launch.
    sleep 0.25
done
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("image_bytes",0) > 1000, d' <<<"${SHOT}" || fail "screenshot too small after first-frame wait: ${SHOT}"

if [[ "$(uname -s)" == "Darwin" ]]; then
    step "macOS confirms every owned renderer has entered its sandbox"
    python3 "${REPO_ROOT}/scripts/browser_sandbox.py" "${APP}" || fail "renderer sandbox verification failed"
fi

step "page popup opens as a real tab"
mcp call page_click "{\"tab_id\": \"${B_ID}\", \"locator\": \"role=link[name=\\\"Open popup\\\"]\"}" >/dev/null || fail "popup link could not be clicked"
for _ in $(seq 1 40); do
    TABS=$(mcp call tabs_list)
    POPUP_ID=$(python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin) if x["url"].endswith("popup.html")]; print(t[0]["id"] if t else "")' <<<"${TABS}")
    [[ -n "${POPUP_ID}" ]] && break; sleep 0.25
done
[[ -n "${POPUP_ID:-}" ]] || fail "window.open did not create a popup tab: ${TABS}"
mcp call tab_activate "{\"tab_id\": \"${POPUP_ID}\"}" >/dev/null || fail "popup tab could not be activated"
mcp call page_wait_for "{\"tab_id\": \"${POPUP_ID}\", \"text\": \"Popup opened\", \"timeout_ms\": 15000}" >/dev/null || fail "popup tab did not render"
mcp call tab_close "{\"tab_id\": \"${POPUP_ID}\"}" >/dev/null
mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null

# Native PermissionBridge allows 30 seconds for an undecided request.
# Observe its real fail-closed deadline; do not change the browser policy.
# macOS asks for its own camera and microphone consent before Chromium ever
# reaches Dive's handler, and that system prompt cannot be answered on a CI
# runner or for a freshly copied bundle, so the step runs only where that
# consent has already been given (LIVE_MEDIA_CONSENT=1).
if [[ "${LIVE_MEDIA_CONSENT:-0}" == "1" ]]; then
    step "undecided camera and microphone requests fail closed"
    mcp call page_click "{\"tab_id\": \"${B_ID}\", \"locator\": \"role=button[name=\\\"Request camera\\\"]\"}" >/dev/null || fail "camera button could not be clicked"
    mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"camera request handled: NotAllowedError\", \"timeout_ms\": 35000}" >/dev/null || fail "undecided camera request did not fail closed"
    mcp call page_click "{\"tab_id\": \"${B_ID}\", \"locator\": \"role=button[name=\\\"Request microphone\\\"]\"}" >/dev/null || fail "microphone button could not be clicked"
    mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"microphone request handled: NotAllowedError\", \"timeout_ms\": 35000}" >/dev/null || fail "undecided microphone request did not fail closed"
else
    step "camera and microphone fail-closed check skipped: set LIVE_MEDIA_CONSENT=1 on a Mac that has granted this bundle camera and microphone access"
fi

step "PDF renders in its own tab"
PDF=$(mcp call tab_open "{\"url\": \"${SITE}/sample.pdf\"}")
PDF_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${PDF}")
mcp call page_wait_for "{\"tab_id\": \"${PDF_ID}\", \"url_includes\": \"sample.pdf\", \"load\": true, \"timeout_ms\": 20000}" >/dev/null || fail "PDF did not finish loading"
PDF_SHOT=$(mcp call page_screenshot "{\"tab_id\": \"${PDF_ID}\"}")
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("image_bytes",0) > 1000, d' <<<"${PDF_SHOT}" || fail "PDF screenshot too small: ${PDF_SHOT}"
mcp call tab_close "{\"tab_id\": \"${PDF_ID}\"}" >/dev/null
mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null

step "offline navigation fails without taking down the tab, then recovers"
mcp call page_throttle "{\"tab_id\": \"${B_ID}\", \"profile\": \"offline\"}" >/dev/null
mcp call tab_navigate "{\"tab_id\": \"${B_ID}\", \"url\": \"${SITE}/offline.html\"}" >/dev/null || true
sleep 1
kill -0 "${APP}" || fail "the app exited during offline navigation"
mcp call page_throttle "{\"tab_id\": \"${B_ID}\", \"profile\": \"none\"}" >/dev/null
mcp call tab_navigate "{\"tab_id\": \"${B_ID}\", \"url\": \"${SITE}/b.html\"}" >/dev/null || fail "navigation did not recover after clearing offline mode"
mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"bravo content\", \"timeout_ms\": 15000}" >/dev/null || fail "tab did not recover after offline navigation"

if [[ "${LIVE_SKIP_YOUTUBE:-0}" != "1" ]]; then
    step "YouTube video reaches playback"
    # Let the startup CDP probe finish before loading a deliberately heavy external
    # page, so its latency number measures Dive rather than YouTube's renderer work.
    for _ in $(seq 1 40); do
        plain_log | grep -q "cdp bench:" && break; sleep 0.25
    done
    YOUTUBE=$(mcp call tab_open "{\"url\": \"${YOUTUBE_URL}\"}") || fail "YouTube tab could not be opened"
    YOUTUBE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${YOUTUBE}")
    mcp call tab_activate "{\"tab_id\": \"${YOUTUBE_ID}\"}" >/dev/null || fail "YouTube tab could not be activated"
    mcp call page_wait_for "{\"tab_id\": \"${YOUTUBE_ID}\", \"locator\": \"video\", \"load\": true, \"timeout_ms\": 45000}" >/dev/null || fail "YouTube video element did not load"
    # Use the persistent transport control: the large aria-label="Play" overlay
    # can disappear between discovery and click during player initialization.
    # A script-level play() during YouTube initialization can be immediately
    # cancelled by the player. Exercise its visible control and require actual
    # sustained playback; a fraction of a second before pausing is not success.
    mcp call page_wait_for "{\"tab_id\": \"${YOUTUBE_ID}\", \"locator\": \"css=.ytp-play-button\", \"timeout_ms\": 15000}" >/dev/null || fail "YouTube Play control did not become available"
    mcp call page_evaluate "{\"tab_id\": \"${YOUTUBE_ID}\", \"expression\": \"document.querySelector('video').muted=true\"}" >/dev/null || fail "could not mute the test video"
    mcp call page_click "{\"tab_id\": \"${YOUTUBE_ID}\", \"locator\": \"css=.ytp-play-button\"}" >/dev/null || fail "YouTube Play control could not be clicked"
    PLAYBACK=$(mcp call page_evaluate "{\"tab_id\": \"${YOUTUBE_ID}\", \"expression\": \"(async()=>{const v=document.querySelector('video');if(!v)throw new Error('video missing');const start=v.currentTime;const end=performance.now()+10000;while(performance.now()<end){if(document.querySelector('video')!==v)throw new Error('player replaced video during verification');if(v.currentTime>start+1.5&&v.readyState>=2&&!v.paused)return {advanced:true,currentTime:v.currentTime,readyState:v.readyState,paused:v.paused};await new Promise(r=>setTimeout(r,100))}return {advanced:false,currentTime:v.currentTime,readyState:v.readyState,paused:v.paused,error:v.error?.message}})()\"}") || fail "YouTube playback evaluation failed"
    python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["advanced"] and v["readyState"] >= 2 and not v["paused"], v' <<<"${PLAYBACK}" || fail "YouTube did not sustain playback: ${PLAYBACK}"
    echo "   ${PLAYBACK}"
    mcp call tab_close "{\"tab_id\": \"${YOUTUBE_ID}\"}" >/dev/null
    mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null
fi

step "an in-flight tool protects its background tab until completion"
mcp call tab_activate "{\"tab_id\": \"${A_ID}\"}" >/dev/null || fail "could not prepare tab A for tool protection probe"
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 15000}" >/dev/null || fail "tool protection page did not load"
mcp call page_evaluate "{\"tab_id\": \"${A_ID}\", \"expression\": \"new Promise(resolve => { window.__diveLeaseProbeStarted = true; setTimeout(() => resolve('lease complete'), 12000); })\"}" >"${DATA_DIR}/tool-wait.json" 2>&1 &
TOOL_WAIT=$!
STARTED="false"
for _ in $(seq 1 20); do
    STARTED=$(mcp call page_evaluate "{\"tab_id\": \"${A_ID}\", \"expression\": \"window.__diveLeaseProbeStarted === true\"}") || fail "tool protection handshake failed"
    [[ "${STARTED}" == "true" ]] && break
    sleep 0.1
done
[[ "${STARTED}" == "true" ]] || fail "long-running tool did not start"
mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null || fail "could not background the protected tab"
sleep 3
kill -0 "${TOOL_WAIT}" 2>/dev/null || fail "tool completed before its protection could be checked"
[[ "$(tab_state "${A_ID}")" == "active" ]] || fail "in-flight tool's renderer was discarded"
wait "${TOOL_WAIT}" || fail "protected tool did not finish: $(cat "${DATA_DIR}/tool-wait.json")"
TOOL_WAIT=""
python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == "lease complete"' "${DATA_DIR}/tool-wait.json" || fail "protected tool returned an unexpected result"

step "background tab is discarded after the tool, then wakes on activation"
for _ in $(seq 1 30); do
    [[ "$(tab_state "${A_ID}")" == "discarded" ]] && break; sleep 0.5
done
[[ "$(tab_state "${A_ID}")" == "discarded" ]] || fail "sweep never discarded background tab A"
mcp call tab_activate "{\"tab_id\": \"${A_ID}\"}" >/dev/null || fail "waking tab A failed"
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 15000}" >/dev/null || fail "tab A did not come back with its page"

step "in-process CDP latency"
for _ in $(seq 1 40); do
    plain_log | grep -q "cdp bench:" && break; sleep 0.5
done
BENCH=$(plain_log | grep "cdp bench:" | tail -1)
[[ -n "${BENCH}" ]] || fail "no CDP benchmark line in the log"
echo "   ${BENCH#*cdp bench: }"
P95=$(sed -n 's/.*p95_ms=\([0-9.]*\).*/\1/p' <<<"${BENCH}")
python3 -c "import sys; sys.exit(0 if float('${P95}') <= float('${CDP_P95_BUDGET_MS}') else 1)" || fail "CDP p95 ${P95} ms is over the ${CDP_P95_BUDGET_MS} ms budget"

# Finish this fixture before the native qualification creates its own profile.
# Its normal-exit/helper-drain checks are independent of this shell cleanup.
cleanup
trap - EXIT
step "isolated renderer crash, unchanged controls, and native lifecycle"
DIVE_CRASH_PROBE=1 DIVE_BIN="${BIN}" python3 "${SCRIPT_DIR}/native_lifecycle_check.py"
echo ">> live check passed"
