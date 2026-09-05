#!/usr/bin/env node
/**
 * Tests for `parseFoundryProgressLine` — the engine's own stderr, read as counts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-progress.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Foundry's `runJob` hands its `onProgress` A RAW STDERR LINE. This side had
 * declared that callback as taking a parsed `{done, total}` object — a shape
 * Foundry has never sent and never had — so `progress.done ?? 0` read a
 * property off a string, every count came out 0, `total > 0` never became true,
 * and NO HOSTED READ REPORTED A COUNT, A BAR OR A NOTE between the seam landing
 * and 2026-08-21. It was found by asking Foundry a question about their engine
 * and being answered with their own signature.
 *
 * Two halves, and the second is the one that keeps this fixed:
 *
 *  - BEHAVIOUR. The lines the engine actually writes, parsed. Including the ones
 *    that must NOT parse: the gate exists because `attempt 2/3` would otherwise
 *    render as 67% and the bar would leap because an answer was RETRIED.
 *  - DRIFT. `parseFoundryProgressLine` is a MIRROR of `parseProgressLine` in the
 *    vendored subtree, kept by hand because that function is not on the mount
 *    seam and reaching past the one contracted door for it would make a private
 *    function of theirs into a dependency they could break without knowing. A
 *    hand-kept mirror rots in silence, so the second half reads THEIR file and
 *    fails if the patterns, their ORDER, or the gate have moved.
 *
 * The order is the design, not an implementation detail: `page 143 (7/180)` also
 * contains `page 143`, so testing the bare pattern first would read a count of
 * 143 out of nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-host-queue.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { parseFoundryProgressLine } = require(path.join(DIST, 'foundry-host-queue.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('parseFoundryProgressLine — what the engine writes');

// ── The endpoint route (vLLM, concurrent) ───────────────────────────────────
//
// The numerator is PAGES COMPLETED and is monotonic; the leading number is the
// page NUMBER and arrives out of order, because this route reads N at a time.

test('endpoint: the parenthesised pair is the count, not the leading page number', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('vlm-read: page 143 (7/180) — 4,212 chars, 2,118 tokens, 3.4s'),
    { phase: 'read', page: 7, total: 180 },
  );
});

test('endpoint: an out-of-order page number does not disturb the count', () => {
  const first = parseFoundryProgressLine('vlm-read: page 143 (7/180) — 4,212 chars');
  const second = parseFoundryProgressLine('vlm-read: page 12 (8/180) — 1,004 chars');
  assert.strictEqual(first.page, 7);
  assert.strictEqual(second.page, 8, 'the count moved forward while the page number went back');
});

test('endpoint: a conversion counting its pages is read the same way', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('vlm-convert: page 9 (3/40) — 812 chars'),
    { phase: 'read', page: 3, total: 40 },
  );
});

// ── The local route (mlx, in-process, sequential) ───────────────────────────
//
// Here the numerator is THE PAGE NUMBER — a position, not work done — and the
// denominator is the whole document rather than the pages this run asked for.

test('local: the bare pair parses, and it is the page number over the document', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('vlm-read: page 12/180 — 1650x2200, 4,212 chars, 12.1s'),
    { phase: 'read', page: 12, total: 180 },
  );
});

test('local: a --skip-pages run starts at its first page, not at 1', () => {
  // The consequence kept deliberately: this run reads 20 pages and its bar
  // begins near the end. A short landing is honest; a bar that reported a
  // different quantity on each route would not be.
  assert.deepStrictEqual(
    parseFoundryProgressLine('vlm-read: page 160/180 — 1650x2200'),
    { phase: 'read', page: 160, total: 180 },
  );
});

// ── Rendering and translation ───────────────────────────────────────────────

test('render: the rasteriser counts what it writes, with no command prefix', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('page 3/317: rendered'),
    { phase: 'render', page: 3, total: 317 },
  );
});

test('translate: blocks are counted, and say so — they are not pages', () => {
  const got = parseFoundryProgressLine('translate: block 412/2081 (EPUB/text/c0003.xhtml)');
  assert.deepStrictEqual(got, { phase: 'translate', page: 412, total: 2081 });
  assert.strictEqual(got.phase, 'translate', 'a bar that called blocks pages changed units mid-run');
});

// ── The narration cleanup (foundry 9f4ee4e) ─────────────────────────────────
//
// The one pattern in the set with no noun to match on. Every other line names
// what it counts — block, rank, verify, page — and the naming is what stops a
// bar reading a retry or a survivor count as progress. `clean-text` says
// "blocks" only in its FINAL line, so the discipline is spelled the other way
// round: the fraction is ANCHORED TO THE END.

test('clean-text: the bare fraction is a count of blocks', () => {
  const got = parseFoundryProgressLine('clean-text: 412/2081');
  assert.deepStrictEqual(got, { phase: 'clean', page: 412, total: 2081 });
  assert.strictEqual(got.phase, 'clean', 'a cleanup counted as a translation is the wrong bar');
});

test('clean-text: the SUMMARY line is not a count — this is what the $ anchor buys', () => {
  // `\b` instead of `$` reads "412 blocks, 87 changed" as 412 of 87 and drives
  // the bar past its own end at the exact moment the run finishes. Their own
  // docblock names this; it is the reason the pattern is anchored.
  assert.strictEqual(
    parseFoundryProgressLine('clean-text: 412 blocks, 87 changed, 3 edits refused in 91s'),
    null,
  );
});

test('clean-text: a named refusal is a NOTE, not a count', () => {
  // Every refusal is said on stderr by its disposition's own name. They carry no
  // fraction and must fall through so the caller makes them the note.
  assert.strictEqual(
    parseFoundryProgressLine('clean-text: REFUSED NOT_A_READING in b12-3 — "Dr." → "Drive"'),
    null,
  );
  assert.strictEqual(
    parseFoundryProgressLine('clean-text: punctuation (s1) rewrote 12 span(s) across 4 block(s); 0 refused.'),
    null,
  );
});

test('clean-text: leading whitespace does not hide the count, and nothing else does either', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('   clean-text: 1/17   '),
    { phase: 'clean', page: 1, total: 17 },
  );
  // A trailing anything is not this line. The engine writes the fraction alone.
  assert.strictEqual(parseFoundryProgressLine('clean-text: 1/17 (b2-3)'), null);
});

// ── What must NOT parse ─────────────────────────────────────────────────────

test('a retry is not progress — the whole reason the gate exists', () => {
  // Ungated, `attempt 2/3` reads as 67% and the bar leaps because an ANSWER was
  // retried. Both spellings, because the engine writes both.
  assert.strictEqual(parseFoundryProgressLine('vlm-read: attempt 2/3 — answer rejected'), null);
  assert.strictEqual(parseFoundryProgressLine('translate: attempt 2/3 — answer rejected'), null);
});

test('an unprefixed line with a fraction in it is not a count', () => {
  assert.strictEqual(parseFoundryProgressLine('loaded 3/4 shards'), null);
  assert.strictEqual(parseFoundryProgressLine('reading server: 2/2 workers up'), null);
});

test('a refused or skipped page is a NOTE, not a count', () => {
  // These name a page and carry no fraction. They must fall through to null so
  // the caller makes them the note — the line that tells working from wedged.
  assert.strictEqual(parseFoundryProgressLine('vlm-read: page 12 SKIPPED — already in the bank'), null);
  assert.strictEqual(parseFoundryProgressLine('vlm-read: page 41 was not a runaway — kept at 900 tokens'), null);
});

test('an emptied-pages summary names pages in parentheses without counting them', () => {
  // `page 5 (runaway)` — parenthesised, but not a fraction, and it must not be
  // mistaken for one.
  assert.strictEqual(parseFoundryProgressLine('vlm-read: emptied page 5 (runaway), page 9 (runaway)'), null);
});

test('an empty line says nothing', () => {
  assert.strictEqual(parseFoundryProgressLine(''), null);
  assert.strictEqual(parseFoundryProgressLine('   '), null);
});

test('leading whitespace does not hide a count', () => {
  assert.deepStrictEqual(
    parseFoundryProgressLine('   page 3/317: rendered   '),
    { phase: 'render', page: 3, total: 317 },
  );
});

// ── The drift check ─────────────────────────────────────────────────────────

console.log('\nthe mirror still matches the vendored source');

const THEIRS = path.join(REPO, 'foundry-app', 'electron', 'engine.ts');
const OURS = path.join(REPO, 'electron', 'foundry-host-queue.ts');

test('the vendored engine still has the function this one mirrors', () => {
  assert.ok(fs.existsSync(THEIRS), `${THEIRS} is missing — is the subtree vendored?`);
  const src = fs.readFileSync(THEIRS, 'utf8');
  assert.ok(
    /export function parseProgressLine\(/.test(src),
    'parseProgressLine has been renamed or removed in the vendored subtree. This mirror is now '
    + 'guessing; read their file and update parseFoundryProgressLine to match.',
  );
});

/**
 * Every regex literal in a function body, in source order.
 *
 * Source order IS the check. Their `page 143 (7/180)` also matches the bare
 * pattern, so a mirror that tested them the other way round would read a count
 * of 143 out of nothing — and would still hold every pattern the drift check
 * compared as a set.
 */
