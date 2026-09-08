import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import tempfile
from unittest import mock
import unittest
import urllib.request
import wave

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('fetch_filter_check', SCRIPTS / 'fetch_filter_check.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FetchFilterHarnessTests(unittest.TestCase):
    def test_counts_require_positive_controls_and_media_delivery_and_no_blocked_hits(self):
        expected = {}
        for phase in probe.PHASES:
            if phase != 'workspace':
                expected[phase + ':/control.js'] = 1
            if phase == 'off':
                expected[phase + ':/tracker.js'] = 1
            expected[phase + ':/fixture.wav'] = 1
        probe.validate_counts(expected)
        for changed in ({}, {**expected, 'privacy:/tracker.js': 1}, {**expected, 'workspace:/control.js': 1},
                        {**expected, 'off:/tracker.js': 0}, {**expected, 'restored:/control.js': 0}):
            with self.assertRaises(RuntimeError):
                probe.validate_counts(changed)

    def test_missing_reordered_and_duplicate_receipts_fail(self):
        rows = ['DIVE_FETCH_FILTER_PHASE: ' + json.dumps({'phase': phase}) for phase in probe.PHASES]
        documents = '\n'.join('DIVE_FETCH_DOCUMENT: ' + json.dumps({'phase': phase, 'requested': 1, 'paused': int(phase == 'mock')}) for phase in ['privacy', 'mock', 'disabled'])
        footer = '\n' + documents + '\n' + probe.MARKER + '\nevent loop exited'
        self.assertEqual(len(probe.validate_receipts('\n'.join(rows) + footer)), 4)
        for text in ('', '\n'.join(rows[:-1]) + footer, '\n'.join(reversed(rows)) + footer,
                     '\n'.join(rows + rows[:1]) + footer, '\n'.join(rows),
                     '\n'.join(rows) + footer.replace(documents, ''),
                     '\n'.join(rows) + footer.replace('"paused": 0', '"paused": 1'),
                     '\n'.join(rows) + footer.replace('"requested": 1', '"requested": 0')):
            with self.assertRaises(RuntimeError):
                probe.validate_receipts(text)

    def test_failed_native_run_still_retains_independent_server_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'test-binary'
            binary.write_bytes(b'never executed')
            def fail_native(_binary, _env, log, _timeout):
                log.write_text('injected native qualification failure')
                raise RuntimeError('injected native qualification failure')
            with mock.patch.object(probe, 'ROOT', root), mock.patch.object(probe, 'run_probe', fail_native), mock.patch.dict(probe.os.environ, {'DIVE_BIN': str(binary)}):
                with self.assertRaisesRegex(RuntimeError, 'injected'):
                    probe.main()
            evidence = next((root / 'target').glob('fetch-filter-probe-*'))
            self.assertEqual(json.loads((evidence / 'server-requests.json').read_text()), {})
            self.assertFalse((evidence / 'summary.json').exists(), 'failure must not write a passing summary')

    def test_loopback_media_is_valid_pcm_and_preserves_requested_range(self):
        audio = probe.audio_bytes()
        with wave.open(io.BytesIO(audio)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()), (1, 2, 8000, 800))
        server = probe.LoopbackServer(('127.0.0.1', 0), probe.Handler)
        server.counts, server.counts_lock = {}, threading.Lock()
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/fixture.wav?privacy',
                headers={'Host': f'ads.doubleclick.net:{server.server_port}', 'Range': 'bytes=44-63'})
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'], f'bytes 44-63/{len(audio)}')
                self.assertEqual(response.read(), audio[44:64])
            self.assertEqual(server.counts, {'privacy:/fixture.wav': 1})
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
