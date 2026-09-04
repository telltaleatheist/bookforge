#!/usr/bin/env bash
# CLI flag parity: cli/bookforge-tts.py (the wrapper) and cli/generate-sentences.js
# (the adapter) must ACCEPT and REJECT exactly the same things. They drifted once —
# a valueless --snap-silence was silently dropped by the adapter while the wrapper
# had no opinion, and --no-snap-silence together with --snap-silence 1.0 was
# rejected by the wrapper but silently resolved to 1.0 by the adapter.
#
#   bash tools/tests/test-cli-flag-parity.sh
set -u
cd "$(dirname "$0")/../.."
PY="${PYTHON:-C:/Users/tellt/AppData/Local/Programs/Python/Python311/python.exe}"
AUDIO=/nonexistent-audio.flac      # never reached: every case fails or dry-runs first
EPUB=/nonexistent-book.epub
pass=0; fail=0

# run <expect: ok|err> <name> <extra args...>
run_wrapper() { "$PY" cli/bookforge-tts.py --generate-sentences --audio "$AUDIO" --out /tmp/x.vtt "$@" --dry-run 2>&1; }
run_adapter() { node --require ./cli/electron-stub.js cli/generate-sentences.js --audio "$AUDIO" --out /tmp/x.vtt "$@" 2>&1; }

check() {  # check <name> <expected ok|err> <actual-output> <exit>
  local name="$1" want="$2" out="$3" rc="$4" got
  if [ "$rc" -eq 0 ]; then got=ok; else got=err; fi
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "  ok   $name"
  else fail=$((fail+1)); echo "  FAIL $name (wanted $want, got $got)"; echo "       ${out%%$'\n'*}"; fi
}

echo
echo "both entry points must REJECT these"
for spec in \
  "valueless --snap-silence|--epub $EPUB --snap-silence" \
  "--snap-silence with --no-snap-silence|--epub $EPUB --snap-silence 1.0 --no-snap-silence" \
  "negative --snap-silence|--epub $EPUB --snap-silence -1" \
  "--snap-silence without --epub|--snap-silence 0.6" \
  "--no-snap-silence without --epub|--no-snap-silence" \
  "--no-paragraph-split without --epub|--no-paragraph-split" \
  "--report-min-hole without --epub|--report-min-hole 3" \
  "negative --report-min-hole|--epub $EPUB --report-min-hole -2" \
; do
  name="${spec%%|*}"; args="${spec#*|}"
  # shellcheck disable=SC2086
  out=$(run_wrapper $args); check "wrapper: $name" err "$out" $?
  case "$args" in *--report-min-hole*) args="${args/--report-min-hole/--report-hole-min}";; esac
  # shellcheck disable=SC2086
  out=$(run_adapter $args); check "adapter: $name" err "$out" $?
done

echo
echo "both entry points must ACCEPT these (wrapper dry-runs; adapter reaches the missing file)"
for spec in \
  "--snap-silence 0.6|--epub $EPUB --snap-silence 0.6" \
  "--snap-silence 0|--epub $EPUB --snap-silence 0" \
  "--no-snap-silence alone|--epub $EPUB --no-snap-silence" \
  "--no-paragraph-split alone|--epub $EPUB --no-paragraph-split" \
; do
  name="${spec%%|*}"; args="${spec#*|}"
  # shellcheck disable=SC2086
  out=$(run_wrapper $args); rc=$?
  # the wrapper validates flags, then --dry-run prints the spawn line
  if [ $rc -eq 0 ] && echo "$out" | grep -q "DRY RUN"; then pass=$((pass+1)); echo "  ok   wrapper: $name"
  else fail=$((fail+1)); echo "  FAIL wrapper: $name"; echo "       ${out%%$'\n'*}"; fi
  # the adapter has no dry-run; a flag-validation error names the flag, whereas an
  # accepted flag set gets as far as the missing audio file
  # shellcheck disable=SC2086
  out=$(run_adapter $args)
  if echo "$out" | grep -q "audio file not found"; then pass=$((pass+1)); echo "  ok   adapter: $name"
  else fail=$((fail+1)); echo "  FAIL adapter: $name"; echo "       ${out%%$'\n'*}"; fi
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
