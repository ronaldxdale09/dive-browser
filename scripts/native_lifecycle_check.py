#!/usr/bin/env python3
"""Check real CEF window/tab teardown, then restart the same disposable profile."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from probe_process import run_probe

ROOT = Path(__file__).resolve().parent.parent


def main():
    binary = Path(os.environ['DIVE_BIN']).resolve()
    fingerprint = hashlib.sha256(binary.read_bytes()).hexdigest()
    evidence = ROOT / 'target' / f'lifecycle-probes-{time.time_ns()}'
    evidence.mkdir(parents=True)
    records = []
    with tempfile.TemporaryDirectory(prefix='dive-lifecycle-') as profile:
        for index, mode in enumerate(('quit', 'window-close', 'quit', 'window-close'), 1):
            env = {**os.environ, 'DIVE_DATA_DIR': profile, 'DIVE_MCP_PORT': '0', 'DIVE_USE_MOCK_KEYCHAIN': '1',
                   'DIVE_NATIVE_LIFECYCLE_PROBE': mode, 'RUST_LOG': 'info', 'NO_COLOR': '1'}
            for key in ('DIVE_STARTUP_BENCHMARK', 'DIVE_STRESS_TABS', 'DIVE_SMOKE', 'DIVE_WINDOW_HIDDEN'):
                env.pop(key, None)
            if index != 1:
                env.pop('DIVE_WELCOME_PROBE', None)
            if 'DIVE_AVATAR_PROBE' in env:
                env['DIVE_AVATAR_PROBE'] = 'cold' if index == 1 else 'warm'
            log = evidence / f'{index}-{mode}.log'
            started = time.monotonic()
            sampled = False

            def inspect_hang(pid):
                nonlocal sampled
                if not sampled and sys.platform == 'darwin' and time.monotonic() - started > 10:
                    sampled = True
                    subprocess.run(['sample', str(pid), '1', '1', '-file', str(log.with_suffix('.sample.txt'))], capture_output=True, timeout=5)

            elapsed = run_probe(binary, env, log, 60 if 'DIVE_CRASH_PROBE' in env else 30, inspect_hang)
            content = log.read_text(errors='replace')
            if ('DIVE_LIFECYCLE_PROBE: popout close and reattach verified' not in content
                    or 'DIVE_LIFECYCLE_PROBE: cross-workspace reattach and preserved page verified' not in content
                    or 'DIVE_LIFECYCLE_PROBE: native navigation history verified' not in content
                    or 'DIVE_LIFECYCLE_PROBE: chrome IPC boundary verified' not in content
                    or 'DIVE_LIFECYCLE_PROBE: ' + ('quit requested with detached window' if mode == 'quit' else 'main window close requested') not in content
                    or 'event loop exited' not in content):
                raise RuntimeError(f'lifecycle evidence incomplete: {log}')
            if 'DIVE_PERMISSION_CACHE_PROBE' in env and 'DIVE_PERMISSION_PROBE: native scalar/structured reset, shared-context reuse, container isolation and closed-context Ask/reopen verified' not in content:
                raise RuntimeError(f'permission cache evidence incomplete: {log}')
            if 'DIVE_PERMISSION_CACHE_PROBE' in env and 'DIVE_PERMISSION_LEGACY_PROBE: seeded native AR, partitioned storage-access pair and sensor ALLOW reset/readback verified' not in content:
                raise RuntimeError(f'legacy permission evidence incomplete: {log}')
            if 'DIVE_WELCOME_PROBE' in env and 'DIVE_WELCOME_PROBE: static native artwork and on-demand tour open/close verified' not in content:
                raise RuntimeError(f'welcome evidence incomplete: {log}')
            if 'DIVE_PERMISSION_WEBUI_PROBE' in env and 'DIVE_PERMISSION_WEBUI_PROBE: effective chooser/protocol services verified' not in content:
                raise RuntimeError(f'permission WebUI evidence incomplete: {log}')
            if 'DIVE_AVATAR_PROBE' in env and f"DIVE_AVATAR_PROBE: {env['DIVE_AVATAR_PROBE']} artwork verified" not in content:
                raise RuntimeError(f'avatar evidence incomplete: {log}')
            if 'DIVE_CRASH_PROBE' in env and 'DIVE_CRASH_PROBE: Page.crash once, isolated context, in-place recovery and unchanged sibling/chrome documents verified' not in content:
                raise RuntimeError(f'isolated crash evidence incomplete: {log}')
            records.append({'avatar_cache': env.get('DIVE_AVATAR_PROBE'), 'mode': mode, 'elapsed_seconds': round(elapsed, 2), 'permission_cache_checked': 'DIVE_PERMISSION_CACHE_PROBE' in env, 'crash_checked': 'DIVE_CRASH_PROBE' in env, 'log': str(log)})
            print(f'{index}: {mode}, tab/window checks passed, exited normally in {elapsed:.2f}s', flush=True)
    # The native runtime must preserve failure status after asynchronous CEF
    # shutdown, not merely log app.exit(1) and return success to its launcher.
    with tempfile.TemporaryDirectory(prefix='dive-startup-negative-') as profile:
        report = evidence / 'incomplete-startup.json'
        env = {**os.environ, 'DIVE_DATA_DIR': profile, 'DIVE_MCP_PORT': '0', 'DIVE_USE_MOCK_KEYCHAIN': '1',
               'DIVE_STARTUP_BENCHMARK': '1', 'DIVE_BENCHMARK_TIMEOUT_MS': '0',
               'DIVE_BENCHMARK_OUTPUT': str(report)}
        for key in ('DIVE_NATIVE_LIFECYCLE_PROBE', 'DIVE_CRASH_PROBE', 'DIVE_STRESS_TABS', 'DIVE_SMOKE'):
            env.pop(key, None)
        run_probe(binary, env, evidence / 'incomplete-startup.log', 20, expected_exit_code=1)
        if json.loads(report.read_text())['total_startup_ms'] is not None:
            raise RuntimeError('incomplete startup report claimed full readiness')
        print('Incomplete native startup correctly exited 1', flush=True)
    if hashlib.sha256(binary.read_bytes()).hexdigest() != fingerprint:
        raise RuntimeError('binary changed during lifecycle check')
    (evidence / 'summary.json').write_text(json.dumps({'binary': str(binary), 'binary_sha256': fingerprint, 'runs': records}, indent=2) + '\n')
    print(f'Evidence: {evidence}')


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'Native lifecycle check FAILED: {error}', file=sys.stderr)
        sys.exit(1)
