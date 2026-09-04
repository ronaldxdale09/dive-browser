#!/usr/bin/env python3
"""Sample the normal browser process tree and require a clean completed run."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from probe_process import run_probe, stop_group
from startup_benchmark import positive

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r'\x1b\[[0-9;]*m')


def tree_rss(pid):
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True, timeout=2)
    rows = [tuple(map(int, line.split())) for line in output.splitlines() if line.strip()]
    wanted = {pid}
    while True:
        descendants = {child for child, parent, _ in rows if parent in wanted}
        if descendants <= wanted:
            break
        wanted |= descendants
    return sum(rss for child, _, rss in rows if child in wanted)


def main():
    target = ROOT / 'target'
    target.mkdir(exist_ok=True)
    summary_path = target / 'memory-benchmark.json'
    summary_path.unlink(missing_ok=True)
    tabs = positive('STRESS_TABS', 20, True)
    settle = positive('STRESS_SETTLE_SECS', 15, True)
    timeout = positive('DIVE_PROBE_TIMEOUT_SECS', 2 * settle + tabs + 60)
    minimum = float(os.environ.get('MEM_MIN_RECLAIM_PCT', '30'))
    if not 0 <= minimum <= 100:
        raise ValueError('MEM_MIN_RECLAIM_PCT must be between 0 and 100')
    explicit = os.environ.get('DIVE_BIN')
    binary = Path(explicit).resolve() if explicit else next((target / f'{kind}/bundle/macos/Dive.app/Contents/MacOS/dive-desktop' for kind in ('release', 'debug') if (target / f'{kind}/bundle/macos/Dive.app/Contents/MacOS/dive-desktop').is_file()), None)
    if binary is None or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('set DIVE_BIN to an existing executable app bundle')
    fingerprint = hashlib.sha256(binary.read_bytes()).hexdigest()
    evidence = target / f'memory-probe-{time.time_ns()}'
    evidence.mkdir()
    log = evidence / 'browser.log'
    fixture = None
    with tempfile.TemporaryDirectory(prefix='dive-stress-') as profile:
        try:
            urls = os.environ.get('STRESS_URL', '').strip()
            if not urls:
                port_file = evidence / 'fixture.port'
                with port_file.open('w') as port, (evidence / 'fixture.log').open('w') as err:
                    fixture = subprocess.Popen([sys.executable, str(ROOT / 'scripts/memory-fixture.py')], stdout=port, stderr=err, start_new_session=True)
                deadline = time.monotonic() + 5
                while not port_file.read_text().strip():
                    if fixture.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError('memory fixture did not start')
                    time.sleep(0.05)
                port = int(port_file.read_text().strip())
                urls = ' '.join(f'http://127.0.0.1:{port}/tab-{i}' for i in range(tabs))
            environment = {**os.environ, 'DIVE_DATA_DIR': profile, 'DIVE_MCP_PORT': '0', 'DIVE_USE_MOCK_KEYCHAIN': '1',
                           'DIVE_STRESS_TABS': str(tabs), 'DIVE_STRESS_SETTLE_SECS': str(settle),
                           'DIVE_STRESS_URLS': urls, 'DIVE_MAX_IDLE_SECS': '0',
                           'DIVE_SWEEP_SECS': '3600', 'DIVE_DISCARD_LOCAL_TABS': '1',
                           'RUST_LOG': os.environ.get('RUST_LOG', 'info') + ',dive_desktop_lib=info',
                           'NO_COLOR': '1'}
            for key in ('DIVE_STARTUP_BENCHMARK', 'DIVE_SMOKE', 'DIVE_NATIVE_LIFECYCLE_PROBE'):
                environment.pop(key, None)
            samples = {'baseline': [], 'loaded': [], 'swept': []}

            def observe(pid):
                text = ANSI.sub('', log.read_text(errors='replace'))
                phase = 'swept' if 'stress: done' in text else 'loaded' if 'stress: loaded' in text else 'baseline' if 'stress: baseline' in text else None
                if phase and 'stress: exiting' not in text:
                    rss = tree_rss(pid)
                    # Do not count memory freed by whole-application teardown
                    # as memory reclaimed by discarding background tabs.
                    after_sample = ANSI.sub('', log.read_text(errors='replace'))
                    if rss > 0 and 'stress: exiting' not in after_sample:
                        samples[phase].append(rss)
                        with (evidence / 'rss-samples.jsonl').open('a') as trace:
                            trace.write(json.dumps({'monotonic_seconds': time.monotonic(), 'phase': phase, 'rss_kb': rss}) + '\n')

            print(f'Executable: {binary}\nProcess model: shipping defaults plus explicit environment overrides\nProbe evidence: {evidence}', flush=True)
            elapsed = run_probe(binary, environment, log, timeout, observe)
            text = ANSI.sub('', log.read_text(errors='replace'))
            loaded_match = re.search(r'stress: loaded[^\n]*tabs=(\d+)', text)
            discarded_match = re.search(r'stress: swept[^\n]*discarded=(\d+)', text)
            if not loaded_match or not discarded_match or 'stress: exiting' not in text or any(not v for v in samples.values()):
                raise ValueError(f'missing markers or live process samples; log: {log}')
            actual_tabs, discarded = int(loaded_match[1]), int(discarded_match[1])
            if actual_tabs != tabs or discarded < tabs - 1:
                raise ValueError(f'incomplete workload: {actual_tabs}/{tabs} tabs, {discarded} discarded')
            baseline, loaded, swept = samples['baseline'][0], max(samples['loaded']), min(samples['swept'])
            growth = loaded - baseline
            if growth <= 0:
                raise ValueError('workload did not produce measurable resident memory growth')
            reclaimed = loaded - swept
            percent = 100 * reclaimed / growth
            if percent < minimum:
                raise ValueError(f'reclaimed {percent:.1f}% of growth, below {minimum}%')
            if hashlib.sha256(binary.read_bytes()).hexdigest() != fingerprint:
                raise ValueError('binary changed during measurement')
            summary = {'tabs': actual_tabs, 'discarded': discarded,
                       'baseline_rss_kb': baseline, 'loaded_rss_kb': loaded, 'swept_rss_kb': swept,
                       'reclaimed_kb': reclaimed, 'reclaimed_pct_of_growth': round(percent, 2),
                       'sample_counts': {key: len(value) for key, value in samples.items()},
                       'binary': str(binary), 'binary_sha256': fingerprint, 'evidence': str(evidence),
                       'elapsed_seconds': round(elapsed, 2),
                       'process_overrides': {key: environment.get(key) for key in ('DIVE_CHROMIUM_FLAGS', 'DIVE_DEFAULT_PROCESS_MODEL', 'DIVE_RENDERER_PROCESS_LIMIT')},
                       'workload': 'explicit URLs' if os.environ.get('STRESS_URL') else 'local same-site fixture'}
            temporary = summary_path.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(summary, indent=2) + '\n')
            temporary.replace(summary_path)
            print(json.dumps(summary, indent=2))
        finally:
            if fixture is not None:
                stop_group(fixture)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'Memory benchmark FAILED: {error}', file=sys.stderr)
        sys.exit(1)
