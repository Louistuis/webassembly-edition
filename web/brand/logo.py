"""Renders the WebSim WASM Edition wordmark (web/page/logo.png, the title screen's and the
start screen's) from a Comic Sans MS Bold on this machine: "websim" in WebSim's colours,
each letter tilted a little, with a dark outline and drop shadow so it reads over any
panorama. "WASM EDITION" stays in pixel letters under it (the game's edition banner, the
page's pixel font), so it is not in the image. The image is ours; the font file is never
shipped.
    python3 web/brand/logo.py [FONT]"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = sys.argv[1] if len(sys.argv) > 1 else "/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf"
OUT = Path(__file__).resolve().parent.parent / "page" / "logo.png"
W, H = 1024, 224
BLUE, RED, YELLOW, GREEN = (66, 133, 244), (234, 67, 53), (251, 188, 5), (52, 168, 83)
INK = (24, 22, 38)
# letter, colour, tilt (degrees, counter-clockwise), lift (pixels up)
LETTERS = [("w", BLUE, 4, 0), ("e", RED, -3, 6), ("b", YELLOW, 3, 8), ("s", BLUE, -4, 2), ("i", GREEN, 5, -6), ("m", RED, -3, 8)]

def glyph(ch, size, fill, stroke):
    font = ImageFont.truetype(FONT, size)
    box = font.getbbox(ch, stroke_width=stroke)
    w, h = box[2] - box[0] + 40, box[3] - box[1] + 40
    layers = []
    for colour, dy in ((INK, 9), (INK, 0), (fill, 0)):
        im = Image.new("RGBA", (w, h + 10), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        s = stroke if colour == INK else 0
        d.text((20 - box[0], 20 - box[1] + dy), ch, font=font, fill=colour + (255,), stroke_width=s, stroke_fill=INK + (255,))
        layers.append(im)
    out = Image.new("RGBA", layers[0].size, (0, 0, 0, 0))
    for im in layers:
        out.alpha_composite(im)
    return out, font.getlength(ch)

img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
size, stroke = 168, 13
pieces = [glyph(ch, size, c, stroke) + (tilt, lift) for ch, c, tilt, lift in LETTERS]
gap = 4
total = sum(adv for _, adv, _, _ in pieces) + gap * (len(pieces) - 1)
x = (W - total) / 2
for im, adv, tilt, lift in pieces:
    r = im.rotate(tilt, resample=Image.BICUBIC, expand=True)
    cx = x + adv / 2
    img.alpha_composite(r, (int(cx - r.width / 2), int(112 - r.height / 2 - lift)))
    x += adv + gap

bbox = img.getbbox()
print("used", bbox)
img.save(OUT, optimize=True)
print(OUT, OUT.stat().st_size)
