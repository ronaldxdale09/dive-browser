"""`mcp-call.py` keeps its CLI contract while speaking through `mcp_client`."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from loopback_server import LoopbackServer  # noqa: E402

TOKEN = "secret-token"
SESSION = "session-1"
IMAGE = "A" * 8  # 6 decoded bytes


class FakeMcp(BaseHTTPRequestHandler):
    violations = []

    def log_message(self, *args):
        pass

    def reply(self, status, payload=None, headers=None):
        body = b"" if payload is None else ("data: " + json.dumps(payload) + "\n\n").encode()
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = request["method"]
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.violations.append(f"{method}: bad authorization")
        if method != "initialize" and self.headers.get("Mcp-Session-Id") != SESSION:
            self.violations.append(f"{method}: missing session id")
        if method == "initialize":
            return self.reply(200, {"jsonrpc": "2.0", "id": request["id"], "result": {}}, {"Mcp-Session-Id": SESSION})
        if method == "notifications/initialized":
            return self.reply(202)
        if method == "tools/list":
            tools = [{"name": "a"}, {"name": "b"}]
            return self.reply(200, {"jsonrpc": "2.0", "id": request["id"], "result": {"tools": tools}})
        name = request["params"]["name"]
        if name == "boom":
            result = {"content": [{"type": "text", "text": "bad"}], "isError": True}
        elif name == "picture":
            result = {"content": [{"type": "image", "data": IMAGE, "mimeType": "image/png"}]}
        elif name == "plain":
            result = {"content": [{"type": "text", "text": "not json"}]}
        else:
            result = {"content": [{"type": "text", "text": '{"ok":true}'}]}
        self.reply(200, {"jsonrpc": "2.0", "id": request["id"], "result": result})


class McpCallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FakeMcp.violations = []
        cls.server = LoopbackServer(("127.0.0.1", 0), FakeMcp)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.directory = tempfile.TemporaryDirectory()
        (Path(cls.directory.name) / "mcp-token").write_text(TOKEN + "\n")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.directory.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "mcp-call.py"), "--data-dir", self.directory.name,
             "--port", str(self.server.server_port), *args],
            capture_output=True, text=True, timeout=30,
        )

    def test_list_prints_tool_names(self):
        done = self.run_cli("list")
        self.assertEqual((done.returncode, json.loads(done.stdout)), (0, ["a", "b"]), done.stderr)

    def test_call_prints_parsed_text(self):
        done = self.run_cli("call", "a", "{}")
        self.assertEqual((done.returncode, done.stdout), (0, '{"ok": true}\n'), done.stderr)

    def test_call_prints_non_json_text_as_a_string(self):
        done = self.run_cli("call", "plain", "{}")
        self.assertEqual((done.returncode, done.stdout), (0, '"not json"\n'), done.stderr)

    def test_call_summarises_an_image(self):
        done = self.run_cli("call", "picture", "{}")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), {"image_bytes": 6, "mime": "image/png"})

    def test_tool_error_exits_two(self):
        self.assertEqual(self.run_cli("call", "boom", "{}").returncode, 2)

    def test_every_request_carries_session_and_bearer(self):
        self.run_cli("list")
        self.assertEqual(FakeMcp.violations, [])


if __name__ == "__main__":
    unittest.main()
