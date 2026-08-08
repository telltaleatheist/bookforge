/**
 * Tests for the narration copy — the SECOND file, cut from the converted book by
 * what the user struck out of it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-deletions.js
 *
 * Four things are worth a test here, and they are the four ways this can be
 * wrong in a way nobody notices until they are listening to the book.
 *
 * THE TRANSFORM, because it is the whole feature: element keys in, the elements
 * of the official book that come out, and every one of them still there in the
 * official book afterwards.
 *
 * THE REFUSAL, because the alternative is a narration copy with the wrong
 * paragraphs missing. A recorded key that names no element of the book stops the
 * export by name — the same rule the editor's block deletions follow at foundry
 * export, and for the same reason: a positional record whose position is gone
 * cannot be reconciled by guessing.
 *
 * THE CATEGORY MAP, because a stamp BookForge cannot read must be an error and
 * not a paragraph quietly painted as body text.
 *
 * THE PROGRESS PARSER, against foundry's real lines in both dialects, because
 * the endpoint form contains the MLX form's substring and reading it with the
 * wrong pattern reports a PDF page number as a count.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-narration-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  ZipReader,
  ZipWriter,
  epubCarriesConversionStamps,
  readEpubConversionStamps,
  readEpubConversionUnits,
  writeNarrationEpub,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const {
  narrationElementKey,
  narrationImageElementKey,
  parseNarrationElementKey,
  deriveNarrationStrikes,
  describeUnstruckDeletions,
  narrationDeletedBlockIds,
  narrationDeletedPages,
  narrationDeletionEdit,
  narrationBlocksOnSourcePage,
  narrationEpubRelPath,
  narrationDeletionsStaleReason,
  planNarrationRemoval,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));
const {
  blockCategoryForVlm,
  parseVlmProgressLine,
  VLM_CATEGORIES,
} = require(path.join(DIST, 'shared', 'vlm', 'conversion.js'));

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => { results.push(['ok', name]); },
        (err) => { failures++; results.push(['FAIL', name, err && err.message]); }
      );
    }
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
  return Promise.resolve();
}

// ── A converted book, built the way foundry's vlm-convert emitter writes one ──

const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>One</title></head>
<body>
<h1 data-bf-page="1" data-bf-cat="title">Working Towards the Fuhrer</h1>
<p data-bf-page="1" data-bf-cat="text">The first paragraph of the book, which is ordinary body prose and long enough to align.</p>
<p data-bf-page="2" data-bf-cat="text">A second paragraph on the following page, also ordinary and also long enough to align cleanly.</p>
<blockquote data-bf-page="2" data-bf-cat="quote"><p>An epigraph set apart from the body of the chapter.</p></blockquote>
<p data-bf-page="2" data-bf-cat="caption">Figure 1. The caption belonging to the plate above.</p>
<p data-bf-page="3" data-bf-cat="footnote">1. Kershaw, Ian. Working Towards the Fuhrer, page two hundred and eleven.</p>
</body>
</html>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:test</dc:identifier>
<dc:title>Working Towards the Fuhrer</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="c1" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`;

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** A book with no stamps at all — the other input class. */
const PLAIN_CHAPTER = CHAPTER
  .replace(/ data-bf-page="\d+"/g, '')
  .replace(/ data-bf-cat="[a-z-]+"/g, '');

async function buildEpub(name, chapterXhtml) {
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(OPF, 'utf8'));
  zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(chapterXhtml, 'utf8'));
  const out = path.join(ROOT, name);
  await zip.write(out);
  return out;
}

// ── The SAME book with pictures in it ────────────────────────────────────────
//
// Two shapes, and both are the real ones. `cover.xhtml` holds ONE `<img>` and no
// text at all — the case that made this change necessary, because such a
// document had nothing that could be struck and so was never emptied and never
// pruned. The chapter holds an INLINE plate between two paragraphs, which is the
// other half: a picture that has to come out without its document going with it.

const COVER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body><div class="cover"><img src="images/cover.jpg" alt=""/></div></body>
</html>`;

const PLATE = '<p data-bf-page="2" data-bf-cat="picture">'
  + '<img src="images/plate.jpg" alt="Plate 1"/></p>';

/** The stamped chapter, with one plate between the second paragraph and the quote. */
const CHAPTER_WITH_PLATE = CHAPTER.replace(
  '<blockquote data-bf-page="2"',
  `${PLATE}\n<blockquote data-bf-page="2"`);

/** The same chapter carrying TWO plates — the refusal case, when only one is laid out. */
const CHAPTER_WITH_TWO_PLATES = CHAPTER_WITH_PLATE.replace(
  '<p data-bf-page="3" data-bf-cat="footnote">',
  '<p data-bf-page="3" data-bf-cat="picture"><img src="images/plate2.jpg" alt="Plate 2"/></p>\n'
  + '<p data-bf-page="3" data-bf-cat="footnote">');

const OPF_WITH_COVER = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:test</dc:identifier>
<dc:title>Working Towards the Fuhrer</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="cov" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
<item id="coverimg" href="images/cover.jpg" media-type="image/jpeg"/>
</manifest>
<spine><itemref idref="cov"/><itemref idref="c1"/></spine>
<guide><reference type="cover" href="cover.xhtml" title="Cover"/></guide>
</package>`;

