/**
 * Tests for the chapter-heading INSERT — `insertChapterHeadingInBookFile` /
 * `removeInsertedHeadingFromBookFile` in electron/epub-processor.ts, the
 * project wrappers in electron/book-headings.ts, and the strike-record carry
 * that makes the edit safe (shared/vlm/narration-deletions.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chapter-heading-insert.js
 *
 * ── The book this exists for ────────────────────────────────────────────────
 *
 * Owen, 2026-08-12: "theres a book that lost the chapter headers but kept the
 * body text. i have ot insert chapter headers in where they belong for this
 * book." No relabel can answer that — there is no element to promote — so the
 * heading is ADDED, and that makes this the one deliberate edit that changes
 * the enumeration: every text unit after the insertion point is one index
 * further on, and every narration strike keyed past it must be carried `+1`
 * (and `-1` back on undo), fingerprints travelling with their keys.
 *
 * ── What is worth a test ───────────────────────────────────────────────────
 *
 * THE SHIFT, measured exactly: every element after the insertion point at
 * index+1 with unchanged text and tag, everything before untouched, no picture
 * moved. That arithmetic is what the record carry rests on, so it is the
 * whole claim.
 *
 * THE CARRY, end to end through the real project door: strikes recorded before
 * the insert still name their elements after it — the key before the insertion
 * unchanged, the key at/after carried +1, the fingerprint still describing the
 * words at its new key — and the inverse removal carries them back.
 *
 * THE REFUSALS, because every alternative is silent damage: a publisher book
 * (an invented <h1> is a guess about markup we did not write), a strike that
 * cannot be carried (refuses the WHOLE insert before any byte — never a
 * dropped strike), a strike ON the heading being removed (unstrike first), and
 * a remover that must not be a general delete-element.
 *
 * THE FAILURE ARM, fault-injected in the same style as the relabel suite — and
 * mutation-guarded the same way that suite's history demanded: the injection
 * fires only once the written book provably carries the edit, so the restore
 * assertion cannot pass over a book that was never written.
 *
 * Everything is written to a temp directory; nothing here touches the library.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'epub-processor.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-heading-insert-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  ZipReader, ZipWriter,
  insertChapterHeadingInBookFile,
  removeInsertedHeadingFromBookFile,
  readEpubElementCategories,
  nameChapterOpeningsInBookFile,
  USER_CATEGORY_ATTR,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
// The container seam, held so the failure-arm tests can make the verification's
// read of the WRITTEN book fail — the only way in from outside to the restore.
const epubContainer = require(path.join(DIST, 'electron', 'epub-container.js'));
const {
  migrateNarrationDeletionsForHeadingInsert,
  migrateNarrationDeletionsForHeadingRemoval,
  narrationDeletionsStaleReason,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));
const { narrationDocumentShapes, narrationFingerprintsOfBook } =
  require(path.join(DIST, 'electron', 'quire-stamp.js'));
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const narrationExport = require(path.join(DIST, 'electron', 'narration-export.js'));
const { insertBookChapterHeading, removeBookInsertedHeading } =
  require(path.join(DIST, 'electron', 'book-headings.js'));
const { bookDigestOf } = require('./fixture-book');

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

const PAGE = (title, bodyMarkup) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
  + `<head><title>${title}</title></head>\n<body>\n${bodyMarkup}\n</body>\n</html>\n`;

const OPF3 = (docs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
  + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
  + `    <dc:identifier id="pub-id">urn:uuid:${path.basename(ROOT)}</dc:identifier>\n`
  + '    <dc:title>A Book</dc:title>\n    <dc:language>en</dc:language>\n'
  + '  </metadata>\n  <manifest>\n'
  + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
  + '    <item id="plate" href="plate.png" media-type="image/png"/>\n'
  + docs.map((d) => `    <item id="${d}" href="${d}.xhtml" media-type="application/xhtml+xml"/>\n`).join('')
  + '  </manifest>\n  <spine>\n'
  + docs.map((d) => `    <itemref idref="${d}"/>\n`).join('')
  + '  </spine>\n</package>\n';

const NAV = (entries) => PAGE('Contents',
  '<nav epub:type="toc"><ol>\n'
  + entries.map(([href, label]) => `<li><a href="${href}">${label}</a></li>\n`).join('')
  + '</ol></nav>');

/** A one-pixel PNG, so a picture element has something real behind it. */
const PLATE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function writeEpubAt(target, files) {
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'), true);
  zip.addFile('OEBPS/plate.png', PLATE, true);
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), true);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await zip.write(target);
  return target;
}

