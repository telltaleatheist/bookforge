#!/usr/bin/env node
/**
 * Tests for shared/document/pass-lifecycle.ts — a diff dies with its artifact.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-pass-lifecycle.js
 *
 * Owen, third real session: "if that file is removed, so is the diff and its
 * viewing button." Two events end a book's passes — the book being deleted and
 * the book being rebuilt — and the interesting one is the rebuild, because the
 * file is still there afterwards and the passes still did not happen to it.
 *
 * What is asserted here:
 *
 *  - Both events drop EVERY pass. Neither is a filter.
 *  - The paths to remove are the passes' own stage directories, in run order,
 *    deduped — never the book, never a directory a diff merely sits in.
 *  - A pass with no diff drops its record and removes no file, because it left
 *    none. (A job that died halfway is the ordinary case.)
 *  - Nothing else is touched: a pass list with no diffs yields no removals at
 *    all, so no other event can be implemented by calling this one.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'pass-lifecycle.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { passesAfterEpubEvent, passStageDirOf } = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const AT = (n) => `2026-08-05T0${n}:00:00.000Z`;

/** The Kershaw shape: one footnote pass with its diff, recorded against a book. */
const kershaw = [
  { kind: 'footnotes', at: AT(1), diff: 'stages/01-footnotes/diff.json' },
];

/** A book that has been through the whole EPUB station. */
const fullHouse = [
  { kind: 'get-text', at: AT(1) },
  { kind: 'blocks', at: AT(1) },
  { kind: 'reflow', at: AT(1) },
  { kind: 'footnotes', at: AT(2), diff: 'stages/04-footnotes/diff.json' },
  { kind: 'simplify', at: AT(3), diff: 'stages/05-simplify/diff.json' },
  { kind: 'translate', at: AT(4), diff: 'stages/06-translate/diff.json' },
];

// ── The rule itself ─────────────────────────────────────────────────────────

test('deleting the book drops every pass', () => {
  const out = passesAfterEpubEvent('epub-deleted', fullHouse);
  assert.deepStrictEqual(out.kept, []);
  assert.strictEqual(out.dropped.length, fullHouse.length);
});

test('rebuilding the book drops every pass — the passes did not happen to it', () => {
  const out = passesAfterEpubEvent('epub-rebuilt', fullHouse);
  assert.deepStrictEqual(out.kept, []);
  assert.strictEqual(out.dropped.length, fullHouse.length);
});

test('the two events agree, exactly', () => {
  const deleted = passesAfterEpubEvent('epub-deleted', fullHouse);
  const rebuilt = passesAfterEpubEvent('epub-rebuilt', fullHouse);
  assert.deepStrictEqual(deleted.removePaths, rebuilt.removePaths);
  assert.deepStrictEqual(deleted.dropped, rebuilt.dropped);
});

// ── What comes off disk ─────────────────────────────────────────────────────

test('the stage directory is what is removed, not the diff file alone', () => {
  const out = passesAfterEpubEvent('epub-deleted', kershaw);
  assert.deepStrictEqual(out.removePaths, ['stages/01-footnotes']);
});

test('removals are in run order and deduped', () => {
  const out = passesAfterEpubEvent('epub-deleted', [
    ...fullHouse,
    // The same pass run twice into the same stage dir (a resumed job).
    { kind: 'footnotes', at: AT(5), diff: 'stages/04-footnotes/diff.json' },
  ]);
  assert.deepStrictEqual(out.removePaths, [
    'stages/04-footnotes', 'stages/05-simplify', 'stages/06-translate',
  ]);
});

test('a pass that recorded no diff removes nothing', () => {
  const out = passesAfterEpubEvent('epub-deleted', [
    { kind: 'footnotes', at: AT(1) },
    { kind: 'simplify', at: AT(2) },
  ]);
  assert.strictEqual(out.dropped.length, 2);
  assert.deepStrictEqual(out.removePaths, []);
});

test('a book with no passes loses nothing and removes nothing', () => {
  const out = passesAfterEpubEvent('epub-rebuilt', []);
  assert.deepStrictEqual(out.kept, []);
  assert.deepStrictEqual(out.dropped, []);
  assert.deepStrictEqual(out.removePaths, []);
});

// ── The stage-directory test, which is what keeps the book safe ─────────────

test('a diff inside a pass stage directory owns that directory', () => {
  assert.strictEqual(passStageDirOf('stages/04-footnotes/diff.json'), 'stages/04-footnotes');
  assert.strictEqual(passStageDirOf('stages/12-ocr-correction/diff.json'), 'stages/12-ocr-correction');
});

test('a diff that is NOT in a pass stage directory owns none', () => {
  // A legacy sidecar beside the book. Removing `source/` would take the book.
  assert.strictEqual(passStageDirOf('source/Book.diff.json'), null);
  assert.strictEqual(passStageDirOf('diff.json'), null);
  // Not under stages/ at all.
  assert.strictEqual(passStageDirOf('output/Book.diff.json'), null);
});

test('a RESERVED stage directory is never a pass\'s to remove', () => {
  // 01-cleanup and 02-translate are the LL pipeline's own, and hold real books.
  // reset-book.ts is the authority; this asserts we honour it.
  assert.strictEqual(passStageDirOf('stages/01-cleanup/cleaned.diff.json'), null);
  assert.strictEqual(passStageDirOf('stages/02-translate/diff.json'), null);
  const out = passesAfterEpubEvent('epub-deleted', [
    { kind: 'translate', at: AT(1), diff: 'stages/02-translate/diff.json' },
  ]);
  assert.deepStrictEqual(out.removePaths, ['stages/02-translate/diff.json'],
    'the diff file comes off; the shared directory does not');
});

test('a directory whose suffix is not a pass kind owns nothing', () => {
  assert.strictEqual(passStageDirOf('stages/07-whatever/diff.json'), null);
});

test('a legacy sidecar diff removes the FILE, never its directory', () => {
  const out = passesAfterEpubEvent('epub-deleted', [
    { kind: 'ocr-correction', at: AT(1), diff: 'source/Book.diff.json' },
  ]);
  assert.deepStrictEqual(out.removePaths, ['source/Book.diff.json']);
});

test('the book itself is never a removal path', () => {
  const out = passesAfterEpubEvent('epub-deleted', fullHouse);
  for (const p of out.removePaths) {
    assert.ok(!p.toLowerCase().endsWith('.epub'), `${p} is a book`);
    assert.ok(p !== 'stages' && p !== 'source' && p !== 'archive', `${p} is a whole project folder`);
  }
});

test('an event nobody has ruled on refuses by name', () => {
  assert.throws(
    () => passesAfterEpubEvent('epub-renamed', kershaw),
    /epub-renamed/,
    'an unruled event must refuse, not silently keep every pass');
});

for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}

console.log(`\npass-lifecycle: ${passed}/${tests.length} passed`);
for (const f of failures) {
  console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
}
process.exit(failures.length === 0 ? 0 : 1);
