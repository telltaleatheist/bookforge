#!/usr/bin/env node
/**
 * The working copy as an EXPLODED FOLDER, and the migration that makes it one.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-exploded-working-copy.js
 *
 * ── What is being asserted, and why each one ────────────────────────────────
 *
 * THE ROUND TRIP, because it is the whole point. A book is minted as a folder of
 * its parts, one entry is edited, and the claim "editing one chapter writes one
 * file" is MEASURED rather than believed — `DirectoryEpubSink.lastWrite()` says
 * which entries it touched, and every other entry must still carry the mtime it
 * was minted with.
 *
 * THE ENTRY-FOR-ENTRY REFUSAL, because the proof `deriveWorkingCopy` used to
 * make (hash both, compare) is not available across two containers, and the one
 * that replaced it is only worth anything if it actually refuses. A source that
 * loses an entry mid-copy must be named — the ENTRY, not "some byte somewhere" —
 * and the half-written copy must be gone.
 *
 * THE MIGRATION'S DRY RUN WRITES NOTHING, because it is the default and because
 * it is the thing that will be pointed at a real library first. Every path in
 * the project is measured before and after and must be identical, mtimes
 * included.
 *
 * VERIFY BEFORE DELETE, because the working copy carries edits that are NOT
 * re-derivable from `archive/`. A migration that cannot prove its unpacked copy
 * must leave BOTH artifacts standing.
 *
 * THE RE-STAMP, because 2b measured what a cross-algorithm comparison does at
 * each consumer and one of them (book-chapters' "the ToC is also a spine
 * document" guard) reads a mismatch as "not this book" — so the guard does NOT
 * fire and the add proceeds, which is a LOOSENING. A record that matched the
 * archive must come out of the migration matching the folder, so no consumer
 * ever sees the boundary at all.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'manifest-service.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  createEpubSink, epubContainerKindAt, openEpubSource, removeEpubContainer,
} = require(path.join(DIST, 'electron', 'epub-container.js'));
const { bookDigest } = require(path.join(DIST, 'electron', 'sidecar-binding.js'));
const {
  bookDigestAlgorithm, bookDigestAlgorithmChange,
} = require(path.join(DIST, 'shared', 'book-digest.js'));
const {
  bookDigestOf, bookEntryNames, bookEntryText,
} = require('./fixture-book');

// ── Harness ──────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-exploded-'));
manifestService.setLibraryBasePath(ROOT);
const projectsDir = path.join(ROOT, 'projects');

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
const writeManifest = (dir, manifest) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
};

/** A minimal, REAL EPUB with `chapters.length` chapter documents. */
async function writeEpub(file, chapters) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const docs = chapters.map((text, i) => ({
    name: `ch${i + 1}.xhtml`,
    xhtml: '<?xml version="1.0" encoding="utf-8"?>'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'
      + `Chapter ${i + 1}</title></head><body><p>${text}</p></body></html>`,
  }));
  const opf = '<?xml version="1.0" encoding="utf-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="i">urn:uuid:${crypto.createHash('sha256')
      .update(chapters.join('|')).digest('hex')}</dc:identifier>`
    + '<dc:title>The Exploded Book</dc:title><dc:language>en</dc:language></metadata><manifest>'
    + docs.map((d, i) =>
      `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('')
    + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    + '</manifest><spine>'
    + docs.map((_, i) => `<itemref idref="d${i}"/>`).join('')
    + '</spine></package>';
  const container = '<?xml version="1.0" encoding="utf-8"?>'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
    + 'media-type="application/oebps-package+xml"/></rootfiles></container>';
  const nav = '<?xml version="1.0" encoding="utf-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    + '<head><title>nav</title></head><body><nav epub:type="toc"><ol>'
    + docs.map((d, i) => `<li><a href="${d.name}">Chapter ${i + 1}</a></li>`).join('')
    + '</ol></nav></body></html>';

  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  for (const d of docs) zip.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  await zip.write(file);
  return file;
}

