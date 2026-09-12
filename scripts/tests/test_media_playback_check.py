import importlib.util
import pathlib
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "media-playback-check.py"
SPEC = importlib.util.spec_from_file_location("media_playback_check", MODULE_PATH)
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)


def observation(*, at, time, paused=False, ready=4, identity="video-1", document="document-1", url="https://example.test/watch?v=one", target=None):
    return {
        "observed_at": at,
        "url": url,
        "scroll": {"x": 0, "y": 0},
        "documentIdentity": document,
        "video": {
            "identity": identity,
            "connected": True,
            "currentTime": time,
            "readyState": ready,
            "paused": paused,
            "error": None,
        },
        "startup_target": target,
        "trusted_pointer_events": [],
    }


class PlaybackVerifierTests(unittest.TestCase):
    def test_playing_video_is_observed_without_requesting_a_click(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")

        decision = verifier.consume(observation(at=0.0, time=4.0))

        self.assertEqual(decision.action, None)
        self.assertEqual(decision.status, "observing")

    def test_paused_video_requests_only_a_visible_startup_overlay_click(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        target = {"locator": "css=[data-startup-play]", "rect": {"x": 10, "y": 20, "width": 80, "height": 50}}

        decision = verifier.consume(observation(at=0.0, time=0.0, paused=True, target=target))

        self.assertEqual(decision.action, {"type": "trusted_click", "locator": "css=[data-startup-play]"})

    def test_hidden_or_missing_overlay_is_never_replaced_with_transport_click(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")

        decision = verifier.consume(observation(at=0.0, time=0.0, paused=True))

        self.assertIsNone(decision.action)
        self.assertEqual(decision.reason, "paused_without_visible_startup_control")

    def test_continuous_advancement_reaches_success_after_one_point_five_seconds(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=10.0))
        verifier.consume(observation(at=0.8, time=10.8))

        decision = verifier.consume(observation(at=1.6, time=11.6))

        self.assertEqual(decision.status, "success")
        self.assertGreaterEqual(decision.advanced_seconds, 1.5)

    def test_replacement_resets_the_continuous_window(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))
        verifier.consume(observation(at=1.0, time=1.0))

        decision = verifier.consume(observation(at=1.7, time=1.7, identity="video-2"))

        self.assertEqual(decision.status, "observing")
        self.assertEqual(decision.reason, "video_replaced")

    def test_seek_jump_does_not_count_as_continuous_playback(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))

        decision = verifier.consume(observation(at=0.2, time=20.0))

        self.assertEqual(decision.status, "observing")
        self.assertEqual(decision.reason, "discontinuous_time_jump")

    def test_navigation_to_a_different_video_fails(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")

        decision = verifier.consume(observation(at=0.0, time=0.0, url="https://example.test/watch?v=two"))

        self.assertEqual(decision.status, "failure")
        self.assertEqual(decision.reason, "navigation_mismatch")

    def test_paused_or_unready_sample_resets_progress(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))
        verifier.consume(observation(at=1.0, time=1.0))
        verifier.consume(observation(at=1.2, time=1.2, ready=1))

        decision = verifier.consume(observation(at=3.0, time=3.0))

        self.assertEqual(decision.status, "observing")
        self.assertLess(decision.advanced_seconds, 1.5)

    def test_detached_video_sample_cannot_start_a_success_window(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))
        detached = observation(at=1.0, time=1.0)
        detached["video"]["connected"] = False
        verifier.consume(detached)

        decision = verifier.consume(observation(at=3.0, time=3.0))

        self.assertEqual(decision.status, "observing")

    def test_missing_video_resets_progress_instead_of_bridging_the_gap(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))
        verifier.consume(observation(at=1.0, time=1.0))
        missing = observation(at=1.2, time=1.2)
        missing["video"] = None
        verifier.consume(missing)

        decision = verifier.consume(observation(at=1.7, time=1.7))

        self.assertEqual(decision.status, "observing")
        self.assertLess(decision.advanced_seconds, 1.5)

    def test_same_url_document_reload_resets_even_when_video_counter_repeats(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        verifier.consume(observation(at=0.0, time=0.0))
        verifier.consume(observation(at=1.0, time=1.0))

        decision = verifier.consume(observation(at=1.7, time=1.7, document="document-2"))

        self.assertEqual(decision.status, "observing")
        self.assertEqual(decision.reason, "video_replaced")

    def test_trusted_startup_actions_are_bounded_across_video_replacements(self):
        verifier = media.PlaybackVerifier("https://example.test/watch?v=one")
        target = {"locator": "css=[data-startup-play]", "rect": {"x": 10, "y": 20, "width": 80, "height": 50}}
        verifier.consume(observation(at=0.0, time=0.0, paused=True, identity="video-1", target=target))
        verifier.consume(observation(at=0.2, time=0.0, paused=True, identity="video-2", target=target))
        verifier.consume(observation(at=0.3, time=0.0, paused=True, identity="video-2", target=target))
        verifier.consume(observation(at=0.4, time=0.0, paused=True, identity="video-3", target=target))

        decision = verifier.consume(observation(at=0.5, time=0.0, paused=True, identity="video-3", target=target))

        self.assertIsNone(decision.action)
        self.assertEqual(decision.status, "failure")
        self.assertEqual(decision.reason, "trusted_action_limit_exceeded")


class McpClientProtocolTests(unittest.TestCase):
    def test_malformed_cli_inputs_return_json_failure_evidence(self):
        output = io.StringIO()

        with redirect_stdout(output):
            status = media.main([])

        self.assertNotEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["reason"], "invalid_arguments")

    def test_notification_accepts_the_protocols_empty_http_response(self):
        class EmptyResponse:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self):
                return b""

        client = object.__new__(media.McpClient)
        client.url = "http://127.0.0.1:7493/mcp"
        client.token = "secret"
        client.sid = "session"
        with mock.patch.object(media.urllib.request, "urlopen", return_value=EmptyResponse()):
            client._notify("notifications/initialized")

    def test_rpc_uses_the_callers_remaining_deadline_as_http_timeout(self):
        class JsonResponse:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self):
                return b'{"jsonrpc":"2.0","id":1,"result":{}}'

        client = object.__new__(media.McpClient)
        client.url = "http://127.0.0.1:7493/mcp"
        client.token = "secret"
        client.sid = "session"
        client.counter = 0
        with mock.patch.object(media.urllib.request, "urlopen", return_value=JsonResponse()) as opened:
            client._rpc("tools/list", {}, timeout=0.25)

        self.assertEqual(opened.call_args.kwargs["timeout"], 0.25)

    def test_verification_passes_only_the_remaining_overall_timeout_to_rpc(self):
        class FakeClient:
            def __init__(self):
                self.timeouts = []

            def call(self, _name, _arguments, timeout):
                self.timeouts.append(timeout)
                return observation(at=0.0, time=0.0, url="https://example.test/watch?v=other")

        client = FakeClient()
        result = media.verify(client, "tab-1", "https://example.test/watch?v=one", timeout=0.25, poll_interval=0)

        self.assertEqual(result["reason"], "navigation_mismatch")
        self.assertEqual(len(client.timeouts), 1)
        self.assertGreater(client.timeouts[0], 0)
        self.assertLessEqual(client.timeouts[0], 0.25)

    def test_rpc_timeout_retains_the_last_observation_for_diagnostics(self):
        class FailingClient:
            def __init__(self):
                self.calls = 0

            def call(self, _name, _arguments, timeout):
                self.calls += 1
                if self.calls == 1:
                    return observation(at=0.0, time=0.0)
                raise TimeoutError("deadline reached")

        result = media.verify(FailingClient(), "tab-1", "https://example.test/watch?v=one", timeout=0.1, poll_interval=0)

        self.assertEqual(result["reason"], "observation_failed")
        self.assertEqual(len(result["observations"]), 1)
        self.assertIn("deadline reached", result["error"])


if __name__ == "__main__":
    unittest.main()
