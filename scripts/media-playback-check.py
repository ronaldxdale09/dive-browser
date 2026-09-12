#!/usr/bin/env python3
"""Verify sustained media playback through Dive's trusted MCP input path."""

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


OBSERVE_EXPRESSION = r"""(() => {
  const stateKey = '__diveMediaPlaybackCheck';
  const state = window[stateKey] || (window[stateKey] = {
    ids: new WeakMap(), nextId: 1, events: [],
    documentId: `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`
  });
  if (!state.listening) {
    const record = event => {
      if (!event.isTrusted) return;
      state.events.push({
        type: event.type,
        trusted: true,
        tag: event.target && event.target.tagName || null,
        id: event.target && event.target.id || null,
        className: event.target && typeof event.target.className === 'string' ? event.target.className : null,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp
      });
      if (state.events.length > 20) state.events.shift();
    };
    for (const name of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(name, record, true);
    }
    state.listening = true;
  }
  const rectValue = element => {
    const r = element.getBoundingClientRect();
    return {x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, right:r.right, bottom:r.bottom, left:r.left};
  };
  const visible = element => {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!element.isConnected || r.width <= 0 || r.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    return document.elementsFromPoint(x, y).some(hit => hit === element || element.contains(hit));
  };
  const video = document.querySelector('video');
  if (video && !state.ids.has(video)) state.ids.set(video, `video-${state.nextId++}`);
  if (video) video.muted = true;
  const candidates = [
    ['css=.ytp-large-play-button', document.querySelector('.ytp-large-play-button')],
    ['css=[data-startup-play]', document.querySelector('[data-startup-play]')]
  ];
  const chosen = candidates.find(([, element]) => element && visible(element));
  return {
    url: location.href,
    documentIdentity: state.documentId,
    scroll: {x: scrollX, y: scrollY},
    viewport: {width: innerWidth, height: innerHeight},
    video: video ? {
      identity: state.ids.get(video), connected: video.isConnected,
      currentTime: video.currentTime, readyState: video.readyState,
      paused: video.paused, ended: video.ended, muted: video.muted,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      error: video.error ? {code: video.error.code, message: video.error.message || null} : null,
      rect: rectValue(video)
    } : null,
    startup_target: chosen ? {locator: chosen[0], rect: rectValue(chosen[1])} : null,
    trusted_pointer_events: state.events.slice()
  };
})()"""


class Decision:
    def __init__(self, status, reason, action=None, advanced_seconds=0.0):
        self.status = status
        self.reason = reason
        self.action = action
        self.advanced_seconds = advanced_seconds


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def same_document_url(expected, actual):
    """Fragments may change during playback; every other URL part must match."""
    try:
        left = urllib.parse.urlsplit(expected)
        right = urllib.parse.urlsplit(actual)
    except (TypeError, ValueError):
        return False
    return bool(left.scheme and left.netloc) and left[:4] == right[:4]


class PlaybackVerifier:
    REQUIRED_ADVANCE = 1.5
    JUMP_TOLERANCE = 0.75
    MAX_TRUSTED_ACTIONS = 2

    def __init__(self, expected_url):
        self.expected_url = expected_url
        self.identity = None
        self.window_at = None
        self.window_time = None
        self.previous_at = None
        self.previous_time = None
        self.clicked_identities = set()
        self.action_count = 0

    def _reset(self, obs, reason):
        video = obs.get("video") or {}
        self.identity = (obs.get("documentIdentity"), video.get("identity"))
        self.window_at = obs.get("observed_at")
        self.window_time = video.get("currentTime")
        self.previous_at = self.window_at
        self.previous_time = self.window_time
        return Decision("observing", reason)

    def _clear(self):
        self.identity = None
        self.window_at = None
        self.window_time = None
        self.previous_at = None
        self.previous_time = None

    def consume(self, obs):
        if not same_document_url(self.expected_url, obs.get("url")):
            return Decision("failure", "navigation_mismatch")
        video = obs.get("video")
        if not isinstance(video, dict):
            self._clear()
            return Decision("observing", "video_missing")
        if video.get("error"):
            return Decision("failure", "player_error")
        if not video.get("connected"):
            self._clear()
            return Decision("observing", "video_detached")

        video_identity = video.get("identity")
        identity = (obs.get("documentIdentity"), video_identity)
        now_at = obs.get("observed_at")
        now_time = video.get("currentTime")
        if not all(identity) or not isinstance(now_at, (int, float)) or not isinstance(now_time, (int, float)):
            return Decision("failure", "malformed_observation")
        if self.identity is not None and identity != self.identity:
            return self._reset(obs, "video_replaced")

        if video.get("paused") or video.get("readyState", 0) < 2 or video.get("ended"):
            self._clear()
            target = obs.get("startup_target")
            if video.get("paused") and target and identity not in self.clicked_identities:
                locator = target.get("locator")
                if locator:
                    if self.action_count >= self.MAX_TRUSTED_ACTIONS:
                        return Decision("failure", "trusted_action_limit_exceeded")
                    self.clicked_identities.add(identity)
                    self.action_count += 1
                    return Decision("observing", "paused_with_visible_startup_control", {
                        "type": "trusted_click", "locator": locator
                    })
            reason = "paused_without_visible_startup_control" if video.get("paused") else "video_not_ready"
            return Decision("observing", reason)

        if self.identity is None or self.window_at is None:
            return self._reset(obs, "playback_window_started")

        wall_delta = now_at - self.previous_at
        media_delta = now_time - self.previous_time
        if wall_delta < 0 or media_delta < 0 or media_delta > wall_delta + self.JUMP_TOLERANCE:
            return self._reset(obs, "discontinuous_time_jump")

        self.previous_at = now_at
        self.previous_time = now_time
        total_wall = now_at - self.window_at
        total_media = now_time - self.window_time
        if total_wall >= self.REQUIRED_ADVANCE and total_media >= self.REQUIRED_ADVANCE:
            return Decision("success", "sustained_playback", advanced_seconds=total_media)
        return Decision("observing", "advancing", advanced_seconds=max(0.0, total_media))


