import io
import json
import shutil
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from person_studio.app import create_app
from person_studio.config import Settings
from person_studio.engine import Cancelled, WanEngine


class TestEngine:
    """Only tests inject this engine. The shipped app uses a GPU worker (WanEngine) or fal (FalClipEngine)."""
    __test__ = False

    def __init__(self, settings, blocked=False):
        self.validator = WanEngine(settings)
        self.blocked = blocked
        self.started = threading.Event()
        self.release = threading.Event()

    def status(self):
        return {"configured": True, "mode": "clip", "live_available": False,
                "engine": "test-only", "message": "Test engine"}

    def validate_video(self, path):
        return self.validator.validate_video(path)

    def run(self, folder, options, progress, cancel):
        progress("transforming", "Test engine running")
        self.started.set()
        if self.blocked:
            while not self.release.wait(0.01):
                if cancel.is_set():
                    raise Cancelled()
        # Valid MP4 fixture copied to check transport, not a claimed AI transformation.
        shutil.copyfile(folder / "upload.video", folder / "result.mp4")
        return {"generation_seconds": 0.01}


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Media integration tests require FFmpeg")
    folder = tmp_path_factory.mktemp("media")
    video = folder / "source.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=256x256:r=16",
                    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True)
    image = io.BytesIO()
    Image.new("RGB", (256, 256), "green").save(image, format="PNG")
    return image.getvalue(), video.read_bytes()


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    engine = TestEngine(settings)
    app = create_app(settings, engine)
    with TestClient(app, headers={"Authorization": "Bearer test-token"}) as http:
        yield http, app.state.jobs, engine


def upload(http, media, **kwargs):
    image, video = media
    return http.post("/api/jobs", files={"reference": ("ref.png", image, "image/png"),
                                       "video": ("source.mp4", video, "video/mp4")}, **kwargs)


