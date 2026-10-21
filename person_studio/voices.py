"""AI accent voices for recordings: ElevenLabs' voice changer through fal, with the server's FAL_KEY.

The voice changer works on audio files, not live audio, so it is applied when a recording is saved:
the browser sends the recording's own voice (already lined up with the video), gets the new voice back
and puts it into the MP4. Preset voices only, no cloning. Billed by fal per minute of audio.
"""
import base64
import io
import math
import json
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from datetime import datetime, timezone

from .config import Settings

ENDPOINT = "https://fal.run/fal-ai/elevenlabs/voice-changer"
# Speech-to-speech into the voice of an uploaded sample (the user's own, or one they have permission to use).
SAMPLE_ENDPOINT = "https://fal.run/resemble-ai/chatterboxhd/speech-to-speech"
SAMPLE_MAX_BYTES = 6 * 1024 * 1024
PRICE_PER_MINUTE = 0.30  # fal's listed price for the ElevenLabs voice changer
# Billed per started minute: on 2026-10-11, 14 calls of 2-8 s each cost exactly 14 x $0.30 on the fal dashboard.
MIN_BILLED_MINUTES = 1
RESULT_HOSTS = (".fal.media", "storage.googleapis.com")
MAX_RESULT_BYTES = 40 * 1024 * 1024

# Preset ElevenLabs voices, all checked on fal on 2026-10-11 (each returned audio; unknown names return 422).
VOICES = [
    {"id": "american-male", "voice": "Brian", "accent": "American", "gender": "male"},
    {"id": "american-female", "voice": "Sarah", "accent": "American", "gender": "female"},
    {"id": "british-male", "voice": "George", "accent": "British", "gender": "male"},
    {"id": "british-female", "voice": "Lily", "accent": "British", "gender": "female"},
    {"id": "australian-male", "voice": "Charlie", "accent": "Australian", "gender": "male"},
    {"id": "swedish-female", "voice": "Charlotte", "accent": "Swedish", "gender": "female"},
    {"id": "transatlantic-male", "voice": "Callum", "accent": "Transatlantic", "gender": "male"},
]
_BY_ID = {v["id"]: v for v in VOICES}


class VoiceError(RuntimeError):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status  # 422 for input the user can fix, 503 for service problems


