#!/usr/bin/env node
/**
 * Tests for the book's LEDGER: the passes a user committed to, each one
 * deletable on its own, composed with the working changes that overlay them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-ledger-lifecycle.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Owen's truth table, verbatim: "if they delete working changes but keep
 * footnotes, the working copy will have no changes except footnotes removed. if
 * they delete footnotes AND working changes, itll be byte identical to the
 * archive copy. if they delete footnotes, itll only have working changes
 * present. like chapter renaming, deletions, etc."
 *
 * Three states of one book, and the only way to prove a claim about bytes is to
 * put bytes on a disk and hash them. So every fixture here is a real project
 * under the OS temp directory with real (small, synthetic) EPUBs in it, and the
 * pass that makes a ledger entry is a real rewrite of those EPUBs recorded
 * through `registerLedgerPass` — the SAME helper electron/processing-passes.ts
 * calls after a simplify. Driving that helper is the point: a test that
 * hand-wrote ledger entries would be testing its own idea of one.
 *
 * NOTHING in the user's library is read or written — the library base path is
 * pointed at the fixture root for the duration, and the root is removed at the
 * end.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'book-ledger.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { registerLedgerPass } = require(path.join(DIST, 'electron', 'book-ledger.js'));
// The picker's working state is a per-project sidecar, so "was the curation
// cleared?" is a question about `editor-state.json` — asked through the module
// that owns the file, not by reaching for `manifest.editor`, which is only the
// pre-sidecar location a fixture may still be written in.
const { peekEditorStateSync } =
  require(path.join(DIST, 'electron', 'editor-state-store.js'));
const { ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  bookDigestOf, bookEntryBytes, bookEntryNames, bookEntryText, placeBook, replaceBookEntry,
} = require('./fixture-book');
const { removeEpubContainer } = require(path.join(DIST, 'electron', 'epub-container.js'));
const { runProcessingPass } = require(path.join(DIST, 'electron', 'processing-passes.js'));
const {
  ledgerAfterDeleting, describeLedgerDeletion, listLedgerLabels,
} = require(path.join(DIST, 'shared', 'document', 'book-ledger.js'));

// THE BOOK'S identity as the app records it. The working copy and every ledger
// snapshot taken of it are FOLDERS of a book's parts now, so nothing here may
// readFileSync one — and two folders are still compared by digest, exactly as
// two files were.
const sha256 = (book) => bookDigestOf(book);

/**
 * Two books hold the same entries with the same bytes.
 *
 * "Byte-identical to the archive original" is what a derived working copy used
 * to be, and it cannot be said that way any more: the archive is a file hashed
 * over its compressed bytes and the copy is a folder hashed over its contents,
 * so the two never share a digest no matter how identical the book is. This is
 * the same claim, proved the way `deriveWorkingCopy` proves it — entry for
 * entry, names and bytes.
 */
