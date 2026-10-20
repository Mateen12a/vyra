# Vyrani Studio

**Your next look. Live.** Testing deployment hostname: `vyrani.blackhevents.com` (deployment and HTTPS verification pending).

Become anyone you imagine — live. VYRANI AI has two modes:

- **Live** (default): your camera is transformed in real time by Decart's Lucy 2.5 realtime model, reached through either of two engines you can switch between in the app:
  - **Decart** — direct (WebRTC/LiveKit, 1280×720), with Decart's own connection diagnostics.
  - **Lucy via fal** — the same model billed through fal.ai; fal relays the WebRTC signalling and the video flows directly between the browser and Decart.
  **Lucy via fal is the default.** Type a few words ("pirate captain") and the built-in prompt assistant (Gemini 2.5 Flash through fal) writes and applies a full look in about 2 s; upload a character photo and it describes itself.
  Pick a look or a consented character image, go live, switch looks without reconnecting, **record** the AI output to an MP4, use **clean view** for OBS window capture, or publish to an RTMP(S) ingest from VYRANI.
  **Voice**, two kinds:
  - *Live voices* (free, on this device): Natural, Male, Female, Deep, Cartoon, Robot, Radio, Monster, Cave. Male and Female use a pitch-synchronous shifter (`web/voice-worklet.js`) that changes pitch and voice character separately and adapts to the speaker's own pitch, so "Male" works for anyone. The microphone is never sent to fal or Decart; it is mixed into recordings only, delayed by the measured video lag (motion matching between camera and AI video) so lips and voice line up.
  - *Accent voices* (AI, paid): American, British, Australian, Swedish and Transatlantic, male and female, using ElevenLabs preset voices through fal (`fal-ai/elevenlabs/voice-changer`, $0.30 per **started** minute, so every conversion costs at least $0.30, as the fal dashboard showed on 2026-10-11; same `FAL_KEY`). The voice changer works on files, not live audio, so it is applied when a recording is saved: the recorded voice goes to `/api/voice/convert`, and the new voice replaces it in the MP4 (video copied, not re-encoded). If it fails, the recording is saved with the speaker's own voice. Preset voices only; no cloning.
- **Clips**: highest-quality full-body replacement of a recorded 0.5–10 s clip with Wan 2.2 Animate. With no GPU worker configured it runs on fal (`fal-ai/wan/v2.2-14b/animate/replace`, billed per 16 output frames: $0.04 at 480p and $0.08 at 720p, so about $0.075 and $0.15 per second of a 30 fps clip). Measured 2026-10-11: a 3 s selfie clip took 5.5 min and cost $0.23 at 480p and replaced the person with the reference character, keeping movement and background. A configured GPU worker still takes priority.
- **Network panel**: live connection quality (signal bars), upload rate, latency, video delay, frame rate and packet loss, with a plain-language tip when something limits the video, and a "Test my connection" check against the VYRANI server (`/api/net/probe`).
- **Live sources**: a camera, a video file (played on a loop) or a shared screen can be transformed live.
- **Scenes tab**:
  - *Voice commands* (hold <kbd>V</kbd> / the mic button, or hands-free with "Vyrani, …"): "switch to anime", "female voice", "start recording", "show the banner". Anything else edits the current look through the prompt assistant, so "make it snow" keeps the look and adds snow. Speech-to-text is the browser's own service (Google in Chrome and Edge). Hold-to-talk mutes the command in recordings.
  - *Scene rules*: "when <trigger> do <action>", optionally undone when the trigger stops. Triggers are hand gestures (open hand, thumbs up, peace sign, point up, fist), objects appearing (phone, bottle, cup, book, laptop) and leaving the frame. They are detected on the user's device with MediaPipe (free, private, about 7 checks a second, debounced). Actions are switch look, change voice, show or hide the banner, and start recording.
  - *Overlay*: a lower-third banner (title, subtitle, optional logo) on the stage and burned into recordings.
- **Provenance**: outside development mode, saved MP4s carry VYRANI metadata tags and optionally a visible label. Set `VYRA_DEV_MODE=true` for local development to omit VYRANI-added pixel labels and provenance metadata; this does not alter provider-added marks.
- **Livestream**: configure `VYRA_RTMP_URL` with an RTMP/RTMPS ingest URL in the server's ignored `.env`, install FFmpeg with `libx264`, then go live and choose **Start stream**. Video and optional delayed voice are encoded server-side and sent to the configured ingest. The stream key never goes to the browser. Configure RTMPS/TLS when possible; keep the server local/private because ingress can use significant bandwidth.
- **Virtual cameras**: OBS clean-window capture remains the current camera-app path. Windows/WhatsApp and macOS/FaceTime native virtual cameras require separate native Media Foundation and Core Media I/O extension projects, signing/installation, and platform testing; they are not supplied by the Python/JS app. WhatsApp compatibility with virtual cameras must be confirmed in its desktop client.
- **Colour themes**: Signal (orange, default), Lime, Ice and Gold, switchable from the Session panel and remembered per browser.

