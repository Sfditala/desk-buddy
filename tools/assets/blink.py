"""Synthesise closed-eye frames for blinking (girl: paint eyelids; robot: pixel line)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "apps/desktop/src/renderer/characters"

# Eye boxes in girl/idle.png (x0, y0, x1, y1), measured on the 320px-tall export.
GIRL_EYES = [(58, 68, 87, 94), (105, 68, 133, 94)]


def girl() -> None:
    img = Image.open(OUT / "girl/idle.png").convert("RGBA")
    a = np.array(img).astype(int)
    for x0, y0, x1, y1 in GIRL_EYES:
        cheek = a[y1 + 2 : y1 + 6, x0 + 6 : x1 - 6, :3].reshape(-1, 3)
        skin = np.median(cheek, axis=0)
        region = a[y0:y1, x0:x1, :3]
        dist = np.abs(region - skin).sum(axis=2)
        a[y0:y1, x0:x1, :3][dist > 60] = skin.astype(int)
    out = Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(out)
    for x0, y0, x1, y1 in GIRL_EYES:
        cy = (y0 + y1) // 2 + 3
        d.arc((x0 + 1, cy - 7, x1 - 1, cy + 5), start=15, end=165, fill=(40, 28, 26, 255), width=3)
    out.save(OUT / "girl/idle-blink.png", optimize=True)


def robot() -> None:
    from scipy import ndimage

    img = Image.open(OUT / "robot/neutral.png").convert("RGBA")
    a = np.array(img)
    rgb = a[..., :3].astype(int)
    eyes = ((rgb.sum(axis=2) < 120) | (rgb.min(axis=2) > 220)) & (a[..., 3] > 0)
    eyes[int(a.shape[0] * 0.55) :, :] = False  # keep the mouth
    labels, n = ndimage.label(ndimage.binary_closing(eyes, iterations=2))
    boxes = ndimage.find_objects(labels)
    cy0 = min(b[0].start for b in boxes)
    xs = sorted((b[1].start, b[1].stop) for b in boxes)
    face = a[cy0 + 5, (xs[0][1] + xs[-1][0]) // 2].copy()  # face red between the eyes
    a[eyes] = face
    out = Image.fromarray(a, "RGBA")
    d = ImageDraw.Draw(out)
    for b in boxes:
        y = b[0].stop - 10
        d.rectangle((b[1].start, y - 10, b[1].stop - 1, y + 9), fill=(17, 17, 20, 255))
    out.save(OUT / "robot/neutral-blink.png", optimize=True)


if __name__ == "__main__":
    girl()
    robot()
    print("blink frames written")
