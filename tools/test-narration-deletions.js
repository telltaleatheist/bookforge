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
  ZipWriter,
  epubCarriesConversionStamps,
  readEpubConversionStamps,
  readEpubConversionUnits,
  writeNarrationEpub,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  narrationElementKey,
  parseNarrationElementKey,
  narrationElementsOf,
  narrationDeletedBlockIds,
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

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── keys ───────────────────────────────────────────────────────────────────
  await check('an element key is <file>#<index>, and round-trips', () => {
    const key = narrationElementKey('OEBPS/chapter-01.xhtml', 12);
    assert.strictEqual(key, 'OEBPS/chapter-01.xhtml#12');
    assert.deepStrictEqual(parseNarrationElementKey(key),
      { file: 'OEBPS/chapter-01.xhtml', index: 12 });
  });

  await check('a key with no index is refused by name', () => {
    assert.throws(() => parseNarrationElementKey('OEBPS/chapter-01.xhtml'),
      /not a narration element key/);
    assert.throws(() => parseNarrationElementKey('#3'), /not a narration element key/);
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

  // ── deriving the record from the editor ───────────────────────────────────
  await check('the record is the deleted blocks\' elements, deduped and sorted', () => {
    const blocks = [
      { id: 'b1', element: 'OEBPS/c1.xhtml#0', sourcePage: 1 },
      { id: 'b2', element: 'OEBPS/c1.xhtml#1', sourcePage: 1 },
      // Two blocks of ONE element — mupdf lays a paragraph out per visual line.
      { id: 'b3', element: 'OEBPS/c1.xhtml#1', sourcePage: 1 },
      { id: 'b4', element: 'OEBPS/c1.xhtml#2', sourcePage: 2 },
      // No element: the aligner could not place it. Not deletable through this.
      { id: 'b5', sourcePage: 2 },
    ];
    const deleted = new Set(['b2', 'b3', 'b5']);
    assert.deepStrictEqual(narrationElementsOf(blocks, deleted), ['OEBPS/c1.xhtml#1']);
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
    // `narrationElementsOf` skipped all of them, and striking a paragraph
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
    assert.strictEqual(plainReading.unaligned, 0, 'every block was placed in the markup');
    assert.strictEqual(plainReading.elementByBlockId.size, blocks.length,
      'but EVERY block knows which element it came from');
    assert.strictEqual(
      plainReading.elementByBlockId.get('b0'), 'OEBPS/chapter-01.xhtml#0');
    // Which is exactly what the picker needs to record a strike.
    assert.deepStrictEqual(
      narrationElementsOf(
        blocks.map((b) => ({ id: b.id, element: plainReading.elementByBlockId.get(b.id) })),
        new Set(['b5'])),
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

  // ── report ────────────────────────────────────────────────────────────────
  for (const [status, name, message] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
})();