def await_terminal(http, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        record = http.get(f"/api/jobs/{job_id}").json()
        if record["status"] in {"completed", "failed", "cancelled"}:
            return record
        time.sleep(0.01)
    pytest.fail("Job did not finish")


def test_api_authentication_and_private_downloads(client, media):
    http, jobs, engine = client
    assert http.get("/api/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    response = upload(http, media)
    assert response.status_code == 202
    job_id = response.json()["id"]
    assert http.get(f"/api/jobs/{job_id}", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert http.get(f"/api/jobs/{job_id}/result", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_upload_generate_download_delete(client, media):
    http, jobs, engine = client
    response = upload(http, media, data={"quality": "preview", "prompt": "A person moving naturally."})
    assert response.status_code == 202
    job_id = response.json()["id"]
    record = await_terminal(http, job_id)
    assert record["status"] == "completed"
    assert record["source"]["duration_seconds"] == 1.0
    assert record["metrics"]["processing_to_clip_ratio"] >= 0
    result = http.get(f"/api/jobs/{job_id}/result")
    assert result.status_code == 200
    assert result.headers["content-type"] == "video/mp4"
    assert result.content == media[1]
    assert http.delete(f"/api/jobs/{job_id}").status_code == 204
    assert not jobs.folder(job_id).exists()
    assert http.get(f"/api/jobs/{job_id}").status_code == 404


@pytest.mark.parametrize("payload", [b"not an image", b""])
def test_bad_reference_does_not_consume_a_queue_slot(client, media, payload):
    http, jobs, _ = client
    for _ in range(3):
        assert upload(http, (payload, media[1])).status_code == 422
    assert not list(jobs.root.iterdir())
    assert upload(http, media).status_code == 202


def test_bad_video_and_invalid_options(client, media):
    http, jobs, _ = client
    assert upload(http, (media[0], b"not a video")).status_code == 422
    assert upload(http, media, data={"quality": "unknown"}).status_code == 422
    assert upload(http, media, data={"prompt": "x" * 1001}).status_code == 422
    assert not list(jobs.root.iterdir())


def test_image_size_limit(client, media):
    http, jobs, _ = client
    jobs.settings.max_image_bytes = 100
    assert upload(http, media).status_code == 413
    assert not list(jobs.root.iterdir())


def test_queue_limit_and_cancel_running_and_queued_jobs(tmp_path, media):
    settings = Settings(data_dir=tmp_path)
    engine = TestEngine(settings, blocked=True)
    app = create_app(settings, engine)
    with TestClient(app) as http:
        first = upload(http, media).json()["id"]
        assert engine.started.wait(2)
        second = upload(http, media).json()["id"]
        assert upload(http, media).status_code == 429
        assert http.get(f"/api/jobs/{first}/result").status_code == 409
        assert http.delete(f"/api/jobs/{first}").status_code == 409
        assert http.post(f"/api/jobs/{second}/cancel").status_code == 200
        assert http.post(f"/api/jobs/{first}/cancel").status_code == 200
        assert await_terminal(http, first)["status"] == "cancelled"
        assert await_terminal(http, second)["status"] == "cancelled"
        engine.release.set()
        assert upload(http, media).status_code == 202


def test_restart_recovery(tmp_path):
    import uuid
    job_id = str(uuid.uuid4())
    folder = tmp_path / "jobs" / job_id
    folder.mkdir(parents=True)
    (folder / "job.json").write_text(json.dumps({"id": job_id, "status": "transforming", "message": "Running"}))
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as http:
        record = http.get(f"/api/jobs/{job_id}").json()
        assert record["status"] == "failed"
        assert "restarted" in record["message"]


def test_no_model_does_not_pretend_to_transform(tmp_path, media):
    app = create_app(Settings(data_dir=tmp_path, wan_repo=None, wan_checkpoint=None))
    with TestClient(app) as http:
        health = http.get("/api/health").json()
        assert not health["configured"]
        assert health["live_available"] is False
        assert upload(http, media).status_code == 503
        assert not list(app.state.jobs.root.iterdir())


def test_invalid_id_and_static_app(client):
    http, _, _ = client
    assert http.get("/api/jobs/not-a-uuid").status_code == 404
    assert http.get("/api/jobs/00000000-0000-0000-0000-000000000000/result").status_code == 404
    assert http.get("/").status_code == 200
    assert http.get("/assets/app.js").status_code == 200
    assert "frame-ancestors 'none'" in http.get("/").headers["content-security-policy"]


def test_cors_allows_only_configured_origin(client):
    http, _, _ = client
    headers = {"Origin": "http://127.0.0.1:8765", "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "Authorization"}
    assert http.options("/api/jobs", headers=headers).status_code == 200
    headers["Origin"] = "https://unrelated.example"
    assert http.options("/api/jobs", headers=headers).status_code == 400


def test_unknown_length_upload_limit(tmp_path):
    settings = Settings(data_dir=tmp_path, max_image_bytes=100, max_video_bytes=100)
    app = create_app(settings, TestEngine(settings))
    boundary = "test-boundary"
    data = (f'--{boundary}\r\nContent-Disposition: form-data; name="reference"; filename="ref.png"\r\n'
            'Content-Type: image/png\r\n\r\n').encode() + b"x" * 70000 + f"\r\n--{boundary}--\r\n".encode()
    with TestClient(app) as http:
        response = http.post("/api/jobs", content=iter([data[:40000], data[40000:]]),
                             headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        assert response.status_code == 413


def test_upstream_pose_checkpoint_directory_is_supported(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, wan_repo=tmp_path / "repo", wan_checkpoint=tmp_path / "weights")
    for relative in ["generate.py", "wan/modules/animate/preprocess/preprocess_data.py"]:
        path = settings.wan_repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    for relative in ["config.json", "process_checkpoint/det/yolov10m.onnx",
                     "process_checkpoint/pose2d/vitpose_h_wholebody.onnx/end2end.onnx",
                     "process_checkpoint/sam2/sam2_hiera_large.pt", "diffusion_pytorch_model.safetensors.index.json",
                     "Wan2.1_VAE.pth", "models_t5_umt5-xxl-enc-bf16.pth", "relighting_lora.ckpt"]:
        path = settings.wan_checkpoint / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    monkeypatch.setattr(shutil, "which", lambda name: name)
    assert WanEngine(settings).status()["configured"] is True
    (settings.wan_checkpoint / "process_checkpoint/pose2d/vitpose_h_wholebody.onnx/end2end.onnx").unlink()
    assert WanEngine(settings).status()["configured"] is False


def test_cancellation_terminates_a_real_worker_process(tmp_path):
    engine = WanEngine(Settings(data_dir=tmp_path))
    cancel = threading.Event()
    timer = threading.Timer(0.3, cancel.set)
    timer.start()
    start = time.monotonic()
    try:
        with pytest.raises(Cancelled):
            engine.run_command([sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, tmp_path, cancel)
        assert time.monotonic() - start < 5
    finally:
        timer.cancel()


def test_browser_webm_without_duration_can_be_validated(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg required")
    video = tmp_path / "camera.webm"
    # Non-seekable pipe output has the missing duration header seen in MediaRecorder blobs.
    result = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=256x256:r=16",
                             "-t", "1", "-c:v", "libvpx", "-f", "webm", "pipe:1"], capture_output=True, check=True)
    video.write_bytes(result.stdout)
    metadata = WanEngine(Settings(data_dir=tmp_path)).validate_video(video)
    assert 0.9 <= metadata["duration_seconds"] <= 1.1


def test_long_video_rejected_before_generation(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg required")
    video = tmp_path / "long.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=128x128:r=8",
                    "-t", "11", "-c:v", "libx264", str(video)], check=True)
    with pytest.raises(ValueError, match="10 seconds"):
        WanEngine(Settings(data_dir=tmp_path)).validate_video(video)


FAKE_RUNNER = '''
import json, sys, time
print("noise before the protocol is ignored")
print(json.dumps({"ready": True, "load_seconds": 0.1, "merged_layers": 0}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request["prompt"] == "hang":
        time.sleep(30)
    print(json.dumps({"ok": request["prompt"] != "fail", "generate_seconds": 1.0, "peak_vram_gb": 1.0}), flush=True)
'''


def resident_runner(tmp_path, monkeypatch):
    import person_studio.engine as engine_module
    script = tmp_path / "fake_runner.py"
    script.write_text(FAKE_RUNNER)
    monkeypatch.setattr(engine_module, "RUNNER", script)
    settings = Settings(data_dir=tmp_path, wan_repo=tmp_path, wan_checkpoint=tmp_path, wan_python=sys.executable)
    return engine_module.ResidentRunner(settings)


def test_resident_runner_loads_once_and_serves_requests(tmp_path, monkeypatch):
    runner = resident_runner(tmp_path, monkeypatch)
    try:
        request = {"prompt": "ok", "steps": 1}
        assert runner.generate(request, threading.Event())["ok"] is True
        first = runner.process.pid
        assert runner.generate(request, threading.Event())["ok"] is True
        assert runner.process.pid == first and runner.state == "ready"
        with pytest.raises(RuntimeError):
            runner.generate({"prompt": "fail", "steps": 1}, threading.Event())
        assert runner.process.pid == first
    finally:
        runner.stop()


def test_resident_runner_cancellation_stops_the_model_process(tmp_path, monkeypatch):
    runner = resident_runner(tmp_path, monkeypatch)
    cancel = threading.Event()
    timer = threading.Timer(0.5, cancel.set)
    timer.start()
    start = time.monotonic()
    try:
        with pytest.raises(Cancelled):
            runner.generate({"prompt": "hang", "steps": 1}, cancel)
        assert time.monotonic() - start < 8
        assert runner.process is None and runner.state == "stopped"
    finally:
        timer.cancel()
        runner.stop()


class FakeTokenResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def live_client(tmp_path, monkeypatch, key="fal_secret", fal_key=None, **overrides):
    import person_studio.live as live_module
    calls = []

    def fake_urlopen(request, timeout):
        calls.append({"url": request.full_url, "headers": dict(request.header_items()), "body": json.loads(request.data)})
        if request.full_url == live_module.FAL_TOKEN_URL:
            return FakeTokenResponse(json.dumps("hdr.claims.sig").encode())
        return FakeTokenResponse(json.dumps({"apiKey": "ek_short", "token": "jwt", "expiresAt": "2026-10-10T00:00:20Z"}).encode())

    monkeypatch.setattr(live_module.urllib.request, "urlopen", fake_urlopen)
    overrides.setdefault("live_provider", "")
    settings = Settings(data_dir=tmp_path, fal_key=key if fal_key is None else fal_key, **overrides)
    return TestClient(create_app(settings, TestEngine(settings))), calls


def test_live_token_is_short_lived_capped_and_never_exposes_the_key(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, live_max_session_seconds=120)
    with client:
        assert client.get("/api/live/status").json()["available"] is True
        response = client.post("/api/live/token", headers={"Origin": "http://127.0.0.1:8765"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["token"] == "hdr.claims.sig" and payload["max_session_seconds"] == 120
    assert "fal_secret" not in response.text
    assert calls[0]["body"] == {"allowed_apps": ["lucy-2-5"], "token_expiration": 20}
    assert calls[0]["headers"]["Authorization"] == "Key fal_secret"
    assert (tmp_path / "live-usage.jsonl").read_text().count("\n") == 1


def test_live_token_ignores_untrusted_origins_and_rate_limits(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, live_tokens_per_minute=2)
    with client:
        assert client.post("/api/live/token", headers={"Origin": "https://evil.example"}).status_code == 200
        assert client.post("/api/live/token").status_code == 200
        limited = client.post("/api/live/token")
    assert limited.status_code == 503 and "Too many" in limited.json()["detail"]


def test_live_mode_unavailable_without_key(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, key="")
    with client:
        assert client.get("/api/health").json()["live"]["available"] is False
        assert client.post("/api/live/token").status_code == 503
    assert calls == []


def test_live_token_requires_worker_token_when_configured(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, api_token="worker-secret")
    with client:
        assert client.post("/api/live/token").status_code == 401
        assert client.post("/api/live/token", headers={"Authorization": "Bearer worker-secret"}).status_code == 200


def test_csp_allows_realtime_websockets(tmp_path, monkeypatch):
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        csp = client.get("/").headers["content-security-policy"]
    assert "wss:" in csp and "script-src 'self' 'wasm-unsafe-eval';" in csp
    assert " 'unsafe-eval'" not in csp and "'unsafe-inline'" not in csp  # WebAssembly only, never JS eval


def test_fal_token_is_scoped_to_lucy_and_never_exposes_the_key(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, key="", fal_key="fal_secret", live_max_session_seconds=90)
    with client:
        status = client.get("/api/live/status").json()
        response = client.post("/api/live/token", json={"provider": "fal"})
    assert status["available"] is True and status["provider"] == "fal"
    assert {p["id"]: p["available"] for p in status["providers"]} == {"fal": True}
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "fal" and payload["token"] == "hdr.claims.sig"
    assert payload["url"] == "wss://fal.run/decart/lucy-2-5/realtime" and payload["max_session_seconds"] == 90
    assert "fal_secret" not in response.text and "api_key" not in payload
    assert calls[0]["url"] == "https://rest.fal.ai/tokens/"
    assert calls[0]["body"] == {"allowed_apps": ["lucy-2-5"], "token_expiration": 20}
    assert calls[0]["headers"]["Authorization"] == "Key fal_secret"
    ledger = (tmp_path / "live-usage.jsonl").read_text().splitlines()
    assert len(ledger) == 1 and json.loads(ledger[0])["provider"] == "fal"


def test_fal_is_the_only_live_engine(tmp_path, monkeypatch):
    # Decart direct was removed: an old LIVE_PROVIDER=decart setting or a "decart" request can't select it.
    client, calls = live_client(tmp_path, monkeypatch, live_provider="decart")
    with client:
        status = client.get("/api/live/status").json()
        assert status["provider"] == "fal" and [p["id"] for p in status["providers"]] == ["fal"]
        assert client.post("/api/live/token").json()["provider"] == "fal"
        refused = client.post("/api/live/token", json={"provider": "decart"})
        assert refused.status_code == 503 and "Unknown live engine" in refused.json()["detail"]
    assert [c["url"] for c in calls] == ["https://rest.fal.ai/tokens/"]


def test_unknown_or_unconfigured_engines_are_refused(tmp_path, monkeypatch):
    client, calls = live_client(tmp_path, monkeypatch, key="")  # no FAL_KEY
    with client:
        unknown = client.post("/api/live/token", json={"provider": "nope"})
        missing = client.post("/api/live/token", json={"provider": "fal"})
        invalid = client.post("/api/live/token", json={"provider": 5})
        garbled = client.post("/api/live/token", content=b"{", headers={"Content-Type": "application/json"})
    assert unknown.status_code == 503 and "Unknown" in unknown.json()["detail"]
    assert missing.status_code == 503 and "not configured" in missing.json()["detail"]
    assert invalid.status_code == 422 and garbled.status_code == 422
    assert calls == []


def test_env_file_fills_missing_settings_without_overriding_the_shell(tmp_path, monkeypatch):
    from person_studio.__main__ import load_env_file
    env = tmp_path / ".env"
    env.write_text('# comment\nFAL_KEY="fal_from_file"\nLIVE_MODEL=from-file\nEMPTY=\n', encoding="utf-8")
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.setenv("LIVE_MODEL", "from-shell")
    monkeypatch.delenv("EMPTY", raising=False)
    load_env_file(env)
    import os
    assert os.environ["FAL_KEY"] == "fal_from_file"
    assert os.environ["LIVE_MODEL"] == "from-shell"
    assert "EMPTY" not in os.environ



# ---------- prompt assistant ----------
def assist_client(tmp_path, monkeypatch, replies, fal_key="fal_secret", **overrides):
    """replies: (status, body) pairs returned in order by the fake fal endpoint."""
    import urllib.error
    import person_studio.assist as assist_module
    calls = []

    def fake_urlopen(request, timeout):
        calls.append({"url": request.full_url, "headers": dict(request.header_items()), "body": json.loads(request.data)})
        status, body = replies[min(len(calls), len(replies)) - 1]
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(json.dumps(body).encode()))
        return FakeTokenResponse(json.dumps(body).encode())

    monkeypatch.setattr(assist_module.urllib.request, "urlopen", fake_urlopen)
    settings = Settings(data_dir=tmp_path, fal_key=fal_key, **overrides)
    return TestClient(create_app(settings, TestEngine(settings))), calls


def test_assistant_writes_a_look_from_a_few_words(tmp_path, monkeypatch):
    look = {"name": "Pirate Captain", "note": "Ruler of the seas",
            "prompt": "Dress the person in a tricorn hat; keep the face visible.", "refused": False}
    reply = {"output": "```json\n" + json.dumps(look) + "\n```", "cost": 0.0004}
    client, calls = assist_client(tmp_path, monkeypatch, [(200, reply)])
    with client:
        assert client.get("/api/live/status").json()["assist"] is True
        response = client.post("/api/assist/look", json={"idea": "  pirate   captain "})
    assert response.status_code == 200
    assert response.json() == {k: look[k] for k in ("name", "note", "prompt")}
    assert calls[0]["url"] == "https://fal.run/openrouter/router"
    assert calls[0]["body"]["model"] == "google/gemini-2.5-flash" and calls[0]["body"]["prompt"] == "Idea: pirate captain"
    assert "the person" in calls[0]["body"]["system_prompt"] and calls[0]["headers"]["Authorization"] == "Key fal_secret"
    assert "fal_secret" not in response.text
    entry = json.loads((tmp_path / "live-usage.jsonl").read_text().splitlines()[-1])
    assert entry["provider"] == "fal-assist" and entry["kind"] == "look" and entry["cost"] == 0.0004


def test_assistant_retries_models_that_require_reasoning(tmp_path, monkeypatch):
    replies = [(400, {"detail": "Reasoning is mandatory for this endpoint and cannot be disabled."}),
               (200, {"output": json.dumps({"name": "Ice Queen", "note": "Frozen", "prompt": "Restyle the entire scene as ice."})})]
    client, calls = assist_client(tmp_path, monkeypatch, replies, assist_model="google/gemini-3.8-flash")
    with client:
        response = client.post("/api/assist/look", json={"idea": "ice queen"})
    assert response.status_code == 200 and response.json()["name"] == "Ice Queen"
    assert "reasoning" not in calls[0]["body"]
    assert calls[1]["body"]["reasoning"] is True and calls[1]["body"]["max_tokens"] == 2500


def test_assistant_refusals_and_bad_input_are_user_errors(tmp_path, monkeypatch):
    client, calls = assist_client(tmp_path, monkeypatch, [(200, {"output": json.dumps({"name": "", "prompt": "", "refused": True})})])
    with client:
        refused = client.post("/api/assist/look", json={"idea": "something explicit"})
        short = client.post("/api/assist/look", json={"idea": "x"})
        wrong = client.post("/api/assist/look", json={"idea": 7})
    assert refused.status_code == 422 and "made into a look" in refused.json()["detail"]
    assert short.status_code == 422 and wrong.status_code == 422
    assert len(calls) == 1


def test_assistant_describes_a_character_photo_without_metadata(tmp_path, monkeypatch):
    client, calls = assist_client(tmp_path, monkeypatch, [(200, {"output": "Dark brown skin, oval face, short buzz cut, light grey t-shirt."})])
    photo = io.BytesIO()
    Image.new("RGB", (2400, 1600), (120, 90, 70)).save(photo, format="PNG")
    with client:
        response = client.post("/api/assist/describe", files={"image": ("me.png", photo.getvalue(), "image/png")})
    assert response.status_code == 200
    assert response.json() == {"description": "Dark brown skin, oval face, short buzz cut, light grey t-shirt"}
    assert calls[0]["url"] == "https://fal.run/openrouter/router/vision"
    sent = calls[0]["body"]["image_urls"][0]
    assert sent.startswith("data:image/jpeg;base64,")
    import base64
    with Image.open(io.BytesIO(base64.b64decode(sent.split(",", 1)[1]))) as image:
        assert max(image.size) == 1024 and not image.info.get("exif")


def test_assistant_reports_photos_without_a_person(tmp_path, monkeypatch):
    client, _ = assist_client(tmp_path, monkeypatch, [(200, {"output": "NO_PERSON"})])
    photo = io.BytesIO()
    Image.new("RGB", (600, 600)).save(photo, format="JPEG")
    with client:
        none = client.post("/api/assist/describe", files={"image": ("x.jpg", photo.getvalue(), "image/jpeg")})
        empty = client.post("/api/assist/describe", files={"image": ("x.jpg", b"", "image/jpeg")})
        junk = client.post("/api/assist/describe", files={"image": ("x.jpg", b"not an image", "image/jpeg")})
    assert none.status_code == 422 and "No person" in none.json()["detail"]
    assert empty.status_code == 422 and junk.status_code == 422


def test_assistant_needs_a_key_and_is_rate_limited(tmp_path, monkeypatch):
    client, calls = assist_client(tmp_path, monkeypatch, [], fal_key="")
    with client:
        assert client.get("/api/live/status").json()["assist"] is False
        missing = client.post("/api/assist/look", json={"idea": "wizard"})
    assert missing.status_code == 503 and "FAL_KEY" in missing.json()["detail"] and calls == []
    reply = {"output": json.dumps({"name": "Wizard", "note": "Robes", "prompt": "Dress the person in robes."})}
    client, calls = assist_client(tmp_path, monkeypatch, [(200, reply)], assist_calls_per_minute=2)
    with client:
        codes = [client.post("/api/assist/look", json={"idea": "wizard"}).status_code for _ in range(3)]
    assert codes == [200, 200, 503] and len(calls) == 2


# ---------- AI accent voices ----------
def wav_bytes(seconds=2.0, rate=24000):
    import math
    import struct
    import wave
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 20))) for i in range(int(seconds * rate))))
    return buffer.getvalue()


def voice_client(tmp_path, monkeypatch, fal_key="fal_secret", result_url="https://v3.fal.media/files/out.mp3", status=200, **overrides):
    import urllib.error
    import person_studio.voices as voices_module
    calls = []

    def fake_urlopen(request, timeout):
        calls.append({"url": request.full_url, "headers": dict(request.header_items()),
                      "body": json.loads(request.data) if request.data else None})
        if request.full_url == voices_module.ENDPOINT:
            if status != 200:
                raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(b'{"detail":"nope"}'))
            return FakeTokenResponse(json.dumps({"audio": {"url": result_url}, "seed": 1}).encode())
        return FakeTokenResponse(b"ID3-converted-voice")

    monkeypatch.setattr(voices_module.urllib.request, "urlopen", fake_urlopen)
    settings = Settings(data_dir=tmp_path, fal_key=fal_key, **overrides)
    return TestClient(create_app(settings, TestEngine(settings))), calls


