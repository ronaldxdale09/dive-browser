#!/usr/bin/env bash
# benchmark-memory.sh — 20-tab memory stress for Dive.
#
# Launches the app with DIVE_STRESS_TABS, samples resident memory of the whole
# process tree (browser, GPU, renderers, helpers) at the markers the app logs
# (baseline, loaded, swept), and writes target/memory-benchmark.json.
# Fails when the sweep reclaims less than MEM_MIN_RECLAIM_PCT of the growth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TABS="${STRESS_TABS:-20}"
# Distinct sites: with --process-per-site, same-site tabs share one renderer.
URL="${STRESS_URL:-https://example.com https://example.org https://www.iana.org https://www.wikipedia.org https://www.mozilla.org https://www.rust-lang.org https://tauri.app https://developer.mozilla.org https://www.w3.org https://www.gnu.org https://www.kernel.org https://www.python.org https://nodejs.org https://www.debian.org https://www.apache.org https://www.eff.org https://www.chromium.org https://www.sqlite.org https://www.openssl.org https://www.postgresql.org}"
SETTLE="${STRESS_SETTLE_SECS:-15}"
MIN_RECLAIM="${MEM_MIN_RECLAIM_PCT:-30}"
OUT="${REPO_ROOT}/target/memory-benchmark.json"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dive-stress.XXXXXX")"
LOG="${REPO_ROOT}/target/memory-benchmark.log"
mkdir -p "${REPO_ROOT}/target"

if [[ -n "${DIVE_BIN:-}" && -x "${DIVE_BIN}" ]]; then
    BIN="${DIVE_BIN}"
elif [[ -x "${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
elif [[ -x "${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
else
    echo "no Dive binary found; set DIVE_BIN or build the app" >&2
    exit 1
fi

# The app log without colour codes.
plain_log() { sed -e $'s/\x1b\[[0-9;]*m//g' "${LOG}"; }

# Resident memory in KB of a process and all of its descendants.
tree_rss() {
    local root="$1"
    ps -axo pid=,ppid=,rss= | awk -v root="$root" '
        { pid[NR]=$1; ppid[NR]=$2; rss[NR]=$3 }
        END {
            want[root]=1; changed=1
            while (changed) { changed=0
                for (i=1;i<=NR;i++) if (!(pid[i] in want) && (ppid[i] in want)) { want[pid[i]]=1; changed=1 } }
            total=0; for (i=1;i<=NR;i++) if (pid[i] in want) total+=rss[i]
            print total }'
}

echo ">> ${TABS} tabs on ${URL}, settle ${SETTLE}s, data dir ${DATA_DIR}"
DIVE_DATA_DIR="${DATA_DIR}" DIVE_MCP_PORT="${STRESS_MCP_PORT:-0}" \
DIVE_STRESS_TABS="${TABS}" DIVE_STRESS_SETTLE_SECS="${SETTLE}" DIVE_STRESS_URLS="${URL}" \
DIVE_MAX_IDLE_SECS=0 DIVE_SWEEP_SECS=3600 RUST_LOG="${RUST_LOG:-info}" \
    NO_COLOR=1 "${BIN}" >"${LOG}" 2>&1 &
APP=$!

baseline=""; loaded=""; swept=""; tabs=""; discarded=""
deadline=$(( $(date +%s) + SETTLE + 90 ))
while kill -0 "${APP}" 2>/dev/null && [[ $(date +%s) -lt ${deadline} ]]; do
    if [[ -z "${baseline}" ]] && plain_log | grep -q "stress: baseline"; then
        baseline=$(tree_rss "${APP}"); echo "   baseline  ${baseline} KB"
    fi
    if [[ -z "${loaded}" ]] && plain_log | grep -q "stress: loaded"; then
        loaded=$(tree_rss "${APP}"); tabs=$(plain_log | sed -n 's/.*stress: loaded.*tabs=\([0-9]*\).*/\1/p' | tail -1)
        echo "   loaded    ${loaded} KB (${tabs} tabs)"
    fi
    if [[ -z "${swept}" ]] && plain_log | grep -q "stress: done"; then
        swept=$(tree_rss "${APP}"); discarded=$(plain_log | sed -n 's/.*stress: swept.*discarded=\([0-9]*\).*/\1/p' | tail -1)
        echo "   swept     ${swept} KB (${discarded} discarded)"
        break
    fi
    sleep 0.5
done
wait "${APP}" || true

if [[ -z "${baseline}" || -z "${loaded}" || -z "${swept}" ]]; then
    echo "!! markers missing; see ${LOG}" >&2
    plain_log | tail -20 >&2
    exit 1
fi
growth=$(( loaded - baseline ))
reclaimed=$(( loaded - swept ))
pct=0; [[ ${growth} -gt 0 ]] && pct=$(( reclaimed * 100 / growth ))
cat >"${OUT}" <<JSON
{
  "tabs": ${tabs:-0},
  "discarded": ${discarded:-0},
  "baseline_rss_kb": ${baseline},
  "loaded_rss_kb": ${loaded},
  "swept_rss_kb": ${swept},
  "reclaimed_kb": ${reclaimed},
  "reclaimed_pct_of_growth": ${pct}
}
JSON
echo ">> reclaimed ${reclaimed} KB (${pct}% of growth); summary at ${OUT}"
cat "${OUT}"
rm -rf "${DATA_DIR}"
[[ ${pct} -ge ${MIN_RECLAIM} ]] || { echo "!! reclaimed less than ${MIN_RECLAIM}%" >&2; exit 3; }