const writeEpub = (name, files) => writeEpubAt(path.join(ROOT, name), files);

/**
 * THE BOOK OWEN HAS: a `foundry vlm-convert` conversion whose pages carried no
 * chapter headings — the body text is all there, stamped, and nothing in
 * `c0001` says `chapter`. The "II" h1 is stamped `title`, which is what a
 * heading looks like when the split heuristics could not call it a chapter.
 */
function convertedBook(name = 'converted.epub') {
  return writeEpub(name, {
    'OEBPS/content.opf': OPF3(['c0000', 'c0001']),
    'OEBPS/nav.xhtml': NAV([
      ['c0000.xhtml', 'The Nazi Revolution'],
      ['c0001.xhtml', 'Working Towards the Führer'],
    ]),
    'OEBPS/c0000.xhtml': PAGE('The Nazi Revolution', [
      '<h1 data-bf-page="1" data-bf-cat="chapter">The Nazi Revolution</h1>',
      '<p data-bf-page="1" data-bf-cat="text">Hitler came to power in a country that had been '
      + 'governed by decree for three years.</p>',
    ].join('\n')),
    'OEBPS/c0001.xhtml': PAGE('Working Towards the Führer', [
      '<p data-bf-page="9" data-bf-cat="text">— and the party had learnt to read his silences as '
      + 'instructions, which is how the machine ran at all.</p>',
      '<h1 data-bf-page="9" data-bf-cat="title">II</h1>',
      '<p data-bf-page="9" data-bf-cat="text">Everyone works towards the leader along the lines he '
      + 'would wish.</p>',
      '<div class="image" data-bf-page="10" data-bf-cat="picture"><img src="plate.png" alt="a plate"/></div>',
    ].join('\n')),
  });
}

/** A converted book with ONE element carrying no stamp at all. */
function convertedBookWithUnstamped() {
  return writeEpub('converted-unstamped.epub', {
    'OEBPS/content.opf': OPF3(['u0001']),
    'OEBPS/nav.xhtml': NAV([['u0001.xhtml', 'The Gap']]),
    'OEBPS/u0001.xhtml': PAGE('The Gap', [
      '<p data-bf-page="3" data-bf-cat="text">A stamped paragraph, like all the others.</p>',
      '<p>A paragraph somebody added by hand, with no stamp anywhere above it.</p>',
    ].join('\n')),
  });
}

/** A PUBLISHER's book: no stamp of ours anywhere. */
function publisherBook() {
  return writeEpub('publisher.epub', {
    'OEBPS/content.opf': OPF3(['p0001']),
    'OEBPS/nav.xhtml': NAV([['p0001.xhtml', 'Chapter 1: Killing America']]),
    'OEBPS/p0001.xhtml': PAGE('Chapter 1', [
      '<p class="cn">Chapter 1</p>',
      '<p class="ct">Killing America</p>',
      '<p>The country had been arguing about the same four things for thirty years.</p>',
    ].join('\n')),
  });
}

/** Every zip entry of a book, as bytes, for a surgical-edit diff. */
async function entriesOf(bookPath) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    const out = new Map();
    for (const entry of reader.getEntries()) out.set(entry, await reader.readEntry(entry));
    return out;
  } finally {
    reader.close();
  }
}

/** What one document of a book reads as. */
async function documentText(bookPath, entry) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    return (await reader.readEntry(entry)).toString('utf8');
  } finally {
    reader.close();
  }
}

/** key → {tag, text} for the whole book, off the one reading everything uses. */
async function factsByKey(bookPath) {
  const reading = await readEpubElementCategories(bookPath);
  const out = new Map();
  for (const e of reading.elements) {
    out.set(e.key, {
      tag: e.tag, kind: e.kind,
      category: reading.categoryByElement.get(e.key) ?? '(none)',
    });
  }
  return out;
}

// ── The project fixture, for the record carry through the real door ─────────

const projectsDir = path.join(ROOT, 'projects');
manifestService.setLibraryBasePath(ROOT);

