#!/usr/bin/env node
/**
 * Tests for the WORKING CHAINS: one per archive-grade EPUB, side by side in one
 * project.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-family-lifecycle.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Owen, 2026-08-10: "we'll change the architecture to make working chains
 * per-archive-file. PDFs have no working chain. only epubs. PDFs only exist to
 * convert to epub. but i do have different versions of books, and i want to be
 * able to run adjustment chains on different versions… no ambiguity, no
 * confusion." And: "having the epub listed under documents instead of versions
 * breaks the chain of custody."
 *
 * Five claims follow, and each is asserted here against real files:
 *
 *  1. A project made before chains gets exactly ONE, minted from the source it
 *     was already answering with, with its records MOVED under it and not a
 *     single byte of the book touched. Running it again changes nothing.
 *  2. A second chain added beside it gets its own working copy, its own ledger,
 *     its own strikes and its own narration copy, under its own names.
 *  3. With ONE chain, every reader answers without being told which — that is
 *     the theorem the whole compatibility story rests on.
 *  4. With SEVERAL, the same readers REFUSE, naming both. A surface that has not
 *     learned identity fails loudly the moment ambiguity is real.
 *  5. Erasing one chain's changes, and deleting one chain's ledger entry, touch
 *     that chain only.
 *
 * Plus the naming refusal: two sources with one stem would write one working
 * copy, and the second is refused BY NAME rather than destroying the first.
 *
 * ── Why the fixtures are real projects on disk ──────────────────────────────
 *
 * Same reason as tools/test-working-copy-lifecycle.js: the claims are about
 * bytes and about a manifest, and both are things this code touches through the
 * filesystem. Every fixture is built here, under the OS temp directory, and
 * removed at the end; NOTHING in the user's library is read or written (the
 * library base path is pointed at the fixture root for the duration).
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
// The pure naming rules, from the same build. `nextReadingName` is what keeps
// the stem-collision refusal below from being the ONLY answer a second reading
// of one PDF can get.
const { familyStem, nextReadingName } = require(
  path.join(REPO, 'dist', 'shared', 'document', 'book-families.js'));
const { ZipWriter } = require(path.join(REPO, 'dist', 'electron', 'epub-processor.js'));
// A book's identity and its entries, read the way the app reads them: a working
// copy is a FOLDER of the book's parts, so nothing here may readFileSync one.
const { bookDigestOf, bookEntryBytes, bookEntryNames } = require('./fixture-book');

// THE BOOK'S identity as the app records it — bare hex for an archive, tagged
// for an exploded one (shared/book-digest.ts). Every comparison below that used
// to be `sha256(a) === sha256(b)` still is, EXCEPT the ones that now span two
// containers; those use `sameBook` and say why.
const sha256 = (book) => bookDigestOf(book);

/** The plain file digest, for the fixture's own bookkeeping over archives. */
const fileSha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Two books hold the same entries with the same bytes.
 *
 * The comparison a mint's proof became. An archive and the folder of parts
 * minted from it are the same book and can never have the same digest — one is
 * hashed over compressed bytes, the other over its contents — so "the copy is
 * its source" is asserted the way `deriveWorkingCopy` proves it.
 */
