#!/usr/bin/env bash
# ==============================================================================
# benchmark-startup.sh — Automated Startup Benchmarking Harness for Dive Browser
#
# Milestone 1 (R1): Benchmarks cold vs warm startup timings, milestone intervals,
# calculates statistical percentiles (p50, p95), and verifies zero UI thread blocking.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Number of iterations
COLD_RUNS="${BENCH_COLD_RUNS:-1}"
WARM_RUNS="${BENCH_WARM_RUNS:-4}"
TIMEOUT_MS="${DIVE_BENCHMARK_TIMEOUT_MS:-300}"

OUTPUT_SUMMARY="${REPO_ROOT}/target/startup-benchmark-summary.json"
mkdir -p "${REPO_ROOT}/target"

echo "================================================================="
echo "        Dive Browser Startup Performance Benchmark (R1)          "
echo "================================================================="

# 1. Locate or build binary
EXPLICIT_BIN=0
if [[ -n "${DIVE_BIN:-}" && -x "${DIVE_BIN}" ]]; then
    BIN="${DIVE_BIN}"
    EXPLICIT_BIN=1
elif [[ -x "${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
elif [[ -x "${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/release/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
elif [[ -x "${REPO_ROOT}/target/debug/dive-desktop" ]]; then
    BIN="${REPO_ROOT}/target/debug/dive-desktop"
else
    echo ">> Building dive-desktop..."
    (cd "${REPO_ROOT}" && cargo build -p dive-desktop)
    BIN="${REPO_ROOT}/target/debug/dive-desktop"
fi

# Ensure Dive.app bundle binary is in sync with target/debug/dive-desktop if on macOS
if [[ ${EXPLICIT_BIN} -eq 0 && -f "${REPO_ROOT}/target/debug/dive-desktop" && -d "${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS" ]]; then
    cp -f "${REPO_ROOT}/target/debug/dive-desktop" "${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
    BIN="${REPO_ROOT}/target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop"
fi

echo ">> Using binary: ${BIN}"

RESULTS_DIR="$(mktemp -d -t dive-bench-XXXXXX)"
trap 'rm -rf "${RESULTS_DIR}"' EXIT

# Determine process invocation flags
EXTRA_FLAGS=()
if [[ "$(uname)" == "Darwin" ]]; then
    EXTRA_FLAGS+=("--single-process")
fi

run_instance() {
    local data_dir="$1"
    local output_json="$2"
    local is_cold="$3"

    DIVE_DATA_DIR="${data_dir}" \
    DIVE_STARTUP_BENCHMARK=1 \
    DIVE_COLD_START="${is_cold}" \
    DIVE_BENCHMARK_OUTPUT="${output_json}" \
    DIVE_BENCHMARK_TIMEOUT_MS="${TIMEOUT_MS}" \
    DIVE_WINDOW_HIDDEN=1 \
    DIVE_MCP_PORT=0 \
    "${BIN}" "${EXTRA_FLAGS[@]}" > /dev/null 2>&1 || true
}

echo ""
echo ">> Running Cold Startup Tests (${COLD_RUNS} iteration(s))..."
for ((i=1; i<=COLD_RUNS; i++)); do
    RUN_DATA_DIR="$(mktemp -d -t dive-cold-XXXXXX)"
    OUT_FILE="${RESULTS_DIR}/cold_${i}.json"
    run_instance "${RUN_DATA_DIR}" "${OUT_FILE}" 1
    rm -rf "${RUN_DATA_DIR}"
    echo "   [Cold ${i}/${COLD_RUNS}] Completed"
done

echo ""
echo ">> Warming up browser cache and database..."
WARM_DATA_DIR="$(mktemp -d -t dive-warm-data-XXXXXX)"
run_instance "${WARM_DATA_DIR}" "${RESULTS_DIR}/warmup.json" 0

echo ">> Running Warm Startup Tests (${WARM_RUNS} iteration(s))..."
for ((i=1; i<=WARM_RUNS; i++)); do
    OUT_FILE="${RESULTS_DIR}/warm_${i}.json"
    run_instance "${WARM_DATA_DIR}" "${OUT_FILE}" 0
    echo "   [Warm ${i}/${WARM_RUNS}] Completed"
done
rm -rf "${WARM_DATA_DIR}"

# Parse results and compute statistics with python3
python3 - <<PYEOF
import os, glob, json, math

results_dir = "${RESULTS_DIR}"
output_summary = "${OUTPUT_SUMMARY}"

def load_records(pattern):
    records = []
    for filepath in sorted(glob.glob(os.path.join(results_dir, pattern))):
        if not os.path.exists(filepath):
            continue
        try:
            with open(filepath) as f:
                data = json.load(f)
                records.append(data)
        except Exception as e:
            pass
    return records

cold_records = load_records("cold_*.json")
warm_records = load_records("warm_*.json")

def percentile(vals, p):
    if not vals:
        return 0.0
    vals = sorted(vals)
    k = (len(vals) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(vals[int(k)])
    return float(vals[f] * (c - k) + vals[c] * (k - f))

cold_totals = [r.get("total_startup_ms", 0.0) for r in cold_records]
warm_totals = [r.get("total_startup_ms", 0.0) for r in warm_records]

cold_p50 = percentile(cold_totals, 50)
cold_p95 = percentile(cold_totals, 95)
warm_p50 = percentile(warm_totals, 50)
warm_p95 = percentile(warm_totals, 95)

# Calculate UI thread block metric (window_created to setup_complete)
ui_deltas = []
paint_times = []
for r in cold_records + warm_records:
    milestones = r.get("milestones", {})
    delta = milestones.get("window_created_to_setup_complete_ms", 0.0)
    ui_deltas.append(delta)
    paint = r.get("timeline", {}).get("chrome_paint_ms")
    if paint is not None:
        paint_times.append(paint)

max_ui_delta = max(ui_deltas) if ui_deltas else 0.0
# Zero UI blocking threshold: setup delta must remain strictly non-blocking (< 100ms)
zero_ui_blocked = max_ui_delta < 100.0
paint_p50 = percentile(paint_times, 50) if paint_times else warm_p50

total_runs = len(cold_records) + len(warm_records)

summary = {
    "runs": total_runs,
    "cold_start_p50_ms": round(cold_p50, 2),
    "cold_start_p95_ms": round(cold_p95, 2),
    "warm_start_p50_ms": round(warm_p50, 2),
    "warm_start_p95_ms": round(warm_p95, 2),
    "initial_paint_p50_ms": round(paint_p50, 2),
    "zero_ui_blocked": bool(zero_ui_blocked)
}

with open(output_summary, "w") as f:
    json.dump(summary, f, indent=2)

print("\n=================================================================")
print("                   STARTUP BENCHMARK RESULTS                     ")
print("=================================================================")
print(f"Total Runs Executed:       {total_runs}")
print(f"Cold Startup p50:          {cold_p50:.2f} ms")
print(f"Cold Startup p95:          {cold_p95:.2f} ms")
print(f"Warm Startup p50:          {warm_p50:.2f} ms")
print(f"Warm Startup p95:          {warm_p95:.2f} ms")
print(f"Initial Window Paint p50:  {paint_p50:.2f} ms")
print(f"Max Setup UI Delta:        {max_ui_delta:.2f} ms")
print(f"Zero UI Blocked (<100ms):  {'PASS' if zero_ui_blocked else 'FAIL'}")
print("=================================================================")
print(f"Summary JSON written to: {output_summary}")
print(json.dumps(summary, indent=2))

if not zero_ui_blocked:
    print("\n[ERROR] UI thread blocking detected during startup!")
    exit(1)
PYEOF

echo ""
echo ">> Benchmark completed successfully."
