#!/bin/bash
# blockcat-to-ollama — take a trained LoRA checkpoint and produce an Ollama
# model the Mac can run locally.
#
#   ./blockcat-to-ollama.sh <run-name> <checkpoint-dir> [mac-host]
#   ./blockcat-to-ollama.sh blockcat_v2 /home/telltale/xtts_ft/blockcat_v2_lora
#
# Runs on the TRAINING BOX (WSL), because that is where the base model, the
# adapter and a working torch live. It leaves an f16 GGUF to copy to the Mac.
#
# Why f16 and not a quantized GGUF: quantizing needs llama.cpp's compiled
# `llama-quantize`, and `ollama create --quantize q4_K_M` does the same job
# from an f16 source without building anything. One less toolchain.
#
# THE PROMPT TEMPLATE IS DELIBERATELY NOT SET HERE. The fine-tune was trained
# under Qwen3's template with thinking disabled, which emits an empty
# <think></think> block that Ollama's stock template does not. BookForge sends
# the fully-formed string with `raw: true` instead, so the Modelfile carries no
# TEMPLATE at all — one implementation of the prompt format, in the encoder.

set -euo pipefail

RUN_NAME="${1:?usage: blockcat-to-ollama.sh <run-name> <checkpoint-dir> [mac-host]}"
CKPT="${2:?checkpoint dir, e.g. /home/telltale/xtts_ft/blockcat_v2_lora}"
MAC_HOST="${3:-}"

WORK=/home/telltale/blockcat-export
MERGED="$WORK/${RUN_NAME}_merged"
GGUF="$WORK/${RUN_NAME}-f16.gguf"
LLAMA_CPP=/home/telltale/llama.cpp
PY=/home/telltale/anaconda3/envs/orpheus_train/bin/python

mkdir -p "$WORK"

echo "=== 1/4 merge LoRA into the base model ==="
if [ -d "$MERGED" ]; then
  echo "    $MERGED exists, skipping"
else
  # CPU merge on purpose: this may run while a training job owns the GPU, and
  # a 4B model in fp16 is ~8 GB of ordinary RAM.
  CUDA_VISIBLE_DEVICES="" "$PY" - "$CKPT" "$MERGED" <<'PY'
import sys, torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

ckpt, out = sys.argv[1], sys.argv[2]
base_id = "Qwen/Qwen3-4B"
print(f"[merge] base={base_id} adapter={ckpt}", flush=True)
model = AutoModelForCausalLM.from_pretrained(
    base_id, torch_dtype=torch.float16, device_map="cpu")
model = PeftModel.from_pretrained(model, ckpt, device_map="cpu")
model = model.merge_and_unload()
model.save_pretrained(out, safe_serialization=True)
# The tokenizer must come from the CHECKPOINT, not the hub: training may have
# added tokens, and a tokenizer that disagrees with the weights produces
# fluent nonsense rather than an error.
AutoTokenizer.from_pretrained(ckpt).save_pretrained(out)
print(f"[merge] wrote {out}", flush=True)
PY
fi

echo "=== 2/4 llama.cpp converter ==="
if [ ! -d "$LLAMA_CPP" ]; then
  # Only the Python converter is needed; nothing is compiled.
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP"
fi
"$PY" -m pip install -q --disable-pip-version-check gguf sentencepiece protobuf

echo "=== 3/4 convert to f16 GGUF ==="
if [ -f "$GGUF" ]; then
  echo "    $GGUF exists, skipping"
else
  "$PY" "$LLAMA_CPP/convert_hf_to_gguf.py" "$MERGED" --outfile "$GGUF" --outtype f16
fi
ls -lh "$GGUF"

echo "=== 4/4 next steps ==="
cat <<EOF

Copy to the Mac and import (Ollama does the quantizing):

  scp <this-box>:$GGUF ~/Downloads/
  printf 'FROM ~/Downloads/$(basename "$GGUF")\n' > /tmp/Modelfile.$RUN_NAME
  ollama create $RUN_NAME --quantize q4_K_M -f /tmp/Modelfile.$RUN_NAME

Then in BookForge: Detect mode -> backend Ollama, model "$RUN_NAME".
No TEMPLATE in the Modelfile on purpose — BookForge sends the raw prompt.
EOF

if [ -n "$MAC_HOST" ]; then
  echo "=== copying to $MAC_HOST ==="
  scp "$GGUF" "$MAC_HOST:~/Downloads/"
fi
