#!/usr/bin/env bash
#
# build-dev-preview-dmg.sh — builds the VYRA AI Camera "Developer Preview" DMG on a Mac,
# WITHOUT an Apple Developer Program account / Developer ID / notarization.
#
# This produces a Mac-side installer that works the same way open-source camera
# extensions (e.g., SimCam, Camo dev builds) activate: per-machine `sudo
# systemextensionsctl developer on`, /Applications placement, and manual System
# Settings approval. It is NOT a consumer-distribution DMG; see
# ../BUILD-SIGN-NOTARIZE.md for the $99/yr Developer ID + notarized path and the
# differences that gatekeeper enforces for normal users.
#
# Requirements on the Mac running this:
#   - macOS 12.3+ (camera extension API; test 13/14/15 as far as you can), uarch any.
#   - Xcode Command Line Tools:  xcode-select --install
#     (we compile with `swiftc` directly; no Xcode project needed).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../"
NAME="VyraCameraApp"
EXT_ID="ai.vyra.camera.extension"
APP_ID="ai.vyra.camera.app"
GROUP_ID="ai.vyra.camera"
BUILD="$HERE/build"
APP="$BUILD/$NAME.app"

rm -rf "$BUILD"
mkdir -p "$BUILD"
trap 'echo "[build] failed; check output above" >&2' ERR

SDK="$(xcrun --show-sdk-path)"
UNAME_ARCH="$(uname -m)"
TARGET="${UNAME_ARCH}-apple-macos12.3"

if [ "$UNAME_ARCH" = "arm64" ]; then
  EXT_ARCH_FLAGS=()
  APP_ARCH_FLAGS=()
else
  # Intel Mac — same target, no special flags needed.
  EXT_ARCH_FLAGS=()
  APP_ARCH_FLAGS=()
fi

# ---------------------------------------------------------------------------
# 1. Camera system-extension binary (the CMIOExtensionProvider source classes).
# ---------------------------------------------------------------------------
EXT="$APP/Contents/Library/SystemExtensions/com.$EXT_ID.systemextension"
mkdir -p "$EXT/Contents/MacOS" "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "[1/5] Compiling camera extension..."
swiftc -O -sdk "$SDK" -target "$TARGET" \
    "$SRC/VyraCameraExtensionProvider.swift" "$SRC/VyraExtensionProvider.swift" \
    -o "$EXT/Contents/MacOS/VyraCameraExtension" "${EXT_ARCH_FLAGS[@]}"

cat > "$EXT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.$EXT_ID</string>
    <key>CFBundleExecutable</key>
    <string>VyraCameraExtension</string>
    <key>CFBundleName</key>
    <string>VYRA Camera Extension</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0-dev</string>
    <key>CMIOExtension</key>
    <dict>
        <key>CMIOExtensionMachServiceName</key>
        <string>ai.vyra.camera.extension</string>
    </dict>
    <key>LSMinimumSystemVersion</key>
    <string>12.3</string>
</dict>
</plist>
PLIST

# Sandboxed camera extension + shared App Group with the containing app so the
# extension can read frames produced by the VYRA bridge in the user session.
cat > "$EXT/Contents/vyra-extension-entitlements.plist" <<EENTS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.application-groups</key>
    <array><string>group.$GROUP_ID</string></array>
    <key>com.apple.security.device.camera</key><true/>
</dict>
</plist>
EENTS

# ---------------------------------------------------------------------------
# 2. Containing .app — thin launcher. It calls OSSystemExtensionRequest at launch.
#    (Entry point: minimal Swift driver compiled into the app's binary.)
# ---------------------------------------------------------------------------
echo "[2/5] Compiling containing app..."
cat > "$BUILD/AppMain.swift" <<'SWIFT'
import Foundation
import AppKit
import OSSystemExtension

// Entry point per Apple's documentation: activate the camera system extension via
// OSSystemExtensionRequestDelegate. Validate delegate signatures against
// https://developer.apple.com/documentation/systemextensions/ossystemextensionrequestdelegate
// during the first Mac-side build (this script cannot be Swift-compiled on Windows).
final class VyraExtensionInstaller: NSObject, OSSystemExtensionRequestDelegate {
    func activate() {
        let request = OSSystemExtensionRequest.activationRequest(
            extensionBundleIdentifier: "com.ai.vyra.camera.extension",
            queue: .main,
            delegate: self)
        OSSystemExtensionClient.shared.submit(request)
    }

