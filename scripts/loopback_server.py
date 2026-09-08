"""A loopback HTTP server that starts at once on every machine.

`HTTPServer.server_bind` looks up the host's fully qualified name with a
reverse DNS query. On a normal Mac that returns immediately; on GitHub's macOS
runners it can block for longer than the probes allow, so the fixture never
prints its port and the probe reports that the fixture did not start. The
name is only used for the `Server` header, so it is set from the address.
"""
from http.server import ThreadingHTTPServer
import socketserver


class LoopbackServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` without the reverse DNS lookup on bind."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port
