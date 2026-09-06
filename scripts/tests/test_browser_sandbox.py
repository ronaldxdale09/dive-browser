"""A native sandbox claim must cover every owned renderer and fail on gaps."""
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser_sandbox import verify


class BrowserSandboxTests(unittest.TestCase):
    tree = ('10 1 900 browser\n11 10 700 helper --type=renderer\n'
            '12 10 400 helper --type=renderer\n13 10 300 helper --type=gpu-process\n'
            '99 1 100 other --type=renderer\n')

    def test_requires_every_owned_renderer_but_not_browser_or_other_apps(self):
        seen = []

        def query(pid):
            seen.append(pid)
            return pid == 11

        self.assertFalse(verify(10, self.tree, query)['allRenderersSandboxed'])
        self.assertEqual(seen, [11, 12])
        self.assertTrue(verify(10, self.tree, lambda _: True)['allRenderersSandboxed'])

    def test_missing_root_or_renderers_cannot_pass_vacuously(self):
        with self.assertRaisesRegex(RuntimeError, 'root'):
            verify(50, self.tree)
        with self.assertRaisesRegex(RuntimeError, 'no live renderers'):
            verify(10, '10 1 900 browser\n')

    def test_query_failure_is_not_interpreted_as_sandboxed(self):
        def error(_):
            raise OSError('permission denied')

        with self.assertRaises(OSError):
            verify(10, self.tree, error)
