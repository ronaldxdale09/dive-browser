"""A small MCP client for the harnesses, counting what each call costs.

`mcp-call.py` speaks the protocol for one call from a shell. A harness needs a
session it can keep, and it needs to know the size of every answer, because the
number that matters for an agent is not only "did the tool work" but "what did
knowing cost". Both live here so the two scripts cannot drift.
"""
import json
import urllib.request

PROTOCOL = "2025-06-18"


class McpError(RuntimeError):
    """A tool that answered with an error, or a call that was refused."""


class McpClient:
    """One session against a running Dive."""

    def __init__(self, port, data_dir, name="dive-bench"):
        self.url = f"http://127.0.0.1:{port}/mcp"
        self.token = open(f"{data_dir}/mcp-token").read().strip()
        self.name = name
        self.session = None
        self.counter = 0
        # Reset by the caller per task.
        self.calls = 0
        self.bytes = 0
        self.tab_id = None

    # --- protocol ---

    def _rpc(self, method, params, notify=False):
        self.counter += 1
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Origin": self.url.rsplit("/", 1)[0],
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        body = {"jsonrpc": "2.0", "method": method}
        if not notify:
            body["id"] = self.counter
        if params is not None:
            body["params"] = params
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=90) as response:
            self.session = response.headers.get("Mcp-Session-Id") or self.session
            text = response.read().decode()
        if notify:
            return None
        payload = None
        for line in text.splitlines():
            if line.startswith("data: ") and line[6:].strip():
                payload = json.loads(line[6:])
        if payload is None and text.strip():
            payload = json.loads(text)
        return payload

    def connect(self):
        self._rpc("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": self.name, "version": "1"},
        })
        try:
            self._rpc("notifications/initialized", None, notify=True)
        except urllib.error.HTTPError:
            pass
        return self

    # --- calls ---

    def call_raw(self, tool, arguments=None):
        """The whole JSON-RPC answer, error included. Counts toward the cost.

        The task's own tab is passed unless the caller names one: a harness
        that leaves it out is testing "the active tab", which is whatever ran
        last rather than what this task opened.
        """
        arguments = dict(arguments or {})
        if self.tab_id and "tab_id" not in arguments and tool not in ("tab_open", "tabs_list", "contexts"):
            arguments["tab_id"] = self.tab_id
        answer = self._rpc("tools/call", {"name": tool, "arguments": arguments})
        self.calls += 1
        self.bytes += len(json.dumps(answer))
        return answer

    def call(self, tool, arguments=None):
        """The result, raising when the server or the tool reported an error."""
        answer = self.call_raw(tool, arguments)
        if "error" in answer:
            raise McpError(f"{tool}: {answer['error'].get('message', answer['error'])}")
        result = answer["result"]
        if result.get("isError"):
            raise McpError(f"{tool}: {self.text_of(result)[:400]}")
        return result

    @staticmethod
    def text_of(result):
        """The text a result carries, joined; images count as a placeholder."""
        parts = []
        for block in result.get("content", []):
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif block.get("type") == "image":
                parts.append(f"[image {len(block.get('data', '')) * 3 // 4} bytes]")
        return "\n".join(parts)

    def text(self, tool, arguments=None):
        """Call a tool and take its text."""
        return self.text_of(self.call(tool, arguments))

    def list_tools(self):
        return self._rpc("tools/list", {})["result"]["tools"]

    def list_prompts(self):
        return self._rpc("prompts/list", {})["result"]["prompts"]

    def get_prompt(self, name, arguments=None):
        return self._rpc("prompts/get", {"name": name, "arguments": arguments or {}})["result"]

    def list_resources(self):
        return self._rpc("resources/list", {})["result"]["resources"]

    def read_resource(self, uri):
        return self._rpc("resources/read", {"uri": uri})["result"]

    # --- tabs ---

    def open(self, url):
        """A fresh tab on `url`, left as the tab every later call acts on."""
        result = self.call("tab_open", {"url": url})
        opened = json.loads(self.text_of(result))
        self.tab_id = opened.get("id") or opened.get("tab_id")
        self.call("page_wait_for", {"tab_id": self.tab_id, "load": True, "timeout_ms": 15000})
        return self.tab_id

    def close(self):
        if self.tab_id:
            try:
                self.call("tab_close", {"tab_id": self.tab_id})
            except McpError:
                pass
            self.tab_id = None