/** A two-document book: an image-only cover, then a chapter. */
async function buildIllustratedEpub(name, chapterXhtml) {
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(OPF_WITH_COVER, 'utf8'));
  zip.addFile('OEBPS/cover.xhtml', Buffer.from(COVER, 'utf8'));
  zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(chapterXhtml, 'utf8'));
  zip.addFile('OEBPS/images/cover.jpg', Buffer.from('JPEGBYTES', 'utf8'));
  zip.addFile('OEBPS/images/plate.jpg', Buffer.from('JPEGBYTES', 'utf8'));
  const out = path.join(ROOT, name);
  await zip.write(out);
  return out;
}

/** The zip entries of a written book. */
async function entriesOf(epubPath) {
  const reader = new ZipReader(epubPath);
  await reader.open();
  try {
    return reader.getEntries();
  } finally {
    reader.close();
  }
}

/** The chapter's prose, laid out — the aligner's block shape. */
const CHAPTER_TEXTS = [
  'Working Towards the Fuhrer',
  'The first paragraph of the book, which is ordinary body prose and long enough to align.',
  'A second paragraph on the following page, also ordinary and also long enough to align cleanly.',
  'An epigraph set apart from the body of the chapter.',
  'Figure 1. The caption belonging to the plate above.',
  '1. Kershaw, Ian. Working Towards the Fuhrer, page two hundred and eleven.',
];

/**
 * The illustrated book AS MUPDF LAYS IT OUT: the cover picture on its own page,
 * then the chapter's prose with the plate sitting between the second paragraph
 * and the epigraph — which is where it is in the markup.
 */
