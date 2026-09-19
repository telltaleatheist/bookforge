#!/usr/bin/env node
/**
 * keeper-skip — THE ONE SPELLING OF "THIS SUITE COULD NOT RUN HERE".
 *
 * ── Why the spelling has an owner ───────────────────────────────────────────
 *
 * `tools/run-keepers.js` scores a suite by reading its output, and the only
 * thing that turns an exit-0 suite into a `SKIP` row rather than an `ok` row is
 * a line matching the contract. So the contract is not a convention: a suite
 * that announces a skip in any other words is reported as a suite that PASSED,
 * having verified nothing.
 *
 * That happened. `test-foundry-clean-text-vendor` printed
 * `SKIP <suite> — <reason>` (no colon), and `test-foundry-narration-stamp` and
 * `test-narration-clean-text-door` copied the spelling from it. On a machine
 * with no Foundry checkout — every machine but Owen's, and every CI runner —
 * three suites that asserted nothing at all scored `ok`, which is the 2026-09-13
 * census's finding (an unrun guard in a listing looks like coverage) arriving
 * through the runner instead of through the list.
 *
 * The cause was that the line was a LITERAL in two dozen files. One fact, one
 * owner: it is composed here, read here, and `tools/test-keeper-runner.js`
 * refuses any `tools/test-*.js` that writes the word itself.
 *
 * ── The contract, in full ───────────────────────────────────────────────────
 *
 *   A suite that cannot run on this machine prints `SKIP: <reason>` at column
 *   zero, on a line of its own, and exits 0. The reason names what is missing
 *   and, where there is one, how to supply it.
 *
 * A suite that skips ONE CHECK and runs the rest is not this: it is a running
 * suite, and it says so on an indented line beside its other per-check lines.
 * The distinction is positional because it is the one a reader of the output
 * makes too — column zero is the suite talking, an indent is a check talking.
 */
'use strict';

/** The contract's prefix. Nothing else in the tree spells it. */
const SKIP_PREFIX = 'SKIP: ';

/** The line a suite prints instead of running. `console.log(skipLine(why))`. */
function skipLine(reason) {
  const said = String(reason).replace(/\s+/g, ' ').trim();
  if (said === '') {
    throw new Error(
      'skipLine() was given no reason. A skip with no reason is indistinguishable from a suite '
      + 'that ran, which is the whole defect this line exists to avoid.',
    );
  }
  return `${SKIP_PREFIX}${said}`;
}

/** The contract, exactly: the prefix at column zero and something after it. */
const SKIP_RE = /^SKIP:[ \t]*(\S.*)$/m;

/**
 * ANY line at column zero that opens with the word — the contract's and the
 * near-misses alike. Matched deliberately wider than `SKIP_RE` so that an
 * almost-right spelling is READ rather than passed over: passing over it is
 * what scored three empty suites green.
 */
const ANNOUNCEMENT_RE = /^SKIP\b.*$/m;

/**
 * What a finished suite's output says about skipping.
 *
 *   `{ why }`        — it skipped, in the contract's spelling.
 *   `{ malformed }`  — it announced a skip in some other spelling. The caller
 *                      must treat this as a FAILURE: the suite verified nothing
 *                      and the runner cannot tell that from a pass.
 *   `null`           — it said nothing about skipping, or said it on an
 *                      indented per-check line, which is a running suite.
 */
function readSkip(out) {
  const contract = SKIP_RE.exec(out);
  if (contract !== null) return { why: contract[1].trim() };
  const announced = ANNOUNCEMENT_RE.exec(out);
  if (announced !== null) return { malformed: announced[0].trim() };
  return null;
}

module.exports = { SKIP_PREFIX, SKIP_RE, skipLine, readSkip };
