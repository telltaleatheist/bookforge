#!/usr/bin/env node
/**
 * Tests for shared/document/book-chain.ts — one book line per working chain, and
 * everything else indented under the chain that owns it.
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
 * And, 2026-08-10: "i do have different versions of books, and i want to be able
 * to run adjustment chains on different versions. tts copies will be nested under
 * their respective parent item, and if the user wants to process a specific TTS
 * document then they click the process button next to it. no ambiguity, no
 * confusion."
 *
 * What is asserted here is the ARRANGEMENT and the BUTTON MATRIX, which are the
 * two things that regress silently inside a 4000-line inline template: a line
 * that quietly stops being drawn, or a button that quietly appears on a row that
 * cannot perform it. Everything the page does with a line — which IPC a delete
 * calls, what a confirmation says — is the component's, and is not here.
 *
 * ── The regression proof for families ───────────────────────────────────────
 *
 * The SOLE-CHAIN half of this file is the same set of claims it made before
 * per-family chains landed, asserted against the same two fixtures. The inputs
 * gained a `families` list and the rows gained the chain they are on; the
 * arrangement and the buttons a one-chain project draws did not move, and that
 * equivalence is what says ~385 existing projects render exactly as they did.
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

/** A row exactly as `editor:get-versions` emits it, chain and all. */
const row = (id, type, extension, familyId) => ({ id, type, extension, familyId: familyId ?? null });

/**
 * A chain, as the arrangement needs it. `ledger` and `archiveRowId` are the two
 * things the LAYOUT reads; the rest is identity. `hasWorkingChanges` defaults
 * TRUE here so every arrangement claim below keeps asserting the full chain;
 * the gate it drives has its own tests.
 */
const family = (id, sourceKind, sourceName, ledger, archiveRowId, hasWorkingChanges) => ({
  id, sourceKind, sourceName, ledger: ledger ?? [], archiveRowId: archiveRowId ?? null,
  hasWorkingChanges: hasWorkingChanges ?? true,
});

// ── The two fixtures every sole-chain claim is made against ──────────────────

const PDF_CHAIN = 'fam-aaaaaaaa';
const PDF_ROW = 'archive:archive/Deathstalker.pdf';

/** A project imported as a PDF whose pages have been read into a book. */
const pdfProject = [
  row(PDF_ROW, 'archive', 'pdf', null),
  row('generated', 'generated', 'epub', PDF_CHAIN),
  row('exported', 'exported', 'epub', PDF_CHAIN),
];
const pdfChain = (ledger) =>
  family(PDF_CHAIN, 'generated-epub', 'Deathstalker.generated.epub', ledger, PDF_ROW);

const EPUB_CHAIN = 'fam-bbbbbbbb';

/** A project imported AS an EPUB: no archive row at all (main lists PDFs). */
const epubProject = [
  row('exported', 'exported', 'epub', EPUB_CHAIN),
];
const epubChain = (ledger) =>
  family(EPUB_CHAIN, 'archive-epub', 'Killing America.epub', ledger, null);

const entry = (id, kind, label, hasReceipt) => ({
  id, kind, label, createdAt: '2026-08-09T10:00:00.000Z', hasReceipt,
});

const kindsOf = (lines) => lines.map((l) => l.kind);

// ─────────────────────────────────────────────────────────────────────────────
// SOLE CHAIN — the arrangement and the button matrix, unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('a PDF project shows two top-level files and nothing else at depth 0', () => {
  const lines = bookChain({ rows: pdfProject, families: [pdfChain()] });
  const tops = lines.filter((l) => l.depth === 0);
  assert.deepStrictEqual(kindsOf(tops), ['archive-pdf', 'book']);
  // The working copy is NOT a line: the user's EPUB is the top-level line, and
  // opening it lands on the copy.
  assert.ok(!lines.some((l) => l.kind === 'working'), 'no working-copy line');
});

test('the book line of a PDF project is the CAST book, not the working copy', () => {
  assert.strictEqual(bookRowType(pdfProject, pdfChain()), 'generated');
  const book = bookChain({ rows: pdfProject, families: [pdfChain()] })
    .find((l) => l.kind === 'book');
  assert.strictEqual(book.rowId, 'generated');
});

