"""Memory diagnostics retain process roles without exposing command arguments."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_benchmark import process_tree


class MemoryProcessTests(unittest.TestCase):
    def test_includes_nested_children_but_not_other_browser_sessions(self):
        rows = '''100 1 10 /tmp/Dive.app/Contents/MacOS/dive --secret=do-not-record
103 102 7 /tmp/Dive Helper --type=utility --private=do-not-record
200 1 900 /tmp/another-browser --type=renderer
102 100 20 /tmp/Dive Helper --type=renderer --private=do-not-record
101 100 5 /tmp/Dive Helper --type=gpu-process
'''
        processes = process_tree(100, rows)
        self.assertEqual([row['pid'] for row in processes], [100, 101, 102, 103])
        self.assertEqual(sum(row['rss_kb'] for row in processes), 42)
        self.assertEqual([row['role'] for row in processes], ['browser', 'gpu-process', 'renderer', 'utility'])
        self.assertNotIn('do-not-record', str(processes))

    def test_missing_root_does_not_count_reparented_or_unrelated_children(self):
        self.assertEqual(process_tree(100, '102 1 50 helper --type=renderer'), [])


if __name__ == '__main__':
    unittest.main()
