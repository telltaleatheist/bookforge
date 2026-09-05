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
#   (default) create the env if absent, install the pins if absent, install
#             narrator's runtime imports if any are missing, apply both patches,
#             deploy the launcher and the deploy profile. Every step whose work
#             is already done is skipped, so re-running after a partial failure
#             resumes — with TWO deliberate exceptions: the launcher (section 5)
#             and higgs_default_frames7500.yaml (section 5b) are copied EVERY
#             time, because "only if absent" made the env's copy a snapshot of
#             the day it was built and every later fix to those files shipped in
#             the repo and was read by nobody.
#
# It is NEVER run automatically. Higgs is a GPU engine whose install downloads
# many GB and whose server preallocates ~24 GB of VRAM; that starts because a
# person pressed a button in Settings → Higgs.
#
# ── The two patches are not optional ────────────────────────────────────────
#
# Without patch_vllm.py, every voice-clone request returns HTTP 400 and only the
# model's own default speaker can serve. Without patch_sentinel_filter.py, every
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

# Where a VOICE lives: one MERGED checkpoint directory per voice, mirroring the
# Orpheus models dir. ~8.5 GB each, because vllm-omni has no runtime LoRA path —
# a fine-tune is merged into a full checkpoint before it can serve, and the
# server is started ON that directory. This script does not populate it (a voice
# arrives from a training run, not from an installer); it is stated here because
# it is the convention the catalog's checkpointDir paths follow.
HIGGS_MODELS_DIR="${HIGGS_MODELS_DIR:-$HOME/higgs-models}"

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
  bad "patch:higgs-sentinel-filter=absent"
  bad "narrator-deps=absent"
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
# grep -qF, FIXED STRING: the absent-marker is `[:, :-1]`, which as a basic
# regular expression is a bracket expression matching a single character out of a
# set and would match nearly every line.
check_patch() {  # id  relpath  marker  [absent-marker]
  local id="$1" rel="$2" marker="$3" absent="${4:-}"
  local f
  f=$(ls "$ENV_PREFIX"/lib/python*/site-packages/"$rel" 2>/dev/null | head -1)
  if [ -z "$f" ]; then bad "patch:$id=absent"; return 2; fi
  if ! grep -qF "$marker" "$f"; then bad "patch:$id=unpatched"; return 1; fi
  if [ -n "$absent" ] && grep -qF "$absent" "$f"; then
    # Marker present AND the string the patch removes still there: half-applied
    # or stacked, which is not patched.
    bad "patch:$id=trim-survived"; return 3
  fi
  say "patch:$id=ok"; return 0
}

check_patch vllm-negative-token-id \
  "vllm/v1/engine/input_processor.py" "min_input_id != -100"
p1=$?
check_patch higgs-sentinel-filter \
  "vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py" \
  "_filter_sentinel_frames" "[:, :-1]"
p2=$?

if [ "$CHECK_ONLY" = "0" ]; then
  if [ "$p1" != "0" ]; then
    echo "== applying patch_vllm.py =="
    "$PY" "$SCRIPT_DIR/patch_vllm.py" "$ENV_PREFIX" || exit 13
  fi
  if [ "$p2" != "0" ]; then
    echo "== applying patch_sentinel_filter.py =="
    "$PY" "$SCRIPT_DIR/patch_sentinel_filter.py" "$ENV_PREFIX" || exit 13
  fi
fi

# ── 4b. narrator's own runtime imports ──────────────────────────────────────
# THE ENV NEEDS THESE BECAUSE NARRATOR IS NOT PIP-INSTALLED INTO IT. narrator
# reaches this env over PYTHONPATH (electron/narrator-spawn.ts), so nothing ever
# resolves its dependency list here — and Owen's first in-app Higgs prep died
# with `ModuleNotFoundError: No module named 'bs4'` for exactly that reason
# (2026-09-05). The list, its provenance and the reason each row carries an
# `# import:` annotation are in the file itself; the doctor builds its probe
# from THE SAME rows (electron/tool-paths.ts narratorRuntimeDeps), so a
# dependency added there is installed and checked together.
REQ_FILE="$SCRIPT_DIR/requirements-narrator-runtime.txt"
if [ ! -f "$REQ_FILE" ]; then
  bad "narrator-deps=list-missing"
  if [ "$CHECK_ONLY" = "0" ]; then
    echo "requirements-narrator-runtime.txt is not beside this script ($REQ_FILE)." >&2
    exit 16
  fi
