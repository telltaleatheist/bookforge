#!/bin/bash
# Launch the TEXT-PASS model (Qwen3.5-9B, bf16) under vLLM — the batched server
# behind Foundry's clean-text / translate / simplify passes.
#
# WHY THIS EXISTS. Owen, 2026-09-08: "lets build in vllm batching. ollama
# batching doesnt work. its an unfinished feature ollama tried to implement but
# isnt accessible on the mac or pc. cuda graphs/vllm would probably be the best
# for all three features." Measured before that ruling: Ollama 0.33.3 refuses to
# decode the qwen35 architecture in parallel on its llama.cpp backend
# (sched.go:509), so OLLAMA_NUM_PARALLEL=4 and Foundry's four-in-flight pool
# bought nothing — every text pass ran one request at a time on a 24 GB card.
# vLLM's continuous batching + CUDA graphs + prefix caching is what those passes
# were shaped for: the same ~6 kB system prompt on every request (prefix-cached
# once), one block of prose per request, temperature 0.
#
# THE CONTRACT, in the shape of serve_higgs_sgl.sh: configured entirely through
# the environment, `exec`s the server so a signal reaches it, and exports
# BOOKFORGE_TEXT_SERVER_OWNER so BookForge's teardown can find the listener by
# scanning /proc — BookForge OWNS THIS SERVER'S LIFETIME (starts it before a text pass,
# stops it after; a render never shares the card with it). Foundry only speaks
# to the endpoint; it starts and stops nothing.
#
# TEXT ONLY. Qwen3.5-9B is a multimodal checkpoint (config architecture
# Qwen3_5ForConditionalGeneration); the vision tower is never used by a text
# pass, so the multimodal limits are set to zero and vLLM skips loading and
# profiling it. The served NAME is the string Foundry sends as `model`; it is
# pinned here so the client and the server can never disagree about it.
#
# Nothing below is measured yet (2026-09-08): the card is busy. The first start
# records --max-num-seqs / --gpu-memory-utilization / --max-model-len against
# a real clean-text pass, and those numbers replace these defaults with their
# provenance in this header.
set -euo pipefail

VLLM_TEXT_ENV="${VLLM_TEXT_ENV:-$HOME/anaconda3/envs/higgs3}"
VLLM_TEXT_MODEL_DIR="${VLLM_TEXT_MODEL_DIR:-$HOME/models/Qwen3.5-9B}"
# THE SERVED NAME IS THE RECORD. Foundry (19f5e70) resolves the model by asking
# /v1/models and writes THAT id into the bank key, the records key and the
# narration stamp - it carries no separate precision field because a server
# cannot report its dtype. So this name must say what it is, never mimic an
# Ollama tag: two books cleaned at two precisions would otherwise be
# byte-indistinguishable in their records. "Qwen3.5-9B-bf16" = the checkpoint
# and the dtype it is served at. A request naming anything else is an HTTP 404
# from vLLM, which is the right answer to a client and a server that disagree.
VLLM_TEXT_MODEL_NAME="${VLLM_TEXT_MODEL_NAME:-Qwen3.5-9B-bf16}"
VLLM_TEXT_HOST="${VLLM_TEXT_HOST:-127.0.0.1}"
# 8300: clear of Higgs on 8095 (vllm-omni) and 8200 (SGLang-Omni), and of Ollama
# on 11434, so a stale listener on any of those can never be mistaken for this.
VLLM_TEXT_PORT="${VLLM_TEXT_PORT:-8300}"
# Requests in flight. Foundry's pool sends 4 today (cd89ee7, --concurrency 4);
# the server admits more so a wider pool needs no server change.
VLLM_TEXT_MAX_NUM_SEQS="${VLLM_TEXT_MAX_NUM_SEQS:-16}"
# The context per request. Foundry pins num_ctx 12288 on Ollama (its longest
# system prompt + block + answer); 16384 covers that with headroom for a long
# block. Prefix caching makes the shared system prompt cost one prefill.
VLLM_TEXT_MAX_MODEL_LEN="${VLLM_TEXT_MAX_MODEL_LEN:-16384}"
# 9B bf16 weights are ~19 GB; 0.90 of a 24.5 GB card leaves ~3 GB for the cache
# pool. MEASURED on the first run (Pokemon, 2026-09-08): 18.26 GiB of weights,
# a pool of 22,420 tokens, 7 requests decoding with 3 queued "capacity" out of
# foundry's 12 — and 458 blocks/min against Ollama's 110.
VLLM_TEXT_GPU_MEM_UTIL="${VLLM_TEXT_GPU_MEM_UTIL:-0.90}"
# THE DEPTH KNOBS, exposed and UNMEASURED. Both Qwen3.5-9B and Qwen3.8-27B are
# HYBRID models: three of every four layers are Gated DeltaNet with a FIXED
# recurrent state per sequence (~50 MB on the 9B, ~148 MB on the 27B at fp32),
# one in four is full attention with a tiny KV (kv_heads 4, head_dim 256:
# 32 KB / 64 KB per token). vLLM pads the attention page to the state's size,
# so a sequence costs pages of ~1,600 tokens — which is why 3.3 GB reported
# only 22,420 tokens and admitted 7. The state dtype is therefore the knob that
# buys depth (float16 halves the state and the page); the KV dtype buys little
# here. "auto" = vLLM's own default; a value is passed through verbatim and
# vLLM refuses one it does not know.
VLLM_TEXT_MAMBA_CACHE_DTYPE="${VLLM_TEXT_MAMBA_CACHE_DTYPE:-auto}"
VLLM_TEXT_KV_CACHE_DTYPE="${VLLM_TEXT_KV_CACHE_DTYPE:-auto}"
# THE ACTIVATION DTYPE, a variable because the SECOND profile is not bf16. The 9B
# is served bfloat16 because its weights are; the 27B is
# cyankiwi/Qwen3.8-27B-AWQ-INT4 — compressed-tensors, pack-quantized, 4 bits —
# where vLLM picks the activation dtype out of the checkpoint's own
# quantization_config, and naming one here would be this launcher having an
# opinion about somebody else's weights. `auto` is that. The DEFAULT stays
# bfloat16, so a hand-run of this script for the 9B is byte-identical to before.
VLLM_TEXT_DTYPE="${VLLM_TEXT_DTYPE:-bfloat16}"