/** An EPUB-native project with its archive original and nothing else. */
async function makeProject(id, chapters = ['one', 'two']) {
  const dir = path.join(projectsDir, id);
  await writeEpub(path.join(dir, 'archive', 'The Exploded Book.epub'), chapters);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Exploded Book' },
    source: { type: 'epub', originalFilename: 'The Exploded Book.epub' },
    archive: [{ path: 'archive/The Exploded Book.epub', role: 'original', format: 'epub' }],
    outputs: {},
  });
  return dir;
}

/**
 * A LEGACY project: its book is a `.working.epub` ARCHIVE recorded the way every
 * project on disk records it today, with an evening of work stamped against it.
 */
async function makeLegacyProject(id, opts = {}) {
  const dir = path.join(projectsDir, id);
  await writeEpub(path.join(dir, 'archive', 'The Exploded Book.epub'), ['one', 'two']);
  const book = await writeEpub(
    path.join(dir, 'source', 'The Exploded Book.working.epub'), ['one', 'two']);
  await writeEpub(path.join(dir, 'source', 'The Exploded Book.tts.epub'), ['one']);
  const archived = (await bookDigest(book)).digest;
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Exploded Book' },
    source: { type: 'epub', originalFilename: 'The Exploded Book.epub' },
    archive: [{ path: 'archive/The Exploded Book.epub', role: 'original', format: 'epub' }],
    outputs: {
      epub: {
        path: 'source/The Exploded Book.working.epub',
        modifiedAt: '2026-08-02T00:00:00.000Z',
        narrationDeletions: {
          epubSha256: opts.staleStrikes === true ? 'f'.repeat(64) : archived,
          elements: ['OEBPS/ch1.xhtml#0'],
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      },
      ttsEpub: {
        path: 'source/The Exploded Book.tts.epub',
        modifiedAt: '2026-08-02T00:00:00.000Z',
        removedElements: 1,
        fromEpubSha256: archived,
      },
    },
  });
  return { dir, archived };
}

/** Every path under `dir`, with its size and mtime — the "nothing moved" probe. */
function census(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        out[`${childRel}/`] = 'dir';
        walk(childAbs, childRel);
      } else {
        const stat = fs.statSync(childAbs);
        out[childRel] = `${stat.size}@${stat.mtimeMs}`;
      }
    }
  };
  walk(dir, '');
  return out;
}

// ── 1. The round trip ────────────────────────────────────────────────────────

test('a minted working copy is a FOLDER of the book\'s parts, holding the archive\'s entries',
  async () => {
    const dir = await makeProject('roundtrip-mint');
    const book = await manifestService.ensureBookEpub(dir);

    assert.strictEqual(book.relPath, 'source/The Exploded Book.working',
      'the working copy is not recorded at the exploded name');
    assert.strictEqual(await epubContainerKindAt(book.absPath), 'directory',
      'the working copy is not a folder');
    // `mimetype` FIRST: a tree has no order of its own, and the `.tts.epub`
    // minted out of it would be an OCF violation if it did not come back first.
    const names = await bookEntryNames(book.absPath);
    assert.strictEqual(names[0], 'mimetype', 'mimetype is not the first entry');
    assert.deepStrictEqual([...names].sort(), [
      'META-INF/container.xml', 'OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml',
      'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'mimetype',
    ].sort(), 'the folder does not hold the archive original\'s entries');
    // And its identity SAYS it was measured as a folder, so nothing downstream
    // can read a re-measurement as a changed book.
    assert.strictEqual(bookDigestAlgorithm(await bookDigestOf(book.absPath)),
      'bookforge-epub-tree-v1');
  });

