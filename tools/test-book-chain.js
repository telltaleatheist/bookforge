#!/usr/bin/env node
/**
 * Tests for shared/document/book-chain.ts — two files on the page, and
 * everything else indented under them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-chain.js
 *
 * Owen, 2026-08-09: "the user would only ever see two files on the main page -
 * the pdf and the epub… under the epub… smaller, indented lines that say
 * 'working changes' or something… in whichever order they were originally
 * executed. the tts file is also indented under its parent." And: "from right to
 * left, on every file - delete, export, open. then, to the left of that are
 * special buttons, depending on whether the file is capable of running the
 * commands."
 *
 * What is asserted here is the ARRANGEMENT and the BUTTON MATRIX, which are the
 * two things that regress silently inside a 3400-line inline template: a line
 * that quietly stops being drawn, or a button that quietly appears on a row that
 * cannot perform it. Everything the page does with a line — which IPC a delete
 * calls, what a confirmation says — is the component's, and is not here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'book-chain.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { bookChain, bookRowType, describeWorkingChangesErase } = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const row = (id, type, extension) => ({ id, type, extension });

/** A project imported as a PDF whose pages have been read into a book. */
const pdfProject = [
  row('archive:archive/Deathstalker.pdf', 'archive', 'pdf'),
  row('generated', 'generated', 'epub'),
  row('exported', 'exported', 'epub'),
];

/** A project imported AS an EPUB: no archive row at all (main lists PDFs). */
const epubProject = [
  row('exported', 'exported', 'epub'),
];

const entry = (id, kind, label, hasReceipt) => ({
  id, kind, label, createdAt: '2026-08-09T10:00:00.000Z', hasReceipt,
});

const kindsOf = (lines) => lines.map((l) => l.kind);

test('a PDF project shows two top-level files and nothing else at depth 0', () => {
  const lines = bookChain({ rows: pdfProject, ledger: [] });
  const tops = lines.filter((l) => l.depth === 0);
  assert.deepStrictEqual(kindsOf(tops), ['archive-pdf', 'book']);
  // The working copy is NOT a line: the user's EPUB is the top-level line, and
  // opening it lands on the copy.
  assert.ok(!lines.some((l) => l.kind === 'working'), 'no working-copy line');
});

test('the book line of a PDF project is the CAST book, not the working copy', () => {
  assert.strictEqual(bookRowType(pdfProject), 'generated');
  const book = bookChain({ rows: pdfProject, ledger: [] }).find((l) => l.kind === 'book');
  assert.strictEqual(book.rowId, 'generated');
});

test('an EPUB-native project has one top-level file, and it is the book', () => {
  assert.strictEqual(bookRowType(epubProject), 'exported');
  const lines = bookChain({ rows: epubProject, ledger: [] });
  assert.deepStrictEqual(kindsOf(lines.filter((l) => l.depth === 0)), ['book']);
});

test('the chain under the book is working changes, then the ledger in order, then TTS', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub')],
    ledger: [
      entry('01-simplify-aa', 'simplify', 'Simplify', true),
      entry('02-translate-bb', 'translate', 'Translate', false),
    ],
  });
  assert.deepStrictEqual(kindsOf(lines), [
    'archive-pdf', 'book', 'working-changes', 'ledger', 'ledger', 'narration',
  ]);
  assert.ok(lines.slice(2).every((l) => l.depth === 1), 'every chain line is indented');
  // In whichever order they were originally executed — the ledger's own order,
  // never sorted by label or by kind.
  assert.deepStrictEqual(
    lines.filter((l) => l.kind === 'ledger').map((l) => l.ledgerId),
    ['01-simplify-aa', '02-translate-bb']);
});

test('every line carries the three standing acts', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub')],
    ledger: [entry('01-simplify-aa', 'simplify', 'Simplify', true)],
  });
  for (const line of lines) {
    if (line.kind === 'working-changes') continue;
    assert.ok(line.buttons.open, `${line.kind} opens`);
    assert.ok(line.buttons.export, `${line.kind} exports`);
    assert.ok(line.buttons.delete, `${line.kind} deletes`);
  }
  // The one exception, and it is a fact rather than an omission: the
  // working-changes line names no file, so the book line above IS its Open.
  const records = lines.find((l) => l.kind === 'working-changes');
  assert.strictEqual(records.buttons.open, false);
  assert.strictEqual(records.buttons.export, false);
  assert.strictEqual(records.buttons.delete, true);
});

test('Convert is on the PDF lines only, and Generate analysis is never on a PDF', () => {
  const lines = bookChain({ rows: pdfProject, ledger: [] });
  const pdf = lines.find((l) => l.kind === 'archive-pdf');
  const book = lines.find((l) => l.kind === 'book');
  assert.strictEqual(pdf.buttons.convert, true);
  assert.strictEqual(pdf.buttons.analysis, false, 'Owen: analysis not on PDFs');
  assert.strictEqual(book.buttons.convert, false);
  assert.strictEqual(book.buttons.analysis, true);
});