if [ ! -d "$VLLM_TEXT_MODEL_DIR" ]; then
  echo "VLLM_TEXT_MODEL_DIR '$VLLM_TEXT_MODEL_DIR' does not exist." >&2
  echo "Download Qwen/Qwen3.5-9B into it (bf16 safetensors) before starting the text server." >&2
  exit 2
fi
if [ ! -x "$VLLM_TEXT_ENV/bin/python" ]; then
  echo "VLLM_TEXT_ENV '$VLLM_TEXT_ENV' has no python; it must be the conda env that holds vllm." >&2
  exit 3
fi
case "$VLLM_TEXT_GPU_MEM_UTIL" in
  0.[0-9]*) ;;
  *) echo "VLLM_TEXT_GPU_MEM_UTIL must be a fraction in (0, 1); got '$VLLM_TEXT_GPU_MEM_UTIL'" >&2; exit 4 ;;
esac
for pair in "VLLM_TEXT_MAX_NUM_SEQS=$VLLM_TEXT_MAX_NUM_SEQS" \
            "VLLM_TEXT_MAX_MODEL_LEN=$VLLM_TEXT_MAX_MODEL_LEN" \
            "VLLM_TEXT_PORT=$VLLM_TEXT_PORT"; do
  case "${pair#*=}" in
    ''|*[!0-9]*|0) echo "${pair%%=*} must be a positive integer; got '${pair#*=}'" >&2; exit 4 ;;
  esac
done

# The ownership marker every BookForge teardown path finds by scanning
# /proc/<pid>/environ — exported, so it is in the server's environment and not
# merely a shell variable here. NOT a VLLM_* name: vLLM treats that prefix as
# its own namespace and warns about every unknown one at startup.
export BOOKFORGE_TEXT_SERVER_OWNER="${BOOKFORGE_TEXT_SERVER_OWNER:-bookforge}"

# THE CUDA 13 TOOLKIT THAT SHIPS INSIDE THE PIP WHEEL, exactly as
# serve_higgs_v3.sh finds it for the same env. MEASURED on the first start
# (2026-09-08): without it the engine core died in the sampler warm-up with
# "Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist"
# — the model had loaded (16.8 GiB) and the failure came ninety seconds later.
export CUDA_HOME="$VLLM_TEXT_ENV/lib/python3.11/site-packages/nvidia/cu13"
export CUDA_PATH="$CUDA_HOME"
export PATH="$CUDA_HOME/bin:$VLLM_TEXT_ENV/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib:${LD_LIBRARY_PATH:-}"
if [ ! -x "$CUDA_HOME/bin/nvcc" ]; then
  echo "No nvcc at $CUDA_HOME/bin — the env's pip CUDA toolkit is missing; vLLM's sampler warm-up needs it." >&2
  exit 5
fi

# FlashInfer is unavailable on sm_86 with torch 2.13+cu130 (its bundled CCCL
# headers reject the wheel's CUDA 13 nvcc) — the same three lines the Higgs
# vllm-omni launcher uses to route around it: torch-native sampler, vLLM's
# prebuilt FA2. Speed only; correctness is unaffected.
export VLLM_USE_FLASHINFER_SAMPLER=0
export VLLM_ATTENTION_BACKEND="${VLLM_ATTENTION_BACKEND:-FLASH_ATTN}"
export VLLM_DISABLE_FLASHINFER_PREFILL=1
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.6}"

echo "[serve_text_vllm] $VLLM_TEXT_MODEL_DIR as '$VLLM_TEXT_MODEL_NAME' on $VLLM_TEXT_HOST:$VLLM_TEXT_PORT" >&2
echo "[serve_text_vllm] max-num-seqs $VLLM_TEXT_MAX_NUM_SEQS, max-model-len $VLLM_TEXT_MAX_MODEL_LEN, gpu-mem $VLLM_TEXT_GPU_MEM_UTIL, mamba-cache $VLLM_TEXT_MAMBA_CACHE_DTYPE, kv-cache $VLLM_TEXT_KV_CACHE_DTYPE" >&2

exec "$VLLM_TEXT_ENV/bin/python" -m vllm.entrypoints.openai.api_server \
  --model "$VLLM_TEXT_MODEL_DIR" \
  --served-model-name "$VLLM_TEXT_MODEL_NAME" \
  --host "$VLLM_TEXT_HOST" --port "$VLLM_TEXT_PORT" \
  --dtype "$VLLM_TEXT_DTYPE" \
  --max-model-len "$VLLM_TEXT_MAX_MODEL_LEN" \
  --max-num-seqs "$VLLM_TEXT_MAX_NUM_SEQS" \
  --gpu-memory-utilization "$VLLM_TEXT_GPU_MEM_UTIL" \
  --enable-prefix-caching \
  --mamba-cache-dtype "$VLLM_TEXT_MAMBA_CACHE_DTYPE" \
  --mamba-ssm-cache-dtype "$VLLM_TEXT_MAMBA_CACHE_DTYPE" \
  --kv-cache-dtype "$VLLM_TEXT_KV_CACHE_DTYPE" \
  --limit-mm-per-prompt '{"image":0,"video":0}' \
  --no-enable-log-requests
