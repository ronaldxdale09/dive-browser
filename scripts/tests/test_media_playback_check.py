import importlib.util
import pathlib
import io
import json
import unittest
import copy
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
        "content": {"video_id": "jNQXAC9IVRw", "ad_showing": False},
    }


class PlaybackVerifierTests(unittest.TestCase):
    def test_youtube_does_not_count_ads_or_unidentified_media(self):
        url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        for content in [None, {"video_id": "jNQXAC9IVRw", "ad_showing": True}]:
            verifier = media.PlaybackVerifier(url)
            for at in (0, 1, 2):
                obs = observation(at=at, time=at, url=url)
                obs["content"] = content
                decision = verifier.consume(obs)
                self.assertNotEqual(decision.status, "success")
            self.assertEqual(verifier.consume(observation(at=3, time=3, url=url)).status, "observing")

    def test_youtube_rejects_player_video_id_mismatch(self):
        url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        obs = observation(at=0, time=0, url=url)
        obs["content"]["video_id"] = "other-video"
        decision = media.PlaybackVerifier(url).consume(obs)
        self.assertEqual(decision.status, "failure")
        self.assertEqual(decision.reason, "player_content_mismatch")

    def test_youtube_theme_reload_requires_a_fresh_continuous_window(self):
        url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        verifier = media.PlaybackVerifier(url)
        verifier.consume(observation(at=0, time=0, url=url))
        verifier.consume(observation(at=1, time=1, url=url))
        reloaded = url + "&themeRefresh=1"
        decision = verifier.consume(observation(at=1.7, time=1.7, document="new", url=reloaded))
        self.assertEqual(decision.status, "observing")
        self.assertEqual(decision.reason, "video_replaced")
        self.assertEqual(verifier.consume(observation(at=2.7, time=2.7, document="new", url=reloaded)).status, "observing")
        self.assertEqual(verifier.consume(observation(at=3.3, time=3.3, document="new", url=reloaded)).status, "success")

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


