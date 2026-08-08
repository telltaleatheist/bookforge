#!/bin/bash
# train-line — stage the ocr LINE corpus to the GPU box and launch its SFT run.
#
#   bash tools/foundry-ocr/train-line.sh              # print every step, change nothing
#   bash tools/foundry-ocr/train-line.sh --preflight  # read-only checks + MEASURE token lengths
#   bash tools/foundry-ocr/train-line.sh --go         # actually stage, merge profiles and TRAIN
#
# (invoked with `bash` because the repo lives on an ExFAT volume, which cannot
#  store the executable bit — git records these as 100644 whatever chmod says)
#
#   env: RUN=ocr_line_v1_06b  SFT=/Volumes/Callisto/training/rubric/ocr/sft-line
#        HOST=owens-pc
#
# IT DOES NOTHING WITHOUT --go, ON PURPOSE. The 3090 Ti is shared, and the box
# has a faulty fan (docs/BLOCKS_TRAINING.md section 6): a run needs the owner's
# explicit green light every time, and a script that trains as a side effect of
# being run is a script that will one day train while someone else's job is on
# the card. Default output is the plan, so the plan can be read and approved.
#
# HEAT. Watch GPU temp for the whole run. ~82 C is normal; at >=86 C throttle NOW
# with `nvidia-smi -pl 270`, and 220 if it is still climbing. Do not leave this
# box running unattended without a temperature monitor.
#
# FOUR PITFALLS ARE BAKED IN because each one has cost a night already:
#   1. conda is NOT on the wsl login PATH  -> source conda.sh explicitly
#   2. the env is `orpheus_train`, not `orpheus_ft`
#   3. global options go BEFORE the `train` subcommand
#   4. NO --merge. Merging needs ~10 GB resident and that box measured 11 GB
#      total with a job in it; merge on the Mac with tools/aligner/blocks-merge-mac.sh
#
# And one more that is specific to staging: pipe the data through ssh STDIN.
# PowerShell mangles anything quoted inline, and WSL kills descendants of a
# closed ssh session, so the training command must run on a LIVE ssh handle
# (start this script itself as a background task; do not nohup/setsid it).
set -euo pipefail

HOST="${HOST:-owens-pc}"
RUN="${RUN:-ocr_line_v1_06b}"
SFT="${SFT:-/Volumes/Callisto/training/rubric/ocr/sft-line}"
REMOTE_DIR="${REMOTE_DIR:-\$HOME/ocr-line}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILES="$REPO_ROOT/tools/foundry-ocr/line-training-profiles.json"
RIG_PROFILES='/mnt/c/Users/tellt/Projects/orpheus-finetune/training_profiles.json'
FINETUNE_DIR='/mnt/c/Users/tellt/Projects/orpheus-finetune'

MODE=plan
case "${1:-}" in
  --go) MODE=go ;;
  --preflight) MODE=preflight ;;
  ''|--plan) MODE=plan ;;
  *) echo "usage: $0 [--plan|--preflight|--go]" >&2; exit 1 ;;
esac

# Run a command inside WSL. The script body goes through STDIN, never inside a
# quoted argument: PowerShell and the ssh command line each get a turn at
# mangling nested quotes, and a sed expression or a grep pattern will not
# survive both. This is the same reason the corpus is staged through stdin.
#
# The exit status is ssh's, NOT the filter's, and that is the whole point of the
# shape below. Piping straight into `grep -v` made the pipeline's status grep's:
# a command whose every output line was a banner — `mkdir -p`, say — left grep
# with nothing to print, so grep exited 1, and under `set -o pipefail` that
# aborted the script mid-flight with no error to read. It aborted --preflight
# before it staged anything and would have aborted --go at the same line. The
# mirror of that bug is worse: a real ssh failure was hidden whenever the banner
# filter still had a line to print.
wsl() {
  local out rc
  out=$(printf '%s\n' "$1" | ssh -o ConnectTimeout=20 "$HOST" "wsl -e bash -lc 'bash -s'" 2>&1)
  rc=$?
  printf '%s\n' "$out" | grep -v "post-quantum\|store now, decrypt later\|may need to be upgraded\|openssh.com/pq" || true
  return $rc
}