def test_ai_voice_converts_a_recording_with_a_preset_voice(tmp_path, monkeypatch):
    client, calls = voice_client(tmp_path, monkeypatch)
    with client:
        status = client.get("/api/live/status").json()
        response = client.post("/api/voice/convert", data={"voice": "british-male"},
                               files={"audio": ("voice.wav", wav_bytes(3.0), "audio/wav")})
    assert {"id": "british-male", "accent": "British", "gender": "male", "voice": "George"} in status["voices"]
    assert status["voice_price_per_minute"] == 0.30
    assert response.status_code == 200 and response.content == b"ID3-converted-voice"
    assert response.headers["content-type"] == "audio/mpeg"
    sent = calls[0]["body"]
    assert calls[0]["url"] == "https://fal.run/fal-ai/elevenlabs/voice-changer"
    assert calls[0]["headers"]["Authorization"] == "Key fal_secret" and sent["voice"] == "George"
    assert sent["audio_url"].startswith(("data:audio/mpeg;base64,", "data:audio/wav;base64,"))
    assert calls[1]["url"] == "https://v3.fal.media/files/out.mp3"
    entry = json.loads((tmp_path / "live-usage.jsonl").read_text().splitlines()[-1])
    assert entry["provider"] == "fal-voice" and entry["voice"] == "George" and entry["seconds"] == 3.0
    assert entry["cost_estimate"] == 0.30  # fal bills whole minutes, at least one


