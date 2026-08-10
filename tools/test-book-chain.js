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
 * And, later the same day, the restructure this file now defends: "the archive
 * item is the one the user should be clicking to open/view/etc… footnotes and
 * working changes should not be able to be opened or exported individually. only
 * deleted… footnotes and working changes are more ledgers than documents, to the
 * user's eyes." Two classes of line — DOCUMENTS and LEDGERS — and which acts
 * each carries is asserted as one claim per class below.
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

// ── DOCUMENTS open and export; LEDGERS only clear ────────────────────────────
//
// Owen, 2026-08-10: "the archive item is the one the user should be clicking to
// open/view/etc… footnotes and working changes should not be able to be opened
// or exported individually. only deleted… the tts document can have process/open
// /etc buttons since we actually do stuff with that and its a real tangible
// document, not a UI device used to show the user what's been done indirectly.
// footnotes and working changes are more ledgers than documents."
//
// This is the class boundary, asserted as one claim per class, because the whole
// destructive bug of 2026-08-10 was a LEDGER line carrying a document's Open.

/** Every kind that is a real file the user acts on. */
const DOCUMENT_KINDS = ['archive-pdf', 'working-pdf', 'book', 'narration', 'loose'];
/** Every kind that is a record of what was done, drawn under the document. */
const LEDGER_KINDS = ['working-changes', 'ledger'];

test('every DOCUMENT line carries the three standing acts', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN),
      row('cleaned', 'cleaned', 'epub', null)],
    families: [pdfChain([entry('01-simplify-aa', 'simplify', 'Simplify', true)])],
  });
  const documents = lines.filter((l) => DOCUMENT_KINDS.includes(l.kind));
  assert.deepStrictEqual(kindsOf(documents),
    ['archive-pdf', 'book', 'narration', 'loose'], 'every document kind is on screen');
  for (const line of documents) {
    assert.ok(line.buttons.open, `${line.kind} opens`);
    assert.ok(line.buttons.export, `${line.kind} exports`);
    assert.ok(line.buttons.delete, `${line.kind} deletes`);
  }
});

test('no LEDGER line opens or exports — clear is the only act it has', () => {
  const lines = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN)],
    families: [pdfChain([entry('01-simplify-aa', 'simplify', 'Simplify', true)])],
  });
  const ledgers = lines.filter((l) => LEDGER_KINDS.includes(l.kind));
  assert.deepStrictEqual(kindsOf(ledgers), ['working-changes', 'ledger']);
  for (const line of ledgers) {
    // Open on the footnote line opened the pass's SNAPSHOT as the project's
    // document, and the picker bound it writable without the project's edits —
    // one autosave from erasing them. The affordance is gone from the model.
    assert.strictEqual(line.buttons.open, false, `${line.kind} must not open`);
    assert.strictEqual(line.buttons.export, false, `${line.kind} must not export`);
    assert.strictEqual(line.buttons.delete, true, `${line.kind} clears`);
    // And none of the document specials either: a ledger runs nothing.
    assert.strictEqual(line.buttons.passes, false);
    assert.strictEqual(line.buttons.process, false);
    assert.strictEqual(line.buttons.analysis, false);
    assert.strictEqual(line.buttons.convert, false);
    assert.strictEqual(line.buttons.eraseEverything, false);
  }
});

test('the ARCHIVE line is the control centre: Open, Process, Erase, Delete', () => {
  // Owen: "the archive document will be the control center." Open lands on the
  // working copy (shared/document/artifact-open.ts) — the working document has
  // no line of its own and is invisible, which is asserted right above by there
  // being no 'working' kind at all.
  const book = bookChain({ rows: pdfProject, families: [pdfChain()] })
    .find((l) => l.kind === 'book');
  assert.strictEqual(book.buttons.open, true);
  assert.strictEqual(book.buttons.export, true);
  assert.strictEqual(book.buttons.passes, true, 'Process opens the passes here');
  assert.strictEqual(book.buttons.analysis, true);
  assert.strictEqual(book.buttons.eraseEverything, true);
  assert.strictEqual(book.buttons.delete, true);
});

test('a ledger line still offers Review changes — a ledger says what it did', () => {
  // Owen asked for it by name: "will it be possible to keep the review changes
  // button on footnotes/working changes, so we can open the file and see what
  // changed?" It is the one thing a ledger line shows, and it is not an Open.
  const lines = bookChain({
    rows: pdfProject,
    families: [pdfChain([entry('01-footnote-refs-aa', 'footnote-refs', 'Remove footnote references', true)])],
  });
  const [pass] = lines.filter((l) => l.kind === 'ledger');
  assert.strictEqual(pass.buttons.review, 'ready');
  assert.strictEqual(pass.buttons.open, false);
  assert.strictEqual(pass.buttons.export, false);
});

test('the TTS document keeps everything a real document has', () => {
  // Owen: "the tts document can have process/open/etc buttons since we actually
  // do stuff with that and its a real tangible document."
  const tts = bookChain({
    rows: [...pdfProject, row('narration', 'narration', 'epub', PDF_CHAIN)],
    families: [pdfChain()],
  }).find((l) => l.kind === 'narration');
  assert.strictEqual(tts.buttons.process, true);
  assert.strictEqual(tts.buttons.open, true);
  assert.strictEqual(tts.buttons.export, true);
  assert.strictEqual(tts.buttons.delete, true);
});

test('the working DOCUMENT has no line of its own — only its working CHANGES', () => {
  // "the working document shouldnt have a line item, it sohuld be invisible to
  // the user." It never had one; this is the claim said out loud, against both
  // origins, so a future arrangement cannot quietly give it one back.
  for (const [rows, families] of [
    [pdfProject, [pdfChain()]],
    [epubProject, [epubChain()]],
  ]) {
    const lines = bookChain({ rows, families });
    assert.ok(!lines.some((l) => l.kind === 'working'), 'no working-copy document line');
    assert.deepStrictEqual(
      kindsOf(lines.filter((l) => l.depth === 1)), ['working-changes'],
      'the copy appears only as the record of what was done to it');
  }
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