test('Process opens the passes on the book and takes the TTS copy to narration', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub')],
    ledger: [],
  });
  const book = lines.find((l) => l.kind === 'book');
  const tts = lines.find((l) => l.kind === 'narration');
  assert.strictEqual(book.buttons.passes, true);
  assert.strictEqual(book.buttons.process, false, 'the book does not go to narration directly');
  assert.strictEqual(tts.buttons.process, true);
  assert.strictEqual(tts.buttons.passes, false, 'no passes on the narration cut');
});

test('Review changes is offered per ledger line, and says so when the diff is missing', () => {
  const lines = bookChain({
    rows: pdfProject,
    ledger: [
      entry('01-simplify-aa', 'simplify', 'Simplify', true),
      entry('02-translate-bb', 'translate', 'Translate', false),
    ],
  });
  const [withDiff, without] = lines.filter((l) => l.kind === 'ledger');
  assert.strictEqual(withDiff.buttons.review, 'ready');
  // NOT 'none': a pass that rewrote the book and left no diff is a disabled
  // button with a reason, never a silent gap.
  assert.strictEqual(without.buttons.review, 'no-receipt');
  assert.strictEqual(lines.find((l) => l.kind === 'book').buttons.review, 'none');
});

test('Erase all changes is a SPECIAL on every book line, and never the delete', () => {
  // Owen, 2026-08-10: "its a specialty button, and should be on the left side
  // instead of covering the delete button." The delete column is 78px because
  // "Delete" is; the erase act's name lives where width is not rationed.
  //
  // PDF-origin: the book line is the cast. Erase is a special; Delete stays,
  // because deleting the CAST is a real, different, heavier act.
  const cast = bookChain({ rows: pdfProject, ledger: [] }).find((l) => l.kind === 'book');
  assert.strictEqual(cast.buttons.eraseEverything, true);
  assert.strictEqual(cast.buttons.delete, true);
  // EPUB-native: the book line IS the working copy, whose only honest delete
  // is the erase — so the delete column is EMPTY, not a second name for it.
  const own = bookChain({ rows: epubProject, ledger: [] }).find((l) => l.kind === 'book');
  assert.strictEqual(own.buttons.eraseEverything, true);
  assert.strictEqual(own.buttons.delete, false);
});

test('a PDF nobody has converted is one line, with no book and no chain', () => {
  const lines = bookChain({ rows: [row('archive:a.pdf', 'archive', 'pdf')], ledger: [] });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf']);
  assert.strictEqual(bookRowType([row('archive:a.pdf', 'archive', 'pdf')]), null);
});

test('a legacy working PDF is indented under its archive PDF', () => {
  const lines = bookChain({
    rows: [row('archive:a.pdf', 'archive', 'pdf'), row('working:w.pdf', 'working', 'pdf')],
    ledger: [],
  });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf', 'working-pdf']);
  assert.strictEqual(lines[1].depth, 1);
  assert.strictEqual(lines[1].buttons.convert, true);
});

test('stage outputs the chain does not claim keep a top-level line of their own', () => {
  const lines = bookChain({
    rows: [...epubProject, row('cleaned', 'cleaned', 'epub'), row('original', 'original', 'pdf')],
    ledger: [],
  });
  assert.deepStrictEqual(kindsOf(lines), ['book', 'working-changes', 'loose', 'loose']);
  // No passes, no analysis, no convert — they are not the book, and a Simplify
  // hanging off one would promise to rewrite that file.
  for (const loose of lines.filter((l) => l.kind === 'loose')) {
    assert.strictEqual(loose.buttons.passes, false);
    assert.strictEqual(loose.buttons.analysis, false);
    assert.strictEqual(loose.buttons.convert, false);
  }
});

test('a ledger with no working copy behind it draws no chain at all', () => {
  // The ledger is read off the exported row, so this state cannot arise from
  // main — asserted so it cannot arise from a future caller either.
  const lines = bookChain({
    rows: [row('archive:a.pdf', 'archive', 'pdf')],
    ledger: [entry('01-simplify-aa', 'simplify', 'Simplify', true)],
  });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf']);
});

test('every line key is unique, so the list can be tracked', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub'), row('cleaned', 'cleaned', 'epub')],
    ledger: [
      entry('01-simplify-aa', 'simplify', 'Simplify', true),
      entry('02-simplify-cc', 'simplify', 'Simplify', true),
    ],
  });
  const keys = lines.map((l) => l.key);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate key in ${keys.join(', ')}`);
});

test('the working-changes confirmation names the passes it KEEPS', () => {
  const none = describeWorkingChangesErase([]);
  assert.ok(/archive-grade/.test(none), none);
  const kept = describeWorkingChangesErase(['Simplify', 'Translate']);
  assert.ok(kept.includes('Simplify'), kept);
  assert.ok(kept.includes('Translate'), kept);
  // The whole point of the narrower scope: an hour of model time is not thrown
  // away by a user clearing their own edits.
  assert.ok(/stay applied/.test(kept), kept);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
