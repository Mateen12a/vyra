import asyncio
import io
import math
import secrets
import shutil
import subprocess
import sys
import threading
import time
import warnings
import zipfile
from urllib.parse import urlsplit
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from . import pricing
from .accounts import SESSION_COOKIE, Accounts, LogMailer, pick_mailer
from .assist import AssistError, Assistant
from .billing import Billing
from .config import Settings
from .clip_fal import pick_engine
from .provider import BUSY_MESSAGE, ProviderGuard
from .credits import InsufficientCredits, Ledger, LiveMeter
from .routes_accounts import build_router
from .streaming import DestinationError, destination
from .jobs import Jobs
from .live import LiveError, LiveSessions
from . import obs_commander, setup
from .voices import PRICE_PER_MINUTE as VOICE_PRICE_PER_MINUTE, SAMPLE_MAX_BYTES as VOICE_SAMPLE_MAX_BYTES, VOICES, VoiceChanger, VoiceError

WEB = Path(__file__).resolve().parent / "web"
ROOT_DIR = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT_DIR / "extension"
NATIVE_CAM_DIR = ROOT_DIR / "native-cam"
MAX_VOICE_BYTES = 30 * 1024 * 1024  # 16-bit mono WAV at 16 kHz: over 15 minutes
MAX_PROBE_BYTES = 4 * 1024 * 1024


async def save_upload(upload: UploadFile, destination: Path, limit: int):
    count = 0
    with destination.open("wb") as file:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > limit:
                raise HTTPException(413, "The file is too large. Use an image under 8 MB and a clip under 32 MB.")
            file.write(chunk)
    if not count:
        raise HTTPException(422, "One of the uploaded files is empty.")


def normalize_reference(path: Path, destination: Path):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 20_000_000:
                    raise ValueError("Use a JPG, PNG, or WebP image up to 20 megapixels.")
                if min(image.size) < 128:
                    raise ValueError("Use a reference image at least 128 pixels wide and tall.")
                image = ImageOps.exif_transpose(image).convert("RGB")
                image.thumbnail((2048, 2048))
                # Fresh RGB pixel copy removes original metadata before persistence.
                clean = Image.frombytes("RGB", image.size, image.tobytes())
                clean.save(destination, format="PNG")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("This image could not be read. Try a JPG, PNG, or WebP.")