async function sameBook(a, b) {
  const [an, bn] = await Promise.all([bookEntryNames(a), bookEntryNames(b)]);
  assert.deepStrictEqual([...an].sort(), [...bn].sort(), `${a} and ${b} hold different entries`);
  for (const name of an) {
    const [ab, bb] = await Promise.all([bookEntryBytes(a, name), bookEntryBytes(b, name)]);
    assert.ok(ab.equals(bb), `${name} differs between ${a} and ${b}`);
  }
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

const writeManifest = (dir, manifest) =>
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const familiesOf = (dir) => readManifest(dir).families ?? [];

/** The chain hanging off a named source file, by that file's basename. */
const chainOff = (dir, basename) => {
  const found = familiesOf(dir).find(
    (family) => path.basename(family.source.path) === basename);
  assert.ok(found, `no working chain hangs off ${basename}`);
  return found;
};

/** A file that is not a book: a PDF, an m4b. Bytes, and nothing reads them. */
function writeRaw(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/**
 * A REAL EPUB, minimal, whose one chapter says `marker`.
 *
 * It used to be enough to write a few bytes and call it a book: minting a
 * working copy was a byte copy, and a byte copy does not care whether the zip is
 * valid. It is not a copy any more — the working copy is a FOLDER of the book's
 * parts, so a mint reads its source entry by entry and proves the result the
 * same way. A book nothing can open is no longer a book, here or in the app.
 *
 * The marker is what makes two editions two different books.
 */
async function writeBook(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = String(marker);
  const id = crypto.createHash('sha256').update(text).digest('hex');
  const opf = '<?xml version="1.0" encoding="utf-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="i">urn:uuid:${id}</dc:identifier>`
    + '<dc:title>A Book</dc:title><dc:language>en</dc:language></metadata>'
    + '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    + '</manifest><spine><itemref idref="c1"/></spine></package>';
  const container = '<?xml version="1.0" encoding="utf-8"?>'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
    + 'media-type="application/oebps-package+xml"/></rootfiles></container>';
  const nav = '<?xml version="1.0" encoding="utf-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    + '<head><title>nav</title></head><body><nav epub:type="toc"><ol>'
    + '<li><a href="ch1.xhtml">One</a></li></ol></nav></body></html>';
  const chapter = '<?xml version="1.0" encoding="utf-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>'
    + `<p>${text}</p></body></html>`;
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zip.addFile('OEBPS/ch1.xhtml', Buffer.from(chapter, 'utf8'));
  await zip.write(file);
  return file;
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-families-'));
manifestService.setLibraryBasePath(ROOT);
const projectsDir = path.join(ROOT, 'projects');

const FIRST_BYTES = 'the first edition, exactly as it was handed over';
const SECOND_BYTES = 'a different edition of the same book, also handed over';
const CAST_BYTES = 'the book the page reader made of the pages';

/**
 * A LEGACY project: imported as an EPUB, with its book and its narration copy
 * at the records projects used before chains existed, and an evening of work
 * recorded against the book.
 */
async function makeLegacyProject(id) {
  const dir = path.join(projectsDir, id);
  await writeBook(path.join(dir, 'archive', 'Killing America.epub'), FIRST_BYTES);
  const legacyBook = await writeBook(
    path.join(dir, 'source', 'Killing America.working.epub'), FIRST_BYTES);
  await writeBook(path.join(dir, 'source', 'Killing America.tts.epub'), FIRST_BYTES);
  // The legacy book's own digest, measured off the file the fixture just wrote:
  // it is an ARCHIVE and it stays one (nothing re-mints it), so the bare hex the
  // records already hold is exactly what a reader measures.
  const legacyDigest = fileSha256(legacyBook);
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Killing America' },
    source: { type: 'epub', originalFilename: 'Killing America.epub' },
    archive: [{ path: 'archive/Killing America.epub', role: 'original', format: 'epub' }],
    outputs: {
      epub: {
        path: 'source/Killing America.working.epub',
        modifiedAt: '2026-08-02T00:00:00.000Z',
        appliedPasses: [{ kind: 'footnotes', at: '2026-08-02T00:00:00.000Z', params: {} }],
        narrationDeletions: {
          epubSha256: legacyDigest,
          elements: ['OEBPS/ch1.xhtml#3', 'OEBPS/ch1.xhtml#4'],
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
        bookEdits: [
          { kind: 'name-chapter-openers', at: '2026-08-02T00:00:00.000Z', named: [] },
        ],
      },
      ttsEpub: {
        path: 'source/Killing America.tts.epub',
        modifiedAt: '2026-08-02T00:00:00.000Z',
        removedElements: 2,
        epubSha256: legacyDigest,
      },
    },
  });
  return dir;
}

/** A PDF project whose pages were read: its chain hangs off the CAST book. */
async function makePdfProject(id) {
  const dir = path.join(projectsDir, id);
  writeRaw(path.join(dir, 'archive', 'Deathstalker.pdf'), Buffer.from('%PDF-1.7 pages'));
  const cast = await writeBook(path.join(dir, 'source', 'Deathstalker.generated.epub'), CAST_BYTES);
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Deathstalker' },
    source: { type: 'pdf', originalFilename: 'Deathstalker.pdf' },
    archive: [{ path: 'archive/Deathstalker.pdf', role: 'original', format: 'pdf' }],
    outputs: {
      generatedEpub: {
        path: 'source/Deathstalker.generated.epub',
        modifiedAt: '2026-08-01T00:00:00.000Z',
        sha256: fileSha256(cast),
        origin: 'cast',
      },
    },
  });
  return dir;
}

/** Put a second archive-grade EPUB in the project, and give it a chain. */
async function addSecondEdition(dir, filename, bytes) {
  const absPath = path.join(dir, 'archive', filename);
  await writeBook(absPath, bytes);
  return manifestService.addBookFamily(dir, { absPath, kind: 'archive-epub' });
}

// ── 1. The migration ─────────────────────────────────────────────────────────

test('a legacy project is given ONE chain, off the book it already answered with', async () => {
  const dir = await makeLegacyProject('legacy-mint');
  const bookBefore = await sha256(path.join(dir, 'source', 'Killing America.working.epub'));

  const adoption = await manifestService.ensureBookFamilies(dir);

  assert.ok(adoption.minted, 'the migration minted no chain');
  assert.strictEqual(adoption.refusal, null);
  const families = familiesOf(dir);
  assert.strictEqual(families.length, 1, 'a legacy project has exactly one chain');
  const [chain] = families;
  assert.match(chain.id, /^fam-[0-9a-f]{8}$/, `the id is not opaque and stable: ${chain.id}`);
  assert.strictEqual(chain.source.path, 'archive/Killing America.epub');
  assert.strictEqual(chain.source.kind, 'archive-epub');
  assert.strictEqual(
    chain.source.sha256, await sha256(path.join(dir, 'archive', 'Killing America.epub')),
    'the chain is stamped with bytes that are not its source\'s');

  // MOVED, not copied: two copies of one record is how a book comes to be
  // edited through one of them and read through the other.
  const manifest = readManifest(dir);
  assert.strictEqual(manifest.outputs.epub, undefined, 'the legacy book record survived');
  assert.strictEqual(manifest.outputs.ttsEpub, undefined, 'the legacy tts record survived');
  assert.strictEqual(chain.epub.path, 'source/Killing America.working.epub');
  assert.strictEqual(chain.epub.appliedPasses.length, 1, 'the provenance did not come across');
  assert.strictEqual(
    chain.epub.narrationDeletions.elements.length, 2, 'the strikes did not come across');
  assert.strictEqual(chain.epub.bookEdits.length, 1, 'the book edits did not come across');
  assert.strictEqual(chain.ttsEpub.path, 'source/Killing America.tts.epub');

  // Not one byte of the book moves. The chain's stem derives to the name the
  // file already has, which is why the migration renames nothing.
  assert.strictEqual(
    await sha256(path.join(dir, 'source', 'Killing America.working.epub')), bookBefore,
    'the migration rewrote the working copy');
});

