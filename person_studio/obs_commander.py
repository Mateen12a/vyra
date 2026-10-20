"""VYRANI Camera Commander – launches the user's own OBS Studio install as a system camera.

VYRANI never bundles, embeds, or links OBS. The Commander only:
  1. writes a small scene-collection JSON into the user's OBS config directory, and
  2. launches the user's installed OBS executable with OBS's documented flags
     (--collection "VYRANI Camera" --startvirtualcam --minimize-to-tray --multi,
     https://obsproject.com/kb/launch-parameters).

OBS Studio is GPLv2; interacting with the user's installed OBS through files and process
boundaries is the same "separate program" pattern as the OBS remote-control ecosystem, and
is what allows a closed, VYRANI-branded launcher. Do not copy OBS code into this module.

Only enabled when the server runs in pure-local mode (no accounts/hosted deployment), so it
can never launch a native process on a hosted server."""
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Union

VIRTUAL_CAM_WINDOW_TITLE = "VYRANI AI Camera Output"  # matches Studio.tsx clean pop-out title
COLLECTION_NAME = "VYRANI Camera"

# OBS scene collection JSON: minimal, per OBS's basic/scenes layout. The window_capture
# settings use title matching; if OBS cannot auto-match, the user picks the window once
# in OBS and it persists (documented deviation in native-cam/README.md).


def local_mode(settings) -> bool:
    """Pure-local mode: no hosted accounts, no bearer token required."""
    return not settings.mongo_uri and not settings.api_token


def obs_executable_candidates() -> list[Path]:
    paths: list[Path] = []
    if sys.platform == "win32":
        for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                paths.append(Path(base) / "obs-studio" / "bin" / "64bit" / "obs64.exe")
    elif sys.platform == "darwin":
        paths.append(Path("/Applications/OBS.app"))
        paths.append(Path.home() / "Applications/OBS.app")
    return paths


def find_obs() -> Optional[Path]:
    for path in obs_executable_candidates():
        if path.exists():
            return path
    return None


def scenes_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", "")) / "obs-studio" / "basic" / "scenes"
    return Path.home() / "Library" / "Application Support" / "obs-studio" / "basic" / "scenes"


def write_collection(window_title: str = VIRTUAL_CAM_WINDOW_TITLE) -> Path:
    """Create the 'VYRANI Camera' scene collection with one window-capture source."""
    directory = scenes_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{COLLECTION_NAME}.json"
    path.write_text(
        _collection_json(window_title),
        encoding="utf-8",
    )
    return path


def _collection_json(window_title: str) -> str:
    collection = {
        "name": COLLECTION_NAME,
        "current_scene": COLLECTION_NAME,
        "current_program_scene": COLLECTION_NAME,
        "scene_order": [{"name": COLLECTION_NAME}],
        "sources": [
            {
                "name": COLLECTION_NAME,
                "id": "scene",
                "settings": {},
                "items": [
                    {
                        "name": "VYRANI Output Window",
                        "visible": True,
                        "locked": False,
                    }
                ],
            },
            {
                "name": "VYRANI Output Window",
                "id": "window_capture",
                "settings": {
                    "window": window_title,
                    "priority": 1,  # 1 = match by window title
                },
            },
        ],
        "resolution": {"x": 1280, "y": 720},
        "fps": 30,
    }
    return json.dumps(collection, indent=2)


def launch_command(exe: Path) -> list[str]:
    """OBS launch args per https://obsproject.com/kb/launch-parameters."""
    flags = ["--collection", COLLECTION_NAME, "--startvirtualcam", "--minimize-to-tray", "--multi"]
    if sys.platform == "darwin":
        return ["open", "-a", str(exe), "--args", *flags]
    return [str(exe), *flags]


def launch_obs(exe: Path, spawn=subprocess.Popen, detach=subprocess.DEVNULL):
    """Spawn OBS detached; returns whatever ``spawn`` returns (used by tests)."""
    command = launch_command(exe)
    kwargs: dict = {
        "stdout": detach,
        "stderr": detach,
        "stdin": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        return spawn(command, **kwargs)
    except OSError as exc:  # keep the message user-facing
        raise RuntimeError(f"Could not start OBS: {exc}") from exc
