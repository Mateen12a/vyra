"""Synthetic browser-test assets. These never represent AI output."""
import shutil
import subprocess
from pathlib import Path

from PIL import Image

folder = Path(".data/browser-fixtures")
folder.mkdir(parents=True, exist_ok=True)
Image.new("RGB", (320, 320), "#b7a0ff").save(folder / "reference.png")
if not shutil.which("ffmpeg"):
    raise SystemExit("FFmpeg required to prepare browser-test fixtures.")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=16",
                "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(folder / "source.mp4")], check=True)
print("Prepared synthetic image and video fixtures.")
