#!/usr/bin/env python3
"""Qualify production Fetch filtering using a known tracker resolved only to loopback."""
import hashlib
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlparse
import wave

from probe_process import run_probe

ROOT = Path(__file__).resolve().parent.parent
PHASES = ('privacy', 'workspace', 'restored', 'off')
MARKER = 'DIVE_FETCH_FILTER_PROBE: privacy block, media bypass, wildcard rule, privacy restore and off verified'
PAGE = b'''<!doctype html><title>Fetch filter fixture</title><p>Local Fetch qualification</p><script>
window.runFetchFilterProbe = async phase => {
  if (!['privacy','workspace','restored','off'].includes(phase)) throw Error('phase');
  const port = location.port;
  const read = (kind, url) => new Promise((resolve, reject) => {
    const element = document.createElement(kind === 'media' ? 'audio' : 'script');
    let done = false;
    const finish = success => { if (!done) { done = true; clearTimeout(timer); resolve(success); } };
    const timer = setTimeout(() => { if (!done) { done = true; reject(Error('fixture deadline')); } }, 5000);
    element.onerror = () => finish(false);
    if (kind === 'media') { element.preload = 'auto'; element.onloadeddata = () => finish(true); }
    else element.onload = () => finish(true);
    element.src = url; document.body.append(element);
  });
  const [control, tracker, media] = await Promise.all([
    read('script', '/control.js?' + phase),
    read('script', 'http://ads.doubleclick.net:' + port + '/tracker.js?' + phase),
    read('media', 'http://ads.doubleclick.net:' + port + '/fixture.wav?' + phase)
  ]);
  return {control, tracker, media};
};
</script>'''


def audio_bytes():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 800)
    return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        host = self.headers.get('Host', '')
        expected = f"{'127.0.0.1' if url.path in ('/', '/control.js', '/favicon.ico') else 'ads.doubleclick.net'}:{self.server.server_port}"
        if host != expected:
            self.send_error(421)
            return
        if url.path == '/':
            body, mime = PAGE, 'text/html'
        elif url.path in ('/control.js', '/tracker.js', '/fixture.wav') and url.query in PHASES:
            with self.server.counts_lock:
                key = url.query + ':' + url.path
                self.server.counts[key] = self.server.counts.get(key, 0) + 1
            body, mime = (audio_bytes(), 'audio/wav') if url.path == '/fixture.wav' else (b'void 0;', 'application/javascript')
        else:
            self.send_error(404)
            return
        status, start, end = 200, 0, len(body) - 1
        requested = self.headers.get('Range')
        if requested:
            import re
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', requested)
            if not match:
                self.send_error(416)
                return
            start = int(match[1])
            end = min(int(match[2]), end) if match[2] else end
            if start > end:
                self.send_error(416)
                return
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(body)}')
        self.end_headers()
        self.wfile.write(body[start:end + 1])


def validate_counts(counts):
    for phase in PHASES:
        expected = {'/control.js': phase != 'workspace', '/tracker.js': phase == 'off', '/fixture.wav': True}
        for path, reaches_server in expected.items():
            actual = counts.get(phase + ':' + path, 0)
            if (actual > 0) != reaches_server:
                raise RuntimeError(f'fixture delivery mismatch: {phase} {path} count={actual}')


def validate_receipts(content):
    if MARKER not in content or 'event loop exited' not in content:
        raise RuntimeError('missing native Fetch or normal-exit receipt')
    rows = [json.loads(line.split('DIVE_FETCH_FILTER_PHASE: ', 1)[1]) for line in content.splitlines() if 'DIVE_FETCH_FILTER_PHASE: ' in line]
    if [row['phase'] for row in rows] != list(PHASES):
        raise RuntimeError('missing, repeated or reordered Fetch phase receipts')
    documents = [json.loads(line.split('DIVE_FETCH_DOCUMENT: ', 1)[1]) for line in content.splitlines() if 'DIVE_FETCH_DOCUMENT: ' in line]
    if [row['phase'] for row in documents] != ['privacy', 'mock', 'disabled'] or any(
        row.get('requested', 0) < 1 or row.get('paused') != int(row['phase'] == 'mock') for row in documents
    ):
        raise RuntimeError('document bypass, mock or disabled-rule receipt failed')
    return rows


def main():
    binary = Path(os.environ['DIVE_BIN']).resolve()
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    evidence = ROOT / 'target' / f'fetch-filter-probe-{time.time_ns()}'
    evidence.mkdir(parents=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.counts, server.counts_lock = {}, threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='dive-fetch-filter-') as profile:
            Path(profile, 'fetch-filter-probe.owner').write_text('dive-fetch-filter-probe-v1')
            env = {key: value for key, value in os.environ.items() if not key.startswith('DIVE_')}
            env.update(DIVE_DATA_DIR=profile, DIVE_MCP_PORT='0', DIVE_USE_MOCK_KEYCHAIN='1',
                       DIVE_NATIVE_LIFECYCLE_PROBE='quit', DIVE_FETCH_FILTER_PROBE='1',
                       DIVE_FETCH_FILTER_PROBE_URL=f'http://127.0.0.1:{server.server_port}/',
                       RUST_LOG='info', NO_COLOR='1')
            log = evidence / 'native.log'
            elapsed = run_probe(binary, env, log, 55)
            phases = validate_receipts(log.read_text(errors='replace'))
            validate_counts(server.counts)
            if hashlib.sha256(binary.read_bytes()).hexdigest() != digest:
                raise RuntimeError('binary changed during qualification')
            (evidence / 'summary.json').write_text(json.dumps({'binary': str(binary), 'sha256': digest,
                'elapsed_seconds': elapsed, 'phases': phases, 'server_requests': server.counts}, indent=2) + '\n')
            print(f'Native Fetch filtering and normal helper drain passed. Evidence: {evidence}')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        # Keep the independent delivery evidence even when the native process
        # rejects a phase before the success-only summary can be written.
        with server.counts_lock:
            counts = dict(server.counts)
        (evidence / 'server-requests.json').write_text(json.dumps(counts, indent=2) + '\n')


if __name__ == '__main__':
    main()
