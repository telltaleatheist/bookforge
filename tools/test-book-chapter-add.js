#!/usr/bin/env node
/**
 * Tests for LISTING a chapter in a real project's book — `addBookChapter` in
 * electron/book-chapters.ts, and the gesture the picker performs around it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-chapter-add.js
 *
 * ── The dead end this exists for ────────────────────────────────────────────
 *
 * Owen, 2026-08-10, promoted a block to `chapter` in a document the book's table
 * of contents did not list. The app answered: "…is not listed under a name in
 * this book's table of contents… Rename the chapter to give it one" — and the
 * rename then refused, correctly, because a rename replaces an entry and there
 * was none. Every route out of that state ran into the same wall, so the book
 * kept a chapter opening it could not name and an audiobook built from it would
 * announce nothing at all.
 *
 * The pure edit — where the entry goes, in which lists, with which playOrder —
 * is covered by tools/test-book-chapter-titles.js against book files. THIS file
 * is about the PROJECT: the transaction, the records stamped with the book's
 * bytes, and the two halves of the picker's one gesture happening in the right
 * order.
 *
 * WHAT IS ASSERTED, and why each is a way the feature could be silently wrong:
 *
 * THE WHOLE GESTURE, because that is the fix: relabel a block to `chapter`,
 * give the chapter a name, and the contents gains the entry AND the opening on
 * the page prints it AND the answer names every file whose bytes moved — which
 * is what the window lays out again instead of re-opening the book.
 *
 * THE USER'S OPENER WINS, because a document can hold two candidates and the
 * naming pass writes into exactly one. The user's stamp has to outrank the
 * markup's derivation here as it does everywhere else, or the name would print
 * on a heading the user said was not the opening.
 *
 * THE RECORD, because a book edit nothing recorded is a book nobody can explain.
 * `add-chapter` is its own kind and not a rename with a blank "before".
 *
 * THE NARRATION COPY, both ways, because it is the file the audiobook is really
 * built from: a copy cut from THIS book gets the same entry, and one cut from
 * some other version is left alone and said out loud rather than quietly
 * agreeing with a book it was never made against.
 *
 * THE ONE REFUSAL, because an insert into a table of contents that is ITSELF a
 * spine document adds an element to a document narration strikes are keyed by
 * position in — and every strike after it would name a different paragraph.
 *
 * Every fixture is a real project under the OS temp directory. NOTHING in the
 * user's library is read or written.
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'book-chapters.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chapter-add-'));
// The manifest service resolves the library against the Electron userData dir,
// which does not exist outside the app. Point it at the temp tree BEFORE
// anything loads.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { ZipReader, ZipWriter, readEpubElementCategories } =
  require(path.join(DIST, 'electron', 'epub-processor.js'));
const { setBookBlockCategory } = require(path.join(DIST, 'electron', 'book-categories.js'));
const {
  addBookChapter, readBookChapterTitles, readChapterTitlesOfBook, renameBookChapter,
} = require(path.join(DIST, 'electron', 'book-chapters.js'));
const narrationExport = require(path.join(DIST, 'electron', 'narration-export.js'));

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
}

async function refuses(promise, ...fragments) {
  let message = null;
  try {
    await promise;
  } catch (err) {
    message = err.message;
  }
  assert.notStrictEqual(message, null, 'it did not refuse');
  for (const fragment of fragments) {
    assert.ok(
      message.includes(fragment),
      `the refusal does not say "${fragment}" — it says: ${message}`);
  }
  return message;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
  + '  <rootfiles>\n'
  + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
  + '  </rootfiles>\n</container>\n';

const PAGE = (title, body) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
  + `<head><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

/**
 * An EPUB 3 package. `spine` is the reading order; the nav document is in the
 * manifest and NOT in the spine, which is the ordinary shape — the one book
 * below that puts it in the spine does so on purpose.
 */
const OPF = (docs, navInSpine) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
  + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
  + '    <dc:identifier id="pub-id">urn:uuid:chapter-add</dc:identifier>\n'
  + '    <dc:title>The Unlisted</dc:title>\n    <dc:language>en</dc:language>\n'
  + '  </metadata>\n  <manifest>\n'
  + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
  + docs.map((d) => `    <item id="${d}" href="${d}.xhtml" media-type="application/xhtml+xml"/>\n`).join('')
  + '  </manifest>\n  <spine>\n'
  + (navInSpine ? '    <itemref idref="nav"/>\n' : '')
  + docs.map((d) => `    <itemref idref="${d}"/>\n`).join('')
  + '  </spine>\n</package>\n';

