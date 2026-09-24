#!/usr/bin/env bash
#
# SWAP A VERIFIED STAGING BUILD INTO foundry-app/dist — and refuse if it is not
# one, or if BookForge is up.
#
# BookForge hosts Foundry in its own main process: main loads
# `foundry-app/dist/electron/mount.js` at startup and the hosted window loads
# `foundry-app/dist/renderer/browser/index.html`. `dist/` is gitignored, so a
# half-built or half-swapped copy leaves a CLEAN `git status` and says nothing
# until the window dies in front of somebody.
#
# That is not hypothetical. On 2026-09-20 a stage build shared
# `foundry-app/node_modules` (and its `.angular` cache) with another agent's
# build, the renderer step never landed, and the grep that "verified" the swap
# only ever looked at `dist/electron/*.js`. The swap shipped `dist/{electron,
# shared}` with no renderer at all and the hosted Foundry window came up
# `ERR_FILE_NOT_FOUND …/dist/renderer/browser/index.html`. Owen: "the whole
# system is broken."
#
# So this script exists to be the one door, and it refuses on any of:
#
#   1. the staging `dist/electron/mount.js` is missing            — no electron half
#   2. the staging `dist/renderer/browser/index.html` is missing  — no renderer half
#   3. the staging electron build does not contain the symbol you name with
#      --expect (default: none; pass what only the NEW sources contain)
#   4. BookForge is running — the electron half CANNOT be swapped under a live
#      app, and a running main already holds the old mount.js
#   5. the vendored engine (foundry-app/engine/foundry-engine.cjs) is missing —
#      the dist would swap in fine and every Foundry job would then fail
#
# Usage:
#   tools/swap-foundry-dist.sh .foundry-stage-<sha> [--expect <symbol>]
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="${1:-}"
expect=""

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) expect="${2:-}"; shift 2 ;;
    *) echo "swap-foundry-dist: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$stage" ]; then
  echo "usage: tools/swap-foundry-dist.sh <staging dir> [--expect <symbol>]" >&2
  exit 2
fi
case "$stage" in
  /*) ;;
  *) stage="$repo/$stage" ;;
esac

fail() { echo "swap-foundry-dist: REFUSED — $1" >&2; exit 1; }

# ── 1 and 2: both halves, by name ───────────────────────────────────────────
electron_main="$stage/dist/electron/mount.js"
renderer_index="$stage/dist/renderer/browser/index.html"
[ -f "$electron_main" ] || fail "no electron half: $electron_main does not exist"
[ -f "$renderer_index" ] || fail "no renderer half: $renderer_index does not exist (the 2026-09-20 trap)"

# ── 3: the built dist, not the sources, carries the new code ────────────────
# The stale-dist trap has been paid for twice: correct sources beside a dist
# compiled from older ones. Grep the BUILT file for something only the new
# sources contain.
if [ -n "$expect" ]; then
  hits="$(grep -rc -- "$expect" "$stage/dist/electron/" 2>/dev/null | awk -F: '{ n += $2 } END { print n + 0 }')"
  [ "$hits" -gt 0 ] || fail "the built electron dist does not contain '$expect' — it was compiled from older sources"
  echo "swap-foundry-dist: '$expect' appears $hits time(s) in the staged electron dist"
fi

# ── 4: BookForge must be down ───────────────────────────────────────────────
# The main process runs as `Electron .` out of THIS repo's node_modules and
# carries no --user-data-dir of its own; its helpers carry
# --user-data-dir=…/BookForge. Either is proof the app is up.
if pgrep -f "$repo/node_modules/electron/dist/Electron.app" >/dev/null 2>&1 \
  || pgrep -f -- "--user-data-dir=.*BookForge" >/dev/null 2>&1; then
  fail "BookForge is RUNNING — the electron half cannot be swapped under a live app. Quit it and run this again."
fi

# ── 5: the engine the dist will run is here ─────────────────────────────────
# The ENGINE is not in the stage — it is vendored source, foundry-app/engine/,
# committed with the rest of the copy (Foundry's tools/build-engine.mjs writes
# it). A dist whose engine.js looks for it and finds nothing would fail every
# Foundry job, so its absence is named here too.
engine_bundle="$repo/foundry-app/engine/foundry-engine.cjs"
[ -f "$engine_bundle" ] || fail "$engine_bundle is missing — re-vendor foundry-app (VENDORED.md)"
echo "swap-foundry-dist: engine present ($engine_bundle)"

# ── the swap ────────────────────────────────────────────────────────────────
target="$repo/foundry-app/dist"
rm -rf "$target"
cp -R "$stage/dist" "$target"

# And say what landed, in the same terms the checks were written in.
[ -f "$target/electron/mount.js" ] || fail "post-swap: $target/electron/mount.js is missing"
[ -f "$target/renderer/browser/index.html" ] || fail "post-swap: $target/renderer/browser/index.html is missing"
echo "swap-foundry-dist: swapped $stage/dist -> $target (electron + renderer both present)"

