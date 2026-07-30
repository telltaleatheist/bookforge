#!/bin/bash
# rubric-merge-mac — fold a trained LoRA into the base model ON THE MAC and
# hand the result to Ollama, so BookForge classifies locally.
#
#   ./rubric-merge-mac.sh <ollama-name> <remote-checkpoint> [ssh-host]
#   ./rubric-merge-mac.sh rubric-v2 /home/telltale/xtts_ft/rubric_v2_lora
#
# The Mac is the right machine for this even though the model was trained
# elsewhere. Merging needs the whole 4B base resident (~8 GB fp16) and the
# training box's WSL has 11 GB total with a job running in it; this Mac has 64.
# Only the adapter crosses the network — 264 MB, not 8 GB.
#
# WHY MERGE AT ALL, when Ollama can apply a LoRA with an ADAPTER line: that
# route trusts Ollama's `qwen3:4b` to be the same weights the adapter trained
# against. If it isn't, the model returns plausible-looking wrong answers with
# no error — the hardest failure to attribute, and we would waste the time
# blaming the model or the prompt encoder. Merging pins the exact base.
#
# One honest caveat, and it depends on the run: the 4B adapters were trained
# against an NF4-quantized base (`load_in_4bit: true`), so folding them into
# fp16 weights and re-quantizing to Q4_K_M is not bit-faithful to training. That
# is standard QLoRA practice and works, but it is why the FIRST thing to check,
# if quality looks off, is whether it looks off *everywhere* (quantization) or
# only on the classes the run was built to fix (the model). The 0.6B was trained
# in bf16 with no quantization at all, so for it the honest export is f16 with
# no `--quantize` — 1.2 GB is not worth a lossy step. Set RUBRIC_QUANT="" to
# skip it, or to any Ollama quant name to change it.
#
# The base model is read from the adapter's own `adapter_config.json`, not
# guessed: an adapter merged into the wrong base produces fluent nonsense
# rather than an error, so the checkpoint gets to name its own base.
#
# The Modelfile deliberately sets no TEMPLATE. Training used Qwen3's template
# with thinking disabled, which inserts an empty <think></think> block that
# Ollama's stock template omits; BookForge sends the fully-formed prompt with
# raw:true. One implementation of the format, in rubric-encoder.ts.

set -euo pipefail

NAME="${1:?usage: rubric-merge-mac.sh <ollama-name> <remote-checkpoint> [ssh-host]}"
REMOTE_CKPT="${2:?remote checkpoint dir, e.g. /home/telltale/xtts_ft/rubric_v2_lora}"
HOST="${3:-owens-pc}"
QUANT="${RUBRIC_QUANT-q4_K_M}"

WORK="$HOME/rubric-export"
VENV="$WORK/venv"
CKPT="$WORK/$(basename "$REMOTE_CKPT")"
MERGED="$WORK/${NAME}-merged"
GGUF="$WORK/${NAME}-f16.gguf"
LLAMA_CPP="$WORK/llama.cpp"

mkdir -p "$WORK"

echo "=== 1/5 fetch the adapter from $HOST ==="
if [ -d "$CKPT" ]; then
  echo "    $CKPT exists, skipping"
else
  # WSL paths are not reachable over scp directly; stage through the Windows
  # side, which is the same trick the rest of this toolchain uses.
  ssh "$HOST" "wsl -d Ubuntu -- tar -C $(dirname "$REMOTE_CKPT") -czf /mnt/c/Users/tellt/rubric-ckpt.tgz $(basename "$REMOTE_CKPT")"
  scp "$HOST:rubric-ckpt.tgz" "$WORK/"
  tar -C "$WORK" -xzf "$WORK/rubric-ckpt.tgz"
  rm -f "$WORK/rubric-ckpt.tgz"
fi
# `train` writes the adapter at the run root and checkpoints beneath it; prefer
# the best checkpoint when one is recorded, since the last step is rarely best.
if [ -f "$CKPT/trainer_state.json" ] || ls "$CKPT"/checkpoint-* >/dev/null 2>&1; then
  BEST=$(python3 - "$CKPT" <<'PY'
import json, os, sys, glob
root = sys.argv[1]
best = None
for state in glob.glob(os.path.join(root, "checkpoint-*", "trainer_state.json")):
    try:
        b = json.load(open(state)).get("best_model_checkpoint")
    except Exception:
        continue
    if b:
        best = os.path.join(root, os.path.basename(b))
print(best or "")
PY
)
  if [ -n "$BEST" ] && [ -d "$BEST" ]; then
    echo "    using best checkpoint: $BEST"
    CKPT="$BEST"
  fi
