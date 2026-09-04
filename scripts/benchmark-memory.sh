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
# An explicit URL list remains useful for profiling real sites. By default the
# harness supplies distinct loopback sites so TLS, DNS, and the public network
# cannot turn the memory signal into noise.
URL="${STRESS_URL:-}"
LAUNCH_ENV=()
SETTLE="${STRESS_SETTLE_SECS:-15}"
MIN_RECLAIM="${MEM_MIN_RECLAIM_PCT:-30}"
OUT="${REPO_ROOT}/target/memory-benchmark.json"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dive-stress.XXXXXX")"
LOG="${REPO_ROOT}/target/memory-benchmark.log"
mkdir -p "${REPO_ROOT}/target"
APP=""
FIXTURE=""

cleanup() {
    [[ -z "${APP}" ]] || kill "${APP}" 2>/dev/null || true
    [[ -z "${FIXTURE}" ]] || kill "${FIXTURE}" 2>/dev/null || true
    [[ -z "${APP}" ]] || wait "${APP}" 2>/dev/null || true
    [[ -z "${FIXTURE}" ]] || wait "${FIXTURE}" 2>/dev/null || true
    rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

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

if [[ -z "${URL}" ]]; then
    FIXTURE_PORT_FILE="${DATA_DIR}/fixture.port"
    python3 -u "${SCRIPT_DIR}/memory-fixture.py" >"${FIXTURE_PORT_FILE}" 2>"${DATA_DIR}/fixture.log" &
    FIXTURE=$!
    for _ in $(seq 1 40); do
        FIXTURE_PORT=$(sed -n '1p' "${FIXTURE_PORT_FILE}")
        [[ -n "${FIXTURE_PORT}" ]] && break
        kill -0 "${FIXTURE}" 2>/dev/null || { sed -n '1,80p' "${DATA_DIR}/fixture.log" >&2; exit 1; }
        sleep 0.1
    done
    [[ -n "${FIXTURE_PORT:-}" ]] || { echo "!! memory fixture did not start" >&2; exit 1; }
    for i in $(seq 1 "${TABS}"); do
        URL+="http://127.0.0.1:${FIXTURE_PORT}/tab-${i} "
    done
    LAUNCH_ENV+=("DIVE_DEFAULT_PROCESS_MODEL=1" "DIVE_CHROMIUM_FLAGS=${DIVE_CHROMIUM_FLAGS:-} --process-per-tab")
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
env "${LAUNCH_ENV[@]}" DIVE_DATA_DIR="${DATA_DIR}" DIVE_MCP_PORT="${STRESS_MCP_PORT:-0}" \
DIVE_STRESS_TABS="${TABS}" DIVE_STRESS_SETTLE_SECS="${SETTLE}" DIVE_STRESS_URLS="${URL}" \
DIVE_MAX_IDLE_SECS=0 DIVE_SWEEP_SECS=3600 DIVE_DISCARD_LOCAL_TABS=1 RUST_LOG="${RUST_LOG:-info},dive_desktop_lib=info" \
    NO_COLOR=1 "${BIN}" >"${LOG}" 2>&1 &
APP=$!

# Several samples a second apart, keeping the extreme: memory keeps climbing
# for a moment after pages load and keeps falling after their renderers go.
sample_max() { local best=0 v; for _ in 1 2 3; do v=$(tree_rss "$1"); [[ ${v} -gt ${best} ]] && best=${v}; sleep 1; done; echo "${best}"; }
sample_min() { local best="" v; for _ in 1 2 3 4; do v=$(tree_rss "$1"); [[ -z ${best} || ${v} -lt ${best} ]] && best=${v}; sleep 1; done; echo "${best}"; }

baseline=""; loaded=""; swept=""; tabs=""; discarded=""
deadline=$(( $(date +%s) + SETTLE + 90 ))
while kill -0 "${APP}" 2>/dev/null && [[ $(date +%s) -lt ${deadline} ]]; do
    if [[ -z "${baseline}" ]] && plain_log | grep -q "stress: baseline"; then
        baseline=$(tree_rss "${APP}"); echo "   baseline  ${baseline} KB"
    fi
    if [[ -z "${loaded}" ]] && plain_log | grep -q "stress: loaded"; then
        loaded=$(sample_max "${APP}"); tabs=$(plain_log | sed -n 's/.*stress: loaded.*tabs=\([0-9]*\).*/\1/p' | tail -1)
        echo "   loaded    ${loaded} KB (${tabs} tabs)"
    fi
    if [[ -z "${swept}" ]] && plain_log | grep -q "stress: done"; then
        swept=$(sample_min "${APP}"); discarded=$(plain_log | sed -n 's/.*stress: swept.*discarded=\([0-9]*\).*/\1/p' | tail -1)
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
[[ ${pct} -ge ${MIN_RECLAIM} ]] || { echo "!! reclaimed less than ${MIN_RECLAIM}%" >&2; exit 3; }
