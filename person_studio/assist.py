"""Prompt assistant: turns a few words into a strong Lucy look, and a character photo into a description.

Runs a small Gemini model through fal's OpenRouter endpoints with the server's FAL_KEY, so users never
write prompts themselves. Each call costs a fraction of a cent; calls are rate limited and logged.
"""
import base64
import io
import json
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings

TEXT_ENDPOINT = "https://fal.run/openrouter/router"
VISION_ENDPOINT = "https://fal.run/openrouter/router/vision"

LOOK_SYSTEM = """You write prompts for Lucy, a real-time video model that edits a live webcam feed of one person.
Turn the user's short idea into one look. Rules for the prompt:
- 35 to 60 words, one paragraph, present tense, concrete and visual: materials, colours, textures, lighting.
- Say exactly what changes and where. For a full style use "Restyle the entire scene as ...". For costumes use
  "Dress the person in ..." and add "keep the face visible". For backgrounds use "Change the background to ...".
- Refer to "the person"; never assume gender, age or ethnicity.
- Unless the idea asks to change the person's face, skin, age or makeup, end the prompt with "Keep the person's own
  face, skin tone, facial features and expressions exactly as they are." Video models otherwise drift identity.
- No camera moves, no on-screen text or logos, nothing that needs a second person.
- If the idea names a real, identifiable person, describe a generic costume or style instead of their likeness.
- Keep it suitable for a general audience. If the idea is sexual, hateful or graphic, set "refused" to true.
- If a current look is given, keep everything in it and add only the requested change (e.g. weather, lighting, an
  extra item), merged into one prompt of at most 70 words. Name the result after the combined look.
Reply with JSON only: {"name": "2-3 word title", "note": "3-6 word subtitle", "prompt": "...", "refused": false}"""

CHARACTER_SYSTEM = """You describe a reference photo for a real-time video character swap, so the video model can
reproduce the look. Describe only what is visible: skin tone, face shape, hair (length, style, colour), facial hair,
eyewear, clothing (type, colour, material) and notable accessories. 15 to 35 words, comma-separated, plain and neutral.
Never name, identify or guess who the person is, and never state ethnicity, nationality or religion.
If the image shows no person, reply exactly: NO_PERSON"""


class AssistError(RuntimeError):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status  # 422 for input the user can fix, 503 for service problems


class Assistant:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.recent = []

    def available(self):
        return bool(self.settings.fal_key)

    def look(self, idea, base=None):
        idea = " ".join(str(idea or "").split())
        if not 2 <= len(idea) <= 300:
            raise AssistError("Describe the look in 2 to 300 characters.", 422)
        base = " ".join(str(base or "").split())[:700]
        prompt = f"Current look: {base}\nChange: {idea}" if base else f"Idea: {idea}"
        text = self._run(TEXT_ENDPOINT, {"system_prompt": LOOK_SYSTEM, "prompt": prompt}, "edit" if base else "look")
        data = _json_object(text)
        prompt = " ".join(str(data.get("prompt") or "").split())
        if data.get("refused") or not prompt:
            raise AssistError("That idea can't be made into a look. Try a costume, a character type or an art style.", 422)
        name = " ".join(str(data.get("name") or "").split())[:32] or idea[:32].title()
        note = " ".join(str(data.get("note") or "").split())[:48] or "Created for you"
        return {"name": name, "note": note, "prompt": prompt[:600]}

    def describe(self, image_bytes):
        data_uri = _image_data_uri(image_bytes)
        text = " ".join(self._run(VISION_ENDPOINT, {"system_prompt": CHARACTER_SYSTEM, "prompt": "Describe this person.",
                                                     "image_urls": [data_uri]}, "describe").split())
        if not text or "NO_PERSON" in text:
            raise AssistError("No person was found in that photo. Use a clear head-and-shoulders picture.", 422)
        return {"description": text.rstrip(".")[:300]}

    def _run(self, url, body, kind):
        s = self.settings
        if not s.fal_key:
            raise AssistError("The prompt assistant needs FAL_KEY on the server.")
        now = time.monotonic()
        with self.lock:
            self.recent = [t for t in self.recent if now - t < 60]
            if len(self.recent) >= s.assist_calls_per_minute:
                raise AssistError("Too many requests in the last minute. Wait a moment and try again.")
            self.recent.append(now)
        payload = {"model": s.assist_model, "max_tokens": 600, **body}
        try:
            result = self._post(url, payload)
        except _ReasoningRequired:
            # Some models (e.g. Gemini 3.x) refuse to run without reasoning; give them room to think.
            result = self._post(url, {**payload, "reasoning": True, "max_tokens": 2500})
        output = result.get("output") if isinstance(result, dict) else None
        if not isinstance(output, str) or not output.strip():
            raise AssistError(str(result.get("error") or "The prompt assistant returned nothing. Try again.")
                              if isinstance(result, dict) else "The prompt assistant returned nothing. Try again.")
        self._record(kind, result)
        return output.strip()

    def _post(self, url, payload):
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
            "Authorization": f"Key {self.settings.fal_key}", "Content-Type": "application/json",
            "User-Agent": "vyrani-ai/0.3"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:500].decode("utf-8", "replace")
            if exc.code == 400 and "reasoning is mandatory" in detail.lower():
                raise _ReasoningRequired()
            if exc.code in (401, 403):
                raise AssistError("The prompt assistant was refused. Check FAL_KEY on the server.")
            if exc.code == 402 or "balance" in detail.lower():
                raise AssistError("Your fal balance is too low. Top up at fal.ai.")
            raise AssistError("The prompt assistant is unavailable right now. Try again shortly.")
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise AssistError("Could not reach the prompt assistant. Check this server's internet connection.")

    def _record(self, kind, result):
        ledger = self.settings.data_dir / "live-usage.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        usage = {k: result.get(k) for k in ("cost", "total_tokens") if isinstance(result, dict) and k in result}
        with ledger.open("a", encoding="utf-8") as file:
            file.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "provider": "fal-assist",
                                   "kind": kind, "model": self.settings.assist_model, **usage}) + "\n")


class _ReasoningRequired(Exception):
    pass


def _json_object(text):
    """Parse the model's JSON reply, tolerating code fences or stray words around it."""
    match = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(match.group(0) if match else text)
    except ValueError:
        raise AssistError("The prompt assistant replied in an unexpected format. Try again.")
    if not isinstance(data, dict):
        raise AssistError("The prompt assistant replied in an unexpected format. Try again.")
    return data


def _image_data_uri(image_bytes, longest=1024):
    """Re-encode the upload: bounded size, no metadata, JPEG."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 40_000_000:
                raise AssistError("Use a JPG, PNG or WebP photo.", 422)
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((longest, longest))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=88)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise AssistError("This photo could not be read. Try a JPG, PNG or WebP.", 422)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()
