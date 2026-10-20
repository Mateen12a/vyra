# VYRANI AI — Media Foundation Virtual Camera (Windows 11, real path)

This folder documents the **only** correct way to make "VYRANI AI Camera" appear in apps that
enumerate cameras through Media Foundation + the Windows Frame Server — Microsoft Store apps
(including WhatsApp Desktop from the Store), Windows Camera, Teams, and UWP hosts. The
DirectShow filter sitting next to this folder (`../VyraDirectShowCam.cpp`) does **not** reach
these apps; that separation is deliberate and documented.

Broad app compatibility was researched and verified from Microsoft's documentation; see
"References" below for every source.

---

## 1. What the API actually does (from Microsoft's own docs)

`MFCreateVirtualCamera` (Windows 11 build **22000+**, `mfvirtualcamera.h`, `mfsensorgroup.lib`):

```
MFCreateVirtualCamera(
    MFVirtualCameraType   type,          // ONLY value that exists: MFVirtualCameraType_SoftwareCameraSource
    MFVirtualCameraLifetime lifetime,    // Session | System
    MFVirtualCameraAccess    access,     // CurrentUser | AllUsers (AllUsers needs admin)
    LPCWSTR friendlyName,                // shown as "VYRANI AI Camera Windows Virtual Camera"
    LPCWSTR sourceId,                    // MUST be "{<CLSID>}" of a registered COM **IMFMediaSource**
    const GUID* categories,              // nullptr/0 → defaults KSCATEGORY_VIDEO_CAMERA, KSCATEGORY_VIDEO, KSCATEGORY_CAPTURE
    ULONG categoryCount,
    IMFVirtualCamera** virtualCamera);
```

Key facts that shaped the plan:

- `sourceId` must point to a **COM class exposing `IMFMediaSource`** (`IMFMediaSourceEx`,
  `IMFMediaEventGenerator`, `IMFGetService`, `IKsControl` + a stream object with
  `IMFMediaStream`/`IMFMediaStream2` and `IMFSampleAllocatorControl`). A DirectShow filter
  CLSID **cannot** be used; Frame Server will try to activate the class and it will fail.
  This is why the earlier attempt embedding `MFCreateVirtualCamera` inside the DirectShow
  DLL was removed — passing the DirectShow filter's CLSID as `sourceId` never worked.
- Windows dispenses (loads) the media source DLL inside the **Frame Server** services
  (`FrameServerMonitor` when registering, `FrameServer` when an app streams). The DLL and its
  dependencies must be readable by those services (machine-wide install, i.e. `HKLM\Software\Classes\CLSID\...\InprocServer32` + the DLL in `Program Files`).
- `activateType`: `CurrentUser` registers the camera for the calling user only;
  `AllUsers` requires administrator. The COM class registration itself still has to be
  machine-wide so the services can resolve it.
- Chrome tests show a correctly built software camera is streamable through the browser
  ImageCapture path; direct Store-app compatibility was **not** certified by Microsoft for any
  specific app — each target app needs real testing after build (WhatsApp Store, Zoom, Teams).
- OBS Studio, for reference, has *not* switched its Windows virtual camera to
  `MFCreateVirtualCamera` (it remains DirectShow-only as of 31.x) — so streaming this path
  successfully would be ahead of OBS's current Windows implementation.

## 2. Reference source to build on (do not reinvent)

VYRANI does not contain a hand-written from-scratch MF media source. Instead, adapt one of two
public, Apache-2.0 licensed reference implementations that already implement the whole COM
surface and call `MFCreateVirtualCamera`:

- **Microsoft's official sample** — `microsoft/Windows-Camera`, `Samples/VirtualCamera`
  (`SimpleMediaSource`, `SimpleMediaStream`, installer MSI, WinRT UI):
  https://github.com/microsoft/Windows-Camera/tree/master/Samples/VirtualCamera
- **Stefan Rousj's `VCamSample`** (independent, C++ only, MF-only):
  https://github.com/smourier/VCamSample

`build.cmd` in this folder clones one of these and builds it with MSVC once the Windows
Windows SDK 22000+ components are on the machine. Integration step:

