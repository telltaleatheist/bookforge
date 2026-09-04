#!/bin/bash
#
# Build (or verify) the WSL conda environment that serves Higgs Audio v3.
#
# ── What this reproduces ────────────────────────────────────────────────────
#
# The `higgs3` env on owens-pc, built 2026-09-04 by the orpheus-training session
# (E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\setup_higgs3.sh +
# install_vllm.sh), against which every measurement in
# electron/data/higgs-models.json was taken. The pins below were captured from
# that env's own `pip freeze`, not guessed.
#
# ── IDEMPOTENT, AND IT NEVER TOUCHES A RUNNING ENV WITHOUT BEING TOLD TO ────
#
#   --check   probe only. Prints one `key=value` line per step and exits 0/1.
#             Reads nothing, writes nothing, installs nothing. This is the mode
#             BookForge's doctor and CI run.
#   (default) create the env if absent, install the pins if absent, apply both
#             patches, deploy the launcher. Every step is skipped when it is
#             already done, so re-running after a partial failure resumes.
#
# It is NEVER run automatically. Higgs is a GPU engine whose install downloads
# many GB and whose server preallocates ~24 GB of VRAM; that starts because a
# person pressed a button in Settings → Higgs.
#
# ── The two patches are not optional ────────────────────────────────────────
#
# Without patch_vllm.py, every voice-clone request returns HTTP 400 and only the
# model's own default speaker can serve. Without patch_tail_trim.py, every
# rendered chunk ends with ~240 ms of audible garbage. BOTH MUST BE RE-APPLIED
# AFTER ANY PIP UPGRADE IN THIS ENV — an upgrade replaces the site-packages file
# and silently reverts the patch, which is why the doctor greps for their markers
# on every check rather than trusting a "we installed it once" flag.
#
# Usage:  install_higgs_env.sh [--check] [--env-name NAME] [--conda PATH]
set -uo pipefail

CHECK_ONLY=0
ENV_NAME="higgs3"
CONDA_BIN="${CONDA_BIN:-$HOME/anaconda3/bin/conda}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --env-name) ENV_NAME="$2"; shift 2 ;;
    --conda) CONDA_BIN="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

CONDA_BASE="${CONDA_BIN%/bin/conda}"
ENV_PREFIX="$CONDA_BASE/envs/$ENV_NAME"
PY="$ENV_PREFIX/bin/python"

# The load-bearing pins, captured from the reference env's pip freeze. torch,
# vllm and vllm-omni are the three whose versions the measurements depend on:
# vllm-omni 0.28.0 is what implements the higgs_audio_v3 talker, vllm 0.28.0 is
# the engine it runs inside (and the one both patches are written against), and
# torch 2.13.0 is the cu130 build the whole stack is compiled for.
#
# NO --index-url. The reference install did not pass one: `pip install vllm-omni`
# resolved torch 2.13.0 (cu130) straight from PyPI as a transitive dependency.
# Adding a torch index here would be inventing a step the measured env never took.
PIN_VLLM_OMNI="vllm-omni==0.28.0"
PIN_VLLM="vllm==0.28.0"
PIN_TORCH="torch==2.13.0"
HF_MODEL="bosonai/higgs-audio-v3-tts-4b"

fail=0
say() { echo "$1"; }
bad() { echo "$1"; fail=1; }

# ── 1. conda ────────────────────────────────────────────────────────────────
if [ -x "$CONDA_BIN" ]; then
  say "conda=ok"
else
  bad "conda=absent"
  if [ "$CHECK_ONLY" = "1" ]; then exit 1; fi
  echo "No conda at $CONDA_BIN. Set it in Settings → Add-ons (WSL Conda Path)." >&2
  exit 10
fi

# ── 2. the environment ──────────────────────────────────────────────────────
if [ -d "$ENV_PREFIX" ]; then
  say "env=ok"
else
  bad "env=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "== creating conda env $ENV_NAME (python 3.11) =="
    "$CONDA_BIN" create -y -n "$ENV_NAME" python=3.11 || exit 11
    say "env=created"
  fi
fi

