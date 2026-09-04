#!/usr/bin/env python3
"""Qualify bounded response capture against the exact disposable native bundle."""
import gzip
import hashlib
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlparse

from probe_process import run_probe

ROOT = Path(__file__).resolve().parent.parent
PAGE = b'''<!doctype html><title>Dive capture fixture</title><p>Response capture</p><script>
(async () => {
  try {
    const read = async url => { const r = await fetch(url); const v = await r.json(); if (v.answer !== 42) throw Error(url); };
    for (const name of ['small-plain','large-plain','small-gzip','large-gzip','small-cache','small-cache']) await read('/json?capture-case='+name);
    let largeBlob;
    for (const size of ['small','large']) {
      const blob = new Blob([JSON.stringify({answer:42,pad:size==='large'?'x'.repeat(1048576):'ok'})], {type:'application/json'});
      const url = URL.createObjectURL(blob); if (size === 'large') largeBlob = url; await read(url); URL.revokeObjectURL(url);
    }
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    await read('/sw-json?capture-case=small-sw'); await read('/sw-json?capture-case=large-sw');
    window.captureProbeResult = {done:true,largeBlob};
  } catch (error) { window.captureProbeResult = {error:String(error)}; }
})();
</script>'''
SW = b'''self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/sw-json')event.respondWith(new Response(JSON.stringify({answer:42,pad:event.request.url.includes('large')?'x'.repeat(1048576):'ok'}),{headers:{'Content-Type':'application/json'}}));});'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        name = parse_qs(url.query).get('capture-case', [''])[0]
        headers = {}
        if url.path == '/':
            content = PAGE.replace(b'small-cache', b'large-cache') if self.server.large_cache else PAGE
            mime = 'text/html'
        elif url.path == '/sw.js':
            content, mime = SW, 'application/javascript'
            headers['Cache-Control'] = 'no-store'
        elif url.path == '/json':
            with self.server.counts_lock:
                self.server.capture_counts[name] = self.server.capture_counts.get(name, 0) + 1
            content = json.dumps({'answer': 42, 'pad': 'x' * (1048576 if 'large' in name else 2)}).encode()
            mime = 'application/json'
            headers['Cache-Control'] = 'max-age=3600' if 'cache' in name else 'no-store'
            if 'gzip' in name:
                content = gzip.compress(content)
                headers['Content-Encoding'] = 'gzip'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        for key, value in {'Content-Type': mime, 'Content-Length': str(len(content)), **headers}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)


def main():
    binary = Path(os.environ['DIVE_BIN']).resolve()
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    evidence = ROOT / 'target' / f'network-probe-{time.time_ns()}'
    evidence.mkdir(parents=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.large_cache = os.environ.get('DIVE_NETWORK_LARGE_CACHE') == '1'
    server.capture_counts = {}
    server.counts_lock = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='dive-network-') as profile:
            env = {**os.environ, 'DIVE_DATA_DIR': profile, 'DIVE_MCP_PORT': '0',
                   'DIVE_USE_MOCK_KEYCHAIN': '1', 'DIVE_NATIVE_LIFECYCLE_PROBE': 'quit',
                   'DIVE_PERMISSION_CACHE_PROBE': '1',
                   'DIVE_NETWORK_CAPTURE_PROBE_URL': f'http://127.0.0.1:{server.server_port}/',
                   'RUST_LOG': 'info,dive_desktop_lib::network=debug', 'NO_COLOR': '1'}
            for key in ('DIVE_STARTUP_BENCHMARK', 'DIVE_STRESS_TABS', 'DIVE_SMOKE', 'DIVE_WINDOW_HIDDEN', 'DIVE_DISABLE_FEEDS'):
                env.pop(key, None)
            log = evidence / 'native.log'
            elapsed = run_probe(binary, env, log, 45)
            content = log.read_text(errors='replace')
            marker = 'DIVE_NETWORK_PROBE: compressed, cached, blob and service-worker capture verified'
            if marker not in content or 'DIVE_PERMISSION_PROBE: native scalar/structured reset' not in content or 'DIVE_PERMISSION_LEGACY_PROBE: seeded native AR, partitioned storage-access pair and sensor ALLOW reset/readback verified' not in content or 'event loop exited' not in content:
                raise RuntimeError(f'native capture evidence incomplete: {log}')
            rows_line = next(line for line in content.splitlines() if line.startswith('DIVE_NETWORK_PROBE: ['))
            rows = json.loads(rows_line.removeprefix('DIVE_NETWORK_PROBE: '))
            calls = set(re.findall(r'response body fetch dispatched tab_id=([\w-]+) request_id=([^\s]+)', content))
            for row in rows:
                dispatched = (row['tab_id'], row['request_id']) in calls
                if row['large'] and dispatched:
                    raise RuntimeError(f"oversized response fetched before omission: {row['url']}")
                if row['captured_bytes'] is not None and not dispatched:
                    raise RuntimeError(f"capture dispatch trace missing: {row['url']}")
            cache_case = 'large-cache' if server.large_cache else 'small-cache'
            cache_rows = [row for row in rows if 'capture-case=' + cache_case in row['url']]
            if len(cache_rows) != 2 or server.capture_counts.get(cache_case) != 1:
                raise RuntimeError(f'cache path not exercised: {len(cache_rows)} browser requests, {server.capture_counts.get(cache_case, 0)} server requests')
            if not calls:
                raise RuntimeError('no positive-control response body dispatch was observed')
            if hashlib.sha256(binary.read_bytes()).hexdigest() != digest:
                raise RuntimeError('binary changed during qualification')
            (evidence / 'summary.json').write_text(json.dumps({'binary': str(binary), 'sha256': digest,
                'elapsed_seconds': elapsed, 'cache_case': cache_case, 'server_requests': server.capture_counts, 'log': str(log)}, indent=2) + '\n')
            print(f'Native response capture passed; natural exit and helper drain verified. Evidence: {evidence}')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
