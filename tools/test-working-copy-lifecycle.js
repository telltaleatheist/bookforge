#!/usr/bin/env node
/**
 * Tests for the working copy's whole life: minted, erased, and re-minted — for
 * BOTH kinds of project.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-working-copy-lifecycle.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Owen, 2026-08-09: "whats the goal of creating a working copy in the first
 * place? … to make changes reversible and to protect an archived file … the
 * thing they 'delete' is actually the changes, not the working copy. by deleting
 * the 'working copy' on the versions page, it clears changes. all changes. byte
 * identical … same goes for an epub generated from a pdf. it should be treated
 * as an archive file."
 *
 * Three claims follow, and each is asserted here against real files rather than
 * argued:
 *
 *  1. Erasing changes CLEARS every record and puts back bytes that are
 *     sha256-identical to the archive-grade book behind them.
 *  2. A PDF-origin project's cast book SURVIVES that — it is a file of its own
 *     now (`<archive basename>.generated.epub`), so erasing changes costs a file
 *     copy instead of an hour of GPU.
 *  3. The migration that gives that file to the projects which predate it is
 *     idempotent, and it never invents one.
 *
 * ── Why the fixtures are real projects on disk ──────────────────────────────
 *
 * The claims are about bytes and about a manifest, and both of those are things
 * this code touches through the filesystem. A stubbed fs would test the stubs.
 * Every fixture is built here, under the OS temp directory, and removed at the
 * end; NOTHING in the user's library is read or written (the library base path
 * is pointed at the fixture root for the duration).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(MODULE);

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

const writeManifest = (dir, manifest) =>
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

/**
 * The book record, where it lives now: under the family that owns it.
 *
 * `manifest.outputs.epub` was the one book a project could have. A project may
 * now have several chains, so the record moved inside the family whose source it
 * hangs off — and a fixture that reads it (or mutates it, after the code under
 * test has had a chance to mint the family) reads it there instead. Every
 * fixture in this file mints exactly one chain, so there is exactly one family
 * to mean.
 */
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

/**
 * An EPUB, as far as everything under test is concerned: a file of bytes with a
 * sha256. Nothing here parses one — the working copy is proved by digest, and a
 * digest does not care whether the zip is valid.
 */
