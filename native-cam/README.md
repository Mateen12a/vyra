# VYRANI AI Virtual Camera — Capabilities & Setup Guide

VYRANI lets you use your live AI-transformed video and voice inside WhatsApp, Google Meet,
Zoom, Discord, Microsoft Teams, and other video apps. There are two complementary delivery
surfaces, and it is worth being precise about what each one covers:

| Where you call | What provides the camera | Status |
| --- | --- | --- |
| WhatsApp Web, Google Meet, Zoom Web, Discord Web, Teams Web (browser tabs) | VYRANI browser extension | **Working** — real-call testing is the next milestone |
| Native desktop apps on Windows incl. Store apps (WhatsApp Desktop, Zoom.exe, Teams, Windows Camera) | DirectShow filter + the Media Foundation virtual camera path | DirectShow works today for DShow-enumerating apps; Media Foundation path is **documented + scripted, needs an MSVC build on Windows 11 to activate** |
| Native desktop apps on macOS (FaceTime, Zoom, WhatsApp, Teams) | CoreMediaIO camera system extension | Free **Developer Preview** DMG for your own Macs (`macos/dev-dmg/`); real distribution to customers still requires the **Apple Developer Program ($99/yr)** for Developer ID + notarization |

The browser extension cannot make a system camera appear: Chrome extensions have no API that
registers a camera device with Windows or macOS. That is why the native deliverables above
exist — build them, don't pretend the extension covers desktop apps.

---

## Option 1: VYRANI Browser Virtual Camera Extension ($0, zero OS drivers — for web apps)

Works in Chrome, Edge, Brave, and Arc on **macOS** and **Windows**, for WhatsApp Web
(`web.whatsapp.com`), Google Meet (`meet.google.com`), Zoom Web (`*.zoom.us`), Discord Web
(`discord.com`), and Microsoft Teams Web (`teams.microsoft.com`, `teams.live.com`);
other sites are **not injected** by design (store-review policy and security).

### Security & transport architecture
- **Scoped host permissions** (no `<all_urls>`; see `extension/manifest.json`).
- **Origin-verified producer**: the service worker checks Chrome-verified `port.sender.url`
  against allowed VYRANI Studio origins and requires the `/app/studio` (or `/studio`) path
  before accepting any video/audio. Nothing else can publish into the camera.
- **Native WebRTC loopback**: intra-browser `RTCPeerConnection` (`addTrack` / `ontrack`)
  relays hardware-accelerated 30 fps video and Opus audio directly between the verified
  Studio tab and calling tabs — no base64-JPEG polling loop anymore.

### How to load
1. Download/extract `vyrani-virtual-camera-extension.zip` from **Studio → Virtual Cam**
   (or use the `extension/` folder in this repo).
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the extension folder.
3. Open **VYRANI Studio**, turn on **Virtual Camera**, press **Go Live**.
4. In WhatsApp Web / Meet / Zoom Web / Discord Web / Teams Web, pick
   **VYRANI AI Virtual Camera / VYRANI AI Virtual Microphone**.

### Chrome Web Store distribution
- Package the `extension/` folder, keep permissions scoped, ship clear store listing copy
  (screenshots, setup steps, privacy policy, and statement on which sites the extension
  operates).
- Google review focuses on minimal host permissions and honest permissions story — the
  current design is aligned with that; verify end-to-end calls before submitting.

---

## Option 2: Native desktop virtual camera source (`native-cam/`)

For native desktop apps beyond a browser's `getUserMedia`.

### Local frame bridge (`native-cam/bridge/vyra_cam_bridge.py`)
- Runs `python native-cam/bridge/vyra_cam_bridge.py` (or via `native-cam/windows/start-vyra-cam.ps1`),
  listening on `ws://127.0.0.1:29876/vyra-cam`.
- Rejects any HTTP/WebSocket request whose `Origin` isn't in `VYRA_CAM_ALLOWED_ORIGINS` /
  `PERSON_ALLOWED_ORIGINS` (403), supports a shared-secret token (`VYRA_CAM_TOKEN`, 401).
- Writes 1280×720 30 fps frames into `Local\VyraCamSharedMem` (Windows) or `/tmp/vyra_cam.shm` (macOS).

### Windows — two *separate* paths, both accurate
1. **DirectShow source filter** (`windows/VyraDirectShowCam.cpp`) — full COM/InprocServer32 +
   `IBaseFilter` push-source filter at 30 fps. Register per-user with `regsvr32` (no admin).
   Covers Chrome, Discord, legacy Zoom/OBS, most Win32 apps that use `ICreateDevEnum`.
