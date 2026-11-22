"""Slice source art into per-state transparent PNGs for the desktop app.

Usage: python3 tools/assets/build_characters.py  (requires numpy, pillow, scipy)
Deterministic: re-run after replacing anything in assets/source/.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets" / "source"
OUT = ROOT / "apps" / "desktop" / "src" / "renderer" / "characters"

# Target render height in px at 2x DPR (rendered at half size in CSS).
BODY_HEIGHT = 320
AVATAR_HEIGHT = 160

# (top, left, bottom, right) boxes on girl-sheet.webp, found via connected components.
GIRL_BOXES: dict[str, tuple[int, int, int, int]] = {
    "idle": (17, 102, 777, 478),
    "walk": (788, 1040, 1233, 1195),
    "sit": (791, 11, 1220, 395),
    "sleep": (804, 423, 1211, 778),
    "avatar": (23, 556, 376, 840),
    "avatar-happy": (413, 910, 753, 1195),
}


# Sheet poses are drawn at different scales; normalise head size to the standing pose.
GIRL_HEIGHTS = {
    "sit": 196,
    "sleep": 176,
    "avatar": AVATAR_HEIGHT,
    "avatar-happy": AVATAR_HEIGHT,
}


def remove_white_background(rgb: np.ndarray) -> np.ndarray:
    """Alpha = 0 for near-white regions connected to the crop border.

    Interior whites (eye highlights, sneakers) survive because they are not
    connected to the border through near-white pixels.
    """
    near_white = (rgb.astype(int) >= 232).all(axis=2)
    labels, _ = ndimage.label(near_white)
    border = np.unique(
        np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    )
    background = np.isin(labels, border[border != 0])
    # Defringe: also drop the 1px light halo produced by webp compression.
    halo = ndimage.binary_dilation(background, iterations=1) & (
        rgb.astype(int).min(axis=2) >= 205
    )
    alpha = np.where(background | halo, 0, 255).astype(np.uint8)
    return np.dstack([rgb, alpha])


def keep_largest_component(rgba: np.ndarray) -> np.ndarray:
    """Drop decorations (sparkles, hearts, code bubble) detached from the body."""
    solid = ndimage.binary_closing(rgba[..., 3] > 0, iterations=3)
    labels, n = ndimage.label(solid)
    if n <= 1:
        return rgba
    sizes = ndimage.sum(solid, labels, range(1, n + 1))
    keep = labels == (int(np.argmax(sizes)) + 1)
    out = rgba.copy()
    out[..., 3] = np.where(keep, out[..., 3], 0)
    return out


def trim(img: Image.Image, pad: int = 2) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    assert bbox, "empty sprite"
    l, t, r, b = bbox
    return img.crop((max(l - pad, 0), max(t - pad, 0), r + pad, b + pad))


def fit_height(img: Image.Image, height: int, pixelated: bool) -> Image.Image:
    w = round(img.width * height / img.height)
    return img.resize((w, height), Image.NEAREST if pixelated else Image.LANCZOS)


def build_girl() -> dict:
    sheet = np.array(Image.open(SRC / "girl-sheet.webp").convert("RGB"))
    out = OUT / "girl"
    out.mkdir(parents=True, exist_ok=True)
    for name, (t, l, b, r) in GIRL_BOXES.items():
        rgba = remove_white_background(sheet[t:b, l:r])
        rgba = keep_largest_component(rgba)
        img = trim(Image.fromarray(rgba, "RGBA"))
        target = GIRL_HEIGHTS.get(name, BODY_HEIGHT)
        fit_height(img, target, pixelated=False).save(out / f"{name}.png", optimize=True)
    return {
        "id": "girl",
        "name": "Me",
        "pixelated": False,
        "scale": 0.5,
        "states": {
            "idle": {"src": "idle.png", "blink": "idle-blink.png"},
            "walk": {"src": "walk.png", "facing": "right"},
            "sit": {"src": "sit.png"},
            "sleep": {"src": "sleep.png"},
            "alert": {"src": "idle.png", "blink": "idle-blink.png"},
            "happy": {"src": "idle.png", "blink": "idle-blink.png"},
        },
        "avatar": {"default": "avatar.png", "happy": "avatar-happy.png"},
    }


def build_robot() -> dict:
    out = OUT / "robot"
    out.mkdir(parents=True, exist_ok=True)
    names = {1: "neutral", 2: "happy", 3: "content", 4: "alert"}
    for i, name in names.items():
        img = trim(Image.open(SRC / f"robot-{i}.png").convert("RGBA"), pad=0)
        # Source art is already a crisp 20px grid; rendered with image-rendering: pixelated.
        img.save(out / f"{name}.png", optimize=True)
    return {
        "id": "robot",
        "name": "Robo",
        "pixelated": True,
        "scale": 0.42,
        "states": {
            "idle": {"src": "neutral.png", "blink": "neutral-blink.png"},
            "walk": {"src": "neutral.png", "blink": "neutral-blink.png", "facing": "none"},
            "sit": {"src": "content.png"},
            "sleep": {"src": "content.png"},
            "alert": {"src": "alert.png"},
            "happy": {"src": "happy.png"},
        },
        "avatar": {"default": "alert.png", "happy": "happy.png"},
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifests = [build_girl(), build_robot()]
    for m in manifests:
        (OUT / m["id"] / "manifest.json").write_text(json.dumps(m, indent=2) + "\n")
    (OUT / "index.json").write_text(
        json.dumps([m["id"] for m in manifests], indent=2) + "\n"
    )
    import blink  # noqa: PLC0415  (sibling script; needs the exports above)

    blink.girl()
    blink.robot()
    print("built:", ", ".join(m["id"] for m in manifests))


if __name__ == "__main__":
    main()