    func request(_ request: OSSystemExtensionRequest,
                 didFinishWithResult result: OSSystemExtensionRequest.Result) {
        print("VYRA camera extension result: \(result)")
        if result == .complete { exit(0) }
        exit(1)
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        fputs("Install failed: \(error)\n", stderr)
        exit(2)
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        print("Approve this extension via System Settings → General → Login Items & Extensions.")
    }

    func request(_ request: OSSystemExtensionRequest,
                 foundExtension existing: OSSystemExtensionProperties,
                 replacementOf existing: OSSystemExtensionProperties) -> OSSystemExtensionReplacementAction {
        .replace
    }
}

// Entry point: submit the activation request; approval UI is handled by macOS.
let installer = VyraExtensionInstaller()
installer.activate()
RunLoop.main.run()  // keep alive while the request completes asynchronously
SWIFT

swiftc -O -sdk "$SDK" -target "$TARGET" "$BUILD/AppMain.swift" \
    -o "$APP/Contents/MacOS/$NAME" "${APP_ARCH_FLAGS[@]}"

cat > "$APP/Contents/Info.plist" <<APPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.$APP_ID</string>
    <key>CFBundleExecutable</key>
    <string>$NAME</string>
    <key>CFBundleName</key>
    <string>VYRA AI Camera</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0-dev</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.3</string>
</dict>
</plist>
APPLIST

# Entitlement the HOST app needs to activate a system extension at all.
cat > "$APP/Contents/vyra-app-entitlements.plist" <<AENTS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.system-extension.install</key><true/>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.application-groups</key>
    <array><string>group.$GROUP_ID</string></array>
</dict>
</plist>
AENTS

# ---------------------------------------------------------------------------
# 3. Sign. Preferred: locally-generated self-signed Code Signing certificate in
#    your keychain (stable identity → stable TCC permissions across rebuilds).
#    Fallback: ad-hoc (-) — simpler; TCC camera permission may need re-granting
#    after every rebuild, documented cost for previews only.
# ---------------------------------------------------------------------------
SIGN_ID="${VYRA_MAC_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
  echo "[3/5] Using ad-hoc signing (set VYRA_MAC_SIGN_ID=... to use a local self-signed cert)."
  SIGN_ID="-"
fi
echo "[3/5] codesign with identity: $SIGN_ID"
codesign --force --options runtime \
    --entitlements "$EXT/Contents/vyra-extension-entitlements.plist" \
    -s "$SIGN_ID" "$EXT"
codesign --force --options runtime \
    --entitlements "$APP/Contents/vyra-app-entitlements.plist" \
    -s "$SIGN_ID" "$APP" --deep
codesign --verify --deep --strict "$APP"

# ---------------------------------------------------------------------------
# 4. DMG.
# ---------------------------------------------------------------------------
echo "[4/5] Packaging DMG..."
staging="$BUILD/extra-dmg"
rm -rf "$staging"
mkdir -p "$staging"
cp -R "$APP" "$staging/"
cp -R "$HERE/extra-dmg-contents/." "$staging/"
hdiutil create -volname "VYRA AI Camera (Developer Preview)" \
    -srcfolder "$staging" \
    -format UDZO -o "$BUILD/VYRA-Camera-Developer-Preview.dmg"

echo "[5/5] Done: $BUILD/VYRA-Camera-Developer-Preview.dmg"
echo
echo "Install (free path) on the target Mac:"
echo "  1. Double-click the DMG, drag VyraCameraApp.app to /Applications."
echo "  2. sudo systemextensionsctl developer on   (admin, terminal)"
echo "  3. open /Applications/VyraCameraApp.app"
echo "  4. Approve the extension prompt, then check Simple/Meet camera pickers."
echo "  5. Re-run step 2 after reboot if the camera disappears (dev mode resets)."
