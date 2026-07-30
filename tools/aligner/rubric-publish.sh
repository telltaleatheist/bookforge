#!/bin/bash
# rubric-publish — turn a trained checkpoint into the artifact BookForge ships.
#
#   ./rubric-publish.sh <version-tag> <merged-model-dir-or-f16-gguf>
#   ./rubric-publish.sh v3-4b ~/rubric-export/rubric-v3-4b-merged
#   ./rubric-publish.sh v4-4b ~/rubric-export/rubric-v4-4b-f16.gguf
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
#   4. uploads to huggingface.co/owenmorgan/bookforge-rubric
#   5. prints the catalog entry to paste into electron/rubric-models.ts
#
# Step 5 is manual ON PURPOSE. The sha256 and byte count in that catalog are what
# make a download verifiable, and a script that edited them itself could quietly
# republish a model nobody had evaluated. Pasting them is a moment to notice.
#
# NOT OLLAMA. This script used to emit an Ollama Modelfile, which meant every
# user needed Ollama installed and had to `ollama create` by hand. BookForge now
# serves the GGUF on its own bundled llama-server (electron/rubric-server.ts), so
# a plain quantized GGUF on HuggingFace is the whole deliverable.

set -euo pipefail

TAG="${1:?usage: rubric-publish.sh <version-tag> <merged-dir-or-f16-gguf>}"
SRC="${2:?a merged model dir or an f16 .gguf}"

REPO=owenmorgan/bookforge-rubric
WORK="${RUBRIC_WORK:-$HOME/rubric-export}"
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
F16="$WORK/rubric-$TAG-f16.gguf"
Q4="$WORK/rubric-$TAG-Q4_K_M.gguf"

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
# Q4_K_M: the size/quality knee for this job. 2.5 GB is a download people will
# wait for; the f16 is 8 GB. (Cross-check when changing this: the v3-4b Q4_K_M
# came out byte-identical to what `ollama create --quantize q4_K_M` produced,
# which is the build every measurement in the field guide was taken on.)
if [ ! -f "$Q4" ]; then
  echo "=== quantize -> Q4_K_M ==="
  DYLD_LIBRARY_PATH="$LLAMA_BIN" "$LLAMA_BIN/llama-quantize" "$F16" "$Q4" Q4_K_M 8
else
  echo "=== Q4_K_M already present: $Q4 ==="
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
Paste into RUBRIC_MODELS in electron/rubric-models.ts, giving it a \`rank\` above
the entry it replaces so it becomes the default:

  {
    id: 'rubric-$TAG',
    name: 'Page layout model',
    filename: '$BASENAME',
    url: \`\\\${HF}/$BASENAME\`,
    sha256: '$SHA',
    bytes: $BYTES,
    minRAM: 6,
    note: '…',
    rank: 40,
  },

The id's version segment is LOAD-BEARING — rubricVersionFor() reads v1/v2/v3 out
of it to choose the prompt format and the legal class list. A new taxonomy or a
new prompt shape needs a new version number here AND a branch in the encoder.

Old entries stay in the catalog: someone mid-book has the old model on disk and
pulling it out from under them would strand them. Only \`rank\` decides the default.
════════════════════════════════════════════════════════════════════════════
EOF