def test_ai_voice_rejects_bad_input_before_spending(tmp_path, monkeypatch):
    client, calls = voice_client(tmp_path, monkeypatch, live_max_session_seconds=10)
    with client:
        unknown = client.post("/api/voice/convert", data={"voice": "elvis"}, files={"audio": ("v.wav", wav_bytes(), "audio/wav")})
        junk = client.post("/api/voice/convert", data={"voice": "british-male"}, files={"audio": ("v.wav", b"not audio", "audio/wav")})
        empty = client.post("/api/voice/convert", data={"voice": "british-male"}, files={"audio": ("v.wav", b"", "audio/wav")})
        long = client.post("/api/voice/convert", data={"voice": "british-male"}, files={"audio": ("v.wav", wav_bytes(30, 8000), "audio/wav")})
    assert [r.status_code for r in (unknown, junk, empty, long)] == [422, 422, 422, 422]
    assert calls == []


def test_ai_voice_needs_a_key_is_rate_limited_and_only_downloads_from_fal(tmp_path, monkeypatch):
    client, calls = voice_client(tmp_path, monkeypatch, fal_key="")
    with client:
        assert client.get("/api/live/status").json()["voices"] == []
        missing = client.post("/api/voice/convert", data={"voice": "british-male"}, files={"audio": ("v.wav", wav_bytes(), "audio/wav")})
    assert missing.status_code == 503 and calls == []
    client, calls = voice_client(tmp_path, monkeypatch, voice_calls_per_minute=1)
    with client:
        codes = [client.post("/api/voice/convert", data={"voice": "american-female"},
                             files={"audio": ("v.wav", wav_bytes(), "audio/wav")}).status_code for _ in range(2)]
    assert codes == [200, 503]
    client, calls = voice_client(tmp_path, monkeypatch, result_url="https://evil.example/x.mp3")
    with client:
        response = client.post("/api/voice/convert", data={"voice": "american-female"}, files={"audio": ("v.wav", wav_bytes(), "audio/wav")})
    assert response.status_code == 503 and len(calls) == 1
    client, calls = voice_client(tmp_path, monkeypatch, status=402)
    with client:
        broke = client.post("/api/voice/convert", data={"voice": "american-female"}, files={"audio": ("v.wav", wav_bytes(), "audio/wav")})
    assert broke.status_code == 503 and "balance" in broke.json()["detail"]