else
  # The module names, from the `# import:` annotations on the REQUIREMENT rows.
  # Whole-line comments are dropped FIRST: the file documents its own format in
  # a comment that contains the words `# import:`, and a parser that matched it
  # would probe a module called "<module".
  #
  # One python, one answer: find_spec asks "is it importable" without paying the
  # import, which is what the failure being prevented actually is.
  NARRATOR_ROWS=$(grep -v '^[[:space:]]*#' "$REQ_FILE" | grep -c '[^[:space:]]' || true)
  NARRATOR_MODULES=$(grep -v '^[[:space:]]*#' "$REQ_FILE" \
    | sed -n 's/.*#[[:space:]]*import:[[:space:]]*\([^[:space:]]*\).*/\1/p' | tr '\n' ' ')
  NARRATOR_COUNT=$(echo $NARRATOR_MODULES | wc -w)
  if [ "$NARRATOR_ROWS" != "$NARRATOR_COUNT" ]; then
    # EVERY ROW MUST SAY WHAT IT IMPORTS. `beautifulsoup4` imports as `bs4`,
    # `pillow` as `PIL`, `iso639-lang` as `iso639` — a row without its
    # annotation is a package that gets installed and never verified.
    bad "narrator-deps=list-unannotated"
    if [ "$CHECK_ONLY" = "0" ]; then
      echo "$REQ_FILE has $NARRATOR_ROWS requirement row(s) and $NARRATOR_COUNT '# import:' annotation(s)." >&2
      echo "Every row must carry one — see the header of that file." >&2
      exit 16
    fi
  else
    # shellcheck disable=SC2086
    MISSING=$("$PY" -c 'import importlib.util as u,sys;print(",".join([m for m in sys.argv[1:] if u.find_spec(m) is None]))' $NARRATOR_MODULES 2>/dev/null)
    if [ -z "$MISSING" ]; then
      say "narrator-deps=ok"
    else
      bad "narrator-deps=$MISSING"
      if [ "$CHECK_ONLY" = "0" ]; then
        echo "== installing narrator's runtime imports ($MISSING) =="
        "$PY" -m pip install -r "$REQ_FILE" || exit 16
        # shellcheck disable=SC2086
        STILL=$("$PY" -c 'import importlib.util as u,sys;print(",".join([m for m in sys.argv[1:] if u.find_spec(m) is None]))' $NARRATOR_MODULES 2>/dev/null)
        if [ -n "$STILL" ]; then
          echo "still not importable after pip install: $STILL" >&2
          exit 16
        fi
        say "narrator-deps=installed"
      fi
    fi
  fi
fi

# ── 5. the launcher, deployed INTO the env ──────────────────────────────────
# Inside the env on purpose: it makes the serving stack self-contained, so
# nothing at run time reaches back into the BookForge install (or, historically,
# into E:\training) to find out how to start the server.
#
# ALWAYS COPIED, NEVER "ONLY IF ABSENT". It used to be the second, and that made
# the env's copy a SNAPSHOT of whatever the script said the day the env was
# first built: every later fix — the --stage-overrides split that stopped the
# codec stage reserving a second 0.60 of the card, the $HIGGS_CODEC_GPU_MEM_UTIL
# and $HIGGS_DEPLOY_CONFIG knobs BookForge now sets — shipped in the repo and
# was read by nobody, while the doctor's `test -x` reported the stale copy as
# ok. It is our file, the copy is idempotent, and it costs 7 kB.
if [ "$CHECK_ONLY" = "1" ]; then
  # --check WRITES NOTHING. Three distinct answers, because they send a person
  # to three different places: no launcher at all, a launcher that is not the
  # one this build ships (re-run the installer), and a match.
  if [ ! -x "$ENV_PREFIX/bin/serve_higgs_v3.sh" ]; then
    bad "launcher=absent"
  elif ! cmp -s "$SCRIPT_DIR/serve_higgs_v3.sh" "$ENV_PREFIX/bin/serve_higgs_v3.sh"; then
    bad "launcher=stale"
  else
    say "launcher=ok"
  fi
else
  cp "$SCRIPT_DIR/serve_higgs_v3.sh" "$ENV_PREFIX/bin/serve_higgs_v3.sh" || exit 14
  chmod +x "$ENV_PREFIX/bin/serve_higgs_v3.sh" || exit 14
  say "launcher=installed"
fi

# ── 5b. the deploy profile, deployed BESIDE the launcher ────────────────────
# higgs_default_frames7500.yaml is byte-identical to vllm-omni 0.28.0's own
# deploy/higgs_multimodal_qwen3.yaml EXCEPT stage 0's
# default_sampling_params.max_tokens, 2048 -> 7500.
#
# WHY IT SHIPS AT ALL: the served speech endpoint IGNORES a per-request
# max_tokens, so that profile value is a HARD CEILING on every render — 2048
# frames is 81.92 s of audio and a chunk needing more is cut mid-sentence
# (MEASURED 2026-09-05, owens-pc). 7500 frames is 300 s.
#
# NOT WRITTEN INTO site-packages, which is the other way to raise it: a pip
# upgrade in this env would revert that silently, exactly as it reverts the two
# patches above. A profile FILE passed with --deploy-config survives an upgrade
# and can be hashed, and the doctor's `profile-sha` row hashes it — the training
# side's certificates bind to these bytes, so a drifted copy is a different
# server, not a cosmetic difference.
#
# Same rule as the launcher: ALWAYS COPIED, never "only if absent", and the same
# exit code (14), because a half-deployed env is one failure, not two.
if [ "$CHECK_ONLY" = "1" ]; then
  if [ ! -f "$ENV_PREFIX/bin/higgs_default_frames7500.yaml" ]; then
    bad "profile=absent"
  elif ! cmp -s "$SCRIPT_DIR/higgs_default_frames7500.yaml" "$ENV_PREFIX/bin/higgs_default_frames7500.yaml"; then
    bad "profile=stale"
  else
    say "profile=ok"
  fi
else
  cp "$SCRIPT_DIR/higgs_default_frames7500.yaml" "$ENV_PREFIX/bin/higgs_default_frames7500.yaml" || exit 14
  say "profile=installed"
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

# ── 7. the voices directory ─────────────────────────────────────────────────
# Reported, never fatal: a machine can legitimately have the serving stack and no
# voices yet. The catalog refuses a voice whose checkpoint is absent by name, so
# that failure belongs there and not here.
if [ -d "$HIGGS_MODELS_DIR" ]; then
  say "models-dir=ok"
else
  say "models-dir=absent"
  if [ "$CHECK_ONLY" = "0" ]; then
    mkdir -p "$HIGGS_MODELS_DIR" && say "models-dir=created"
  fi
fi

if [ "$CHECK_ONLY" = "1" ]; then exit $fail; fi
echo "HIGGS_ENV_OK $ENV_PREFIX"
echo "HIGGS_MODELS_DIR $HIGGS_MODELS_DIR"
