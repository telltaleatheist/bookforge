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

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

/**
 * An EPUB, as far as everything under test is concerned: a file of bytes with a
 * sha256. Nothing here parses one — a working copy is proved by digest, and a
 * digest does not care whether the zip is valid.
 */
function writeBook(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
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

const FIRST_BYTES = Buffer.from('PK the first edition, exactly as it was handed over');
const SECOND_BYTES = Buffer.from('PK a different edition of the same book, also handed over');
const CAST_BYTES = Buffer.from('PK the book the page reader made of the pages');

/**
 * A LEGACY project: imported as an EPUB, with its book and its narration copy
 * at the records projects used before chains existed, and an evening of work
 * recorded against the book.
 */
function makeLegacyProject(id) {
  const dir = path.join(projectsDir, id);
  writeBook(path.join(dir, 'archive', 'Killing America.epub'), FIRST_BYTES);
  writeBook(path.join(dir, 'source', 'Killing America.working.epub'), FIRST_BYTES);
  writeBook(path.join(dir, 'source', 'Killing America.tts.epub'), FIRST_BYTES);
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
          epubSha256: crypto.createHash('sha256').update(FIRST_BYTES).digest('hex'),
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
        epubSha256: crypto.createHash('sha256').update(FIRST_BYTES).digest('hex'),
      },
    },
  });
  return dir;
}

/** A PDF project whose pages were read: its chain hangs off the CAST book. */
function makePdfProject(id) {
  const dir = path.join(projectsDir, id);
  writeBook(path.join(dir, 'archive', 'Deathstalker.pdf'), Buffer.from('%PDF-1.7 pages'));
  writeBook(path.join(dir, 'source', 'Deathstalker.generated.epub'), CAST_BYTES);
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
        sha256: crypto.createHash('sha256').update(CAST_BYTES).digest('hex'),
        origin: 'cast',
      },
    },
  });
  return dir;
}

/** Put a second archive-grade EPUB in the project, and give it a chain. */
async function addSecondEdition(dir, filename, bytes) {
  const absPath = path.join(dir, 'archive', filename);
  writeBook(absPath, bytes);
  return manifestService.addBookFamily(dir, { absPath, kind: 'archive-epub' });
}

// ── 1. The migration ─────────────────────────────────────────────────────────

test('a legacy project is given ONE chain, off the book it already answered with', async () => {
  const dir = makeLegacyProject('legacy-mint');
  const bookBefore = sha256(path.join(dir, 'source', 'Killing America.working.epub'));

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
    chain.source.sha256, sha256(path.join(dir, 'archive', 'Killing America.epub')),
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
    sha256(path.join(dir, 'source', 'Killing America.working.epub')), bookBefore,
    'the migration rewrote the working copy');
});

test('the migration is idempotent — a second run mints nothing and moves nothing', async () => {
  const dir = makeLegacyProject('legacy-idempotent');
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
  const dir = makePdfProject('pdf-chain');

  await manifestService.ensureBookFamilies(dir);

  const [chain] = familiesOf(dir);
  assert.strictEqual(chain.source.kind, 'generated-epub');
  assert.strictEqual(chain.source.path, 'source/Deathstalker.generated.epub');
  // And its working copy is still named after the PDF, because the `.generated`
  // half of a cast book's name is stripped from the stem.
  const book = await manifestService.ensureBookEpub(dir);
  assert.strictEqual(book.relPath, 'source/Deathstalker.working.epub');
});

test('a PDF nobody has converted gets NO chain, and the refusal names the act', async () => {
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

  const adoption = await manifestService.ensureBookFamilies(dir);

  assert.strictEqual(adoption.minted, null, 'a chain was invented for an unconverted PDF');
  assert.ok(adoption.refusal, 'the refusal must be reported');
  assert.match(adoption.refusal, /Convert to EPUB/, 'the refusal must name the act that fixes it');
  assert.strictEqual(familiesOf(dir).length, 0, 'an empty chain was written');
});

// ── 2. A second chain, with everything of its own ────────────────────────────

test('a second edition gets its own chain, its own copy and its own tts copy', async () => {
  const dir = makeLegacyProject('two-chains');
  await manifestService.ensureBookFamilies(dir);
  const first = familiesOf(dir)[0];

  const second = await addSecondEdition(dir, 'Killing America. Second edition.epub', SECOND_BYTES);

  assert.notStrictEqual(second.id, first.id, 'the two chains share an id');
  assert.strictEqual(familiesOf(dir).length, 2);

  // Its working copy is named after ITS source, and is ITS source's bytes.
  const book = await manifestService.ensureBookEpub(dir, second.id);
  assert.strictEqual(book.relPath, 'source/Killing America. Second edition.working.epub');
  assert.strictEqual(
    sha256(book.absPath), sha256(path.join(dir, 'archive', 'Killing America. Second edition.epub')),
    'the second chain\'s copy is not its own source\'s bytes');

  // The first chain's copy is untouched, and still its own source's bytes.
  assert.strictEqual(
    sha256(path.join(dir, 'source', 'Killing America.working.epub')),
    sha256(path.join(dir, 'archive', 'Killing America.epub')),
    'minting the second chain\'s copy disturbed the first chain\'s');

  // A narration copy is recorded against the chain it was cut from, and nowhere
  // else — the tts copy is nested under its parent, which is the whole of what
  // "no ambiguity" means on that row.
  await manifestService.registerNarrationEpub(dir, {
    path: 'source/Killing America. Second edition.tts.epub',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    removedElements: 0,
    epubSha256: sha256(book.absPath),
  }, second.id);
  assert.strictEqual(
    chainOff(dir, 'Killing America. Second edition.epub').ttsEpub.path,
    'source/Killing America. Second edition.tts.epub');
  assert.strictEqual(
    chainOff(dir, 'Killing America.epub').ttsEpub.path, 'source/Killing America.tts.epub',
    'the first chain\'s narration copy was replaced by the second chain\'s');
});