test('the migration is idempotent — a second run mints nothing and moves nothing', async () => {
  const dir = await makeLegacyProject('legacy-idempotent');
  const first = await manifestService.ensureBookFamilies(dir);
  assert.ok(first.minted, 'the first run minted no chain');
  const afterFirst = JSON.stringify(readManifest(dir).families);
  const filesAfterFirst = fs.readdirSync(path.join(dir, 'source')).sort().join('|');

  const second = await manifestService.ensureBookFamilies(dir);

  assert.strictEqual(second.minted, null, 'the second run minted a second chain');
  assert.strictEqual(second.refusal, null);
  assert.strictEqual(
    JSON.stringify(readManifest(dir).families), afterFirst, 'the second run rewrote the chain');
  assert.strictEqual(
    fs.readdirSync(path.join(dir, 'source')).sort().join('|'), filesAfterFirst,
    'the second run left a file behind');
});

test('a PDF project\'s chain hangs off the CAST book, never the PDF', async () => {
  const dir = await makePdfProject('pdf-chain');

  await manifestService.ensureBookFamilies(dir);

  const [chain] = familiesOf(dir);
  assert.strictEqual(chain.source.kind, 'generated-epub');
  assert.strictEqual(chain.source.path, 'source/Deathstalker.generated.epub');
  // And its working copy is still named after the PDF, because the `.generated`
  // half of a cast book's name is stripped from the stem.
  const book = await manifestService.ensureBookEpub(dir);
  assert.strictEqual(book.relPath, 'source/Deathstalker.working');
});

test('a PDF nobody has converted gets NO chain, and the refusal names the act', async () => {
  const dir = path.join(projectsDir, 'pdf-unread');
  writeRaw(path.join(dir, 'archive', 'Unread.pdf'), Buffer.from('%PDF-1.7'));
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

  const adoption = await manifestService.ensureBookFamilies(dir);

  assert.strictEqual(adoption.minted, null, 'a chain was invented for an unconverted PDF');
  assert.ok(adoption.refusal, 'the refusal must be reported');
  assert.match(adoption.refusal, /Convert to EPUB/, 'the refusal must name the act that fixes it');
  assert.strictEqual(familiesOf(dir).length, 0, 'an empty chain was written');
});

// ── 2. A second chain, with everything of its own ────────────────────────────

test('a second edition gets its own chain, its own copy and its own tts copy', async () => {
  const dir = await makeLegacyProject('two-chains');
  await manifestService.ensureBookFamilies(dir);
  const first = familiesOf(dir)[0];

  const second = await addSecondEdition(dir, 'Killing America. Second edition.epub', SECOND_BYTES);

  assert.notStrictEqual(second.id, first.id, 'the two chains share an id');
  assert.strictEqual(familiesOf(dir).length, 2);

  // Its working copy is named after ITS source, and is ITS source's bytes.
  const book = await manifestService.ensureBookEpub(dir, second.id);
  assert.strictEqual(book.relPath, 'source/Killing America. Second edition.working');
  await sameBook(book.absPath, path.join(dir, 'archive', 'Killing America. Second edition.epub'));

  // The first chain's copy is untouched, and still its own source's bytes.
  assert.strictEqual(
    await sha256(path.join(dir, 'source', 'Killing America.working.epub')),
    await sha256(path.join(dir, 'archive', 'Killing America.epub')),
    'minting the second chain\'s copy disturbed the first chain\'s');

  // A narration copy is recorded against the chain it was cut from, and nowhere
  // else — the tts copy is nested under its parent, which is the whole of what
  // "no ambiguity" means on that row.
  await manifestService.registerNarrationEpub(dir, {
    path: 'source/Killing America. Second edition.tts.epub',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    removedElements: 0,
    epubSha256: await sha256(book.absPath),
  }, second.id);
  assert.strictEqual(
    chainOff(dir, 'Killing America. Second edition.epub').ttsEpub.path,
    'source/Killing America. Second edition.tts.epub');
  assert.strictEqual(
    chainOff(dir, 'Killing America.epub').ttsEpub.path, 'source/Killing America.tts.epub',
    'the first chain\'s narration copy was replaced by the second chain\'s');
});

