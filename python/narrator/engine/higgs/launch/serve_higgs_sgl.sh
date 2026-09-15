#!/bin/bash
# Launch Higgs Audio v3 (4B) under SGLang-Omni — the SECOND serving stack.
#
# THE SIBLING of serve_higgs_v3.sh, which serves the same model under vllm-omni.
# Same contract in every way BookForge depends on: it is configured entirely
# through the environment, it `exec`s the server so a signal reaches it, and
# narrator's wrapper exports NARRATOR_HIGGS3_OWNER into it (the ownership marker
# every teardown path finds by scanning /proc) plus HIGGS_MODEL_DIR (which on
# THIS stack is also the only way to tell which checkpoint is up — see below).
#
# PROVENANCE. Transcribed from
#   E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\night3\sgl\serve_sgl.sh
# (owens-pc, WSL Ubuntu, RTX 3090 Ti, 2026-09-05) and the flags recorded in
# orpheus-finetune/HIGGS_FIELD_NOTES.md §4n.3, which is the configuration every
# night-3 measurement was taken against. What differs from the campaign script,
# and why each is a fix rather than drift:
#   1. The env prefix is a parameter ($HIGGS_SGL_ENV) instead of a hardcoded
#      /home/telltale path, so this ships.
#   2. The three --tts_engine.factory flags are passed HERE rather than left to
#      the caller's "$@" passthrough. In the campaign they were typed on the
#      launch line; a launcher that takes them from the environment is the only
#      version BookForge can configure from its catalog.
#   3. There is no GPU lock and no tmux: BookForge owns the GPU lock, and the
#      wrapper narrator builds does the detaching.
#
# WHY THIS STACK EXISTS AT ALL. Measured 2026-09-05, same 50 packed chunks, same
# merged checkpoint, same sampling, one seed:
#   vllm-omni 0.28.0 @16   4 early stops, 13/50 damaged, 6 sustained voice
#                          switches, 10,752 chars/min
#   SGLang-Omni 0.1.4 @16  0 early stops,  5/50 damaged, 0 switches,
#                          26,666 chars/min
# vllm-omni's batched talker corrupts the newest batch row; SGLang-Omni does not.
#
# TWO THINGS THIS SERVER DOES NOT DO, and both are deliberate:
#   * NO SITE-PACKAGES PATCHES. The sentinel filter is a vllm-omni fix to its own
#     stage processor. SGLang-Omni has its own and needs none, which is why
#     BookForge's doctor reports no patch rows for this stack.
#   * NO --allowed-local-media-path. references[].audio_path is read BY THE
#     SERVER from its own filesystem, and handing a server a directory to read is
#     not something a launcher should do quietly. narrator therefore refuses a
#     reference-clone voice on this stack by name (sgl_served.refuse_clips_voice),
#     which is also right for a second reason: the reference's ~330 placeholder
#     tokens come out of a hard-coded 4096-token context.
#
# The installer copies this into <env>/bin/serve_higgs_sgl.sh and chmod +x's it;
# the doctor checks that the copy there is byte-identical to the shipped one.
set -euo pipefail

HIGGS_SGL_ENV="${HIGGS_SGL_ENV:-$HOME/anaconda3/envs/sglomni}"
HIGGS_SGL_HOST="${HIGGS_SGL_HOST:-127.0.0.1}"
# 8200, so a server on this stack can never be confused with vllm-omni's 8095.
HIGGS_SGL_PORT="${HIGGS_SGL_PORT:-8200}"
# ONE FRACTION, NOT TWO. Unlike vllm-omni — which is two vLLM stages and applies
# a global --gpu-memory-utilization to each, so BookForge has to split them
# through --stage-overrides — sgl-omni takes a single --mem-fraction-static for
# the whole engine. MEASURED: 0.60 holds ~19 GB of a 24.5 GB card at 16 in
# flight, with CUDA graphs captured on sm_86 (prefill + decode + 150 codec
# graphs) and health at ~110 s.
HIGGS_SGL_MEM_FRACTION="${HIGGS_SGL_MEM_FRACTION:-0.60}"
# The server's admission width AND the width of narrator's own batch: ONE
# number, stated once, so the two can never disagree about how wide the render
# is. It is the same variable the vllm-omni launcher reads.
HIGGS_MAX_NUM_SEQS="${HIGGS_MAX_NUM_SEQS:-16}"
# The CUDA-graph batch ceiling. Kept separate from the admission width because it
# is a CAPTURE budget rather than a scheduling limit — graphs are captured up to
# this size at startup and cost VRAM — even though the catalog ships them equal.
HIGGS_SGL_CUDA_GRAPH_MAX_BS="${HIGGS_SGL_CUDA_GRAPH_MAX_BS:-$HIGGS_MAX_NUM_SEQS}"
# The engine's own generation ceiling, applied as min(request, this) in
# make_higgs_scheduler_adapters. It is NOT the per-request cap: the real ceiling
# on this stack is the hard-coded 4096-token context (prompt + max_new_tokens),
# which narrator sizes every request against (sgl_served.frame_cap).
HIGGS_SGL_MAX_NEW_TOKENS="${HIGGS_SGL_MAX_NEW_TOKENS:-7500}"

# WHICH STACK THE CALLER THINKS IT IS STARTING, asserted rather than assumed —
# the mirror of the same guard in serve_higgs_v3.sh. BookForge sets HIGGS_STACK
# from the catalog and narrator refuses to render without it; a job configured
# for vllm-omni that reached THIS launcher would get a server whose requests the
# client is not building (sampling in `extra_params` that this stack has no field
# for, so top_k disabled and the untruncated codebook tail). Two seconds here
# instead of 110 and a book nobody can hear the fault in.
#
# Unset is accepted: this script is also run by hand.
if [ -n "${HIGGS_STACK:-}" ] && [ "$HIGGS_STACK" != "sglang-omni" ]; then
  echo "HIGGS_STACK is '$HIGGS_STACK' but this is the sglang-omni launcher." >&2
  echo "Start serve_higgs_v3.sh for the vllm-omni stack, or fix serving.stack in" >&2
  echo "electron/data/higgs-models.json — the client and the server must agree." >&2
  exit 6
