#!/bin/bash
# blocks-publish — turn a trained checkpoint into the artifact foundry ships.
#
#   ./blocks-publish.sh <release-tag> <prompt-version> <merged-dir-or-f16-gguf> [quant]
#   ./blocks-publish.sh v2-4b 6 ~/blocks-export/blocks-v6-4b-merged
#   ./blocks-publish.sh v2-4b 6 ~/blocks-export/blocks-v6-4b-f16.gguf f16
#
# THE RELEASE TAG AND THE PROMPT VERSION ARE DIFFERENT NUMBERS, and that is why
# the prompt version is an argument rather than something read back out of a
# filename. `foundry-blocks-v1-4b` is RELEASE 1 of the blocks stage and carries
# the v5 PROMPT (twelve classes, table merged into list) — it is the checkpoint
# that shipped as rubric-v5-4b, re-published under foundry's naming. Anything
# that infers one from the other will eventually serve a model a class list it
# was trained never to emit, which does not error and just scores worse.
#
# Runs on the MAC, where llama.cpp and the HF token live. Training happens on the
# GPU box; merging needs ~10 GB resident and that box measured 11 GB total with a
# job in it, so the merge and everything after it belongs here.
#
# THE MODEL IS NOT DONE UNTIL IT IS PUBLISHED. A checkpoint nobody can install is
# a training artifact, not a model — so this is the last step of training, not a
# separate deployment chore. It:
#
#   1. converts to f16 GGUF (skipped if handed one)
#   2. quantizes to Q4_K_M
#   3. checks it loads on the binary that will serve it
#   4. uploads to huggingface.co/owenmorgan/foundry-models
#   5. prints the catalog entries to paste into foundry's src/models/catalog.ts
#      AND BookForge's electron/blocks-models.ts
#
# Step 5 is manual ON PURPOSE. The sha256 and byte count in that catalog are what
# make a download verifiable, and a script that edited them itself could quietly
# republish a model nobody had evaluated. Pasting them is a moment to notice.
#
# NOT OLLAMA. This script used to emit an Ollama Modelfile, which meant every
# user needed Ollama installed and had to `ollama create` by hand. BookForge now
# serves the GGUF on its own bundled llama-server (electron/blocks-server.ts), so
# a plain quantized GGUF on HuggingFace is the whole deliverable.
#
# ONE FILE, TWO CONSUMERS. `foundry models pull` and BookForge's Settings →
# Add-ons fetch the SAME artifact into the SAME directory (foundry's models dir),
# so there is never a second copy of an 8 GB checkpoint on one machine. That is
# the whole reason the file is named for the foundry stage rather than for the
# app that happens to be asking.

set -euo pipefail

TAG="${1:?usage: blocks-publish.sh <release-tag> <prompt-version> <merged-dir-or-f16-gguf> [quant]}"
PROMPT_VERSION="${2:?the PROMPT version these weights were trained on (e.g. 5) — not the release tag}"
SRC="${3:?a merged model dir or an f16 .gguf}"
case "$PROMPT_VERSION" in
  ''|*[!0-9]*) echo "prompt-version must be a number, got '$PROMPT_VERSION'" >&2; exit 1;;
esac
# MEASURE BEFORE CHOOSING THIS. Q4_K_M was the default on the assumption it was
# free; on v4 it is not — scored on the same held-out split, Q4_K_M gave up
# 0.035 macro-F1, 2.5 pts of block accuracy and 9.2 pts of page-exact-match
# against Q8_0, which is itself indistinguishable from f16. That is more than
# the entire v3->v4 model improvement, thrown away at the packaging step.
# Quantization cost is per-model, so re-measure it per release rather than
# inheriting a default.
QUANT="${4:-Q4_K_M}"

REPO=owenmorgan/foundry-models
WORK="${BLOCKS_WORK:-$HOME/blocks-export}"
TOKEN_FILE="$HOME/.config/bookforge/hf-owenmorgan.token"

# The pinned llama.cpp release the app itself bundles. Quantizing with the SAME
# build that will serve the file removes a whole class of "loads here, not there"
# — a GGUF written by a newer converter can use tensor types the shipped
# llama-server does not know.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LLAMA_VER="$(sed -n "s/^const LLAMA_CPP_VERSION = '\(.*\)';/\1/p" \
  "$REPO_ROOT/scripts/download-llama-cpp.js")"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || ARCH=x64
LLAMA_BIN="$REPO_ROOT/.llama-build/llama-$LLAMA_VER-bin-macos-$ARCH/llama-$LLAMA_VER"

if [ ! -x "$LLAMA_BIN/llama-quantize" ]; then
  echo "llama-quantize ($LLAMA_VER) is not staged." >&2
  echo "Run:  cd $REPO_ROOT && npm run download:llama" >&2
  exit 1
fi
[ -f "$TOKEN_FILE" ] || { echo "No HF token at $TOKEN_FILE" >&2; exit 1; }

