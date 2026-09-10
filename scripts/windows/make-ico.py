#!/usr/bin/env python3
"""Build the Windows .ico from the macOS artwork.

The source icon is drawn to Apple's grid, which reserves a wide transparent
margin around the shape -- ours leaves the artwork filling about 81% of the
canvas. macOS relies on that margin. Windows does not: it draws an icon
edge-to-edge, so the very same file reads about a fifth smaller in the
taskbar and the title bar than every icon beside it.

So trim the margin off and re-lay the artwork on Windows' own proportions,
leaving only the slight breathing room its icons carry.

    python3 scripts/windows/make-ico.py
"""

from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parents[2] / "apps/desktop/src-tauri/icons"
# What fraction of the canvas edge the artwork should span on Windows.
FILL = 0.92
# Every size Explorer, the taskbar, the title bar and Alt-Tab ask for.
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    source = Image.open(ICONS / "source.png").convert("RGBA")
    box = source.getchannel("A").getbbox()
    if box is None:
        raise SystemExit("source.png is fully transparent")
    art = source.crop(box)

    edge = max(art.size)
    canvas = round(edge / FILL)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(art, ((canvas - art.width) // 2, (canvas - art.height) // 2))

    target = ICONS / "icon.ico"
    out.save(target, sizes=[(s, s) for s in SIZES])
    print(f"{target.name}: artwork {art.size} on {canvas}px canvas, sizes {SIZES}")


if __name__ == "__main__":
    main()
