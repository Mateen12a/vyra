"""Makes the studio's built-in call backgrounds: soft, out-of-focus rooms, like a real camera's blurred backdrop.

    python scripts/make_backgrounds.py
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "person_studio" / "web" / "site" / "backgrounds"
W, H = 1280, 720

# name: (top colour, bottom colour, light colours, a window glow on the left?)
SCENES = {
    "studio": ((46, 34, 30), (18, 14, 13), [(255, 170, 110), (255, 210, 160), (230, 120, 80)], False),
    "office": ((150, 160, 170), (70, 76, 84), [(235, 240, 245), (200, 215, 230), (255, 245, 225)], True),
    "lounge": ((92, 70, 58), (40, 30, 26), [(255, 200, 140), (250, 225, 190), (210, 150, 110)], True),
    "night": ((20, 26, 44), (8, 10, 18), [(120, 160, 255), (255, 190, 120), (200, 120, 255)], False),
}


def scene(top, bottom, lights, window, seed):
    rnd = random.Random(seed)
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = row
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    if window:
        g.rectangle([60, 60, 420, 520], fill=tuple(min(255, c + 60) for c in top))
    for _ in range(46):
        r = rnd.randint(18, 70)
        x, y = rnd.randint(0, W), rnd.randint(0, int(H * 0.75))
        c = rnd.choice(lights)
        k = rnd.uniform(0.25, 0.7)
        g.ellipse([x - r, y - r, x + r, y + r], fill=tuple(round(v * k) for v in c))
    glow = glow.filter(ImageFilter.GaussianBlur(26))
    img = Image.blend(img, Image.composite(glow, img, glow.convert("L")), 0.85)
    return img.filter(ImageFilter.GaussianBlur(6))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for i, (name, spec) in enumerate(SCENES.items()):
        scene(*spec, seed=i).save(OUT / f"{name}.jpg", quality=84, optimize=True)
        print("wrote", OUT / f"{name}.jpg")
