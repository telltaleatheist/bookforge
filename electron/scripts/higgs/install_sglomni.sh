#!/bin/bash
#
# Build (or verify) the WSL conda environment that serves Higgs Audio v3 under
# SGLang-Omni — the SECOND serving stack.
#
# ── A SEPARATE ENV, AND IT NEVER TOUCHES higgs3 ─────────────────────────────
#
# The two stacks cannot share one environment and it is not close: higgs3 is
# python 3.11 with vllm 0.28.0, and this is python 3.12 with sglang 0.5.18 +
# sglang-omni 0.1.4 (which pull their own torch 2.13.0+cu130 and flashinfer
# 0.6.17). Installing either into the other's env replaces the resolver's answer
# for torch and breaks both. So this script names its own prefix, and the
# campaign script it is transcribed from says the same thing in its first line:
# "Never touches higgs3."
#
# ── What this reproduces ────────────────────────────────────────────────────
#
# The `sglomni` env on owens-pc, built 2026-09-05 by the training session
# (E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\night3\sgl\
# install_sglomni.sh + fix_flashinfer.sh + fix_cuda_links.sh), against which the
# night-3 comparison was measured: 0 early stops, 5/50 damaged, 0 sustained
# voice switches and 26,666 chars/min at 16 in flight, against vllm-omni's 4
# early stops, 13/50 damaged, 6 switches and 10,752 chars/min on the same 50
# chunks and the same checkpoint.
#
# ── THE THREE STEPS THAT ARE NOT `pip install` ──────────────────────────────
#
# flashinfer JIT-builds its kernels with nvcc, and on this box the only nvcc is
# the CUDA 13 one inside the pip wheel. It works, but only once the wheel's
# directory looks like a CUDA toolkit:
#
#   1. CUDA_HOME must point at <env>/lib/python3.12/site-packages/nvidia/cu13
#      (the launcher does this; it is stated here because the two must agree).
#   2. `lib64 -> lib` — the build looks for lib64 and the wheel ships lib.
#   3. `libcudart.so -> libcudart.so.13` — the linker wants the unversioned name.
#
# and the prebuilt `flashinfer-jit-cache` wheel for cu130 saves compiling the
# common kernels at every server start. All four are done below.
#
# ── IDEMPOTENT, AND IT NEVER TOUCHES A RUNNING ENV WITHOUT BEING TOLD TO ────
#
#   --check   probe only. Prints one `key=value` line per step and exits 0/1.
#             Reads nothing, writes nothing, installs nothing. This is the mode
#             BookForge's doctor and CI run.
#   (default) create the env if absent, install the pins if absent, install
#             narrator's runtime imports if any are missing, make the two CUDA
#             symlinks, and deploy the launcher. Every step whose work is already
#             done is skipped — with ONE deliberate exception: the launcher is
#             copied EVERY time, for the same reason serve_higgs_v3.sh is (an
#             "only if absent" copy makes the env's launcher a snapshot of the
#             day it was built and every later fix is read by nobody).
#
# THERE ARE NO SITE-PACKAGES PATCHES ON THIS STACK. The two the vllm-omni env
# needs (the negative-token-id fix and the sentinel filter) are fixes to
# vllm/vllm_omni; SGLang-Omni has its own stage processor and needs neither,
# which is why BookForge's doctor reports no patch rows here. That is a real
# difference between the stacks, not an omission.
#
# It is NEVER run automatically: the install downloads many GB and the server it
# builds preallocates ~19 GB of VRAM. It starts because a person pressed a button
# in Settings → Higgs.
#
# Usage:  install_sglomni.sh [--check] [--env-name NAME] [--conda PATH]
set -uo pipefail

CHECK_ONLY=0
ENV_NAME="sglomni"
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
SITE="$ENV_PREFIX/lib/python3.12/site-packages"
CU13="$SITE/nvidia/cu13"

# The load-bearing pins, captured from the reference env. sglang-omni 0.1.4 is
# what implements the higgs_tts pipeline; everything else (sglang 0.5.18, torch
# 2.13.0+cu130, flashinfer 0.6.17) comes with it, and the flashinfer JIT CACHE is
# a separate wheel from a separate index that must match the CUDA build.
#
# --prerelease=allow AND uv: the reference install used both. sglang-omni's
# dependency set does not resolve with plain pip's strategy at the time of
# writing, and the campaign's script is what the measurements were taken against.
PIN_SGLANG_OMNI="sglang-omni==0.1.4"
PIN_JIT_CACHE="flashinfer-jit-cache==0.6.17"
JIT_CACHE_INDEX="https://flashinfer.ai/whl/cu130/"
LAUNCHER="serve_higgs_sgl.sh"

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
    echo "== creating conda env $ENV_NAME (python 3.12) =="
    "$CONDA_BIN" create -y -p "$ENV_PREFIX" python=3.12 || exit 11
    say "env=created"
  fi
fi

# Everything below needs the interpreter. In --check mode a missing env means the
# remaining probes cannot run; report them as absent rather than skipping, so the
# caller sees a complete picture instead of a truncated one.
if [ ! -x "$PY" ]; then
  bad "sgl-omni=absent"
  bad "cuda-links=absent"
  bad "narrator-deps=absent"
  bad "launcher=absent"
  bad "weights=absent"
  exit $fail
fi

# ── 3. the serving stack ────────────────────────────────────────────────────
if "$PY" -c 'import sglang_omni' >/dev/null 2>&1; then
  say "sgl-omni=ok"
