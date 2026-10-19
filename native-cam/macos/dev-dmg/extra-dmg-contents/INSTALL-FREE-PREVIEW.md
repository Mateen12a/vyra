# VYRA AI Camera — Developer Preview (free, no Apple Developer Program)

This DMG installs a **working developer preview** of the VYRA AI virtual camera using
macOS's system-extension developer mode, so you can test the CMIO camera extension on your
own Macs without paying the $99/year Apple Developer Program. Be honest with yourself
about what you accept:

## What works free
- The CMIO camera extension is real, and shows up in FaceTime/Zoom/WhatsApp/Web browsers
  on the Mac where you install it, as long as `systemextensionsctl developer on` is active.
  Apple's own walkthrough and the SimCam open-source project document the flow
  ([SimCam no-account runbook](https://github.com/CarGuo/iOS-Simulator-Camera-Extend/blob/main/docs/no-developer-account.md)).

## What does NOT work free (why the paid program exists)
1. **Developer mode resets after every reboot.** Users must re-run
   `sudo systemextensionsctl developer on` (admin, terminal) each session; otherwise the
   camera extension disappears.
2. **Not customer-installable.** Without Developer ID signing + notarization there is no
   supported Gatekeeper bypass for strangers; "Open Anyway" and `xattr -dr
   com.apple.quarantine` are workarounds for a specific app, and Apple does not document
   them as user-facing API.
3. **Rebuild TCC drift.** With ad-hoc signing (`codesign -s -`), the camera/microphone
   permission identity changes on every rebuild — reset Camera permission in System
   Settings once per rebuild. Fix: set `VYRA_MAC_SIGN_ID` to a locally-generated
   "Code Signing" certificate in Keychain Access.
4. **Possible SIP nuance** on some macOS versions — the SimCam project applies
   `csrutil enable --without kext --without debug` in Recovery once; do **not** fully
   disable SIP.

## Install (on the Mac receiving the DMG)
```bash
sudo ./install-dev-preview.sh        # from the DMG mount root
```
Then approve the system-extension prompt in System Settings → General → Login Items &
Extensions (macOS 15: "Camera Extensions") and select "VYRA AI Camera" in your calling app.

## When you ship to real users
Distribute via **Developer ID signing + notarization** ($99/year Apple Developer Program)
per ../BUILD-SIGN-NOTARIZE.md — that's the $99 the free path saves you, Apple's gate for
activation-time notarized system extensions on customer Macs.
