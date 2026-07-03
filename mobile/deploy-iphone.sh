#!/usr/bin/env bash
#
# Reinstall the Bookshelf app onto the iPhone ("blip").
#
# Free personal-team builds expire after 7 days, so re-run this whenever the
# app refuses to launch. Prereqs are all one-time and already done:
#   - telltaleatheist@gmail.com added to Xcode → Settings → Accounts
#   - the developer profile trusted once on the phone
#   - Developer Mode enabled on the phone
#
# Usage: plug the phone in, unlock it, then:  ./deploy-iphone.sh
#
set -euo pipefail

TEAM="N7V7AT6CZ9"                       # telltaleatheist@gmail.com (Telltale Atheist)
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

# Find the connected phone by name ("blip"); fall back to the known UDID.
DEVICE_UDID="$(xcrun xctrace list devices 2>/dev/null \
  | grep -iE '^blip ' | grep -oE '\(([0-9A-F-]{25,})\)$' | tr -d '()' | head -1 || true)"
DEVICE_UDID="${DEVICE_UDID:-00008130-00082C4134C0001C}"
echo "Device: $DEVICE_UDID"

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

echo "Done. This build is good for ~7 days."
