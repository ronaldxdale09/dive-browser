"""Registry removal and late shutdown must not satisfy native discard evidence."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_benchmark import validate_native_closure


def sample(phase, ids):
    return 'DIVE_MEMORY_HEAP: ' + json.dumps({
        'phase': phase, 'isolates': {'shared': {}},
        'targets': [{'targetId': identity, 'type': 'page'} for identity in ids],
    })


RECEIPTS = ['DEBUG dive_native_close: stage=before_close webview=1',
            'DEBUG dive_native_close: stage=retired webview=1 live_browsers=1 native_children=1']


class MemoryClosureTests(unittest.TestCase):
    def test_completed_native_receipt_and_target_removal_pass(self):
        validate_native_closure('\n'.join([
            sample('loaded', ['one', 'two']), *RECEIPTS,
            sample('swept', ['two']), sample('settled', ['two']),
        ]), 1)

    def test_missing_late_reversed_duplicate_and_still_live_receipts_fail(self):
        for receipts, swept, late, count in [
            ([], ['two'], [], 1),
            ([], ['two'], RECEIPTS, 1),
            (RECEIPTS[::-1], ['two'], [], 1),
            (RECEIPTS * 2, ['three'], [], 2),
            (RECEIPTS, ['one', 'two', 'three'], [], 1),
        ]:
            with self.subTest(receipts=receipts, swept=swept, late=late, count=count):
                with self.assertRaisesRegex(ValueError, 'not confirmed retired'):
                    validate_native_closure('\n'.join([
                        sample('loaded', ['one', 'two', 'three']), *receipts,
                        sample('swept', swept), *late, sample('settled', swept),
                    ]), count)

    def test_missing_targets_and_changed_settled_target_fail(self):
        with self.assertRaisesRegex(ValueError, 'native target evidence'):
            validate_native_closure('\n'.join([
                sample('loaded', ['one', 'two']), *RECEIPTS,
                sample('swept', []), sample('settled', ['two']),
            ]), 1)
        with self.assertRaisesRegex(ValueError, 'not confirmed retired'):
            validate_native_closure('\n'.join([
                sample('loaded', ['one', 'two']), *RECEIPTS,
                sample('swept', ['two']), sample('settled', ['three']),
            ]), 1)
