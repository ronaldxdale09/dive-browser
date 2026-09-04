"""Disposable native launchers must never request the user's real keychain."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class NativeProbeEnvironmentTests(unittest.TestCase):
    def run_launcher(self, launcher):
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
    f.write(json.dumps({k:os.environ.get(k) for k in ('DIVE_USE_MOCK_KEYCHAIN','DIVE_DATA_DIR')})+'\\n')
assert os.environ.get('DIVE_USE_MOCK_KEYCHAIN') == '1'
if os.environ.get('DIVE_STARTUP_BENCHMARK'):
    with open(os.environ['DIVE_BENCHMARK_OUTPUT'],'w') as f: json.dump({'total_startup_ms':None},f)
    sys.exit(1)
if os.environ.get('DIVE_NATIVE_LIFECYCLE_PROBE'):
    print('DIVE_LIFECYCLE_PROBE: popout close and reattach verified')
    print('DIVE_LIFECYCLE_PROBE: quit requested with detached window' if os.environ['DIVE_NATIVE_LIFECYCLE_PROBE']=='quit' else 'DIVE_LIFECYCLE_PROBE: main window close requested')
    print('event loop exited')
else:
    sys.exit(9) # End live-check immediately after inspecting its actual launch environment.
''')
            fake.chmod(0o755)
            env = {**os.environ, 'DIVE_BIN': str(fake), 'RECORDED_ENV': str(recorded)}
            env.pop('DIVE_USE_MOCK_KEYCHAIN', None)
            command = ['bash' if launcher.endswith('.sh') else 'python3', str(scripts / launcher)]
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            return result, [json.loads(line) for line in recorded.read_text().splitlines()]

    def test_lifecycle_and_negative_startup_use_disposable_keychain(self):
        result, records = self.run_launcher('native_lifecycle_check.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(records), 5)
        self.assertTrue(all(r['DIVE_USE_MOCK_KEYCHAIN'] == '1' and r['DIVE_DATA_DIR'] for r in records))

    def test_live_check_launch_uses_disposable_keychain(self):
        result, records = self.run_launcher('live-check.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['DIVE_USE_MOCK_KEYCHAIN'], '1')
        self.assertTrue(records[0]['DIVE_DATA_DIR'])