async function sameBook(a, b, message) {
  const [an, bn] = await Promise.all([bookEntryNames(a), bookEntryNames(b)]);
  assert.deepStrictEqual([...an].sort(), [...bn].sort(), message);
  for (const name of an) {
    const [ab, bb] = await Promise.all([bookEntryBytes(a, name), bookEntryBytes(b, name)]);
    assert.ok(ab.equals(bb), `${message} (${name})`);
  }
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

const writeManifest = (dir, manifest) =>
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

/**
 * The book record, where it lives now: under the family that owns it.
 *
 * `manifest.outputs.epub` was the one book a project could have, and the ledger
 * hangs off it. Every fixture in this file goes through `makeProject`, which
 * mints its one chain during setup (`ensureBookEpub`), so by the time a test
 * body reads or mutates the book record the legacy field is already gone and
 * this is where it lives instead.
 */
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

const ledgerOf = (dir) => bookRecordOf(dir).ledger ?? [];

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A real (tiny) EPUB, because the guard walks one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The book's two chapters as paragraph text. A "pass" here rewrites these
 * strings and the book is rebuilt from them, which is exactly the shape of the
 * real thing: same spine, same elements, different words.
 */
const CHAPTER_ONE = ['It was 1998, and the machine hummed.', 'She counted 12 of them.'];
const CHAPTER_TWO = ['The 3rd door was open.', 'Nobody had been through it.'];

/**
 * Write an EPUB whose spine documents hold exactly the paragraphs given.
 *
 * Deliberately minimal and deliberately REAL: `registerLedgerPass` opens the
 * book and walks its elements to check the pass left the structure alone, so a
 * stub file would exercise nothing that matters.
 */
async function writeEpub(outPath, chapters) {
  const docs = chapters.map((paragraphs, i) => ({
    name: `ch${i + 1}.xhtml`,
    xhtml: '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter '
      + `${i + 1}</title></head><body>`
      + paragraphs.map((p) => `<p>${p}</p>`).join('')
      + '</body></html>',
  }));
  const manifestItems = docs
    .map((d, i) => `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = docs.map((_, i) => `<itemref idref="d${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:ledger-test</dc:identifier>
<dc:title>The Ledger</dc:title><dc:language>en</dc:language></metadata>
<manifest>${manifestItems}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine>${spine}</spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol>${docs
  .map((d, i) => `<li><a href="${d.name}">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  for (const d of docs) zw.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  await zw.write(outPath);
  return outPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// A pass, run the way the real ones are run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite the book in place and record it — an `appliedPasses` entry and, when
 * the ledger will have it, an entry of its own.
 *
 * This mirrors `runSimplifyPass` step for step: produce the file in a stage
 * directory, move it onto the recorded book, write the diff, append the
 * provenance record, then `registerLedgerPass`. The transform is scripted rather
 * than an AI call, which is the only difference that matters here.
 */
async function runPass(dir, { kind, label, chapters }) {
  const book = await manifestService.readExportEpub(dir);
  assert.ok(book, 'runPass: the project records no book');

  const stageRel = await manifestService.nextPassStageRelDir(dir, kind);
  const stageAbs = path.join(dir, stageRel.split('/').join(path.sep));
  fs.mkdirSync(stageAbs, { recursive: true });

  // The produced book is an ARCHIVE (a renderer and a model both hand this app
  // zip bytes) and the working copy is a FOLDER of the book's parts, so landing
  // it is no longer a rename — it is the conversion `replaceBookEpub` performs,
  // proved entry for entry. Written the same way here so this helper still
  // mirrors the real pass step for step.
  const produced = path.join(stageAbs, 'out.epub');
  await writeEpub(produced, chapters);
  await placeBook(produced, book.absPath);
  fs.rmSync(produced);

  const diffRel = `${stageRel}/diff.json`;
  fs.writeFileSync(
    path.join(stageAbs, 'diff.json'),
    JSON.stringify({ version: 1, pass: kind, chapters: [] }, null, 2));

  const applied = { kind, at: new Date().toISOString(), params: {}, diff: diffRel };
  // `{ outcome: 'none' }` and not a carry: this helper is about the LEDGER, and
  // it writes the book with `fs.renameSync` rather than through the pass code
  // that proves a carry. Carrying the strikes across a real pass is
  // tools/test-narration-carry.js.
  await manifestService.appendAppliedPass(dir, applied, { outcome: 'none' });
  return registerLedgerPass(dir, { kind, label, pass: applied });
}

/** Every record an evening of work leaves, all at once. */
function populateRecords(dir) {
  const manifest = readManifest(dir);
  manifest.editor = { undoStack: [{ kind: 'split' }], blockEdits: { 'b-1': 'corrected' } };
  manifest.source = { ...manifest.source, deletedBlockIds: ['b-1', 'b-2'], deletedPages: [4] };
  manifest.chapters = [{ id: 'c1', title: 'One', page: 1, level: 1 }];
  manifest.chaptersSource = 'editor';
  // Every fixture reaching this point has already been through `makeProject`,
  // which mints the chain, so the book record to strike is the family's.
  const families = manifest.families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  families[0].epub.narrationDeletions = {
    elements: ['OEBPS/ch1.xhtml#1'], epubSha256: 'whatever',
  };
  writeManifest(dir, manifest);
}

function assertRecordsPresent(dir, label) {
  const m = readManifest(dir);
  assert.ok(peekEditorStateSync(dir), `${label}: the editor state was cleared`);
  assert.deepStrictEqual(
    m.source.deletedBlockIds, ['b-1', 'b-2'], `${label}: block deletions were cleared`);
  assert.deepStrictEqual(m.source.deletedPages, [4], `${label}: page deletions were cleared`);
  assert.ok(m.chapters, `${label}: chapter markers were cleared`);
  assert.ok(bookRecordOf(dir).narrationDeletions, `${label}: narration strikes were cleared`);
}

function assertRecordsCleared(dir, label) {
  const m = readManifest(dir);
  assert.strictEqual(m.editor, undefined, `${label}: manifest.editor survived`);
  assert.strictEqual(
    peekEditorStateSync(dir), null, `${label}: the editor state sidecar survived`);
  assert.strictEqual(m.source.deletedBlockIds, undefined, `${label}: block deletions survived`);
  assert.strictEqual(m.source.deletedPages, undefined, `${label}: page deletions survived`);
  assert.strictEqual(m.chapters, undefined, `${label}: chapter markers survived`);
  assert.strictEqual(
    bookRecordOf(dir).narrationDeletions, undefined, `${label}: narration strikes survived`);
}

/**
 * Erase, as its underlying calls — the same two `book:erase-changes` makes.
 *
 * The IPC handler is those calls plus a window to destroy and a broadcast;
 * wrapping it would need an Electron main process and would test the wrapper.
 */
async function erase(dir, scope) {
  if (scope === 'everything') await manifestService.clearBookLedger(dir);
  const before = await manifestService.readExportEpub(dir);
  await removeEpubContainer(before.absPath);
  return manifestService.ensureBookEpub(dir);
}

// ── Fixture root ─────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ledger-'));
manifestService.setLibraryBasePath(ROOT);
const projectsDir = path.join(ROOT, 'projects');

/** A project imported AS an EPUB, with its archive original on disk. */
async function makeProject(id) {
  return makeProjectWith(id, [CHAPTER_ONE, CHAPTER_TWO]);
}

async function makeProjectWith(id, chapters) {
  const dir = path.join(projectsDir, id);
  await writeEpub(path.join(dir, 'archive', 'The Ledger.epub'), chapters);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Ledger' },
    source: { type: 'epub', originalFilename: 'The Ledger.epub' },
    archive: [{ path: 'archive/The Ledger.epub', role: 'original', format: 'epub' }],
    outputs: {},
  });
  await manifestService.ensureBookEpub(dir);
  return dir;
}

const archiveOf = (dir) => path.join(dir, 'archive', 'The Ledger.epub');

/** Digits stripped — a text-only rewrite, which is what a ledger pass must be. */
const undigit = (paragraphs) => paragraphs.map((p) => p.replace(/\d+/g, 'some'));

// ── The pure rule, first: it decides everything below ────────────────────────

test('the cascade rule takes the named entry and everything after it', () => {
  const entries = [
    { id: 'a', kind: 'simplify', label: 'Simplify', createdAt: '1' },
    { id: 'b', kind: 'translate', label: 'Translate to fr', createdAt: '2' },
    { id: 'c', kind: 'simplify', label: 'Simplify', createdAt: '3' },
  ];
  const middle = ledgerAfterDeleting(entries, 'b');
  assert.deepStrictEqual(middle.kept.map((e) => e.id), ['a']);
  assert.deepStrictEqual(middle.cascaded.map((e) => e.id), ['b', 'c']);

  const last = ledgerAfterDeleting(entries, 'c');
  assert.deepStrictEqual(last.kept.map((e) => e.id), ['a', 'b']);
  assert.deepStrictEqual(last.cascaded.map((e) => e.id), ['c'],
    'deleting the last entry must cascade nothing');

  assert.throws(
    () => ledgerAfterDeleting(entries, 'nope'),
    (err) => /has no entry "nope"/.test(err.message),
    'an id the ledger does not hold must be refused by name');
});

test('the deletion sentence NAMES the entries that went with it', () => {
  const said = describeLedgerDeletion(ledgerAfterDeleting([
    { id: 'a', kind: 'simplify', label: 'Simplify', createdAt: '1' },
    { id: 'b', kind: 'translate', label: 'Translate to fr', createdAt: '2' },
    { id: 'c', kind: 'simplify', label: 'Simplify again', createdAt: '3' },
  ], 'a'));
  assert.ok(/Translate to fr/.test(said), `the cascade is not named: ${said}`);
  assert.ok(/Simplify again/.test(said), `the cascade is not named in full: ${said}`);
  assert.ok(/archive-grade original/.test(said), `it does not say where the book landed: ${said}`);
  assert.ok(/working changes are untouched/.test(said),
    `it does not say the records survived: ${said}`);
  assert.strictEqual(listLedgerLabels([]), '', 'an empty ledger has no labels to list');
});

// ── A pass makes an entry ────────────────────────────────────────────────────

test('a text-only pass records a ledger entry with a snapshot and a frozen diff', async () => {
  const dir = await makeProject('ledger-register');
  const recorded = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });

  assert.strictEqual(recorded.refusal, null, `the entry was refused: ${recorded.refusal}`);
  const entry = recorded.entry;
  assert.ok(entry, 'no ledger entry was recorded');
  assert.strictEqual(entry.label, 'Simplify');
  assert.ok(entry.dir.startsWith('source/ledger/'), `the entry is not under source/ledger: ${entry.dir}`);

  const book = await manifestService.readExportEpub(dir);
  assert.strictEqual(
    await sha256(path.join(dir, entry.snapshot.split('/').join(path.sep))), await sha256(book.absPath),
    'the snapshot is not the book the pass produced');
  assert.strictEqual(
    entry.snapshotSha256, await sha256(book.absPath), 'the recorded digest is not the snapshot\'s');
  assert.ok(entry.receipt, 'the pass wrote a diff and the entry froze none');
  assert.ok(
    fs.existsSync(path.join(dir, entry.receipt.split('/').join(path.sep))),
    'the frozen diff is not on disk');
  // The frozen copy is what the carried provenance points at — the stage
  // directory it came from is cleared by the next derivation of the book.
  assert.strictEqual(entry.pass.diff, entry.receipt,
    'the carried pass record still points at the stage directory');
});

test('a pass that changes the book\'s STRUCTURE is refused, and says why', async () => {
  const dir = await makeProject('ledger-structural');
  const recorded = await runPass(dir, {
    kind: 'simplify',
    label: 'Simplify',
    // One paragraph more than the base has: every element after it moves, and
    // every record the user made against a position would name a different one.
    chapters: [[...CHAPTER_ONE, 'And a paragraph nobody wrote.'], CHAPTER_TWO],
  });

  assert.strictEqual(recorded.entry, null, 'a structural rewrite was given a ledger entry');
  assert.ok(/STRUCTURE/.test(recorded.refusal), `the refusal does not say why: ${recorded.refusal}`);
  assert.ok(/element/.test(recorded.refusal), `the refusal does not name the counts: ${recorded.refusal}`);
  assert.deepStrictEqual(ledgerOf(dir), [], 'an entry was recorded anyway');
  // The pass itself HAPPENED, and the honest state is that it is in the
  // provenance and not in the ledger: it cannot be taken back on its own.
  const passes = await manifestService.readAppliedPasses(dir);
  assert.strictEqual(passes.length, 1, 'the pass was dropped from the provenance too');
  assert.strictEqual(
    fs.existsSync(path.join(dir, 'source', 'ledger')), false,
    'the refused entry left a directory behind');
});

// ── The truth table ──────────────────────────────────────────────────────────

test('(a) erasing WORKING CHANGES keeps the pass: the copy is the snapshot', async () => {
  const dir = await makeProject('ledger-erase-working');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  populateRecords(dir);
  const snapshotDigest = await sha256(path.join(dir, entry.snapshot.split('/').join(path.sep)));
  const archiveDigest = await sha256(archiveOf(dir));

  const after = await erase(dir, 'working-changes');

  assert.strictEqual(await sha256(after.absPath), snapshotDigest,
    'the fresh copy is not the book the pass produced');
  assert.notStrictEqual(await sha256(after.absPath), archiveDigest,
    'the fresh copy went back past the pass — the pass was thrown away');
  assertRecordsCleared(dir, 'erase working-changes');
  assert.strictEqual(ledgerOf(dir).length, 1, 'the ledger entry went with the working changes');
  assert.ok(after.remint, 'a re-mint must produce a receipt');
  assert.deepStrictEqual(after.remint.kept, ['Simplify'],
    'the receipt does not say which pass was kept');
  // The provenance came back with the bytes it describes.
  const passes = await manifestService.readAppliedPasses(dir);
  assert.strictEqual(passes.length, 1, 'the carried provenance was dropped');
  assert.strictEqual(passes[0].kind, 'simplify');
});

test('(b) deleting the LEDGER ENTRY keeps the working changes: the copy is the base', async () => {
  const dir = await makeProject('ledger-delete-entry');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  populateRecords(dir);
  const archiveDigest = await sha256(archiveOf(dir));
  const entryDir = path.join(dir, entry.dir.split('/').join(path.sep));

  const deletion = await manifestService.deleteLedgerEntry(dir, entry.id);

  assert.deepStrictEqual(deletion.dropped.map((e) => e.id), [entry.id]);
  assert.deepStrictEqual(deletion.kept, [], 'nothing should stand — there was one entry');
  await sameBook(deletion.book.absPath, archiveOf(dir),
    'the copy does not hold the archive original\'s entries');
  assertRecordsPresent(dir, 'delete ledger entry');
  assert.deepStrictEqual(ledgerOf(dir), [], 'the entry survived its own deletion');
  assert.strictEqual(fs.existsSync(entryDir), false,
    'the entry\'s snapshot and frozen diff were left on disk');
  assert.strictEqual(await sha256(archiveOf(dir)), archiveDigest, 'the archive original was written to');
  const passes = await manifestService.readAppliedPasses(dir);
  assert.deepStrictEqual(passes, [], 'the deleted pass still claims to describe these bytes');
});

test('(c) erasing EVERYTHING is the archive original, with nothing recorded', async () => {
  const dir = await makeProject('ledger-erase-everything');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  populateRecords(dir);
  const archiveDigest = await sha256(archiveOf(dir));
  const entryDir = path.join(dir, entry.dir.split('/').join(path.sep));

  const after = await erase(dir, 'everything');

  await sameBook(after.absPath, archiveOf(dir),
    'the fresh copy does not hold the archive original\'s entries');
  assertRecordsCleared(dir, 'erase everything');
  assert.deepStrictEqual(ledgerOf(dir), [], 'the ledger survived "erase everything"');
  assert.strictEqual(fs.existsSync(entryDir), false, 'the snapshot was left on disk');
  assert.ok(after.remint, 'a re-mint must produce a receipt');
  assert.deepStrictEqual(after.remint.kept, [], 'the receipt claims a pass was kept');
});

test('(d) a deleted working copy comes back from the snapshot, and says what stood', async () => {
  const dir = await makeProject('ledger-remint');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  populateRecords(dir);
  const snapshotDigest = await sha256(path.join(dir, entry.snapshot.split('/').join(path.sep)));
  const book = await manifestService.readExportEpub(dir);

  // The user deletes the file in Explorer, meaning "start my edits over".
  await removeEpubContainer(book.absPath);
  const after = await manifestService.ensureBookEpub(dir);

  assert.strictEqual(await sha256(after.absPath), snapshotDigest,
    'the re-minted copy threw the pass away');
  assert.ok(after.remint, 'a re-mint must produce a receipt');
  assert.deepStrictEqual(after.remint.kept, ['Simplify'],
    'the receipt does not name what was kept');
  const { describeWorkingCopyRemint } = require(
    path.join(DIST, 'shared', 'document', 'working-copy-remint.js'));
  const said = describeWorkingCopyRemint(after.remint);
  assert.ok(/with Simplify applied/.test(said), `the sentence hides the kept pass: ${said}`);
  assert.ok(!/archive original, unedited/.test(said),
    `the sentence claims the original came back: ${said}`);
  assertRecordsCleared(dir, 're-mint');
});

test('(e) deleting the FIRST of two entries cascades, and names both', async () => {
  const dir = await makeProject('ledger-cascade');
  const first = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  const second = await runPass(dir, {
    kind: 'translate',
    label: 'Translate to fr',
    chapters: [undigit(CHAPTER_ONE).map((p) => `FR ${p}`), undigit(CHAPTER_TWO).map((p) => `FR ${p}`)],
  });
  assert.strictEqual(first.refusal, null, `first pass refused: ${first.refusal}`);
  assert.strictEqual(second.refusal, null, `second pass refused: ${second.refusal}`);
  populateRecords(dir);
  const archiveDigest = await sha256(archiveOf(dir));

  const deletion = await manifestService.deleteLedgerEntry(dir, first.entry.id);

  assert.deepStrictEqual(
    deletion.dropped.map((e) => e.label), ['Simplify', 'Translate to fr'],
    'the cascade did not take the later entry');
  assert.ok(/Translate to fr/.test(deletion.message),
    `the answer does not name the cascade: ${deletion.message}`);
  assert.deepStrictEqual(ledgerOf(dir), [], 'entries survived the cascade');
  await sameBook(deletion.book.absPath, archiveOf(dir),
    'the copy is not back at the archive original');
  for (const entry of [first.entry, second.entry]) {
    assert.strictEqual(
      fs.existsSync(path.join(dir, entry.dir.split('/').join(path.sep))), false,
      `${entry.label}'s snapshot was left on disk`);
  }
  assertRecordsPresent(dir, 'cascade');
});

test('deleting the LAST of two entries keeps the first, bytes and record', async () => {
  const dir = await makeProject('ledger-delete-last');
  const first = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  const second = await runPass(dir, {
    kind: 'translate',
    label: 'Translate to fr',
    chapters: [undigit(CHAPTER_ONE).map((p) => `FR ${p}`), undigit(CHAPTER_TWO).map((p) => `FR ${p}`)],
  });
  const firstSnapshot = await sha256(path.join(dir, first.entry.snapshot.split('/').join(path.sep)));

  const deletion = await manifestService.deleteLedgerEntry(dir, second.entry.id);

  assert.deepStrictEqual(deletion.dropped.map((e) => e.label), ['Translate to fr'],
    'deleting the last entry cascaded');
  assert.deepStrictEqual(deletion.kept.map((e) => e.label), ['Simplify']);
  assert.strictEqual(await sha256(deletion.book.absPath), firstSnapshot,
    'the copy is not the book the surviving pass left');
  assert.strictEqual(ledgerOf(dir).length, 1, 'the surviving entry was dropped too');
  assert.ok(
    fs.existsSync(path.join(dir, first.entry.dir.split('/').join(path.sep))),
    'the surviving entry\'s snapshot was removed');
  assert.ok(
    fs.existsSync(path.join(dir, first.entry.receipt.split('/').join(path.sep))),
    'the surviving entry\'s frozen diff was removed');
  const passes = await manifestService.readAppliedPasses(dir);
  assert.deepStrictEqual(passes.map((p) => p.kind), ['simplify'],
    'the provenance does not describe the bytes that are there');
});

test('a fold made since the pass refuses the deletion, rather than mis-placing strikes', async () => {
  const dir = await makeProject('ledger-fold-since');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  populateRecords(dir);
  // A chapter-opening fold REMOVES elements, and the strike record was migrated
  // to match it in the same transaction. Going back past it would undo the
  // removal in the bytes and leave every later strike one element out.
  const manifest = readManifest(dir);
  assert.strictEqual(
    (manifest.families ?? []).length, 1, `expected one working chain, found ${(manifest.families ?? []).length}`);
  manifest.families[0].epub.bookEdits = [{
    kind: 'merge-chapter-opening',
    at: new Date(Date.parse(entry.createdAt) + 1000).toISOString(),
    file: 'OEBPS/ch1.xhtml',
    openerKey: 'OEBPS/ch1.xhtml#0',
    openerTextBefore: 'It was some, and the machine hummed.',
    openerTextAfter: 'Chapter One',
    folded: [{ key: 'OEBPS/ch1.xhtml#1', textBefore: 'She counted some of them.' }],
    fromSha256: 'a', toSha256: 'b',
  }];
  writeManifest(dir, manifest);
  const bookDigest = await sha256((await manifestService.readExportEpub(dir)).absPath);

  await assert.rejects(
    () => manifestService.deleteLedgerEntry(dir, entry.id),
    (err) => /chapter opening\(s\) folded/.test(err.message)
      && /Erase this book's working changes first/.test(err.message),
    'the refusal must name the fold and the way out');
  assert.strictEqual(
    await sha256((await manifestService.readExportEpub(dir)).absPath), bookDigest,
    'the refused deletion rewrote the book anyway');
  assert.strictEqual(ledgerOf(dir).length, 1, 'the refused deletion dropped the entry anyway');
});

// ─────────────────────────────────────────────────────────────────────────────
// The real footnote-reference pass, end to end
// ─────────────────────────────────────────────────────────────────────────────
//
// Owen: "if the user opens the working file and footnote reference numbers were
// removed, will it show the change in the epub? will it show that the numbers
// are actually gone? i.e. does it actually edit the text?" These assert that it
// does — against the bytes of the book, not against a report about them.

/** Both forms publishers write a reference in, plus an ordinal that must SURVIVE. */
const FOOTED_ONE = [
  'The treaty was signed in Berlin.<sup class="calibre11">55</sup>',
  'Himmler disagreed.<sup><a href="#fn-9" id="fn_9">9</a></sup>',
];
const FOOTED_TWO = [
  'It would be invited to become the 28<sup>th</sup> state.',
  'Nobody had been through the door.<sup>3,4</sup>',
];

/**
 * Run the footnote pass exactly as `book:remove-footnote-references` runs it.
 *
 * The IPC handler is these two calls plus a window to destroy, a naming pass and
 * a broadcast — deliberately, so the rail button and a queued chain reach one
 * implementation. Driving the two here is driving the primitive; wrapping the
 * IPC would need an Electron main process and would test the wrapper.
 */
async function runFootnotePass(dir) {
  const stageRelDir = await manifestService.nextPassStageRelDir(dir, 'footnote-refs');
  return runProcessingPass(
    `footnote-refs-test-${Date.now()}`, { kind: 'footnote-refs', projectDir: dir, stageRelDir }, null);
}

/** Every content document of an EPUB, concatenated — what the reader will see. */
async function bookMarkup(epubPath) {
  let out = '';
  for (const entry of await bookEntryNames(epubPath)) {
    if (!/\.(xhtml|html|htm)$/i.test(entry)) continue;
    out += await bookEntryText(epubPath, entry);
  }
  return out;
}

test('the footnote pass takes the numbers OUT OF THE BOOK, and keeps the ordinal', async () => {
  const dir = await makeProjectWith('footnote-run', [FOOTED_ONE, FOOTED_TWO]);
  const book = await manifestService.readExportEpub(dir);
  const before = await bookMarkup(book.absPath);
  assert.ok(/<sup class="calibre11">55<\/sup>/.test(before), 'the fixture has no bare marker');
  assert.ok(/<sup><a href="#fn-9"/.test(before), 'the fixture has no anchor-wrapped marker');

  const result = await runFootnotePass(dir);

  assert.strictEqual(result.success, true, `the pass failed: ${result.error}`);
  const after = await bookMarkup((await manifestService.readExportEpub(dir)).absPath);
  assert.ok(!/<sup class="calibre11">55<\/sup>/.test(after), 'the bare marker is still in the book');
  assert.ok(!/<sup><a href="#fn-9"/.test(after), 'the anchor-wrapped marker is still in the book');
  assert.ok(!/<sup>3,4<\/sup>/.test(after), 'the range marker is still in the book');
  // The SAME rule the narration copy is cut by, which keeps ordinals — proof
  // this is that rule and not a blunt "remove every sup".
  assert.ok(/28<sup>th<\/sup> state/.test(after), 'the ordinal suffix was removed too');
  // The prose either side of a removed marker is untouched, byte for byte.
  assert.ok(/The treaty was signed in Berlin\.<\/p>/.test(after),
    'the markup around the marker was rewritten');
  assert.strictEqual(result.summary, '3 footnote reference number(s) removed from 2 document(s).');
});

test('the pass is TEXT-ONLY, so the structural guard passes and it gets a ledger row', async () => {
  const dir = await makeProjectWith('footnote-ledger', [FOOTED_ONE, FOOTED_TWO]);

  const result = await runFootnotePass(dir);

  // Asserted rather than assumed: a `<sup>` is inline, so removing one takes
  // characters out of a block and leaves every block where it was. If that ever
  // stopped being true, `registerLedgerPass` would refuse the entry and this is
  // where it would be seen.
  assert.strictEqual(result.ledgerRefusal, undefined,
    `the structural guard refused the entry: ${result.ledgerRefusal}`);
  assert.ok(result.ledgerEntryId, 'the pass recorded no ledger entry');

  const entries = ledgerOf(dir);
  assert.strictEqual(entries.length, 1, 'the ledger did not get exactly one entry');
  const entry = entries[0];
  assert.strictEqual(entry.id, result.ledgerEntryId);
  assert.strictEqual(entry.kind, 'footnote-refs');
  assert.strictEqual(entry.label, 'Remove footnote references');
  assert.ok(
    fs.existsSync(path.join(dir, entry.snapshot.split('/').join(path.sep))),
    'the entry has no snapshot on disk');
  assert.ok(entry.receipt, 'the entry froze no diff');
  assert.ok(
    fs.existsSync(path.join(dir, entry.receipt.split('/').join(path.sep))),
    'the frozen diff is not on disk');
  // The snapshot IS the book the pass produced.
  assert.strictEqual(
    await sha256(path.join(dir, entry.snapshot.split('/').join(path.sep))),
    await sha256((await manifestService.readExportEpub(dir)).absPath),
    'the snapshot is not the book the pass wrote');
  // And the provenance says it happened.
  const passes = await manifestService.readAppliedPasses(dir);
  assert.deepStrictEqual(passes.map((p) => p.kind), ['footnote-refs']);
});

test('a second run is REFUSED by name, and records nothing', async () => {
  const dir = await makeProjectWith('footnote-twice', [FOOTED_ONE, FOOTED_TWO]);
  const first = await runFootnotePass(dir);
  assert.strictEqual(first.success, true, `the first run failed: ${first.error}`);
  const bookAfterFirst = await sha256((await manifestService.readExportEpub(dir)).absPath);

  const second = await runFootnotePass(dir);

  assert.strictEqual(second.success, false, 'a second run recorded a vacuous entry');
  assert.ok(/No footnote reference markers remain/.test(second.error),
    `the refusal does not say why: ${second.error}`);
  assert.strictEqual(ledgerOf(dir).length, 1, 'the second run added a ledger entry');
  assert.strictEqual((await manifestService.readAppliedPasses(dir)).length, 1,
    'the second run added a provenance record');
  // Nothing was written — not even the book's own bytes back over itself, which
  // would move its timestamp and invalidate every cache keyed on it.
  assert.strictEqual(
    await sha256((await manifestService.readExportEpub(dir)).absPath), bookAfterFirst,
    'the refused run rewrote the book');
});

test('a book with no markers at all gets the same refusal, first time', async () => {
  const dir = await makeProject('footnote-none');
  const result = await runFootnotePass(dir);

  assert.strictEqual(result.success, false, 'a book with nothing to strip recorded an entry');
  assert.ok(/No footnote reference markers remain/.test(result.error),
    `the refusal does not say why: ${result.error}`);
  assert.deepStrictEqual(ledgerOf(dir), []);
  assert.deepStrictEqual(await manifestService.readAppliedPasses(dir), []);
});

test('deleting the entry puts the numbers BACK, byte-identically', async () => {
  const dir = await makeProjectWith('footnote-undo', [FOOTED_ONE, FOOTED_TWO]);
  const archiveDigest = await sha256(archiveOf(dir));
  const result = await runFootnotePass(dir);
  assert.strictEqual(result.success, true, `the pass failed: ${result.error}`);
  // The user's evening, made against the stripped book and keyed to positions
  // the strip did not move.
  populateRecords(dir);

  const deletion = await manifestService.deleteLedgerEntry(dir, result.ledgerEntryId);

  await sameBook(deletion.book.absPath, archiveOf(dir),
    'the book did not come back holding the archive original\'s entries');
  const restored = await bookMarkup(deletion.book.absPath);
  assert.ok(/<sup class="calibre11">55<\/sup>/.test(restored), 'the bare marker did not come back');
  assert.ok(/<sup><a href="#fn-9"/.test(restored), 'the anchor-wrapped marker did not come back');
  // The whole point of the ledger: the pass came out and the user's work stayed.
  assertRecordsPresent(dir, 'footnote undo');
  assert.deepStrictEqual(ledgerOf(dir), []);
  assert.deepStrictEqual(await manifestService.readAppliedPasses(dir), []);
});

test('a paragraph that was ONLY a marker says [break] now, and the entry still registers', async () => {
  // The edge Owen ruled on: "we could put [break] in instead of leaving it
  // blank". A marker-only <p> comes out of the strip textless, falls out of
  // the export walk, and would shift every position key after it — the
  // structural guard would then refuse the pass its ledger row. The repair
  // keeps the element enumerated with the one token the pipeline reads as a
  // pause. A paragraph that was ALREADY empty in the base is the same edge
  // mirrored — giving IT text would ADD an enumerated element — so it must
  // come through untouched.
  const dir = await makeProjectWith('footnote-break', [
    ['Before the note.', '<sup>77</sup>', 'After the note.'],
    ['A chapter with an already empty paragraph.', '', 'And its last line.'],
  ]);
  const archiveDigest = await sha256(archiveOf(dir));

  const result = await runFootnotePass(dir);
  assert.strictEqual(result.success, true, `the pass failed: ${result.error}`);
  assert.strictEqual(result.ledgerRefusal, undefined,
    'the structural guard refused the entry — the [break] repair did not hold the enumeration');
  assert.ok(result.ledgerEntryId, 'the pass registered no ledger entry');
  assert.ok(/now say \[break\]/.test(result.summary),
    `the summary does not account for the repaired paragraph: ${result.summary}`);

  const after = await bookMarkup((await manifestService.readExportEpub(dir)).absPath);
  assert.ok(!/<sup>77<\/sup>/.test(after), 'the marker is still in the book');
  assert.ok(/<p[^>]*>\[break\]<\/p>/.test(after), 'the emptied paragraph does not say [break]');
  assert.strictEqual((after.match(/\[break\]/g) || []).length, 1,
    'exactly one paragraph was emptied, so exactly one [break] may exist');

  // And the way back is intact: delete the entry, the marker returns, the
  // [break] goes, byte-identical to the archive.
  const deletion = await manifestService.deleteLedgerEntry(dir, result.ledgerEntryId);
  await sameBook(deletion.book.absPath, archiveOf(dir),
    'the book did not come back holding the archive original\'s entries after the [break] repair');
});

// ── A record whose file is gone is REPORTED, never quietly rebuilt ───────────

test('a ledger snapshot that is missing refuses by name', async () => {
  const dir = await makeProject('ledger-snapshot-missing');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  await removeEpubContainer(path.join(dir, entry.snapshot.split('/').join(path.sep)));
  const book = await manifestService.readExportEpub(dir);
  await removeEpubContainer(book.absPath);

  await assert.rejects(
    () => manifestService.ensureBookEpub(dir),
    (err) => /snapshot at source\/ledger/.test(err.message) && /not there/.test(err.message),
    'a missing snapshot must be reported, naming it');
  assert.strictEqual(ledgerOf(dir).length, 1,
    'the entry was dropped instead of being reported');
});

test('a ledger snapshot whose bytes have changed refuses by digest', async () => {
  const dir = await makeProject('ledger-snapshot-changed');
  const { entry } = await runPass(dir, {
    kind: 'simplify', label: 'Simplify', chapters: [undigit(CHAPTER_ONE), undigit(CHAPTER_TWO)],
  });
  const snapshot = path.join(dir, entry.snapshot.split('/').join(path.sep));
  await replaceBookEntry(snapshot, 'OEBPS/ch1.xhtml', '<html>somebody edited the snapshot</html>');
  const book = await manifestService.readExportEpub(dir);
  await removeEpubContainer(book.absPath);

  await assert.rejects(
    () => manifestService.ensureBookEpub(dir),
    (err) => /is not the book it was recorded as/.test(err.message),
    'a snapshot that has changed since it was taken must be refused');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