class McpClient:
    def __init__(self, data_dir, port, timeout=15.0):
        deadline = time.monotonic() + timeout
        self.url = "http://127.0.0.1:{}/mcp".format(port)
        self.token = (pathlib.Path(data_dir) / "mcp-token").read_text().strip()
        if not self.token:
            raise ValueError("MCP token is empty")
        self.sid = None
        self.counter = 0
        self.sid, _ = self._rpc("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "media-playback-check", "version": "1"},
        }, timeout=max(0.001, deadline - time.monotonic()))
        try:
            self._notify("notifications/initialized", timeout=max(0.001, deadline - time.monotonic()))
        except urllib.error.HTTPError:
            pass

    def _headers(self):
        headers = {
            "Authorization": "Bearer {}".format(self.token),
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Origin": self.url.rsplit("/", 1)[0],
        }
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        return headers

    def _send(self, payload, timeout=60):
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers=self._headers())
        with urllib.request.urlopen(request, timeout=timeout) as response:
            self.sid = response.headers.get("Mcp-Session-Id") or self.sid
            body = response.read().decode()
        parsed = None
        for line in body.splitlines():
            if line.startswith("data: ") and line[6:].strip():
                parsed = json.loads(line[6:])
        return parsed if parsed is not None else json.loads(body)

    def _rpc(self, method, params, timeout=60):
        self.counter += 1
        out = self._send({"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params}, timeout=timeout)
        return self.sid, out

    def _notify(self, method, timeout=60):
        request = urllib.request.Request(
            self.url,
            data=json.dumps({"jsonrpc": "2.0", "method": method}).encode(),
            headers=self._headers(),
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()

    def call(self, name, arguments, timeout=60):
        _, out = self._rpc("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        if "error" in out:
            raise RuntimeError(out["error"])
        result = out["result"]
        content = result.get("content", [])
        text = content[0].get("text", "") if content else ""
        if result.get("isError"):
            raise RuntimeError(text or "MCP tool failed")
        try:
            return json.loads(text)
        except (TypeError, json.JSONDecodeError):
            return text


def verify(client, tab_id, expected_url, timeout=15.0, poll_interval=0.2):
    verifier = PlaybackVerifier(expected_url)
    started = time.monotonic()
    deadline = started + timeout
    evidence = {
        "status": "failure", "reason": "timeout", "tab_id": tab_id,
        "required_advance_seconds": verifier.REQUIRED_ADVANCE,
        "observations": [], "actions": [],
    }
    while time.monotonic() < deadline:
        remaining = max(0.001, deadline - time.monotonic())
        try:
            raw = client.call("page_evaluate", {"tab_id": tab_id, "expression": OBSERVE_EXPRESSION}, timeout=remaining)
        except Exception as error:
            evidence["reason"] = "observation_failed"
            evidence["error"] = str(error)
            break
        if not isinstance(raw, dict):
            evidence["reason"] = "malformed_evaluate_result"
            break
        raw["observed_at"] = time.monotonic() - started
        decision = verifier.consume(raw)
        recorded = dict(raw)
        recorded["url_matches_expected"] = same_document_url(expected_url, recorded.pop("url", None))
        evidence["observations"].append(recorded)
        evidence["reason"] = decision.reason
        evidence["advanced_seconds"] = decision.advanced_seconds
        if decision.action:
            action = dict(decision.action)
            try:
                remaining = max(0.001, deadline - time.monotonic())
                action["result"] = client.call("page_click", {
                    "tab_id": tab_id, "locator": action["locator"]
                }, timeout=remaining)
            except Exception as error:
                action["error"] = str(error)
                evidence["actions"].append(action)
                evidence["reason"] = "trusted_click_failed"
                break
            evidence["actions"].append(action)
        if decision.status == "failure":
            break
        if decision.status == "success":
            evidence["status"] = "success"
            break
        time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
    evidence["elapsed_seconds"] = time.monotonic() - started
    return evidence


def main(argv=None):
    parser = JsonArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--tab-id", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--timeout", type=float, default=15.0)
    try:
        args = parser.parse_args(argv)
    except ValueError as error:
        print(json.dumps({"status": "failure", "reason": "invalid_arguments", "error": str(error)}, sort_keys=True))
        return 1
    evidence = {"status": "failure", "reason": "initialization_failed"}
    try:
        if args.port < 1 or args.port > 65535 or args.timeout <= 0:
            raise ValueError("port must be 1..65535 and timeout must be positive")
        deadline = time.monotonic() + args.timeout
        client = McpClient(args.data_dir, args.port, timeout=max(0.001, deadline - time.monotonic()))
        evidence = verify(client, args.tab_id, args.url, timeout=max(0.001, deadline - time.monotonic()))
    except Exception as error:
        evidence["error"] = str(error)
    print(json.dumps(evidence, sort_keys=True))
    return 0 if evidence.get("status") == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