"VYRANI AI" is the working brand. Run a trademark search before launch.

### Measured live performance (from a Nigerian home connection)

| Engine | Time to first AI frame | Output | Network round trip |
| --- | --- | --- | --- |
| Decart direct (2026-10-10) | 5.7 s with token prefetch (9.7 s without) | 1280×720, 20–22 FPS | 128–854 ms, bandwidth-limited |
| Lucy via fal (2026-10-11, 36 s session) | 7.7 s | 720×1280 portrait camera, 10–22 FPS | 267–358 ms, bandwidth-limited |

Both engines cost $0.02 per second of open session (standard mode). Your upload bandwidth is the main limiter.
In the 2026-10-11 fal test, no "AI Generated" watermark appeared in the sampled frames; Decart direct adds one.

### Live mode safeguards

- `DECART_API_KEY` and `FAL_KEY` stay on the server. Browsers receive tokens that expire in 20 s: Decart tokens are limited to one model, (when trusted) the page origin, and carry a Decart-enforced `maxSessionDuration`; fal tokens are scoped to the single Lucy app.
- Decart enforces its cap **per session, not per token**; fal enforces none, so the browser also stops every session at `LIVE_MAX_SESSION_SECONDS` (default 30 minutes, with a one-minute warning). Short token expiry and a per-minute mint limit stop chained reconnects. Every mint is logged with its engine to `PERSON_DATA_DIR/live-usage.jsonl`; reconcile with the provider dashboards.
- If fal reports a busy live slot, the app recognizes common busy/locked/already-active responses and retries with capped exponential delays (up to seven retries over roughly two minutes) before reporting failure; stopping cancels the wait immediately.
- Accent voices are rate limited (`VOICE_CALLS_PER_MINUTE`), limited to the session length, preset only, and logged with an estimated cost to `live-usage.jsonl`.
- The prompt assistant is rate limited (`ASSIST_CALLS_PER_MINUTE`), refuses sexual, hateful or graphic looks, never identifies people in photos, and strips photo metadata before sending; each call is logged to `live-usage.jsonl`.
- Sessions stop after 60 s in a hidden tab, and after 40 s if no video comes back. Character images require a likeness-consent confirmation. With `AI_LABEL=on` and `VYRA_DEV_MODE=false`, the live view and output show a **VYRANI · AI** label. Development mode suppresses only VYRANI-added labels and MP4 metadata; it never attempts to remove or obscure provider-added marks. Content resembling real people should keep an AI disclosure.
- Voice effects are presets only. There is no voice cloning; any future AI voice that imitates a real person needs that person's consent, like character images.
- Decart's "AI Generated" watermark must not be removed, covered, or altered (Decart Terms/AUP). Content resembling real people must keep an AI disclosure regardless of engine.
- Commercial use needs written agreements: Decart's API terms forbid making the service available to third parties without its consent, and fal's terms limit use to personal or internal business use.

## Live output setup

The optional RTMP relay streams the composited AI output (including VYRANI overlays/label) and, when enabled, the locally processed voice. Install a recent FFmpeg build with `libx264` and AAC, then set `VYRA_RTMP_URL=rtmps://<provider-ingest>/<stream-key>` in the project `.env` and restart the server. Keep the URL private: it is used only by server-side FFmpeg and never returned to the browser. The browser uploads short WebM chunks over an origin-bound, one-use WebSocket ticket; FFmpeg transcodes them to H.264/AAC FLV for the ingest. This consumes server upload bandwidth and CPU. Keep VYRANI bound to localhost or protected by `PERSON_API_TOKEN`; do not expose an unauthenticated relay to the public internet.

For a system camera device, use OBS Virtual Camera with VYRANI clean view/window capture. A native Windows virtual-camera implementation is a separate Media Foundation project; a macOS camera source requires a separately packaged Core Media I/O extension. The Python/JavaScript app does not register OS-level cameras. WhatsApp Desktop virtual-camera compatibility must be checked against the actual client and is not guaranteed.

## Start on Windows

