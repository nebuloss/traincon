#!/usr/bin/env python3
"""Render the raster icons and the social preview card.

WhatsApp, Signal, Slack and friends will not rasterise an SVG, so the link
preview needs a real bitmap. Rather than carry a binary we cannot diff, the
card is drawn here from the same shapes as favicon.svg and the result is
committed; re-run after changing the artwork:

    python3 scripts/make-og-image.py

Deliberately free of any hostname: this repo is public and the card should
suit whatever domain it is deployed under.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

STATIC = Path(__file__).resolve().parent.parent / "src" / "client" / "static"
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")

W, H = 1200, 630
SS = 3  # supersampling factor; the card is drawn 3x then filtered down

BG = (14, 17, 22)
ACCENT = (77, 163, 255)
VIOLET = (139, 92, 246)
TEXT = (255, 255, 255)
MUTED = (168, 179, 196)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def bezier(p0, p1, p2, p3, steps=24):
    """Flatten one cubic segment; Pillow only fills polygons."""
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append((
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ))
    return out


# The train, in the same 64-unit box as favicon.svg. ('l' = line to, 'c' =
# cubic with two controls.) Keep in step with the SVG if either is edited.
BODY = [
    ("m", (11, 41)),
    ("c", (11, 38), (12.6, 35.1), (15.3, 32.9)),
    ("l", (31, 20.2)),
    ("c", (33.6, 18.1), (36.9, 17.0), (40.2, 17.0)),
    ("l", (47, 17)),
    ("c", (50.314, 17), (53, 19.686), (53, 23)),
    ("l", (53, 41)),
    ("c", (53, 42.105), (52.105, 43), (51, 43)),
    ("l", (13, 43)),
    ("c", (11.895, 43), (11, 42.105), (11, 41)),
]
WINDOW = [
    ("m", (20.5, 34.5)),
    ("l", (32, 25.2)),
    ("c", (33.6, 23.9), (35.6, 23.2), (37.7, 23.2)),
    ("l", (44, 23.2)),
    ("l", (44, 34.5)),
]


def flatten(path):
    pts, cur = [], None
    for seg in path:
        if seg[0] == "m":
            cur = seg[1]
            pts.append(cur)
        elif seg[0] == "l":
            cur = seg[1]
            pts.append(cur)
        else:
            _, c1, c2, end = seg
            pts.extend(bezier(cur, c1, c2, end))
            cur = end
    return pts


def place(pts, ox, oy, scale):
    return [(ox + x * scale, oy + y * scale) for x, y in pts]


def diagonal_gradient(size, a, b):
    """Built small and scaled up — smooth enough and far cheaper per pixel."""
    n = 64
    g = Image.new("RGB", (n, n))
    px = g.load()
    for y in range(n):
        for x in range(n):
            px[x, y] = lerp(a, b, (x + y) / (2 * n - 2))
    return g.resize(size, Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def font(name, px):
    return ImageFont.truetype(str(FONT_DIR / name), px)


def draw_icon(img, x, y, side):
    """The favicon tile: gradient plate, white train, wheels and rail."""
    tile = diagonal_gradient((side, side), ACCENT, VIOLET)
    img.paste(tile, (x, y), rounded_mask((side, side), round(side * 14 / 64)))

    s = side / 64
    layer = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.polygon(place(flatten(BODY), 0, 0, s), fill=(255, 255, 255, 245))
    for cx in (23, 43):
        r = 4.4 * s
        d.ellipse([cx * s - r, 47 * s - r, cx * s + r, 47 * s + r], fill=(255, 255, 255, 255))
    d.rounded_rectangle(
        [6 * s, 52.6 * s, 58 * s, 55.8 * s], radius=1.6 * s, fill=(255, 255, 255, 217)
    )
    img.paste(layer, (x, y), layer)

    # The cab glass: the plate showing through the body, as in the SVG.
    glass = Image.new("L", (side, side), 0)
    ImageDraw.Draw(glass).polygon(place(flatten(WINDOW), 0, 0, s), fill=140)
    img.paste(tile, (x, y), glass)


def main():
    w, h = W * SS, H * SS
    img = Image.new("RGB", (w, h), BG)

    # A wash of the brand gradient across the top-left, fading into the dark
    # so the wordmark keeps its contrast.
    wash = diagonal_gradient((w, h), ACCENT, VIOLET)
    fade = Image.new("L", (64, 64))
    fp = fade.load()
    for y in range(64):
        for x in range(64):
            fp[x, y] = max(0, round(120 - (x + y) * 1.6))
    img.paste(wash, (0, 0), fade.resize((w, h), Image.BILINEAR))

    draw_icon(img, 96 * SS, 196 * SS, 208 * SS)

    d = ImageDraw.Draw(img)
    tx = 372 * SS
    d.text((tx, 214 * SS), "Traincon", font=font("DejaVuSans-Bold.ttf", 116 * SS), fill=TEXT)
    d.text(
        (tx, 356 * SS),
        "Suivi des trains SNCF en temps réel",
        font=font("DejaVuSans.ttf", 44 * SS),
        fill=MUTED,
    )

    # A rail across the foot, echoing the icon.
    d.rounded_rectangle(
        [0, (H - 10) * SS, w, H * SS], radius=0, fill=lerp(ACCENT, VIOLET, 0.5)
    )

    save(img.resize((W, H), Image.LANCZOS), "og.png")


def square(side, pad):
    """A full-bleed tile: iOS and Android apply their own mask, so no rounding
    of our own, and the train is inset to survive an aggressive crop."""
    s = side * SS
    img = diagonal_gradient((s, s), ACCENT, VIOLET).convert("RGB")
    inner = round(s * (1 - 2 * pad))
    draw_icon(img, round(s * pad), round(s * pad), inner)
    return img.resize((side, side), Image.LANCZOS)


def save(img, name):
    out = STATIC / name
    img.save(out, "PNG", optimize=True)
    print(f"  {name} — {out.stat().st_size // 1024} kio")


if __name__ == "__main__":
    main()
    # apple-touch-icon is composited on the home screen with no mask beyond
    # rounded corners, so it can use the whole tile; the maskable Android
    # icons keep a 10% margin inside the safe zone.
    save(square(180, 0.0), "apple-touch-icon.png")
    save(square(192, 0.10), "icon-192.png")
    save(square(512, 0.10), "icon-512.png")