class TargetRecoveryTests(unittest.TestCase):
    URL = "https://example.test/watch?v=one"
    TARGET = {"locator": "css=[data-startup-play]", "rect": {"x": 246, "y": 151, "width": 68, "height": 48}}
    MISSING = {"code": -32602, "message": "nothing matches locator", "data": {
        "code": "target_not_found", "locator": "css=[data-startup-play]", "retryable": True,
    }}

    def run_script(self, steps, timeout=15):
        # Exercise the real MCP error parser and verifier; only transport/time are fake.
        clock = [0.0]
        overall_timeout = timeout
        pending = iter(steps)
        client = object.__new__(media.McpClient)

        def rpc(method, params, timeout):
            self.assertEqual(method, "tools/call")
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, overall_timeout - clock[0])
            name, result = next(pending)
            self.assertEqual(params["name"], name)
            clock[0] += 0.05
            return None, result

        def sleep(seconds):
            clock[0] += seconds

        client._rpc = rpc
        with mock.patch.object(media.time, "monotonic", side_effect=lambda: clock[0]), mock.patch.object(media.time, "sleep", side_effect=sleep):
            return media.verify(client, "tab-1", self.URL, timeout=timeout, poll_interval=0.5)

    def sample(self, **kwargs):
        obs = observation(at=0, time=kwargs.pop("time", 0), **kwargs)
        return ("page_evaluate", {"result": {"content": [{"text": json.dumps(obs)}]}})

    def click(self, error=None):
        return ("page_click", {"error": error} if error is not None else {
            "result": {"content": [{"text": '{"x":280,"y":175}'}]}})

    def test_unresolved_target_reobserves_then_verifies_trusted_fixture_playback(self):
        playing = observation(at=0, time=1.6)
        playing["trusted_pointer_events"] = FixtureEvidenceTests().evidence()["observations"][-1]["trusted_pointer_events"]
        steps = [self.sample(paused=True, target=self.TARGET), self.click(self.MISSING),
                 self.sample(paused=True, target=self.TARGET), self.click(),
                 self.sample(time=0), self.sample(time=0.55), self.sample(time=1.1),
                 ("page_evaluate", {"result": {"content": [{"text": json.dumps(playing)}]}})]
        result = self.run_script(steps)
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(media.fixture_input_errors(result), [])
        self.assertEqual(len(result["actions"]), 1)
        self.assertEqual(result["target_resolution_failures"][0]["error"], self.MISSING)
        action = result["actions"][0]
        self.assertGreater(action["finished_at"], action["started_at"])
        self.assertEqual(action["documentIdentity"], "document-1")
        self.assertEqual(action["videoIdentity"], "video-1")

    def test_reappearing_control_in_new_document_needs_fresh_playback_window(self):
        steps = [self.sample(paused=True, target=self.TARGET), self.click(self.MISSING),
                 self.sample(paused=True, target=self.TARGET, document="replacement"), self.click()]
        steps.extend(self.sample(time=value, document="replacement") for value in (0, 0.55, 1.1, 1.65))
        result = self.run_script(steps)
        self.assertEqual(result["status"], "success", result)
        self.assertGreaterEqual(result["advanced_seconds"], 1.5)
        self.assertEqual(result["actions"][0]["documentIdentity"], "replacement")
        # The local fixture contract still refuses document replacement/missing receipts.
        self.assertTrue(media.fixture_input_errors(result))

    def test_repeated_explicit_target_failures_are_bounded(self):
        steps = []
        for _ in range(3):
            steps.extend([self.sample(paused=True, target=self.TARGET), self.click(self.MISSING)])
        result = self.run_script(steps)
        self.assertEqual(result["reason"], "target_resolution_retry_limit_exceeded")
        self.assertEqual(result["actions"], [])
        self.assertEqual(len(result["target_resolution_failures"]), 3)
        self.assertLess(result["elapsed_seconds"], 15)

    def test_unknown_or_nonretryable_error_fails_without_duplicate_input(self):
        for error in [
            {"code": -32602, "message": "target_not_found retryable:true"},
            {**self.MISSING, "data": {**self.MISSING["data"], "retryable": False}},
            {**self.MISSING, "data": {**self.MISSING["data"], "retryable": "true"}},
            {**self.MISSING, "data": {"code": "dispatch_failed", "retryable": True}},
        ]:
            with self.subTest(error=error):
                result = self.run_script([self.sample(paused=True, target=self.TARGET), self.click(error)])
                self.assertEqual(result["reason"], "trusted_click_failed")
                self.assertEqual(len(result["observations"]), 1)
                self.assertEqual(len(result["actions"]), 1)
                self.assertEqual(result["actions"][0]["error"], error)

    def test_recovery_preserves_two_dispatched_actions_across_reloads(self):
        steps = [self.sample(paused=True, target=self.TARGET), self.click(self.MISSING),
                 self.sample(paused=True, target=self.TARGET, document="document-2"), self.click(),
                 self.sample(paused=True, target=self.TARGET, document="document-3"), self.click(),
                 self.sample(paused=True, target=self.TARGET, document="document-4")]
        result = self.run_script(steps)
        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["reason"], "trusted_action_limit_exceeded")
        self.assertEqual(len(result["actions"]), 2)
        self.assertEqual(len(result["target_resolution_failures"]), 1)
        self.assertEqual(result["actions"][0]["documentIdentity"], "document-2")
        self.assertEqual(result["actions"][1]["documentIdentity"], "document-3")

    def test_visible_already_attempted_target_is_reported_truthfully(self):
        result = self.run_script([self.sample(paused=True, target=self.TARGET), self.click(),
                                  self.sample(paused=True, target=self.TARGET)], timeout=1)
        self.assertEqual(result["reason"], "paused_after_startup_action")
        self.assertEqual(len(result["actions"]), 1)

    def test_target_recovery_keeps_original_deadline(self):
        result = self.run_script([self.sample(paused=True, target=self.TARGET), self.click(self.MISSING)], timeout=0.4)
        self.assertEqual(result["status"], "failure")
        self.assertAlmostEqual(result["elapsed_seconds"], 0.4)
        self.assertEqual(result["actions"], [])


