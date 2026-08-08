#!/usr/bin/env python3
"""Generate the favicon set from images/Propsense_logo.png.

The source has ~25% transparent margin and is 432x460, so it must be trimmed to
the mark's alpha bbox and re-padded square, or the icon renders tiny and
off-centre at 16px.
"""
from PIL import Image

SRC = "images/Propsense_logo.png"
OUT = "."
PAD = 0.08  # breathing room, as a fraction of the square side

src = Image.open(SRC).convert("RGBA")
mark = src.crop(src.getchannel("A").getbbox())

side = int(max(mark.size) * (1 + 2 * PAD))
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)


def resize(img, n):
    return img.resize((n, n), Image.LANCZOS)


# iOS ignores alpha and composites onto black, so flatten onto white.
opaque = Image.new("RGBA", square.size, (255, 255, 255, 255))
opaque.alpha_composite(square)

resize(opaque, 180).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
resize(square, 192).save(f"{OUT}/icon-192.png")
resize(square, 512).save(f"{OUT}/icon-512.png")
square.save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png")
