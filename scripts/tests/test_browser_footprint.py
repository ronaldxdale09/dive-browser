import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser_footprint import sample


class BrowserFootprintTests(unittest.TestCase):
    tree = '10 1 900 browser\n11 10 700 helper --type=renderer\n12 11 500 helper\n99 1 400 other-browser --url=private\n'

    def test_sums_physical_footprint_separately_and_excludes_unrelated_processes(self):
        result = sample(10, self.tree, read=lambda pid: (pid, pid * 100))
        self.assertEqual(result['physicalFootprintBytes'], 33)
        self.assertEqual(result['residentBytes'], 3300)
        self.assertEqual([p['pid'] for p in result['processes']], [10, 11, 12])
        self.assertEqual(result['processes'][1]['role'], 'renderer')
        self.assertNotIn('private', str(result))

    def test_only_a_confirmed_retired_child_may_be_omitted(self):
        def read(pid):
            if pid == 11:
                raise OSError('exited during sampling')
            return 100, 200
        for status in ('', 'Z'):
            result = sample(10, self.tree, read=read, status=lambda _: status)
            self.assertEqual(result['physicalFootprintBytes'], 200)
            self.assertEqual(result['retiredDuringSample'][0]['pid'], 11)
        with self.assertRaises(OSError):
            sample(10, self.tree, read=read, status=lambda _: 'S')

    def test_a_missing_or_unmeasurable_root_is_not_a_low_memory_result(self):
        with self.assertRaises(RuntimeError):
            sample(10, '99 1 400 other-browser')
        def fail(_):
            raise OSError('root exited')
        with self.assertRaises(OSError):
            sample(10, self.tree, read=fail, status=lambda _: '')
