#!/usr/bin/env python3
"""Verify private CEF storage/lifetime against an exact, disposable app binary."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        page = b'<!doctype html><title>Private session fixture</title><h1>Private session fixture</h1>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    with tempfile.TemporaryDirectory(prefix='dive-private-regression-') as root:
        normal = Path(root) / 'normal'
        normal.mkdir()
        for name, private, expected in [('normal-seed', False, 'empty'), ('private-first', True, 'empty'), ('private-fresh', True, 'empty'), ('normal-retained', False, 'normal')]:
            env = {key: value for key, value in os.environ.items() if not key.startswith('DIVE_')}
            env.update(DIVE_DATA_DIR=str(normal), DIVE_USE_MOCK_KEYCHAIN='1', DIVE_MCP_PORT='0', DIVE_PRIVATE_STORAGE_PROBE=f'http://127.0.0.1:{server.server_port}/fixture', DIVE_PRIVATE_STORAGE_EXPECT=expected)
            if private:
                env['DIVE_PRIVATE_SESSION'] = '1'
            started = time.monotonic()
            log = args.output / f'{name}.log'
            with log.open('w') as stream:
                process = subprocess.Popen([str(binary), '-ApplePersistenceIgnoreState', 'YES', '-ApplePersistence', '-1'], env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = process.wait(timeout=55)
                except subprocess.TimeoutExpired:
                    # Own process group only; never target another running browser.
                    import signal
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    raise RuntimeError(f'{name}: last window did not end session; {log}')
            text = log.read_text()
            rows = [json.loads(line.split(': ', 1)[1]) for line in text.splitlines() if line.startswith('DIVE_PRIVATE_PROBE: ')]
            if code != 0 or len(rows) != 1:
                raise RuntimeError(f'{name}: exit {code}, receipts {len(rows)}; {log}')
            row = rows[0]
            if private and Path(row['root']).exists():
                raise RuntimeError(f'{name}: private runtime root remains after exit')
            row.update(name=name, exitCode=code, elapsedSeconds=round(time.monotonic() - started, 2))
            results.append(row)
            print(f'{name}: PASS ({row["elapsedSeconds"]}s)', flush=True)
    server.shutdown()
    report = {'binary': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'cases': results}
    (args.output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'PASS: {args.output / "results.json"}')

if __name__ == '__main__':
    main()
