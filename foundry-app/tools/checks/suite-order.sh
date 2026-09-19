#!/usr/bin/env bash
#
# RUN THE SUITE IN N RANDOM FILE ORDERS. Run from the repo root.
#
#     bash app/tools/checks/suite-order.sh        # 5 orders
#     bash app/tools/checks/suite-order.sh 12     # 12 of them
#
# NOT A GATE -- see the README beside this file. Nothing runs it for you.
#
# WHY: `bun test` walks the directory, and the walk is SORTED on Windows and
# HASH-ORDERED on macOS. A test that leaves module state behind therefore fails
# on one machine and not the other, with nothing in the diff to say which test
# is at fault -- the failures land in whatever file happened to run next. That
# is exactly what `hosted-shelf.test.ts` did with `recordHost` on 2026-09-19:
# four failures in `crucible-install-latest.test.ts`, none of them that file's
# fault, green on Windows and red on the Mac from one commit.
#
# Six shuffled orders reproduced it every time. The default order never did.
#
# A green run here is worth more than a green `bun test` and is still not a
# proof: it SAMPLES orders, it does not enumerate them.
set -euo pipefail

runs="${1:-5}"
cd "$(dirname "$0")/../../.."

if [ ! -d test ] || [ ! -d app/test ]; then
  echo "run me from the repo root (no test/ and app/test/ here)" >&2
  exit 1
fi

echo "$runs shuffled orders over $(find app/test test -name '*.test.ts' | wc -l | tr -d ' ') files"

failed=0
for i in $(seq 1 "$runs"); do
  # shellcheck disable=SC2046
  out=$(bun test $(find app/test test -name '*.test.ts' | sort -R | tr '
' ' ') 2>&1 || true)
  line=$(printf '%s' "$out" | grep -E '^ *[0-9]+ (pass|fail|skip)$' | tr '
' ' ')
  # bun prints the fail line either way, so it is the NUMBER that decides.
  # Matching the word alone calls " 0 fail" a failure, which this script did
  # on its first run -- caught by running it against a suite that was green.
  count=$(printf '%s' "$out" | grep -E '^ *[0-9]+ fail$' | awk '{print $1}' | tail -1)
  if [ -n "${count:-}" ] && [ "$count" -ne 0 ]; then
    failed=$((failed + 1))
    echo "  order $i:  $line <-- FAILED"
    printf '%s' "$out" | grep -E '^\(fail\)' | sed 's/^/      /'
  else
    echo "  order $i:  $line"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "$failed of $runs orders failed -- something is leaking module state between files."
  exit 1
fi
echo "all $runs orders green"
