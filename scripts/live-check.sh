#!/usr/bin/env bash
# live-check.sh — drive the real Dive app end to end through its MCP server.
#
# Starts a private instance against a local HTTP server, then checks: a tab
# opens and its text reads back; a screenshot comes back; a background tab is
# discarded by the sweep and wakes with its page on activation; killing the
# renderer process recovers the tab in place without touching its sibling;
# and the in-process CDP round trip stays inside its budget.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP="${SCRIPT_DIR}/mcp-call.py"
PORT="${LIVE_MCP_PORT:-7493}"
CDP_P95_BUDGET_MS="${CDP_P95_BUDGET_MS:-5}"
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

# Two pages on a local server, so nothing here depends on the network.
cat >"${SITE_DIR}/a.html" <<'HTML'
<!doctype html><title>Page A</title><body style="height:4000px"><h1>Page A</h1><p>alpha content</p></body>
HTML
cat >"${SITE_DIR}/b.html" <<'HTML'
<!doctype html><title>Page B</title><body><h1>Page B</h1><p>bravo content</p></body>
HTML
python3 -u -m http.server --bind 127.0.0.1 0 --directory "${SITE_DIR}" >"${DATA_DIR}/http.log" 2>&1 &
HTTP=$!
for _ in $(seq 1 40); do
    SITE_PORT=$(sed -n 's/.*port \([0-9]*\).*/\1/p' "${DATA_DIR}/http.log" | head -1)
    [[ -n "${SITE_PORT}" ]] && break; sleep 0.25
done
[[ -n "${SITE_PORT:-}" ]] || { kill "${HTTP}"; fail "local http server did not start"; }
SITE="http://127.0.0.1:${SITE_PORT}"

cleanup() {
    kill "${APP:-}" 2>/dev/null || true
    kill "${HTTP}" 2>/dev/null || true
    wait "${APP:-}" 2>/dev/null || true
    rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

step "starting ${BIN}"
NO_COLOR=1 DIVE_DATA_DIR="${DATA_DIR}" DIVE_MCP_PORT="${PORT}" DIVE_OPEN_URL="${SITE}/a.html" \
DIVE_MAX_IDLE_SECS=0 DIVE_SWEEP_SECS=2 DIVE_DISCARD_LOCAL_TABS=1 DIVE_CDP_BENCH=1 RUST_LOG="${RUST_LOG:-info}" \
    "${BIN}" >"${LOG}" 2>&1 &
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
B=$(mcp call tab_open "{\"url\": \"${SITE}/b.html\"}")
B_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${B}")
mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"bravo content\", \"timeout_ms\": 15000}" >/dev/null || fail "page B never showed its text"
mcp call page_text "{\"tab_id\": \"${B_ID}\"}" | grep -q "bravo content" || fail "page_text for B is wrong"

step "screenshot comes back"
SHOT=$(mcp call page_screenshot "{\"tab_id\": \"${B_ID}\"}")
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("image_bytes",0) > 1000, d' <<<"${SHOT}" || fail "screenshot too small: ${SHOT}"

step "background tab is discarded, then wakes on activation"
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 15000}" >/dev/null || fail "page A never loaded"
for _ in $(seq 1 30); do
    plain_log | grep -q "discarded idle tabs" && break; sleep 0.5
done
plain_log | grep -q "discarded idle tabs" || fail "sweep never discarded the background tab"
mcp call tab_activate "{\"tab_id\": \"${A_ID}\"}" >/dev/null || fail "waking tab A failed"
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 15000}" >/dev/null || fail "tab A did not come back with its page"

step "renderer crash recovers in place, sibling untouched"
mcp call tab_activate "{\"tab_id\": \"${B_ID}\"}" >/dev/null
RENDERERS=$(ps -axo pid=,ppid=,comm= | awk -v root="${APP}" '$2==root && /Helper \(Renderer\)/ {print $1}')
[[ -n "${RENDERERS}" ]] || fail "no renderer helper processes found under ${APP}"
kill -9 ${RENDERERS}
for _ in $(seq 1 40); do
    plain_log | grep -q "renderer crashed; reloading" && break; sleep 0.25
done
plain_log | grep -q "renderer crashed; reloading" || fail "crash was never noticed"
sleep 2
mcp call page_wait_for "{\"tab_id\": \"${B_ID}\", \"text\": \"bravo content\", \"timeout_ms\": 20000}" >/dev/null || fail "tab B did not recover after its renderer died"
mcp call tab_activate "{\"tab_id\": \"${A_ID}\"}" >/dev/null
mcp call page_wait_for "{\"tab_id\": \"${A_ID}\", \"text\": \"alpha content\", \"timeout_ms\": 20000}" >/dev/null || fail "sibling tab A was disturbed by the crash"
kill -0 "${APP}" || fail "the app itself went down with the renderer"

step "in-process CDP latency"
for _ in $(seq 1 40); do
    plain_log | grep -q "cdp bench:" && break; sleep 0.5
done
BENCH=$(plain_log | grep "cdp bench:" | tail -1)
[[ -n "${BENCH}" ]] || fail "no CDP benchmark line in the log"
echo "   ${BENCH#*cdp bench: }"
P95=$(sed -n 's/.*p95_ms=\([0-9.]*\).*/\1/p' <<<"${BENCH}")
python3 -c "import sys; sys.exit(0 if float('${P95}') <= float('${CDP_P95_BUDGET_MS}') else 1)" || fail "CDP p95 ${P95} ms is over the ${CDP_P95_BUDGET_MS} ms budget"

echo ">> live check passed"