test('editing ONE chapter writes ONE file — measured, not asserted', async () => {
  const dir = await makeProject('roundtrip-edit');
  const book = await manifestService.ensureBookEpub(dir);

  const before = new Map();
  for (const name of await bookEntryNames(book.absPath)) {
    before.set(name, fs.statSync(path.join(book.absPath, ...name.split('/'))).mtimeMs);
  }
  // Enough of a gap that an mtime that DID move is visibly different: NTFS
  // timestamps are ~100 ns but the test must not depend on that.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // The shape every edit in this app has: read the book, write the book it
  // becomes, swapping the entries that changed.
  const source = await openEpubSource(book.absPath);
  const entries = [];
  for (const name of source.getEntries()) entries.push([name, await source.readEntry(name)]);
  source.close();
  const sink = await createEpubSink(book.absPath, 'directory');
  for (const [name, data] of entries) {
    sink.addFile(
      name,
      name === 'OEBPS/ch2.xhtml'
        ? Buffer.from(data.toString('utf8').replace('<p>two</p>', '<p>two, renamed</p>'), 'utf8')
        : data,
      name !== 'mimetype');
  }
  await sink.write(book.absPath);

  // THE CLAIM, from the sink itself.
  const report = sink.lastWrite();
  assert.deepStrictEqual(report.written, ['OEBPS/ch2.xhtml'],
    `the edit wrote ${report.written.length} entr(y/ies): ${report.written.join(', ')}`);
  assert.strictEqual(report.removed.length, 0, 'the edit removed entries');
  assert.strictEqual(report.unchanged.length, 5, 'the other five entries were not left alone');

  // And the same claim, from the FILESYSTEM: every other entry kept its mtime.
  for (const [name, mtime] of before) {
    const now = fs.statSync(path.join(book.absPath, ...name.split('/'))).mtimeMs;
    if (name === 'OEBPS/ch2.xhtml') {
      assert.notStrictEqual(now, mtime, 'the edited entry was not written');
    } else {
      assert.strictEqual(now, mtime, `${name} was rewritten by an edit that did not touch it`);
    }
  }
  assert.match(await bookEntryText(book.absPath, 'OEBPS/ch2.xhtml'), /two, renamed/);
  assert.match(await bookEntryText(book.absPath, 'OEBPS/ch1.xhtml'), /<p>one<\/p>/);
});

test('the narration copy cut from an exploded book is still an ARCHIVE', async () => {
  // ── One of the two boundaries that stay zips ───────────────────────────────
  //
  // `<stem>.tts.epub` is handed to ebook2audiobook, which is third-party Python
  // with its own ebook parser and cannot be given a folder. The book it is cut
  // FROM is a folder of its parts, so "the same container as the book" is
  // exactly the wrong rule here and the writer states `zip` instead.
  const dir = await makeProject('boundary-tts');
  const book = await manifestService.ensureBookEpub(dir);
  assert.strictEqual(await epubContainerKindAt(book.absPath), 'directory',
    'the fixture book is not exploded, so this proves nothing');

  const narrationExport = require(path.join(DIST, 'electron', 'narration-export.js'));
  const answer = await narrationExport.ensureNarrationEpub(dir);

  assert.ok(answer.relPath.endsWith('.tts.epub'), `unexpected narration path: ${answer.relPath}`);
  const ttsAbs = path.join(dir, ...answer.relPath.split('/'));
  assert.strictEqual(await epubContainerKindAt(ttsAbs), 'zip',
    'the narration copy came out as a folder, which ebook2audiobook cannot read');
  // And it is a book: mimetype first, and the entries the strike-free cut keeps.
  const names = await bookEntryNames(ttsAbs);
  assert.strictEqual(names[0], 'mimetype');
  assert.ok(names.includes('OEBPS/ch1.xhtml'), 'the narration copy lost the book\'s chapters');
});

// ── 2. The entry-for-entry proof ─────────────────────────────────────────────

