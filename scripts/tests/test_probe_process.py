"""A zero-exit parent cannot hide leaked browser helper processes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from probe_process import run_probe


class ProbeProcessTests(unittest.TestCase):
    def test_successful_parent_with_live_helper_fails_and_cleans_its_group(self):
        self.assert_leaked_helper_rejected(0)

    def test_expected_failure_with_live_helper_still_fails_and_cleans_its_group(self):
        self.assert_leaked_helper_rejected(1)

    def assert_leaked_helper_rejected(self, expected_exit_code):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'probe'
            pid_file = root / 'helper.pid'
            fake.write_text('''#!/usr/bin/env python3
import os,subprocess,sys
p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'])
with open(os.environ['CHILD_PID_FILE'],'w') as f: f.write(str(p.pid))
sys.exit(int(os.environ['PARENT_EXIT_CODE']))
''')
            fake.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'left helper processes'):
                run_probe(fake, {**os.environ, 'CHILD_PID_FILE': str(pid_file), 'PARENT_EXIT_CODE': str(expected_exit_code)}, root / 'output.log', 3, expected_exit_code=expected_exit_code)
            pid = pid_file.read_text().strip()
            result = subprocess.run(['ps', '-p', pid, '-o', 'stat='], capture_output=True, text=True)
            self.assertTrue(not result.stdout.strip() or result.stdout.strip().startswith('Z'), result.stdout)
