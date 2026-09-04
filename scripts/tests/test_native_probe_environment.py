"""Disposable native launchers must never request the user's real keychain."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class NativeProbeEnvironmentTests(unittest.TestCase):
    def run_launcher(self, launcher, **extra):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'scripts'
            scripts.mkdir()
            for name in (launcher, 'probe_process.py', 'mcp-call.py'):
                shutil.copy2(SCRIPTS / name, scripts / name)
            recorded = root / 'environments.jsonl'
            fake = root / 'probe'
            fake.write_text('''#!/usr/bin/env python3
import json,os,sys
with open(os.environ['RECORDED_ENV'], 'a') as f:
    f.write(json.dumps({'argv':sys.argv[1:], **{k:os.environ.get(k) for k in ('DIVE_USE_MOCK_KEYCHAIN','DIVE_DATA_DIR')}})+'\\n')
assert os.environ.get('DIVE_USE_MOCK_KEYCHAIN') == '1'
if sys.platform == 'darwin':
    assert sys.argv[1:] == ['-ApplePersistenceIgnoreState', 'YES'], 'test can show an AppKit crash-restore prompt'
if os.environ.get('DIVE_STARTUP_BENCHMARK'):
    with open(os.environ['DIVE_BENCHMARK_OUTPUT'],'w') as f: json.dump({'total_startup_ms':None},f)
    sys.exit(1)
if os.environ.get('DIVE_NATIVE_LIFECYCLE_PROBE'):
    print('DIVE_LIFECYCLE_PROBE: popout close and reattach verified')
    print('DIVE_LIFECYCLE_PROBE: native navigation history verified')
    print('DIVE_LIFECYCLE_PROBE: chrome IPC boundary verified')
    print('DIVE_LIFECYCLE_PROBE: quit requested with detached window' if os.environ['DIVE_NATIVE_LIFECYCLE_PROBE']=='quit' else 'DIVE_LIFECYCLE_PROBE: main window close requested')
    if os.environ.get('DIVE_NETWORK_CAPTURE_PROBE_URL'):
        import urllib.request
        url = os.environ['DIVE_NETWORK_CAPTURE_PROBE_URL'] + 'json?capture-case=small-cache'
        urllib.request.urlopen(url).read()
        print('DIVE_NETWORK_PROBE: '+json.dumps([{'tab_id':'test-tab','request_id':str(i),'large':bool(os.environ.get('FAKE_CAPTURE_OVERSIZED')), 'url':url,'captured_bytes':2} for i in [1,2]]))
        print('DEBUG response body fetch dispatched tab_id=test-tab request_id=1')
        print('DEBUG response body fetch dispatched tab_id=test-tab request_id=2')
    print('DIVE_NETWORK_PROBE: compressed, cached, blob and service-worker capture verified')
    print('DIVE_PERMISSION_PROBE: native scalar/structured reset, shared-context reuse, container isolation and closed-context Ask/reopen verified')
    print('event loop exited')
else:
    sys.exit(9) # End live-check immediately after inspecting its actual launch environment.
''')
            fake.chmod(0o755)
            env = {**os.environ, 'DIVE_BIN': str(fake), 'RECORDED_ENV': str(recorded), **extra}
            env.pop('DIVE_USE_MOCK_KEYCHAIN', None)
            command = ['bash' if launcher.endswith('.sh') else 'python3', str(scripts / launcher)]
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            return result, [json.loads(line) for line in recorded.read_text().splitlines()]

    def test_lifecycle_and_negative_startup_use_disposable_keychain(self):
        result, records = self.run_launcher('native_lifecycle_check.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(records), 5)
        self.assertTrue(all(r['DIVE_USE_MOCK_KEYCHAIN'] == '1' and r['DIVE_DATA_DIR'] for r in records))

    def test_network_probe_uses_disposable_keychain(self):
        result, records = self.run_launcher('network_capture_check.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['DIVE_USE_MOCK_KEYCHAIN'], '1')
        self.assertTrue(records[0]['DIVE_DATA_DIR'])
        if sys.platform == 'darwin':
            self.assertEqual(records[0]['argv'], ['-ApplePersistenceIgnoreState', 'YES'])

    def test_network_probe_rejects_large_body_dispatched_before_omission(self):
        result, _ = self.run_launcher('network_capture_check.py', FAKE_CAPTURE_OVERSIZED='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('oversized response fetched before omission', result.stderr)

    def test_live_check_launch_uses_disposable_keychain(self):
        result, records = self.run_launcher('live-check.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['DIVE_USE_MOCK_KEYCHAIN'], '1')
        self.assertTrue(records[0]['DIVE_DATA_DIR'])
        if sys.platform == 'darwin':
            self.assertEqual(records[0]['argv'], ['-ApplePersistenceIgnoreState', 'YES'])