else
  bad "sgl-omni=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "== installing the serving stack (expect 10-20 min: torch 2.13 cu130 + sglang + flashinfer) =="
    "$PY" -m pip install --upgrade pip || exit 12
    "$PY" -m pip install uv || exit 12
    "$ENV_PREFIX/bin/uv" pip install --python "$PY" --prerelease=allow "$PIN_SGLANG_OMNI" || exit 12
    # The prebuilt JIT cache for cu130. WITHOUT IT the server still starts, but
    # flashinfer compiles its kernels with nvcc on the first request of every
    # cold start. It is a separate index because flashinfer publishes per-CUDA
    # wheels there and PyPI carries none of them.
    "$PY" -m pip install "$PIN_JIT_CACHE" --index-url "$JIT_CACHE_INDEX" || exit 12
    "$PY" -c 'import sglang_omni, sglang, torch; print("sglang-omni", sglang_omni.__version__, "sglang", sglang.__version__, "torch", torch.__version__)' || exit 12
    say "sgl-omni=installed"
  fi
fi

# ── 4. the two CUDA symlinks flashinfer's nvcc build needs ──────────────────
# `lib64 -> lib` and `libcudart.so -> libcudart.so.13`, inside the pip CUDA 13
# wheel that CUDA_HOME points at. Without them the JIT build fails and the server
# comes up (slowly) on fallback kernels or not at all.
if [ -d "$CU13" ] && [ -e "$CU13/lib64" ] && [ -e "$CU13/lib/libcudart.so" ]; then
  say "cuda-links=ok"
else
  bad "cuda-links=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    if [ ! -d "$CU13" ]; then
      echo "No pip CUDA 13 toolkit at $CU13 — the serving stack is not installed." >&2
      exit 13
    fi
    ( cd "$CU13" && { [ -e lib64 ] || ln -s lib lib64; } ) || exit 13
    ( cd "$CU13/lib" && for so in libcudart libnvrtc; do
        v=$(ls "$so".so.* 2>/dev/null | head -1)
        [ -n "$v" ] && [ ! -e "$so.so" ] && ln -s "$v" "$so.so"
        true
      done ) || exit 13
    say "cuda-links=installed"
  fi
fi

# ── 5. narrator's own runtime imports ───────────────────────────────────────
# narrator is NOT pip-installed into this env — it arrives over PYTHONPATH — so
# nothing else resolves its dependency list here, and a prep or a worker that
# cannot import bs4 dies at the first document. The list is
# requirements-narrator-runtime.txt, the SAME file the vllm-omni installer
# installs and the doctor probes, with its `# import:` annotations naming the
# module each requirement actually provides.
REQ="$SCRIPT_DIR/requirements-narrator-runtime.txt"
if [ ! -f "$REQ" ]; then
  bad "narrator-deps=absent"
  echo "requirements-narrator-runtime.txt is missing from $SCRIPT_DIR" >&2
  exit 15
fi
MODULES=$(sed -e 's/\r$//' "$REQ" | grep -v '^[[:space:]]*#' | grep -o 'import:[[:space:]]*[^[:space:]]*' | sed 's/import:[[:space:]]*//')
MISSING=$("$PY" -c 'import importlib.util as u,sys;print(",".join([m for m in sys.argv[1:] if u.find_spec(m) is None]))' $MODULES 2>/dev/null)
if [ -z "$MISSING" ]; then
  say "narrator-deps=ok"
else
  bad "narrator-deps=$MISSING"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "== installing narrator's runtime imports =="
    "$PY" -m pip install -r "$REQ" || exit 15
    say "narrator-deps=installed"
  fi
fi

# ── 6. the launcher, deployed INTO the env ──────────────────────────────────
# Inside the env on purpose: it makes the serving stack self-contained, so
# nothing at run time reaches back into the BookForge install to find out how to
# start the server. ALWAYS COPIED, never "only if absent" — see the note on
# install_higgs_env.sh section 5 for what that cost the other stack.
if [ "$CHECK_ONLY" = "1" ]; then
  if [ ! -x "$ENV_PREFIX/bin/$LAUNCHER" ]; then
    bad "launcher=absent"
  elif ! cmp -s "$SCRIPT_DIR/$LAUNCHER" "$ENV_PREFIX/bin/$LAUNCHER"; then
    bad "launcher=stale"
  else
    say "launcher=ok"
  fi
else
  cp "$SCRIPT_DIR/$LAUNCHER" "$ENV_PREFIX/bin/$LAUNCHER" || exit 14
  chmod +x "$ENV_PREFIX/bin/$LAUNCHER" || exit 14
  say "launcher=installed"
fi

# ── 7. the weights ──────────────────────────────────────────────────────────
# REPORTED, NEVER DOWNLOADED HERE. The base snapshot is ~17 GB and a machine can
# legitimately be mid-download; the launcher refuses at start time if neither a
# HIGGS_MODEL_DIR nor a cached snapshot is there. A fine-tuned voice is a MERGED
# checkpoint directory that arrives from a training run, not from an installer.
if ls -d "$HOME"/.cache/huggingface/hub/models--bosonai--higgs-audio-v3-tts-4b/snapshots/*/ >/dev/null 2>&1; then
  say "weights=ok"
else
  say "weights=absent"
fi

if [ "$CHECK_ONLY" = "1" ]; then exit $fail; fi
echo "SGLOMNI_ENV_OK $ENV_PREFIX"
exit 0
