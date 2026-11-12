#!/usr/bin/env python3
"""Call one MCP tool on a running Dive instance and print the result as JSON.

    mcp-call.py --data-dir DIR --port PORT list
    mcp-call.py --data-dir DIR --port PORT call TOOL '{"arg": 1}'

The bearer token is read from DIR/mcp-token, which the app writes at start.
Speaks the protocol through `mcp_client.py`.
Exit status is 0 on success, 2 when the tool reported an error.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_client import McpClient  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--port", required=True)
    ap.add_argument("verb", choices=["list", "call"])
    ap.add_argument("tool", nargs="?")
    ap.add_argument("arguments", nargs="?", default="{}")
    a = ap.parse_args()
    client = McpClient(a.port, a.data_dir, name="live-check", timeout=60).connect()
    if a.verb == "list":
        print(json.dumps([t["name"] for t in client.list_tools()]))
        return 0
    out = client.call_raw(a.tool, json.loads(a.arguments))
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
