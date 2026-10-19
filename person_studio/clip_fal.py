"""Clips through fal: Wan 2.2 Animate Replace runs on fal's GPUs, so no GPU worker of our own is needed.

Same interface as WanEngine (status, validate_video, run). The clip is normalised with FFmpeg here, sent to
fal's queue, polled until done, then the result is downloaded and given the source audio back.
Billed by fal per 16 output frames ($0.04 at 480p, $0.08 at 720p): a 30 fps clip costs about $0.075 per second at 480p.
"""
import base64
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Callable

from .config import Settings
from .engine import Cancelled, WanEngine

APP = "fal-ai/wan/v2.2-14b/animate/replace"
QUEUE = "https://queue.fal.run/" + APP
PRICE_PER_SECOND = {"480p": 0.04, "720p": 0.08}  # fal bills per 16 output frames ("video second")
# Checked on 2026-10-11: a 3 s, 30 fps clip at 480p (90 frames) cost $0.23 = 90 / 16 x $0.04.
RESULT_HOSTS = (".fal.media", "storage.googleapis.com")
MAX_RESULT_BYTES = 200 * 1024 * 1024


class FalClipEngine:
    name = "Wan 2.2 Animate · on fal"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.local = WanEngine(settings)  # reused for video validation only

    def status(self):
        reasons = []
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            reasons.append("FFmpeg and ffprobe are required on this server.")
        if not self.settings.fal_key:
            reasons.append("Clips need FAL_KEY on the server.")
        return {"configured": not reasons, "engine": self.name, "mode": "clip", "live_available": False,
                "model_state": "cloud", "provider": "fal",
                "message": "Ready. Clips run on fal (about $0.08 per second of clip at 480p)." if not reasons else " ".join(reasons)}

    def validate_video(self, path: Path):
        return self.local.validate_video(path)

    def run(self, folder: Path, options: dict, progress: Callable, cancel: Event):
        s = self.settings
        resolution = "480p" if options["quality"] == "preview" else "720p"
        progress("preparing", "Preparing your clip")
        longest = 854 if resolution == "480p" else 1280
        self._ffmpeg(["-i", str(folder / "upload.video"), "-map", "0:v:0", "-map", "0:a?", "-vf",
                      f"scale=w='min({longest},iw)':h='min({longest},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                      "-t", str(s.max_duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                      "-c:a", "aac", "-movflags", "+faststart", str(folder / "source.mp4")], cancel)
        payload = {
            "video_url": _data_uri(folder / "source.mp4", "video/mp4"),
            "image_url": _data_uri(folder / "reference.png", "image/png"),
            "resolution": resolution,
            "use_turbo": resolution == "480p",
            "video_quality": "high",
            "enable_output_safety_checker": True,
        }
        progress("transforming", "Sending to the cloud GPU")
        started = time.monotonic()
        queued = self._request("POST", QUEUE, payload)
        status_url, response_url = queued.get("status_url"), queued.get("response_url")
        cancel_url = queued.get("cancel_url")
        if not status_url or not response_url:
            raise RuntimeError("The cloud service did not accept the clip. Try again.")
        try:
            while True:
                if cancel.wait(2):
                    raise Cancelled()
                state = self._request("GET", status_url)
                status = state.get("status")
                if status == "IN_QUEUE":
                    position = state.get("queue_position")
                    progress("transforming", f"Waiting for a cloud GPU{f' (position {position + 1})' if isinstance(position, int) else ''}")
                elif status == "IN_PROGRESS":
                    progress("transforming", "Generating the new person on the cloud GPU")
                elif status == "COMPLETED":
                    break
                if time.monotonic() - started > s.timeout:
                    raise RuntimeError("The cloud clip took too long. Try a shorter clip.")
        except Cancelled:
            if cancel_url:
                try:
                    self._request("PUT", cancel_url)
                except RuntimeError:
                    pass
            raise
        result = self._request("GET", response_url)
        url = (result.get("video") or {}).get("url") if isinstance(result, dict) else None
        if not isinstance(url, str):
            detail = result.get("detail") if isinstance(result, dict) else None
            raise RuntimeError(_friendly(detail) or "The cloud service returned no video. Try a clearer single-person clip.")
        (folder / "generated.mp4").write_bytes(_download(url))
        generation = round(time.monotonic() - started, 2)
        progress("encoding", "Preparing your result")
        length = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                 str(folder / "generated.mp4")], capture_output=True, text=True, timeout=15).stdout.strip()
        self._ffmpeg(["-i", str(folder / "generated.mp4"), "-i", str(folder / "source.mp4"), "-map", "0:v:0", "-map", "1:a?",
                      "-c:v", "copy", "-c:a", "aac", *(["-t", length] if length else ["-shortest"]),
                      "-movflags", "+faststart", str(folder / "result.mp4")], cancel)
        if not (folder / "result.mp4").is_file() or (folder / "result.mp4").stat().st_size == 0:
            raise RuntimeError("The cloud result could not be prepared.")
        seconds = float(length or 0)
        frames = _frames(folder / "generated.mp4")
        cost = round(frames / 16 * PRICE_PER_SECOND[resolution], 3) if frames else None
        self._record(resolution, seconds, cost)
        return {"generation_seconds": generation, "cloud": "fal", "estimated_cost_usd": cost}

    def _ffmpeg(self, args, cancel: Event):
        if cancel.is_set():
            raise Cancelled()
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", *args], capture_output=True, timeout=300, check=True)
        except (subprocess.SubprocessError, OSError):
            raise RuntimeError("This video could not be prepared. Try an MP4 or a fresh camera recording.")

    def _request(self, method, url, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Key {self.settings.fal_key}", "Content-Type": "application/json", "User-Agent": "vyra-ai/0.3"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:800].decode("utf-8", "replace")
            if exc.code in (401, 403):
                raise RuntimeError("The cloud service was refused. Check FAL_KEY on the server.")
            if exc.code == 402 or "balance" in detail.lower():
                raise RuntimeError("Your fal balance is too low. Top up at fal.ai.")
            if exc.code == 422:
                raise RuntimeError(_friendly(detail) or "The cloud service could not use this clip or photo.")
            raise RuntimeError("The cloud service is unavailable right now. Try again shortly.")
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise RuntimeError("Could not reach the cloud service. Check this server's internet connection.")

    def _record(self, resolution, seconds, cost):
        ledger = self.settings.data_dir / "live-usage.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as file:
            file.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "provider": "fal-clip", "app": APP,
                                   "resolution": resolution, "seconds": round(seconds, 2), "cost_estimate": cost}) + "\n")