class VoiceChanger:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.recent = []

    def available(self):
        return bool(self.settings.fal_key)

    def catalogue(self):
        return [{k: v[k] for k in ("id", "accent", "gender", "voice")} for v in VOICES] if self.available() else []

    def convert(self, wav_bytes, voice_id):
        s = self.settings
        voice = _BY_ID.get(voice_id)
        if not voice:
            raise VoiceError("Unknown voice.", 422)
        seconds = _wav_seconds(wav_bytes)
        limit = min(s.live_max_session_seconds, s.voice_max_seconds) + 15
        if not 0.5 <= seconds <= limit:
            raise VoiceError(f"Recordings for AI voices must be 0.5 s to {limit} s long.", 422)
        if not s.fal_key:
            raise VoiceError("AI voices need FAL_KEY on the server.")
        now = time.monotonic()
        with self.lock:
            self.recent = [t for t in self.recent if now - t < 60]
            if len(self.recent) >= s.voice_calls_per_minute:
                raise VoiceError("Too many voice changes in the last minute. Wait a moment and try again.")
            self.recent.append(now)
        audio, mime = _compact(wav_bytes)
        result = self._post({"audio_url": f"data:{mime};base64," + base64.b64encode(audio).decode(),
                             "voice": voice["voice"], "output_format": "mp3_44100_128"})
        url = (result.get("audio") or {}).get("url") if isinstance(result, dict) else None
        if not isinstance(url, str):
            raise VoiceError("The voice service returned no audio. Try again.")
        data = _download(url)
        self._record(voice, seconds)
        return data

    def convert_to_sample(self, wav_bytes, sample_bytes, sample_mime):
        """Say the same words in the voice of `sample_bytes` (a short clean recording, 5-30 s works best)."""
        seconds = _wav_seconds(wav_bytes)
        if not 0.5 <= seconds <= self.settings.voice_max_seconds:
            raise VoiceError("This recording is too long for a voice change.", 422)
        if not sample_bytes or len(sample_bytes) > SAMPLE_MAX_BYTES:
            raise VoiceError("Upload a voice sample under 6 MB.", 422)
        if not self.settings.fal_key:
            raise VoiceError("AI voices need FAL_KEY on the server.")
        audio, mime = _compact(wav_bytes)
        result = self._post({"source_audio_url": f"data:{mime};base64," + base64.b64encode(audio).decode(),
                             "target_voice_audio_url": f"data:{sample_mime};base64," + base64.b64encode(sample_bytes).decode()},
                            SAMPLE_ENDPOINT)
        url = (result.get("audio") or {}).get("url") if isinstance(result, dict) else None
        if not isinstance(url, str):
            raise VoiceError("The voice service returned no audio. Try a clearer voice sample.")
        data = _download(url)
        self._record({"voice": "sample"}, seconds)
        return data

    def _post(self, payload, endpoint=ENDPOINT):
        request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), method="POST", headers={
            "Authorization": f"Key {self.settings.fal_key}", "Content-Type": "application/json",
            "User-Agent": "vyrani-ai/0.3"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:500].decode("utf-8", "replace")
            if exc.code in (401, 403):
                raise VoiceError("The voice service was refused. Check FAL_KEY on the server.")
            if exc.code == 402 or "balance" in detail.lower():
                raise VoiceError("Your fal balance is too low. Top up at fal.ai.")
            raise VoiceError("The voice service is unavailable right now. Your recording was kept with your own voice.")
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise VoiceError("Could not reach the voice service. Check this server's internet connection.")

    def _record(self, voice, seconds):
        ledger = self.settings.data_dir / "live-usage.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as file:
            file.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "provider": "fal-voice",
                                   "voice": voice["voice"], "seconds": round(seconds, 2),
                                   "cost_estimate": cost_of(seconds)}) + "\n")


def cost_of(seconds):
    """What fal charges for one conversion: whole minutes, at least one."""
    return round(max(MIN_BILLED_MINUTES, math.ceil(seconds / 60)) * PRICE_PER_MINUTE, 2)


def _wav_seconds(data):
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getnchannels() not in (1, 2) or w.getsampwidth() != 2 or not 8000 <= w.getframerate() <= 48000:
                raise VoiceError("Send 16-bit mono or stereo WAV audio.", 422)
            return w.getnframes() / w.getframerate()
    except (wave.Error, EOFError):
        raise VoiceError("The recording's audio could not be read.", 422)


def _compact(wav_bytes):
    """MP3 at 64 kbit/s when FFmpeg is installed (about 10x smaller to send), else the WAV as is."""
    if not shutil.which("ffmpeg"):
        return wav_bytes, "audio/wav"
    try:
        done = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
                               "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1"],
                              input=wav_bytes, capture_output=True, timeout=60, check=True)
        return (done.stdout, "audio/mpeg") if done.stdout else (wav_bytes, "audio/wav")
    except (subprocess.SubprocessError, OSError):
        return wav_bytes, "audio/wav"


def _download(url):
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or not (host.endswith(RESULT_HOSTS[0]) or host == RESULT_HOSTS[1]):
        raise VoiceError("The voice service returned an unexpected address.")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vyrani-ai/0.3"}), timeout=60) as response:
            data = response.read(MAX_RESULT_BYTES + 1)
    except (urllib.error.URLError, TimeoutError):
        raise VoiceError("Could not download the new voice. Try again.")
    if not data or len(data) > MAX_RESULT_BYTES:
        raise VoiceError("The voice service returned no usable audio.")
    return data
