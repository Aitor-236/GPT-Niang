#!/usr/bin/env python3
"""Regenerates build/icon.png from the shared character art.

Only needed when the character image changes: electron-builder consumes the
generated icon, and build/ is not tracked in git.
"""

import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "gpt-niang-usage" / "assets" / "gpt-dragon-niang-bust.png"
TARGET = ROOT / "build" / "icon.png"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    width, height = image.size
    side = min(width, int(height * 0.75))
    left = (width - side) // 2
    icon = image.crop((left, 0, left + side, side)).resize((512, 512), Image.LANCZOS)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    icon.save(TARGET)
    print(f"wrote {TARGET} from {SOURCE} ({width}x{height})")


if __name__ == "__main__":
    main()