test('two sources with ONE stem are refused BY NAME, and nothing is written', async () => {
  const dir = await makeLegacyProject('stem-collision');
  await manifestService.ensureBookFamilies(dir);
  // A different file, in a different place, with the same basename — so both
  // chains would derive `source/Killing America.working.epub`.
  const clashing = path.join(dir, 'archive', 'second', 'Killing America.epub');
  await writeBook(clashing, SECOND_BYTES);

  await assert.rejects(
    () => manifestService.addBookFamily(dir, { absPath: clashing, kind: 'archive-epub' }),
    (err) => /named after "Killing America"/.test(err.message)
      && /would destroy the first/.test(err.message),
    'the refusal must name the stem and say what it protects');
  assert.strictEqual(familiesOf(dir).length, 1, 'the refused chain was recorded anyway');
});

test('a second chain off the SAME source is refused — one book, one chain', async () => {
  const dir = await makeLegacyProject('same-source');
  await manifestService.ensureBookFamilies(dir);
  await assert.rejects(
    () => manifestService.addBookFamily(
      dir, { absPath: path.join(dir, 'archive', 'Killing America.epub'), kind: 'archive-epub' }),
    (err) => /already has a working chain hanging off/.test(err.message),
    'two chains off one book must be refused');
  assert.strictEqual(familiesOf(dir).length, 1);
});

// ── 3 and 4. The resolution rule ─────────────────────────────────────────────

test('ONE chain answers every reader without being told which', async () => {
  const dir = await makeLegacyProject('sole-resolves');
  await manifestService.ensureBookFamilies(dir);

  const book = await manifestService.readExportEpub(dir);
  assert.ok(book, 'the sole chain did not answer for the book');
  assert.strictEqual(book.relPath, 'source/Killing America.working.epub');
  assert.strictEqual((await manifestService.readAppliedPasses(dir)).length, 1);
  assert.strictEqual((await manifestService.readNarrationDeletions(dir)).elements.length, 2);
  assert.ok(await manifestService.readNarrationEpub(dir), 'the sole chain did not answer for tts');
  assert.deepStrictEqual(await manifestService.readBookLedger(dir), []);
});

test('SEVERAL chains REFUSE without an id, and the refusal names them both', async () => {
  const dir = await makeLegacyProject('several-refuse');
  await manifestService.ensureBookFamilies(dir);
  await addSecondEdition(dir, 'Killing America. Second edition.epub', SECOND_BYTES);

  const namesBoth = (err) =>
    /2 working chains/.test(err.message)
    && /Killing America\.epub/.test(err.message)
    && /Killing America\. Second edition\.epub/.test(err.message);

  for (const [label, call] of [
    ['readExportEpub', () => manifestService.readExportEpub(dir)],
    ['readAppliedPasses', () => manifestService.readAppliedPasses(dir)],
    ['readBookLedger', () => manifestService.readBookLedger(dir)],
    ['readNarrationEpub', () => manifestService.readNarrationEpub(dir)],
    ['readNarrationDeletions', () => manifestService.readNarrationDeletions(dir)],
    ['ensureBookEpub', () => manifestService.ensureBookEpub(dir)],
    ['exportEpubTarget', () => manifestService.exportEpubTarget(dir)],
    ['clearBookLedger', () => manifestService.clearBookLedger(dir)],
    ['forgetNarrationEpub', () => manifestService.forgetNarrationEpub(dir)],
    ['resetEditorRecords', () => manifestService.resetEditorRecords(dir)],
  ]) {
    await assert.rejects(call, namesBoth, `${label} answered a question with two answers`);
  }

  // And each one answers when it IS told which.
  const second = chainOff(dir, 'Killing America. Second edition.epub');
  const book = await manifestService.readExportEpub(dir, chainOff(dir, 'Killing America.epub').id);
  assert.strictEqual(book.relPath, 'source/Killing America.working.epub');
  assert.strictEqual(await manifestService.readExportEpub(dir, second.id), null,
    'the second chain has no working copy yet and must say so');
});

test('an id that names no chain refuses, listing the chains there are', async () => {
  const dir = await makeLegacyProject('unknown-id');
  await manifestService.ensureBookFamilies(dir);
  await assert.rejects(
    () => manifestService.readExportEpub(dir, 'fam-deadbeef'),
    (err) => /no working chain called fam-deadbeef/.test(err.message)
      && /Killing America\.epub/.test(err.message),
    'a stale row must be refused, not resolved to the first chain');
});

// ── 5. Per-chain acts reach one chain only ───────────────────────────────────

