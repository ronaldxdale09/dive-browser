#!/usr/bin/env python3
"""Score Dive's automation surface against the flows agents actually run.

    DIVE_BIN=/path/to/Dive.app/Contents/MacOS/dive-desktop scripts/agent_bench.py
    scripts/agent_bench.py --port 7391 --data-dir ~/Library/.../app.dive.browser

Each task is a fixed sequence of MCP calls with assertions, so it measures the
browser rather than a model's luck: whether a locator finds the button, whether
a wait actually waits, whether a page's text comes back complete, and what all
of it costs in bytes and milliseconds. That last part is the point -- an agent
pays for every character a tool returns, so the size of an answer is part of
whether the answer is good.

It runs against local fixtures only (scripts/fixtures/bench), so a run is the
same on any machine and in CI, and it never depends on a site staying up.

Exit status is 0 when every task passes, 1 when any fails, and 2 when the
browser could not be reached at all. `--json out.json` writes the scores for
tracking across builds; `--compare old.json` fails the run on a regression.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from loopback_server import LoopbackServer  # noqa: E402
from mcp_client import McpClient  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "scripts" / "fixtures" / "bench"
# A task that has not answered in this long has failed, whatever it is doing.
TASK_TIMEOUT_S = 90


class Task:
    """One flow, its steps, and what has to be true at the end."""

    def __init__(self, name, page, run, why, gap=False):
        self.name = name
        self.page = page
        self.run = run
        self.why = why
        # A known gap runs and reports but does not fail the build: it is a
        # thing the browser cannot do yet, written down as a test so the day
        # it starts working is visible rather than accidental.
        self.gap = gap


def task(name, page, why, gap=False):
    def wrap(fn):
        return Task(name, page, fn, why, gap)

    return wrap


# --- the flows ---------------------------------------------------------------


@task("read", "article.html", "Reading a page is the call agents make most.")
def read(c):
    text = c.text("page_text")
    assert "Grendel" in text, "the article's text is missing"
    markdown = c.text("page_markdown")
    assert "## " in markdown, "markdown lost the page's headings"
    assert "](" in markdown, "markdown lost the page's links"


@task("read_budget", "long.html", "A long page must not eat an agent's context.")
def read_budget(c):
    small = c.call("page_text", {"max_chars": 500})
    text = c.text_of(small)
    assert len(text) < 1200, f"a 500-char budget returned {len(text)} characters"
    assert "characters" in text, "a truncated read must say there is more"
    window = small.get("structuredContent") or {}
    assert window.get("truncated") is True, "a truncated read must say so in structured content"
    cursor = window.get("next_cursor")
    assert isinstance(cursor, int) and cursor > 0, "a truncated read must hand back a cursor"
    # The cursor continues rather than starting over.
    more = c.text("page_text", {"max_chars": 500, "cursor": cursor})
    assert more[:40] != text[:40], "the cursor returned the same window again"
    assert len(more) > 40, "the cursor returned nothing"


@task("locate", "form.html", "A locator has to find what a person would point at.")
def locate(c):
    found = c.call("page_locate", {"locator": 'role=button[name="Sign in"]'})
    body = c.text_of(found)
    assert '"count": 1' in body or '"count":1' in body, f"locator matched wrong: {body[:200]}"


@task("form", "form.html", "Filling and submitting a form is the canonical agent task.")
def form(c):
    c.call("page_fill_form", {"fields": [
        {"locator": "testid=email", "value": "someone@example.com"},
        {"locator": "testid=password", "value": "hunter2"},
    ]})
    c.call("page_click", {"locator": 'role=button[name="Sign in"]'})
    c.call("page_wait_for", {"locator": "testid=welcome"})
    assert "Welcome, someone@example.com" in c.text("page_text"), "the form did not submit"


@task("batch", "form.html", "A form should cost one round trip, not five.")
def batch(c):
    result = c.call("page_batch", {"steps": [
        {"tool": "page_fill_form", "arguments": {"fields": [
            {"locator": "testid=email", "value": "batch@example.com"},
            {"locator": "testid=password", "value": "hunter2"},
        ]}},
        {"tool": "page_click", "arguments": {"locator": 'role=button[name="Sign in"]'}},
        {"tool": "page_wait_for", "arguments": {"locator": "testid=welcome"}},
    ]})
    structured = result.get("structuredContent") or {}
    assert structured.get("ok") is True, f"batch failed: {c.text_of(result)[:300]}"
    assert structured.get("steps") == 3, structured
    assert "batch@example.com" in c.text("page_text"), "the batch did not actually run"


@task("batch_stops", "form.html", "A half-run batch must say where it stopped.")
def batch_stops(c):
    # A stopped batch answers with isError, so take the raw result: what is
    # being tested is what it says about where it stopped.
    answer = c.call_raw("page_batch", {"steps": [
        {"tool": "page_fill_form", "arguments": {"fields": [{"locator": "testid=email", "value": "x@y.z"}]}},
        {"tool": "page_click", "arguments": {"locator": 'role=button[name="Nothing here"]'}},
        {"tool": "page_fill_form", "arguments": {"fields": [{"locator": "testid=password", "value": "never"}]}},
    ]})
    result = answer["result"]
    assert result.get("isError") is True, "a batch that stopped must report an error"
    structured = result.get("structuredContent") or {}
    assert structured.get("ok") is False, "a batch with a bad step reported success"
    assert structured.get("failed_at") == 1, structured
    assert "never" not in c.text("page_text"), "a batch kept going after a failure"


@task("wait", "slow.html", "Waiting is what separates a reliable agent from a flaky one.")
def wait(c):
    c.call("page_click", {"locator": 'role=button[name="Start"]'})
    started = time.time()
    c.call("page_wait_for", {"locator": "testid=done", "timeout_ms": 10000})
    waited = time.time() - started
    assert waited > 0.4, f"the wait returned in {waited:.2f}s, before the work finished"
    assert "Finished" in c.text("page_text"), "the wait returned before the page was ready"


@task("diff", "counter.html", "A diff is how an agent reads a change cheaply.")
def diff(c):
    c.call("page_snapshot")
    c.call("page_click", {"locator": 'role=button[name="Add row"]'})
    body = c.text("page_diff")
    assert "Row 1" in body, f"the diff missed the new row: {body[:200]}"
    assert len(body) < 4000, f"a one-row diff cost {len(body)} characters"


@task("errors", "broken.html", "Finding what is broken is the reason to have a browser here.")
def errors(c):
    report = c.text("page_report")
    assert "boom" in report, "the console error is missing from the report"
    assert "404" in report or "failed" in report.lower(), "the failed request is missing"


@task("iframe", "iframe.html", "Most checkouts put the important field in an iframe.")
def iframe(c):
    body = c.text("page_inspect")
    assert "Inside the frame" in body, "the iframe's contents are not in page_inspect"
    assert "frame-inner.html" in body, "the iframe is not named, so an agent cannot tell where it is"
    state = c.text("page_state")
    assert "Inner button" in state, "the iframe's controls are missing from the tree"


@task("iframe_click", "iframe.html", "Acting inside a frame, not only reading it.", gap=True)
def iframe_click(c):
    # Locators resolve in one document, so a button inside an iframe cannot be
    # addressed by locator yet. Written down as a gap rather than left unsaid.
    c.call("page_click", {"locator": "testid=inner"})
    assert "clicked" in c.text("page_text")


@task("shadow", "shadow.html", "Design systems ship shadow DOM; agents still have to click it.")
def shadow(c):
    c.call("page_click", {"locator": 'role=button[name="Shadow button"]'})
    assert "clicked" in c.text("page_text"), "a shadow-DOM button could not be clicked"


@task("scroll", "infinite.html", "Infinite scroll is where naive agents stop early.")
def scroll(c):
    for _ in range(3):
        c.call("page_scroll", {"delta_y": 2000})
        time.sleep(0.4)
    assert "Item 40" in c.text("page_text"), "scrolling did not load more items"


@task("dialog", "dialog.html", "A dialog blocks everything until it is answered.")
def dialog(c):
    c.call("page_click", {"locator": 'role=button[name="Confirm"]'})
    c.call("page_dialog", {"accept": True})
    assert "accepted" in c.text("page_text"), "the dialog was not accepted"


@task("lease", "article.html", "Two agents must not drive one tab.")
def lease(c):
    tab = c.tab_id
    c.call("tab_claim", {"tab_id": tab, "holder": "bench", "seconds": 60})
    # Another client's action is refused while the lease holds; reading is not.
    refused = c.call_raw("page_click", {"tab_id": tab, "locator": "text=Anything", "holder": "someone-else"})
    assert "error" in refused, "a second agent was allowed to act in a claimed tab"
    assert "bench" in json.dumps(refused["error"]), refused["error"]
    c.call("page_text", {"tab_id": tab, "holder": "someone-else"})
    c.call("tab_release", {"tab_id": tab, "holder": "bench"})
    c.call("page_click", {"tab_id": tab, "locator": 'role=heading[name="Grendel"]', "holder": "someone-else"})


TASKS = [read, read_budget, locate, form, batch, batch_stops, wait, diff, errors, iframe, iframe_click, shadow, scroll, dialog, lease]


# --- running -----------------------------------------------------------------


def serve_fixtures():
    """Serve the fixture pages on a loopback port, in a thread."""
    import functools
    import http.server
    import threading

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURES))
    server = LoopbackServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_task(client, base, t):
    """Run one task against a fresh tab; return its score row."""
    started = time.time()
    client.bytes = 0
    client.calls = 0
    try:
        client.open(f"{base}/{t.page}")
        t.run(client)
        ok, error = True, None
    except AssertionError as failure:
        ok, error = False, str(failure)
    except Exception as failure:  # noqa: BLE001 - a broken tool is a failed task
        ok, error = False, f"{type(failure).__name__}: {failure}"
    return {
        "task": t.name,
        "gap": t.gap,
        "ok": ok,
        "error": error,
        "calls": client.calls,
        "bytes": client.bytes,
        "ms": round((time.time() - started) * 1000),
        "why": t.why,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=os.environ.get("DIVE_MCP_PORT", "7391"))
    ap.add_argument("--data-dir", default=os.environ.get("DIVE_DATA_DIR"))
    ap.add_argument("--only", help="run one task by name")
    ap.add_argument("--json", help="write the scores here")
    ap.add_argument("--compare", help="fail on a regression against this file")
    a = ap.parse_args()
    if not a.data_dir:
        print("set --data-dir (or DIVE_DATA_DIR) so the bench can read the MCP token", file=sys.stderr)
        return 2

    fixtures = serve_fixtures()
    base = f"http://127.0.0.1:{fixtures.server_port}"
    try:
        client = McpClient(a.port, a.data_dir)
        client.connect()
    except (urllib.error.URLError, OSError, FileNotFoundError) as e:
        print(f"no browser on port {a.port}: {e}", file=sys.stderr)
        return 2

    tasks = [t for t in TASKS if not a.only or t.name == a.only]
    rows = [run_task(client, base, t) for t in tasks]

    width = max(len(r["task"]) for r in rows)
    for r in rows:
        mark = "ok  " if r["ok"] else ("gap " if r["gap"] else "FAIL")
        print(f"{mark} {r['task']:<{width}}  {r['calls']:>3} calls  {r['bytes']:>7} bytes  {r['ms']:>6} ms")
        if r["error"]:
            print(f"     {r['error']}")
    scored = [r for r in rows if not r["gap"]]
    passed = sum(1 for r in scored if r["ok"])
    total_bytes = sum(r["bytes"] for r in rows)
    print(f"\n{passed}/{len(scored)} tasks, {total_bytes} bytes returned, {sum(r['ms'] for r in rows)} ms")
    gaps = [r for r in rows if r["gap"] and not r["ok"]]
    if gaps:
        print("known gaps: " + ", ".join(r["task"] for r in gaps))
    for r in rows:
        if r["gap"] and r["ok"]:
            print(f"note: {r['task']} is marked a known gap but passed -- drop the flag")

    if a.json:
        pathlib.Path(a.json).write_text(json.dumps({"rows": rows, "passed": passed, "total": len(rows), "bytes": total_bytes}, indent=2))
    if a.compare:
        before = json.loads(pathlib.Path(a.compare).read_text())
        was = {r["task"]: r for r in before["rows"]}
        for r in rows:
            old = was.get(r["task"])
            if old and old["ok"] and not r["ok"] and not r["gap"]:
                print(f"regression: {r['task']} passed before and fails now", file=sys.stderr)
                return 1
            # A tool that got much chattier is a regression too: context is the
            # budget an agent actually runs out of.
            if old and old["ok"] and r["ok"] and r["bytes"] > max(old["bytes"] * 1.5, old["bytes"] + 2000):
                print(f"regression: {r['task']} returns {r['bytes']} bytes, was {old['bytes']}", file=sys.stderr)
                return 1
    return 0 if passed == len(scored) else 1


if __name__ == "__main__":
    sys.exit(main())