function illustratedLayout() {
  const push = (over) => ({
    page: 1, text: '', deleted: false, isImage: false, isFootnoteMarker: false, ...over,
  });
  return [
    push({ id: 'cover-img', page: 0, y: 0, text: '[Image 600x900]', isImage: true }),
    ...CHAPTER_TEXTS.map((text, i) => push({ id: `t${i}`, y: i * 100, text })),
    // Between the second paragraph (t2, y=200) and the epigraph (t3, y=300),
    // which is where the plate sits in the markup.
    push({ id: 'plate-img', y: 250, text: '[Image 400x300]', isImage: true }),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── keys ───────────────────────────────────────────────────────────────────
  await check('an element key is <file>#<index>, and round-trips', () => {
    const key = narrationElementKey('OEBPS/chapter-01.xhtml', 12);
    assert.strictEqual(key, 'OEBPS/chapter-01.xhtml#12');
    assert.deepStrictEqual(parseNarrationElementKey(key),
      { file: 'OEBPS/chapter-01.xhtml', index: 12, kind: 'unit' });
  });

  // The SECOND namespace, and the whole point of its being second: a picture
  // gets an identity without a single text unit being renumbered, so every
  // strike already recorded in the library still names what it named.
  await check('an image key is <file>#img<N>, in its own namespace', () => {
    const key = narrationImageElementKey('OEBPS/cover.xhtml', 0);
    assert.strictEqual(key, 'OEBPS/cover.xhtml#img0');
    assert.deepStrictEqual(parseNarrationElementKey(key),
      { file: 'OEBPS/cover.xhtml', index: 0, kind: 'image' });
    assert.notStrictEqual(key, narrationElementKey('OEBPS/cover.xhtml', 0));
  });

  await check('a key with no index is refused by name', () => {
    assert.throws(() => parseNarrationElementKey('OEBPS/chapter-01.xhtml'),
      /not a narration element key/);
    assert.throws(() => parseNarrationElementKey('#3'), /not a narration element key/);
    // `Number('')` is 0, so a key that says "image" and no number would read as
    // image 0 if the digits were not checked as characters first.
    assert.throws(() => parseNarrationElementKey('OEBPS/c.xhtml#img'),
      /not a narration element key/);
    assert.throws(() => parseNarrationElementKey('OEBPS/c.xhtml#'),
      /not a narration element key/);
    assert.throws(() => narrationImageElementKey('OEBPS/c.xhtml', -1), /whole number/);
  });

  // ── the category map ──────────────────────────────────────────────────────
  await check('every dots category maps to a palette id', () => {
    for (const cat of VLM_CATEGORIES) {
      const mapped = blockCategoryForVlm(cat, 'test');
      assert.ok(typeof mapped === 'string' && mapped.length > 0, `${cat} mapped to ${mapped}`);
    }
    assert.strictEqual(blockCategoryForVlm('section-header', 'test'), 'heading');
    assert.strictEqual(blockCategoryForVlm('picture', 'test'), 'image');
    assert.strictEqual(blockCategoryForVlm('list-item', 'test'), 'list');
  });

  // foundry's chapter stamp (Aug 2026). Its whole point is that it lands on the
  // class the Chapter tab lists and the book splits at — a book stamped
  // `chapter` that came out as `heading` would be a converted book with no
  // chapters, which is what this stamp exists to stop.
  await check('a chapter opening stamp is the chapter class, not a heading', () => {
    assert.strictEqual(blockCategoryForVlm('chapter', 'test'), 'chapter');
    assert.ok(VLM_CATEGORIES.includes('chapter'));
  });

  await check('a category BookForge does not know throws naming it', () => {
    assert.throws(() => blockCategoryForVlm('page-header', 'the book'),
      /data-bf-cat="page-header"/);
  });

  // ── the progress parser ───────────────────────────────────────────────────
  await check('the MLX progress line reports page N of M', () => {
    const p = parseVlmProgressLine(
      'vlm-convert: page 3/317 — 1300x2112, 4210 chars, 1203 tokens, 0.31s render, 18.2s inference');
    assert.deepStrictEqual({ done: p.done, total: p.total }, { done: 3, total: 317 });
  });

  await check('the endpoint line counts the pages IT was asked for, not the PDF page', () => {
    const p = parseVlmProgressLine('vlm-convert: page 12 (4/40) — 3980 chars, 900 tokens, 2.1s');
    assert.deepStrictEqual({ done: p.done, total: p.total }, { done: 4, total: 40 });
  });

  await check('a line that says nothing about progress is null', () => {
    assert.strictEqual(parseVlmProgressLine('vlm-convert: model resident in 12.3s'), null);
    assert.strictEqual(parseVlmProgressLine('some other program: page 3/9'), null);
  });

  // ── the narration copy's own name ─────────────────────────────────────────
  await check('the narration copy is named after the book, beside it', () => {
    assert.strictEqual(
      narrationEpubRelPath('source/Working Towards The Fuhrer. Kershaw, Ian. (1993).epub'),
      'source/Working Towards The Fuhrer. Kershaw, Ian. (1993).tts.epub');
  });

  await check('a book that is not an EPUB has no narration copy to name', () => {
    assert.throws(() => narrationEpubRelPath('source/original.pdf'), /which is not an EPUB/);
  });

  // The three files of one project are SIBLINGS, all three named after the
  // archive file: what you handed us, what you edit, what narration reads.
  // Appending to the working copy's whole stem would make the third read as a
  // copy of the second (`X.working.tts.epub`), which is a different claim.
  await check('the narration copy is a sibling of the working copy, not a copy of it', () => {
    assert.strictEqual(
      narrationEpubRelPath('source/Killing America. Bailey, Gene.working.epub'),
      'source/Killing America. Bailey, Gene.tts.epub');
    // Case is not a second rule: the marker is written by one derivation, and
    // this only has to agree with it about what the marker IS.
    assert.strictEqual(
      narrationEpubRelPath('source/A Book.WORKING.epub'), 'source/A Book.tts.epub');
    // A ".working" that is part of the book's own NAME rather than the marker
    // keeps its extension-position meaning — there is exactly one marker, and it
    // is the last thing before `.epub`.
    assert.strictEqual(
      narrationEpubRelPath('source/Still Working.working.epub'),
      'source/Still Working.tts.epub');
  });

  // ── deriving the record from the editor ───────────────────────────────────
  //
  // The laid-out block shape the derivation reads: a page (mupdf's own
  // pagination of the book), the element it was laid out from, and whether it is
  // furniture the aligner never places.
  const laid = (id, page, element, extra) => ({
    id, page, excerpt: `${id} text`, unplaceable: false,
    ...(element === null ? {} : { element }), ...extra,
  });

  await check('the record is the deleted blocks\' elements, deduped and sorted', () => {
    const blocks = [
      laid('b1', 0, 'OEBPS/c1.xhtml#0'),
      laid('b2', 0, 'OEBPS/c1.xhtml#1'),
      // Two blocks of ONE element — mupdf lays a paragraph out per visual line.
      laid('b3', 0, 'OEBPS/c1.xhtml#1'),
      laid('b4', 1, 'OEBPS/c1.xhtml#2'),
      // No element: the aligner could not place it. Not deletable through this.
      laid('b5', 1, null),
    ];
    const strikes = deriveNarrationStrikes(blocks, new Set(['b2', 'b3', 'b5']), new Set());
    assert.deepStrictEqual(strikes.elements, ['OEBPS/c1.xhtml#1']);
    assert.strictEqual(strikes.fromBlocks, 1);
    assert.strictEqual(strikes.fromPages, 0);
  });

  // The bug this whole change exists for: 64 deleted pages and 58 deleted
  // blocks, and an export that read only the blocks. A page deletion is the
  // same statement as striking every block on it, and it has to reach the
  // record the cut is made from.
  await check('a deleted PAGE strikes every element laid out on it', () => {
    const blocks = [
      laid('b1', 0, 'OEBPS/c1.xhtml#0'),
      laid('b2', 3, 'OEBPS/c1.xhtml#7'),
      laid('b3', 3, 'OEBPS/c1.xhtml#8'),
      laid('b4', 4, 'OEBPS/c1.xhtml#9'),
    ];
    const strikes = deriveNarrationStrikes(blocks, new Set(['b1']), new Set([3]));
    assert.deepStrictEqual(strikes.elements,
      ['OEBPS/c1.xhtml#0', 'OEBPS/c1.xhtml#7', 'OEBPS/c1.xhtml#8']);
    assert.strictEqual(strikes.fromBlocks, 1, 'the block strike is counted as one');
    assert.strictEqual(strikes.fromPages, 2, 'the page added two the blocks did not name');
    assert.strictEqual(strikes.fromBlocks + strikes.fromPages, strikes.elements.length,
      'the two counts partition the set they describe');
  });

  await check('an element struck BOTH ways is counted once, as a block strike', () => {
    const blocks = [
      // One element, two laid-out lines: one of them individually struck, and
      // the page they are both on struck as well.
      laid('b1', 2, 'OEBPS/c1.xhtml#4'),
      laid('b2', 2, 'OEBPS/c1.xhtml#4'),
    ];
    const strikes = deriveNarrationStrikes(blocks, new Set(['b1']), new Set([2]));
    assert.deepStrictEqual(strikes.elements, ['OEBPS/c1.xhtml#4']);
    assert.strictEqual(strikes.fromBlocks, 1);
    assert.strictEqual(strikes.fromPages, 0);
  });

  await check('a deletion that can strike NOTHING is named, never dropped', () => {
    const blocks = [
      // Prose the aligner could not place: a real problem, and the user has to
      // be told, because the paragraph will be read aloud.
      laid('b1', 5, null),
      // Furniture: an image block and a footnote marker have no element BY
      // DESIGN, so they are not reported as failures.
      laid('b2', 5, null, { unplaceable: true }),
      laid('b3', 6, null, { unplaceable: true }),
    ];
    const strikes = deriveNarrationStrikes(blocks, new Set(['b1', 'b2']), new Set([6, 9]));

    assert.deepStrictEqual(strikes.elements, []);
    assert.strictEqual(strikes.unstruck.length, 1, 'only the prose block is a problem');
    assert.strictEqual(strikes.unstruck[0].blockId, 'b1');
    assert.strictEqual(strikes.unstruck[0].via, 'block');
    // Page 6 held nothing but furniture, and page 9 held nothing at all.
    assert.deepStrictEqual(strikes.pagesWithNothingStruck, [6, 9]);

    const said = describeUnstruckDeletions(strikes);
    assert.ok(/could not be matched/.test(said), said);
    assert.ok(/page 6/.test(said), said);  // 1-based in the user's terms
    assert.ok(/nothing on them that could be struck/.test(said), said);
    assert.strictEqual(describeUnstruckDeletions(
      deriveNarrationStrikes([laid('b1', 0, 'e#0')], new Set(['b1']), new Set())), null);
  });

  await check('a deleted block id this layout does not have is named', () => {
    const strikes = deriveNarrationStrikes(
      [laid('b1', 0, 'e#0')], new Set(['b1', 'ghost']), new Set());
    assert.deepStrictEqual(strikes.elements, ['e#0']);
    assert.deepStrictEqual(strikes.unknownBlockIds, ['ghost']);
    assert.ok(/ghost/.test(describeUnstruckDeletions(strikes)));
  });

  await check('re-opening strikes EVERY block of a struck element', () => {
    const blocks = [
      { id: 'b1', element: 'OEBPS/c1.xhtml#0' },
      { id: 'b2', element: 'OEBPS/c1.xhtml#1' },
      { id: 'b3', element: 'OEBPS/c1.xhtml#1' },
    ];
    assert.deepStrictEqual(
      narrationDeletedBlockIds(blocks, ['OEBPS/c1.xhtml#1']).sort(), ['b2', 'b3']);
  });

  await check('a source page selects every block that came off it', () => {
    const blocks = [
      { id: 'b1', element: 'e#0', sourcePage: 7 },
      { id: 'b2', element: 'e#1', sourcePage: 7 },
      { id: 'b3', element: 'e#2', sourcePage: 8 },
    ];
    assert.deepStrictEqual(narrationBlocksOnSourcePage(blocks, 7), ['b1', 'b2']);
  });

  // ── staleness ─────────────────────────────────────────────────────────────
  await check('a record stamped with another book is void, and says why', () => {
    const reason = narrationDeletionsStaleReason(
      { epubSha256: 'aaa', elements: [], updatedAt: 'x' }, 'bbb');
    assert.ok(/has changed since these deletions were made/.test(reason), reason);
    assert.strictEqual(
      narrationDeletionsStaleReason({ epubSha256: 'aaa', elements: [], updatedAt: 'x' }, 'aaa'),
      null);
    assert.strictEqual(narrationDeletionsStaleReason(null, 'aaa'), null);
  });

  // ── the plan ──────────────────────────────────────────────────────────────
  await check('a struck key that names no element stops the export by name', () => {
    const units = [
      { key: 'a#0', category: 'text', sourcePage: 1 },
      { key: 'a#1', category: 'footnote', sourcePage: 1 },
    ];
    assert.deepStrictEqual(planNarrationRemoval(units, ['a#1']),
      { remove: ['a#1'], total: 2 });
    assert.throws(() => planNarrationRemoval(units, ['a#1', 'a#9']), /a#9/);
  });

  // ── end to end, over a real book ──────────────────────────────────────────
  await check('a converted book is recognized by its stamps, and a plain one is not', async () => {
    const converted = await buildEpub('converted.epub', CHAPTER);
    const plain = await buildEpub('plain.epub', PLAIN_CHAPTER);
    assert.strictEqual(await epubCarriesConversionStamps(converted), true);
    assert.strictEqual(await epubCarriesConversionStamps(plain), false);
  });

  await check('an UNSTAMPED book still gives every block its element key', async () => {
    // The hole this closes: element keys used to be minted only for a book
    // carrying `data-bf-cat`, because the reader returned before the aligner
    // ever ran. So on a publisher's EPUB every block came back with no element,
    // the strike derivation skipped all of them, and striking a paragraph
    // recorded NOTHING — silently, looking exactly like it had worked.
    const laidOut = (text, i) => ({
      id: `b${i}`, page: 0, y: i * 20, text,
      deleted: false, isImage: false, isFootnoteMarker: false,
    });
    const blocks = [
      'Working Towards the Fuhrer',
      'The first paragraph of the book, which is ordinary body prose and long enough to align.',
      'A second paragraph on the following page, also ordinary and also long enough to align cleanly.',
      'An epigraph set apart from the body of the chapter.',
      'Figure 1. The caption belonging to the plate above.',
      '1. Kershaw, Ian. Working Towards the Fuhrer, page two hundred and eleven.',
    ].map(laidOut);

    const plain = await buildEpub('plain-stamps.epub', PLAIN_CHAPTER);
    const plainReading = await readEpubConversionStamps(plain, blocks);
    assert.strictEqual(plainReading.converted, false, 'a plain book states no categories');
    assert.strictEqual(plainReading.byBlockId.size, 0, 'and therefore no stamps');
    // `unaligned` is the LIST of blocks that could not be placed, and has been
    // since the aligner started saying which ones and why — this assertion had
    // been comparing that list to the number 0 and failing ever since.
    assert.deepStrictEqual(plainReading.unaligned, [], 'every block was placed in the markup');
    assert.strictEqual(plainReading.elementByBlockId.size, blocks.length,
      'but EVERY block knows which element it came from');
    assert.strictEqual(
      plainReading.elementByBlockId.get('b0'), 'OEBPS/chapter-01.xhtml#0');
    // Which is exactly what the picker needs to record a strike.
    assert.deepStrictEqual(
      deriveNarrationStrikes(
        blocks.map((b) => ({
          id: b.id, page: b.page, excerpt: b.text.slice(0, 80), unplaceable: false,
          element: plainReading.elementByBlockId.get(b.id),
        })),
        new Set(['b5']), new Set()).elements,
      [plainReading.elementByBlockId.get('b5')]);

    // The converted book answers the same keys AND its stamps.
    const converted = await buildEpub('converted-stamps.epub', CHAPTER);
    const reading = await readEpubConversionStamps(converted, blocks);
    assert.strictEqual(reading.converted, true);
    assert.strictEqual(reading.byBlockId.size, blocks.length);
    assert.deepStrictEqual(
      [...reading.elementByBlockId.entries()].sort(),
      [...plainReading.elementByBlockId.entries()].sort(),
      'the element key is a fact about the markup, not about the stamps');
    assert.strictEqual(reading.byBlockId.get('b5').statedCategory, 'footnote');
    assert.strictEqual(reading.byBlockId.get('b5').sourcePage, 3);
  });

  await check('every element of a converted book states its category and its page', async () => {
    const converted = await buildEpub('converted2.epub', CHAPTER);
    const units = await readEpubConversionUnits(converted);
    const stamped = units.filter((u) => u.category !== null);
    assert.strictEqual(stamped.length, 6, `expected 6 stamped units, got ${stamped.length}`);
    assert.deepStrictEqual(stamped.map((u) => u.category), [
      'title', 'text', 'text', 'quote', 'caption', 'footnote',
    ]);
    assert.deepStrictEqual(stamped.map((u) => u.sourcePage), [1, 1, 2, 2, 2, 3]);
    // The key of the first element is the first index of its own file.
    assert.strictEqual(stamped[0].key, 'OEBPS/chapter-01.xhtml#0');
  });

  await check('the narration copy loses what was struck, and the book keeps it', async () => {
    const converted = await buildEpub('converted3.epub', CHAPTER);
    const before = fs.readFileSync(converted);
    const units = await readEpubConversionUnits(converted);
    const struck = units
      .filter((u) => u.category === 'footnote' || u.category === 'caption')
      .map((u) => u.key);
    assert.strictEqual(struck.length, 2);

    const out = path.join(ROOT, 'converted3.tts.epub');
    const written = await writeNarrationEpub(converted, out, struck);
    assert.strictEqual(written.removedElements, 2);
    assert.strictEqual(written.totalElements, units.length);

    // THE OFFICIAL BOOK IS UNTOUCHED — byte for byte.
    assert.ok(before.equals(fs.readFileSync(converted)), 'the official book was rewritten');

    const after = await readEpubConversionUnits(out);
    const cats = after.filter((u) => u.category !== null).map((u) => u.category);
    assert.deepStrictEqual(cats, ['title', 'text', 'text', 'quote']);
  });

  await check('nothing struck writes the whole book', async () => {
    const converted = await buildEpub('converted4.epub', CHAPTER);
    const out = path.join(ROOT, 'converted4.tts.epub');
    const written = await writeNarrationEpub(converted, out, []);
    assert.strictEqual(written.removedElements, 0);
    assert.strictEqual(written.rewrittenFiles.length, 0);
    const after = await readEpubConversionUnits(out);
    assert.strictEqual(after.filter((u) => u.category !== null).length, 6);
  });

  await check('the export refuses a key the book does not have', async () => {
    const converted = await buildEpub('converted5.epub', CHAPTER);
    const out = path.join(ROOT, 'converted5.tts.epub');
    await assert.rejects(
      writeNarrationEpub(converted, out, ['OEBPS/chapter-01.xhtml#99']),
      /OEBPS\/chapter-01\.xhtml#99/);
    assert.ok(!fs.existsSync(out), 'a refused export wrote a file anyway');
  });

  // ── pictures ──────────────────────────────────────────────────────────────
  //
  // The measured hole (Aug 2026): the user struck out the cover, the half-title
  // and the title page — one `<img>` each, no text — and all three came through
  // to the narration copy. Nothing could be recorded for an image, so those
  // documents never emptied and the pruning never fired.

  await check('every picture of a book is an element with a key', async () => {
    const book = await buildIllustratedEpub('illustrated.epub', CHAPTER_WITH_PLATE);
    const units = await readEpubConversionUnits(book);
    const keys = units.map((u) => u.key);
    assert.ok(keys.includes('OEBPS/cover.xhtml#img0'),
      `the cover picture has no key: ${keys.join(', ')}`);
    assert.ok(keys.includes('OEBPS/chapter-01.xhtml#img0'),
      `the plate has no key: ${keys.join(', ')}`);
    // The TEXT numbering is untouched: the chapter's first element is still #0.
    assert.ok(keys.includes('OEBPS/chapter-01.xhtml#0'));
    // A bare `<img>` is ALSO an export unit (it is in the editable-block tag
    // set), so this element has a name in each namespace. That is redundancy
    // rather than ambiguity, and it is the safe direction: striking either name
    // removes the same element, the writer's `parentNode` guard makes removing
    // it twice a no-op, and an image BLOCK is only ever recorded under the image
    // name (image blocks never reach the text matcher, so nothing has to choose).
    assert.deepStrictEqual(
      keys.filter((k) => k.startsWith('OEBPS/cover.xhtml')).sort(),
      ['OEBPS/cover.xhtml#0', 'OEBPS/cover.xhtml#img0']);
    // And the conversion stamp on the element AROUND the plate is read for it.
    const plate = units.find((u) => u.key === 'OEBPS/chapter-01.xhtml#img0');
    assert.strictEqual(plate.category, 'picture');
    assert.strictEqual(plate.sourcePage, 2);
  });

  await check('an image block is matched to an image element by document and ordinal', async () => {
    const book = await buildIllustratedEpub('illustrated2.epub', CHAPTER_WITH_PLATE);
    const reading = await readEpubConversionStamps(book, illustratedLayout());
    assert.deepStrictEqual(reading.unaligned, [], 'the prose all placed');
    assert.deepStrictEqual(reading.unmatchedImages, [], 'both pictures placed');
    // The cover block lies BEFORE any aligned text, so only the counting rule
    // can put it in cover.xhtml — which is the case that matters, because an
    // image-only document has no text to bound it from the near side.
    assert.strictEqual(reading.elementByBlockId.get('cover-img'), 'OEBPS/cover.xhtml#img0');
    assert.strictEqual(reading.elementByBlockId.get('plate-img'), 'OEBPS/chapter-01.xhtml#img0');
    assert.strictEqual(reading.byBlockId.get('plate-img').statedCategory, 'picture');
  });

  // NO FALLBACKS: a count that does not add up is a refusal, not a guess. Two
  // plates in the markup and one on screen (mupdf drops images under 20×20, and
  // a spacer GIF is a real thing) must not silently strike the wrong one.
  await check('a picture the counts cannot settle is REFUSED and reported', async () => {
    const book = await buildIllustratedEpub('illustrated3.epub', CHAPTER_WITH_TWO_PLATES);
    const reading = await readEpubConversionStamps(book, illustratedLayout());
    // The chapter states two pictures and one was laid out — pairing by ordinal
    // would be a coin toss between the two plates, so neither is paired.
    assert.strictEqual(reading.elementByBlockId.get('plate-img'), undefined,
      'a picture was paired by ordinal despite the counts disagreeing');
    // And the COVER goes with it, which is the conservative answer rather than a
    // cascade failure: the cover block lies in a gap whose window ends in that
    // same over-supplied chapter, so "which document is it in" has two answers
    // too. A refusal costs the user a deletion they can see did nothing; a guess
    // costs them a plate out of the middle of somebody's book.
    assert.strictEqual(reading.elementByBlockId.get('cover-img'), undefined);
    assert.deepStrictEqual(
      reading.unmatchedImages.map((u) => u.blockId).sort(), ['cover-img', 'plate-img']);
    assert.ok(reading.unmatchedImages.every((u) => /image element/.test(u.reason)),
      JSON.stringify(reading.unmatchedImages.map((u) => u.reason)));
    // The PROSE is untouched: a picture nobody can place says nothing about text.
    assert.deepStrictEqual(reading.unaligned, []);
    assert.strictEqual(reading.elementByBlockId.get('t1'), 'OEBPS/chapter-01.xhtml#1');
  });

  await check('striking an image-only document\'s picture PRUNES the document', async () => {
    const book = await buildIllustratedEpub('illustrated4.epub', CHAPTER_WITH_PLATE);
    const before = fs.readFileSync(book);
    const out = path.join(ROOT, 'illustrated4.tts.epub');
    const written = await writeNarrationEpub(book, out, ['OEBPS/cover.xhtml#img0'], {
      stripSupMarkers: false,
    });
    assert.strictEqual(written.removedElements, 1);
    assert.deepStrictEqual(written.removedDocuments, ['OEBPS/cover.xhtml'],
      'the emptied cover was left in the book');
    assert.ok(before.equals(fs.readFileSync(book)), 'the official book was rewritten');

    const entries = await entriesOf(out);
    assert.ok(!entries.includes('OEBPS/cover.xhtml'), 'the pruned document is still in the zip');
    // Its IMAGE stays: assets are shared, and this removes documents, not files.
    assert.ok(entries.includes('OEBPS/images/cover.jpg'));

    // The package's own account of itself: manifest item, spine itemref and the
    // EPUB 2 guide reference all go with the document, or a strict reader
    // refuses the file and e2a reads a chapter title for a chapter that is gone.
    const reader = new ZipReader(out);
    await reader.open();
    let opf;
    try {
      opf = (await reader.readEntry('OEBPS/content.opf')).toString('utf8');
    } finally {
      reader.close();
    }
    assert.ok(!/cover\.xhtml/.test(opf), `cover.xhtml is still named in the package:\n${opf}`);
    assert.ok(/chapter-01\.xhtml/.test(opf), 'the surviving document left the package too');
  });

  await check('striking an INLINE picture removes it and keeps its document', async () => {
    const book = await buildIllustratedEpub('illustrated5.epub', CHAPTER_WITH_PLATE);
    const out = path.join(ROOT, 'illustrated5.tts.epub');
    const written = await writeNarrationEpub(book, out, ['OEBPS/chapter-01.xhtml#img0'], {
      stripSupMarkers: false,
    });
    assert.strictEqual(written.removedElements, 1);
    assert.deepStrictEqual(written.removedDocuments, [],
      'a chapter with prose left in it was pruned');
    const entries = await entriesOf(out);
    assert.ok(entries.includes('OEBPS/chapter-01.xhtml'));
    assert.ok(entries.includes('OEBPS/cover.xhtml'), 'an untouched document went missing');

    const reader = new ZipReader(out);
    await reader.open();
    let chapter;
    try {
      chapter = (await reader.readEntry('OEBPS/chapter-01.xhtml')).toString('utf8');
    } finally {
      reader.close();
    }
    assert.ok(!/plate\.jpg/.test(chapter), 'the struck picture is still in the chapter');
    assert.ok(/The first paragraph of the book/.test(chapter), 'the prose went with it');
  });

  await check('a text strike and an image strike do not disturb each other', async () => {
    const book = await buildIllustratedEpub('illustrated6.epub', CHAPTER_WITH_PLATE);
    const units = await readEpubConversionUnits(book);
    const footnote = units.find((u) => u.category === 'footnote').key;
    const out = path.join(ROOT, 'illustrated6.tts.epub');
    const written = await writeNarrationEpub(
      book, out, [footnote, 'OEBPS/cover.xhtml#img0'], { stripSupMarkers: false });
    assert.strictEqual(written.removedElements, 2);
    assert.deepStrictEqual(written.removedDocuments, ['OEBPS/cover.xhtml']);
    const after = await readEpubConversionUnits(out);
    assert.deepStrictEqual(
      after.filter((u) => u.category !== null).map((u) => u.category),
      // The chapter's text units, then its one image unit. `picture` appears
      // twice because the plate's `<p>` wrapper is a text unit and the `<img>`
      // inside it is an image unit — the same element under both names.
      ['title', 'text', 'text', 'picture', 'quote', 'caption', 'picture'],
      'the footnote left and everything else stayed, the plate included');
    assert.ok(!after.some((u) => u.key.startsWith('OEBPS/cover.xhtml')),
      'the pruned cover still has elements in the copy');
  });

  // ── the view, projected from the record ───────────────────────────────────
  await check('a page every strikeable block of which is struck reads as deleted', () => {
    const blocks = [
      laid('b1', 0, 'e#0'),
      laid('b2', 0, 'e#1'),
      laid('b3', 1, 'e#2'),
      // Furniture: a page holding nothing that can be struck is NOT deleted,
      // or every blank page in the book would go the moment anything else did.
      laid('b4', 2, null, { unplaceable: true }),
    ];
    assert.deepStrictEqual(
      [...narrationDeletedPages(blocks, new Set(['b1', 'b2']))], [0]);
    assert.deepStrictEqual(
      [...narrationDeletedPages(blocks, new Set(['b1']))], [],
      'a page with one of two blocks struck is not a deleted page');
    assert.deepStrictEqual(
      [...narrationDeletedPages(blocks, new Set(['b4']))], [],
      'a page of furniture reads as deleted by vacuous truth');
  });

  // ── the transaction ───────────────────────────────────────────────────────
  await check('an edit is the difference, both ways', () => {
    assert.deepStrictEqual(
      narrationDeletionEdit(new Set(['a#0', 'a#1']), new Set(['a#1', 'a#2'])),
      { strike: ['a#2'], unstrike: ['a#0'] });
    // The case the whole model turns on: a view that has just been reset. The
    // old snapshot save read this as "nothing is struck" and wrote it.
    assert.deepStrictEqual(
      narrationDeletionEdit(new Set(['a#0']), new Set(['a#0'])),
      { strike: [], unstrike: [] });
  });

  // ── the record, edited transactionally, on a real manifest ────────────────
  //
  // The bug this is the fix for: the picker used to DERIVE the whole record from
  // its view and overwrite the manifest with it. The view resets on every
  // document reload, so a derivation over a freshly-reset view was a perfectly
  // legitimate record with an evening's strikes missing from it. Main now
  // accumulates, under the project lock, and the picker sends differences.

  /** A library of one project, with a book on disk and a manifest that names it. */
  function makeProject(suffix) {
    const library = fs.mkdtempSync(path.join(ROOT, `lib-${suffix}-`));
    const projectId = 'Illustrated_-_A_Author_-_1999';
    const projectDir = path.join(library, 'projects', projectId);
    fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
    const bookRel = 'source/Illustrated.working.epub';
    const bookAbs = path.join(projectDir, 'source', 'Illustrated.working.epub');
    fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({
      version: 2,
      projectId,
      type: 'book',
      metadata: { title: 'Illustrated' },
      source: { type: 'epub', path: bookRel },
      outputs: { epub: { path: bookRel, modifiedAt: new Date().toISOString() } },
    }, null, 2));
    manifestService.setLibraryBasePath(library);
    return { projectDir, bookAbs, bookRel };
  }

  await check('a strike ACCUMULATES into the record rather than replacing it', async () => {
    const p = makeProject('accum');
    fs.copyFileSync(await buildIllustratedEpub('rec1.epub', CHAPTER_WITH_PLATE), p.bookAbs);
    const { sha256File } = require(path.join(DIST, 'electron', 'sidecar-binding.js'));
    const { sha256: sha } = await sha256File(p.bookAbs);

    const one = await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: ['OEBPS/chapter-01.xhtml#5'], unstrike: [] });
    assert.deepStrictEqual(one.deletions.elements, ['OEBPS/chapter-01.xhtml#5']);

    // A SECOND gesture that knows nothing about the first. Under the old
    // snapshot save this window's view would have replaced the record.
    const two = await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: ['OEBPS/cover.xhtml#img0'], unstrike: [] });
    assert.deepStrictEqual(two.deletions.elements,
      ['OEBPS/chapter-01.xhtml#5', 'OEBPS/cover.xhtml#img0']);
    assert.strictEqual(two.staleReason, null);

    // Idempotent: striking what is already struck changes nothing.
    const again = await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: ['OEBPS/cover.xhtml#img0'], unstrike: [] });
    assert.deepStrictEqual(again.deletions.elements,
      ['OEBPS/chapter-01.xhtml#5', 'OEBPS/cover.xhtml#img0']);

    // An UNSTRIKE takes exactly its own element back out.
    const undone = await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: [], unstrike: ['OEBPS/cover.xhtml#img0'] });
    assert.deepStrictEqual(undone.deletions.elements, ['OEBPS/chapter-01.xhtml#5']);

    // Unstriking something that is not struck is not an error — an undo of a
    // gesture whose element another gesture had already taken back is a real
    // sequence, and refusing it would make undo fail on a legal history.
    const noop = await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: [], unstrike: ['OEBPS/cover.xhtml#img0'] });
    assert.deepStrictEqual(noop.deletions.elements, ['OEBPS/chapter-01.xhtml#5']);

    // The record on disk says the same thing — nothing is held in memory.
    const onDisk = await manifestService.readNarrationDeletions(p.projectDir);
    assert.deepStrictEqual(onDisk.elements, ['OEBPS/chapter-01.xhtml#5']);
    assert.strictEqual(onDisk.epubSha256, sha);
  });

  await check('an edit against a book that has moved on CLEARS and refuses', async () => {
    const p = makeProject('stale');
    fs.copyFileSync(await buildIllustratedEpub('rec2.epub', CHAPTER_WITH_PLATE), p.bookAbs);
    const { sha256File } = require(path.join(DIST, 'electron', 'sidecar-binding.js'));
    const { sha256: sha } = await sha256File(p.bookAbs);

    await manifestService.editNarrationDeletions(
      p.projectDir, sha, { strike: ['OEBPS/chapter-01.xhtml#5'], unstrike: [] });

    // A simplify or translate pass rewrites the book in place; every position
    // after the first change moves. Merging into that record would be striking
    // paragraphs at random.
    const answer = await manifestService.editNarrationDeletions(
      p.projectDir, 'a-different-book-entirely',
      { strike: ['OEBPS/chapter-01.xhtml#2'], unstrike: [] });
    assert.strictEqual(answer.deletions, null);
    assert.ok(/has changed since these deletions were made/.test(answer.staleReason),
      answer.staleReason);
    assert.strictEqual(await manifestService.readNarrationDeletions(p.projectDir), null,
      'the void record was left on disk');
  });

  await check('concurrent edits compose — none is lost to the read-modify-write', async () => {
    const p = makeProject('concurrent');
    fs.copyFileSync(await buildIllustratedEpub('rec3.epub', CHAPTER_WITH_PLATE), p.bookAbs);
    const { sha256File } = require(path.join(DIST, 'electron', 'sidecar-binding.js'));
    const { sha256: sha } = await sha256File(p.bookAbs);

    // Fired together, deliberately: the read and the write are one locked
    // transaction in manifest-service precisely so this cannot drop one.
    await Promise.all(
      ['#0', '#1', '#2', '#3', '#4'].map((k) => manifestService.editNarrationDeletions(
        p.projectDir, sha, { strike: [`OEBPS/chapter-01.xhtml${k}`], unstrike: [] })));
    const onDisk = await manifestService.readNarrationDeletions(p.projectDir);
    assert.deepStrictEqual(onDisk.elements, [
      'OEBPS/chapter-01.xhtml#0', 'OEBPS/chapter-01.xhtml#1', 'OEBPS/chapter-01.xhtml#2',
      'OEBPS/chapter-01.xhtml#3', 'OEBPS/chapter-01.xhtml#4',
    ]);
  });

  // ── report ────────────────────────────────────────────────────────────────
  for (const [status, name, message] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
})();