function writeBook(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** Everything a user's evening of work leaves in a manifest, all at once. */
function populateRecords(dir) {
  const manifest = readManifest(dir);
  manifest.editor = {
    undoStack: [{ kind: 'split', at: '2026-08-09T00:00:00.000Z' }],
    customCategories: ['epigraph'],
    blockEdits: { 'b-1': 'corrected text' },
  };
  manifest.source = {
    ...manifest.source,
    deletedBlockIds: ['b-1', 'b-2', 'b-3'],
    deletedPages: [4, 5],
    pageOrder: [1, 2, 3],
    editorLayout: { engine: 'quire', version: 17 },
  };
  manifest.chapters = [{ id: 'c1', title: 'One', page: 1, level: 1 }];
  manifest.chaptersSource = 'editor';
  // Some callers populate before the project has a chain (still `outputs.epub`,
  // which `ensureBookFamilies` will move on its way past); others populate after
  // a caller upstream already minted one, in which case the book record it wrote
  // to has already moved. Either way, this writes the strikes and book edits onto
  // wherever the book currently lives.
  const book = (manifest.families ?? [])[0]?.epub ?? manifest.outputs.epub;
  book.narrationDeletions = {
    elements: ['OEBPS/ch1.xhtml#3', 'OEBPS/ch1.xhtml#4'],
    bookSha256: 'whatever',
  };
  book.bookEdits = [
    { kind: 'name-chapter-openers', at: '2026-08-09T00:00:00.000Z', named: [] },
  ];
  writeManifest(dir, manifest);
}

/** Every record `populateRecords` wrote is gone. */
function assertRecordsCleared(dir, label, sourceType) {
  const manifest = readManifest(dir);
  assert.strictEqual(manifest.editor, undefined, `${label}: manifest.editor survived`);
  assert.strictEqual(manifest.chapters, undefined, `${label}: chapters survived`);
  assert.strictEqual(manifest.chaptersSource, undefined, `${label}: chaptersSource survived`);
  for (const key of ['deletedBlockIds', 'deletedPages', 'pageOrder', 'editorLayout']) {
    assert.strictEqual(
      manifest.source[key], undefined, `${label}: manifest.source.${key} survived`);
  }
  const book = bookRecordOf(dir);
  assert.strictEqual(book.narrationDeletions, undefined, `${label}: strikes survived`);
  assert.strictEqual(book.bookEdits, undefined, `${label}: book edits survived`);
  // The source's IDENTITY is not a record of anything the user did, and must
  // never go with them — a project that forgot what file it came from could not
  // be reconciled with the library again.
  assert.strictEqual(
    manifest.source.type, sourceType, `${label}: source identity was cleared too`);
}

/**
 * The erase act, as its two underlying calls.
 *
 * `book:erase-changes` is exactly this plus a window to destroy and a broadcast
 * — deliberately, so that a user deleting the file in Explorer and a user
 * pressing the button run one code path. Driving the two calls here is driving
 * the primitive; wrapping the IPC would need an Electron main process and would
 * test the wrapper.
 */
async function erase(dir) {
  const before = await manifestService.readExportEpub(dir);
  assert.ok(before, 'erase: the project records no book, so there is nothing to erase');
  fs.rmSync(before.absPath, { force: true });
  return manifestService.ensureBookEpub(dir);
}

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixture root ─────────────────────────────────────────────────────────────
//
// `<root>/projects/<projectId>` is the layout manifest-service resolves a
// projectId through, and `setLibraryBasePath` is the one knob that says where
// the root is. Pointed at a temp directory for the whole run.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-working-copy-'));
manifestService.setLibraryBasePath(ROOT);
const projectsDir = path.join(ROOT, 'projects');

const ARCHIVE_BYTES = Buffer.from('PK the book exactly as it was handed over');
const CAST_BYTES = Buffer.from('PK the book the page reader made of the pages');

/** A project imported AS an EPUB: archive original, no generated book, no copy. */
function makeEpubProject(id) {
  const dir = path.join(projectsDir, id);
  writeBook(path.join(dir, 'archive', 'Killing America.epub'), ARCHIVE_BYTES);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Killing America' },
    source: { type: 'epub', originalFilename: 'Killing America.epub' },
    archive: [{ path: 'archive/Killing America.epub', role: 'original', format: 'epub' }],
    outputs: {},
  });
  return dir;
}

/**
 * A PDF project as it existed BEFORE generated books were kept: the cast landed
 * straight on `outputs.epub`, so the file the user edits IS the hour of GPU.
 */
function makePdfProjectPreMigration(id) {
  const dir = path.join(projectsDir, id);
  writeBook(path.join(dir, 'archive', 'Deathstalker.pdf'), Buffer.from('%PDF-1.7 pages'));
  writeBook(path.join(dir, 'source', 'Deathstalker.working.epub'), CAST_BYTES);
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Deathstalker' },
    source: { type: 'pdf', originalFilename: 'Deathstalker.pdf' },
    archive: [{ path: 'archive/Deathstalker.pdf', role: 'original', format: 'pdf' }],
    outputs: {
      epub: {
        path: 'source/Deathstalker.working.epub',
        modifiedAt: '2026-08-01T00:00:00.000Z',
        appliedPasses: [{ kind: 'vlm-convert', at: '2026-08-01T00:00:00.000Z', params: {} }],
      },
    },
  });
  return dir;
}

// ── EPUB-native ──────────────────────────────────────────────────────────────

test('an EPUB project mints its working copy as the archive\'s exact bytes', async () => {
  const dir = makeEpubProject('epub-mint');
  const book = await manifestService.ensureBookEpub(dir);

  assert.strictEqual(book.relPath, 'source/Killing America.working.epub');
  assert.strictEqual(book.remint, null, 'a FIRST copy is not a re-mint and must not be announced');
  assert.strictEqual(
    sha256(book.absPath), sha256(path.join(dir, 'archive', 'Killing America.epub')),
    'the working copy is not byte-identical to the archive original');
});

