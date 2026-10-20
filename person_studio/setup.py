"""First-run setup for a locally run VYRANI server.

`steps()` returns what the Setup Wizard shows in the UI: whether the AI engine
is configured, whether the browser extension and a desktop-camera path (OBS)
are set up, and whether FFmpeg is available. Where the server can fix things
itself, `install_portable_ffmpeg()` downloads a portable FFmpeg build into the
data directory so Clips and RTMP streaming work without admin rights or a
system-wide install. Nothing here launches installers or prompts UAC; the only
network traffic is the FFmpeg zip download.
"""
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
OBS_DOWNLOAD_URL = "https://obsproject.com/download"
DESTINATION_NAME = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
PROBE_NAME = "ffprobe.exe" if sys.platform == "win32" else "ffprobe"

from .obs_commander import local_mode


class SetupError(RuntimeError):
    pass


def portable_ffmpeg_dir(data_dir: Path) -> Path:
    return data_dir / "ffmpeg" / "bin"


def ffmpeg_executable(settings) -> Optional[Path]:
    """Explicit VYRA_FFMPEG_PATH wins, then a portable install, then PATH."""
    custom = (settings.ffmpeg_path or "").strip()
    if custom and custom != "ffmpeg" and Path(custom).exists() and Path(custom).is_file():
        return Path(custom)
    portable = portable_ffmpeg_dir(settings.data_dir) / DESTINATION_NAME
    if portable.exists():
        return portable
    found = shutil.which(custom if custom and custom != "ffmpeg" else "ffmpeg")
    return Path(found) if found else None


def _run_version_check(exe: Path) -> bool:
    try:
        result = subprocess.run([str(exe), "-version"], capture_output=True, timeout=30)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def fetch_url(url: str, destination: Path) -> None:
    """Streams a download to disk. Module-level so tests can monkeypatch it."""
    with urllib.request.urlopen(url, timeout=600) as response, destination.open("wb") as file:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            file.write(chunk)


def install_portable_ffmpeg(settings, fetch: Optional[Callable[[str, Path], None]] = None, verify=_run_version_check) -> Path:
    """Download and unpack FFmpeg into the data directory, then verify it runs.

    `fetch` is injectable so tests can fake the download; production code passes
    nothing and gets `fetch_url`. Windows-only: macOS/Linux users install FFmpeg
    with their package manager (the Setup Wizard shows that instead).
    """
    if sys.platform != "win32":
        raise SetupError("Automatic FFmpeg install is Windows-only. Install FFmpeg with your system package manager.")
    fetch = fetch or fetch_url
    ffmpeg_root = settings.data_dir / "ffmpeg"
    destination = portable_ffmpeg_dir(settings.data_dir)
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = ffmpeg_root / "ffmpeg.zip"
    try:
        fetch(FFMPEG_URL, archive_path)
        with zipfile.ZipFile(archive_path) as archive:
            found = {}
            for name in archive.namelist():
                lowered = name.lower()
                if lowered.endswith("/" + DESTINATION_NAME):
                    found[DESTINATION_NAME] = archive.read(name)
                elif lowered.endswith("/" + PROBE_NAME):
                    found[PROBE_NAME] = archive.read(name)
            if DESTINATION_NAME not in found:
                raise SetupError("The downloaded FFmpeg archive did not contain ffmpeg.exe. Try again later.")
            for name, payload in found.items():
                (destination / name).write_bytes(payload)  # flattened into bin/, wherever the zip parked them
        exe = destination / DESTINATION_NAME
        if not verify(exe):
            raise SetupError("The downloaded FFmpeg could not be executed. Try again later.")
    finally:
        archive_path.unlink(missing_ok=True)
    return destination / DESTINATION_NAME


def steps(settings, live_available: bool, engine_status: dict, obs_installed: bool, extension_ready: bool) -> list:
    """The Setup Wizard step list. The client overrides the extension step with
    its own live probe (see Studio.tsx); the server side is deliberately
    conservative and marks it as setup information, not a result."""
    everything_hosted = not local_mode(settings)
    engine_configured = live_available or bool(engine_status.get("configured"))
    engine_mode = engine_status.get("mode", "")
    found = ffmpeg_executable(settings)
    steps_out = []

    if everything_hosted:
        # Bandwidth/engine/payments are the operator's job; users just sign in.
        steps_out.append({"id": "engine", "title": "AI engine", "status": "done" if engine_configured else "missing",
                          "detail": "Handled by the VYRANI server."})
    else:
        steps_out.append({"id": "engine", "title": "AI engine (FAL_KEY)", "status": "done" if engine_configured else "missing",
                          "detail": "FAL_KEY is configured on this server." if engine_configured
                          else "Add FAL_KEY to your .env file and restart the server. Live mode uses Lucy 2.5 through fal.ai."})

    steps_out.append({"id": "extension", "title": "Browser virtual camera", "status": "done" if extension_ready else "guide",
                      "detail": "Adds your AI camera and microphone to supported calling websites in Chrome/Edge."})

    if not everything_hosted:
        if sys.platform in {"win32", "darwin"}:
            steps_out.append({"id": "camera_apps", "title": "Camera in desktop apps (OBS)", "status": "done" if obs_installed else "guide",
                              "detail": "OBS Studio is installed – the one-click launcher is in Studio's Virtual Cam tab." if obs_installed
                              else "Desktop apps need OBS Studio's signed virtual camera. Install it from obsproject.com, then use the one-click launcher in Studio's Virtual Cam tab."})
        if found:
            steps_out.append({"id": "ffmpeg", "title": "FFmpeg (Clips & streaming)", "status": "done",
                              "detail": "Found at {}.".format(found)})
        else:
            required = engine_mode == "clip"
            steps_out.append({"id": "ffmpeg", "title": "FFmpeg (Clips & streaming)",
                              "status": "missing" if required else "optional",
                              "detail": "Clips encode with FFmpeg on this server; install it below in one click." if required
                              else "Only needed for Clips or RTMP streaming. Install it below in one click when you want them.",
                              "fix": "download-ffmpeg" if sys.platform == "win32" else None})
    return steps_out
