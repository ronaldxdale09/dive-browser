"""Every committed script has a row in scripts/README.md."""
from pathlib import Path
import subprocess
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
ROOT = SCRIPTS.parent
SKIPPED_DIRECTORIES = ("tests", "fixtures", "release", "ci", "__pycache__")


def tracked_scripts():
    """Git-tracked files only, so a script another session has not committed
    yet neither fails this test nor needs a row before it exists."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", "scripts"],
        cwd=ROOT, capture_output=True, check=True, text=True,
    ).stdout
    for name in filter(None, listing.split("\0")):
        if not (ROOT / name).exists():  # deleted, not yet committed
            continue
        parts = Path(name).relative_to("scripts").parts
        if len(parts) > 2 or (len(parts) == 2 and parts[0] != "windows"):
            continue
        if parts[0] in SKIPPED_DIRECTORIES or parts[-1] == "README.md":
            continue
        yield parts[-1]


class ScriptsReadmeTests(unittest.TestCase):
    def test_every_tracked_script_is_listed(self):
        readme = (SCRIPTS / "README.md").read_text()
        names = list(tracked_scripts())
        self.assertGreater(len(names), 20)
        missing = [name for name in names if name not in readme]
        self.assertEqual(missing, [], "add a row to scripts/README.md for each")


if __name__ == "__main__":
    unittest.main()