# ---------- network test and long sessions ----------
def test_network_probe_measures_without_storing(tmp_path, monkeypatch):
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        assert client.get("/api/net/probe").json() == {"ok": True}
        assert client.post("/api/net/probe", content=b"x" * 2_000_000).json() == {"bytes": 2_000_000}
        assert client.post("/api/net/probe", content=b"x" * (4 * 1024 * 1024 + 1)).status_code == 413
    assert not any(p.is_file() for p in tmp_path.rglob("*") if p.suffix not in {".jsonl"})


def test_sessions_default_to_thirty_minutes_and_voices_to_ten(tmp_path, monkeypatch):
    monkeypatch.delenv("LIVE_MAX_SESSION_SECONDS", raising=False)
    monkeypatch.delenv("VOICE_MAX_SECONDS", raising=False)
    client, calls = voice_client(tmp_path, monkeypatch)
    with client:
        status = client.get("/api/live/status").json()
        too_long = client.post("/api/voice/convert", data={"voice": "british-male"},
                               files={"audio": ("v.wav", wav_bytes(616, 8000), "audio/wav")})
    assert status["max_session_seconds"] == 1800 and status["voice_max_seconds"] == 600
    assert too_long.status_code == 422 and calls == []


# ---------- clips on fal ----------
def test_clips_run_on_fal_when_no_gpu_worker_is_configured(tmp_path, monkeypatch):
    import person_studio.clip_fal as clip_fal
    from person_studio.clip_fal import FalClipEngine, pick_engine
    assert isinstance(pick_engine(Settings(data_dir=tmp_path, fal_key="fal_secret")), FalClipEngine)
    assert not isinstance(pick_engine(Settings(data_dir=tmp_path, fal_key="")), FalClipEngine)
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((request.get_method(), request.full_url, json.loads(request.data) if request.data else None))
        url = request.full_url
        if url == clip_fal.QUEUE:
            return FakeTokenResponse(json.dumps({"request_id": "r1", "status_url": "https://queue.fal.run/x/requests/r1/status",
                                                 "response_url": "https://queue.fal.run/x/requests/r1", "cancel_url": "https://queue.fal.run/x/requests/r1/cancel"}).encode())
        if url.endswith("/status"):
            return FakeTokenResponse(json.dumps({"status": "COMPLETED"}).encode())
        if url.endswith("/r1"):
            return FakeTokenResponse(json.dumps({"video": {"url": "https://v3.fal.media/files/out.mp4"}}).encode())
        return FakeTokenResponse((tmp_path / "fake-result.mp4").read_bytes())

    monkeypatch.setattr(clip_fal.urllib.request, "urlopen", fake_urlopen)

    class Instant(threading.Event):  # the engine polls fal every 2 s; no waiting in tests
        def wait(self, timeout=None):
            return self.is_set()
    folder = tmp_path / "job"
    folder.mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "2",
                    "-pix_fmt", "yuv420p", str(folder / "upload.video.mp4")], check=True)
    (folder / "upload.video.mp4").rename(folder / "upload.video")
    shutil.copy(folder / "upload.video", tmp_path / "fake-result.mp4")
    Image.new("RGB", (512, 512), (90, 60, 40)).save(folder / "reference.png")
    engine = FalClipEngine(Settings(data_dir=tmp_path, fal_key="fal_secret"))
    steps = []
    metrics = engine.run(folder, {"quality": "preview", "prompt": "x"}, lambda s, m: steps.append(s), Instant())
    method, url, body = calls[0]
    assert method == "POST" and url == "https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace"
    assert body["video_url"].startswith("data:video/mp4;base64,") and body["image_url"].startswith("data:image/png;base64,")
    assert body["resolution"] == "480p"
    assert (folder / "result.mp4").stat().st_size > 0 and metrics["cloud"] == "fal"
    assert metrics["estimated_cost_usd"] == pytest.approx(60 / 16 * 0.04, abs=0.01)  # 2 s at 30 fps = 60 frames
    assert steps[0] == "preparing" and steps[-1] == "encoding"
    entry = json.loads((tmp_path / "live-usage.jsonl").read_text().splitlines()[-1])
    assert entry["provider"] == "fal-clip" and entry["resolution"] == "480p"


def test_dev_mode_only_disables_vyra_added_marks_and_configures_streaming(tmp_path, monkeypatch):
    monkeypatch.setenv("VYRA_DEV_MODE", "true")
    monkeypatch.setenv("AI_LABEL", "on")
    client, _ = live_client(tmp_path, monkeypatch, rtmp_url="rtmps://ingest.example/live/secret")
    with client:
        status = client.get("/api/live/status").json()
        assert status["vyra_dev_mode"] is True and status["ai_label"] is True
        assert status["streaming_available"] is True
        assert client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200