fi
ls "$CKPT"/adapter_model.safetensors >/dev/null

# The base the adapter names, with any 4-bit suffix stripped: PEFT records the
# quantized repo when training was QLoRA, and merging into NF4 weights is not
# the same operation. `RUBRIC_BASE` overrides if a run ever needs it.
BASE_ID="${RUBRIC_BASE:-$(python3 - "$CKPT" <<'PY'
import json, os, re, sys
cfg = os.path.join(sys.argv[1], "adapter_config.json")
base = json.load(open(cfg)).get("base_model_name_or_path") or ""
print(re.sub(r"(-unsloth)?-bnb-4bit$|-4bit$", "", base))
PY
)}"
[ -n "$BASE_ID" ] || { echo "adapter_config.json names no base model"; exit 1; }
echo "    base model: $BASE_ID"

echo "=== 2/5 python env ==="
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --disable-pip-version-check --upgrade pip
"$VENV/bin/pip" install -q --disable-pip-version-check \
  torch transformers peft safetensors gguf sentencepiece protobuf

echo "=== 3/5 merge the LoRA into $BASE_ID ==="
if [ -d "$MERGED" ]; then
  echo "    $MERGED exists, skipping"
else
  "$VENV/bin/python" - "$CKPT" "$MERGED" "$BASE_ID" <<'PY'
import sys, torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

ckpt, out, base_id = sys.argv[1], sys.argv[2], sys.argv[3]
print(f"[merge] base={base_id}\n[merge] adapter={ckpt}", flush=True)
# CPU on purpose: MPS buys nothing for a one-shot weight addition and has
# tripped over large contiguous allocations before on this machine.
model = AutoModelForCausalLM.from_pretrained(
    base_id, torch_dtype=torch.float16, device_map="cpu", low_cpu_mem_usage=True)
model = PeftModel.from_pretrained(model, ckpt, device_map="cpu")
model = model.merge_and_unload()
model.save_pretrained(out, safe_serialization=True)
# Tokenizer from the CHECKPOINT, never the hub: training can add tokens, and a
# tokenizer that disagrees with the weights produces fluent nonsense, not an
# error. Fall back to the hub only if the checkpoint carries none.
try:
    AutoTokenizer.from_pretrained(ckpt).save_pretrained(out)
    print("[merge] tokenizer from checkpoint", flush=True)
except Exception:
    AutoTokenizer.from_pretrained(base_id).save_pretrained(out)
    print("[merge] tokenizer from hub (checkpoint had none)", flush=True)
print(f"[merge] wrote {out}", flush=True)
PY
fi

echo "=== 4/5 convert to GGUF ==="
if [ ! -d "$LLAMA_CPP" ]; then
  # Only the python converter is used; nothing is compiled.
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP"
fi
if [ -f "$GGUF" ]; then
  echo "    $GGUF exists, skipping"
else
  "$VENV/bin/python" "$LLAMA_CPP/convert_hf_to_gguf.py" "$MERGED" \
    --outfile "$GGUF" --outtype f16
fi
ls -lh "$GGUF"

echo "=== 5/5 import into Ollama ${QUANT:+(quantizing to $QUANT)} ==="
cat > "$WORK/Modelfile.$NAME" <<EOF
FROM $GGUF

# No TEMPLATE on purpose. BookForge sends the fully-templated prompt with
# raw:true, because training used Qwen3's template with thinking DISABLED,
# which inserts an empty <think></think> block Ollama's stock template omits.
# Templating here would silently feed the model a shape it never saw.
PARAMETER temperature 0
PARAMETER stop <|im_end|>
EOF
if [ -n "$QUANT" ]; then
  ollama create "$NAME" --quantize "$QUANT" -f "$WORK/Modelfile.$NAME"
else
  ollama create "$NAME" -f "$WORK/Modelfile.$NAME"
fi

echo
echo "Done. In BookForge: Detect mode -> Ollama (local), model \"$NAME\"."
echo "Intermediates left in $WORK (merged + f16 gguf, ~16 GB) — safe to delete:"
echo "  rm -rf $MERGED $GGUF"