class NavigationIdentityTests(unittest.TestCase):
    URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

    def test_only_verified_theme_reload_is_classified_as_same_video(self):
        self.assertEqual(media.classify_navigation(self.URL, self.URL + "#player"), "exact")
        self.assertEqual(media.classify_navigation(self.URL, self.URL + "&themeRefresh=1"), "same_video_theme_reload")
        self.assertEqual(media.classify_navigation(self.URL, "https://www.youtube.com/watch?themeRefresh=1&v=jNQXAC9IVRw"), "same_video_theme_reload")

    def test_theme_reload_does_not_admit_other_navigation_changes(self):
        for actual in [
            self.URL.replace("jNQXAC9IVRw", "other") + "&themeRefresh=1",
            self.URL.replace("https:", "http:") + "&themeRefresh=1",
            self.URL.replace("www.youtube.com", "www.youtube.com.evil.test") + "&themeRefresh=1",
            self.URL.replace("www.youtube.com", "www.youtube.com:443") + "&themeRefresh=1",
            self.URL.replace("/watch", "/embed") + "&themeRefresh=1",
            self.URL + "&themeRefresh=0", self.URL + "&themeRefresh=1&themeRefresh=1",
            self.URL + "&themeRefresh=1&v=jNQXAC9IVRw", self.URL + "&themeRefresh=1&extra=1",
            "https://www.youtube.com/watch?themeRefresh=1",
        ]:
            with self.subTest(actual=actual):
                self.assertEqual(media.classify_navigation(self.URL, actual), "mismatch")
        self.assertEqual(media.classify_navigation(self.URL + "&t=2", self.URL + "&themeRefresh=1"), "mismatch")
        self.assertEqual(media.classify_navigation("https://example.test/watch?v=one", "https://example.test/watch?v=one&themeRefresh=1"), "mismatch")


class FixtureEvidenceTests(unittest.TestCase):
    def evidence(self):
        before = observation(at=0, time=0, paused=True, target={
            "locator": "css=[data-startup-play]",
            "rect": {"x": 246, "y": 151, "width": 68, "height": 48},
        })
        after = observation(at=2, time=1.8)
        after["trusted_pointer_events"] = [
            {"type": name, "trusted": True, "tag": "BUTTON", "id": "start-media", "className": "fixture-play", "x": 280, "y": 175, "at": stamp}
            for name, stamp in [("pointerdown", 200), ("pointerup", 220), ("click", 220)]
        ]
        return {"status": "success", "advanced_seconds": 1.6,
                "actions": [{"type": "trusted_click", "locator": "css=[data-startup-play]", "result": {"x": 280, "y": 175}}],
                "observations": [before, after]}

    def test_accepts_real_fixture_input_receipt_shape(self):
        self.assertEqual(media.fixture_input_errors(self.evidence()), [])

    def test_rejects_missing_synthetic_or_mistargeted_input(self):
        original = self.evidence()
        for field, value in [("trusted", False), ("tag", "HTML"), ("id", None), ("className", "other"), ("x", 1000), ("at", None)]:
            evidence = copy.deepcopy(original)
            evidence["observations"][-1]["trusted_pointer_events"][1][field] = value
            with self.subTest(field=field):
                self.assertTrue(media.fixture_input_errors(evidence))
        for events in [[], original["observations"][-1]["trusted_pointer_events"][:2]]:
            evidence = copy.deepcopy(original)
            evidence["observations"][-1]["trusted_pointer_events"] = events
            self.assertTrue(media.fixture_input_errors(evidence))

    def test_rejects_autoplay_replacement_and_unverified_playback(self):
        for field, value in [("actions", []), ("status", "failure"), ("advanced_seconds", 0.1)]:
            evidence = self.evidence()
            evidence[field] = value
            self.assertTrue(media.fixture_input_errors(evidence))
        evidence = self.evidence()
        evidence["observations"][-1]["documentIdentity"] = "replacement"
        self.assertTrue(media.fixture_input_errors(evidence))


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
