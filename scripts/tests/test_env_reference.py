"""Every DIVE_* variable the Rust code names must be documented."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
LITERAL = re.compile(r'"(DIVE_[A-Z0-9_]+)"')


def code_names():
    names = {}
    for base in (ROOT / 'apps/desktop/src-tauri/src', ROOT / 'crates'):
        for path in sorted(base.rglob('*.rs')):
            if 'target' in path.relative_to(ROOT).parts:
                continue
            for name in LITERAL.findall(path.read_text(encoding='utf-8')):
                names.setdefault(name, path.relative_to(ROOT))
    return names


class EnvironmentReferenceTests(unittest.TestCase):
    def test_every_variable_is_documented(self):
        text = (ROOT / 'docs/ENVIRONMENT.md').read_text(encoding='utf-8')
        names = code_names()
        self.assertTrue(names, 'no DIVE_* literals found; the scan is broken')
        missing = sorted(
            f'{name} (read in {where})'
            for name, where in names.items()
            if not re.search(rf'(?<![A-Z0-9_]){name}(?![A-Z0-9_])', text)
        )
        self.assertEqual([], missing, 'add these to docs/ENVIRONMENT.md')


if __name__ == '__main__':
    unittest.main()