/** A stamped two-chapter book — the shape a conversion leaves. */
const PROJECT_FILES = {
  'OEBPS/content.opf': OPF3(['ch1', 'ch2']),
  'OEBPS/nav.xhtml': NAV([
    ['ch1.xhtml', 'Chapter 1'],
    ['ch2.xhtml', 'Chapter 2'],
  ]),
  'OEBPS/ch1.xhtml': PAGE('Chapter 1', [
    '<p data-bf-page="1" data-bf-cat="text">It was 1998, and the machine hummed in the corner of '
    + 'the room.</p>',
    '<p data-bf-page="1" data-bf-cat="text">She counted twelve of them before the lights went '
    + 'out.</p>',
    '<p data-bf-page="2" data-bf-cat="text">The third door was open, and nobody could say who had '
    + 'opened it.</p>',
  ].join('\n')),
  'OEBPS/ch2.xhtml': PAGE('Chapter 2', [
    '<p data-bf-page="3" data-bf-cat="text">Nobody had been through it, which was the part that '
    + 'troubled him.</p>',
    '<p data-bf-page="3" data-bf-cat="text">And that was the end of the matter for eleven '
    + 'years.</p>',
  ].join('\n')),
};

async function makeProject(id) {
  const dir = path.join(projectsDir, id);
  await writeEpubAt(path.join(dir, 'archive', 'The Insert.epub'), PROJECT_FILES);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Insert' },
    source: { type: 'epub', originalFilename: 'The Insert.epub' },
    archive: [{ path: 'archive/The Insert.epub', role: 'original', format: 'epub' }],
    outputs: {},
  }, null, 2));
  await manifestService.ensureBookEpub(dir);
  return dir;
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

/** The strikes every carry test starts from: one after the insertion point, one elsewhere. */
const STRIKES = ['OEBPS/ch1.xhtml#1', 'OEBPS/ch2.xhtml#0'];

// ── The tests ───────────────────────────────────────────────────────────────