test('a copy that loses an entry is refused BY NAME, and nothing is left of it', async () => {
  const dir = await makeProject('proof-refuses');
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });

  // ── A book whose two entries differ only in CASE ─────────────────────────
  //
  // A real publisher-EPUB shape, and the one way a copy can lose an entry that
  // a test can produce deterministically: on a case-insensitive filesystem
  // (every Windows one, and macOS by default) the two names are ONE file, so the
  // copy comes out holding five entries where the book has six. That is exactly
  // the class of failure the entry-for-entry proof exists to catch — a copy that
  // is quietly not the book — and the old digest comparison would have caught it
  // too, but could only ever have said "some byte somewhere".
  const collided = path.join(dir, 'source', 'collided.epub');
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from('<container/>', 'utf8'));
  zip.addFile('OEBPS/ch1.xhtml', Buffer.from('<html>lower</html>', 'utf8'));
  zip.addFile('OEBPS/CH1.xhtml', Buffer.from('<html>UPPER</html>', 'utf8'));
  await zip.write(collided);

  const probe = path.join(dir, 'source', 'CaseProbe');
  fs.writeFileSync(probe, 'x');
  const caseInsensitive = fs.existsSync(path.join(dir, 'source', 'caseprobe'));
  fs.rmSync(probe);

  const target = path.join(dir, 'source', 'target-tree');
  if (caseInsensitive) {
    await assert.rejects(
      () => manifestService.copyBookIntoContainer(
        collided, target, 'directory', 'the fixture\'s book'),
      (err) => /is missing 1 of the book's 4 entries/.test(err.message)
        && /OEBPS\/(ch1|CH1)\.xhtml/.test(err.message)
        && /Nothing of it was left/.test(err.message),
      'a copy that lost an entry must be refused, naming the entry');
    assert.ok(!fs.existsSync(target), 'the refused copy left a half-written book on disk');
  } else {
    // On a case-sensitive filesystem the two names are two files and the copy is
    // the book. Asserted rather than skipped: the proof must not refuse a copy
    // that IS the book either.
    const proved = await manifestService.copyBookIntoContainer(
      collided, target, 'directory', 'the fixture\'s book');
    assert.strictEqual(proved.entries, 4);
    await removeEpubContainer(target);
  }
});

test('a mismatched copy names the ENTRY, and removes what it wrote', async () => {
  const dir = await makeProject('proof-names-entry');
  const source = await manifestService.requireWorkingCopySource(dir);
  const target = path.join(dir, 'source', 'target-tree');

  // A book with a device name Windows cannot make a file of. It is refused at
  // the name, before a byte is written, and the message says which entry.
  const bad = path.join(dir, 'source', 'bad.epub');
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('OEBPS/NUL.xhtml', Buffer.from('<html/>', 'utf8'));
  await zip.write(bad);

  await assert.rejects(
    () => manifestService.copyBookIntoContainer(bad, target, 'directory', 'the fixture\'s book'),
    (err) => /OEBPS\/NUL\.xhtml/.test(err.message) && /reserves/.test(err.message),
    'the refusal must name the entry that cannot become a file');
  assert.ok(!fs.existsSync(target), 'a refused copy left a half-written book on disk');
  assert.ok(fs.existsSync(source.absPath), 'a refused copy removed the book it was reading');
});

// ── 3. The migration ─────────────────────────────────────────────────────────

test('the migration\'s DRY RUN reports the book and writes absolutely nothing', async () => {
  const { dir } = await makeLegacyProject('migrate-dry');
  const before = census(dir);

  const report = await manifestService.migrateWorkingCopyContainer(dir);

  assert.strictEqual(report.outcome, 'would-explode');
  assert.strictEqual(report.fromRelPath, 'source/The Exploded Book.working.epub');
  assert.strictEqual(report.toRelPath, 'source/The Exploded Book.working');
  assert.strictEqual(report.entries, 6, 'the dry run did not count the book\'s entries');
  assert.ok(report.bytes > 0, 'the dry run did not measure the book');
  assert.deepStrictEqual(report.restamped, [], 'a dry run re-stamped a record');

  assert.deepStrictEqual(census(dir), before,
    'the dry run wrote, moved or touched something');
  // Including the manifest — `requireFamily` would have minted this project a
  // chain, which is a write, and a report that promises to touch nothing may not
  // make it.
  assert.strictEqual(readManifest(dir).families, undefined,
    'the dry run gave the project a chain');
});

