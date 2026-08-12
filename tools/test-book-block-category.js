/**
 * Tests for the relabel — `setElementCategoryInBookFile` in
 * electron/epub-processor.ts and the reading that has to honour it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-block-category.js
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * Owen, 2026-08-10, having promoted a `title` block to `chapter` in the picker
 * and then renamed that chapter: the name landed in the table of contents and
 * the naming pass declined the page, saying "EPUB/text/c0001.xhtml is called
 * 'Working Towards the Führer' in the table of contents, and its markup marks no
 * chapter opening in it". It was right — the relabel had gone into the picker's
 * own editor state and the BOOK still said `title`. "it apparently didnt
 * actually change it to chapter, just visually?"
 *
 * So the fixture below is that book: a converted book whose chapter document
 * does NOT open with a heading (the split landed mid-page, so the first element
 * is prose), which is exactly the shape `markChapterOpenings` cannot read a
 * chapter out of.
 *
 * ── What is worth a test ───────────────────────────────────────────────────
 *
 * THE PROMOTION, END TO END, because that is the whole point: the relabel is
 * written into the book, the reading answers with it, and the naming pass —
 * which finds a chapter's opening through `markupCategoriesForUnits` and knows
 * nothing about any stamp — then finds that element and writes the chapter's
 * stored name into it. A test of the attribute alone would prove nothing; the
 * guarantee is what the READER reads.
 *
 * THE DEMOTION, because it has to reverse: the element stops being the opening
 * and the naming pass says so by name.
 *
 * ALL THREE INPUT CLASSES, because a category is read three different ways
 * depending on what wrote the book (a reflow of ours, a document vision model, a
 * publisher's own markup) and the user's word has to outrank all three. The
 * publisher case also has to demote the opening the NAVIGATION picked, or its
 * document would hold two chapter openings and the naming pass would write the
 * name into whichever came first.
 *
 * THE STAMPS SURVIVE, because the book's record of what wrote it is not the
 * user's to overwrite: `data-bf-cat` still says what the model read, and
 * `data-bf-category`/`data-bf-group` still travel together.
 *
 * THE REFUSALS, because every alternative is silent damage: a category outside
 * the palette, a key naming a picture or a whole document, and a key naming an
 * element the book does not have.
 *
 * THE IDEMPOTENCE, because this runs from a palette a person clicks: a relabel
 * to what the book already says must write no bytes at all, or every click would
 * void the narration strikes and the analysis cache for nothing.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-block-category-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  ZipReader, ZipWriter,
  setElementCategoryInBookFile,
  setElementCategoriesInBookFile,
  readEpubElementCategories,
  nameChapterOpeningsInBookFile,
  USER_CATEGORY_ATTR,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
// The container seam, held so one test can make the verification's read of the
// WRITTEN book fail — the only way in from outside to reach the restore arm.
const epubContainer = require(path.join(DIST, 'electron', 'epub-container.js'));

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

/** An EPUB 3 package with a nav document, and the spine in the order given. */
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

async function writeEpub(name, files) {
  const target = path.join(ROOT, name);
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'), true);
  zip.addFile('OEBPS/plate.png', PLATE, true);
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), true);
  }
  await zip.write(target);
  return target;
}

/**
 * OWEN'S BOOK: a `foundry vlm-convert` conversion whose chapter document does
 * not open with a heading.
 *
 * `c0001.xhtml` starts with the prose the previous page ran into, then the
 * chapter's printed heading ("II"), then more prose. The navigation calls the
 * document "Working Towards the Führer". `markChapterOpenings` reads no chapter
 * out of that — the first text element is not a heading tag, and no run of
 * elements from the top folds to the navigation label — which is exactly the
 * refusal Owen was shown.
 */
