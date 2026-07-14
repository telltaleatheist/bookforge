#!/usr/bin/env bash
#
# Reinstall the Bookshelf app onto the iPhone ("blip").
#
# telltaleatheist@gmail.com is now on the PAID Apple Developer Program, so signed
# builds are good for ~1 YEAR (not the old 7-day free-team window). Re-run this
# whenever you want to push new code to the phone. Prereqs are all one-time and
# already done:
#   - telltaleatheist@gmail.com added to Xcode → Settings → Accounts
#   - the developer profile trusted once on the phone
#   - Developer Mode enabled on the phone
#
# Usage: plug the phone in, unlock it, then:  npm run package:ios
#        (or run this directly:  ./package-ios.sh)
#
set -euo pipefail

TEAM="N7V7AT6CZ9"                       # telltaleatheist@gmail.com (paid Apple Developer Program — 1-yr signing)
BUNDLE_ID="com.owenmorgan.bookshelf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PROJ="$SCRIPT_DIR/ios/App/App.xcodeproj"

# Node 22+ is required by the Capacitor CLI; load it from nvm if present.
if command -v nvm >/dev/null 2>&1 || [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
echo "Node: $(node -v)"

# Auto-detect the connected iPhone — plug in ONE device before running.
# xctrace lists every paired device (iPhone, Apple Watch, this Mac), in any order and
# sometimes under "== Devices Offline ==". Match ONLY a modern iPhone UDID (8 hex,
# dash, 16 hex) and skip watch/simulator lines: the Watch uses a 40-char id and the
# Mac a standard 8-4-4-4-12 UUID, so neither matches. (A blind `head -1` here used to
# grab "Blaine's Apple Watch" and hand xcodebuild a destination it couldn't find,
# silently failing every deploy.)
DEVICE_UDID="$(xcrun xctrace list devices 2>/dev/null \
  | grep -viE 'watch|simulator' \
  | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}' \
  | head -1)"
if [ -z "$DEVICE_UDID" ]; then
  echo "ERROR: no connected iPhone found. Plug ONE in (unlocked + trusted) and retry." >&2
  exit 1
fi
DEVICE_NAME="$(xcrun xctrace list devices 2>/dev/null | grep -F "$DEVICE_UDID" | sed -E 's/ \([0-9].*//' | head -1)"
echo "Device: ${DEVICE_NAME:-iPhone} ($DEVICE_UDID)"

echo "==> Building web assets + Capacitor sync"
cd "$SCRIPT_DIR"
npm run sync

echo "==> Building iOS app (Debug, signed for $TEAM)"
xcodebuild \
  -project "$APP_PROJ" \
  -scheme App \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  build

APP_PATH="$(xcodebuild -project "$APP_PROJ" -scheme App -configuration Debug \
  -showBuildSettings 2>/dev/null | awk -F'= ' '/ CODESIGNING_FOLDER_PATH =/{print $2; exit}')"
echo "==> Installing $APP_PATH"
xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_PATH"

echo "==> Launching"
xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" || \
  echo "(If launch was denied, just tap the Bookshelf icon on the phone.)"

echo "Done. This build is good for ~1 year (paid Apple Developer Program)."
