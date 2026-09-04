"""The public memory harness must bound and reject incomplete runs."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class MemoryBenchmarkTests(unittest.TestCase):
    def run_probe(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'scripts'
            scripts.mkdir()
            for name in ('benchmark-memory.sh', 'memory_benchmark.py', 'probe_process.py', 'startup_benchmark.py', 'memory-fixture.py'):
                if (SCRIPTS / name).exists():
                    shutil.copy2(SCRIPTS / name, scripts / name)
            fake = root / 'probe'
            fake.write_text('''#!/usr/bin/env python3
import os,sys,time,mmap
assert os.environ.get('DIVE_USE_MOCK_KEYCHAIN') == '1', 'test accessed system keychain'
print('fixture output is retained',flush=True)
if os.environ['FAKE_MODE']=='hang': time.sleep(60)
if os.environ['FAKE_MODE'] in ('valid', 'late-crash'):
    print('stress: baseline',flush=True)
    time.sleep(0.4)
    allocation=mmap.mmap(-1,80*1024*1024)
    allocation[::4096]=bytes([1])*(len(allocation)//4096)
    print('stress: loaded tabs=2',flush=True)
    time.sleep(0.4)
    allocation.close()
    print('stress: swept discarded=1',flush=True)
    print('stress: done',flush=True)
    time.sleep(0.4)
    print('stress: exiting',flush=True)
sys.exit(9 if os.environ['FAKE_MODE'] in ('crash', 'late-crash') else 0)
''')
            fake.chmod(0o755)
            environment = {**os.environ, 'DIVE_BIN': str(fake), 'FAKE_MODE': mode,
                           'STRESS_TABS': '2',
                           'DIVE_PROBE_TIMEOUT_SECS': '2.5' if mode in ('valid', 'late-crash') else '0.5'}
            process = subprocess.Popen(['bash', str(scripts / 'benchmark-memory.sh')],
                                       env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=True)
            timed_out = False
            try:
                out, err = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                out, err = process.communicate()
            summary_path = root / 'target/memory-benchmark.json'
            summary = json.loads(summary_path.read_text()) if summary_path.exists() else None
            return timed_out, process.returncode, summary, out + err

    def test_external_deadline_bounds_a_hung_browser(self):
        timed_out, code, summary, output = self.run_probe('hang')
        self.assertFalse(timed_out, 'memory harness ignored external deadline')
        self.assertNotEqual(code, 0, output)
        self.assertIsNone(summary)

    def test_crashes_and_missing_markers_are_rejected(self):
        for mode in ('crash', 'late-crash', 'missing-markers'):
            with self.subTest(mode=mode):
                timed_out, code, summary, output = self.run_probe(mode)
                self.assertFalse(timed_out)
                self.assertNotEqual(code, 0, output)
                self.assertIsNone(summary)

    def test_complete_live_samples_produce_summary_with_normal_process_model(self):
        timed_out, code, summary, output = self.run_probe('valid')
        self.assertFalse(timed_out)
        self.assertEqual(code, 0, output)
        self.assertEqual(summary['tabs'], 2)
        self.assertEqual(summary['discarded'], 1)
        self.assertGreater(summary['loaded_rss_kb'], summary['baseline_rss_kb'])
        self.assertGreater(summary['reclaimed_pct_of_growth'], 30)
        self.assertEqual(len(summary['binary_sha256']), 64)
        self.assertNotIn('--process-per-tab', summary['process_overrides']['DIVE_CHROMIUM_FLAGS'] or '')
