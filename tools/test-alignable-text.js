#!/usr/bin/env node
/**
 * WHICH VERSION OF A BOOK CAN BE ALIGNED TO ITS NARRATION.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-alignable-text.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The Generate-sentences picker listed the project's ARCHIVE PDF as a source to
 * align against (Owen, 2026-09-10: "generate sentences should only ever pick the
 * epub. the embedded text from pdfs cant be trusted"). The test was
 * `kind === 'ebook'`, and a PDF passes it — an archive PDF genuinely is an ebook
 * version of the book, which is why the versions page lists it.
 *
 * IT DOES NOT FAIL LOUDLY. That is the whole reason this has a test. A scanned
 * PDF has no text layer; a born-digital one has a layer in glyph-drawing order
 * with running heads, page numbers and footnote bodies interleaved into the
 * prose. Aligning to that produces a transcript that is subtly and permanently
 * wrong about what was said, sealed into the m4b, with nothing anywhere saying
 * so. The same reasoning is why this pipeline reads PDFs with a vision model
 * instead of pulling their text out.
 *
 * Two halves, and the second is not optional: the picker stops offering it, and
 * the align bridge REFUSES it — a queue row restored from before the fix and the
 * CLI both reach that door without passing the picker.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'alignable-text.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { isAlignableText, alignableTextRefusal } = require(MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

// The four versions of the book this bug was found on (Southern Slavery), in the
// shape the manifest stores them.
const ARCHIVE_PDF = { kind: 'ebook', format: 'pdf' };
const BOOK_EPUB = { kind: 'ebook', format: 'epub' };
const AUDIOBOOK = { kind: 'audiobook', format: 'm4b' };
const RVC_AUDIOBOOK = { kind: 'audiobook', format: 'm4b' };

test('the project EPUB is the alignable text', () => {
  assert.strictEqual(isAlignableText(BOOK_EPUB), true);
});

test('THE ARCHIVE PDF IS NOT, though it is an ebook version', () => {
  assert.strictEqual(ARCHIVE_PDF.kind, 'ebook',
    'the fixture must be what the manifest really stores, or this proves nothing');
  assert.strictEqual(isAlignableText(ARCHIVE_PDF), false);
});

test('an audiobook is not a text at all', () => {
  assert.strictEqual(isAlignableText(AUDIOBOOK), false);
  assert.strictEqual(isAlignableText(RVC_AUDIOBOOK), false);
});

test('the format is matched case- and whitespace-insensitively', () => {
  assert.strictEqual(isAlignableText({ kind: 'ebook', format: 'EPUB' }), true);
  assert.strictEqual(isAlignableText({ kind: 'ebook', format: ' epub ' }), true);
});

test('a version with no format stated is NOT assumed alignable', () => {
  // Absence is not epub. Guessing here would put a file of unknown shape into a
  // zip reader and call the result the book's words.
  assert.strictEqual(isAlignableText({ kind: 'ebook' }), false);
  assert.strictEqual(isAlignableText({ kind: 'ebook', format: '' }), false);
});

test('every other ebook format is refused rather than attempted', () => {
  for (const format of ['azw3', 'mobi', 'txt', 'docx', 'html']) {
    assert.strictEqual(isAlignableText({ kind: 'ebook', format }), false, format);
  }
});

// ── the refusal is a sentence a person can act on ───────────────────────────

test('an alignable version has no refusal', () => {
  assert.strictEqual(alignableTextRefusal(BOOK_EPUB, 'v1'), null);
});

test("the PDF refusal says it is a PDF, why, and what to do", () => {
  const why = alignableTextRefusal(ARCHIVE_PDF, 'arch:archive/slavery.pdf');
  assert.match(why, /PDF/);
  assert.match(why, /arch:archive\/slavery\.pdf/, 'it must name the version');
  assert.match(why, /Convert it to EPUB/, 'a refusal with no next step is a dead end');
});

test('an audiobook is refused for being an audiobook, not for its format', () => {
  const why = alignableTextRefusal(AUDIOBOOK, 'audiobook');
  assert.match(why, /not an ebook/);
});

test('another ebook format is refused by name', () => {
  const why = alignableTextRefusal({ kind: 'ebook', format: 'azw3' }, 'v9');
  assert.match(why, /azw3/);
  assert.match(why, /Convert it to EPUB/);
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`alignable-text: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