test('erasing one chain\'s changes leaves the other chain\'s records alone', async () => {
  const dir = await makeLegacyProject('erase-one');
  await manifestService.ensureBookFamilies(dir);
  const first = chainOff(dir, 'Killing America.epub');
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  await manifestService.ensureBookEpub(dir, second.id);

  // An evening of work on the SECOND chain: strikes of its own.
  const secondBook = await manifestService.readExportEpub(dir, second.id);
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: await sha256(secondBook.absPath),
    elements: ['OEBPS/ch9.xhtml#1'],
    updatedAt: '2026-08-10T00:00:00.000Z',
  }, second.id);

  await manifestService.resetEditorRecords(dir, first.id);

  assert.strictEqual(
    chainOff(dir, 'Killing America.epub').epub.narrationDeletions, undefined,
    'the first chain\'s strikes survived its own reset');
  assert.strictEqual(
    chainOff(dir, 'Second Book.epub').epub.narrationDeletions.elements.length, 1,
    'resetting the first chain cleared the second chain\'s strikes');
});

test('the picker\'s curation goes only with the chain that describes it', async () => {
  const dir = await makeLegacyProject('picker-records');
  await manifestService.ensureBookFamilies(dir);
  const first = chainOff(dir, 'Killing America.epub');
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);

  const withCuration = readManifest(dir);
  withCuration.editor = { undoStack: [{ kind: 'split' }] };
  withCuration.source.deletedBlockIds = ['b-1', 'b-2'];
  withCuration.chapters = [{ id: 'c1', title: 'One', page: 1, level: 1 }];
  writeManifest(dir, withCuration);

  // The SECOND chain is a different file, laid out separately — the picker's
  // page and block records say nothing about it, so erasing its changes must
  // not clear them.
  await manifestService.resetEditorRecords(dir, second.id);
  assert.ok(readManifest(dir).editor, 'a second version\'s reset cleared the picker\'s curation');
  assert.strictEqual(readManifest(dir).source.deletedBlockIds.length, 2);
  assert.ok(readManifest(dir).chapters, 'a second version\'s reset cleared the chapter markers');

  // The chain hanging off the ARCHIVE ORIGINAL is the one they belong to.
  await manifestService.resetEditorRecords(dir, first.id);
  assert.strictEqual(readManifest(dir).editor, undefined, 'the owning chain\'s reset kept them');
  assert.strictEqual(readManifest(dir).source.deletedBlockIds, undefined);
  assert.strictEqual(readManifest(dir).chapters, undefined);
  // The source's IDENTITY is not a record of anything the user did and must
  // never go with them.
  assert.strictEqual(readManifest(dir).source.type, 'epub');
});

test('deleting one chain\'s narration copy leaves the other\'s standing', async () => {
  const dir = await makeLegacyProject('tts-delete');
  await manifestService.ensureBookFamilies(dir);
  const first = chainOff(dir, 'Killing America.epub');
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  const secondBook = await manifestService.ensureBookEpub(dir, second.id);
  await manifestService.registerNarrationEpub(dir, {
    path: 'source/Second Book.tts.epub',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    removedElements: 0,
    epubSha256: await sha256(secondBook.absPath),
  }, second.id);

  const forgotten = await manifestService.forgetNarrationEpub(dir, first.id);

  assert.strictEqual(forgotten.relPath, 'source/Killing America.tts.epub');
  assert.strictEqual(
    chainOff(dir, 'Killing America.epub').ttsEpub, undefined,
    'the named chain\'s narration record survived');
  assert.strictEqual(
    chainOff(dir, 'Second Book.epub').ttsEpub.path, 'source/Second Book.tts.epub',
    'deleting one chain\'s narration copy took the other chain\'s with it');
});

test('a mint may not land on another chain\'s working copy', async () => {
  const dir = await makeLegacyProject('mint-guard');
  await manifestService.ensureBookFamilies(dir);
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  const victim = (await manifestService.ensureBookEpub(dir, second.id)).absPath;
  const victimDigest = await sha256(victim);

  // The damaged manifest this guard exists for: a THIRD chain whose source has
  // the same basename as the second's, so both derive
  // `source/Second Book.working`. `addBookFamily` refuses to write this —
  // that refusal is tested above — so it is written by hand here, because this
  // is the shape a half-synced or hand-edited manifest takes and the guard has
  // to hold against the file rather than against the act that made it.
  const impostorSource = 'archive/second-scan/Second Book.epub';
  await writeBook(path.join(dir, 'archive', 'second-scan', 'Second Book.epub'), CAST_BYTES);
  const damaged = readManifest(dir);
  const impostorId = 'fam-deadbe11';
  damaged.families.push({
    id: impostorId,
    source: { path: impostorSource, kind: 'archive-epub', sha256: await sha256(
      path.join(dir, 'archive', 'second-scan', 'Second Book.epub')) },
  });
  writeManifest(dir, damaged);

  await assert.rejects(
    () => manifestService.ensureBookEpub(dir, impostorId),
    (err) => /would be written over/.test(err.message)
      && /Second Book\.working/.test(err.message),
    'a mint landing on another chain\'s working copy must be refused, naming the file');
  assert.strictEqual(await sha256(victim), victimDigest, 'the refused mint wrote to the file anyway');
});

// ── The naming rule that makes a second reading POSSIBLE ─────────────────────
//
// The refusal above is right and, on its own, would make "Add a copy" in Convert
// to EPUB refuse every time: the name the conversion derives for a second
// reading is the archive original's stem, which is the stem the first chain is
// already named after. So the reading is numbered, and these two tests are the
// pair — the collision is refused, and the numbered name is accepted.