mkdir -p "$WORK"
# Named for the foundry stage and release from here on: the filename IS the
# artifact's identity in both catalogs and on disk.
F16="$WORK/foundry-blocks-$TAG-f16.gguf"
Q4="$WORK/foundry-blocks-$TAG-$QUANT.gguf"

# ── 1. f16 GGUF ──────────────────────────────────────────────────────────────
if [ -d "$SRC" ]; then
  if [ ! -f "$F16" ]; then
    echo "=== convert $SRC -> f16 GGUF ==="
    LLAMA_CPP="${LLAMA_CPP_SRC:-$WORK/llama.cpp}"
    [ -d "$LLAMA_CPP" ] || git clone --depth 1 \
      https://github.com/ggml-org/llama.cpp "$LLAMA_CPP"
    python3 -m pip install -q --disable-pip-version-check gguf sentencepiece protobuf
    python3 "$LLAMA_CPP/convert_hf_to_gguf.py" "$SRC" --outfile "$F16" --outtype f16
  else
    echo "=== f16 GGUF already present: $F16 ==="
  fi
elif [ -f "$SRC" ]; then
  F16="$SRC"
else
  echo "Not a directory or a file: $SRC" >&2; exit 1
fi

# ── 2. quantize ──────────────────────────────────────────────────────────────
# Whatever $QUANT says — see the note at the top. Q4_K_M was picked as the
# size/quality knee back when it looked lossless; v4 measured it costing 9.2 pts
# of page-exact-match, so v4 ships Q8_0 (4.3 GB) instead. (Cross-check when
# changing this: the v3-4b Q4_K_M came out byte-identical to what
# `ollama create --quantize q4_K_M` produced, which is the build every
# measurement in the field guide was taken on.)
if [ "$QUANT" = "f16" ]; then
  Q4="$F16"
  echo "=== shipping f16 unquantized ==="
elif [ ! -f "$Q4" ]; then
  echo "=== quantize -> $QUANT ==="
  DYLD_LIBRARY_PATH="$LLAMA_BIN" "$LLAMA_BIN/llama-quantize" "$F16" "$Q4" "$QUANT" 8
else
  echo "=== $QUANT already present: $Q4 ==="
fi

# ── 3. load check ────────────────────────────────────────────────────────────
# On the binary that will serve it, so a bad quantize is caught now rather than
# after a 2.5 GB upload and somebody's 2.5 GB download.
echo "=== load check on the bundled llama-server ==="
PORT=8824
DYLD_LIBRARY_PATH="$REPO_ROOT/resources/bin" \
  "$REPO_ROOT/resources/bin/llama-server-$ARCH" \
  --model "$Q4" --port "$PORT" --host 127.0.0.1 -c 8192 -np 1 --no-webui \
  > "$WORK/publish-smoke.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok && break
  sleep 2
done
curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok || {
  echo "The quantized model did not load. See $WORK/publish-smoke.log" >&2; exit 1; }
echo "loads OK"
kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT

# ── 4. upload ────────────────────────────────────────────────────────────────
BASENAME="$(basename "$Q4")"
echo "=== upload $BASENAME -> $REPO ==="
HF_TOKEN="$(cat "$TOKEN_FILE")" hf upload "$REPO" "$Q4" "$BASENAME" --repo-type model

# ── 5. the catalog entry ─────────────────────────────────────────────────────
SHA="$(shasum -a 256 "$Q4" | cut -d' ' -f1)"
BYTES="$(stat -f%z "$Q4")"
cat <<EOF

════════════════════════════════════════════════════════════════════════════
1. Paste into FOUNDRY_MODELS in foundry's src/models/catalog.ts:

  {
    id: 'foundry-blocks-$TAG',
    name: 'Page layout model',
    filename: '$BASENAME',
    url: \\`\\${HF}/$BASENAME\\`,
    sha256: '$SHA',
    bytes: $BYTES,
    rank: 100,
    kind: 'full',
    stage: 'blocks',
    promptVersion: $PROMPT_VERSION,
    note: '…',
  },

2. Paste into BLOCKS_MODELS in BookForge's electron/blocks-models.ts, giving it a
   \\`rank\\` above the entry it replaces so it becomes the default:

  {
    id: 'foundry-blocks-$TAG',
    name: 'Page layout model',
    filename: '$BASENAME',
    url: \\`\\${HF}/$BASENAME\\`,
    sha256: '$SHA',
    bytes: $BYTES,
    minRAM: 16,
    note: '…',
    rank: 100,
    promptVersion: $PROMPT_VERSION,
  },

3. If $PROMPT_VERSION is a prompt format the encoder has never served, add its
   class list and system-prompt branch to
   src/app/features/pdf-picker/services/blocks-encoder.ts FIRST, and add
   release $TAG -> prompt $PROMPT_VERSION to FOUNDRY_BLOCKS_PROMPT_VERSION there.
   The id does NOT carry the prompt version any more; the catalogs declare it and
   the encoder's table is what the CLI tools read. All three must agree.

Old entries stay in both catalogs: someone mid-book has the old model on disk and
pulling it out from under them would strand them. Only \\`rank\\` decides the default.
════════════════════════════════════════════════════════════════════════════
EOF