test('erasing changes clears every record and restores the archive\'s bytes', async () => {
  const dir = makeEpubProject('epub-erase');
  const minted = await manifestService.ensureBookEpub(dir);
  populateRecords(dir);
  // The user's evening: the file itself is edited too, so "byte-identical" is a
  // claim about the copy that comes BACK rather than one nothing disturbed.
  fs.appendFileSync(minted.absPath, ' — and a chapter opening the user folded');
  const archive = path.join(dir, 'archive', 'Killing America.epub');
  const archiveDigest = sha256(archive);

  const after = await erase(dir);

  assert.ok(after.remint, 'erasing changes must produce a receipt');
  assert.strictEqual(after.remint.relPath, 'source/Killing America.working.epub');
  assert.strictEqual(after.remint.deletedBlockIds, 3);
  assert.strictEqual(after.remint.deletedPages, 2);
  assert.strictEqual(after.remint.narrationStrikes, 2);
  assertRecordsCleared(dir, 'epub-erase', 'epub');
  assert.strictEqual(
    sha256(after.absPath), archiveDigest,
    'the fresh copy is not byte-identical to the archive original');
  assert.strictEqual(sha256(archive), archiveDigest, 'the archive original was written to');
});

test('a project with no archive original refuses by name', async () => {
  const dir = makeEpubProject('epub-no-original');
  fs.rmSync(path.join(dir, 'archive', 'Killing America.epub'), { force: true });
  await assert.rejects(
    () => manifestService.requireWorkingCopySource(dir),
    (err) => /archive original is an EPUB, and that file is not in the project/.test(err.message),
    'the refusal must name what is missing');
});

// ── PDF-origin ───────────────────────────────────────────────────────────────

test('a PDF project made before generated books adopts its working copy as one', async () => {
  const dir = makePdfProjectPreMigration('pdf-adopt');
  const castDigest = sha256(path.join(dir, 'source', 'Deathstalker.working.epub'));

  const adoption = await manifestService.ensureGeneratedEpub(dir);

  assert.ok(adoption.adopted, 'the migration did not adopt anything');
  assert.strictEqual(adoption.missing, null);
  assert.strictEqual(adoption.adopted.relPath, 'source/Deathstalker.generated.epub');
  assert.strictEqual(adoption.adopted.origin, 'adopted', 'these bytes are not a fresh cast');
  assert.strictEqual(
    sha256(adoption.adopted.absPath), castDigest,
    'the generated book is not byte-identical to the working copy it was adopted from');
  // Adopting must not disturb the file the user is editing.
  assert.strictEqual(
    sha256(path.join(dir, 'source', 'Deathstalker.working.epub')), castDigest,
    'the working copy was changed by the migration');
});

test('the migration is idempotent — a second run changes nothing', async () => {
  const dir = makePdfProjectPreMigration('pdf-idempotent');
  const first = await manifestService.ensureGeneratedEpub(dir);
  assert.ok(first.adopted, 'the first run did not adopt anything');
  const recordAfterFirst = JSON.stringify(readManifest(dir).outputs.generatedEpub);
  const filesAfterFirst = fs.readdirSync(path.join(dir, 'source')).sort().join('|');
  const digestAfterFirst = sha256(first.adopted.absPath);

  const second = await manifestService.ensureGeneratedEpub(dir);

  assert.strictEqual(second.adopted, null, 'the second run adopted a second time');
  assert.strictEqual(second.missing, null);
  assert.strictEqual(
    JSON.stringify(readManifest(dir).outputs.generatedEpub), recordAfterFirst,
    'the second run rewrote the record');
  assert.strictEqual(
    fs.readdirSync(path.join(dir, 'source')).sort().join('|'), filesAfterFirst,
    'the second run left a file behind');
  assert.strictEqual(
    sha256(first.adopted.absPath), digestAfterFirst, 'the second run rewrote the generated book');
});