test('a second reading is NUMBERED, from 2, skipping the numbers already taken', () => {
  assert.strictEqual(nextReadingName([], 'Deathstalker'), 'Deathstalker (reading 2)');
  assert.strictEqual(
    nextReadingName(['Deathstalker'], 'Deathstalker'), 'Deathstalker (reading 2)');
  // Run twice: readings 2 and 3, never two readings 2.
  assert.strictEqual(
    nextReadingName(['Deathstalker', 'Deathstalker (reading 2)'], 'Deathstalker'),
    'Deathstalker (reading 3)');
  // Case is not a difference: two working copies whose names differ only in case
  // are one file on Windows.
  assert.strictEqual(
    nextReadingName(['deathstalker (reading 2)'], 'Deathstalker'), 'Deathstalker (reading 3)');
});

test('the numbered name is ACCEPTED where the bare one is refused', async () => {
  const dir = await makeLegacyProject('second-reading');
  await manifestService.ensureBookFamilies(dir);
  const stem = familyStem(familiesOf(dir)[0].source);
  assert.strictEqual(stem, 'Killing America');

  // The name a conversion would derive: refused, because both chains would want
  // `source/Killing America.working.epub`.
  const bare = path.join(dir, 'archive', 'Killing America.epub2');
  const collides = path.join(dir, 'archive', 'Killing America.epub');
  assert.ok(fs.existsSync(collides), 'the fixture must already hold the colliding name');
  assert.ok(!fs.existsSync(bare), 'no stray file');

  // The name the rule gives instead: a chain of its own, with its own stem.
  const named = `${nextReadingName([stem], stem)}.epub`;
  const second = path.join(dir, 'archive', named);
  await writeBook(second, SECOND_BYTES);
  const chain = await manifestService.addBookFamily(
    dir, { absPath: second, kind: 'archive-epub' });
  assert.strictEqual(familiesOf(dir).length, 2, 'the second reading got a chain of its own');
  assert.strictEqual(familyStem(chain.source), 'Killing America (reading 2)');

  // And its files are named after IT, so nothing it mints can land on the first
  // chain's working copy — which is the whole reason the stem rule exists.
  const book = await manifestService.ensureBookEpub(dir, chain.id);
  assert.strictEqual(book.relPath, 'source/Killing America (reading 2).working');
  assert.strictEqual(
    await sha256(path.join(dir, 'source', 'Killing America.working.epub')),
    await sha256(path.join(dir, 'archive', 'Killing America.epub')),
    'the first chain\'s working copy was written over by the second chain\'s mint');
});

// ── 7. The fragility fixes (2026-08-10 main-process wave) ───────────────────

test('MP-H1: deleting an archive file drops the chains sourced on it, and its archive entry',
  async () => {
    const dir = await makeLegacyProject('h1-archive-delete');
    await manifestService.ensureBookFamilies(dir);
    const chain = chainOff(dir, 'Killing America.epub');
    assert.ok(chain.epub, 'the fixture chain must carry a working copy record');

    // Exactly what `variant:delete` does inside its own transaction.
    const manifest = readManifest(dir);
    const removed = manifestService.dropArchiveSourcedChains(
      manifest, dir, 'archive/Killing America.epub');
    writeManifest(dir, manifest);

    assert.strictEqual(removed.length, 1, 'the chain sourced on the deleted file survived');
    assert.strictEqual(removed[0].id, chain.id);
    assert.strictEqual(removed[0].sourceName, 'Killing America.epub');
    assert.strictEqual(
      removed[0].epubAbsPath,
      path.join(dir, 'source', 'Killing America.working.epub'),
      'the working copy the dead chain still vouched for was not named back');
    assert.strictEqual(
      removed[0].ttsAbsPath, path.join(dir, 'source', 'Killing America.tts.epub'));
    assert.strictEqual(familiesOf(dir).length, 0, 'the chain record was left standing');
    assert.deepStrictEqual(
      readManifest(dir).archive, [],
      'the archive entry kept naming the file that was just deleted');
  });

test('MP-H1: a chain sourced on some OTHER file is not touched', async () => {
  const dir = await makeLegacyProject('h1-other-chain');
  await manifestService.ensureBookFamilies(dir);
  const second = await addSecondEdition(dir, 'Killing America (reading 2).epub', SECOND_BYTES);
  assert.strictEqual(familiesOf(dir).length, 2);

  const manifest = readManifest(dir);
  const removed = manifestService.dropArchiveSourcedChains(
    manifest, dir, 'archive/Killing America.epub');
  writeManifest(dir, manifest);

  assert.strictEqual(removed.length, 1, 'both chains went for one file');
  assert.strictEqual(familiesOf(dir).length, 1);
  assert.strictEqual(familiesOf(dir)[0].id, second.id, 'the wrong chain survived');
  // Only the deleted file's archive entry goes. (`addBookFamily` writes no
  // archive entry of its own, so the reading-2 file never had one — the point
  // here is that the pruning is BY PATH and takes exactly one.)
  assert.deepStrictEqual(
    readManifest(dir).archive.map((a) => a.path), [],
    'the archive entry pruning did not take exactly the deleted file\'s');
});