# Everything below needs the interpreter. In --check mode a missing env means the
# remaining probes cannot run; report them as absent rather than skipping, so the
# caller sees a complete picture instead of a truncated one.
if [ ! -x "$PY" ]; then
  bad "vllm-omni=absent"
  bad "patch:vllm-negative-token-id=absent"
  bad "patch:higgs-tail-trim=absent"
  bad "launcher=absent"
  bad "weights=absent"
  exit $fail
fi

# ── 3. the serving stack ────────────────────────────────────────────────────
if "$PY" -c 'import vllm_omni' >/dev/null 2>&1; then
  say "vllm-omni=ok"
else
  bad "vllm-omni=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "== installing the serving stack =="
    "$PY" -m pip install --upgrade pip || exit 12
    # vllm-omni first: it pulls torch/vllm at the versions it was built against.
    # The two explicit pins after it are a GUARD, not a second install — if the
    # resolver moved either, this puts it back to the measured version.
    "$PY" -m pip install "$PIN_VLLM_OMNI" || exit 12
    "$PY" -m pip install "$PIN_VLLM" "$PIN_TORCH" || exit 12
    "$PY" -c 'import vllm_omni, vllm, torch; print("vllm", vllm.__version__, "torch", torch.__version__)' || exit 12
    say "vllm-omni=installed"
  fi
fi

# ── 4. the two patches ──────────────────────────────────────────────────────
# Marker-based, exactly as electron/tool-paths.ts HIGGS_PATCHES checks them, so a
# green run here and a green doctor mean the same thing.
check_patch() {  # id  relpath  marker
  local id="$1" rel="$2" marker="$3"
  local f
  f=$(ls "$ENV_PREFIX"/lib/python*/site-packages/"$rel" 2>/dev/null | head -1)
  if [ -z "$f" ]; then bad "patch:$id=absent"; return 2; fi
  if grep -q "$marker" "$f"; then say "patch:$id=ok"; return 0; fi
  bad "patch:$id=unpatched"; return 1
}

check_patch vllm-negative-token-id \
  "vllm/v1/engine/input_processor.py" "min_input_id != -100"
p1=$?
check_patch higgs-tail-trim \
  "vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py" \
  "_trim_trailing_sentinel_frames"
p2=$?

if [ "$CHECK_ONLY" = "0" ]; then
  if [ "$p1" != "0" ]; then
    echo "== applying patch_vllm.py =="
    "$PY" "$SCRIPT_DIR/patch_vllm.py" "$ENV_PREFIX" || exit 13
  fi
  if [ "$p2" != "0" ]; then
    echo "== applying patch_tail_trim.py =="
    "$PY" "$SCRIPT_DIR/patch_tail_trim.py" "$ENV_PREFIX" || exit 13
  fi
fi

# ── 5. the launcher, deployed INTO the env ──────────────────────────────────
# Inside the env on purpose: it makes the serving stack self-contained, so
# nothing at run time reaches back into the BookForge install (or, historically,
# into E:\training) to find out how to start the server.
if [ -x "$ENV_PREFIX/bin/serve_higgs_v3.sh" ]; then
  say "launcher=ok"
else
  bad "launcher=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    cp "$SCRIPT_DIR/serve_higgs_v3.sh" "$ENV_PREFIX/bin/serve_higgs_v3.sh" || exit 14
    chmod +x "$ENV_PREFIX/bin/serve_higgs_v3.sh" || exit 14
    say "launcher=installed"
  fi
fi

# ── 6. the weights ──────────────────────────────────────────────────────────
# Reported but NOT fatal to --check: the doctor's job is the serving stack, and a
# machine can legitimately be mid-download. The launcher refuses at start time if
# they are still missing, which is where that failure belongs.
if ls -d "$HOME"/.cache/huggingface/hub/models--bosonai--higgs-audio-v3-tts-4b/snapshots/*/ >/dev/null 2>&1; then
  say "weights=ok"
else
  say "weights=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "== downloading $HF_MODEL =="
    "$ENV_PREFIX/bin/hf" download "$HF_MODEL" || exit 15
    say "weights=installed"
  fi
fi

if [ "$CHECK_ONLY" = "1" ]; then exit $fail; fi
echo "HIGGS_ENV_OK $ENV_PREFIX"