test('an EPUB-native project has one top-level file, and it is the book', () => {
  assert.strictEqual(bookRowType(epubProject, epubChain()), 'exported');
  const lines = bookChain({ rows: epubProject, families: [epubChain()] });
  assert.deepStrictEqual(kindsOf(lines.filter((l) => l.depth === 0)), ['book']);
});

test('the chain under the book is working changes, then the ledger in order, then TTS', () => {
  const ledger = [
    entry('01-simplify-aa', 'simplify', 'Simplify', true),
    entry('02-translate-bb', 'translate', 'Translate', false),
  ];
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN)],
    families: [pdfChain(ledger)],
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
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN)],
    families: [pdfChain([entry('01-simplify-aa', 'simplify', 'Simplify', true)])],
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
  const lines = bookChain({ rows: pdfProject, families: [pdfChain()] });
  const pdf = lines.find((l) => l.kind === 'archive-pdf');
  const book = lines.find((l) => l.kind === 'book');
  assert.strictEqual(pdf.buttons.convert, true);
  assert.strictEqual(pdf.buttons.analysis, false, 'Owen: analysis not on PDFs');
  assert.strictEqual(book.buttons.convert, false);
  assert.strictEqual(book.buttons.analysis, true);
});

test('Process opens the passes on the book and takes the TTS copy to narration', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN)],
    families: [pdfChain()],
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
    families: [pdfChain([
      entry('01-simplify-aa', 'simplify', 'Simplify', true),
      entry('02-translate-bb', 'translate', 'Translate', false),
    ])],
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
  const cast = bookChain({ rows: pdfProject, families: [pdfChain()] })
    .find((l) => l.kind === 'book');
  assert.strictEqual(cast.buttons.eraseEverything, true);
  assert.strictEqual(cast.buttons.delete, true);
  // EPUB-native: the book line IS the working copy. Its Delete routes to the
  // same erase the special performs — Owen ruled delete is ALWAYS available
  // (2026-08-10), and the special stays because it is the act's honest name.
  const own = bookChain({ rows: epubProject, families: [epubChain()] })
    .find((l) => l.kind === 'book');
  assert.strictEqual(own.buttons.eraseEverything, true);
  assert.strictEqual(own.buttons.delete, true);
});

test('a PDF nobody has converted is one line, with no book and no chain', () => {
  // It has no FAMILY either, and that is the same fact: a chain hangs off an
  // archive-grade EPUB and this project has none yet.
  const lines = bookChain({ rows: [row('archive:a.pdf', 'archive', 'pdf', null)], families: [] });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf']);
  assert.strictEqual(lines[0].familyId, null, 'a PDF is on no chain');
});

test('a chain whose book row is not on screen draws no book line', () => {
  // The state `bookRowType` returns null for. Asserted so a chain recorded
  // against a book nobody can find does not draw an empty line with buttons.
  const orphan = family('fam-cccccccc', 'archive-epub', 'Gone.epub', [], null);
  assert.strictEqual(bookRowType([], orphan), null);
  assert.deepStrictEqual(bookChain({ rows: [], families: [orphan] }), []);
});

test('a legacy working PDF is indented under its archive PDF', () => {
  const lines = bookChain({
    rows: [
      row('archive:a.pdf', 'archive', 'pdf', null),
      row('working:w.pdf', 'working', 'pdf', null),
    ],
    families: [],
  });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf', 'working-pdf']);
  assert.strictEqual(lines[1].depth, 1);
  assert.strictEqual(lines[1].buttons.convert, true);
});

test('stage outputs the chain does not claim keep a top-level line of their own', () => {
  const lines = bookChain({
    rows: [
      ...epubProject,
      row('cleaned', 'cleaned', 'epub', null),
      row('original', 'original', 'pdf', null),
    ],
    families: [epubChain()],
  });
  assert.deepStrictEqual(kindsOf(lines), ['book', 'working-changes', 'loose', 'loose']);
  // No passes, no analysis, no convert — they are not the book, and a Simplify
  // hanging off one would promise to rewrite that file.
  for (const loose of lines.filter((l) => l.kind === 'loose')) {
    assert.strictEqual(loose.buttons.passes, false);
    assert.strictEqual(loose.buttons.analysis, false);
    assert.strictEqual(loose.buttons.convert, false);
    assert.strictEqual(loose.familyId, null, 'a stage output is on no chain');
  }
});