const NAV = (entries) => PAGE('Contents',
  '<nav epub:type="toc"><ol>\n'
  + entries.map(([href, label]) => `  <li><a href="${href}">${label}</a></li>\n`).join('')
  + '</ol></nav>');

/**
 * A `foundry vlm-convert` book whose SECOND document the navigation never
 * listed — the state this whole feature exists for. The document does not open
 * with a heading either (the split landed mid-page), so the element the user
 * promotes is the printed "II" in the middle of it.
 */
const CONVERTED = {
  'OEBPS/content.opf': OPF(['c0000', 'c0001'], false),
  'OEBPS/nav.xhtml': NAV([['c0000.xhtml', 'The Nazi Revolution']]),
  'OEBPS/c0000.xhtml': PAGE('The Nazi Revolution', [
    '<h1 data-bf-page="1" data-bf-cat="chapter">The Nazi Revolution</h1>',
    '<p data-bf-page="1" data-bf-cat="text">Hitler came to power in a country that had been '
    + 'governed by decree for three years.</p>',
  ].join('\n')),
  'OEBPS/c0001.xhtml': PAGE('Working Towards the Führer', [
    '<p data-bf-page="9" data-bf-cat="text">— and the party had learnt to read his silences '
    + 'as instructions, which is how the machine ran at all.</p>',
    '<h1 data-bf-page="9" data-bf-cat="title">II</h1>',
    '<p data-bf-page="9" data-bf-cat="text">Everyone works towards the leader along the lines he '
    + 'would wish.</p>',
  ].join('\n')),
};

/** The opener the USER designates, and the one the markup would have picked. */
const OPENER = 'OEBPS/c0001.xhtml#1';
const MARKUP_OPENER = 'OEBPS/c0001.xhtml#0';

/**
 * A book whose printed contents page IS its navigation document AND is read as
 * part of the book. Inserting an entry adds an element to a document narration
 * strikes are keyed by position in, which is the one shape the add refuses.
 */
const NAV_IN_SPINE = {
  'OEBPS/content.opf': OPF(['c0000', 'c0001'], true),
  'OEBPS/nav.xhtml': NAV([['c0000.xhtml', 'The Nazi Revolution']]),
  'OEBPS/c0000.xhtml': CONVERTED['OEBPS/c0000.xhtml'],
  'OEBPS/c0001.xhtml': CONVERTED['OEBPS/c0001.xhtml'],
};

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

/** The one working chain's book record. */
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

async function writeEpub(outPath, files) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'), true);
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'), true);
  }
  await zip.write(outPath);
  return outPath;
}

const projectsDir = path.join(ROOT, 'projects');
manifestService.setLibraryBasePath(ROOT);

async function makeProject(id, files = CONVERTED) {
  const dir = path.join(projectsDir, id);
  await writeEpub(path.join(dir, 'archive', 'The Unlisted.epub'), files);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-10T00:00:00.000Z',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    metadata: { title: 'The Unlisted' },
    source: { type: 'epub', originalFilename: 'The Unlisted.epub' },
    archive: [{ path: 'archive/The Unlisted.epub', role: 'original', format: 'epub' }],
    outputs: {},
  }, null, 2));
  await manifestService.ensureBookEpub(dir);
  return dir;
}

/** What one document of the project's book reads as. */
async function documentText(bookPath, entry) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    return (await reader.readEntry(entry)).toString('utf8');
  } finally {
    reader.close();
  }
}

const bookOf = async (dir) => (await manifestService.readExportEpub(dir)).absPath;

/** The entries of the book's table of contents, as (document, title) pairs. */
async function contentsOf(dir) {
  const titles = await readChapterTitlesOfBook(await bookOf(dir));
  return titles.chapters.map((c) => [c.file, c.navTitle]);
}

// ── The tests ───────────────────────────────────────────────────────────────