function patternsIn(source, fnDeclaration) {
  const start = source.indexOf(fnDeclaration);
  assert.notStrictEqual(start, -1, `could not find ${fnDeclaration}`);
  // To the next top-level close brace — these are both single functions ending
  // at column 0, which is the shape of every function in both files.
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${fnDeclaration}`);
  const body = source.slice(start, end);
  /*
   * A WHOLE regex literal, escaped slashes and character classes included.
   *
   * The naive `[^/\n]*` stops at the first `\/` INSIDE the pattern, so every
   * one of these came out as its tail — `/(\d+)\b/` for both the endpoint and
   * the local route, which are the two this file exists to keep in order. It
   * compared four truncated strings against four identical truncated strings
   * and reported a match; a rename from `page` to `pages` would have sailed
   * through it. Checked by inducing a drift, not by reading.
   */
  const LITERAL = /\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*(?=\.exec\()/g;
  return body.match(LITERAL) || [];
}

test('the patterns, and their ORDER, are the ones in the vendored engine', () => {
  const theirs = patternsIn(fs.readFileSync(THEIRS, 'utf8'), 'export function parseProgressLine(');
  const ours = patternsIn(fs.readFileSync(OURS, 'utf8'), 'export function parseFoundryProgressLine(');
  assert.ok(theirs.length >= 4, `expected at least 4 patterns in theirs, found ${theirs.length}`);
  assert.deepStrictEqual(
    ours,
    theirs,
    'parseFoundryProgressLine has drifted from the vendored parseProgressLine.\n'
    + `        theirs: ${JSON.stringify(theirs)}\n`
    + `        ours:   ${JSON.stringify(ours)}\n`
    + '        Re-read foundry-app/electron/engine.ts and mirror it, INCLUDING the order.',
  );
});

test('the command gate is still the same two prefixes', () => {
  const theirs = fs.readFileSync(THEIRS, 'utf8');
  const ours = fs.readFileSync(OURS, 'utf8');
  const gate = /!trimmed\.startsWith\('vlm-read:'\) && !trimmed\.startsWith\('vlm-convert:'\)/;
  assert.ok(gate.test(theirs), 'the vendored engine\'s gate has changed — mirror the new one');
  assert.ok(gate.test(ours), 'our gate no longer matches the vendored engine\'s');
});

console.log(`\n${passed} passed`);
