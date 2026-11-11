"""The JS @tauri-apps/api and the Rust tauri crate must share major.minor."""
from pathlib import Path
import re
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
ROOT = SCRIPTS.parent

HINT = 'bump @tauri-apps/api together with the tauri git revision in Cargo.toml'


def parse_cargo_tauri_version(text):
    """Versions of every [[package]] named exactly `tauri` in a Cargo.lock."""
    return re.findall(r'^name = "tauri"\nversion = "([^"]+)"', text, re.MULTILINE)


def parse_pnpm_api_version(text):
    """Resolved versions of every `'@tauri-apps/api'` importer entry."""
    return re.findall(
        r"^\s+'@tauri-apps/api':\n\s+specifier: [^\n]+\n\s+version: (\d+\.\d+\.\d+)",
        text,
        re.MULTILINE,
    )


def skew(rust_version, js_version):
    """Return an error message when major.minor differ, else None."""
    if rust_version.split('.')[:2] == js_version.split('.')[:2]:
        return None
    return (
        f'Rust tauri is {rust_version} but @tauri-apps/api resolves to '
        f'{js_version}: {HINT}'
    )


class TauriVersionSkewTests(unittest.TestCase):
    def test_repo_versions_share_major_minor(self):
        rust = parse_cargo_tauri_version((ROOT / 'Cargo.lock').read_text())
        js = parse_pnpm_api_version((ROOT / 'pnpm-lock.yaml').read_text())
        self.assertEqual(len(rust), 1, f'expected one tauri package in Cargo.lock, found {rust}')
        self.assertEqual(len(js), 1, f'expected one @tauri-apps/api in pnpm-lock.yaml, found {js}')
        self.assertIsNone(skew(rust[0], js[0]))

    def test_mismatch_is_reported(self):
        cargo = 'name = "tauri"\nversion = "2.12.0"\n\nname = "tauri-utils"\nversion = "2.1.0"\n'
        pnpm = "      '@tauri-apps/api':\n        specifier: ^2.11.1\n        version: 2.11.1\n"
        rust = parse_cargo_tauri_version(cargo)
        js = parse_pnpm_api_version(pnpm)
        self.assertEqual(rust, ['2.12.0'])
        self.assertEqual(js, ['2.11.1'])
        message = skew(rust[0], js[0])
        self.assertIsNotNone(message)
        self.assertIn('2.12.0', message)
        self.assertIn('2.11.1', message)
        self.assertIn(HINT, message)

    def test_missing_versions_are_not_a_silent_pass(self):
        self.assertEqual(parse_cargo_tauri_version('name = "tauri-utils"\nversion = "2.1.0"\n'), [])
        self.assertEqual(parse_pnpm_api_version('lockfileVersion: 9\n'), [])


if __name__ == '__main__':
    unittest.main()