test('a ledger with no working copy behind it draws no chain at all', () => {
  // The ledger is read off the exported row, so this state cannot arise from
  // main — asserted so it cannot arise from a future caller either.
  const lines = bookChain({
    rows: [row('archive:a.pdf', 'archive', 'pdf', null)],
    families: [family('fam-dddddddd', 'archive-epub', 'Nothing.epub',
      [entry('01-simplify-aa', 'simplify', 'Simplify', true)], null)],
  });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf']);
});

test('every line key is unique, so the list can be tracked', () => {
  const lines = bookChain({
    rows: [
      ...pdfProject,
      row('narration', 'narration', 'epub', PDF_CHAIN),
      row('cleaned', 'cleaned', 'epub', null),
    ],
    families: [pdfChain([
      entry('01-simplify-aa', 'simplify', 'Simplify', true),
      entry('02-simplify-cc', 'simplify', 'Simplify', true),
    ])],
  });
  const keys = lines.map((l) => l.key);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate key in ${keys.join(', ')}`);
});

test('a chain with nothing to erase draws NO working-changes line', () => {
  // The line used to draw whenever a working copy existed — and a successful
  // erase re-mints the copy on the spot, so it reappeared instantly and the
  // erase looked like it did nothing (Owen, 2026-08-10: "it blinked and
  // reloaded, and it was still there").
  const untouched = { ...epubChain(), hasWorkingChanges: false };
  const lines = bookChain({ rows: epubProject, families: [untouched] });
  assert.deepStrictEqual(kindsOf(lines), ['book']);
});

test('the ledger still draws when the working changes are gone', () => {
  // Erasing at the 'working-changes' scope keeps the passes: the records line
  // goes, the ledger lines stand — they are different deletes.
  const erased = {
    ...pdfChain([entry('01-simplify-aa', 'simplify', 'Simplify', true)]),
    hasWorkingChanges: false,
  };
  const lines = bookChain({ rows: pdfProject, families: [erased] });
  assert.deepStrictEqual(kindsOf(lines), ['archive-pdf', 'book', 'ledger']);
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

// ─────────────────────────────────────────────────────────────────────────────
// SEVERAL CHAINS — a book line each, side by side, and every line says which
// ─────────────────────────────────────────────────────────────────────────────

const FIRST = 'fam-11111111';
const SECOND = 'fam-22222222';

/** Two editions of one book the user handed us, each with its own chain. */
const twoEditionRows = [
  row(`exported:${FIRST}`, 'exported', 'epub', FIRST),
  row(`narration:${FIRST}`, 'narration', 'epub', FIRST),
  row(`exported:${SECOND}`, 'exported', 'epub', SECOND),
  row(`narration:${SECOND}`, 'narration', 'epub', SECOND),
];
const twoEditions = [
  family(FIRST, 'archive-epub', 'Dune.epub', [entry('01-simplify-aa', 'simplify', 'Simplify', true)], null),
  family(SECOND, 'archive-epub', 'Dune (Folio).epub', [], null),
];

test('two chains draw two book lines, each with its own chain under it', () => {
  const lines = bookChain({ rows: twoEditionRows, families: twoEditions });
  assert.deepStrictEqual(kindsOf(lines), [
    'book', 'working-changes', 'ledger', 'narration',
    'book', 'working-changes', 'narration',
  ]);
  assert.deepStrictEqual(
    lines.filter((l) => l.depth === 0).map((l) => l.rowId),
    [`exported:${FIRST}`, `exported:${SECOND}`]);
});

test('every line of a chain carries that chain, and no line carries the other', () => {
  const lines = bookChain({ rows: twoEditionRows, families: twoEditions });
  assert.deepStrictEqual(lines.map((l) => l.familyId), [
    FIRST, FIRST, FIRST, FIRST, SECOND, SECOND, SECOND,
  ]);
  // The chain of custody, on the line rather than looked up: with two book lines
  // the source basename is the only thing that tells them apart.
  assert.deepStrictEqual(
    lines.filter((l) => l.kind === 'book').map((l) => l.sourceName),
    ['Dune.epub', 'Dune (Folio).epub']);
});

test('one chain\'s ledger never appears under another chain\'s book', () => {
  const lines = bookChain({ rows: twoEditionRows, families: twoEditions });
  const ledgerLines = lines.filter((l) => l.kind === 'ledger');
  assert.strictEqual(ledgerLines.length, 1);
  assert.strictEqual(ledgerLines[0].familyId, FIRST);
  assert.strictEqual(ledgerLines[0].rowId, `exported:${FIRST}`,
    'a ledger line acts on ITS OWN chain\'s working copy');
});

test('each chain\'s narration copy carries its own Process and its own chain', () => {
  // Owen: "if the user wants to process a specific TTS document then they click
  // the process button next to it. no ambiguity, no confusion."
  const lines = bookChain({ rows: twoEditionRows, families: twoEditions });
  const tts = lines.filter((l) => l.kind === 'narration');
  assert.strictEqual(tts.length, 2);
  assert.deepStrictEqual(tts.map((l) => l.familyId), [FIRST, SECOND]);
  assert.ok(tts.every((l) => l.buttons.process), 'both narration lines process');
  assert.deepStrictEqual(tts.map((l) => l.rowId),
    [`narration:${FIRST}`, `narration:${SECOND}`]);
});

test('a PDF-origin chain is drawn with its archive PDF, and the PDF says which', () => {
  const CAST = 'fam-33333333';
  const PDF = 'archive:archive/Deathstalker.pdf';
  const lines = bookChain({
    rows: [
      row(PDF, 'archive', 'pdf', null),
      row('generated', 'generated', 'epub', CAST),
      row(`exported:${CAST}`, 'exported', 'epub', CAST),
      row(`exported:${SECOND}`, 'exported', 'epub', SECOND),
    ],
    families: [
      // The manifest's order puts the edition FIRST; the cast chain is still
      // drawn beside the PDF it came out of, because that is the file it is the
      // reading of.
      family(SECOND, 'archive-epub', 'Dune (Folio).epub', [], null),
      family(CAST, 'generated-epub', 'Deathstalker.generated.epub', [], PDF),
    ],
  });
  assert.deepStrictEqual(kindsOf(lines), [
    'archive-pdf', 'book', 'working-changes', 'book', 'working-changes',
  ]);
  // The PDF has no chain of its own — Owen: "PDFs have no working chain" — but
  // it names the one book that came out of it, which is what draws them
  // together and what an act taken from the PDF row hands back.
  assert.strictEqual(lines[0].familyId, CAST);
  assert.strictEqual(lines[1].rowId, 'generated', 'the cast is the book line');
  assert.strictEqual(lines[1].familyId, CAST);
  assert.strictEqual(lines[3].familyId, SECOND);
});

test('a row whose chain the project does not have is drawn LOOSE, never dropped', () => {
  // IPC shape drift rather than a state. A file main measured with no line on
  // the page is work with no door, which is the bug the versions rebuild
  // started from — so it gets its three standing acts and none of the chain
  // specials, because nothing here can say which book it is a copy of.
  const lines = bookChain({
    rows: [row('exported:fam-ffffffff', 'exported', 'epub', 'fam-ffffffff')],
    families: [],
  });
  assert.deepStrictEqual(kindsOf(lines), ['loose']);
  assert.strictEqual(lines[0].familyId, null);
  assert.strictEqual(lines[0].buttons.eraseEverything, false);
  assert.strictEqual(lines[0].buttons.passes, false);
});

test('two chains keep every line key distinct', () => {
  const lines = bookChain({ rows: twoEditionRows, families: twoEditions });
  const keys = lines.map((l) => l.key);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate key in ${keys.join(', ')}`);
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
