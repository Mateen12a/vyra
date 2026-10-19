# VYRA AI Camera on macOS — Build, Sign, Notarize (CoreMediaIO Camera Extension)

Apple's supported way to put "VYRA AI Camera" into the camera pickers of **all** macOS apps —
including **FaceTime**, WhatsApp Desktop, Zoom desktop, Teams desktop, Photo Booth and
browsers — is a **Core Media I/O camera System Extension** (macOS 12.3+). Apple demonstrated
this exact flow working in FaceTime in the WWDC22 camera session. The legacy DAL plug-in
route is deprecated since macOS 12.3: DAL code loads into camera-client processes, fails
with library validation, does not work in FaceTime, and Sonoma can gate it behind a legacy
support switch. So: no DAL fallback for VYRA.

## Non-negotiable Apple requirements (verified against Apple's guides)

1. **Bundle container** — the extension cannot ship as a loose `.swift` file or CLI binary.
   It must be produced by an Xcode "Camera Extension" target embedded in a containing
   `.app` at `Contents/Library/SystemExtensions/`, and **the app must live in `/Applications`**.
2. **Sandboxing** — the camera extension must be app-sandboxed or macOS refuses to run it.
3. **Info.plist key** — the extension declares `CMIOExtensionMachServiceName` inside the
   `CMIOExtension` dict (see [Info.plist](Info.plist)); Core Media I/O's registration service
   needs that Mach service name to launch the extension.
4. **Install entitlement** — the *containing app* needs the system-extension install
   entitlement (`com.apple.developer.system-extension.install` in the common template), and
   requests installation at runtime via the `SystemExtensions` API; the user approves in
   System Settings → General → Login Items & Extensions.
5. **Signed + notarized** — Developer ID signing with hardened runtime plus notarization is
   required for distributing outside your own machine. Developer ID certificates require
   membership in the **Apple Developer Program (US$99/year)**. Self-signed/ad-hoc signing is
   a development-only path, not a distribution path.

## Dev-mode local testing (free, but never for users)

```bash
sudo systemextensionsctl developer on
# Reboot; then build & run the containing app from Xcode (or a locally-signed app).
# The extension installs without Developer ID in this mode only.
```

## Production pipeline

```bash
# 1. Archive & sign the containing app with Developer ID
xcodebuild -project VyraCamera.xcodeproj -scheme VyraCameraApp \
           -configuration Release -archivePath build/VyraCameraApp.xcarchive archive
codesign --sign "Developer ID Application: <YOU> (TEAMID)" \
         --options runtime --timestamp \
         build/VyraCameraApp.xcarchive/Products/Applications/VyraCameraApp.app

# 2. Notarize (App Store Connect API key) and staple
xcrun notarytool submit build/VyraCameraApp.app.zip --keychain-profile "AC_PROFILE" --wait
xcrun stapler staple build/VyraCameraApp.app
```

Deliver the stapled `.app` (or `.dmg`) — not a zip of source files. The user drags it to
`/Applications`, opens it once; it calls `OSSystemExtensionRequest` to install the camera
extension; the user approves it in System Settings. After that, "VYRA AI Camera" appears in
FaceTime/Zoom/WhatsApp/Chrome camera pickers.

## Free alternative — "Developer Preview" DMG (no Apple Developer Program)

If you only need a working camera on **your own Macs** for now, `dev-dmg/` builds a DMG
that uses `systemextensionsctl developer on` + locally self-signed/ad-hoc signing instead
of Developer ID + notarization:

- Build: `dev-dmg/build-dev-preview-dmg.sh` (on any macOS 12.3+ Mac with Xcode CLT).
- Install: run `install-dev-preview.sh` from the DMG (`sudo`), approve the prompt.
- Trade-offs that remain: developer mode resets every reboot (re-run the script), no
  supported path to distribute to strangers' Macs without notarization, ad-hoc rebuilds
  change TCC permission identities (use a local self-signed cert to stabilize).
- Verified real-world reference: SimCam's documented no-account camera-extension runbook —
  https://github.com/CarGuo/iOS-Simulator-Camera-Extend/blob/main/docs/no-developer-account.md

**Alternative without building anything at all:** OBS Studio's Virtual Camera is
Developer ID-signed and notarized by the OBS project. VYRA Studio → Virtual Cam tab →
"Pop-out Clean Window" → OBS Window Capture → Start Virtual Camera. Works in FaceTime,
Zoom, WhatsApp, browsers on macOS (and Windows) for free; details in ../README.md
("Option 3: OBS Studio bridge").

Nothing here skips the obligation for *customer* distribution: Apple requires Developer ID
+ notarization (or the Mac App Store) for shipping system extensions to users, per
https://developer.apple.com/documentation/systemextensions.

## Frame feed inside the sandbox

- The extension is sandboxed and **cannot read `/tmp`**. The documented dev fallback in
  [VyraCameraExtensionProvider.swift](VyraCameraExtensionProvider.swift) (`/tmp/vyra_cam.shm`)
  only works while the extension runs unsandboxed in developer mode.
- Production: the desktop helper running VYRA Studio's camera bridge writes frames through the
  shared **App Group container** (`group.ai.vyra.camera`), e.g.
  `~/Library/Group Containers/group.ai.vyra.camera/vyra_cam.shm`, and the extension reads it
  with `containerURL(forSecurityApplicationGroupIdentifier:)`. The App Group must be
  assigned to both targets in the App ID & provisioning profile.

## References

- Apple: Creating a camera extension with Core Media I/O —
  https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o
- Apple WWDC22 session 10022 (Create camera extensions with Core Media I/O) —
  https://developer.apple.com/videos/play/wwdc2022/10022/  (demonstrates FaceTime + Photo Booth
  with a software camera)
- `CMIOExtensionProviderSource` / `CMIOExtensionDevice` / `CMIOExtensionStream` API —
  https://developer.apple.com/documentation/coremediaio
- System Extensions (install API, approval UI) —
  https://developer.apple.com/documentation/systemextensions
- Developer ID certificates / notarization —
  https://developer.apple.com/developer-id/
  https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
  https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Apple Developer Program enrollment fee ($99/yr) —
  https://developer.apple.com/help/account/membership/program-enrollment/
- Apple legacy camera/video support notice (Sonoma) —
  https://support.apple.com/en-us/108387
- OBS migrated off DAL to a CMIO extension on macOS 13+ (confirms the API's practical reach) —
  https://github.com/obsproject/obs-studio/issues/9692