test('two sources with ONE stem are refused BY NAME, and nothing is written', async () => {
  const dir = makeLegacyProject('stem-collision');
  await manifestService.ensureBookFamilies(dir);
  // A different file, in a different place, with the same basename — so both
  // chains would derive `source/Killing America.working.epub`.
  const clashing = path.join(dir, 'archive', 'second', 'Killing America.epub');
  writeBook(clashing, SECOND_BYTES);

  await assert.rejects(
    () => manifestService.addBookFamily(dir, { absPath: clashing, kind: 'archive-epub' }),
    (err) => /named after "Killing America"/.test(err.message)
      && /would destroy the first/.test(err.message),
    'the refusal must name the stem and say what it protects');
  assert.strictEqual(familiesOf(dir).length, 1, 'the refused chain was recorded anyway');
});

test('a second chain off the SAME source is refused — one book, one chain', async () => {
  const dir = makeLegacyProject('same-source');
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
  const dir = makeLegacyProject('sole-resolves');
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
  const dir = makeLegacyProject('several-refuse');
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
  const dir = makeLegacyProject('unknown-id');
  await manifestService.ensureBookFamilies(dir);
  await assert.rejects(
    () => manifestService.readExportEpub(dir, 'fam-deadbeef'),
    (err) => /no working chain called fam-deadbeef/.test(err.message)
      && /Killing America\.epub/.test(err.message),
    'a stale row must be refused, not resolved to the first chain');
});

// ── 5. Per-chain acts reach one chain only ───────────────────────────────────

test('erasing one chain\'s changes leaves the other chain\'s records alone', async () => {
  const dir = makeLegacyProject('erase-one');
  await manifestService.ensureBookFamilies(dir);
  const first = chainOff(dir, 'Killing America.epub');
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  await manifestService.ensureBookEpub(dir, second.id);

  // An evening of work on the SECOND chain: strikes of its own.
  const secondBook = await manifestService.readExportEpub(dir, second.id);
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: sha256(secondBook.absPath),
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
  const dir = makeLegacyProject('picker-records');
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
  const dir = makeLegacyProject('tts-delete');
  await manifestService.ensureBookFamilies(dir);
  const first = chainOff(dir, 'Killing America.epub');
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  const secondBook = await manifestService.ensureBookEpub(dir, second.id);
  await manifestService.registerNarrationEpub(dir, {
    path: 'source/Second Book.tts.epub',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    removedElements: 0,
    epubSha256: sha256(secondBook.absPath),
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
  const dir = makeLegacyProject('mint-guard');
  await manifestService.ensureBookFamilies(dir);
  const second = await addSecondEdition(dir, 'Second Book.epub', SECOND_BYTES);
  const victim = (await manifestService.ensureBookEpub(dir, second.id)).absPath;
  const victimDigest = sha256(victim);

  // The damaged manifest this guard exists for: a THIRD chain whose source has
  // the same basename as the second's, so both derive
  // `source/Second Book.working.epub`. `addBookFamily` refuses to write this —
  // that refusal is tested above — so it is written by hand here, because this
  // is the shape a half-synced or hand-edited manifest takes and the guard has
  // to hold against the file rather than against the act that made it.
  const impostorSource = 'archive/second-scan/Second Book.epub';
  writeBook(path.join(dir, 'archive', 'second-scan', 'Second Book.epub'), CAST_BYTES);
  const damaged = readManifest(dir);
  const impostorId = 'fam-deadbe11';
  damaged.families.push({
    id: impostorId,
    source: { path: impostorSource, kind: 'archive-epub', sha256: sha256(
      path.join(dir, 'archive', 'second-scan', 'Second Book.epub')) },
  });
  writeManifest(dir, damaged);

  await assert.rejects(
    () => manifestService.ensureBookEpub(dir, impostorId),
    (err) => /would be written over/.test(err.message)
      && /Second Book\.working\.epub/.test(err.message),
    'a mint landing on another chain\'s working copy must be refused, naming the file');
  assert.strictEqual(sha256(victim), victimDigest, 'the refused mint wrote to the file anyway');
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
