#!/usr/bin/env bash
# CLI flag parity: cli/bookforge-tts.py (the wrapper) and cli/generate-sentences.js
# (the adapter) must ACCEPT and REJECT exactly the same things. They drifted once —
# a valueless --snap-silence was silently dropped by the adapter while the wrapper
# had no opinion, and --no-snap-silence together with --snap-silence 1.0 was
# rejected by the wrapper but silently resolved to 1.0 by the adapter.
#
#   bash tools/tests/test-cli-flag-parity.sh
#
# N5: THE ASSERTIONS MUST NOT BE VACUOUS. An earlier version passed a nonexistent
# --audio, and generate-sentences.js checks the audio file BEFORE any flag — so every
# case, reject and accept alike, exited 1 with "audio file not found", and the suite
# was green without testing anything. So: a real (empty) audio file, so flag
# validation is actually reached, and every case asserts on the MESSAGE, never on the
# exit code alone. The first assertion below guards that property itself.
set -u
cd "$(dirname "$0")/../.."
PY="${PYTHON:-C:/Users/tellt/AppData/Local/Programs/Python/Python311/python.exe}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUDIO="$TMP/audio.flac"; : > "$AUDIO"   # must EXIST; its contents are never read
EPUB="$TMP/missing.epub"                # deliberately absent — see expect_accept_adapter
OUT="$TMP/out.vtt"
pass=0; fail=0

run_wrapper() { "$PY" cli/bookforge-tts.py --generate-sentences --audio "$AUDIO" --out "$OUT" "$@" --dry-run 2>&1; }
run_adapter() { node --require ./cli/electron-stub.js cli/generate-sentences.js --audio "$AUDIO" --out "$OUT" "$@" 2>&1; }

# A rejected case must fail AND say why, matching the expected text.
expect_reject() { # <label> <needle> <output> <rc>
  local label="$1" needle="$2" out="$3" rc="$4"
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi -- "$needle"; then
    pass=$((pass+1)); echo "  ok   $label"
  else
    fail=$((fail+1)); echo "  FAIL $label (rc=$rc, wanted text: $needle)"
    printf '       %s\n' "$(printf '%s' "$out" | head -2)"
  fi
}
# An accepted case must get PAST flag validation. The wrapper proves that by printing
# its DRY RUN line; the adapter, which has no dry-run, proves it by reaching the next
# check in main() — the missing epub — which is only evaluated after every flag has
# been validated.
expect_accept_wrapper() { # <label> <output> <rc>
  local label="$1" out="$2" rc="$3"
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "DRY RUN"; then
    pass=$((pass+1)); echo "  ok   wrapper: $label"
  else
    fail=$((fail+1)); echo "  FAIL wrapper: $label (rc=$rc)"
    printf '       %s\n' "$(printf '%s' "$out" | head -2)"
  fi
}
expect_accept_adapter() { # <label> <output>
  local label="$1" out="$2"
  if printf '%s' "$out" | grep -q "epub file not found"; then
    pass=$((pass+1)); echo "  ok   adapter: $label"
  else
    fail=$((fail+1)); echo "  FAIL adapter: $label (did not reach the post-flag epub check)"
    printf '       %s\n' "$(printf '%s' "$out" | head -2)"
  fi
}

echo
echo "guard: the adapter really does reach flag validation (else everything below is vacuous)"
out=$(run_adapter --epub "$EPUB")
if printf '%s' "$out" | grep -q "epub file not found"; then
  pass=$((pass+1)); echo "  ok   a real --audio gets past the audio-exists check"
else
  fail=$((fail+1)); echo "  FAIL a real --audio still short-circuits — every case below is vacuous"
  printf '       %s\n' "$(printf '%s' "$out" | head -2)"
fi

echo
echo "both entry points must REJECT these, with a message naming the problem"
while IFS='|' read -r label args wneedle aneedle; do
  [ -z "${label// }" ] && continue
  # shellcheck disable=SC2086
  out=$(run_wrapper $args); expect_reject "wrapper: $label" "$wneedle" "$out" $?
  aargs="${args//--report-min-hole/--report-hole-min}"
  # shellcheck disable=SC2086
  out=$(run_adapter $aargs); expect_reject "adapter: $label" "$aneedle" "$out" $?
done <<EOF
valueless --snap-silence|--epub $EPUB --snap-silence|expected one argument|needs a value
--snap-silence with --no-snap-silence|--epub $EPUB --snap-silence 1.0 --no-snap-silence|mutually exclusive|mutually exclusive
negative --snap-silence|--epub $EPUB --snap-silence -1|must be >= 0|must be a number
--snap-silence without --epub|--snap-silence 0.6|require --epub|require --epub
--no-snap-silence without --epub|--no-snap-silence|require --epub|require --epub
--no-paragraph-split without --epub|--no-paragraph-split|requires --epub|requires --epub
--report-min-hole without --epub|--report-min-hole 3|requires --epub|requires --epub
negative --report-min-hole|--epub $EPUB --report-min-hole -2|must be >= 0|must be a number
a value given to a switch|--epub $EPUB --no-paragraph-split=false|ignored explicit argument|takes no value
EOF

echo
echo "both entry points must ACCEPT these"
while IFS='|' read -r label args; do
  [ -z "${label// }" ] && continue
  # shellcheck disable=SC2086
  out=$(run_wrapper $args); expect_accept_wrapper "$label" "$out" $?
  # shellcheck disable=SC2086
  out=$(run_adapter $args); expect_accept_adapter "$label" "$out"
done <<EOF
--snap-silence 0.6|--epub $EPUB --snap-silence 0.6
--snap-silence 0|--epub $EPUB --snap-silence 0
--no-snap-silence alone|--epub $EPUB --no-snap-silence
--no-paragraph-split alone|--epub $EPUB --no-paragraph-split
no boundary flags at all|--epub $EPUB
EOF

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