def test_live_stream_ticket_requires_configured_rtmp_and_allowed_origin(tmp_path, monkeypatch):
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        unavailable = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"})
        assert unavailable.status_code == 422 and "stream key" in unavailable.json()["detail"]
    client, _ = live_client(tmp_path, monkeypatch, rtmp_url="https://ingest.example/live/key")
    with client:
        invalid = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"})
    client, _ = live_client(tmp_path, monkeypatch, rtmp_url="rtmp://ingest.example/live/key")
    with client:
        denied = client.post("/api/live/stream/ticket", headers={"Origin": "https://evil.example"})
    assert invalid.status_code == 503 and "RTMP" in invalid.json()["detail"]
    assert denied.status_code == 403
    client, _ = live_client(tmp_path, monkeypatch, rtmp_url="rtmps://ingest.example/live/key")
    with client:
        granted = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"})
        ticket = granted.json()["ticket"]
        # A one-time ticket is accepted by WS only for its bound origin; valid use consumes it.
        with pytest.raises(Exception):
            with client.websocket_connect(f"/api/live/stream/{ticket}", headers={"origin": "https://evil.example"}) as ws:
                pass
        repeated = client.websocket_connect(f"/api/live/stream/{ticket}", headers={"origin": "http://127.0.0.1:8765"})
        with pytest.raises(Exception):
            with repeated:
                pass
    assert granted.status_code == 200 and len(ticket) >= 32


def test_live_stream_websocket_pipes_binary_chunks_and_closes_ffmpeg(tmp_path, monkeypatch):
    import person_studio.app as app_module

    class FakeStdin:
        def __init__(self):
            self.data = bytearray()
            self.closed = False
        def write(self, chunk):
            self.data.extend(chunk)
            return len(chunk)
        def close(self):
            self.closed = True

    class FakeProcess:
        def __init__(self, command):
            self.command = command
            self.stdin = FakeStdin()
            self.returncode = None
        def poll(self):
            return self.returncode
        def wait(self, timeout=None):
            self.returncode = 0
            return self.returncode
        def terminate(self): self.returncode = -15
        def kill(self): self.returncode = -9

    processes = []
    def fake_popen(command, **kwargs):
        process = FakeProcess(command)
        processes.append((process, kwargs))
        return process

    monkeypatch.setattr(app_module.subprocess, "Popen", fake_popen)
    client, _ = live_client(tmp_path, monkeypatch, rtmp_url="rtmps://ingest.example/live/key")
    with client:
        ticket = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"}).json()["ticket"]
        with client.websocket_connect(f"/api/live/stream/{ticket}", headers={"origin": "http://127.0.0.1:8765"}) as ws:
            assert ws.receive_json() == {"type": "ready"}
            ws.send_bytes(b"webm-chunk-1")
            ws.send_bytes(b"webm-chunk-2")
            ws.send_text("end")
    process, options = processes[0]
    assert process.stdin.data == b"webm-chunk-1webm-chunk-2" and process.stdin.closed
    assert options["stdout"] == app_module.subprocess.DEVNULL and options["stderr"] == app_module.subprocess.DEVNULL
    assert "libx264" in process.command and process.command[-1] == "rtmps://ingest.example/live/key"
    assert process.returncode == 0


def test_stream_ticket_requires_worker_token_when_configured(tmp_path, monkeypatch):
    client, _ = live_client(tmp_path, monkeypatch, api_token="private-token", rtmp_url="rtmp://ingest.example/live/key")
    with client:
        denied = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765"})
        allowed = client.post("/api/live/stream/ticket", headers={"Origin": "http://127.0.0.1:8765", "Authorization": "Bearer private-token"})
    assert denied.status_code == 401
    assert allowed.status_code == 200


def test_ai_label_is_off_while_building_and_one_setting_turns_it_on(tmp_path, monkeypatch):
    monkeypatch.delenv("AI_LABEL", raising=False)
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        assert client.get("/api/live/status").json()["ai_label"] is False
    monkeypatch.setenv("AI_LABEL", "on")
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        assert client.get("/api/live/status").json()["ai_label"] is True


def test_assistant_edits_the_current_look_instead_of_replacing_it(tmp_path, monkeypatch):
    reply = {"output": json.dumps({"name": "Snowy Anime", "note": "Anime in snowfall", "prompt": "Restyle the entire scene as anime with falling snow."})}
    client, calls = assist_client(tmp_path, monkeypatch, [(200, reply)])
    with client:
        response = client.post("/api/assist/look", json={"idea": "make it snow", "base": "Restyle the entire scene as a hand-drawn anime frame."})
        wrong = client.post("/api/assist/look", json={"idea": "make it snow", "base": 5})
    assert response.status_code == 200 and response.json()["name"] == "Snowy Anime"
    assert calls[0]["body"]["prompt"] == "Current look: Restyle the entire scene as a hand-drawn anime frame.\nChange: make it snow"
    assert "add only the requested change" in calls[0]["body"]["system_prompt"]
    assert wrong.status_code == 422
    entry = json.loads((tmp_path / "live-usage.jsonl").read_text().splitlines()[-1])
    assert entry["kind"] == "edit"