def create_app(settings: Optional[Settings] = None, engine=None, store=None, mailer=None, google=None):
    settings = settings or Settings()
    engine = engine or pick_engine(settings)
    jobs = Jobs(settings, engine)
    live = LiveSessions(settings)
    stream_processes = {}
    stream_tickets = {}
    stream_lock = threading.Lock()
    assistant = Assistant(settings)
    voice_changer = VoiceChanger(settings)
    # Accounts and credits switch on with MONGO_URI; without it the app keeps the single shared token.
    if settings.mongo_uri and store is None:
        from .store import Store
        store = Store(settings)
    if store is not None:
        accounts = Accounts(store, mailer or pick_mailer(settings))
        ledger = Ledger(store)
        meter = LiveMeter(store, ledger)
        billing = Billing(settings, store, ledger)

        def refund_failed_clip(record):
            # Same idempotency key as charge()'s refund, so a clip is never refunded twice.
            if record.get("owner") and record["status"] == "failed":
                ledger.apply(ObjectId(record["owner"]), record.get("credits") or pricing.TOOLS["clip"], "clip_refund",
                             f"clip:{record['id']}:refund")
        jobs.on_failed = refund_failed_clip

        def refund_failed_voice(record):
            if record.get("owner") and record.get("voice_credits"):
                ledger.apply(ObjectId(record["owner"]), record["voice_credits"], "voice_refund", f"clip:{record['id']}:voice_refund")
        jobs.on_voice_failed = refund_failed_voice

    @asynccontextmanager
    async def lifespan(app):
        if store is not None:
            await run_in_threadpool(store.ensure_indexes)
            for record in jobs.records.values():  # clips that failed because the server restarted
                if record.get("owner") and record["status"] == "failed":
                    await run_in_threadpool(jobs.on_failed, record)
        if hasattr(engine, "start"):
            engine.start()
        yield
        with stream_lock:
            active_streams = [proc for proc, _owner in stream_processes.values()]
            stream_processes.clear()
            stream_tickets.clear()
        for process in active_streams:
            try:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
            except OSError:
                pass
            if process.poll() is None:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, 2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait)
        await run_in_threadpool(jobs.close)
        if hasattr(engine, "close"):
            await run_in_threadpool(engine.close)

    app = FastAPI(title="VYRANI AI", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.jobs = jobs
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins),
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])
    if not settings.api_token:
        allowed_hosts = ["localhost", "127.0.0.1", "[::1]", "testserver"]
        public_address = urlsplit(settings.public_url)
        if public_address.scheme in {"https", "http"} and public_address.hostname:
            allowed_hosts.append(public_address.hostname)
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    app.add_middleware(UploadLimitMiddleware, limit=settings.max_video_bytes + settings.max_image_bytes + 65536)
    bearer = HTTPBearer(auto_error=False)

    def authorize(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer)):
        """The one permission choke point: a signed-in user when accounts are on, else the shared token."""
        if store is not None:
            user = accounts.user_for(request.cookies.get(SESSION_COOKIE))
            if not user:
                raise HTTPException(401, "Sign in to continue.")
            return user
        if settings.api_token and (not credentials or not secrets.compare_digest(credentials.credentials, settings.api_token)):
            raise HTTPException(401, "Check your processing-server access token.")
        return None

    def require_admin(user=Depends(authorize)):
        if not user or user.get("role") != "admin":
            raise HTTPException(403, "Admins only.")
        return user

    def charge(user, credits, kind, reference):
        """Take credits for a paid tool up front. Returns a refund callback for when the tool fails."""
        if store is None:
            return lambda: None
        key = f"{kind}:{reference}"
        try:
            ledger.apply(user["_id"], -credits, kind, key)
        except InsufficientCredits:
            raise HTTPException(402, f"This needs {credits} credits. Add credits to continue.")
        return lambda: ledger.apply(user["_id"], credits, f"{kind}_refund", f"{key}:refund")

    # Operator alerts go to ALERT_EMAIL, or else to every admin account.
    def notify_operator(subject, text):
        emails = [settings.alert_email] if settings.alert_email else             [u["email"] for u in store.users.find({"role": "admin"}, {"email": 1})] if store is not None else []
        for email in emails:
            accounts.mailer.notify(email, subject, text)

    guard = ProviderGuard(settings, notify=notify_operator if store is not None else None)
    app.state.provider_guard = guard

    @app.get("/api/admin/provider")
    def provider_status(admin=Depends(require_admin)):
        return {"fal_balance": guard.current(), "min_live": settings.fal_min_balance_live,
                "min_clip": settings.fal_min_balance_clip, "alert_below": settings.fal_alert_balance,
                "accepting_live": guard.allows("live"), "accepting_clips": guard.allows("clip")}

    if store is not None:
        app.include_router(build_router(settings, store, accounts, ledger, billing, authorize, require_admin, google))
    elif not settings.api_token:
        # Single-user install (no accounts): report a local user so the React app unlocks.
        # Auth mutations below would 404 as before; the client treats them as no-ops.
        @app.get("/api/auth/me")
        def local_mode_me():
            return {"user": {"id": "local", "email": "you@localhost", "role": "user", "verified": True,
                             "google": False, "has_password": False, "can_remove_watermark": True},
                    "balance": 0}

        # No credits are metered on a single-user install; the app shows an owned, not purchasable, balance.
        @app.get("/api/credits")
        def local_mode_credits():
            return {**pricing.public_catalogue(), "balance": 0, "history": [], "payments": False}

        # The catalogue without a billing backend: packs listed for reference, purchases off.
        @app.get("/api/pricing")
        def local_mode_pricing():
            return pricing.public_catalogue()

    @app.middleware("http")
    async def reject_large_request(request, call_next):
        # CSRF: with cookie sessions, state-changing API calls must come from an allowed page origin.
        if store is not None and request.method in {"POST", "PUT", "PATCH", "DELETE"} \
                and request.url.path.startswith("/api/") and request.url.path != "/api/billing/webhook" \
                and request.headers.get("origin") not in settings.allowed_origins:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "This request came from a page that isn't allowed."}, status_code=403)
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > settings.max_video_bytes + settings.max_image_bytes + 65536:
                    from fastapi.responses import JSONResponse
                    return JSONResponse({"detail": "Upload exceeds the 40 MB request limit."}, status_code=413)
            except ValueError:
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": "Invalid content length"}, status_code=400)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
            "img-src 'self' blob: data:; media-src 'self' blob:; "
            "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        )
        return response

    @app.get("/api/health", dependencies=[Depends(authorize)])
    def health():
        return {**engine.status(), "live": live.status(), "max_clip_seconds": settings.max_duration,
                "max_video_mb": settings.max_video_bytes // (1024 * 1024), "version": "0.1.0"}

    @app.get("/api/live/status")
    def live_status(user=Depends(authorize)):
        can_remove_watermark = True if store is None else accounts.can_remove_watermark(user)
        # Free-tier accounts show the VYRANI · AI watermark unless they have purchased credits or are admin.
        # Whenever a real person's likeness (reference photo) is used, the visible AI disclosure is always on
        # (compact badge for paid users, standard badge for free users).
        ai_label = settings.ai_label or (store is not None and not can_remove_watermark)
        return {**live.status(), "assist": assistant.available(), "voices": voice_changer.catalogue(),
                "voice_price_per_minute": VOICE_PRICE_PER_MINUTE,
                "voice_max_seconds": min(settings.live_max_session_seconds, settings.voice_max_seconds),
                "ai_label": ai_label, "can_remove_watermark": can_remove_watermark,
                "likeness_watermark_always": True,
                "vyra_dev_mode": settings.vyra_dev_mode,
                # Users paste their own stream key, so streaming only needs FFmpeg on the server.
                "streaming_available": bool(settings.rtmp_url or shutil.which(settings.ffmpeg_path)),
                "stream_default": bool(settings.rtmp_url)}

    @app.get("/api/virtual-cam/extension.zip")
    def download_extension_zip():
        if not EXTENSION_DIR.is_dir():
            raise HTTPException(404, "Virtual camera browser extension files are not available.")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in sorted(EXTENSION_DIR.rglob("*")):
                if item.is_file():
                    zf.write(item, item.relative_to(EXTENSION_DIR).as_posix())
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="vyrani-virtual-camera-extension.zip"'},
        )

    @app.get("/api/virtual-cam/native.zip")
    def download_native_cam_zip():
        if not NATIVE_CAM_DIR.is_dir():
            raise HTTPException(404, "Native virtual camera companion files are not available.")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in sorted(NATIVE_CAM_DIR.rglob("*")):
                if item.is_file() and "__pycache__" not in item.parts:
                    zf.write(item, item.relative_to(NATIVE_CAM_DIR).as_posix())
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="vyrani-native-virtual-cam.zip"'},
        )

    # ---- VYRANI Camera Commander (launches the user's installed OBS; pure-local mode only) ----
    @app.get("/api/obs/status")
    def obs_status(user=Depends(authorize)):
        if not obs_commander.local_mode(settings):
            raise HTTPException(404, "The OBS launcher only works on a locally run VYRANI server.")
        exe = obs_commander.find_obs()
        return {
            "enabled": True,
            "installed": exe is not None,
            "path": str(exe) if exe else None,
            "collection": obs_commander.COLLECTION_NAME,
            "window_title": obs_commander.VIRTUAL_CAM_WINDOW_TITLE,
        }

    @app.post("/api/obs/launch")
    def obs_launch(request: Request, user=Depends(authorize)):
        if not obs_commander.local_mode(settings):
            raise HTTPException(404, "The OBS launcher only works on a locally run VYRANI server.")
        try:
            body = request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
        except ValueError:
            body = {}
        window_title = body.get("window_title") if isinstance(body, dict) else None
        if not isinstance(window_title, str) or not window_title.strip():
            window_title = obs_commander.VIRTUAL_CAM_WINDOW_TITLE
        exe = obs_commander.find_obs()
        if exe is None:
            raise HTTPException(404, "OBS Studio was not found on this machine. Install it from https://obsproject.com/download first.")
        collection_path = obs_commander.write_collection(window_title)
        try:
            obs_commander.launch_obs(exe)
        except RuntimeError as exc:
            raise HTTPException(503, str(exc))
        return {"launched": True, "exe": str(exe), "collection": str(collection_path), "window_title": window_title}

    # ---- First-run setup: what the Wizard shows; one-click fixes stay local-only ----
    @app.get("/api/setup")
    def setup_status(user=Depends(authorize)):
        hosted = not setup.local_mode(settings)
        engine_status = engine.status() if hasattr(engine, "status") else {}
        if hosted:
            # OBS/portable-FFmpeg helpers must never run on a hosted server.
            step_list = setup.steps(settings, bool(live.status().get("available")), engine_status, obs_installed=False,
                                    extension_ready=False)
            return {"mode": "hosted", "steps": step_list}
        step_list = setup.steps(settings, bool(live.status().get("available")), engine_status,
                                obs_installed=obs_commander.find_obs() is not None, extension_ready=False)
        return {"mode": "local", "steps": step_list}

    @app.post("/api/setup/fix/ffmpeg")
    async def setup_fix_ffmpeg(user=Depends(authorize)):
        if not setup.local_mode(settings):
            raise HTTPException(404, "Setup fixes only work on a locally run VYRANI server.")
        if sys.platform != "win32":
            raise HTTPException(400, "Automatic FFmpeg install is Windows-only. Install FFmpeg with your system package manager.")
        try:
            exe = await run_in_threadpool(setup.install_portable_ffmpeg, settings, verify=setup._run_version_check)
        except (setup.SetupError, zipfile.BadZipFile) as exc:
            raise HTTPException(502, str(exc))
        return {"installed": True, "ffmpeg": str(exe)}

    # Network test: a tiny GET for latency and an upload of random bytes for upload speed. Nothing is stored.
    @app.get("/api/net/probe", dependencies=[Depends(authorize)])
    def net_probe():
        return {"ok": True}

    @app.post("/api/net/probe", dependencies=[Depends(authorize)])
    async def net_upload(request: Request):
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > MAX_PROBE_BYTES:
                raise HTTPException(413, "The network test upload is too large.")
        return {"bytes": received}

    @app.post("/api/assist/look")
    async def assist_look(request: Request, user=Depends(authorize)):
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(422, "Invalid request body.")
        idea = body.get("idea") if isinstance(body, dict) else None
        base = body.get("base") if isinstance(body, dict) else None
        if not isinstance(idea, str) or (base is not None and not isinstance(base, str)):
            raise HTTPException(422, "Describe the look in a few words.")
        refund = charge(user, pricing.TOOLS["assist"], "assist", secrets.token_hex(8))
        try:
            return await run_in_threadpool(assistant.look, idea, base)
        except AssistError as exc:
            refund()
            raise HTTPException(exc.status, str(exc))

    @app.post("/api/assist/describe")
    async def assist_describe(image: UploadFile = File(...), user=Depends(authorize)):
        try:
            data = await image.read(settings.max_image_bytes + 1)
        finally:
            await image.close()
        if not data:
            raise HTTPException(422, "The photo is empty.")
        if len(data) > settings.max_image_bytes:
            raise HTTPException(413, "Use a photo under 8 MB.")
        refund = charge(user, pricing.TOOLS["assist"], "assist", secrets.token_hex(8))
        try:
            return await run_in_threadpool(assistant.describe, data)
        except AssistError as exc:
            refund()
            raise HTTPException(exc.status, str(exc))

    @app.post("/api/voice/convert")
    async def voice_convert(audio: UploadFile = File(...), voice: str = Form(...), user=Depends(authorize)):
        try:
            data = await audio.read(MAX_VOICE_BYTES + 1)
        finally:
            await audio.close()
        if not data:
            raise HTTPException(422, "The recording has no audio.")
        if len(data) > MAX_VOICE_BYTES:
            raise HTTPException(413, "The recording's audio is too large.")
        # 16 kHz mono 16-bit WAV is 32,000 bytes a second; the provider bills per started minute.
        minutes = max(1, math.ceil(len(data) / 32000 / 60))
        refund = charge(user, minutes * pricing.TOOLS["voice_minute"], "voice", secrets.token_hex(8))
        try:
            converted = await run_in_threadpool(voice_changer.convert, data, voice)
        except VoiceError as exc:
            refund()
            raise HTTPException(exc.status, str(exc))
        return Response(content=converted, media_type="audio/mpeg")

    @app.post("/api/live/stream/ticket")
    async def create_stream_ticket(request: Request, user=Depends(authorize)):
        origin = request.headers.get("origin", "")
        if origin not in settings.allowed_origins:
            raise HTTPException(403, "This page origin is not allowed to start a stream.")
        body = {}
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                body = await request.json()
            except ValueError:
                raise HTTPException(422, "Invalid request body.")
        body = body if isinstance(body, dict) else {}
        # A user's own destination (URL + stream key) wins; the server's VYRA_RTMP_URL is the operator default.
        if body.get("url"):
            try:
                target = await run_in_threadpool(destination, body.get("url"), body.get("key", ""), settings.allow_private_ingest)
            except DestinationError as exc:
                raise HTTPException(422, str(exc))
        elif settings.rtmp_url and store is None:
            parts = urlsplit(settings.rtmp_url)
            if parts.scheme not in {"rtmp", "rtmps"} or not parts.hostname or parts.username or parts.password:
                raise HTTPException(503, "VYRA_RTMP_URL must be an RTMP or RTMPS URL without embedded credentials.")
            target = settings.rtmp_url
        else:
            raise HTTPException(422, "Add your streaming server URL and stream key.")
        owner = str(user["_id"]) if user else "operator"
        ticket = secrets.token_urlsafe(32)
        with stream_lock:
            now = time.monotonic()
            stream_tickets.update({key: value for key, value in stream_tickets.items() if value[1] > now})
            stream_tickets[ticket] = (origin, now + 30, target, owner)
        return {"ticket": ticket}

    @app.websocket("/api/live/stream/{ticket}")
    async def live_stream(websocket: WebSocket, ticket: str):
        origin = websocket.headers.get("origin", "")
        with stream_lock:
            grant = stream_tickets.pop(ticket, None)
        if not grant or grant[1] <= time.monotonic() or grant[0] != origin or origin not in settings.allowed_origins:
            await websocket.close(code=1008)
            return
        _origin, _expiry, target, owner = grant
        # Browsers that record H.264 are passed straight through, which costs almost no server CPU; only the
        # audio is converted (Opus to AAC). Others are re-encoded at 720p with the cheapest x264 preset.
        if websocket.query_params.get("video") == "h264":
            video = ["-c:v", "copy"]
        else:
            video = ["-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                     "-g", "60", "-pix_fmt", "yuv420p", "-r", "30", "-b:v", "3000k", "-maxrate", "3500k", "-bufsize", "6000k"]
        # Safari sends fragmented MP4; everything else sends WebM.
        container = "mp4" if websocket.query_params.get("container") == "mp4" else "webm"
        command = [settings.ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-nostdin",
                   "-fflags", "+genpts", "-f", container, "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?",
                   "-af", "aresample=async=1:first_pts=0", *video, "-c:a", "aac", "-b:a", "128k",
                   "-f", "flv", target]
        stream_id = secrets.token_urlsafe(16)
        try:
            with stream_lock:
                stream_processes.update({key: entry for key, entry in stream_processes.items() if entry[0].poll() is None})
                busy = None
                if any(entry_owner == owner for _proc, entry_owner in stream_processes.values()):
                    busy = "You already have a livestream running. End it first."
                elif len(stream_processes) >= settings.max_streams:
                    busy = "All livestream slots are in use. Try again in a few minutes."
                if busy:
                    await websocket.close(code=1013, reason=busy)
                    return
                # stderr is discarded: FFmpeg errors can echo the URL, and the stream key must never reach a log.
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, bufsize=0)
                stream_processes[stream_id] = (process, owner)
        except (OSError, ValueError):
            await websocket.close(code=1011, reason="Could not start FFmpeg. Check the VYRANI server configuration.")
            return
        await websocket.accept()
        try:
            await websocket.send_json({"type": "ready"})
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("text") == "end":
                    break
                chunk = message.get("bytes")
                if chunk:
                    if process.poll() is not None:
                        await websocket.send_json({"type": "error", "message": "FFmpeg stopped. Check the RTMP endpoint and server logs."})
                        break
                    try:
                        await asyncio.to_thread(process.stdin.write, chunk)
                    except (BrokenPipeError, OSError):
                        await websocket.send_json({"type": "error", "message": "FFmpeg stopped receiving video. Check the RTMP endpoint."})
                        break
        except WebSocketDisconnect:
            pass
        finally:
            with stream_lock:
                stream_processes.pop(stream_id, None)
            try:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
            except OSError:
                pass
            try:
                await asyncio.to_thread(process.wait, 5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, 2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait)

    @app.post("/api/live/token")
    async def live_token(request: Request, user=Depends(authorize)):
        provider = None
        session_id = None
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                body = await request.json()
            except ValueError:
                raise HTTPException(422, "Invalid request body.")
            provider = body.get("provider") if isinstance(body, dict) else None
            session_id = body.get("session_id") if isinstance(body, dict) else None
            if provider is not None and not isinstance(provider, str):
                raise HTTPException(422, "Invalid live engine.")
        metered = None
        if store is not None:
            if session_id:  # reconnect inside a session the user is already paying for
                metered = meter_status(session_id, user)
                if metered["state"] != "live":
                    raise HTTPException(409, "This live session has ended. Start a new one.")
            else:
                if not await run_in_threadpool(guard.allows, "live"):
                    raise HTTPException(503, BUSY_MESSAGE)
                try:
                    metered = await run_in_threadpool(meter.start, user["_id"], provider or live.default_provider())
                except InsufficientCredits:
                    raise HTTPException(402, f"Going live needs {pricing.LIVE_BLOCK_SECONDS} credits ({pricing.LIVE_BLOCK_SECONDS} seconds). Add credits to continue.")
                except RuntimeError as exc:
                    raise HTTPException(409, str(exc))
        try:
            minted = await run_in_threadpool(live.mint, request.headers.get("origin"), provider)
        except LiveError as exc:
            if metered and not session_id:  # no session was opened, so give the first block back
                await run_in_threadpool(meter.cancel, ObjectId(metered["session_id"]), user["_id"])
            raise HTTPException(503, str(exc))
        return {**minted, "meter": metered} if metered else minted

    def meter_status(session_id, user):
        if store is None:
            raise HTTPException(404, "Credits are not enabled on this server.")
        try:
            return meter.status(ObjectId(session_id), user["_id"])
        except (InvalidId, TypeError, KeyError):
            raise HTTPException(404, "Live session not found.")

    @app.post("/api/live/meter/{session_id}/heartbeat")
    def live_heartbeat(session_id: str, user=Depends(authorize)):
        meter_status(session_id, user)
        return meter.extend(ObjectId(session_id), user["_id"])

    @app.post("/api/live/meter/{session_id}/end")
    def live_end(session_id: str, user=Depends(authorize)):
        meter_status(session_id, user)
        return meter.end(ObjectId(session_id), user["_id"])

    @app.post("/api/jobs", status_code=202)
    async def submit(reference: UploadFile = File(...), video: UploadFile = File(...),
                     quality: str = Form("preview"), prompt: str = Form("A person moving naturally, realistic video."),
                     voice: str = Form(""), voice_sample: Optional[UploadFile] = File(None), voice_consent: str = Form(""),
                     user=Depends(authorize)):
        folder = None
        refund = None
        reserved = False
        submitted = False
        try:
            if quality not in {"preview", "detail"}:
                raise HTTPException(422, "Choose Preview or Detail quality.")
            voice = voice.strip()
            if voice and voice != "sample" and voice not in {v["id"] for v in VOICES}:
                raise HTTPException(422, "Choose one of the listed voices.")
            if voice == "sample" and (voice_sample is None or voice_consent != "yes"):
                raise HTTPException(422, "Add a voice sample and confirm it's your voice or you have permission to use it.")
            prompt = prompt.strip()
            if not 1 <= len(prompt) <= 1000:
                raise HTTPException(422, "The appearance description must contain 1–1000 characters.")
            status = engine.status()
            if not status["configured"]:
                raise HTTPException(503, status["message"])
            if status.get("provider") == "fal" and not await run_in_threadpool(guard.allows, "clip"):
                raise HTTPException(503, BUSY_MESSAGE)
            try:
                job_id, folder = jobs.create()
                reserved = True
            except RuntimeError as exc:
                raise HTTPException(429, str(exc))
            await save_upload(reference, folder / "upload.image", settings.max_image_bytes)
            await save_upload(video, folder / "upload.video", settings.max_video_bytes)
            try:
                await run_in_threadpool(normalize_reference, folder / "upload.image", folder / "reference.png")
                metadata = await run_in_threadpool(engine.validate_video, folder / "upload.video")
            except ValueError as exc:
                raise HTTPException(422, str(exc))
            (folder / "upload.image").unlink()
            if voice == "sample":
                sample = await voice_sample.read(VOICE_SAMPLE_MAX_BYTES + 1)
                if not sample or len(sample) > VOICE_SAMPLE_MAX_BYTES:
                    raise HTTPException(422, "Upload a voice sample under 6 MB.")
                (folder / "voice.sample").write_bytes(sample)
                (folder / "voice.mime").write_text((voice_sample.content_type or "audio/mpeg").split(";")[0])
                if user and store is not None:  # who confirmed the right to use this voice, and for which clip
                    store.audit(user["_id"], "voice_sample_consent", job_id=job_id)
            # A clip is at most a minute, so its voice is one started minute.
            voice_credits = pricing.TOOLS["voice_minute"] if voice else 0
            credits = pricing.TOOLS["clip"] + voice_credits
            refund = charge(user, credits, "clip", job_id)
            record = jobs.submit(job_id, {"quality": quality, "prompt": prompt, "voice": voice or None,
                                          "credits": credits, "voice_credits": voice_credits}, metadata,
                                 owner=str(user["_id"]) if user else None)
            submitted = True
            return record
        finally:
            await reference.close()
            await video.close()
            if voice_sample is not None:
                await voice_sample.close()
            if refund and not submitted:
                refund()
            if reserved and not submitted:
                if folder and folder.parent.resolve() == jobs.root.resolve():
                    shutil.rmtree(folder)
                jobs.slots.release()

    def find_job(job_id, user=None):
        try:
            jobs.folder(job_id)
            record = jobs.get(job_id)
        except (ValueError, KeyError):
            raise HTTPException(404, "This test was not found.")
        # With accounts on, a clip belongs to whoever submitted it (admins can see every clip).
        if user and record.get("owner") != str(user["_id"]) and user.get("role") != "admin":
            raise HTTPException(404, "This test was not found.")
        return record

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str, user=Depends(authorize)):
        return find_job(job_id, user)

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str, user=Depends(authorize)):
        find_job(job_id, user)
        return jobs.cancel(job_id)

    @app.delete("/api/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str, user=Depends(authorize)):
        find_job(job_id, user)
        try:
            jobs.delete(job_id)
        except RuntimeError as exc:
            raise HTTPException(409, str(exc))

    @app.get("/api/jobs/{job_id}/result")
    def result(job_id: str, user=Depends(authorize)):
        if find_job(job_id, user)["status"] != "completed":
            raise HTTPException(409, "The result is not ready yet.")
        path = jobs.folder(job_id) / "result.mp4"
        if not path.is_file():
            raise HTTPException(404, "The result file is missing on the processing server.")
        return FileResponse(path, media_type="video/mp4", filename="vyrani-result.mp4")


    @app.get("/manifest.webmanifest")
    def pwa_manifest():
        path = WEB / "manifest.webmanifest"
        return FileResponse(path, media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        path = WEB / "sw.js"
        return FileResponse(path, media_type="application/javascript")

    @app.get("/watermark")
    def watermark():
        return FileResponse(WEB / "watermark.html")

    # The React app (frontend/, built into web/dist) owns the landing page, sign-in, the dashboard and admin.
    # Every admin API call checks the role server-side; these routes only return the page shell.
    # Without a build, everything falls back to the classic studio page.
    spa = WEB / "dist" / "index.html"
    from fastapi.responses import HTMLResponse, PlainTextResponse
    from . import seo
    shell_cache = {"mtime": None, "text": None}

    def spa_page(request: Request):
        if not spa.is_file():
            return FileResponse(WEB / "index.html")
        mtime = spa.stat().st_mtime  # re-read after a rebuild so the page never points at old bundles
        if shell_cache["mtime"] != mtime:
            shell_cache.update(mtime=mtime, text=spa.read_text(encoding="utf-8"))
        return HTMLResponse(seo.render(shell_cache["text"], request.url.path.rstrip("/") or "/", settings.public_url))

    @app.get("/robots.txt", include_in_schema=False)
    def robots():
        return PlainTextResponse(seo.robots(settings.public_url))

    @app.get("/sitemap.xml", include_in_schema=False)
    def sitemap():
        return Response(seo.sitemap(settings.public_url), media_type="application/xml")

    for path in ("/", "/signin", "/signup", "/forgot", "/reset", "/verify", "/app", "/app/{rest:path}", "/admin"):
        app.add_api_route(path, spa_page, methods=["GET"], include_in_schema=False)

    # The classic studio: voice, scene rules, streaming and overlays live here until they move to the new studio.
    @app.get("/studio")
    def classic_studio():
        return FileResponse(WEB / "index.html")

    if (WEB / "dist" / "ui").is_dir():
        app.mount("/ui", StaticFiles(directory=WEB / "dist" / "ui"), name="ui")
    app.mount("/assets", StaticFiles(directory=WEB), name="assets")
    return app


class UploadLimitMiddleware:
    """Count bytes on receive too, so chunked requests cannot bypass the limit."""
    def __init__(self, app, limit):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/api/jobs":
            return await self.app(scope, receive, send)
        count = 0

        async def limited_receive():
            nonlocal count
            message = await receive()
            if message["type"] == "http.request":
                count += len(message.get("body", b""))
                if count > self.limit:
                    raise HTTPException(413, "Upload exceeds the 40 MB request limit.")
            return message

        await self.app(scope, limited_receive, send)

