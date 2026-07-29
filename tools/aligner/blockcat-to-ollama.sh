#!/bin/bash
# blockcat-to-ollama — take a trained LoRA checkpoint and produce something
# Ollama can run on the Mac.
#
#   ./blockcat-to-ollama.sh <run-name> <checkpoint-dir> [--merge]
#   ./blockcat-to-ollama.sh blockcat_v2 /home/telltale/xtts_ft/blockcat_v2_lora
#
# Runs on the TRAINING BOX (WSL), where the adapter and a working torch live.
#
# TWO ROUTES, and the default is the light one:
#
#   ADAPTER (default) — convert the LoRA itself to GGUF (~250 MB) and let
#     Ollama apply it over the stock qwen3:4b base with a Modelfile ADAPTER
#     line. No merge, no 8 GB transfer. This is also faithful to how the model
#     was trained: `load_in_4bit: true` means the adapter already learned on
#     top of a quantized base, so serving it over one is not a new compromise.
#     It is the ONLY route that fits here — measured, this WSL has 11 GB of RAM
#     total and a merge needs the 8 GB base plus a second copy while saving,
#     which would swap hard and destabilise a training run.
#
#   --merge — merge into the base and ship a full f16 GGUF. Heavier in every
#     way, kept because it removes any question of base-model drift: it pins
#     the exact weights instead of trusting Ollama's qwen3:4b to be the same
#     model the adapter was trained against. Reach for it if the adapter route
#     produces output that looks subtly wrong rather than plainly broken.
#
# THE PROMPT TEMPLATE IS DELIBERATELY NOT SET IN THE MODELFILE. The fine-tune
# was trained under Qwen3's template with thinking disabled, which emits an
# empty <think></think> block that Ollama's stock template does not. BookForge
# sends the fully-formed string with `raw: true`, so there is exactly one
# implementation of the prompt format and it lives in blockcat-encoder.ts.

set -euo pipefail

RUN_NAME="${1:?usage: blockcat-to-ollama.sh <run-name> <checkpoint-dir> [--merge]}"
CKPT="${2:?checkpoint dir, e.g. /home/telltale/xtts_ft/blockcat_v2_lora}"
MODE="${3:-adapter}"

WORK=/home/telltale/blockcat-export
LLAMA_CPP=/home/telltale/llama.cpp
PY=/home/telltale/anaconda3/envs/orpheus_train/bin/python
BASE_TAG=qwen3:4b

mkdir -p "$WORK"

echo "=== llama.cpp converter (python only, nothing is compiled) ==="
if [ ! -d "$LLAMA_CPP" ]; then
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP"
fi
"$PY" -m pip install -q --disable-pip-version-check gguf sentencepiece protobuf

if [ "$MODE" = "--merge" ]; then
  MERGED="$WORK/${RUN_NAME}_merged"
  GGUF="$WORK/${RUN_NAME}-f16.gguf"
  echo "=== merge LoRA into the base (CPU; ~8 GB of RAM) ==="
  if [ ! -d "$MERGED" ]; then
    CUDA_VISIBLE_DEVICES="" "$PY" - "$CKPT" "$MERGED" <<'PY'
import sys, torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
ckpt, out = sys.argv[1], sys.argv[2]
model = AutoModelForCausalLM.from_pretrained(
    "Qwen/Qwen3-4B", torch_dtype=torch.float16,
    device_map="cpu", low_cpu_mem_usage=True)
model = PeftModel.from_pretrained(model, ckpt, device_map="cpu")
model = model.merge_and_unload()
model.save_pretrained(out, safe_serialization=True)
# Tokenizer from the CHECKPOINT, never the hub: training can add tokens, and a
# tokenizer that disagrees with the weights yields fluent nonsense, not an error.
AutoTokenizer.from_pretrained(ckpt).save_pretrained(out)
print(f"[merge] wrote {out}", flush=True)
PY
  fi
  echo "=== convert merged model to f16 GGUF ==="
  [ -f "$GGUF" ] || "$PY" "$LLAMA_CPP/convert_hf_to_gguf.py" "$MERGED" \
      --outfile "$GGUF" --outtype f16
  FROM_LINE="FROM ./$(basename "$GGUF")"
  ADAPTER_LINE=""
  ARTIFACT="$GGUF"
else
  GGUF="$WORK/${RUN_NAME}-lora-f16.gguf"
  echo "=== convert the LoRA itself to GGUF ==="
  [ -f "$GGUF" ] || "$PY" "$LLAMA_CPP/convert_lora_to_gguf.py" "$CKPT" \
      --base Qwen/Qwen3-4B --outfile "$GGUF" --outtype f16
  FROM_LINE="FROM $BASE_TAG"
  ADAPTER_LINE="ADAPTER ./$(basename "$GGUF")"
  ARTIFACT="$GGUF"
fi

ls -lh "$ARTIFACT"

cat > "$WORK/Modelfile.$RUN_NAME" <<EOF
$FROM_LINE
$ADAPTER_LINE

# No TEMPLATE on purpose. BookForge sends the fully-templated prompt with
# raw:true, because training used Qwen3's template with thinking DISABLED —
# which inserts an empty <think></think> block that Ollama's stock template
# omits. Templating here would silently feed the model a shape it never saw.
PARAMETER temperature 0
PARAMETER stop <|im_end|>
EOF

echo
echo "=== next, on the Mac ==="
cat <<EOF
  scp owens-pc:$ARTIFACT owens-pc:$WORK/Modelfile.$RUN_NAME ~/Downloads/
  cd ~/Downloads && ollama create $RUN_NAME -f Modelfile.$RUN_NAME
EOF
if [ "$MODE" = "--merge" ]; then
  echo "  (add --quantize q4_K_M to that create — the f16 GGUF is unquantized)"
else
  echo "  (first time only: ollama pull $BASE_TAG)"
fi
echo
echo "Then in BookForge: Detect mode -> Ollama (local), model \"$RUN_NAME\"."