async function run() {
  // ── The whole gesture ───────────────────────────────────────────────────
  await check('relabel then name: the contents gains the chapter and the page prints it', async () => {
    const dir = await makeProject('gesture');
    const before = await readBookChapterTitles(dir);
    assert.deepStrictEqual(before.unlistedDocuments, ['OEBPS/c0001.xhtml'],
      'the fixture is not the state this feature exists for');

    // Half one: the block becomes the document's chapter opening.
    const relabel = await setBookBlockCategory(dir, OPENER, 'chapter');
    assert.strictEqual(relabel.written, true, 'the relabel wrote nothing');
    assert.strictEqual(relabel.file, 'OEBPS/c0001.xhtml');

    // Half two: the document is LISTED under a name — the operation that did
    // not exist, and the one the app's own advice was describing.
    const added = await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Working Towards the Führer');
    assert.strictEqual(added.title, 'Working Towards the Führer');
    assert.deepStrictEqual(added.rewrittenTocs, ['OEBPS/nav.xhtml']);

    assert.deepStrictEqual(await contentsOf(dir), [
      ['OEBPS/c0000.xhtml', 'The Nazi Revolution'],
      ['OEBPS/c0001.xhtml', 'Working Towards the Führer'],
    ]);
    assert.deepStrictEqual((await readBookChapterTitles(dir)).unlistedDocuments, []);

    // The page followed: the naming pass is part of the add, not a step the
    // caller has to remember.
    assert.strictEqual(added.openingUnnamed, null,
      `the opening was not named: ${added.openingUnnamed}`);
    assert.ok(added.openingsNamed >= 1, 'no opening was named at all');
    const xhtml = await documentText(await bookOf(dir), 'OEBPS/c0001.xhtml');
    assert.ok(
      xhtml.includes('>Working Towards the Führer</h1>'),
      `the heading on the page does not read the chapter's name:\n${xhtml}`);

    // And main names EVERY file whose bytes moved, which is what the window
    // lays out again instead of re-opening the book.
    assert.deepStrictEqual([...added.rewrittenEntries].sort(),
      ['OEBPS/c0001.xhtml', 'OEBPS/nav.xhtml']);
  });

  // ── The user's opener outranks the markup's ─────────────────────────────
  await check('the name is written into the element the USER called the opening', async () => {
    const dir = await makeProject('designated-opener');
    await setBookBlockCategory(dir, OPENER, 'chapter');
    await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Working Towards the Führer');

    const reading = await readEpubElementCategories(await bookOf(dir));
    assert.strictEqual(reading.categoryByElement.get(OPENER), 'chapter');
    // The document holds ONE opening. The paragraph above it — which is what a
    // navigation-label reading would otherwise fold into an opener now that the
    // document is listed — is not a second one.
    assert.notStrictEqual(reading.categoryByElement.get(MARKUP_OPENER), 'chapter',
      'the document now holds two chapter openings');

    const xhtml = await documentText(await bookOf(dir), 'OEBPS/c0001.xhtml');
    assert.ok(xhtml.includes('>Working Towards the Führer</h1>'),
      'the name was not written into the element the user designated');
    assert.ok(
      xhtml.includes('and the party had learnt to read his silences'),
      'the name was written over the paragraph above the opening');
  });

  // ── The record ──────────────────────────────────────────────────────────
  await check('the manifest records the add as its own kind of edit', async () => {
    const dir = await makeProject('record');
    const bookPath = await bookOf(dir);
    const before = sha256(bookPath);
    const added = await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two');

    const edits = bookRecordOf(dir).bookEdits ?? [];
    const record = edits.find((e) => e.kind === 'add-chapter');
    assert.ok(record, `no add-chapter edit was recorded — got ${edits.map((e) => e.kind).join(', ')}`);
    assert.strictEqual(record.file, 'OEBPS/c0001.xhtml');
    assert.strictEqual(record.title, 'Chapter Two');
    assert.deepStrictEqual(record.tocFiles, ['OEBPS/nav.xhtml']);
    assert.strictEqual(record.fromSha256, before);
    // The add's own `toSha256` is the book as the ADD left it; the naming pass
    // that runs after it writes again and records its own entry, so the book on
    // disk is the LAST record's `toSha256` and not this one's.
    assert.strictEqual(record.toSha256, added.bookSha256);
    assert.strictEqual(sha256(bookPath), edits[edits.length - 1].toSha256,
      'the last recorded edit does not describe the book on disk');
    // Not a rename with a blank before: the history has to say which happened.
    assert.strictEqual(record.titleBefore, undefined);
  });

  await check('the strikes are re-stamped onto the book the add wrote', async () => {
    const dir = await makeProject('restamp');
    const struck = await narrationExport.editNarrationDeletions(
      dir, { strike: ['OEBPS/c0000.xhtml#1'], unstrike: [] });
    assert.deepStrictEqual(struck.elements, ['OEBPS/c0000.xhtml#1']);

    await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two');

    const carried = await manifestService.readNarrationDeletions(dir);
    assert.ok(carried, 'THE FAILURE: the strikes were cleared by an add that moved no element');
    assert.deepStrictEqual(carried.elements, ['OEBPS/c0000.xhtml#1'], 'a strike was dropped');
    assert.strictEqual(carried.epubSha256, sha256(await bookOf(dir)),
      'the record was not re-stamped onto the book on disk');
  });

  // ── The narration copy, both ways ────────────────────────────────────────
  await check('a narration copy cut from THIS book gains the entry too', async () => {
    const dir = await makeProject('copy-current');
    await narrationExport.editNarrationDeletions(
      dir, { strike: ['OEBPS/c0000.xhtml#1'], unstrike: [] });
    const written = await narrationExport.exportNarrationEpub(dir);
    assert.ok(written.removedElements >= 1, 'the copy was cut by no strike at all');

    const added = await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two');
    assert.strictEqual(added.narrationCopy, 'updated');

    const copy = await manifestService.readNarrationEpub(dir);
    const copyTitles = await readChapterTitlesOfBook(copy.absPath);
    assert.ok(
      copyTitles.chapters.some((c) => c.file === 'OEBPS/c0001.xhtml' && c.navTitle === 'Chapter Two'),
      `the narration copy does not list the new chapter: ${JSON.stringify(copyTitles.chapters)}`);
    // And the record follows the book rather than declaring the copy stale over
    // an edit the copy also received.
    const record = await manifestService.readNarrationEpubRecord(dir);
    assert.strictEqual(record.fromEpubSha256, added.bookSha256);
  });

  await check('a narration copy cut from ANOTHER version is left alone, and said so', async () => {
    const dir = await makeProject('copy-stale');
    await narrationExport.exportNarrationEpub(dir);
    // The book moves under the copy: a relabel is enough, and it is exactly what
    // the picker does immediately before naming an unlisted chapter.
    await setBookBlockCategory(dir, OPENER, 'chapter');

    const added = await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two');
    assert.strictEqual(added.narrationCopy, 'already-stale');

    const copy = await manifestService.readNarrationEpub(dir);
    const copyTitles = await readChapterTitlesOfBook(copy.absPath);
    assert.ok(
      !copyTitles.chapters.some((c) => c.file === 'OEBPS/c0001.xhtml'),
      'a copy cut from a different book was edited anyway');
  });

  // ── The one refusal ─────────────────────────────────────────────────────
  await check('a strike in a contents page the book READS refuses the add by name', async () => {
    const dir = await makeProject('nav-in-spine', NAV_IN_SPINE);
    await narrationExport.editNarrationDeletions(
      dir, { strike: ['OEBPS/nav.xhtml#1'], unstrike: [] });
    const before = sha256(await bookOf(dir));

    await refuses(
      addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two'),
      'OEBPS/nav.xhtml is both a table of contents and a document this book reads',
      'every strike after it would name a different paragraph');
    assert.strictEqual(sha256(await bookOf(dir)), before, 'a refused add wrote the book anyway');

    // The SAME book with nothing struck takes the add: the refusal is about the
    // record, not about the shape of the book.
    const clean = await makeProject('nav-in-spine-clean', NAV_IN_SPINE);
    const added = await addBookChapter(clean, 'OEBPS/c0001.xhtml', 'Chapter Two');
    assert.ok(added.rewrittenEntries.includes('OEBPS/nav.xhtml'));
  });

  // ── Round trip ──────────────────────────────────────────────────────────
  await check('a chapter that was added can then be renamed in the project', async () => {
    const dir = await makeProject('round-trip');
    await addBookChapter(dir, 'OEBPS/c0001.xhtml', 'Chapter Two');
    const renamed = await renameBookChapter(dir, 'OEBPS/c0001.xhtml', 'Two: Towards the Leader');
    assert.strictEqual(renamed.previousTitle, 'Chapter Two');
    assert.deepStrictEqual(await contentsOf(dir), [
      ['OEBPS/c0000.xhtml', 'The Nazi Revolution'],
      ['OEBPS/c0001.xhtml', 'Two: Towards the Leader'],
    ]);
  });

  await check('a document the book already lists is refused at the project door too', async () => {
    const dir = await makeProject('already-listed');
    const before = sha256(await bookOf(dir));
    await refuses(
      addBookChapter(dir, 'OEBPS/c0000.xhtml', 'Something Else'),
      'already calls it "The Nazi Revolution"',
      'Rename the chapter instead');
    assert.strictEqual(sha256(await bookOf(dir)), before, 'a refused add wrote the book anyway');
  });

  for (const [status, name, detail] of results) {
    console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
  const passed = results.filter(([s]) => s === 'ok').length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
