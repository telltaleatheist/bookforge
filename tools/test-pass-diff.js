#!/usr/bin/env node
/**
 * Tests for shared/document/pass-diff.ts — a pass receipt is READ, never re-diffed.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-pass-diff.js
 *
 * Owen, 2026-08-10, live: "the review changes button just takes me to a
 * perpetually loading screen instead of actually showing me what changed in the
 * text."
 *
 * The spinner was real work: the viewer handed a receipt's two whole-book texts
 * to an LCS diff worker whose table is O(before x after), even though the
 * receipt already contained the edit list the pass produced. Measured on Owen's
 * own library (Working_Towards_The_Fuhrer, one unit, 8,815 x 8,712 tokens):
 * 76.8 million cells, 24.7 s and 628 MB in bare Node. A full-length book is
 * ~200x that.
 *
 * What is asserted here:
 *
 *  - A receipt with edits reads as `changed`, and hydration reproduces the
 *    after-text exactly while marking every recorded edit. Nothing is computed.
 *  - BOTH VINTAGES render honestly. A receipt written before the
 *    keepFootnoteMarkers fix is a diff of the book against ITSELF — valid, zero
 *    edits — and reads as `empty` with a sentence, never as a failure and never
 *    as a hang.
 *  - A corrupt receipt reads as `unreadable` WITH THE REASON, and is never
 *    smoothed into "no changes": "this pass changed nothing" and "this receipt
 *    cannot be read" are different facts about the book.
 *  - The three answers are exhaustive and disjoint — every input lands on
 *    exactly one, so the caller always has something to lower the spinner for.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'pass-diff.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { readPassDiff, hydratePassDiff, passDiffLabel } = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PATH = 'E:/projects/Book/source/ledger/01-footnote-refs-61e20ac5/receipt.json';

/**
 * A receipt exactly as `writePassDiff` lays one down: after-text, before-text,
 * and the compact edits whose offsets index the AFTER text.
 */
function receipt(units) {
  return {
    version: 1,
    createdAt: '2026-08-09T20:00:00.000Z',
    updatedAt: '2026-08-09T20:00:00.000Z',
    ignoreWhitespace: true,
    completed: true,
    chapters: units,
  };
}

/** The real shape of a footnote-reference pass: markers removed, nothing added. */
const REAL_UNIT = {
  id: 'c0001',
  title: 'Beginning',
  originalCharCount: 46,
  cleanedCharCount: 42,
  changeCount: 2,
  changes: [
    { pos: 10, len: 0, rem: '12', fn: 'archive' },
    { pos: 31, len: 0, rem: '13', fn: 'inferred' },
  ],
  //        0123456789          0123456789 0
  text: 'The truth. It was plain. The end. Amen.',
  originalText: 'The truth.12 It was plain. The end.13 Amen.',
};

// ── The good vintage ────────────────────────────────────────────────────────

test('a receipt with edits reads as changed, and its units carry both texts', () => {
  const out = readPassDiff(receipt([REAL_UNIT]), PATH);
  assert.strictEqual(out.kind, 'changed');
  assert.strictEqual(out.units.length, 1);
  assert.strictEqual(out.units[0].id, 'c0001');
  assert.strictEqual(out.units[0].cleanedText, REAL_UNIT.text);
  assert.strictEqual(out.units[0].originalText, REAL_UNIT.originalText);
});

test('the change count comes from the edit list, not from the stored number', () => {
  // The list is the record. A stored count that disagreed with it would be the
  // thing to distrust, so it is never read.
  const lying = { ...REAL_UNIT, changeCount: 999 };
  const out = readPassDiff(receipt([lying]), PATH);
  assert.strictEqual(out.kind, 'changed');
  assert.strictEqual(out.units[0].changeCount, 2);
});

test('hydration reproduces the after-text exactly and marks every recorded edit', () => {
  const out = readPassDiff(receipt([REAL_UNIT]), PATH);
  const words = hydratePassDiff(out.units[0].changes, out.units[0].cleanedText);

  // Everything the reader will SEE, minus what the pass took out, is the book.
  const shown = words.filter(w => w.type !== 'removed').map(w => w.text).join('');
  assert.strictEqual(shown, REAL_UNIT.text);

  const removed = words.filter(w => w.type === 'removed');
  assert.deepStrictEqual(removed.map(w => w.text), ['12', '13']);
  // The footnote proof rides through hydration, or a marker removed beside a
  // quote edit renders as a plain quote change and the removal is invisible.
  assert.deepStrictEqual(removed.map(w => w.fn), ['archive', 'inferred']);
});