test('erasing a PDF book\'s changes keeps the cast — that is the whole payoff', async () => {
  const dir = makePdfProjectPreMigration('pdf-erase');
  await manifestService.ensureGeneratedEpub(dir);
  populateRecords(dir);
  const working = path.join(dir, 'source', 'Deathstalker.working.epub');
  fs.appendFileSync(working, ' — and everything the user did to it');
  const generated = path.join(dir, 'source', 'Deathstalker.generated.epub');
  const castDigest = sha256(generated);
  const castMtime = fs.statSync(generated).mtimeMs;
  assert.notStrictEqual(sha256(working), castDigest, 'the fixture did not actually edit the book');

  const after = await erase(dir);

  assert.ok(after.remint, 'erasing changes must produce a receipt');
  assert.strictEqual(after.remint.deletedBlockIds, 3);
  assert.strictEqual(after.remint.deletedPages, 2);
  assert.strictEqual(after.remint.narrationStrikes, 2);
  assertRecordsCleared(dir, 'pdf-erase', 'pdf');
  assert.strictEqual(
    sha256(after.absPath), castDigest,
    'the fresh copy is not byte-identical to the book cast from the pages');
  assert.ok(fs.existsSync(generated), 'the cast book was deleted — an hour of GPU with it');
  assert.strictEqual(sha256(generated), castDigest, 'the cast book was written to');
  assert.strictEqual(
    fs.statSync(generated).mtimeMs, castMtime, 'the cast book was rewritten with its own bytes');
});

test('a PDF whose pages have never been read refuses, naming Convert to EPUB', async () => {
  const dir = path.join(projectsDir, 'pdf-unread');
  writeBook(path.join(dir, 'archive', 'Unread.pdf'), Buffer.from('%PDF-1.7'));
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: 'pdf-unread',
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Unread' },
    source: { type: 'pdf', originalFilename: 'Unread.pdf' },
    archive: [{ path: 'archive/Unread.pdf', role: 'original', format: 'pdf' }],
    outputs: {},
  });

  // Nothing to adopt, and that is an ordinary answer rather than a refusal.
  const adoption = await manifestService.ensureGeneratedEpub(dir);
  assert.strictEqual(adoption.adopted, null);
  assert.strictEqual(adoption.missing, null);

  assert.strictEqual(
    await manifestService.workingCopySource(dir), null,
    'a PDF nobody has converted must not offer a source to copy');
  await assert.rejects(
    () => manifestService.requireWorkingCopySource(dir),
    (err) => /pages have not been read into a book yet/.test(err.message)
      && /Convert to EPUB/.test(err.message),
    'the refusal must name the act that fixes it');
});

test('a recorded generated book that is gone is reported, never re-adopted', async () => {
  const dir = makePdfProjectPreMigration('pdf-cast-missing');
  const adoption = await manifestService.ensureGeneratedEpub(dir);
  fs.rmSync(adoption.adopted.absPath, { force: true });
  // The working copy has moved on since the cast — which is exactly why it must
  // not quietly become the thing erasing changes goes back to.
  fs.appendFileSync(path.join(dir, 'source', 'Deathstalker.working.epub'), ' edited since');

  const again = await manifestService.ensureGeneratedEpub(dir);

  assert.strictEqual(again.adopted, null, 'the working copy was adopted as the cast');
  assert.ok(again.missing, 'a missing cast must be reported');
  assert.ok(/is not there/.test(again.missing), `unexpected sentence: ${again.missing}`);
  assert.ok(
    !fs.existsSync(path.join(dir, 'source', 'Deathstalker.generated.epub')),
    'a replacement generated book was invented');
  await assert.rejects(
    () => manifestService.requireWorkingCopySource(dir),
    (err) => /generated book is recorded as/.test(err.message),
    'erasing changes must refuse while the cast is missing');
});

// ── The two archive-grade books are never mint targets ───────────────────────

test('a mint that would land on an archive-grade book is refused, and it survives', async () => {
  // The damaged manifest this guard exists for: the generated book's record
  // pointing at the working copy's own path. Nothing writes that today — it is
  // the shape a hand-edited or half-synced manifest takes — and it is exactly
  // the shape in which a mint would overwrite the file it is a copy of.
  const dir = makePdfProjectPreMigration('pdf-target-guard');
  await manifestService.ensureGeneratedEpub(dir);
  const manifest = readManifest(dir);
  manifest.outputs.generatedEpub.path = 'source/Deathstalker.working.epub';
  writeManifest(dir, manifest);
  const victim = path.join(dir, 'source', 'Deathstalker.working.epub');
  const victimDigest = sha256(victim);

  await assert.rejects(
    () => manifestService.mintWorkingCopyFrom(
      dir, { absPath: victim, kind: 'generated-epub' }),
    (err) => /would be written over/.test(err.message),
    'minting onto an archive-grade book must be refused');
  assert.strictEqual(
    sha256(victim), victimDigest, 'the refused mint wrote to the file anyway');
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