Run these from the project directory:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e '.[test]'
.venv/Scripts/python.exe -m person_studio
```

For live mode, put `DECART_API_KEY=...` and/or `FAL_KEY=...` in a `.env` file in the project folder (loaded at start; shell variables win). fal is the default engine when `FAL_KEY` is set; `LIVE_PROVIDER=decart` switches the default.

### One command on Windows

From a fresh checkout, `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` does all of the above in one go: creates the venv, installs dependencies, creates `.env` from the template, builds the frontend when it is not bundled, starts the server and opens the app.

### First-run setup wizard

When the app opens the first time, Studio shows a four-step wizard driven by `GET /api/setup`: the AI engine key, the browser virtual-camera extension, the OBS path for desktop apps, and FFmpeg (required for Clips/streaming on a server without a GPU worker). On Windows, FFmpeg has an **Install for me** button that unpacks a portable build into `.data/ffmpeg` — no admin rights, no system-wide install. The wizard can be skipped and re-opened with the **Setup guide** button at the bottom of the Studio panel. All machine-local fixes are refused in hosted mode, where the operator configures the server.

Open **http://127.0.0.1:8765**. Use **Use camera**, permit camera access, and record a 6-second clip, or upload a short MP4/WebM/MOV. Add a JPG/PNG/WebP reference image. Generation stays disabled until a configured processor is connected.

Once installed, you can also start it in the background with `./scripts/start-local.ps1 -OpenBrowser` and stop that launcher-managed server with `./scripts/stop-local.ps1`.

The application dependencies are small and do not install PyTorch or model weights on your laptop. FFmpeg is required on the **worker**, not for local camera capture. Python 3.9 supports the local interface; use Python 3.11 for the GPU model environment.

## Connect a GPU

For the current laptop's limits, open-source live candidates and API cost comparisons,
see [the cost-conscious options and benchmark](docs/open-source-options.md).

Follow [the cloud worker setup](docs/cloud-worker.md). Run the same application on the GPU server, with `WAN_REPO`, `WAN_CHECKPOINT`, and `WAN_PYTHON` pointing to the upstream model environment. Prefer an SSH tunnel, then choose **Connect GPU processor** and enter the forwarded localhost URL and worker token.

No paid service is provisioned by this project. You choose the machine and stop it when finished. No third-party generation API is required.

## Verify the foundation

```powershell
.venv/Scripts/python.exe -m pytest -q
node --check person_studio/web/app.js
node --check person_studio/web/live.js
```

For the optional browser checks (requires Node.js and FFmpeg for synthetic fixtures):

```powershell
npm.cmd ci
npx.cmd playwright install chromium
.venv/Scripts/python.exe scripts/make_test_media.py
npm.cmd run test:browser
```

Set `VYRA_URL` to run the browser checks against a server on another port. Rebuild the bundled live client with `npm.cmd run build:live-sdk`.

Tests cover API authentication, input validation, queue limits, GPU job cancellation, restart recovery, downloads, deletion, and actual FFmpeg media inspection. GPU generation is deliberately excluded from local tests; orchestration tests use an explicitly injected test engine. See [the quality benchmark plan](docs/quality-benchmark.md) for the first GPU run.

## Architecture

```text
Browser camera / source upload + reference image
              │ authenticated HTTP
              ▼
FastAPI service → bounded queue (one GPU job at a time)
              │
              ▼
FFmpeg normalization → tracking / segmentation → Wan-Animate replacement
              │
              ▼
MP4 output + timing metrics → browser review / download
```

The model process runs in its own Python environment. Commands use argument arrays, not a shell. Jobs persist metadata in `PERSON_DATA_DIR/jobs/<uuid>/job.json`; interrupted jobs become failed on server restart. Source uploads, model inputs, logs, and outputs remain on that server until **Delete test files** is used. There is no automatic retention policy yet. The access token identifies a private worker, not separate users; this version is for a single owner, not a public multi-user deployment.

`processing / clip` is total worker processing time divided by source clip duration. It is **not** camera-to-screen latency and excludes upload and download. A ratio under 1 would still not prove acceptable streaming latency or quality. No FPS is invented from file export metadata.

## Open source and dependencies

Our application code is MIT licensed. [Wan-Animate code](https://github.com/Wan-Video/Wan2.2) and [main model weights](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B) are published under Apache 2.0. Auxiliary tracking, segmentation, runtime components, and checkpoint licenses must be reviewed separately; the complete model pipeline is not represented as uniformly MIT/Apache licensed. NVIDIA's GPU drivers and CUDA runtime also have their own terms. The reference implementation uses a YOLO detector checkpoint, which needs special attention before distribution or commercial hosting.

The official [preprocessing guide](https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/animate/preprocess/UserGuider.md) limits the supplied mask tracking to single-person video and explains the tradeoff between character coverage and preserving the background. This is one of the first quality checks, not a solved guarantee.
# Watermark tools

Open `/watermark` in VYRANI AI for local webcam/video watermark tools. Add text or a PNG/JPEG/WebP logo, choose its position and opacity, and record the processed canvas as WebM. Uploaded video audio is preserved in recordings; camera audio is disabled. No cloud GPU is required.

For footage you own or have permission to edit, drag a small rectangle and enable region blending to obscure an existing watermark. This uses boundary pixel interpolation, not AI reconstruction: moving textures, people, and detailed backgrounds may smear. Removal is limited to 15% of the frame. It does not guarantee artifact-free removal.

