#!/usr/bin/env python3
"""Serve a deterministic, memory-bearing page on loopback using the shipping process model."""

import http.server
import threading
from loopback_server import LoopbackServer


PAGE = b"""<!doctype html>
<meta charset="utf-8"><title>Dive memory fixture</title>
<main id="root"></main>
<script>
  const root = document.querySelector('#root');
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 5000; i += 1) {
    const row = document.createElement('div');
    row.textContent = `fixture row ${i} ${'x'.repeat(160)}`;
    fragment.appendChild(row);
  }
  root.appendChild(fragment);
  window.__diveMemoryFixture = new Uint8Array(32 * 1024 * 1024);
  for (let i = 0; i < window.__diveMemoryFixture.length; i += 4096) {
    window.__diveMemoryFixture[i] = i & 255;
  }
  document.title = 'Dive memory fixture ready';
</script>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, _format, *_args):
        pass


def main():
    server = LoopbackServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(port, flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
