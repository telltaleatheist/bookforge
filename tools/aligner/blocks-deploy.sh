#!/bin/bash
# blocks-deploy — publish a blocks model and put it on every machine that runs it.
#
#   ./blocks-deploy.sh <version-tag> <merged-dir-or-f16-gguf> [quant] [win-host]
#   ./blocks-deploy.sh v4-4b ~/blocks-export/blocks-v4-f16-f16.gguf Q8_0
#
# blocks-publish.sh gets the artifact onto HuggingFace, which is what END USERS
# install from. This adds the two machines that develop on it: they would
# otherwise re-download a multi-GB file they already have sitting in
# ~/blocks-export, and the Windows box in particular is the one where "did you
# test it on Windows?" keeps coming up.
#
#   1..5  everything blocks-publish.sh does (convert, quantize, load-check,
#         upload, print the catalog entry)
#   6     install into this Mac's shared model dir
#   7     copy to the Windows box's shared model dir over ssh
#   8     verify sha256 on BOTH ends against the local file
#
# Step 8 is not ceremony. A truncated scp or a half-synced file is
# indistinguishable from a bad quantize once llama-server refuses it, and the error
# it prints talks about the file format — which sends you looking at the model
# instead of the copy. isBlocksModelPresent() size-checks for the same reason.
#
# The catalog entry stays MANUAL, exactly as blocks-publish.sh argues: the sha256
# and byte count are what make a user's download verifiable, and a script that
# wrote them itself could quietly republish a model nobody evaluated.
#
# NOT a GPU job. Quantizing and copying are CPU and network; the load check runs
# a few seconds on whatever this Mac has. Safe to run while a training box is busy.

set -euo pipefail

TAG="${1:?usage: blocks-deploy.sh <version-tag> <merged-dir-or-f16-gguf> [quant] [win-host]}"
SRC="${2:?a merged model dir or an f16 .gguf}"
QUANT="${3:-Q4_K_M}"
WIN_HOST="${4:-owens-pc}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${BLOCKS_WORK:-$HOME/blocks-export}"

# Mirrors electron/shared-paths.ts. Kept as literals rather than shelling out to
# the app: this script has to work before a build exists.
MAC_DIR="$HOME/Library/Application Support/OwenMorgan/blocks-models"
WIN_DIR='C:\Users\tellt\AppData\Local\OwenMorgan\blocks-models'

# ── 1-5. publish ─────────────────────────────────────────────────────────────
"$HERE/blocks-publish.sh" "$TAG" "$SRC" "$QUANT"

GGUF="$WORK/blocks-$TAG-$QUANT.gguf"
[ "$QUANT" = "f16" ] && GGUF="$WORK/blocks-$TAG-f16.gguf"
[ -f "$GGUF" ] || { echo "deploy: expected $GGUF to exist after publish" >&2; exit 1; }
BASENAME="$(basename "$GGUF")"
SHA="$(shasum -a 256 "$GGUF" | cut -d' ' -f1)"
BYTES="$(stat -f%z "$GGUF")"
echo
echo "=== artifact ==="
echo "    $BASENAME  ($(echo "scale=1; $BYTES/1073741824" | bc) GiB)"
echo "    sha256 $SHA"

# ── 6. this Mac ──────────────────────────────────────────────────────────────
echo "=== 6/8 install on this Mac ==="
mkdir -p "$MAC_DIR"
if [ -f "$MAC_DIR/$BASENAME" ] \
   && [ "$(shasum -a 256 "$MAC_DIR/$BASENAME" | cut -d' ' -f1)" = "$SHA" ]; then
  echo "    already present and matching"
else
  # Copy to a temp name and rename, so an interrupted copy can never be seen at
  # its final path — the same atomic-write rule the library folder uses.
  cp "$GGUF" "$MAC_DIR/.$BASENAME.partial"
  mv "$MAC_DIR/.$BASENAME.partial" "$MAC_DIR/$BASENAME"
  echo "    installed -> $MAC_DIR/$BASENAME"
fi

# ── 7. the Windows box ───────────────────────────────────────────────────────
echo "=== 7/8 copy to $WIN_HOST ==="
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$WIN_HOST" "echo ok" >/dev/null 2>&1; then
  echo "    !! $WIN_HOST unreachable — skipping. Re-run this script to retry;"
  echo "       every step is idempotent and the HF upload will be skipped."
else
  # ssh to Windows OpenSSH lands in PowerShell, so quoting rules differ from the
  # rest of this toolchain. Keep these one-liners simple.
  ssh "$WIN_HOST" "if (!(Test-Path '$WIN_DIR')) { New-Item -ItemType Directory -Force -Path '$WIN_DIR' | Out-Null }" >/dev/null
  WIN_SHA="$(ssh "$WIN_HOST" "if (Test-Path '$WIN_DIR\\$BASENAME') { (Get-FileHash -Algorithm SHA256 '$WIN_DIR\\$BASENAME').Hash.ToLower() } else { 'absent' }" 2>/dev/null | tr -d '\r' | tail -1)"
  if [ "$WIN_SHA" = "$SHA" ]; then
    echo "    already present and matching"
  else
    echo "    sending $BASENAME (this is the slow part)"
    scp "$GGUF" "$WIN_HOST:$BASENAME.partial"
    ssh "$WIN_HOST" "Move-Item -Force -Path '$BASENAME.partial' -Destination '$WIN_DIR\\$BASENAME'" >/dev/null
    echo "    installed -> $WIN_DIR\\$BASENAME"
  fi
fi

# ── 8. verify ────────────────────────────────────────────────────────────────
echo "=== 8/8 verify ==="
MAC_OK=no; WIN_OK=skipped
[ "$(shasum -a 256 "$MAC_DIR/$BASENAME" | cut -d' ' -f1)" = "$SHA" ] && MAC_OK=yes
if ssh -o ConnectTimeout=10 -o BatchMode=yes "$WIN_HOST" "echo ok" >/dev/null 2>&1; then
  WIN_SHA="$(ssh "$WIN_HOST" "if (Test-Path '$WIN_DIR\\$BASENAME') { (Get-FileHash -Algorithm SHA256 '$WIN_DIR\\$BASENAME').Hash.ToLower() } else { 'absent' }" 2>/dev/null | tr -d '\r' | tail -1)"
  [ "$WIN_SHA" = "$SHA" ] && WIN_OK=yes || WIN_OK="MISMATCH ($WIN_SHA)"
fi
echo "    huggingface : uploaded"
echo "    mac         : $MAC_OK"
echo "    windows     : $WIN_OK"
[ "$MAC_OK" = yes ] || { echo "deploy: the Mac copy does not match" >&2; exit 1; }
case "$WIN_OK" in MISMATCH*) echo "deploy: the Windows copy does not match" >&2; exit 1;; esac

echo
echo "Still to do by hand: paste the catalog entry above into BLOCKS_MODELS in"
echo "electron/blocks-models.ts with a rank above the model it replaces, then"
echo "rebuild. Until that lands, the app will not offer blocks-$TAG."
