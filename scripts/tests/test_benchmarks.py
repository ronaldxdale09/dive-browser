"""Exercise the public benchmark command with controlled executable processes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class StartupBenchmarkTests(unittest.TestCase):
    def run_probe(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'scripts'
            scripts.mkdir()
            for name in ('benchmark-startup.sh', 'startup_benchmark.py', 'probe_process.py'):
                if (SCRIPTS / name).exists():
                    shutil.copy2(SCRIPTS / name, scripts / name)
            fake = root / 'probe'
            fake.write_text('''#!/usr/bin/env python3
import json,os,time,sys
assert os.environ.get('DIVE_USE_MOCK_KEYCHAIN') == '1', 'test accessed system keychain'
mode=os.environ['FAKE_MODE']
if mode == 'crash': sys.exit(9)
if mode == 'no-record': sys.exit(0)
report={'total_startup_ms':180.0,'timeline':{'state_init_ms':30.0,'window_created_ms':60.0,'setup_complete_ms':80.0,'chrome_paint_ms':150.0},'milestones':{'controls_ready':180.0,'window_created_to_setup_complete_ms':20.0}}
if mode == 'missing-paint': report['timeline']['chrome_paint_ms']=None
if mode == 'nan': report['total_startup_ms']=float('nan')
if mode == 'missing-controls': report['milestones'].pop('controls_ready')
if mode == 'bad-order': report['timeline']['chrome_paint_ms']=20.0
with open(os.environ['DIVE_BENCHMARK_OUTPUT'],'w') as f: json.dump(report,f)
print('fixture output is retained',flush=True)
if mode == 'hang': time.sleep(60)
''')
            fake.chmod(0o755)
            environment = {**os.environ, 'DIVE_BIN': str(fake), 'FAKE_MODE': mode,
                           'BENCH_COLD_RUNS': '2', 'BENCH_WARM_RUNS': '2',
                           'DIVE_PROBE_TIMEOUT_SECS': '0.75',
                           'DIVE_BENCHMARK_RESULTS_DIR': str(root / 'results')}
            completed = subprocess.run(['bash', str(scripts / 'benchmark-startup.sh')],
                                       env=environment, capture_output=True, text=True, timeout=5)
            summary_path = root / 'target/startup-benchmark-summary.json'
            summary = json.loads(summary_path.read_text()) if summary_path.exists() else None
            logs = list((root / 'results').glob('*.log'))
            return completed, summary, [p.read_text() for p in logs]

    def test_failed_launch_is_not_a_successful_zero_sample_benchmark(self):
        result, summary, _ = self.run_probe('crash')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIsNone(summary)

    def test_incomplete_reports_fail_without_a_success_summary(self):
        for mode in ('no-record', 'missing-paint', 'nan', 'missing-controls', 'bad-order'):
            with self.subTest(mode=mode):
                result, summary, _ = self.run_probe(mode)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIsNone(summary)

    def test_completed_records_do_not_mask_process_shutdown_hang(self):
        result, summary, logs = self.run_probe('hang')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(summary)
        self.assertTrue(any('fixture output is retained' in log for log in logs))

    def test_complete_runs_produce_measured_summary_and_keep_logs(self):
        result, summary, logs = self.run_probe('valid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary['runs'], 4)
        self.assertEqual(summary['initial_paint_p50_ms'], 150)
        self.assertEqual(summary['controls_ready_p95_ms'], 180)
        self.assertNotIn('zero_ui_blocked', summary)
        self.assertEqual(len(logs), 5)


if __name__ == '__main__':
    unittest.main()