test('MP-H1: separator and case spellings of one path name one file', async () => {
  const dir = await makeLegacyProject('h1-path-spelling');
  await manifestService.ensureBookFamilies(dir);
  const manifest = readManifest(dir);
  const removed = manifestService.dropArchiveSourcedChains(
    manifest, dir, 'ARCHIVE\\Killing America.epub');
  assert.strictEqual(removed.length, 1,
    'a manifest synced from the other machine spells its paths differently and must still match');
});

test('MP-H2: forgetting a book names the narration copy it also stopped recording',
  async () => {
    const dir = await makeLegacyProject('h2-tts-orphan');
    await manifestService.ensureBookFamilies(dir);
    const chain = chainOff(dir, 'Killing America.epub');
    assert.ok(chain.ttsEpub, 'the fixture chain must carry a narration copy record');

    const forgotten = await manifestService.forgetEpubExport(dir, chain.id);

    assert.strictEqual(forgotten.relPath, 'source/Killing America.working.epub');
    assert.strictEqual(
      forgotten.ttsRelPath, 'source/Killing America.tts.epub',
      'the narration copy the transaction dropped the record of was not named back, so a caller '
      + 'reading the manifest afterwards leaves a whole book on disk unrecorded');
    assert.strictEqual(
      forgotten.ttsAbsPath, path.join(dir, 'source', 'Killing America.tts.epub'));
    // And the record really is gone by then — which is why it had to travel back.
    assert.strictEqual(chainOff(dir, 'Killing America.epub').ttsEpub, undefined);
  });

test('MP-H2: a chain with no narration copy says so rather than inventing a path', async () => {
  const dir = await makeLegacyProject('h2-no-tts');
  await manifestService.ensureBookFamilies(dir);
  const manifest = readManifest(dir);
  delete manifest.families[0].ttsEpub;
  writeManifest(dir, manifest);

  const forgotten = await manifestService.forgetEpubExport(dir, manifest.families[0].id);
  assert.strictEqual(forgotten.ttsRelPath, null);
  assert.strictEqual(forgotten.ttsAbsPath, null);
});

test('MP-H3: a bare PDF project resets its picker records instead of refusing', async () => {
  // A project whose pages nobody has read: no archive-grade book, so no chain
  // can be minted — and every one of the records below belongs to the PDF.
  const dir = path.join(projectsDir, 'h3-bare-pdf');
  writeRaw(path.join(dir, 'archive', 'Deathstalker.pdf'), Buffer.from('%PDF-1.7 pages'));
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: 'h3-bare-pdf',
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Deathstalker' },
    source: {
      type: 'pdf',
      originalFilename: 'Deathstalker.pdf',
      deletedBlockIds: ['a', 'b'],
      deletedPages: [4, 5],
      pageOrder: [1, 2, 3],
    },
    chapters: [{ title: 'One', page: 1 }],
    chaptersSource: 'manual',
    archive: [{ path: 'archive/Deathstalker.pdf', role: 'original', format: 'pdf' }],
  });

  assert.strictEqual(familiesOf(dir).length, 0, 'the fixture must have no chain');
  await manifestService.resetEditorRecords(dir);

  const after = readManifest(dir);
  assert.strictEqual(after.source.deletedBlockIds, undefined, 'the block deletions survived');
  assert.strictEqual(after.source.deletedPages, undefined, 'the page deletions survived');
  assert.strictEqual(after.source.pageOrder, undefined, 'the page order survived');
  assert.strictEqual(after.chapters, undefined, 'the chapter markers survived');
  assert.strictEqual(after.chaptersSource, undefined);
  // The project's IDENTITY is not a picker record and must not go with them.
  assert.strictEqual(after.source.type, 'pdf');
  assert.strictEqual(after.source.originalFilename, 'Deathstalker.pdf');
});

test('MP-H3: a project with several chains still refuses a reset that names none', async () => {
  const dir = await makeLegacyProject('h3-two-chains');
  await manifestService.ensureBookFamilies(dir);
  await addSecondEdition(dir, 'Killing America (reading 2).epub', SECOND_BYTES);

  await assert.rejects(
    () => manifestService.resetEditorRecords(dir),
    /2 working chains/,
    'a reset that could clear either book\'s records must name which');
});

test('MP-H6: a legacy project whose original was MOVED keeps its working copy visible',
  async () => {
    const dir = await makeLegacyProject('h6-moved-original');
    // The pre-archive layout: the original sat at source/original.epub and was
    // never recorded. Here the user has moved it away — and the archive entry
    // that would otherwise answer goes with it, which is what makes the format
    // read as null.
    const manifest = readManifest(dir);
    delete manifest.archive;
    writeManifest(dir, manifest);
    fs.rmSync(path.join(dir, 'archive', 'Killing America.epub'));

    const adoption = await manifestService.ensureBookFamilies(dir);

    assert.strictEqual(
      adoption.refusal, null,
      'the project has a working copy with an evening of edits in it and was refused a chain');
    assert.ok(adoption.minted, 'no chain was minted');
    assert.strictEqual(adoption.minted.source.path, 'source/original.epub');
    assert.strictEqual(adoption.minted.source.kind, 'archive-epub');
    assert.strictEqual(
      adoption.minted.source.sha256, null,
      'a digest was invented for a file that is not there to be measured');
    // The point of the whole fix: the working copy is readable again.
    const book = await manifestService.readExportEpub(dir);
    assert.ok(book, 'the working copy is still invisible to every reader');
    assert.strictEqual(book.relPath, 'source/Killing America.working.epub');
  });