async function run() {
  // ── The shift, measured exactly ────────────────────────────────────────
  await check('inserting before a middle element shifts everything after it by one', async () => {
    const book = await convertedBook();
    const before = await factsByKey(book);
    const out = path.join(ROOT, 'inserted-middle.epub');
    const result = await insertChapterHeadingInBookFile(
      book, out, 'OEBPS/c0001.xhtml#1', 'Chapter II: Working Towards the Führer');

    assert.strictEqual(result.file, 'OEBPS/c0001.xhtml');
    assert.strictEqual(result.insertedKey, 'OEBPS/c0001.xhtml#1');
    assert.strictEqual(result.title, 'Chapter II: Working Towards the Führer');
    assert.strictEqual(result.sourcePage, 9, 'the heading did not take its neighbour\'s page');
    assert.strictEqual(result.unitsBefore, 4);
    assert.strictEqual(result.unitsAfter, 5);

    // The heading carries BOTH stamps — the conversion stamp every reader of a
    // converted book actually reads, and the user attribute where user
    // statements live — with the neighbour's page between them.
    const xhtml = await documentText(out, 'OEBPS/c0001.xhtml');
    assert.ok(
      xhtml.includes('<h1 data-bf-cat="chapter" data-bf-page="9" '
        + `${USER_CATEGORY_ATTR}="chapter">Chapter II: Working Towards the Führer</h1>`),
      `the inserted heading is not the element the insert promises: ${xhtml}`);

    // The book reads the new element as `chapter`, and EVERY element that was
    // at or after the insertion point still answers — tag, kind and category —
    // at exactly index+1. Everything before it is where it was.
    const after = await factsByKey(out);
    assert.strictEqual(after.get('OEBPS/c0001.xhtml#1').category, 'chapter');
    assert.deepStrictEqual(after.get('OEBPS/c0001.xhtml#0'), before.get('OEBPS/c0001.xhtml#0'));
    assert.deepStrictEqual(after.get('OEBPS/c0001.xhtml#2'), before.get('OEBPS/c0001.xhtml#1'),
      'the displaced element did not slide to index+1');
    assert.deepStrictEqual(after.get('OEBPS/c0001.xhtml#3'), before.get('OEBPS/c0001.xhtml#2'));
    assert.deepStrictEqual(after.get('OEBPS/c0001.xhtml#4'), before.get('OEBPS/c0001.xhtml#3'));
    // The picture's ordinal namespace is untouched, and so is the other document.
    assert.deepStrictEqual(after.get('OEBPS/c0001.xhtml#img0'), before.get('OEBPS/c0001.xhtml#img0'));
    assert.deepStrictEqual(after.get('OEBPS/c0000.xhtml#0'), before.get('OEBPS/c0000.xhtml#0'));
  });

  await check('inserting before the FIRST element takes index 0', async () => {
    const book = await convertedBook('converted-first.epub');
    const out = path.join(ROOT, 'inserted-first.epub');
    const result = await insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#0', 'Two');
    assert.strictEqual(result.insertedKey, 'OEBPS/c0001.xhtml#0');
    const after = await factsByKey(out);
    assert.strictEqual(after.get('OEBPS/c0001.xhtml#0').category, 'chapter');
    assert.strictEqual(after.get('OEBPS/c0001.xhtml#0').tag, 'h1');
    assert.strictEqual(after.get('OEBPS/c0001.xhtml#1').category, 'body',
      'the old first element did not slide to #1');
  });

  await check('the title is escaped by the serializer, never trusted as markup', async () => {
    const book = await convertedBook('converted-escape.epub');
    const out = path.join(ROOT, 'inserted-escape.epub');
    const result = await insertChapterHeadingInBookFile(
      book, out, 'OEBPS/c0001.xhtml#1', 'Fire & Sword <II>');
    assert.strictEqual(result.title, 'Fire & Sword <II>');
    const xhtml = await documentText(out, 'OEBPS/c0001.xhtml');
    assert.ok(xhtml.includes('Fire &amp; Sword &lt;II'),
      `the title was not escaped: ${xhtml}`);
    assert.ok(!xhtml.includes('Fire & Sword <II>'),
      'the raw title reached the markup unescaped');
  });

  await check('only the one document changes, byte for byte', async () => {
    const book = await convertedBook('converted-surgical.epub');
    const out = path.join(ROOT, 'inserted-surgical.epub');
    await insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#1', 'Two');
    const before = await entriesOf(book);
    const after = await entriesOf(out);
    assert.deepStrictEqual([...after.keys()], [...before.keys()], 'the zip entries changed');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, ['OEBPS/c0001.xhtml'],
      `entries other than the inserted-into document changed: ${changed.join(', ')}`);
  });

  // ── The refusals ───────────────────────────────────────────────────────
  await check('a publisher book refuses whole — an invented h1 would be a guess', async () => {
    const book = await publisherBook();
    const before = await entriesOf(book);
    const out = path.join(ROOT, 'publisher-inserted.epub');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/p0001.xhtml#2', 'Chapter 1'),
      'carries no conversion stamps',
      'edited by hand',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false, 'a book was written for a refused insert');
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [], 'the refused insert changed the book it read');
  });

  await check('every bad key and bad title refuses by name, before any byte', async () => {
    const book = await convertedBook('converted-refusals.epub');
    const before = await entriesOf(book);
    const out = path.join(ROOT, 'refused-insert.epub');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#1', '   '),
      'empty title', 'Nothing was written.');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#img0', 'Two'),
      'names a picture', 'Nothing was written.');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#doc', 'Two'),
      'names a whole document', 'Nothing was written.');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#94', 'Two'),
      'holds 4 text element(s), so OEBPS/c0001.xhtml#94 names nothing in it',
      'Nothing was written.');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/c0099.xhtml#0', 'Two'),
      'has no spine document OEBPS/c0099.xhtml', 'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [], 'a refused insert changed the book');
  });

  await check('an anchor with no conversion stamp refuses — no page to stamp with', async () => {
    const book = await convertedBookWithUnstamped();
    const out = path.join(ROOT, 'refused-unstamped.epub');
    await refuses(
      insertChapterHeadingInBookFile(book, out, 'OEBPS/u0001.xhtml#1', 'The Gap'),
      'carries no conversion stamp, so there is no page number',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
  });

  // ── What the insert exists to feed ─────────────────────────────────────
  await check('the naming pass finds the invented heading and writes the name into it', async () => {
    const book = await convertedBook('converted-for-naming.epub');
    const inserted = path.join(ROOT, 'inserted-for-naming.epub');
    await insertChapterHeadingInBookFile(book, inserted, 'OEBPS/c0001.xhtml#0', 'II');
    const named = await nameChapterOpeningsInBookFile(
      inserted, path.join(ROOT, 'named-after-insert.epub'),
      new Map([['OEBPS/c0001.xhtml', 'Working Towards the Führer']]));
    assert.strictEqual(named.edits.length, 1,
      `the pass did not name the invented heading — skipped: ${JSON.stringify(named.skipped)}`);
    assert.strictEqual(named.edits[0].openerKey, 'OEBPS/c0001.xhtml#0');
    assert.strictEqual(named.edits[0].textBefore, 'II');
    assert.strictEqual(named.edits[0].textAfter, 'Working Towards the Führer');
  });

  // ── The inverse ────────────────────────────────────────────────────────
  await check('remove restores the enumeration and the text, exactly', async () => {
    const book = await convertedBook('converted-roundtrip.epub');
    const before = await factsByKey(book);
    const shapesBefore = await narrationDocumentShapes(book, 'roundtrip');
    const inserted = path.join(ROOT, 'roundtrip-inserted.epub');
    await insertChapterHeadingInBookFile(book, inserted, 'OEBPS/c0001.xhtml#1', 'Two');
    const removed = path.join(ROOT, 'roundtrip-removed.epub');
    const result = await removeInsertedHeadingFromBookFile(
      inserted, removed, 'OEBPS/c0001.xhtml#1');
    assert.strictEqual(result.textBefore, 'Two');
    assert.strictEqual(result.unitsBefore, 5);
    assert.strictEqual(result.unitsAfter, 4);
    assert.deepStrictEqual(await factsByKey(removed), before,
      'the removal did not restore what every key answers');
    assert.deepStrictEqual(await narrationDocumentShapes(removed, 'roundtrip'), shapesBefore,
      'the removal did not restore the enumeration');
  });

  await check('remove refuses everything that is not the shape the insert writes', async () => {
    const book = await convertedBook('converted-remove-refusals.epub');
    const out = path.join(ROOT, 'refused-remove.epub');
    // A body paragraph: not a heading, not chapter — a general delete-element
    // is exactly what this must not be.
    await refuses(
      removeInsertedHeadingFromBookFile(book, out, 'OEBPS/c0001.xhtml#0'),
      'is a <p> the book calls "body", not a chapter heading',
      'Nothing was written.');
    // A real heading the book calls `title`: still not the insert's shape.
    await refuses(
      removeInsertedHeadingFromBookFile(book, out, 'OEBPS/c0001.xhtml#1'),
      'is a <h1> the book calls "title", not a chapter heading',
      'Nothing was written.');
    await refuses(
      removeInsertedHeadingFromBookFile(book, out, 'OEBPS/c0001.xhtml#img0'),
      'names a picture', 'Nothing was written.');
    await refuses(
      removeInsertedHeadingFromBookFile(await publisherBook(), out, 'OEBPS/p0001.xhtml#0'),
      'carries no conversion stamps', 'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
  });

  // ── The failure arm, fault-injected at the seam ────────────────────────
  await check('an in-place insert that fails verification puts the document back', async () => {
    const source = await convertedBook('converted-restore-source.epub');
    const inPlace = path.join(ROOT, 'insert-restore.epub');
    fs.copyFileSync(source, inPlace);
    const before = await entriesOf(inPlace);

    // Fired on the first open of a book that ALREADY carries the heading —
    // which is precisely the verification's read, and never one of the reads
    // before the write. The fixture provably lacks the marker (asserted), so
    // this cannot fire over an unwritten book — the mutation the relabel
    // suite's history warned about. One-shot, so the restore's own write can
    // still open the book.
    const MARKER = '>An Injected Heading</h1>';
    assert.ok(!(await documentText(inPlace, 'OEBPS/c0001.xhtml')).includes(MARKER),
      'the fixture already carries the marker, so this test could not tell a write from a read');
    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      if (!failedTheVerification && path.resolve(p) === path.resolve(inPlace)
        && (await documentText(inPlace, 'OEBPS/c0001.xhtml')).includes(MARKER)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await insertChapterHeadingInBookFile(
        inPlace, inPlace, 'OEBPS/c0001.xhtml#1', 'An Injected Heading');
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the insert did not refuse when its verification failed');
    assert.ok(message.includes('could not be read back'),
      `the refusal is not the one the verification raised: ${message}`);
    // The whole point: the edit HAD landed on disk, so the restore below
    // proves it was taken back and not merely that it never happened.
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a written book, so nothing was restored');

    const after = await entriesOf(inPlace);
    assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(),
      'the restore changed which entries the book has');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `the restore left ${changed.length} document(s) edited: ${changed.join(', ')}`);
  });

  await check('a staged insert that fails verification destroys the staged book only', async () => {
    const book = await convertedBook('converted-staged-fail.epub');
    const out = path.join(ROOT, 'insert-staged-fail.epub');
    const before = await entriesOf(book);

    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      if (path.resolve(p) === path.resolve(out) && fs.existsSync(out)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await insertChapterHeadingInBookFile(book, out, 'OEBPS/c0001.xhtml#1', 'Two');
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the staged insert did not refuse');
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a staged book, so nothing was destroyed');
    assert.strictEqual(fs.existsSync(out), false, 'the staged book survived its own refusal');
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [], 'a staged refusal changed the source book');
  });

  await check('an in-place removal that fails verification puts the document back', async () => {
    const source = await convertedBook('converted-remove-restore-src.epub');
    const inPlace = path.join(ROOT, 'remove-restore.epub');
    await insertChapterHeadingInBookFile(
      source, inPlace, 'OEBPS/c0001.xhtml#1', 'An Injected Heading');
    const before = await entriesOf(inPlace);
    const MARKER = '>An Injected Heading</h1>';

    // The inverse mark: the removal is proven written when the marker is GONE.
    assert.ok((await documentText(inPlace, 'OEBPS/c0001.xhtml')).includes(MARKER),
      'the fixture does not carry the heading, so this test could not tell a write from a read');
    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      if (!failedTheVerification && path.resolve(p) === path.resolve(inPlace)
        && !(await documentText(inPlace, 'OEBPS/c0001.xhtml')).includes(MARKER)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await removeInsertedHeadingFromBookFile(inPlace, inPlace, 'OEBPS/c0001.xhtml#1');
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the removal did not refuse when its verification failed');
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a written book, so nothing was restored');
    const after = await entriesOf(inPlace);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `the restore left ${changed.length} document(s) edited: ${changed.join(', ')}`);
  });

  // ── The carry arithmetic, held on its own ──────────────────────────────
  await check('the insert carry: +1 at and after, everything else untouched, prints travel', async () => {
    const record = {
      elements: [
        'OEBPS/a.xhtml#0', 'OEBPS/a.xhtml#2', 'OEBPS/a.xhtml#5',
        'OEBPS/a.xhtml#img1', 'OEBPS/a.xhtml#doc', 'OEBPS/b.xhtml#2',
      ],
      fingerprints: {
        'OEBPS/a.xhtml#0': 'the first paragraph',
        'OEBPS/a.xhtml#2': 'the third paragraph',
        'OEBPS/a.xhtml#5': 'the sixth paragraph',
        'OEBPS/b.xhtml#2': 'a paragraph of another file',
      },
    };
    const carried = migrateNarrationDeletionsForHeadingInsert(record, 'OEBPS/a.xhtml', 2, 6);
    assert.deepStrictEqual(carried.elements, [
      'OEBPS/a.xhtml#0', 'OEBPS/a.xhtml#3', 'OEBPS/a.xhtml#6',
      'OEBPS/a.xhtml#doc', 'OEBPS/a.xhtml#img1', 'OEBPS/b.xhtml#2',
    ].sort());
    assert.strictEqual(carried.renumbered, 2);
    assert.deepStrictEqual(carried.fingerprints, {
      'OEBPS/a.xhtml#0': 'the first paragraph',
      'OEBPS/a.xhtml#3': 'the third paragraph',
      'OEBPS/a.xhtml#6': 'the sixth paragraph',
      'OEBPS/b.xhtml#2': 'a paragraph of another file',
    }, 'a fingerprint did not travel with its key');
    // A record with no fingerprints stays that way — never invented.
    const bare = migrateNarrationDeletionsForHeadingInsert(
      { elements: ['OEBPS/a.xhtml#3'] }, 'OEBPS/a.xhtml', 2, 6);
    assert.strictEqual(bare.fingerprints, undefined);
  });

  await check('a strike that cannot be carried refuses the carry outright', async () => {
    await refuses(
      Promise.resolve().then(() => migrateNarrationDeletionsForHeadingInsert(
        { elements: ['OEBPS/a.xhtml#9'] }, 'OEBPS/a.xhtml', 0, 6)),
      'OEBPS/a.xhtml#9 is struck for narration but OEBPS/a.xhtml holds only 6 text element(s)',
      'Nothing was written.');
  });

  await check('the removal carry: -1 after, and a strike ON the heading refuses', async () => {
    const carried = migrateNarrationDeletionsForHeadingRemoval(
      { elements: ['OEBPS/a.xhtml#0', 'OEBPS/a.xhtml#4'] }, 'OEBPS/a.xhtml', 2, 6);
    assert.deepStrictEqual(carried.elements, ['OEBPS/a.xhtml#0', 'OEBPS/a.xhtml#3']);
    assert.strictEqual(carried.renumbered, 1);
    await refuses(
      Promise.resolve().then(() => migrateNarrationDeletionsForHeadingRemoval(
        { elements: ['OEBPS/a.xhtml#2'] }, 'OEBPS/a.xhtml', 2, 6)),
      'OEBPS/a.xhtml#2 is struck for narration',
      'Unstrike the heading first',
      'Nothing was written.');
  });

  // ── The carry, through the real project door ───────────────────────────
  await check('the project insert carries the strikes +1 in the one transaction', async () => {
    const dir = await makeProject('heading-carry');
    const struck = await narrationExport.editNarrationDeletions(
      dir, { strike: STRIKES, unstrike: [] });
    assert.ok(struck.fingerprints, 'the strikes recorded no fingerprints');

    const result = await insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine');
    assert.strictEqual(result.insertedKey, 'OEBPS/ch1.xhtml#0');
    assert.strictEqual(result.renumberedStrikes, 1,
      'exactly one strike sits at or after the insertion point');
    assert.deepStrictEqual(result.rewrittenEntries, ['OEBPS/ch1.xhtml']);

    const record = bookRecordOf(dir).narrationDeletions;
    assert.deepStrictEqual(record.elements, ['OEBPS/ch1.xhtml#2', 'OEBPS/ch2.xhtml#0'],
      'the strike after the insertion point was not carried +1');
    assert.strictEqual(record.epubSha256, result.toSha256, 'the record was not re-stamped');
    assert.strictEqual(narrationDeletionsStaleReason(record, result.toSha256), null,
      'the carried record still reads as stale');

    // The fingerprints travelled with their keys AND still describe the book:
    // what the record remembers striking is what each carried position says.
    const book = await manifestService.readExportEpub(dir);
    const prints = await narrationFingerprintsOfBook(book.absPath, 'carry test');
    assert.strictEqual(record.fingerprints['OEBPS/ch1.xhtml#2'],
      struck.fingerprints['OEBPS/ch1.xhtml#1'], 'the fingerprint did not travel with its key');
    assert.strictEqual(record.fingerprints['OEBPS/ch1.xhtml#2'], prints['OEBPS/ch1.xhtml#2'],
      'the carried fingerprint no longer describes the element at its new key');
    assert.strictEqual(record.fingerprints['OEBPS/ch2.xhtml#0'], prints['OEBPS/ch2.xhtml#0']);

    // The edit is on the record, and it is the record the fold's rule reads.
    const edits = bookRecordOf(dir).bookEdits;
    const last = edits[edits.length - 1];
    assert.strictEqual(last.kind, 'insert-chapter-heading');
    assert.strictEqual(last.insertedKey, 'OEBPS/ch1.xhtml#0');
    assert.strictEqual(last.fromSha256, result.fromSha256);
    assert.strictEqual(last.toSha256, result.toSha256);
  });

  await check('the naming pass then names the invented heading, record intact', async () => {
    const dir = await makeProject('heading-naming');
    await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
    await insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine');

    // Exactly what the IPC handler runs behind the insert.
    const summary = await narrationExport.nameChapterOpenings(dir);
    assert.strictEqual(summary.edited, 1,
      `the pass named ${summary.edited} opening(s): ${JSON.stringify(summary.skipped)}`);
    assert.strictEqual(summary.named[0].openerKey, 'OEBPS/ch1.xhtml#0');
    assert.strictEqual(summary.named[0].textBefore, 'The Machine');
    assert.strictEqual(summary.named[0].textAfter, 'Chapter 1');

    const book = await manifestService.readExportEpub(dir);
    const record = bookRecordOf(dir).narrationDeletions;
    assert.deepStrictEqual(record.elements, ['OEBPS/ch1.xhtml#2', 'OEBPS/ch2.xhtml#0']);
    assert.strictEqual(
      narrationDeletionsStaleReason(record, await bookDigestOf(book.absPath)), null,
      'the record went stale under the naming pass');
  });

  await check('the project removal carries the strikes back -1', async () => {
    const dir = await makeProject('heading-carry-back');
    const struck = await narrationExport.editNarrationDeletions(
      dir, { strike: STRIKES, unstrike: [] });
    const shapesBefore = await narrationDocumentShapes(
      (await manifestService.readExportEpub(dir)).absPath, 'carry back');

    await insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine');
    const removed = await removeBookInsertedHeading(dir, 'OEBPS/ch1.xhtml#0');
    assert.strictEqual(removed.textBefore, 'The Machine');
    assert.strictEqual(removed.renumberedStrikes, 1);

    const book = await manifestService.readExportEpub(dir);
    assert.deepStrictEqual(await narrationDocumentShapes(book.absPath, 'carry back'),
      shapesBefore, 'the removal did not restore the enumeration');
    const record = bookRecordOf(dir).narrationDeletions;
    assert.deepStrictEqual(record.elements, STRIKES, 'the strikes did not come back to their keys');
    assert.deepStrictEqual(record.fingerprints, struck.fingerprints,
      'the fingerprints did not come back with their keys');
    assert.strictEqual(record.epubSha256, removed.toSha256);
    const edits = bookRecordOf(dir).bookEdits;
    assert.strictEqual(edits[edits.length - 1].kind, 'remove-inserted-heading');
  });

  await check('a strike ON the heading refuses the removal before any byte', async () => {
    const dir = await makeProject('heading-struck');
    await insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine');
    await narrationExport.editNarrationDeletions(
      dir, { strike: ['OEBPS/ch1.xhtml#0'], unstrike: [] });

    const book = await manifestService.readExportEpub(dir);
    const digestBefore = await bookDigestOf(book.absPath);
    const recordBefore = bookRecordOf(dir).narrationDeletions;
    await refuses(
      removeBookInsertedHeading(dir, 'OEBPS/ch1.xhtml#0'),
      'OEBPS/ch1.xhtml#0 is struck for narration',
      'Unstrike the heading first',
      'Nothing was written.');
    assert.strictEqual(await bookDigestOf(book.absPath), digestBefore,
      'the refused removal changed the book');
    assert.deepStrictEqual(bookRecordOf(dir).narrationDeletions, recordBefore,
      'the refused removal changed the record');
  });

  await check('a stale strike record refuses the insert before any byte', async () => {
    const dir = await makeProject('heading-stale');
    await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });

    // The record now claims a book nobody has: flip one hex character of its
    // stamp, exactly what an out-of-band edit of the book looks like from here.
    const manifest = readManifest(dir);
    const record = manifest.families[0].epub.narrationDeletions;
    record.epubSha256 = record.epubSha256.replace(/[0-9a-f]$/,
      record.epubSha256.endsWith('0') ? '1' : '0');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const book = await manifestService.readExportEpub(dir);
    const digestBefore = await bookDigestOf(book.absPath);
    await refuses(
      insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine'),
      'The heading was not inserted',
      'cannot be carried across the edit');
    assert.strictEqual(await bookDigestOf(book.absPath), digestBefore,
      'the refused insert changed the book');
  });

  await check('a strike naming nothing refuses the WHOLE insert before any byte', async () => {
    const dir = await makeProject('heading-damaged');
    const book = await manifestService.readExportEpub(dir);
    const digestBefore = await bookDigestOf(book.absPath);

    // A damaged record whose stamp matches the book — the shape the dry run
    // exists for: staleness cannot catch it, only the carry arithmetic can.
    const manifest = readManifest(dir);
    manifest.families[0].epub.narrationDeletions = {
      epubSha256: digestBefore,
      elements: ['OEBPS/ch1.xhtml#99'],
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await refuses(
      insertBookChapterHeading(dir, 'OEBPS/ch1.xhtml#0', 'The Machine'),
      'OEBPS/ch1.xhtml#99 is struck for narration',
      'cannot be carried across the insert',
      'Nothing was written.');
    assert.strictEqual(await bookDigestOf(book.absPath), digestBefore,
      'the refused insert changed the book');
    assert.deepStrictEqual(bookRecordOf(dir).narrationDeletions.elements,
      ['OEBPS/ch1.xhtml#99'], 'the refused insert changed the record');
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
