#!/bin/bash
#
# BookForge — full uninstall for macOS.
#
# macOS BookForge is a drag-install (.dmg), so there's no system uninstaller.
# This removes the app and ALL of BookForge's downloaded data — the unpacked
# audiobook engine, voice & AI models, Stanza language packs, GPU components,
# caches, logs, and settings (several GB).
#
# It deliberately KEEPS your audiobook library (~/Documents/BookForge) — your
# imported books, projects, and finished audiobooks are your own files, not ours.
#
# Double-click this file in Finder, or run it from Terminal.

set -u

# Electron's userData uses the package name ("bookforge-app"), not the product
# name; the file logger uses "BookForgeApp". The .app bundle is "BookForge".
APP="/Applications/BookForge.app"
SUPPORT="$HOME/Library/Application Support/bookforge-app"
CACHE1="$HOME/Library/Caches/bookforge-app"
CACHE2="$HOME/Library/Caches/com.bookforge.app"
PREFS="$HOME/Library/Preferences/com.bookforge.app.plist"
STATE="$HOME/Library/Saved Application State/com.bookforge.app.savedState"
LOGS="$HOME/Library/Logs/BookForgeApp"
LIBRARY="$HOME/Documents/BookForge"

TARGETS=("$APP" "$SUPPORT" "$CACHE1" "$CACHE2" "$PREFS" "$STATE" "$LOGS")

echo "BookForge uninstaller"
echo "====================="
echo
echo "This will remove BookForge and everything it downloaded:"
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then echo "  • $t"; fi
done
echo
if [ -d "$LIBRARY" ]; then
  echo "Your audiobook LIBRARY will be KEPT (your own books):"
  echo "  ✓ $LIBRARY"
  echo
fi
read -r -p "Remove everything listed above? [y/N] " reply
case "$reply" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "Cancelled. Nothing was removed."; exit 0 ;;
esac

# Quit any running instance first so files aren't locked.
osascript -e 'quit app "BookForge"' >/dev/null 2>&1 || true
sleep 1
pkill -f "BookForge.app/Contents/MacOS/BookForge" >/dev/null 2>&1 || true

removed=0
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    rm -rf "$t" && { echo "Removed: $t"; removed=$((removed+1)); } || echo "Could not remove: $t"
  fi
done

echo
echo "Done — removed $removed item(s)."
if [ -d "$LIBRARY" ]; then
  echo "Kept your library: $LIBRARY"
fi
