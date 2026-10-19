#!/usr/bin/env bash
# install-dev-preview.sh — free (no Apple Developer Program) installer on a Mac.
# Run from the DMG after dragging VyraCameraApp.app to /Applications:
#
#   sudo ./install-dev-preview.sh
#
# What it does:
#   1. clears the download quarantine on the copied app (Gatekeeper),
#   2. turns on system-extension developer mode (required every session; xattr
#      clearing alone does NOT install system extensions),
#   3. launches the app, which submits OSSystemExtensionRequest,
#   4. points the user to the approval UI in System Settings.

set -euo pipefail

APP_SRC="$(cd "$(dirname "$0")" && pwd)/VyraCameraApp.app"
APP_DST="/Applications/VyraCameraApp.app"

if [ ! -d "$APP_SRC" ]; then
  echo "VyraCameraApp.app not found next to this script. Drag the app into /Applications first." >&2
  exit 1
fi

if [ ! -d "$APP_DST" ]; then
  cp -R "$APP_SRC" "$APP_DST"
  echo "Copied VyraCameraApp.app to /Applications."
else
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" "$APP_DST"
  echo "Replaced /Applications/VyraCameraApp.app with this DMG's copy."
fi

echo "[1/3] Clearing quarantine so macOS 15/26 Gatekeeper 'Open Anyway' isn't needed..."
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true

echo "[2/3] Enabling system-extension developer mode (resets after reboot)..."
systemextensionsctl developer on

echo "[3/3] Launching VYRA AI Camera to submit the extension install..."
open "$APP_DST"
echo
echo "Next: approve the prompt. Camera pickers will now show 'VYRA AI Camera'."
echo "Reminder: after a reboot, re-run:  sudo systemextensionsctl developer on && open /Applications/VyraCameraApp.app"
