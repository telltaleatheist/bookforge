#!/bin/bash
# Launch Higgs Audio v3 (4B) under vllm-omni.
#
# PROVENANCE. Transcribed from
#   E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\serve_v3.sh
# (owens-pc, WSL Ubuntu, RTX 3090 Ti, 2026-09-04), which is the script every
# measurement in electron/data/higgs-models.json was taken against. What differs
# from the original, and why each one is a fix rather than drift:
#   1. The env prefix is a parameter ($HIGGS_ENV) instead of a hardcoded
#      /home/telltale path, so this ships.
#   2. The model is resolved from $HIGGS_MODEL_DIR when set, so a merged
#      fine-tune can be served without editing the script. narrator EXPORTS it
#      per voice (python/narrator/engine/higgs/v3_served.py `_launch_exports`).
#   3. Memory, concurrency and context length are passed PER STAGE through
#      --stage-overrides, not as global flags. vllm-omni applies a global
#      --gpu-memory-utilization / --max-num-seqs / --max-model-len to EVERY stage
#      (vllm_omni/config/omni_config.py `_stage_cli_overrides`: a field of
#      OmniEngineArgs is a "global stage field"), and this server is TWO stages -
#      the talker (stage 0) and the codec decoder (stage 1). The campaign's
#      `--gpu-memory-utilization 0.60` therefore reserved 0.60 of the card TWICE:
#      measured 24.2 GB of 24.5 GB in use on 2026-09-05. The deploy profile
#      (vllm_omni/deploy/higgs_multimodal_qwen3.yaml) intends 0.60 for the talker
#      and 0.25 for the codec, and that is what the two variables below default
#      to. Likewise `--max-model-len 8192` was clamping the codec stage, whose
#      profile value is 65536.
#   4. $HIGGS_DEPLOY_CONFIG selects vllm-omni's deploy profile. Unset, vllm-omni
#      auto-discovers `higgs_multimodal_qwen3.yaml`, which keeps stage 0 in
#      enforce_eager (NO CUDA GRAPHS on the talker). The sibling
#      `higgs_multimodal_qwen3_low_latency` profile turns them on
#      (enforce_eager: false, cudagraph_mode FULL_DECODE_ONLY). Which profile is
#      certified for a voice is the training side's measurement, and until it is
#      made this stays unset - the variable exists so that measurement needs no
#      script edit.
# The levers are documented in the campaign's HIGGS_V3_LEVERS.md.
#
# The installer copies this into <env>/bin/serve_higgs_v3.sh and chmod +x's it;
# the doctor checks that the copy there is byte-identical to the shipped one.
# Keeping it inside the env is what makes the stack self-contained: nothing at
# run time reads E:\training.
set -euo pipefail

HIGGS_ENV="${HIGGS_ENV:-$HOME/anaconda3/envs/higgs3}"
HIGGS_PORT="${HIGGS_PORT:-8095}"
HIGGS_HOST="${HIGGS_HOST:-127.0.0.1}"
# Stage 0, the talker: weights + KV cache. Stage 1, the codec decoder: no KV
# cache. Both are FRACTIONS OF THE WHOLE CARD, and they add.
HIGGS_GPU_MEM_UTIL="${HIGGS_GPU_MEM_UTIL:-0.60}"
HIGGS_CODEC_GPU_MEM_UTIL="${HIGGS_CODEC_GPU_MEM_UTIL:-0.25}"
HIGGS_MAX_MODEL_LEN="${HIGGS_MAX_MODEL_LEN:-8192}"
HIGGS_MAX_NUM_SEQS="${HIGGS_MAX_NUM_SEQS:-16}"
HIGGS_DEPLOY_CONFIG="${HIGGS_DEPLOY_CONFIG:-}"

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

# A fine-tune wins; otherwise serve the base snapshot out of the HF cache.
#
# HIGGS_MODEL_DIR IS A MERGED CHECKPOINT DIRECTORY (~8.5 GB), by convention at
# /home/<user>/higgs-models/<voice>/. It is not a LoRA and there is no flag here
# that would take one: vllm-omni cannot load an adapter at runtime — `vllm-omni
# serve` has no adapter options and the higgs_audio_v3 talker class does not
# implement SupportsLoRA — so a LoRA is merged into a full checkpoint before it
# can serve at all. That is also why changing voice means restarting this script
# (~55 s warm / ~300 s cold) rather than sending the server a message.
#
# NO FALLBACK ON A SET-BUT-MISSING DIR: if the caller named a model dir and it is
# not there, that is a wrong render waiting to happen — serving the base instead
# would produce a completely different narrator and report success.
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

# Refuse a value that is not a number before vllm-omni turns it into a traceback
# three minutes in. (bash has no floats; the pattern is the check.)
for pair in "HIGGS_GPU_MEM_UTIL=$HIGGS_GPU_MEM_UTIL" "HIGGS_CODEC_GPU_MEM_UTIL=$HIGGS_CODEC_GPU_MEM_UTIL"; do
  case "${pair#*=}" in
    0.[0-9]*|1|1.0) ;;
    *) echo "${pair%%=*} must be a fraction in (0, 1]; got '${pair#*=}'" >&2; exit 4 ;;
  esac
done
case "$HIGGS_MAX_NUM_SEQS" in ''|*[!0-9]*|0) echo "HIGGS_MAX_NUM_SEQS must be a positive integer; got '$HIGGS_MAX_NUM_SEQS'" >&2; exit 4 ;; esac
case "$HIGGS_MAX_MODEL_LEN" in ''|*[!0-9]*|0) echo "HIGGS_MAX_MODEL_LEN must be a positive integer; got '$HIGGS_MAX_MODEL_LEN'" >&2; exit 4 ;; esac

STAGE_OVERRIDES="{\"0\": {\"gpu_memory_utilization\": $HIGGS_GPU_MEM_UTIL, \"max_num_seqs\": $HIGGS_MAX_NUM_SEQS, \"max_model_len\": $HIGGS_MAX_MODEL_LEN}, \"1\": {\"gpu_memory_utilization\": $HIGGS_CODEC_GPU_MEM_UTIL, \"max_num_seqs\": $HIGGS_MAX_NUM_SEQS}}"

DEPLOY_ARGS=()
if [ -n "$HIGGS_DEPLOY_CONFIG" ]; then
  DEPLOY_ARGS=(--deploy-config "$HIGGS_DEPLOY_CONFIG")
fi

echo "MODEL=$MODEL"
echo "BIND=$HIGGS_HOST:$HIGGS_PORT"
echo "STAGE_OVERRIDES=$STAGE_OVERRIDES"
echo "DEPLOY_CONFIG=${HIGGS_DEPLOY_CONFIG:-(vllm-omni default profile)}"

exec "$HIGGS_ENV/bin/vllm-omni" serve "$MODEL" \
  --served-model-name higgs-v3 \
  --host "$HIGGS_HOST" --port "$HIGGS_PORT" \
  --trust-remote-code \
  --stage-overrides "$STAGE_OVERRIDES" \
  --attention-backend "$VLLM_ATTENTION_BACKEND" \
  "${DEPLOY_ARGS[@]}" \
  --omni