echo "=== ocr line SFT ==="
echo "  host      $HOST"
echo "  run       $RUN"
echo "  corpus    $SFT"
echo "  profiles  $PROFILES"
echo "  mode      $MODE"

# ── 1. the corpus must exist and must be the one that was reviewed ──────────
for f in train.jsonl eval.jsonl build-stats.json; do
  [ -f "$SFT/$f" ] || { echo "missing $SFT/$f — run tools/foundry-ocr/build-dataset.py first" >&2; exit 1; }
done
TRAIN_N=$(wc -l < "$SFT/train.jsonl" | tr -d ' ')
EVAL_N=$(wc -l < "$SFT/eval.jsonl" | tr -d ' ')
TRAIN_SHA=$(shasum -a 256 "$SFT/train.jsonl" | cut -d' ' -f1)
EVAL_SHA=$(shasum -a 256 "$SFT/eval.jsonl" | cut -d' ' -f1)
echo
echo "  train.jsonl  $TRAIN_N rows  ${TRAIN_SHA:0:16}"
echo "  eval.jsonl   $EVAL_N rows  ${EVAL_SHA:0:16}"
python3 - "$SFT/build-stats.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print(f"  holdouts     {', '.join(s['holdoutBooks'])}")
print(f"  quarantined  {', '.join(s['quarantinedBooks'])}")
print(f"  built        {s['generated']}")
books = [b for b, c in s['books'].items() if c.get('kept')]
print(f"  books        {len(books)}")
PY

if [ "$MODE" = plan ]; then
  cat <<EOF