test('hydration is linear in the edits — a whole book is expanded, never diffed', () => {
  // The guard on the bug itself. 400 KB of text with 500 recorded edits is the
  // size that took 25 s (and 628 MB) through the LCS worker; expanding the
  // recorded edits must be instant.
  const body = 'the quick brown fox jumps over the lazy dog. '.repeat(9000); // ~400 KB
  const changes = [];
  for (let i = 0; i < 500; i++) changes.push({ pos: i * 700, len: 0, rem: 'x' });
  const started = Date.now();
  const words = hydratePassDiff(changes, body);
  const elapsed = Date.now() - started;
  assert.strictEqual(words.filter(w => w.type !== 'unchanged').length, 500);
  assert.strictEqual(words.filter(w => w.type !== 'removed').map(w => w.text).join(''), body);
  assert.ok(elapsed < 1000, `hydration took ${elapsed} ms — it must not be doing a comparison`);
});

// ── The pre-fix vintage: valid, and empty ───────────────────────────────────

test('a receipt that recorded no edits is EMPTY, not an error and not a hang', () => {
  // Written before the keepFootnoteMarkers fix: the diff was computed through a
  // text extractor that stripped the very markers the pass removed, so the book
  // was compared with itself. The file is perfectly well formed.
  const selfDiff = {
    id: 'c0001',
    title: 'Beginning',
    originalCharCount: 38,
    cleanedCharCount: 38,
    changeCount: 0,
    changes: [],
    text: 'The truth. It was plain. The end. Amen.',
    originalText: 'The truth. It was plain. The end. Amen.',
  };
  const out = readPassDiff(receipt([selfDiff]), PATH);
  assert.strictEqual(out.kind, 'empty');
  assert.match(out.reason, /recorded no changes/i);
  assert.match(out.reason, /1 text unit/);
});

test('an empty answer says which, and stays short enough to sit inline', () => {
  const out = readPassDiff(receipt([]), PATH);
  assert.strictEqual(out.kind, 'empty');
  assert.match(out.reason, /no text units at all/);
  const sentences = out.reason.split(/(?<=\.)\s+/).filter(s => s.trim().length > 0);
  assert.ok(sentences.length <= 3, `empty notice ran to ${sentences.length} sentences`);
});

test('two units where only one changed is still CHANGED — a total, not an any', () => {
  const quiet = { ...REAL_UNIT, id: 'c0002', changes: [], changeCount: 0,
    originalText: REAL_UNIT.text };
  const out = readPassDiff(receipt([REAL_UNIT, quiet]), PATH);
  assert.strictEqual(out.kind, 'changed');
  assert.deepStrictEqual(out.units.map(u => u.changeCount), [2, 0]);
});

// ── The broken file: said out loud ──────────────────────────────────────────

test('a file that is not a receipt is unreadable, and names the file', () => {
  for (const junk of [null, 42, 'a string', ['a', 'list']]) {
    const out = readPassDiff(junk, PATH);
    assert.strictEqual(out.kind, 'unreadable', `${JSON.stringify(junk)} read as ${out.kind}`);
    assert.match(out.reason, /01-footnote-refs-61e20ac5\/receipt\.json/);
  }
});

test('a version this build cannot read is unreadable, and says which version', () => {
  const out = readPassDiff({ ...receipt([REAL_UNIT]), version: 7 }, PATH);
  assert.strictEqual(out.kind, 'unreadable');
  assert.match(out.reason, /version 7/);
});

test('a receipt with no units list is unreadable — distinct from one with none', () => {
  // `chapters: []` is a pass that recorded nothing (empty). No `chapters` key at
  // all is a file that is not a receipt (unreadable). The two must not merge.
  const missing = readPassDiff({ version: 1 }, PATH);
  assert.strictEqual(missing.kind, 'unreadable');
  const none = readPassDiff(receipt([]), PATH);
  assert.strictEqual(none.kind, 'empty');
});

