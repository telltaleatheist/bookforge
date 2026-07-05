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
# Usage: plug the phone in, unlock it, then:  npm run package:ios
#        (or run this directly:  ./package-ios.sh)
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

# Auto-detect the single connected iPhone/iPad — plug in ONE device before running.
# xctrace lists physical devices (online + offline) before the "== Simulators =="
# section. A real device line is "Name (iOS ver) (UDID)" — two parenthesized
# groups — whereas this Mac has only one group and simulators live in the later
# section. So: take everything up to Simulators, keep the line with a version +
# UDID, and pull the UDID.
DEV_LINE="$(xcrun xctrace list devices 2>/dev/null \
  | sed -n '1,/== Simulators ==/p' \
  | grep -E '\([0-9]+\.[0-9.]+\) \([0-9A-Fa-f-]{20,}\)' \
  | head -1)"
DEVICE_UDID="$(printf '%s' "$DEV_LINE" | grep -oE '\([0-9A-Fa-f-]{20,}\)$' | tr -d '()')"
DEVICE_NAME="$(printf '%s' "$DEV_LINE" | sed -E 's/ \([0-9].*//')"
if [ -z "$DEVICE_UDID" ]; then
  echo "ERROR: no connected iPhone/iPad found. Plug ONE in (unlocked + trusted) and retry." >&2
  exit 1
fi
echo "Device: ${DEVICE_NAME:-?} ($DEVICE_UDID)"

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
