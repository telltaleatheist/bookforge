#!/usr/bin/env node
/**
 * Tests for `chapterOpeningsAfterDeletions` in shared/ocr/text-block.ts — the
 * rule the picker's Chapter tab lists rows by.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chapter-openings.js
 *
 * The tab itself is Angular signals and cannot be driven from node, but the
 * QUESTION it asks is this pure function, and it is asked by both artifacts that
 * have chapter blocks: the working PDF's document layer
 * (`DocumentBlocksService.chapterBlocks`) and a converted book's own blocks
 * (`bookChapterOpeningBlocks`). A drift between them would show a chapter on one
 * artifact and not the other, which is why the rule was moved here to be tested
 * once.
 *
 * The case that forced it: a publisher EPUB stamps its own markup, so a printed
 * Contents page arrives labelled `chapter`. Deleting that page has to stop it
 * being listed as a chapter of a book that will not contain it — and restoring
 * the page has to bring it back, because a deletion is an undoable record and
 * this list is derived from it rather than edited alongside it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'shared', 'ocr');
if (!fs.existsSync(path.join(DIST, 'text-block.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { chapterOpeningsAfterDeletions, isChapterOpening } =
  require(path.join(DIST, 'text-block.js'));

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

/** A block with only the fields this rule reads. */
function block(id, page, y, category_id, extra = {}) {
  return {
    id, page, y, category_id,
    x: 0, width: 100, height: 20,
    text: id, font_size: 20, font_name: 'serif', char_count: id.length,
    region: 'body',
    ...extra,
  };
}

const NONE = new Set();

// The book of every case below: a Contents page (p0) the conversion stamped as
// a chapter, then two real chapter openings, with body text between them.
const BOOK = [
  block('toc', 0, 100, 'chapter'),
  block('body-1', 1, 200, 'body'),
  block('ch-2', 2, 50, 'chapter'),
  block('ch-1', 1, 50, 'chapter'),
  block('running-head', 2, 10, 'header'),
];

const ids = blocks => blocks.map(b => b.id);

test('lists every chapter opening and nothing else', () => {
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(BOOK, NONE, NONE)).sort(),
    ['ch-1', 'ch-2', 'toc']);
});

test('reading order is page, then down the page', () => {
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(BOOK, NONE, NONE)),
    ['toc', 'ch-1', 'ch-2']);
});

test('a deleted block is not a chapter row', () => {
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(BOOK, new Set(['toc']), NONE)),
    ['ch-1', 'ch-2']);
});

test('deleting the page a marker sits on removes its row — the Contents case', () => {
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(BOOK, NONE, new Set([0]))),
    ['ch-1', 'ch-2']);
});

test('a deleted page takes every marker on it, not just the first', () => {
  const twoOnAPage = [...BOOK, block('ch-1b', 1, 400, 'chapter')];
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(twoOnAPage, NONE, new Set([1]))),
    ['toc', 'ch-2']);
});

test('restoring the page brings the row back — the rule is derived, not applied', () => {
  const deleted = new Set([0]);
  assert.deepStrictEqual(ids(chapterOpeningsAfterDeletions(BOOK, NONE, deleted)),
    ['ch-1', 'ch-2']);
  deleted.delete(0);
  assert.deepStrictEqual(ids(chapterOpeningsAfterDeletions(BOOK, NONE, deleted)),
    ['toc', 'ch-1', 'ch-2']);
});

test('the two strikes are independent, and both are enough on their own', () => {
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(BOOK, new Set(['ch-1']), new Set([0]))),
    ['ch-2']);
});

test('relabelling a marker to body text takes its row out', () => {
  const demoted = BOOK.map(b => (b.id === 'toc' ? { ...b, category_id: 'body' } : b));
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(demoted, NONE, NONE)),
    ['ch-1', 'ch-2']);
});

test('an image labelled chapter is not a chapter opening — no title to name it', () => {
  const withFigure = [...BOOK, block('plate', 3, 10, 'chapter', { is_image: true })];
  assert.deepStrictEqual(
    ids(chapterOpeningsAfterDeletions(withFigure, NONE, NONE)),
    ['toc', 'ch-1', 'ch-2']);
  assert.strictEqual(isChapterOpening(withFigure[withFigure.length - 1]), false);
});

test('the caller\'s array is not reordered under it', () => {
  const given = BOOK.slice();
  chapterOpeningsAfterDeletions(given, NONE, NONE);
  assert.deepStrictEqual(ids(given), ids(BOOK));
});

// ─────────────────────────────────────────────────────────────────────────────
// What the picker says after a rename, about THIS chapter's opening
//
// A chapter's name lives in the book's table of contents; the heading printed at
// the top of the chapter is derived from it by the naming pass. The pass can
// decline one chapter and say why, and the window has to pass that on — a rename
// that leaves the page printing the old heading in silence is what Owen hit on
// 2026-08-10. `chapterOpeningRefusal` is the whole of that decision.
// ─────────────────────────────────────────────────────────────────────────────

const { chapterOpeningRefusal } =
  require(path.join(REPO, 'dist', 'shared', 'document', 'chapter-opening-report.js'));

const CH2 = 'OEBPS/ch02.xhtml';

test('an opening that was rewritten says nothing — the page followed the name', () => {
  assert.strictEqual(
    chapterOpeningRefusal({ named: [{ file: CH2 }], skipped: [] }, CH2),
    null);
});

test('an opening that already read the name says nothing either — same fact', () => {
  assert.strictEqual(
    chapterOpeningRefusal({
      named: [],
      skipped: [{ file: CH2, kind: 'already-named', reason: 'it already reads that.' }],
    }, CH2),
    null);
});

test('a document with no chapter opening in its markup reports the pass\'s own words', () => {
  const reason = 'ch02.xhtml is called "Chapter 2" in the table of contents, and its markup marks '
    + 'no chapter opening in it.';
  assert.strictEqual(
    chapterOpeningRefusal({ named: [], skipped: [{ file: CH2, kind: 'no-chapter-element', reason }] },
      CH2),
    reason);
});

test('an opening holding a picture reports why it was left alone', () => {
  const reason = 'ch02.xhtml\'s chapter opening holds a picture.';
  assert.strictEqual(
    chapterOpeningRefusal({ named: [], skipped: [{ file: CH2, kind: 'holds-image', reason }] }, CH2),
    reason);
});

test('another chapter being named is not this chapter being named', () => {
  const answer = chapterOpeningRefusal(
    { named: [{ file: 'OEBPS/ch07.xhtml' }], skipped: [] }, CH2);
  assert.notStrictEqual(answer, null);
  assert.ok(answer.includes(CH2), 'the sentence names the document it is about');
});

test('a chapter in neither list is its own answer, not a silent pass', () => {
  const answer = chapterOpeningRefusal({ named: [], skipped: [] }, CH2);
  assert.notStrictEqual(answer, null);
  assert.ok(answer.includes(CH2), 'the sentence names the document it is about');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
