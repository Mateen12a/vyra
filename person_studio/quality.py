"""Cheap, local checks that stop poor inputs before any credits or provider money are spent.

The video models do their best work with a sharp, evenly lit, front-facing photo and a well-lit clip. These checks
catch the commonest causes of a weak result (darkness, blur, a tiny image) and say how to fix them.
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat

MIN_BRIGHTNESS = 55    # mean luma 0-255; below this faces lose detail
MIN_SHARPNESS = 12     # Laplacian variance at 768 px; sharp phone photos score 60-300+, a 2-3 px blur under 12
MIN_PHOTO_SIDE = 256   # px; the models need enough face detail
MIN_VIDEO_BRIGHTNESS = 45


def _luma(image: Image.Image):
    return ImageStat.Stat(image.convert("L")).mean[0]


LAPLACIAN = ImageFilter.Kernel((3, 3), (0, 1, 0, 1, -4, 1, 0, 1, 0), scale=1, offset=128)


def _sharpness(image: Image.Image):
    """Variance of the Laplacian (the usual blur measure), at a fixed scale and without the image border."""
    gray = image.convert("L")
    gray.thumbnail((768, 768))
    edges = gray.filter(LAPLACIAN)
    w, h = edges.size
    return ImageStat.Stat(edges.crop((4, 4, w - 4, h - 4))).var[0]


def check_photo(path: Path):
    """Raise ValueError with a friendly fix if the reference photo is likely to give a poor result."""
    with Image.open(path) as image:
        image = image.convert("RGB")
        if min(image.size) < MIN_PHOTO_SIDE:
            raise ValueError("This photo is too small for a clear face. Use one at least 256 pixels across, ideally a full-size phone photo.")
        if _luma(image) < MIN_BRIGHTNESS:
            raise ValueError("This photo is too dark. Use one taken facing a window or a lamp, with the face clearly lit.")
        if _sharpness(image) < MIN_SHARPNESS:
            raise ValueError("This photo looks blurry. Use a sharp, in-focus photo of the face.")


def check_video_light(path: Path, duration: float):
    """Raise ValueError if the clip is too dark to read a face. Looks at the middle frame."""
    try:
        frame = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", f"{max(0.0, duration / 2):.2f}", "-i", str(path),
                                "-frames:v", "1", "-vf", "scale=160:-2,format=gray", "-f", "rawvideo", "pipe:1"],
                               capture_output=True, timeout=30).stdout
    except (subprocess.SubprocessError, OSError):
        return  # can't judge; let the model try
    if frame and sum(frame) / len(frame) < MIN_VIDEO_BRIGHTNESS:
        raise ValueError("This video is too dark to read your face. Film again facing a window or a lamp.")