test('MP-H6: a project with nothing archive-grade AND no book still gets no chain', async () => {
  const dir = path.join(projectsDir, 'h6-nothing');
  writeRaw(path.join(dir, 'archive', 'Read Aloud.m4b'), Buffer.from('an audiobook, not a book'));
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: 'h6-nothing',
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Read Aloud' },
    source: { type: 'epub' },
    archive: [{ path: 'archive/Read Aloud.m4b', role: 'original', format: 'm4b' }],
  });

  const adoption = await manifestService.ensureBookFamilies(dir);
  assert.strictEqual(adoption.minted, null, 'a chain was invented for an imported audiobook');
  assert.match(adoption.refusal, /no archive original/);
});

test('MP-M1: the ledger of a project with no chain is empty, not a refusal', async () => {
  const dir = path.join(projectsDir, 'm1-bare-pdf-ledger');
  writeRaw(path.join(dir, 'archive', 'Deathstalker.pdf'), Buffer.from('%PDF-1.7 pages'));
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: 'm1-bare-pdf-ledger',
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'Deathstalker' },
    source: { type: 'pdf', originalFilename: 'Deathstalker.pdf' },
    archive: [{ path: 'archive/Deathstalker.pdf', role: 'original', format: 'pdf' }],
  });

  assert.deepStrictEqual(await manifestService.readBookLedger(dir), []);
});

test('MP-M1: a ledger asked for BY NAME still refuses a chain that is not there', async () => {
  const dir = await makeLegacyProject('m1-named-chain');
  await manifestService.ensureBookFamilies(dir);
  await assert.rejects(
    () => manifestService.readBookLedger(dir, 'fam-deadbeef'),
    /no working chain called fam-deadbeef/);
});

test('MP-M2: a chapter rename touches, re-stamps and logs in ONE transaction', async () => {
  const dir = await makeLegacyProject('m2-rename-record');
  await manifestService.ensureBookFamilies(dir);
  const chain = chainOff(dir, 'Killing America.epub');
  const before = chain.epub.narrationDeletions.epubSha256;

  const result = await manifestService.recordChapterRename(dir, {
    kind: 'rename-chapter',
    at: '2026-08-10T12:00:00.000Z',
    file: 'OEBPS/ch1.xhtml',
    titleBefore: 'CHAPTER ONE',
    titleAfter: 'The Beginning',
    fromSha256: before,
    toSha256: 'newsha',
  }, chain.id);

  assert.strictEqual(result.alreadyVoid, false);
  const after = chainOff(dir, 'Killing America.epub');
  assert.strictEqual(after.epub.modifiedAt, '2026-08-10T12:00:00.000Z', 'the book was not touched');
  assert.strictEqual(
    after.epub.narrationDeletions.epubSha256, 'newsha',
    'the strikes still name the old bytes, which is the void record that shuts a project');
  assert.deepStrictEqual(
    after.epub.narrationDeletions.elements, ['OEBPS/ch1.xhtml#3', 'OEBPS/ch1.xhtml#4'],
    'a rename moves no element and must not move a strike key');
  const logged = after.epub.bookEdits.filter((e) => e.kind === 'rename-chapter');
  assert.strictEqual(logged.length, 1, 'the rename left no record of what the chapter was called');
  assert.strictEqual(logged[0].titleBefore, 'CHAPTER ONE');
});

test('MP-M2: an ALREADY void strike record is reported, not forged', async () => {
  const dir = await makeLegacyProject('m2-rename-void');
  await manifestService.ensureBookFamilies(dir);
  const chain = chainOff(dir, 'Killing America.epub');

  const result = await manifestService.recordChapterRename(dir, {
    kind: 'rename-chapter',
    at: '2026-08-10T12:00:00.000Z',
    file: 'OEBPS/ch1.xhtml',
    titleBefore: 'CHAPTER ONE',
    titleAfter: 'The Beginning',
    fromSha256: 'a book nobody has',
    toSha256: 'newsha',
  }, chain.id);

  assert.strictEqual(result.alreadyVoid, true, 'the mismatch was not reported');
  const after = chainOff(dir, 'Killing America.epub');
  assert.strictEqual(
    after.epub.narrationDeletions.epubSha256,
    chain.epub.narrationDeletions.epubSha256,
    'a record about some other book was re-stamped onto this one — forged agreement');
  assert.strictEqual(
    after.epub.bookEdits.filter((e) => e.kind === 'rename-chapter').length, 1,
    'the rename happened and must be logged whatever the strikes say');
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
  console.log(`\nfamily-lifecycle: ${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
