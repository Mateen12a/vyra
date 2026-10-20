import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("PERSON_DATA_DIR", ".data")).resolve())
    api_token: str = field(default_factory=lambda: os.getenv("PERSON_API_TOKEN", ""))
    allowed_origins: Tuple[str, ...] = field(default_factory=lambda: tuple(
        origin.strip() for origin in os.getenv(
            "PERSON_ALLOWED_ORIGINS", "http://127.0.0.1:8765,http://localhost:8765"
        ).split(",") if origin.strip()
    ))
    wan_repo: Optional[Path] = field(default_factory=lambda: Path(os.environ["WAN_REPO"]).resolve() if os.getenv("WAN_REPO") else None)
    wan_checkpoint: Optional[Path] = field(default_factory=lambda: Path(os.environ["WAN_CHECKPOINT"]).resolve() if os.getenv("WAN_CHECKPOINT") else None)
    wan_python: str = field(default_factory=lambda: os.getenv("WAN_PYTHON", sys.executable))
    steps: int = field(default_factory=lambda: int(os.getenv("WAN_STEPS", "20")))
    preview_steps: int = field(default_factory=lambda: int(os.getenv("WAN_PREVIEW_STEPS", "8")))
    offload_model: bool = field(default_factory=lambda: os.getenv("WAN_OFFLOAD_MODEL", "true").lower() in {"1", "true", "yes"})
    t5_cpu: bool = field(default_factory=lambda: os.getenv("WAN_T5_CPU", "true").lower() in {"1", "true", "yes"})
    # Keep the model loaded between jobs instead of reloading it (~4 minutes) for every clip.
    resident: bool = field(default_factory=lambda: os.getenv("WAN_RESIDENT", "true").lower() in {"1", "true", "yes"})
    merge_lora: bool = field(default_factory=lambda: os.getenv("WAN_MERGE_LORA", "true").lower() in {"1", "true", "yes"})
    # Optional step-distill LoRA (e.g. lightx2v I2V 480p); pair it with WAN_PREVIEW_STEPS/WAN_STEPS of 4-6.
    distill_lora: Optional[Path] = field(default_factory=lambda: Path(os.environ["WAN_DISTILL_LORA"]).resolve() if os.getenv("WAN_DISTILL_LORA") else None)
    distill_scale: float = field(default_factory=lambda: float(os.getenv("WAN_DISTILL_SCALE", "1.0")))
    preload: bool = field(default_factory=lambda: os.getenv("WAN_PRELOAD", "false").lower() in {"1", "true", "yes"})
    timeout: int = field(default_factory=lambda: int(os.getenv("WAN_TIMEOUT_SECONDS", "1800")))
    # Live mode (Lucy realtime through fal). The key stays server-side;
    # browsers get short-lived tokens.
    live_model: str = field(default_factory=lambda: os.getenv("LIVE_MODEL", "lucy-2.5"))
    fal_key: str = field(default_factory=lambda: os.getenv("FAL_KEY", ""))
    fal_live_app: str = field(default_factory=lambda: os.getenv("FAL_LIVE_APP", "decart/lucy-2-5/realtime"))
    # Kept for older .env files; fal is the only live engine.
    live_provider: str = field(default_factory=lambda: os.getenv("LIVE_PROVIDER", "").strip().lower())
    # Prompt assistant (writes looks and character descriptions) through fal's OpenRouter endpoints.
    assist_model: str = field(default_factory=lambda: os.getenv("ASSIST_MODEL", "google/gemini-2.5-flash"))
    assist_calls_per_minute: int = field(default_factory=lambda: int(os.getenv("ASSIST_CALLS_PER_MINUTE", "12")))
    # Development-only suppression of VYRANI-added disclosure/provenance marks.
    vyra_dev_mode: bool = field(default_factory=lambda: os.getenv("VYRA_DEV_MODE", "false").strip().lower() in {"1", "true", "on", "yes"})
    # Optional RTMP(S) ingest URL. The endpoint is configured server-side, not by the browser.
    rtmp_url: str = field(default_factory=lambda: os.getenv("VYRA_RTMP_URL", "").strip())
    # Users bring their own stream keys. Private/LAN ingest addresses are refused unless explicitly allowed (local testing).
    allow_private_ingest: bool = field(default_factory=lambda: os.getenv("VYRA_ALLOW_PRIVATE_INGEST", "false").strip().lower() in {"1", "true", "on", "yes"})
    max_streams: int = field(default_factory=lambda: max(1, int(os.getenv("VYRA_MAX_STREAMS", "3"))))
    ffmpeg_path: str = field(default_factory=lambda: os.getenv("VYRA_FFMPEG_PATH", "ffmpeg").strip() or "ffmpeg")
    # AI accent voices for recordings (ElevenLabs voice changer through fal).
    # The visible "VYRANI · AI" label on the live view and in recordings.
    ai_label: bool = field(default_factory=lambda: os.getenv("AI_LABEL", "off").strip().lower() in {"1", "true", "on", "yes"})
    voice_max_seconds: int = field(default_factory=lambda: max(10, int(os.getenv("VOICE_MAX_SECONDS", "600"))))
    voice_calls_per_minute: int = field(default_factory=lambda: int(os.getenv("VOICE_CALLS_PER_MINUTE", "6")))
    live_max_session_seconds: int = field(default_factory=lambda: max(10, int(os.getenv("LIVE_MAX_SESSION_SECONDS", "1800"))))
    live_token_ttl_seconds: int = field(default_factory=lambda: int(os.getenv("LIVE_TOKEN_TTL_SECONDS", "20")))
    live_tokens_per_minute: int = field(default_factory=lambda: int(os.getenv("LIVE_TOKENS_PER_MINUTE", "6")))
    # Accounts, credits and payments. With MONGO_URI set, every API route needs a signed-in user.
    mongo_uri: str = field(default_factory=lambda: os.getenv("MONGO_URI", "").strip())
    db_name: str = field(default_factory=lambda: os.getenv("DB_NAME", "vyra").strip() or "vyra")
    public_url: str = field(default_factory=lambda: os.getenv("VYRANI_PUBLIC_URL", os.getenv("VYRA_PUBLIC_URL", "http://127.0.0.1:8765")).strip())
    stripe_secret_key: str = field(default_factory=lambda: (os.getenv("STRIPE_SECRET_KEY") or os.getenv("STRIPE_SECRET_TEST_KEY", "")).strip())
    stripe_webhook_secret: str = field(default_factory=lambda: os.getenv("STRIPE_WEBHOOK_SECRET", "").strip())
    # Google sign-in (OAuth web client). Redirect URI: <VYRA_PUBLIC_URL>/api/auth/google/callback
    google_client_id: str = field(default_factory=lambda: os.getenv("GOOGLE_CLIENT_ID", "").strip())
    google_client_secret: str = field(default_factory=lambda: os.getenv("GOOGLE_CLIENT_SECRET", "").strip())
    # Optional SMTP transactional email delivery (falls back to LogMailer if smtp_host is empty).
    smtp_host: str = field(default_factory=lambda: os.getenv("SMTP_HOST", "").strip())
    smtp_port: int = field(default_factory=lambda: int(os.getenv("SMTP_PORT", "587")))
    smtp_user: str = field(default_factory=lambda: os.getenv("SMTP_USER", "").strip())
    smtp_password: str = field(default_factory=lambda: os.getenv("SMTP_PASSWORD", "").strip())
    smtp_from: str = field(default_factory=lambda: os.getenv("SMTP_FROM", "VYRANI AI <noreply@vyrani.blackhevents.com>").strip())
    max_duration: float = 10.0
    max_video_bytes: int = 32 * 1024 * 1024
    max_image_bytes: int = 8 * 1024 * 1024
    max_jobs: int = 2