test('the migration unpacks the book, repoints the manifest, and removes the archive LAST',
  async () => {
    const { dir } = await makeLegacyProject('migrate-apply');
    const archiveOriginal = fs.readFileSync(path.join(dir, 'archive', 'The Exploded Book.epub'));

    const report = await manifestService.migrateWorkingCopyContainer(dir, { apply: true });

    assert.strictEqual(report.outcome, 'exploded');
    assert.strictEqual(report.entries, 6);
    const toAbs = path.join(dir, 'source', 'The Exploded Book.working');
    assert.strictEqual(await epubContainerKindAt(toAbs), 'directory');
    assert.ok(!fs.existsSync(path.join(dir, 'source', 'The Exploded Book.working.epub')),
      'the archive was left beside the folder it became');

    const chains = readManifest(dir).families;
    assert.strictEqual(chains.length, 1, 'the project did not get its chain');
    assert.strictEqual(chains[0].epub.path, 'source/The Exploded Book.working',
      'the manifest still names the archive');

    // `archive/` is never touched — not read for this, not written, not moved.
    assert.ok(fs.readFileSync(path.join(dir, 'archive', 'The Exploded Book.epub'))
      .equals(archiveOriginal), 'the archive original was written to');

    // And it is idempotent: a second run has nothing to do and says so.
    const again = await manifestService.migrateWorkingCopyContainer(dir, { apply: true });
    assert.strictEqual(again.outcome, 'already-exploded');
  });

test('a migration that cannot prove its copy leaves BOTH artifacts standing', async () => {
  const { dir } = await makeLegacyProject('migrate-refuses');
  const from = path.join(dir, 'source', 'The Exploded Book.working.epub');
  const to = path.join(dir, 'source', 'The Exploded Book.working');
  const bookBefore = fs.readFileSync(from);

  // Something is already at the destination — the shape an interrupted migration
  // leaves, and the one case where writing over it would destroy half of this
  // same book.
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'mimetype'), 'application/epub+zip');

  await assert.rejects(
    () => manifestService.migrateWorkingCopyContainer(dir, { apply: true }),
    (err) => /has both/.test(err.message) && /Nothing was migrated/.test(err.message),
    'a destination that is already there must be refused by name');

  assert.ok(fs.existsSync(from), 'the archive was removed by a refused migration');
  assert.ok(fs.readFileSync(from).equals(bookBefore), 'the archive was written to');
  assert.deepStrictEqual(fs.readdirSync(to), ['mimetype'],
    'the refused migration wrote into the folder it refused');
  assert.strictEqual(
    readManifest(dir).families[0].epub.path, 'source/The Exploded Book.working.epub',
    'the manifest was repointed by a refused migration');
});

test('a book with an entry this filesystem cannot hold is refused BY NAME, before anything moves',
  async () => {
    const dir = path.join(projectsDir, 'migrate-long-name');
    await writeEpub(path.join(dir, 'archive', 'The Exploded Book.epub'), ['one']);
    // 260 characters in ONE path component — over the 255 cap every Windows
    // filesystem imposes, and the failure it produces natively is ENOENT, which
    // reads as "the folder is missing".
    fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
    const long = `OEBPS/${'x'.repeat(260)}.xhtml`;
    const zip = new ZipWriter();
    zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
    zip.addFile('META-INF/container.xml', Buffer.from('<container/>', 'utf8'));
    zip.addFile(long, Buffer.from('<html/>', 'utf8'));
    await zip.write(path.join(dir, 'source', 'The Exploded Book.working.epub'));
    writeManifest(dir, {
      manifestVersion: 2,
      projectId: 'migrate-long-name',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      metadata: { title: 'The Exploded Book' },
      source: { type: 'epub', originalFilename: 'The Exploded Book.epub' },
      archive: [{ path: 'archive/The Exploded Book.epub', role: 'original', format: 'epub' }],
      outputs: { epub: { path: 'source/The Exploded Book.working.epub', modifiedAt: 'x' } },
    });

    // The DRY RUN catches it — which is the point of checking before exploding.
    await assert.rejects(
      () => manifestService.migrateWorkingCopyContainer(dir),
      (err) => /266-character path component/.test(err.message)
        && new RegExp('x{20}').test(err.message),
      'the refusal must name the entry and the length');
    assert.ok(!fs.existsSync(path.join(dir, 'source', 'The Exploded Book.working')),
      'the refused check wrote a folder anyway');
  });