def test_user_stream_destination_is_validated(tmp_path, monkeypatch):
    from person_studio.streaming import DestinationError, destination
    import socket as socket_module
    public = [(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", ("142.250.0.1", 0))]
    private = [(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", ("10.0.0.5", 0))]
    monkeypatch.setattr("person_studio.streaming.socket.getaddrinfo", lambda host, *a, **k: private if host == "internal.example" else public)
    assert destination("rtmp://a.rtmp.youtube.com/live2", "abcd-1234") == "rtmp://a.rtmp.youtube.com/live2/abcd-1234"
    assert destination("rtmps://live-api-s.facebook.com:443/rtmp/", "FB-1?s_bl=1") == "rtmps://live-api-s.facebook.com:443/rtmp/FB-1?s_bl=1"
    for url, key in [("https://youtube.com/live", "k"), ("rtmp://user:pw@host.example/app", "k"), ("rtmp://internal.example/app", "k"),
                     ("rtmp://a.rtmp.youtube.com/live2", "key with spaces"), ("", "k")]:
        with pytest.raises(DestinationError):
            destination(url, key)
    assert destination("rtmp://internal.example/app", "k", allow_private=True).endswith("/app/k")


def test_user_destination_reaches_ffmpeg_and_one_stream_per_user(tmp_path, monkeypatch):
    import socket as socket_module
    monkeypatch.setattr("person_studio.streaming.socket.getaddrinfo",
                        lambda *a, **k: [(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", ("142.250.0.1", 0))])
    started = []

    class FakeProcess:
        def __init__(self, command, **kwargs):
            self.command, self.stdin = command, io.BytesIO()
            started.append(self)
        def poll(self):
            return None
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr("person_studio.app.subprocess.Popen", FakeProcess)
    client, _ = live_client(tmp_path, monkeypatch)
    headers = {"Origin": "http://127.0.0.1:8765"}
    with client:
        bad = client.post("/api/live/stream/ticket", headers=headers, json={"url": "http://not-rtmp.example/x", "key": "k"})
        assert bad.status_code == 422
        ticket = client.post("/api/live/stream/ticket", headers=headers,
                             json={"url": "rtmp://live.twitch.tv/app", "key": "live_123_abc"}).json()["ticket"]
        with client.websocket_connect(f"/api/live/stream/{ticket}", headers={"origin": "http://127.0.0.1:8765"}) as ws:
            assert ws.receive_json()["type"] == "ready"
            second = client.post("/api/live/stream/ticket", headers=headers,
                                 json={"url": "rtmp://live.twitch.tv/app", "key": "live_123_abc"}).json()["ticket"]
            with pytest.raises(Exception):
                with client.websocket_connect(f"/api/live/stream/{second}", headers={"origin": "http://127.0.0.1:8765"}) as other:
                    other.receive_json()
            ws.send_text("end")
    assert started[0].command[-1] == "rtmp://live.twitch.tv/app/live_123_abc"


def test_virtual_camera_bundles_and_pwa_manifest_are_served(tmp_path, monkeypatch):
    import zipfile
    client, _ = live_client(tmp_path, monkeypatch)
    with client:
        ext_res = client.get("/api/virtual-cam/extension.zip")
        assert ext_res.status_code == 200
        assert ext_res.headers["content-type"] == "application/zip"
        with zipfile.ZipFile(io.BytesIO(ext_res.content)) as zf:
            names = set(zf.namelist())
            assert {"manifest.json", "background.js", "content-bridge.js", "page-inject.js", "popup.html"}.issubset(names)
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            assert "<all_urls>" not in manifest.get("host_permissions", [])
            for script in manifest.get("content_scripts", []):
                assert "<all_urls>" not in script.get("matches", [])
            bg_src = zf.read("background.js").decode("utf-8")
            assert "isAllowedStudioSender(port.sender)" in bg_src
            inject_src = zf.read("page-inject.js").decode("utf-8")
            assert "RTCPeerConnection" in inject_src

        nat_res = client.get("/api/virtual-cam/native.zip")
        assert nat_res.status_code == 200
        with zipfile.ZipFile(io.BytesIO(nat_res.content)) as zf:
            names = set(zf.namelist())
            assert "bridge/vyra_cam_bridge.py" in names
            assert "windows/VyraDirectShowCam.cpp" in names
            assert "windows/mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md" in names
            assert "windows/mf-virtual-camera/build.cmd" in names
            assert "macos/VyraCameraExtensionProvider.swift" in names
            assert "macos/VyraExtensionProvider.swift" in names
            assert "macos/Info.plist" in names
            assert "macos/BUILD-SIGN-NOTARIZE.md" in names
            cpp_src = zf.read("windows/VyraDirectShowCam.cpp").decode("utf-8")
            for required_symbol in ("DllGetClassObject", "IClassFactory", "IBaseFilter", "FillBuffer"):
                assert required_symbol in cpp_src
            # The DirectShow filter must NOT claim Media Foundation virtual-camera support:
            # that path needs a genuine IMFMediaSource COM class (see mf-virtual-camera docs).
            assert "MFCreateVirtualCamera" not in cpp_src
            mf_doc = zf.read("windows/mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md").decode("utf-8")
            assert "MFCreateVirtualCamera" in mf_doc
            mac_sign = zf.read("macos/BUILD-SIGN-NOTARIZE.md").decode("utf-8")
            assert "com.apple.developer.system-extension.install" in mac_sign
            assert "$99/year" in mac_sign
            plist_src = zf.read("macos/Info.plist").decode("utf-8")
            assert "CMIOExtensionMachServiceName" in plist_src

        manifest_res = client.get("/manifest.webmanifest")
        assert manifest_res.status_code == 200
        assert manifest_res.json()["short_name"] == "VYRANI"
        sw_res = client.get("/sw.js")
        assert sw_res.status_code == 200


def test_obs_commander_collection_and_launch_flags(tmp_path, monkeypatch):
    from person_studio import obs_commander
    from pathlib import Path
    assert obs_commander.local_mode(Settings(data_dir=tmp_path)) is True
    assert obs_commander.local_mode(Settings(data_dir=tmp_path, api_token="t")) is False
    assert obs_commander.local_mode(Settings(data_dir=tmp_path, mongo_uri="mongodb://x")) is False

    monkeypatch.setattr(obs_commander, "scenes_dir", lambda: tmp_path / "scenes")
    path = obs_commander.write_collection("My Window Title")
    collection = json.loads(path.read_text(encoding="utf-8"))
    assert collection["name"] == "VYRANI Camera"
    assert collection["sources"][1]["settings"]["window"] == "My Window Title"
    assert collection["sources"][1]["settings"]["priority"] == 1

    from pathlib import PurePath
    fake_exe = PurePath("obs64.exe")
    command = obs_commander.launch_command(Path(fake_exe))
    joined = " ".join(command)
    assert all(flag in joined for flag in ("--collection", "--startvirtualcam", "--minimize-to-tray", "--multi"))

    spawn_args, spawn_kwargs = obs_commander.launch_obs(Path(fake_exe), spawn=lambda cmd, **kb: (cmd, kb), detach="devnull")
    assert spawn_args[0] == str(Path(fake_exe)) and "--startvirtualcam" in spawn_args
    assert spawn_kwargs["stdout"] == "devnull" and spawn_kwargs["stderr"] == "devnull"


def test_obs_commander_routes_are_local_only(tmp_path, monkeypatch):
    headers = {"Origin": "http://127.0.0.1:8765", "Authorization": "Bearer test-token"}
    client = TestClient(create_app(Settings(data_dir=tmp_path, api_token="test-token"), TestEngine(Settings(data_dir=tmp_path))))
    with client:
        assert client.get("/api/obs/status", headers=headers).status_code == 404
        assert client.post("/api/obs/launch", headers=headers).status_code == 404

    # Pure-local mode: status reflects what OBS is found on disk; launch spawns OBS with its flags.
    from person_studio import obs_commander
    from pathlib import Path
    exe = tmp_path / "obs-studio" / "bin" / "64bit" / "obs64.exe"
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(b"MZ")
    settings = Settings(data_dir=tmp_path)
    client = TestClient(create_app(settings, TestEngine(settings)))
    with client:
        monkeypatch.setattr(obs_commander, "find_obs", lambda: None)
        assert client.get("/api/obs/status", headers={"Origin": "http://127.0.0.1:8765"}).json()["installed"] is False

        monkeypatch.setattr(obs_commander, "find_obs", lambda: exe)
        monkeypatch.setattr(obs_commander, "scenes_dir", lambda: tmp_path / "scenes")
        launched_calls = []
        monkeypatch.setattr(obs_commander, "launch_obs", lambda exe_: launched_calls.append(str(exe_)) or {"launched": True})
        launched = client.post("/api/obs/launch", headers={"Origin": "http://127.0.0.1:8765"})

    assert launched.status_code == 200
    assert launched.json()["window_title"] == "VYRANI AI Camera Output"
    assert len(launched_calls) == 1


def test_native_cam_bridge_rejects_untrusted_origins_and_authenticates():
    import asyncio
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("vyra_cam_bridge", Path(__file__).resolve().parent.parent / "native-cam/bridge/vyra_cam_bridge.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)

    allowed = {"http://127.0.0.1:8765", "https://vyrani.blackhevents.com"}
    assert bridge.is_origin_allowed("http://127.0.0.1:8765", allowed) is True
    assert bridge.is_origin_allowed("https://evil.example.com", allowed) is False
    assert bridge.is_origin_allowed("", allowed) is False

    class DummyShm:
        seq = 7

    async def run_request(raw_request: bytes, required_token: str = "") -> bytes:
        reader = asyncio.StreamReader()
        reader.feed_data(raw_request)
        reader.feed_eof()
        written = bytearray()

        class DummyWriter:
            def write(self, data):
                written.extend(data)
            async def drain(self):
                pass
            def close(self):
                pass
            async def wait_closed(self):
                pass

        await bridge.handle_client(reader, DummyWriter(), DummyShm(), allowed_origins=allowed, required_token=required_token)
        return bytes(written)

    # 1. Untrusted origin is rejected with 403 Forbidden
    res_evil = asyncio.run(run_request(b"GET /vyra-cam HTTP/1.1\r\nHost: 127.0.0.1:29876\r\nOrigin: https://evil.example\r\n\r\n"))
    assert res_evil.startswith(b"HTTP/1.1 403 Forbidden")
    assert b"Access-Control-Allow-Origin: *" not in res_evil

    # 2. Missing Origin is rejected with 403 Forbidden
    res_no_origin = asyncio.run(run_request(b"GET /vyra-cam HTTP/1.1\r\nHost: 127.0.0.1:29876\r\n\r\n"))
    assert res_no_origin.startswith(b"HTTP/1.1 403 Forbidden")

    # 3. Trusted Origin succeeds and echoes exact Origin (never *)
    res_ok = asyncio.run(run_request(b"GET /vyra-cam HTTP/1.1\r\nHost: 127.0.0.1:29876\r\nOrigin: http://127.0.0.1:8765\r\n\r\n"))
    assert res_ok.startswith(b"HTTP/1.1 200 OK")
    assert b"Access-Control-Allow-Origin: http://127.0.0.1:8765\r\n" in res_ok
    assert b"Access-Control-Allow-Origin: *" not in res_ok

    # 4. Token requirement enforced when configured
    res_bad_tok = asyncio.run(run_request(b"GET /vyra-cam?token=wrong HTTP/1.1\r\nHost: 127.0.0.1:29876\r\nOrigin: http://127.0.0.1:8765\r\n\r\n", required_token="secret123"))
    assert res_bad_tok.startswith(b"HTTP/1.1 401 Unauthorized")
    res_good_tok = asyncio.run(run_request(b"GET /vyra-cam?token=secret123 HTTP/1.1\r\nHost: 127.0.0.1:29876\r\nOrigin: http://127.0.0.1:8765\r\n\r\n", required_token="secret123"))
    assert res_good_tok.startswith(b"HTTP/1.1 200 OK")


def test_setup_status_lists_local_steps(tmp_path, monkeypatch):
    """Local mode reports every first-run step; the portable FFmpeg slot counts as installed."""
    from person_studio import obs_commander, setup as setup_module
    portable = tmp_path / "ffmpeg" / "bin" / "ffmpeg.exe"
    portable.parent.mkdir(parents=True, exist_ok=True)
    portable.write_bytes(b"MZ")
    settings = Settings(data_dir=tmp_path)
    client = TestClient(create_app(settings, TestEngine(settings)))
    with client:
        monkeypatch.setattr(obs_commander, "find_obs", lambda: None)
        body = client.get("/api/setup").json()
    assert body["mode"] == "local"
    by_id = {step["id"]: step for step in body["steps"]}
    assert list(by_id) == ["engine", "extension", "camera_apps", "ffmpeg"]
    assert by_id["engine"]["status"] == "done"          # TestEngine reports itself configured
    assert by_id["extension"]["status"] == "guide"        # client probes the extension live; server stays conservative
    assert by_id["camera_apps"]["status"] == "guide"      # no OBS on disk
    assert by_id["ffmpeg"]["detail"].startswith("Found at")  # portable install detected

    # Without FFmpeg anywhere, clip-mode engines make the step required and offer the one-click fix.
    settings_vanilla = Settings(data_dir=tmp_path, ffmpeg_path="")
    monkeypatch.setattr(setup_module, "ffmpeg_executable", lambda settings: None)
    client = TestClient(create_app(settings_vanilla, TestEngine(settings_vanilla)))
    with client:
        body = client.get("/api/setup").json()
    ffmpeg_step = next(step for step in body["steps"] if step["id"] == "ffmpeg")
    assert ffmpeg_step["status"] == "missing" and ffmpeg_step["fix"] == "download-ffmpeg"

    # One-click fix: installs to the data dir. Download and verification are faked.
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("ffmpeg-7.4-essentials_build/bin/ffmpeg.exe", b"MZfake")
        zf.writestr("ffmpeg-7.4-essentials_build/bin/ffprobe.exe", b"MZfake")
    fetched = []
    def fake_fetch(url, destination):
        fetched.append(url)
        destination.write_bytes(buffer.getvalue())
    monkeypatch.setattr(setup_module, "fetch_url", fake_fetch)
    monkeypatch.setattr(setup_module, "_run_version_check", lambda exe: True)
    fix = client.post("/api/setup/fix/ffmpeg")

    assert fix.status_code == 200
    assert fetched == [setup_module.FFMPEG_URL]
    installed_exe = (tmp_path / "ffmpeg" / "bin" / "ffmpeg.exe")
    assert installed_exe.read_bytes().startswith(b"MZfake")
    assert (tmp_path / "ffmpeg" / "bin" / "ffprobe.exe").exists()  # flattened out of the build subfolder


def test_setup_steps_hosted_gating(tmp_path, monkeypatch):
    """With an access token (as in the hosted gate), only the engine step is exposed and fixes are refused."""
    from person_studio import setup as setup_module
    headers = {"Origin": "http://127.0.0.1:8765", "Authorization": "Bearer test-token"}
    client = TestClient(create_app(Settings(data_dir=tmp_path, api_token="test-token"), TestEngine(Settings(data_dir=tmp_path))))
    with client:
        body = client.get("/api/setup", headers=headers).json()
        assert body["mode"] == "hosted"
        # Hosted still shows the browser-extension step (it works everywhere), but no machine-local steps.
        assert [step["id"] for step in body["steps"]] == ["engine", "extension"]
        # No native spawn or download may run on a hosted server.
        assert client.post("/api/setup/fix/ffmpeg", headers=headers).status_code == 404