1. Replace the reference's `SimpleFrameGenerator` NV12 test-pattern generator with
   **reading frames written by VYRANI's local bridge** (`../bridge/vyra_cam_bridge.py`), exposed at
   1280×720/30 fps from `Local\VyraCamSharedMem` (DShow path) **or** a named pipe
   `\\.\pipe\vyra_cam_frames` (which the bridge will add once the MF source is ready to consume
   it — see `bridge/` notes). Do **not** try to read the user-session mapping from inside
   Frame Server: the service runs in session 0 and cannot see `Local\` named objects without
   a matching `Global\`-namespace DACL; named pipes injected by the user are the reliable
   mtunnel.
2. Register the resulting CLSID machine-wide (`regsvr32 /s` in an elevated shell or an MSI).
3. `MFStartup()`, `MFCreateVirtualCamera(SoftwareCameraSource, <lifetime>, <access>,
   L"VYRANI AI Camera", L"{<your-source-CLSID>}", nullptr, 0, &vc)`, then `vc->Start(nullptr)`.
4. Keep the returned much pointer alive for the Session lifetime, or use
   `MFVirtualCameraLifetime_System` for persistence (the scene survives reboot; `Remove()`
   unregisters).

## 3. Why this is not already compiled here

Building requires:
- Visual Studio 2019/2022 with "Desktop development with C++" workload (MSVC v14x).
- Windows SDK **10.0.22000.0 or newer** (`mfvirtualcamera.h` first appears in 10.0.22000.0;
  the machine used to prepare this repo has only 10.0.19041.0 headers and no MSVC).
- Windows 11 build 22000+ to run/register the camera (Media Foundation frame server only
  accepts this API there).

None of that exists in the build environment that prepared this repo, which is why this
directory ships **build instructions + a reproducible build script + integration notes**
instead of unverified C++ shipped as if it worked. Registering a camera that Windows can
enumerate but then fails to activate is *worse* than not registering it at all — the camera
appears in every app and then shows a black/failing preview.

## 4. After building — checklist on a real Windows 11 machine

1. `regsvr32 /s <built DLL>` (admin, machine-wide CLSID).
2. Start the host → camera appears as "VYRANI AI Camera Windows Virtual Camera" **without** app restart? (Store apps cache the camera list — restart them.)
3. Windows Settings → Bluetooth & devices → Cameras page lists it.
4. Windows Camera app: preview renders the test/NV12 frames.
5. WhatsApp Desktop (Store build), Zoom desktop, Teams desktop, Discord desktop, OBS:
   camera picker lists it and streams at 30 fps. Several of these (notably Store WhatsApp)
   skip cameras that are not registered with the Frame Server — record the result per app.
6. Chrome: `navigator.mediaDevices.getUserMedia({video:{deviceId:…}})` streams it; Playwright
   harness across Chromium versions, then scrub to record.
7. Frame injection from VYRANI Studio: confirm frames produced by `vyra_cam_bridge.py` appear
   inside a YouTube/WhatsApp preview end-to-end.

## 5. References

- MFCreateVirtualCamera signatures + rules —
  https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera
- MFVirtualCameraType / Lifetime / Access enums —
  https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/ne-mfvirtualcamera-mfvirtualcameratype
  https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/ne-mfvirtualcamera-mfvirtualcameralifetime
  https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/ne-mfvirtualcamera-mfvirtualcameraaccess
- IMFVirtualCamera (Start/Stop/Remove/Lifetime semantics) —
  https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nn-mfvirtualcamera-imfvirtualcamera
- Frame Server custom media source guidelines (session 0, MFT/$COM surface, YUY2 advice) —
  https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/frame-server-custom-media-source
- Microsoft sample README (installer + registration + browser test) —
  https://github.com/microsoft/Windows-Camera/blob/master/Samples/VirtualCamera/README.md
- SimpleMediaSource / SimpleMediaStream —
  https://github.com/microsoft/Windows-Camera/tree/master/Samples/VirtualCamera/VirtualCameraMediaSource
- Independent C++ sample — https://github.com/smourier/VCamSample
- OBS still DirectShow-only on Windows —
  https://github.com/obsproject/obs-studio/issues/8057
  https://github.com/obsproject/obs-studio/issues/13439
- Historical note: Store WhatsApp Desktop historically did **not** list OBS's old DirectShow
  virtual camera (it is not a Frame Server camera) —
  https://obsproject.com/forum/threads/new-whatsapp-desktop-application-does-not-work-with-obs-virtual-camera.140414/
