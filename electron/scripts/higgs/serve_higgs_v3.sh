#!/bin/bash
# Launch Higgs Audio v3 (4B) under vllm-omni.
#
# PROVENANCE. Transcribed from
#   E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\serve_v3.sh
# (owens-pc, WSL Ubuntu, RTX 3090 Ti, 2026-09-04), which is the script every
# measurement in electron/data/higgs-models.json was taken against. Two things
# changed and nothing else did:
#   1. The env prefix is a parameter ($HIGGS_ENV) instead of a hardcoded
#      /home/telltale path, so this ships.
#   2. The model is resolved from $HIGGS_MODEL_DIR when set, so a merged
#      fine-tune can be served without editing the script.
# Anything else that differs from the original is a BUG — the original is the
# reference, and its levers are documented in that campaign's HIGGS_V3_LEVERS.md.
#
# The installer copies this into <env>/bin/serve_higgs_v3.sh and chmod +x's it;
# the doctor checks for it there. Keeping it inside the env is what makes the
# stack self-contained: nothing at run time reads E:\training.
set -euo pipefail

HIGGS_ENV="${HIGGS_ENV:-$HOME/anaconda3/envs/higgs3}"
HIGGS_PORT="${HIGGS_PORT:-8095}"
HIGGS_HOST="${HIGGS_HOST:-127.0.0.1}"
HIGGS_GPU_MEM_UTIL="${HIGGS_GPU_MEM_UTIL:-0.60}"
HIGGS_MAX_MODEL_LEN="${HIGGS_MAX_MODEL_LEN:-8192}"
HIGGS_MAX_NUM_SEQS="${HIGGS_MAX_NUM_SEQS:-2}"

# The CUDA 13 toolkit that ships INSIDE the pip wheel. vllm-omni's stack is built
# against it and the system CUDA (if any) is the wrong version.
export CUDA_HOME="$HIGGS_ENV/lib/python3.11/site-packages/nvidia/cu13"
export CUDA_PATH="$CUDA_HOME"
export PATH="$CUDA_HOME/bin:$HIGGS_ENV/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib:${LD_LIBRARY_PATH:-}"

# FlashInfer is unavailable on sm_86 with torch 2.13+cu130: it JIT-builds its
# attention kernels with nvcc, and its bundled CCCL headers reject the CUDA 13
# nvcc from the pip wheel. These three lines route around it entirely — the
# torch-native sampler plus vLLM's prebuilt FA2. This is SPEED ONLY; correctness
# is unaffected. The flashinfer-jit-cache cu130/sm_86 wheel from
# https://flashinfer.ai/whl/cu130/torch2.13/ is the route if v3 speed matters.
export VLLM_USE_FLASHINFER_SAMPLER=0
export VLLM_ATTENTION_BACKEND="${VLLM_ATTENTION_BACKEND:-FLASH_ATTN}"
export VLLM_DISABLE_FLASHINFER_PREFILL=1
export VLLM_LOGGING_LEVEL="${VLLM_LOGGING_LEVEL:-INFO}"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.6}"

# A fine-tune (merged checkpoint dir) wins; otherwise serve the base snapshot out
# of the HF cache. NO FALLBACK ON A SET-BUT-MISSING DIR: if the caller named a
# model dir and it is not there, that is a wrong render waiting to happen —
# serving the base instead would produce a completely different narrator and
# report success.
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
echo "MODEL=$MODEL"

exec "$HIGGS_ENV/bin/vllm-omni" serve "$MODEL" \
  --served-model-name higgs-v3 \
  --host "$HIGGS_HOST" --port "$HIGGS_PORT" \
  --trust-remote-code \
  --gpu-memory-utilization "$HIGGS_GPU_MEM_UTIL" \
  --max-model-len "$HIGGS_MAX_MODEL_LEN" \
  --max-num-seqs "$HIGGS_MAX_NUM_SEQS" \
  --attention-backend "$VLLM_ATTENTION_BACKEND" \
  --omni