2. **Media Foundation virtual camera** (`windows/mf-virtual-camera/`) — the *only* way to
   show up in Microsoft Store apps (Store WhatsApp Desktop, Windows Camera, Teams) and UWP
   hosts, because they enumerate through the Frame Server. Requires a real
   `IMFMediaSource` COM DLL plus `MFCreateVirtualCamera` on Windows 11 22000+, which must be
   built with MSVC + SDK 10.0.22000+. Read
   [windows/mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md](windows/mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md),
   then run `windows/mf-virtual-camera/build.cmd` on a Windows 11 dev machine with VS 2022.

### macOS — the only path Apple allows
CoreMediaIO **camera system extension**, not a DAL plugin. Apple's requirements (all
mandatory): extension lives in `Contents/Library/SystemExtensions` inside a Developer ID
-signed **and notarized** `.app` released to `/Applications`; extension is app-sandboxed;
primary app holds the system-extension install entitlement; user approves in System
Settings.

Two variants:
1. **Free Developer Preview (your own Macs):** `macos/dev-dmg/` builds a DMG with
   locally signed app + `sudo systemextensionsctl developer on` + launch script.
   Works on any macOS 12.3+ Mac without the paid account; re-run after each reboot.
2. **Customer distribution:** Apple Developer Program $99/yr, Developer ID + notarized
   DMG. Exact commands and reasons are in [macos/BUILD-SIGN-NOTARIZE.md](macos/BUILD-SIGN-NOTARIZE.md).

---

## Option 3: OBS Studio bridge ($0, signed by OBS — still the recommended native path today)

OBS Studio ships a **Developer ID-signed and notarized** Virtual Camera on both Windows and
macOS. That means every desktop app (WhatsApp Desktop-Store build, Zoom.exe, Teams, FaceTime
on Mac, browsers) can pick **OBS Virtual Camera** — with zero per-user signing cost for
VYRANI. Flow:

### Manual (works without any servers)
1. Start camera + look in VYRANI Studio, press **Go live**.
2. In Studio's Virtual Cam tab, click **Pop-out Clean Window** (chromeless window titled
   "VYRANI AI Camera Output" showing the composited output).
3. In OBS add a **Window Capture** source and select that window.
4. OBS → Start Virtual Camera. In the calling app pick **OBS Virtual Camera**.

### VYRANI Camera Commander (one click, local server mode)
When VYRANI runs as a local server (no hosted accounts, no `PERSON_API_TOKEN`), Studio's
Virtual Cam tab offers **"Create VYRANI scene & launch OBS"**: the server writes a
`VYRANI Camera` scene collection into the user's OBS config dir
(`%%APPDATA%%\obs-studio\basic\scenes` on Windows, `~/Library/Application
Support/obs-studio/basic/scenes` on macOS) and launches the user's installed OBS with
`--collection "VYRANI Camera" --startvirtualcam --minimize-to-tray --multi` (documented flags:
https://obsproject.com/kb/launch-parameters). If OBS cannot auto-match the pop-out window by
title, the user selects it once in OBS and OBS remembers.

Endpoints (require an authorized session, disabled when the server is hosted — the launcher
must never run on a server volume; `person_studio/obs_commander.py`):
- `GET /api/obs/status` — { installed, path, collection, window_title }
- `POST /api/obs/launch` `{ "window_title?" }` — writes the collection, spawns OBS.

### Licensing stance (deliberate)
OBS Studio is GPLv2 (or later). VYRANI does **not** bundle, embed, fork, or link OBS: the
Commander only writes config files into the user's own OBS directory and launches the
user's installed OBS by its documented CLI. That is the classic "separate program"
interaction (same pattern as the OBS remote-control/Stream Deck ecosystem) and keeps VYRANI's
own code outside the GPL's derivative-work provisions. If VYRANI ever ships an OBS fork
("VYRANI-powered runtime"), it must be license-compatible with GPLv2 and redistributed with
appropriate notices.

The declarative watermark stays because the pop-out displays the existing composite, so
likeness disclosure is preserved even when OBS is just re-encoding that window.

## Honest capability summary

| App type | Windows | macOS |
| --- | --- | --- |
| Browser (Chrome/Edge/Brave/Arc) on supported calling sites | ✅ now (extension) | ✅ now (extension) |
| Native desktop apps (WhatsApp Desktop, Zoom, Teams, Discord) | ✅ via **OBS's Virtual Camera** (Option 3) | ✅ via **OBS's Virtual Camera** (Option 3) |
| Microsoft Store / UWP camera apps (Store WhatsApp Desktop, Windows Camera) | ✅ via **OBS's Virtual Camera**, or ⏳ our own MF build (above) | n/a |
| FaceTime | n/a | ✅ via CMIO extension (Apple-demonstrated) — MF path above, or OBS on Mac also lists the camera in FaceTime

For **all apps on Windows** without our own MF build, OBS's virtual camera is the zero-cost
route today; the MF build removes the OBS dependency later. **All apps on macOS**: OBS works
while you test; keeping a VYRANI-branded (notarized) CMIO extension after it is the $99/yr
Apple program decision.