def pick_engine(settings: Settings):
    """A configured GPU worker wins; otherwise clips run on fal when a key is set."""
    local = WanEngine(settings)
    if local.status()["configured"] or not settings.fal_key:
        return local
    return FalClipEngine(settings)


def _frames(path: Path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                              "stream=nb_read_packets", "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=30).stdout
        return int(out.strip().split(",")[0])
    except (ValueError, IndexError, subprocess.SubprocessError, OSError):
        return 0


def _data_uri(path: Path, mime):
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def _friendly(detail):
    """Pull a readable message out of a fal error body, if there is one."""
    try:
        data = json.loads(detail) if isinstance(detail, str) else detail
    except ValueError:
        return None
    if isinstance(data, dict):
        data = data.get("detail", data)
    if isinstance(data, list) and data and isinstance(data[0], dict):
        message = data[0].get("msg")
        return str(message)[:200] if message else None
    return str(data)[:200] if isinstance(data, str) else None


def _download(url):
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or not (host.endswith(RESULT_HOSTS[0]) or host == RESULT_HOSTS[1]):
        raise RuntimeError("The cloud service returned an unexpected address.")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vyra-ai/0.3"}), timeout=120) as response:
            data = response.read(MAX_RESULT_BYTES + 1)
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Could not download the result. Try again.")
    if not data or len(data) > MAX_RESULT_BYTES:
        raise RuntimeError("The cloud service returned no usable video.")
    return data
