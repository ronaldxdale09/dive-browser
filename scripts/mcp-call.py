#!/usr/bin/env python3
"""Call one MCP tool on a running Dive instance and print the result as JSON.

    mcp-call.py --data-dir DIR --port PORT list
    mcp-call.py --data-dir DIR --port PORT call TOOL '{"arg": 1}'

The bearer token is read from DIR/mcp-token, which the app writes at start.
Exit status is 0 on success, 2 when the tool reported an error.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

COUNTER = [0]


def rpc(url, token, sid, method, params):
    COUNTER[0] += 1
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Origin": url.rsplit("/", 1)[0],
    }
    if sid:
        headers["Mcp-Session-Id"] = sid
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": COUNTER[0], "method": method, "params": params}).encode(),
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        sid = resp.headers.get("Mcp-Session-Id") or sid
        body = resp.read().decode()
    payload = None
    for line in body.splitlines():
        if line.startswith("data: ") and line[6:].strip():
            payload = json.loads(line[6:])
    if payload is None and body.strip():
        payload = json.loads(body)
    return sid, payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--port", required=True)
    ap.add_argument("verb", choices=["list", "call"])
    ap.add_argument("tool", nargs="?")
    ap.add_argument("arguments", nargs="?", default="{}")
    a = ap.parse_args()
    token = open(f"{a.data_dir}/mcp-token").read().strip()
    url = f"http://127.0.0.1:{a.port}/mcp"
    sid, _ = rpc(url, token, None, "initialize", {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "live-check", "version": "1"},
    })
    try:
        rpc(url, token, sid, "notifications/initialized", {})
    except urllib.error.HTTPError:
        pass
    if a.verb == "list":
        _, out = rpc(url, token, sid, "tools/list", {})
        print(json.dumps([t["name"] for t in out["result"]["tools"]]))
        return 0
    _, out = rpc(url, token, sid, "tools/call", {"name": a.tool, "arguments": json.loads(a.arguments)})
    if "error" in out:
        print(json.dumps(out["error"]))
        return 2
    result = out["result"]
    content = result.get("content", [])
    if content and content[0].get("type") == "image":
        print(json.dumps({"image_bytes": len(content[0].get("data", "")) * 3 // 4, "mime": content[0].get("mimeType")}))
    else:
        text = content[0].get("text", "") if content else ""
        try:
            print(json.dumps(json.loads(text)))
        except (json.JSONDecodeError, TypeError):
            print(json.dumps(text))
    return 2 if result.get("isError") else 0


if __name__ == "__main__":
    sys.exit(main())