function convertedBook() {
  return writeEpub('converted.epub', {
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

/** A book OUR reflow wrote: the three provenance attributes, together. */
function reflowedBook() {
  return writeEpub('reflowed.epub', {
    'OEBPS/content.opf': OPF3(['r0001']),
    'OEBPS/nav.xhtml': NAV([['r0001.xhtml', 'Nuremberg, October 1946']]),
    'OEBPS/r0001.xhtml': PAGE('Nuremberg, October 1946', [
      '<p data-bf-category="body" data-bf-group="p0001" data-bf-blocks="p0001b001">The court rose '
      + 'at four, and the corridor outside was already full.</p>',
      '<h1 data-bf-category="title" data-bf-group="p0002" data-bf-blocks="p0002b001">ONE</h1>',
      '<p data-bf-category="body" data-bf-group="p0003" data-bf-blocks="p0003b001">Twenty-one men '
      + 'sat in two rows, and none of them looked at each other.</p>',
    ].join('\n')),
  });
}

/**
 * A PUBLISHER's book: no stamp of ours anywhere, headings set as styled
 * paragraphs (Killing America carries zero `<h1>`–`<h6>` in 21 documents), so
 * the navigation LABEL is what picks the opening.
 */
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

// ── The tests ───────────────────────────────────────────────────────────────

const CONVERTED_OPENER = 'OEBPS/c0001.xhtml#1';

async function run() {
  // ── The failure this exists for, reproduced ────────────────────────────
  await check('the book Owen had: its markup marks no chapter opening in c0001', async () => {
    const book = await convertedBook();
    const staged = path.join(ROOT, 'named-before.epub');
    const named = await nameChapterOpeningsInBookFile(
      book, staged, new Map([['OEBPS/c0001.xhtml', 'Working Towards the Führer']]));
    assert.strictEqual(named.edits.length, 0, 'it named something it should not have found');
    assert.strictEqual(named.skipped.length, 1);
    assert.strictEqual(named.skipped[0].kind, 'no-chapter-element');
    assert.ok(
      named.skipped[0].reason.includes('marks no chapter opening in it'),
      `the reason is not the one Owen was shown: ${named.skipped[0].reason}`);
  });

  await check('a converted book reads its categories off data-bf-cat', async () => {
    const book = await convertedBook();
    const reading = await readEpubElementCategories(book);
    assert.strictEqual(reading.source, 'document');
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0001.xhtml#0'), 'body');
    assert.strictEqual(reading.categoryByElement.get(CONVERTED_OPENER), 'title');
  });

  // ── The promotion, end to end ──────────────────────────────────────────
  await check('promoting title→chapter is written into the book and read back', async () => {
    const book = await convertedBook();
    const promoted = path.join(ROOT, 'converted-promoted.epub');
    const { written, edit } = await setElementCategoryInBookFile(
      book, promoted, CONVERTED_OPENER, 'chapter');

    assert.strictEqual(written, true, 'nothing was written');
    assert.strictEqual(edit.file, 'OEBPS/c0001.xhtml');
    assert.strictEqual(edit.tag, 'h1');
    assert.strictEqual(edit.categoryBefore, 'title');
    assert.strictEqual(edit.categoryAfter, 'chapter');
    assert.strictEqual(edit.excerpt, 'II');

    const xhtml = await documentText(promoted, 'OEBPS/c0001.xhtml');
    assert.ok(
      xhtml.includes(`${USER_CATEGORY_ATTR}="chapter"`),
      'the element does not carry the user category');
    // The MODEL's own word survives beside it: the book's record of what it read
    // is not the user's to overwrite.
    assert.ok(xhtml.includes('data-bf-cat="title"'), 'the conversion stamp was destroyed');

    const reading = await readEpubElementCategories(promoted);
    assert.strictEqual(reading.categoryByElement.get(CONVERTED_OPENER), 'chapter');
    assert.strictEqual(
      reading.conversionByElement.get(CONVERTED_OPENER).statedCategory, 'title',
      'the model\'s own category stopped being reported');
    // Nothing else moved.
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0001.xhtml#0'), 'body');
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0000.xhtml#0'), 'chapter');
  });

  await check('the naming pass then finds that opening and writes the name into it', async () => {
    const book = await convertedBook();
    const promoted = path.join(ROOT, 'converted-promoted-2.epub');
    await setElementCategoryInBookFile(book, promoted, CONVERTED_OPENER, 'chapter');

    const staged = path.join(ROOT, 'converted-named.epub');
    const named = await nameChapterOpeningsInBookFile(promoted, staged, new Map([
      ['OEBPS/c0000.xhtml', 'The Nazi Revolution'],
      ['OEBPS/c0001.xhtml', 'Working Towards the Führer'],
    ]));
    const one = named.edits.find((e) => e.file === 'OEBPS/c0001.xhtml');
    assert.ok(one !== undefined,
      `c0001's opening was not named — skipped: ${JSON.stringify(named.skipped)}`);
    assert.strictEqual(one.openerKey, CONVERTED_OPENER);
    assert.strictEqual(one.textBefore, 'II');
    assert.strictEqual(one.textAfter, 'Working Towards the Führer');

    const xhtml = await documentText(staged, 'OEBPS/c0001.xhtml');
    assert.ok(
      xhtml.includes('>Working Towards the Führer</h1>'),
      'the heading on the page does not read the chapter\'s name');
    // The relabel travelled through the naming pass untouched — the pass
    // rewrites text inside an element and moves no attribute.
    assert.ok(xhtml.includes(`${USER_CATEGORY_ATTR}="chapter"`), 'the relabel was lost');
  });

  // ── The demotion ───────────────────────────────────────────────────────
  await check('demotion reverses it — the element stops being the opening', async () => {
    const book = await convertedBook();
    const promoted = path.join(ROOT, 'converted-promoted-3.epub');
    await setElementCategoryInBookFile(book, promoted, CONVERTED_OPENER, 'chapter');
    const demoted = path.join(ROOT, 'converted-demoted.epub');
    const { written, edit } = await setElementCategoryInBookFile(
      promoted, demoted, CONVERTED_OPENER, 'body');

    assert.strictEqual(written, true);
    assert.strictEqual(edit.categoryBefore, 'chapter');
    assert.strictEqual(edit.categoryAfter, 'body');
    assert.strictEqual(
      (await readEpubElementCategories(demoted)).categoryByElement.get(CONVERTED_OPENER), 'body');

    const staged = path.join(ROOT, 'converted-demoted-named.epub');
    const named = await nameChapterOpeningsInBookFile(
      demoted, staged, new Map([['OEBPS/c0001.xhtml', 'Working Towards the Führer']]));
    assert.strictEqual(named.edits.length, 0, 'it named an opening that is no longer one');
    assert.strictEqual(named.skipped[0].kind, 'no-chapter-element');
  });

  await check('a demotion of a chapter block takes its row out of the Chapter tab', async () => {
    const book = await convertedBook();
    const demoted = path.join(ROOT, 'converted-ch0-demoted.epub');
    await setElementCategoryInBookFile(book, demoted, 'OEBPS/c0000.xhtml#0', 'heading');
    const reading = await readEpubElementCategories(demoted);
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0000.xhtml#0'), 'heading');
  });

  // ── A book our reflow wrote ────────────────────────────────────────────
  await check('a relabel outranks the reflow stamp, and the stamp survives', async () => {
    const book = await reflowedBook();
    const before = await readEpubElementCategories(book);
    assert.strictEqual(before.source, 'document');
    assert.strictEqual(before.categoryByElement.get('OEBPS/r0001.xhtml#1'), 'title');

    const promoted = path.join(ROOT, 'reflowed-promoted.epub');
    const { edit } = await setElementCategoryInBookFile(
      book, promoted, 'OEBPS/r0001.xhtml#1', 'chapter');
    assert.strictEqual(edit.categoryBefore, 'title');

    const after = await readEpubElementCategories(promoted);
    assert.strictEqual(after.source, 'document', 'the book changed input class');
    assert.strictEqual(after.categoryByElement.get('OEBPS/r0001.xhtml#1'), 'chapter');
    const stamp = after.provenanceByElement.get('OEBPS/r0001.xhtml#1');
    assert.strictEqual(stamp.category, 'title', 'the reflow stamp was overwritten');
    assert.strictEqual(stamp.group, 'p0002');
    assert.deepStrictEqual(stamp.sourceBlockIds, ['p0002b001']);
    assert.strictEqual(after.categoryByElement.get('OEBPS/r0001.xhtml#0'), 'body');
  });

  // ── A publisher's book ─────────────────────────────────────────────────
  await check('a publisher book takes the relabel, and the classification respects it', async () => {
    const book = await publisherBook();
    const before = await readEpubElementCategories(book);
    assert.strictEqual(before.source, 'markup');
    // The navigation's own reading: "Chapter 1" + "Killing America" folds to the
    // label, so the first of the run opens the chapter and the second is its
    // heading.
    assert.strictEqual(before.categoryByElement.get('OEBPS/p0001.xhtml#0'), 'chapter');
    assert.strictEqual(before.categoryByElement.get('OEBPS/p0001.xhtml#1'), 'heading');

    // The user says the TITLE line is the opening, not the number above it.
    const promoted = path.join(ROOT, 'publisher-promoted.epub');
    const { edit } = await setElementCategoryInBookFile(
      book, promoted, 'OEBPS/p0001.xhtml#1', 'chapter');
    assert.strictEqual(edit.categoryBefore, 'heading');

    const after = await readEpubElementCategories(promoted);
    assert.strictEqual(after.source, 'markup', 'the book changed input class');
    assert.strictEqual(after.categoryByElement.get('OEBPS/p0001.xhtml#1'), 'chapter');
    // ONE opening per document: the navigation's pick steps aside for the user's.
    assert.strictEqual(
      after.categoryByElement.get('OEBPS/p0001.xhtml#0'), 'heading',
      'the document now holds two chapter openings');
    assert.strictEqual(after.categoryByElement.get('OEBPS/p0001.xhtml#2'), 'body');

    // And the naming pass writes the name into the element the USER named.
    const staged = path.join(ROOT, 'publisher-named.epub');
    const named = await nameChapterOpeningsInBookFile(
      promoted, staged, new Map([['OEBPS/p0001.xhtml', 'Chapter 1: Killing America']]));
    assert.strictEqual(named.edits.length, 1,
      `nothing was named — skipped: ${JSON.stringify(named.skipped)}`);
    assert.strictEqual(named.edits[0].openerKey, 'OEBPS/p0001.xhtml#1');
    assert.strictEqual(named.edits[0].textBefore, 'Killing America');
    assert.strictEqual(named.edits[0].textAfter, 'Chapter 1: Killing America');
  });

  // ── Idempotence ────────────────────────────────────────────────────────
  await check('relabelling to what the book already says writes nothing', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'converted-noop.epub');
    const { written, edit } = await setElementCategoryInBookFile(
      book, out, 'OEBPS/c0000.xhtml#0', 'chapter');
    assert.strictEqual(written, false, 'the book was rewritten to say what it already said');
    assert.strictEqual(edit.categoryBefore, 'chapter');
    assert.strictEqual(fs.existsSync(out), false, 'a file was written anyway');
  });

  await check('saying the same thing twice writes nothing the second time', async () => {
    const book = await convertedBook();
    const once = path.join(ROOT, 'converted-once.epub');
    await setElementCategoryInBookFile(book, once, CONVERTED_OPENER, 'chapter');
    const twice = path.join(ROOT, 'converted-twice.epub');
    const second = await setElementCategoryInBookFile(once, twice, CONVERTED_OPENER, 'chapter');
    assert.strictEqual(second.written, false);
    assert.strictEqual(fs.existsSync(twice), false);
  });

  // ── The edit is surgical ───────────────────────────────────────────────
  await check('only the one document changes, and it holds what it held', async () => {
    const book = await convertedBook();
    const promoted = path.join(ROOT, 'converted-surgical.epub');
    await setElementCategoryInBookFile(book, promoted, CONVERTED_OPENER, 'chapter');

    const before = await entriesOf(book);
    const after = await entriesOf(promoted);
    assert.deepStrictEqual([...after.keys()], [...before.keys()], 'the zip entries changed');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, ['OEBPS/c0001.xhtml'],
      `entries other than the relabelled document changed: ${changed.join(', ')}`);

    // The element walk is unmoved, which is what lets the strike record be
    // re-stamped rather than migrated.
    const beforeKeys = (await readEpubElementCategories(book)).elements.map((e) => e.key);
    const afterKeys = (await readEpubElementCategories(promoted)).elements.map((e) => e.key);
    assert.deepStrictEqual(afterKeys, beforeKeys, 'the element enumeration moved');
  });

  // ── The refusals ───────────────────────────────────────────────────────
  await check('a category outside the palette is refused, naming it', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'refused-category.epub');
    await refuses(
      setElementCategoryInBookFile(book, out, CONVERTED_OPENER, 'chapter-opening'),
      '"chapter-opening" is not a block category BookForge knows',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
  });

  await check('a key naming no element is refused, naming the file and its count', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'refused-index.epub');
    await refuses(
      setElementCategoryInBookFile(book, out, 'OEBPS/c0001.xhtml#94', 'chapter'),
      // Four, not three: the `<div class="image">` wrapper is a text unit that
      // lays out no words, enumerated alongside the picture inside it.
      'OEBPS/c0001.xhtml holds 4 text element(s), so OEBPS/c0001.xhtml#94 names nothing in it',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
  });

  await check('a key naming a document this book does not have is refused', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'refused-file.epub');
    await refuses(
      setElementCategoryInBookFile(book, out, 'OEBPS/c0099.xhtml#0', 'chapter'),
      'has no document OEBPS/c0099.xhtml',
      'Nothing was written.');
  });

  await check('a key naming a picture is refused — a picture is what it is', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'refused-image.epub');
    await refuses(
      setElementCategoryInBookFile(book, out, 'OEBPS/c0001.xhtml#img0', 'discard'),
      'names a picture',
      'strike it instead');
  });

  await check('a key naming a whole document is refused', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'refused-doc.epub');
    await refuses(
      setElementCategoryInBookFile(book, out, 'OEBPS/c0001.xhtml#doc', 'chapter'),
      'names a whole document',
      'A document is not labelled; the things in it are.');
  });

  // ── The value in the book has to be one we know ────────────────────────
  await check('a relabel the book carries in an unknown vocabulary is refused', async () => {
    const book = await convertedBook();
    const forged = path.join(ROOT, 'forged.epub');
    const reader = new ZipReader(book);
    await reader.open();
    try {
      const zip = new ZipWriter();
      for (const entry of reader.getEntries()) {
        let data = await reader.readEntry(entry);
        if (entry === 'OEBPS/c0001.xhtml') {
          data = Buffer.from(
            data.toString('utf8').replace(
              'data-bf-cat="title"', `data-bf-cat="title" ${USER_CATEGORY_ATTR}="chapter-opening"`),
            'utf8');
        }
        zip.addFile(entry, data, entry !== 'mimetype');
      }
      await zip.write(forged);
    } finally {
      reader.close();
    }
    await refuses(
      readEpubElementCategories(forged),
      `${USER_CATEGORY_ATTR}="chapter-opening", which is not a block category BookForge knows`);
  });

  // ── The BATCH ──────────────────────────────────────────────────────────
  //
  // A person relabels a RUN of blocks, and the picker used to send them one at
  // a time: every block re-paid the whole-book read, the write and the reading
  // that verifies it (~500 ms each on a 20-document book, measured 2026-08-11).
  // `setElementCategoriesInBookFile` does all of that once for the whole run.
  //
  // What is worth a test is not the speed — it is that a batch keeps every
  // promise the singular made, and that it keeps them ACROSS elements: all or
  // nothing before the first byte, an idempotent element beside a real one, and
  // a failure after the write that puts back EVERY document it touched.

  await check('a batch relabels several elements across several documents, in one write', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'batch-multi.epub');
    const written = await setElementCategoriesInBookFile(book, out, [
      { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
      { elementKey: 'OEBPS/c0001.xhtml#0', categoryId: 'quote' },
      { elementKey: 'OEBPS/c0000.xhtml#1', categoryId: 'caption' },
    ]);

    assert.strictEqual(written.length, 3, 'the batch did not answer once per element');
    assert.deepStrictEqual(written.map((w) => w.written), [true, true, true]);
    // In the order asked, so the caller can put each answer against its block.
    assert.deepStrictEqual(
      written.map((w) => w.edit.elementKey),
      [CONVERTED_OPENER, 'OEBPS/c0001.xhtml#0', 'OEBPS/c0000.xhtml#1'],
      'the answers came back in a different order from the questions');
    assert.strictEqual(written[0].edit.categoryBefore, 'title');
    assert.strictEqual(written[1].edit.categoryBefore, 'body');

    const reading = await readEpubElementCategories(out);
    assert.strictEqual(reading.categoryByElement.get(CONVERTED_OPENER), 'chapter');
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0001.xhtml#0'), 'quote');
    assert.strictEqual(reading.categoryByElement.get('OEBPS/c0000.xhtml#1'), 'caption');

    // Exactly the two documents the batch named, and nothing else in the book.
    const before = await entriesOf(book);
    const after = await entriesOf(out);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed.sort(), ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml'],
      `the batch moved entries it did not name: ${changed.join(', ')}`);

    // And the enumeration every narration strike is keyed by is unmoved.
    const beforeKeys = (await readEpubElementCategories(book)).elements.map((e) => e.key);
    assert.deepStrictEqual(reading.elements.map((e) => e.key), beforeKeys,
      'the element enumeration moved under a batch');
  });

  await check('an idempotent element rides along beside a real one', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'batch-mixed.epub');
    const written = await setElementCategoriesInBookFile(book, out, [
      // c0000#0 is ALREADY `chapter` — the book says so in its own markup.
      { elementKey: 'OEBPS/c0000.xhtml#0', categoryId: 'chapter' },
      { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
    ]);
    assert.deepStrictEqual(written.map((w) => w.written), [false, true],
      'the already-labelled element was not reported as writing nothing');
    assert.strictEqual(written[0].edit.categoryBefore, 'chapter');

    // The one that had something to say landed; the one that did not left no
    // mark on its own document.
    const reading = await readEpubElementCategories(out);
    assert.strictEqual(reading.categoryByElement.get(CONVERTED_OPENER), 'chapter');
    const untouched = await documentText(out, 'OEBPS/c0000.xhtml');
    assert.ok(!untouched.includes(USER_CATEGORY_ATTR),
      'an element the book already labelled was stamped anyway');

    const before = await entriesOf(book);
    const after = await entriesOf(out);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, ['OEBPS/c0001.xhtml'],
      `a document holding only idempotent elements was rewritten: ${changed.join(', ')}`);
  });

  await check('a batch of nothing but idempotent elements writes no book at all', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'batch-all-noop.epub');
    const written = await setElementCategoriesInBookFile(book, out, [
      { elementKey: 'OEBPS/c0000.xhtml#0', categoryId: 'chapter' },
      { elementKey: 'OEBPS/c0000.xhtml#1', categoryId: 'body' },
    ]);
    assert.deepStrictEqual(written.map((w) => w.written), [false, false]);
    assert.strictEqual(fs.existsSync(out), false, 'a book was written anyway');
  });

  await check('one bad element refuses the WHOLE batch, before any byte', async () => {
    const book = await convertedBook();
    const before = await entriesOf(book);

    // A category outside the palette, in the middle of good ones.
    const out = path.join(ROOT, 'batch-bad-category.epub');
    await refuses(
      setElementCategoriesInBookFile(book, out, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: 'OEBPS/c0001.xhtml#0', categoryId: 'chapter-opening' },
        { elementKey: 'OEBPS/c0000.xhtml#1', categoryId: 'caption' },
      ]),
      '"chapter-opening" is not a block category BookForge knows',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false, 'a book was written for a refused batch');

    // A key naming an element the book does not have.
    const missing = path.join(ROOT, 'batch-missing-key.epub');
    await refuses(
      setElementCategoriesInBookFile(book, missing, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: 'OEBPS/c0001.xhtml#99', categoryId: 'caption' },
      ]),
      'names nothing in it', 'Nothing was written.');
    assert.strictEqual(fs.existsSync(missing), false);

    // A key naming a picture, which is what it is and not a label.
    const picture = path.join(ROOT, 'batch-picture-key.epub');
    await refuses(
      setElementCategoriesInBookFile(book, picture, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: 'OEBPS/c0001.xhtml#img0', categoryId: 'caption' },
      ]),
      'names a picture', 'Nothing was written.');
    assert.strictEqual(fs.existsSync(picture), false);

    // The SOURCE book is untouched by every one of those refusals.
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `a refused batch changed the book it read: ${changed.join(', ')}`);
  });

  await check('one element named twice is refused — the batch says two things about it', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'batch-duplicate.epub');
    await refuses(
      setElementCategoriesInBookFile(book, out, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: CONVERTED_OPENER, categoryId: 'heading' },
      ]),
      'is named twice in the same relabel',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false);
  });

  await check('a batch that names no element at all is refused', async () => {
    const book = await convertedBook();
    await refuses(
      setElementCategoriesInBookFile(book, path.join(ROOT, 'batch-empty.epub'), []),
      'named no element at all',
      'Nothing was written.');
  });

  // ── The failure arm, over N documents ──────────────────────────────────
  //
  // The in-place write has no staged book to destroy, so a verification that
  // refuses has to put back every document it touched — and the batch made that
  // "every", not "the one". Reached by making the verification's read of the
  // written book fail, which is the seam a torn write would fail at anyway.
  await check('an in-place batch that fails verification puts EVERY document back', async () => {
    const book = await convertedBook();
    const inPlace = path.join(ROOT, 'batch-restore.epub');
    fs.copyFileSync(book, inPlace);
    const before = await entriesOf(inPlace);

    // Fired on the first open of a book that ALREADY carries the edit — which is
    // precisely the verification's read, and never one of the reads before the
    // write. One-shot, so the restore's own write can still open the book.
    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      if (!failedTheVerification && path.resolve(p) === path.resolve(inPlace)
        && (await documentText(inPlace, 'OEBPS/c0001.xhtml')).includes(USER_CATEGORY_ATTR)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await setElementCategoriesInBookFile(inPlace, inPlace, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: 'OEBPS/c0000.xhtml#1', categoryId: 'caption' },
      ]);
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the batch did not refuse when its verification failed');
    assert.ok(
      message.includes('could not be read back'),
      `the refusal is not the one the verification raised: ${message}`);
    // The whole point: the edit HAD landed on disk, so the restore below is
    // proving it was taken back and not merely that it never happened.
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a written book, so nothing was restored');

    // The book is the book it was handed — BOTH documents, byte for byte.
    const after = await entriesOf(inPlace);
    assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(),
      'the restore changed which entries the book has');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `the restore left ${changed.length} document(s) edited: ${changed.join(', ')}`);
    assert.ok(fs.existsSync(inPlace), 'the in-place failure destroyed the book');
  });

  await check('a staged batch that fails verification destroys the staged book only', async () => {
    const book = await convertedBook();
    const out = path.join(ROOT, 'batch-staged-fail.epub');
    const before = await entriesOf(book);

    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      // Only ever the staged book, and only once it exists — so the write has
      // certainly happened and there is a staged book to be destroyed.
      if (path.resolve(p) === path.resolve(out) && fs.existsSync(out)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await setElementCategoriesInBookFile(book, out, [
        { elementKey: CONVERTED_OPENER, categoryId: 'chapter' },
        { elementKey: 'OEBPS/c0000.xhtml#1', categoryId: 'caption' },
      ]);
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the staged batch did not refuse');
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a staged book, so nothing was destroyed');
    assert.strictEqual(fs.existsSync(out), false, 'the staged book survived its own refusal');
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [], 'a staged refusal changed the source book');
  });

  await check('the singular relabel is the batch of one, and answers the same', async () => {
    const book = await convertedBook();
    const one = path.join(ROOT, 'singular-vs-batch-one.epub');
    const many = path.join(ROOT, 'singular-vs-batch-many.epub');
    const singular = await setElementCategoryInBookFile(book, one, CONVERTED_OPENER, 'chapter');
    const [batched] = await setElementCategoriesInBookFile(
      book, many, [{ elementKey: CONVERTED_OPENER, categoryId: 'chapter' }]);
    assert.deepStrictEqual(batched, singular, 'the batch of one answered differently');

    const oneEntries = await entriesOf(one);
    const manyEntries = await entriesOf(many);
    for (const [entry, bytes] of oneEntries) {
      assert.ok(bytes.equals(manyEntries.get(entry)),
        `${entry} differs between the singular relabel and the batch of one`);
    }
  });

  // ── The naming pass, IN PLACE ──────────────────────────────────────────
  //
  // It runs behind every promotion to `chapter`, and while it staged its result
  // and landed it with `moveIntoPlace` that click re-created every entry of the
  // book (~1.3 s of it on the migrated Nuremberg project, measured 2026-08-11).
  // In place it rewrites only the chapters it named — which puts the same three
  // obligations on it that the batch relabel has: touch nothing else, take back
  // EVERY document it touched when its own verification refuses, and write
  // nothing at all for a book that already reads right.

  /** The fixture with c0001's opener promoted, so both documents can be named. */
  async function bookWithTwoNameableOpenings(name) {
    const book = await convertedBook();
    const promoted = path.join(ROOT, name);
    await setElementCategoryInBookFile(book, promoted, CONVERTED_OPENER, 'chapter');
    return promoted;
  }

  const TWO_NAMES = new Map([
    // c0000 prints "The Nazi Revolution" already, so it is only nameable under a
    // DIFFERENT stored name — which is what makes this a two-document edit.
    ['OEBPS/c0000.xhtml', 'Chapter 1: The Nazi Revolution'],
    ['OEBPS/c0001.xhtml', 'Working Towards the Führer'],
  ]);

  await check('the naming pass writes several chapters in place, and nothing else', async () => {
    const book = await bookWithTwoNameableOpenings('named-in-place.epub');
    const before = await entriesOf(book);

    const named = await nameChapterOpeningsInBookFile(book, book, TWO_NAMES);
    assert.strictEqual(named.edits.length, 2,
      `the pass named ${named.edits.length} opening(s): ${JSON.stringify(named.skipped)}`);
    assert.deepStrictEqual(named.edits.map((e) => e.file).sort(),
      ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml']);

    // Both pages print their stored names, read off the book itself.
    assert.ok((await documentText(book, 'OEBPS/c0000.xhtml'))
      .includes('>Chapter 1: The Nazi Revolution</h1>'), 'c0000 does not print its name');
    assert.ok((await documentText(book, 'OEBPS/c0001.xhtml'))
      .includes('>Working Towards the Führer</h1>'), 'c0001 does not print its name');

    // Exactly those two entries moved — the images and the package did not.
    const after = await entriesOf(book);
    assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(),
      'the in-place naming changed which entries the book has');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed.sort(), ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml'],
      `the naming pass moved entries it did not name: ${changed.join(', ')}`);

    // And the enumeration every narration strike is keyed by is unmoved, which
    // is what lets the caller re-stamp the record rather than migrate it.
    const beforeKeys = (await readEpubElementCategories(
      await bookWithTwoNameableOpenings('named-in-place-ref.epub'))).elements.map((e) => e.key);
    const afterKeys = (await readEpubElementCategories(book)).elements.map((e) => e.key);
    assert.deepStrictEqual(afterKeys, beforeKeys, 'the element enumeration moved under the naming');
  });

  await check('a book that already reads right is not rewritten in place', async () => {
    const book = await bookWithTwoNameableOpenings('named-idempotent.epub');
    await nameChapterOpeningsInBookFile(book, book, TWO_NAMES);
    const settled = await entriesOf(book);

    // Second run: the openings already say it, so there is nothing to write.
    const again = await nameChapterOpeningsInBookFile(book, book, TWO_NAMES);
    assert.strictEqual(again.edits.length, 0, 'it named something that already read right');
    assert.deepStrictEqual(again.skipped.map((s) => s.kind).sort(),
      ['already-named', 'already-named']);

    const after = await entriesOf(book);
    const changed = [...settled.keys()].filter((e) => !settled.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `an idempotent naming pass rewrote ${changed.join(', ')}`);
  });

  await check('beforeWriting is asked only when there is something to write', async () => {
    const book = await bookWithTwoNameableOpenings('named-hook.epub');
    const before = await entriesOf(book);

    // Refusing from the hook leaves the book exactly as it was found — the
    // window `nameChapterOpenings` makes its staleness judgement in.
    let asked = null;
    await refuses(
      nameChapterOpeningsInBookFile(book, book, TWO_NAMES, (edits) => {
        asked = edits.map((e) => e.file).sort();
        throw new Error('the strikes cannot be carried onto this edit');
      }),
      'the strikes cannot be carried onto this edit');
    assert.deepStrictEqual(asked, ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml'],
      'the hook was not told what the pass was about to write');
    const afterRefusal = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(afterRefusal.get(e)));
    assert.deepStrictEqual(changed, [],
      `a refusal from beforeWriting still wrote ${changed.join(', ')}`);

    // Name it for real, then run again: a book with nothing to do must never
    // ask, which is what lets a project whose strikes are void still open.
    await nameChapterOpeningsInBookFile(book, book, TWO_NAMES);
    let askedAgain = false;
    const quiet = await nameChapterOpeningsInBookFile(book, book, TWO_NAMES, () => {
      askedAgain = true;
      throw new Error('this must never be reached');
    });
    assert.strictEqual(askedAgain, false,
      'a book with nothing to name asked permission to write nothing');
    assert.strictEqual(quiet.edits.length, 0);
  });

  await check('an in-place naming that fails verification puts EVERY chapter back', async () => {
    const book = await bookWithTwoNameableOpenings('named-restore.epub');
    const before = await entriesOf(book);

    // Fired on the first open of a book that ALREADY carries the naming — which
    // is precisely the verification's read, and never one of the reads before
    // the write. One-shot, so the restore's own write can still open the book.
    //
    // The mark is the NAMED HEADING and not the name anywhere in the file: the
    // document's `<title>` has said "Working Towards the Führer" since the
    // fixture was built, so a looser test fires on the pass's very first read,
    // nothing is ever written, and the restore this is here to check never runs
    // — a test that passes over an unwritten book. (It did, until a mutation of
    // the restore failed to break it.)
    const NAMED_HEADING = '>Working Towards the Führer</h1>';
    assert.ok(!(await documentText(book, 'OEBPS/c0001.xhtml')).includes(NAMED_HEADING),
      'the fixture already prints the name, so this test could not tell a write from a read');
    const real = epubContainer.openEpubSource;
    let failedTheVerification = false;
    epubContainer.openEpubSource = async (p) => {
      if (!failedTheVerification && path.resolve(p) === path.resolve(book)
        && (await documentText(book, 'OEBPS/c0001.xhtml')).includes(NAMED_HEADING)) {
        failedTheVerification = true;
        throw new Error('the written book could not be read back');
      }
      return real(p);
    };
    let message = null;
    try {
      await nameChapterOpeningsInBookFile(book, book, TWO_NAMES);
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the pass did not refuse when its verification failed');
    assert.ok(message.includes('could not be read back'),
      `the refusal is not the one the verification raised: ${message}`);
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a written book, so nothing was restored');

    // BOTH chapters are back, byte for byte, and the book still exists.
    const after = await entriesOf(book);
    assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(),
      'the restore changed which entries the book has');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [],
      `the restore left ${changed.length} chapter(s) named: ${changed.join(', ')}`);
    assert.ok(fs.existsSync(book), 'the in-place failure destroyed the book');
  });

  await check('a staged naming that fails verification destroys the staged book only', async () => {
    const book = await bookWithTwoNameableOpenings('named-staged-fail.epub');
    const out = path.join(ROOT, 'named-staged-fail-out.epub');
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
      await nameChapterOpeningsInBookFile(book, out, TWO_NAMES);
    } catch (err) {
      message = err.message;
    } finally {
      epubContainer.openEpubSource = real;
    }

    assert.notStrictEqual(message, null, 'the staged naming did not refuse');
    assert.strictEqual(failedTheVerification, true,
      'the injected failure never saw a staged book, so nothing was destroyed');
    assert.strictEqual(fs.existsSync(out), false, 'the staged book survived its own refusal');
    const after = await entriesOf(book);
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, [], 'a staged refusal changed the source book');
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