fi

# THE CUDA 13 TOOLKIT THAT SHIPS INSIDE THE PIP WHEEL, and the two symlinks
# without which flashinfer's JIT cannot build a kernel: `lib64 -> lib` and
# `libcudart.so -> libcudart.so.13`. install_sglomni.sh creates them; this only
# points at them. (The env's own pip nvcc 13.4 is what does the compiling.)
export CUDA_HOME="$HIGGS_SGL_ENV/lib/python3.12/site-packages/nvidia/cu13"
export CUDA_PATH="$CUDA_HOME"
export PATH="$CUDA_HOME/bin:$HIGGS_SGL_ENV/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib:${LD_LIBRARY_PATH:-}"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.6}"

# A fine-tune wins; otherwise serve the base snapshot out of the HF cache.
#
# NO FALLBACK ON A SET-BUT-MISSING DIR: if the caller named a model dir and it is
# not there, that is a wrong render waiting to happen — serving the base instead
# would produce a completely different narrator and report success.
#
# HIGGS_MODEL_DIR IS ALSO THE IDENTITY OF THIS SERVER. sglang-omni's /v1/models
# answers ModelCard(id=model_name, root=model_name) — the served NAME in both
# fields, never the model path (serve/openai_api.py:_register_models) — so unlike
# vllm-omni 0.28 there is no endpoint that says which checkpoint is up. narrator
# reads this variable back out of /proc/<listener pid>/environ instead, which is
# why it MUST be exported into this process and not merely used here.
if [ -n "${HIGGS_MODEL_DIR:-}" ]; then
  if [ ! -d "$HIGGS_MODEL_DIR" ]; then
    echo "HIGGS_MODEL_DIR is set to '$HIGGS_MODEL_DIR' but that directory does not exist." >&2
    echo "Refusing to serve the base model in its place — it is a different speaker." >&2
    exit 2
  fi
  MODEL="$HIGGS_MODEL_DIR"
else
  MODEL=$(ls -d "$HOME"/.cache/huggingface/hub/models--bosonai--higgs-audio-v3-tts-4b/snapshots/*/ 2>/dev/null | head -1)
  if [ -z "$MODEL" ]; then
    echo "Higgs v3 weights are not in the HuggingFace cache and no HIGGS_MODEL_DIR was given." >&2
    exit 3
  fi
fi

# Refuse a value that is not a number before sgl-omni turns it into a traceback
# two minutes in. (bash has no floats; the pattern is the check.)
case "$HIGGS_SGL_MEM_FRACTION" in
  0.[0-9]*) ;;
  *) echo "HIGGS_SGL_MEM_FRACTION must be a fraction in (0, 1); got '$HIGGS_SGL_MEM_FRACTION'" >&2; exit 4 ;;
esac
for pair in "HIGGS_MAX_NUM_SEQS=$HIGGS_MAX_NUM_SEQS" \
            "HIGGS_SGL_CUDA_GRAPH_MAX_BS=$HIGGS_SGL_CUDA_GRAPH_MAX_BS" \
            "HIGGS_SGL_MAX_NEW_TOKENS=$HIGGS_SGL_MAX_NEW_TOKENS"; do
  case "${pair#*=}" in
    ''|*[!0-9]*|0) echo "${pair%%=*} must be a positive integer; got '${pair#*=}'" >&2; exit 4 ;;
  esac
done

if [ ! -x "$HIGGS_SGL_ENV/bin/sgl-omni" ]; then
  echo "There is no sgl-omni at $HIGGS_SGL_ENV/bin/sgl-omni." >&2
  echo "Build the env from Settings → Higgs (install_sglomni.sh) — it is a SEPARATE" >&2
  echo "conda env from higgs3 and the two cannot share one (torch 2.13 + sglang vs vllm)." >&2
  exit 5
fi

echo "MODEL=$MODEL"
echo "BIND=$HIGGS_SGL_HOST:$HIGGS_SGL_PORT"
echo "MEM_FRACTION_STATIC=$HIGGS_SGL_MEM_FRACTION"
echo "MAX_RUNNING_REQUESTS=$HIGGS_MAX_NUM_SEQS CUDA_GRAPH_MAX_BS=$HIGGS_SGL_CUDA_GRAPH_MAX_BS"
echo "FACTORY_MAX_NEW_TOKENS=$HIGGS_SGL_MAX_NEW_TOKENS"

# --model-name higgs-v3-ds, DELIBERATELY NOT vllm-omni's higgs-v3: it is the
# `model` field of every request and the id /v1/models reports, so a name that
# differs is one more way a leftover server on the wrong port is caught before a
# book is rendered against it.
exec "$HIGGS_SGL_ENV/bin/sgl-omni" serve \
  --model-path "$MODEL" \
  --model-name higgs-v3-ds \
  --host "$HIGGS_SGL_HOST" --port "$HIGGS_SGL_PORT" \
  --mem-fraction-static "$HIGGS_SGL_MEM_FRACTION" \
  --tts_engine.factory.max_running_requests "$HIGGS_MAX_NUM_SEQS" \
  --tts_engine.factory.cuda_graph_max_bs "$HIGGS_SGL_CUDA_GRAPH_MAX_BS" \
  --tts_engine.factory.max_new_tokens "$HIGGS_SGL_MAX_NEW_TOKENS"
