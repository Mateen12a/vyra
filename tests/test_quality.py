import subprocess
import shutil

import pytest
from PIL import Image, ImageEnhance, ImageFilter

from person_studio import quality


def photo(tmp_path, image, name="p.png"):
    path = tmp_path / name
    image.save(path)
    return path


def detailed():
    return Image.effect_noise((400, 400), 64).convert("RGB").point(lambda v: min(255, v + 40))


def test_sharp_bright_photo_passes(tmp_path):
    quality.check_photo(photo(tmp_path, detailed()))


@pytest.mark.parametrize("make, words", [
    (lambda: ImageEnhance.Brightness(detailed()).enhance(0.25), "too dark"),
    (lambda: detailed().filter(ImageFilter.GaussianBlur(4)), "blurry"),
    (lambda: detailed().resize((180, 180)), "too small"),
])
def test_poor_photos_get_a_fix(tmp_path, make, words):
    with pytest.raises(ValueError, match=words):
        quality.check_photo(photo(tmp_path, make()))


def test_dark_video_is_refused(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("needs FFmpeg")
    dark, bright = tmp_path / "dark.mp4", tmp_path / "bright.mp4"
    for path, source in ((dark, "color=c=0x101010:s=128x128"), (bright, "testsrc=s=128x128")):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source, "-t", "1", "-pix_fmt", "yuv420p", str(path)], check=True)
    with pytest.raises(ValueError, match="too dark"):
        quality.check_video_light(dark, 1.0)
    quality.check_video_light(bright, 1.0)
