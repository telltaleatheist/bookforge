#!/usr/bin/env node
/**
 * Tests for shared/processing/reset-book.ts — which directories under `stages/`
 * a "Start over" is allowed to delete.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-reset-book.js
 *
 * ── What is actually being defended ─────────────────────────────────────────
 *
 * `stages/` is SHARED. A pass's working space is `stages/NN-<kind>` (numbered by
 * the pass's position in the book's provenance), and living right beside it are
 * the language-learning pipeline's `01-cleanup` and `02-translate`, the TTS
 * sentence cache `03-tts`, and the Insights report `04-analysis`. Those hold
 * genuinely different books and hours of rendered audio; a reset that took
 * "everything in stages/" would delete work no re-run rebuilds.
 *
 * The nastiest case is `02-translate`, which is BOTH: `passStageRelDir(2,
 * 'translate')` produces exactly that name. The name wins — see
 * RESERVED_STAGE_DIRS — because deleting real per-language books to save one
 * re-run of a pass is the wrong trade in both directions.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'shared', 'processing');
if (!fs.existsSync(path.join(DIST, 'reset-book.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  isPassStageDirName,
  selectPassStageDirs,
  presentResetItems,
  PASS_STAGE_KINDS,
  RESERVED_STAGE_DIRS,
} = require(path.join(DIST, 'reset-book.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

// ── pass directories die ────────────────────────────────────────────────────

test('every pass kind names a stage directory that is removed', () => {
  for (const kind of PASS_STAGE_KINDS) {
    const name = `07-${kind}`;
    assert.ok(isPassStageDirName(name), `${name} should be a pass stage dir`);
  }
});

test('the numbering is the pass position, whatever it has reached', () => {
  assert.ok(isPassStageDirName('01-ocr-correction'));
  assert.ok(isPassStageDirName('02-footnotes'));
  assert.ok(isPassStageDirName('09-simplify'));
  // The provenance list only grows, so a long-lived book passes 99.
  assert.ok(isPassStageDirName('100-simplify'));
});

// ── the LL pipeline, the TTS cache and the analysis report survive ──────────

test('the reserved directories are never pass directories', () => {
  for (const name of RESERVED_STAGE_DIRS) {
    assert.strictEqual(isPassStageDirName(name), false, `${name} must survive a reset`);
  }
});

test('02-translate survives even though "translate" is a pass kind', () => {
  // The collision this rule exists for: passStageRelDir(2, 'translate') IS
  // `stages/02-translate`, the LL pipeline's per-language book directory.
  assert.strictEqual(isPassStageDirName('02-translate'), false);
  // A translate pass at any OTHER position is an ordinary pass directory.
  assert.ok(isPassStageDirName('03-translate'));
  assert.ok(isPassStageDirName('12-translate'));
});

test('a whole stages/ listing is filtered, not swept', () => {
  const listing = [
    '01-cleanup',
    '01-ocr-correction',
    '02-footnotes',
    '02-translate',
    '03-simplify',
    '03-tts',
    '04-analysis',
  ];
  assert.deepStrictEqual(selectPassStageDirs(listing), [
    '01-ocr-correction',
    '02-footnotes',
    '03-simplify',
  ]);
});

// ── nothing else in the project is matched by accident ─────────────────────

test('a directory that is not NN-<pass kind> is left alone', () => {
  for (const name of [
    'sessions',
    'tts',
    'translate',           // no number
    'ocr-correction',      // no number
    '05-cleanup',          // a kind that is not a pass
    '05-tts',              // ditto
    '05-analysis',
    'stages',
    '',
    '1-simplify',          // one digit is not the padded form anything writes
    '01_simplify',
    '01-simplify-old',     // a user's own copy, not a pass directory
    '.DS_Store',
  ]) {
    assert.strictEqual(isPassStageDirName(name), false, `${name} must not be removed`);
  }
});

// ── the summary's "what is actually there" reading ─────────────────────────

test('only the present items are what a reset has to do', () => {
  const summary = {
    projectDir: '/library/projects/Book',
    preview: true,
    empty: false,
    items: [
      { kind: 'run-dir', label: 'run', path: '/runs/x', present: true, removed: false },
      { kind: 'book-epub', label: 'book', present: false, removed: false },
      { kind: 'source-records', label: 'deletions', present: true, removed: false },
    ],
  };
  assert.deepStrictEqual(presentResetItems(summary).map((i) => i.kind), ['run-dir', 'source-records']);
});

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`reset-book: ${passed} test(s) passed`);
