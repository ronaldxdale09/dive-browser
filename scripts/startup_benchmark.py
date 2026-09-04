#!/usr/bin/env python3
"""Measure complete launches of the shipping runtime; reject missing evidence."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from probe_process import run_probe

ROOT = Path(__file__).resolve().parent.parent


def positive(name, default, integer=False):
    raw = os.environ.get(name, str(default))
    value = int(raw) if integer else float(raw)
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be positive and finite')
    return value


def number(record, key):
    value = record.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'missing or invalid {key}')
    return value


def read_record(path):
    with path.open() as source:
        record = json.load(source)
    timeline = record['timeline']
    milestones = record['milestones']
    state = number(timeline, 'state_init_ms')
    window = number(timeline, 'window_created_ms')
    setup = number(timeline, 'setup_complete_ms')
    paint = number(timeline, 'chrome_paint_ms')
    controls = number(milestones, 'controls_ready')
    total = number(record, 'total_startup_ms')
    number(milestones, 'window_created_to_setup_complete_ms')
    if not (0 <= state <= window <= setup <= controls and window <= paint <= controls <= total and paint > 0):
        raise ValueError('startup milestones are incomplete or out of order')
    return record


def percentile(values, fraction):
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (index - low), 2)


def main():
    target = ROOT / 'target'
    target.mkdir(exist_ok=True)
    summary_path = target / 'startup-benchmark-summary.json'
    # A failed new run must not leave a prior green summary looking current.
    summary_path.unlink(missing_ok=True)
    cold_count = positive('BENCH_COLD_RUNS', 3, True)
    warm_count = positive('BENCH_WARM_RUNS', 5, True)
    timeout = positive('DIVE_PROBE_TIMEOUT_SECS', 20)
    explicit = os.environ.get('DIVE_BIN')
    if explicit:
        binary = Path(explicit).resolve()
    else:
        candidates = [target / f'{kind}/bundle/macos/Dive.app/Contents/MacOS/dive-desktop' for kind in ('release', 'debug')]
        binary = next((p for p in candidates if p.is_file()), None)
    if binary is None or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('set DIVE_BIN to an existing executable app bundle')
    fingerprint = hashlib.sha256(binary.read_bytes()).hexdigest()
    results = Path(os.environ.get('DIVE_BENCHMARK_RESULTS_DIR', str(target / f'startup-probes-{time.time_ns()}'))).resolve()
    results.mkdir(parents=True, exist_ok=False)
    print(f'Executable: {binary}\nProbe evidence: {results}', flush=True)

    def launch(profile, name, cold):
        report = results / f'{name}.json'
        env = {**os.environ, 'DIVE_DATA_DIR': str(profile), 'DIVE_MCP_PORT': '0', 'DIVE_USE_MOCK_KEYCHAIN': '1',
               'DIVE_STARTUP_BENCHMARK': '1', 'DIVE_COLD_START': str(int(cold)),
               'DIVE_BENCHMARK_OUTPUT': str(report),
               'DIVE_BENCHMARK_TIMEOUT_MS': os.environ.get('DIVE_BENCHMARK_TIMEOUT_MS', '10000')}
        # Paint is intentionally visible; a hidden renderer cannot prove first paint.
        for key in ('DIVE_WINDOW_HIDDEN', 'DIVE_STRESS_TABS', 'DIVE_SMOKE', 'DIVE_NATIVE_LIFECYCLE_PROBE'):
            env.pop(key, None)
        run_probe(binary, env, results / f'{name}.log', timeout)
        value = read_record(report)
        print(f'{name}: {value["total_startup_ms"]:.2f} ms; process exited normally', flush=True)
        return value

    cold = []
    for index in range(cold_count):
        with tempfile.TemporaryDirectory(prefix='dive-cold-') as profile:
            cold.append(launch(profile, f'cold-{index+1}', True))
    with tempfile.TemporaryDirectory(prefix='dive-warm-') as profile:
        launch(profile, 'warmup', False)
        warm = [launch(profile, f'warm-{index+1}', False) for index in range(warm_count)]
    records = cold + warm
    setup_deltas = [r['milestones']['window_created_to_setup_complete_ms'] for r in records]
    summary = {
        'runs': len(records), 'cold_runs': len(cold), 'warm_runs': len(warm),
        'cold_start_p50_ms': percentile([r['total_startup_ms'] for r in cold], .5),
        'cold_start_p95_ms': percentile([r['total_startup_ms'] for r in cold], .95),
        'warm_start_p50_ms': percentile([r['total_startup_ms'] for r in warm], .5),
        'warm_start_p95_ms': percentile([r['total_startup_ms'] for r in warm], .95),
        'initial_paint_p50_ms': percentile([r['timeline']['chrome_paint_ms'] for r in records], .5),
        'controls_ready_p95_ms': percentile([r['milestones']['controls_ready'] for r in records], .95),
        'max_setup_interval_ms': max(setup_deltas),
        'binary': str(binary), 'binary_sha256': fingerprint, 'evidence': str(results),
        'process_overrides': {key: os.environ.get(key) for key in ('DIVE_CHROMIUM_FLAGS', 'DIVE_DEFAULT_PROCESS_MODEL', 'DIVE_RENDERER_PROCESS_LIMIT')},
        'note': 'Setup interval is not a measurement of UI thread blocking.'
    }
    if hashlib.sha256(binary.read_bytes()).hexdigest() != fingerprint:
        raise ValueError('binary changed during measurement')
    temporary = summary_path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(summary, indent=2) + '\n')
    temporary.replace(summary_path)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'Startup benchmark FAILED: {error}', file=sys.stderr)
        sys.exit(1)
