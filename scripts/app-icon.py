#!/usr/bin/env python3
"""Regenerate the app icon set from assets/logo.png.

The logo is the dark circle with the chevron wave. macOS shows app icons on a
rounded tile, so this bakes the logo into a light tile on the standard 1024 px
grid (824 px tile, 100 px margin) and hands the result to `tauri icon`, which
writes every size the bundles need under apps/desktop/src-tauri/icons/.

    python3 scripts/app-icon.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / "assets/logo.png"
ICONS = ROOT / "apps/desktop/src-tauri/icons"
SOURCE = ICONS / "source.png"
SUPERSAMPLE, SIZE = 4, 1024
TILE = (244, 244, 243, 255)


def compose() -> Image.Image:
    size = SIZE * SUPERSAMPLE
    logo = Image.open(LOGO).convert("RGBA")
    logo = logo.crop(logo.split()[3].getbbox())
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = size * 100 / SIZE
    tile = size - 2 * inset
    ImageDraw.Draw(image).rounded_rectangle((inset, inset, size - 1 - inset, size - 1 - inset), radius=int(tile * 0.2247), fill=TILE)
    diameter = int(tile * 0.66)
    image.alpha_composite(logo.resize((diameter, diameter), Image.LANCZOS), ((size - diameter) // 2, (size - diameter) // 2))
    return image.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> int:
    compose().save(SOURCE)
    desktop = ROOT / "apps/desktop"
    subprocess.run(["pnpm", "exec", "tauri", "icon", str(SOURCE), "-o", str(ICONS)], cwd=desktop, check=True)
    for mobile in ("android", "ios"):
        shutil.rmtree(ICONS / mobile, ignore_errors=True)
    print(f"wrote {ICONS.relative_to(ROOT)} from {LOGO.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