test('a folder record in the archive is dropped, counted, and said out loud', async () => {
  const dir = path.join(projectsDir, 'migrate-dir-entries');
  await writeEpub(path.join(dir, 'archive', 'The Exploded Book.epub'), ['one']);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  // A publisher EPUB zipped by a tool that writes `EPUB/`-style folder records.
  // A tree cannot reproduce them and does not have to: they are zero bytes and
  // no reader in this app or in quire ever reads one.
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('OEBPS/', Buffer.alloc(0));
  zip.addFile('META-INF/container.xml', Buffer.from('<container/>', 'utf8'));
  zip.addFile('OEBPS/ch1.xhtml', Buffer.from('<html/>', 'utf8'));
  await zip.write(path.join(dir, 'source', 'The Exploded Book.working.epub'));
  writeManifest(dir, {
    manifestVersion: 2,
    projectId: 'migrate-dir-entries',
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Exploded Book' },
    source: { type: 'epub', originalFilename: 'The Exploded Book.epub' },
    archive: [{ path: 'archive/The Exploded Book.epub', role: 'original', format: 'epub' }],
    outputs: { epub: { path: 'source/The Exploded Book.working.epub', modifiedAt: 'x' } },
  });

  const report = await manifestService.migrateWorkingCopyContainer(dir, { apply: true });

  assert.strictEqual(report.outcome, 'exploded');
  assert.deepStrictEqual(report.directoryMarkersDropped, ['OEBPS/'],
    'the folder record was not reported');
  assert.strictEqual(report.entries, 3, 'the folder record was counted as a book entry');
  assert.deepStrictEqual(
    [...await bookEntryNames(path.join(dir, 'source', 'The Exploded Book.working'))].sort(),
    ['META-INF/container.xml', 'OEBPS/ch1.xhtml', 'mimetype']);
});

// ── 4. The re-stamp ──────────────────────────────────────────────────────────

test('a record that matched the archive comes out matching the FOLDER', async () => {
  const { dir, archived } = await makeLegacyProject('migrate-restamp');

  const report = await manifestService.migrateWorkingCopyContainer(dir, { apply: true });

  assert.deepStrictEqual([...report.restamped].sort(),
    ['narrationDeletions.epubSha256', 'ttsEpub.fromEpubSha256']);
  assert.deepStrictEqual(report.leftStale, []);

  const chain = readManifest(dir).families[0];
  const now = await bookDigestOf(path.join(dir, 'source', 'The Exploded Book.working'));

  // THE POINT: a consumer comparing its record to the book reads "the same
  // book", not "a different algorithm" and not "a changed book".
  assert.strictEqual(chain.epub.narrationDeletions.epubSha256, now,
    'the strikes still name the archive that is gone');
  assert.strictEqual(chain.ttsEpub.fromEpubSha256, now,
    'the narration copy would be re-cut for a book that did not change');
  assert.strictEqual(bookDigestAlgorithmChange(chain.epub.narrationDeletions.epubSha256, now), null,
    'the comparison still crosses an algorithm boundary');
  assert.notStrictEqual(archived, now, 'the fixture did not actually change how it is measured');
  assert.strictEqual(bookDigestAlgorithm(archived), 'sha256-file');
  assert.strictEqual(bookDigestAlgorithm(now), 'bookforge-epub-tree-v1');

  // And the app's own reader agrees the record is not stale.
  const deletions = await manifestService.readNarrationDeletions(dir);
  const { narrationDeletionsStaleReason } = require(
    path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));
  assert.strictEqual(narrationDeletionsStaleReason(deletions, now), null,
    'the strikes read as stale after a migration that changed nothing');
});

test('a record that was ALREADY stale is left exactly as stale as it was', async () => {
  const { dir } = await makeLegacyProject('migrate-stale', { staleStrikes: true });

  const report = await manifestService.migrateWorkingCopyContainer(dir, { apply: true });

  assert.deepStrictEqual(report.leftStale, ['narrationDeletions.epubSha256'],
    'an already-stale record was silently refreshed');
  assert.deepStrictEqual(report.restamped, ['ttsEpub.fromEpubSha256']);
  assert.strictEqual(
    readManifest(dir).families[0].epub.narrationDeletions.epubSha256, 'f'.repeat(64),
    'the migration re-stamped a record that did not describe the book');
});

// ── run ──────────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err && err.message}`);
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nexploded working copy: ${passed}/${tests.length} passed`);
  for (const f of failures) console.log(`  FAILED: ${f.name}\n${f.err && f.err.stack}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