--- nothing has been changed. To proceed: ---

  1. read-only checks + token-length measurement (safe, no GPU):
       $0 --preflight

  2. with the owner's explicit green light, and a temperature monitor running:
       RUN=$RUN $0 --go

  What --go will do, in order:
    a. back up the rig's training_profiles.json, then merge in
       tools/foundry-ocr/line-training-profiles.json
    b. pipe train.jsonl / eval.jsonl through ssh stdin into $REMOTE_DIR
       and verify sha256 on both sides
    c. launch, on a live ssh handle:
         python orpheus_owen.py --profile $RUN \\
           --train-data $REMOTE_DIR/train.jsonl \\
           --eval-data  $REMOTE_DIR/eval.jsonl \\
           --run-name $RUN --out-base /home/telltale/xtts_ft train
    d. NOT merge. Merge on the Mac: tools/aligner/blocks-merge-mac.sh

  Afterwards, judge it with tools/foundry-ocr/eval-line.py and read \`degraded\` first.
EOF
  exit 0
fi

# ── 2. read-only state of the box ───────────────────────────────────────────
echo
echo "=== GPU box (read-only) ==="
wsl 'echo "  wsl ok"
nvidia-smi --query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader
df -h "$HOME" | tail -1
echo "  conda:"
source ~/anaconda3/etc/profile.d/conda.sh && conda env list | grep orpheus_train'

if [ "$MODE" = preflight ]; then
  echo
  echo "=== token lengths, MEASURED with the real tokenizer ==="
  echo "  text_sft refuses to truncate, so one row over max_seq_length kills the"
  echo "  run partway through. Measure, then set max_seq_length above the max."
  # The corpus has to be on the box to measure it there; stage it first, which
  # is harmless and is a step --go would do anyway.
  wsl "mkdir -p $REMOTE_DIR"
  ssh "$HOST" "wsl -e bash -lc 'cat > $REMOTE_DIR/train.jsonl'" < "$SFT/train.jsonl"
  cat > /tmp/ocr-measure.py <<'PY'
import json, os, sys
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(os.environ.get('BASE', 'Qwen/Qwen3-0.6B'))
lens = []
for line in open(sys.argv[1]):
    if not line.strip():
        continue
    m = json.loads(line)['messages']
    text = tok.apply_chat_template(m, tokenize=False, enable_thinking=False)
    lens.append(len(tok(text).input_ids))
lens.sort()
n = len(lens)
print(f'  rows {n}  p50 {lens[n//2]}  p99 {lens[int(n*0.99)]}  max {lens[-1]}')
print(f'  -> set max_seq_length comfortably above {lens[-1]}')
PY
  cat /tmp/ocr-measure.py | ssh "$HOST" "wsl -e bash -lc 'cat > /tmp/ocr-measure.py && source ~/anaconda3/etc/profile.d/conda.sh && conda activate orpheus_train && python /tmp/ocr-measure.py $REMOTE_DIR/train.jsonl'"
  echo
  echo "preflight done. Nothing was trained. Re-run with --go once the owner says go."
  exit 0
fi

# ── 3. --go: profiles, staging, launch ──────────────────────────────────────
echo
echo "=== merging profiles into the rig (backup first) ==="
BAK="training_profiles.json.bak-pre-$RUN"
wsl "cp $RIG_PROFILES $FINETUNE_DIR/$BAK && echo '  backed up to $BAK'"
python3 - "$PROFILES" > /tmp/ocr-line-profiles.json <<'PY'
import json, sys
print(json.dumps(json.load(open(sys.argv[1]))['profiles']))
PY
cat > /tmp/ocr-merge.py <<'PY'
import json, sys
rig_path, add_path = sys.argv[1], sys.argv[2]
rig = json.load(open(rig_path))
add = json.load(open(add_path))
target = rig['profiles'] if 'profiles' in rig else rig
for k, v in add.items():
    target[k] = v
    print(f'  + {k}')
json.dump(rig, open(rig_path, 'w'), indent=1)
PY
cat /tmp/ocr-line-profiles.json | ssh "$HOST" "wsl -e bash -lc 'cat > /tmp/ocr-add.json'"
cat /tmp/ocr-merge.py | ssh "$HOST" "wsl -e bash -lc 'cat > /tmp/ocr-merge.py && python3 /tmp/ocr-merge.py $RIG_PROFILES /tmp/ocr-add.json'"

echo
echo "=== staging corpus ==="
wsl "mkdir -p $REMOTE_DIR"
for f in train.jsonl eval.jsonl; do
  ssh "$HOST" "wsl -e bash -lc 'cat > $REMOTE_DIR/$f'" < "$SFT/$f"
done
echo "  local  train $TRAIN_SHA"
echo "  local  eval  $EVAL_SHA"
wsl "sha256sum $REMOTE_DIR/train.jsonl $REMOTE_DIR/eval.jsonl | sed 's/^/  remote /'"
echo "  ^ the two sides must match. If they do not, STOP; a truncated corpus trains silently."

echo
echo "=== launching $RUN ==="
echo "  KEEP THIS SSH HANDLE ALIVE. WSL kills descendants of a closed session;"
echo "  nohup and setsid do not help. Run this script as a background task."
echo "  Watch the temperature. >=86 C -> nvidia-smi -pl 270."
ssh "$HOST" "wsl -e bash -lc 'source ~/anaconda3/etc/profile.d/conda.sh && \
  conda activate orpheus_train && cd $FINETUNE_DIR && \
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python orpheus_owen.py \
  --profile $RUN \
  --train-data $REMOTE_DIR/train.jsonl \
  --eval-data  $REMOTE_DIR/eval.jsonl \
  --run-name $RUN --out-base /home/telltale/xtts_ft train \
  2>&1 | tee $REMOTE_DIR/train_$RUN.log'"

cat <<EOF

=== done training. NOT merged, on purpose. ===
  1. merge on the Mac:   tools/aligner/blocks-merge-mac.sh   (best checkpoint by
     highest step number — an early checkpoint names itself, the last names the winner)
  2. serve the GGUF on llama-server, port 8771
  3. score:  python3 tools/foundry-ocr/eval-line.py --endpoint http://localhost:8771
     Read \`degraded\` first. trainer_state.json is authoritative, never the log tail.
  4. clear the WSL staging: it is a staging ground, never a master.
EOF