test('a unit that kept neither of its texts is unreadable, and says so', () => {
  // A receipt has to be self-contained: the book it described was overwritten by
  // whatever ran next, so a unit without its texts cannot be shown at all.
  const stripped = { id: 'c0001', title: 'Beginning', changes: [], changeCount: 0 };
  const out = readPassDiff(receipt([stripped]), PATH);
  assert.strictEqual(out.kind, 'unreadable');
  assert.match(out.reason, /neither its before- nor its after-text/);
});

test('a unit missing ONE side names which side is missing', () => {
  const noBefore = readPassDiff(receipt([{ ...REAL_UNIT, originalText: undefined }]), PATH);
  assert.strictEqual(noBefore.kind, 'unreadable');
  assert.match(noBefore.reason, /no before-text/);

  const noAfter = readPassDiff(receipt([{ ...REAL_UNIT, text: undefined }]), PATH);
  assert.strictEqual(noAfter.kind, 'unreadable');
  assert.match(noAfter.reason, /no after-text/);
});

test('an edit whose offsets contradict the receipt\'s own text is unreadable', () => {
  // The offsets index text in the SAME file, so they cannot drift honestly. A
  // mismatch is corruption, and re-deriving a diff to paper over it would show
  // the user something the pass never did.
  const lying = {
    ...REAL_UNIT,
    changes: [{ pos: 0, len: 3, add: 'NOT WHAT IS THERE' }],
  };
  const out = readPassDiff(receipt([lying]), PATH);
  assert.strictEqual(out.kind, 'unreadable');
  assert.match(out.reason, /contradicts itself/);
  assert.match(out.reason, /NOT WHAT IS THERE/);
});

test('an edit at a position that is not a place in the text is unreadable', () => {
  for (const bad of [{ pos: -1, len: 0 }, { pos: 'x', len: 0 }, { pos: 0, len: -4 }]) {
    const out = readPassDiff(receipt([{ ...REAL_UNIT, changes: [bad] }]), PATH);
    assert.strictEqual(out.kind, 'unreadable', `${JSON.stringify(bad)} read as ${out.kind}`);
    assert.match(out.reason, /not a place in the text/);
  }
});

test('a unit with no id is unreadable — its text could not be addressed', () => {
  const out = readPassDiff(receipt([{ ...REAL_UNIT, id: '' }]), PATH);
  assert.strictEqual(out.kind, 'unreadable');
  assert.match(out.reason, /no id/);
});

// ── The contract the viewer leans on ────────────────────────────────────────

test('every input lands on exactly one of the three answers', () => {
  // What lets the loader guarantee the spinner comes down: there is no fourth
  // shape, and no shape that is two at once.
  const inputs = [
    receipt([REAL_UNIT]), receipt([]), receipt([{ ...REAL_UNIT, changes: [] }]),
    null, undefined, 0, '', [], {}, { version: 1 },
    receipt([{ ...REAL_UNIT, text: undefined }]),
    receipt([{ ...REAL_UNIT, changes: [{ pos: 0, len: 3, add: 'nope' }] }]),
  ];
  for (const input of inputs) {
    const out = readPassDiff(input, PATH);
    assert.ok(['changed', 'empty', 'unreadable'].includes(out.kind),
      `${JSON.stringify(input)} read as ${out.kind}`);
    if (out.kind === 'changed') assert.ok(Array.isArray(out.units) && out.units.length > 0);
    else assert.ok(typeof out.reason === 'string' && out.reason.length > 0,
      `${out.kind} answer carried no reason`);
  }
});

test('the label is what identifies a receipt to a human, on either separator', () => {
  assert.strictEqual(passDiffLabel(PATH), '01-footnote-refs-61e20ac5/receipt.json');
  assert.strictEqual(passDiffLabel('E:\\p\\stages\\02-footnote-refs\\diff.json'),
    '02-footnote-refs/diff.json');
});

// ── Run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

for (const { name, err } of failures) {
  console.log(`FAIL  ${name}`);
  console.log(`      ${err.message}`);
}
console.log(`${passed}/${tests.length} passed`);
process.exit(failures.length === 0 ? 0 : 1);
