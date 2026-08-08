/**
 * Tests for reading a book's OWN record of its block categories —
 * `readEpubBlockProvenance` in electron/epub-processor.ts and the way
 * electron/pdf-analyzer.ts uses it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-epub-provenance.js
 *
 * Three things are worth a test here.
 *
 * THE RULE, because it is the whole point: where an element states
 * `data-bf-category`, that value IS the block's category — used verbatim, never
 * as a hint — and it travels with the group id and the working PDF's source
 * block ids. Includes the outermost-element case (`<ul>` stamped, `<li>` not)
 * and the container case (`<blockquote>` stamped, its `<p>` not), which are
 * where a naive read-the-attribute-off-the-unit would come back empty.
 *
 * THE REFUSAL, because the alternative is silence. A stamped category BookForge
 * does not know is a disagreement between two programs about what a category is,
 * and dropping it would leave the block wearing a guess while the book plainly
 * says otherwise. It throws naming the value.
 *
 * THE TWO INPUT CLASSES, end to end through the real analyzer, because that is
 * the bug Owen reported: the same heading, in two byte-identical books but for
 * the stamps, comes back `chapter` from the book that states it and `title` from
 * the book that states nothing. The second is not a degraded first — it is a
 * different kind of input, it is the only reading available for it, and the
 * result says which one the caller got.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-epub-provenance-'));
// The analyzer's caches resolve against the Electron userData dir, which does
// not exist outside the app. Point them at the temp tree BEFORE anything loads.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  readEpubBlockProvenance, epubCarriesProvenance, ZipWriter,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.then(
      () => { results.push(['ok', name]); },
      (err) => { failures++; results.push(['FAIL', name, err && err.message]); },
    );
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
  return Promise.resolve();
}

// ── Fixture: a minimal EPUB3, shaped like foundry's own output ──────────────

const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
  + '  <rootfiles>\n'
  + '    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>\n'
  + '  </rootfiles>\n</container>\n';

// The analysis cache lives under the user's real Documents\BookForge\cache and
// is keyed by the file's sha256, so a fixture with fixed bytes would be answered
// out of the PREVIOUS run's cache and the extraction path would never run again.
// A per-run nonce in the identifier makes every fixture a new file; the entries
// it leaves are removed at the end (see clearFixtureCaches).
const RUN_NONCE = path.basename(ROOT);

const OPF = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">\n'
  + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
  + `    <dc:identifier id="pub-id">urn:uuid:${RUN_NONCE}-${title}</dc:identifier>\n`
  + `    <dc:title>${title}</dc:title>\n`
  + '    <dc:language>en</dc:language>\n'
  + '    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>\n'
  + '  </metadata>\n  <manifest>\n'
  + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
  + '    <item id="s0001" href="text/s0001.xhtml" media-type="application/xhtml+xml"/>\n'
  + '  </manifest>\n  <spine>\n    <itemref idref="s0001"/>\n  </spine>\n</package>\n';

const NAV = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">\n'
  + '<head><meta charset="utf-8"/><title>Contents</title></head>\n<body>\n'
  + '  <nav epub:type="toc" id="toc">\n    <h1>Contents</h1>\n'
  + '    <ol><li><a href="text/s0001.xhtml">Section</a></li></ol>\n  </nav>\n'
  + '</body>\n</html>\n';

const PAGE = (bodyMarkup, title) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">\n'
  + `<head><meta charset="utf-8"/><title>${title}</title></head>\n<body>\n`
  + bodyMarkup + '\n</body>\n</html>\n';

async function writeEpub(name, bodyMarkup, title) {
  const out = path.join(ROOT, name);
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('EPUB/package.opf', Buffer.from(OPF(title), 'utf8'));
  zip.addFile('EPUB/nav.xhtml', Buffer.from(NAV, 'utf8'));
  zip.addFile('EPUB/text/s0001.xhtml', Buffer.from(PAGE(bodyMarkup, title), 'utf8'));
  await zip.write(out);
  return out;
}

/** A picker block in the aligner's input shape. Nothing is deleted at analysis time. */
function block(id, y, text) {
  return { id, page: 0, y, text, deleted: false, isImage: false, isFootnoteMarker: false };
}

// The book, as foundry's emitter writes it: the stamp on the OUTERMOST element
// of a group — the <ul> and not each <li>, the <blockquote> and not its <p>.
const STAMPED_BODY = [
  '<h1 data-bf-category="chapter" data-bf-group="p0001" data-bf-blocks="p0006b003">Working Towards the Fuhrer</h1>',
  '<p data-bf-category="body" data-bf-group="p0002" data-bf-blocks="p0001b001 p0001b002">'
    + 'The renewed emphasis on the intertwined fates of the Soviet Union and Germany has become intensified.</p>',
  '<blockquote data-bf-category="quote" data-bf-group="p0003" data-bf-blocks="p0002b001">'
    + '<p>Everyone works towards the Fuhrer along the lines he would wish.</p></blockquote>',
  '<ul data-bf-category="list" data-bf-group="p0004" data-bf-blocks="p0003b001 p0003b002">\n'
    + '  <li>Bracher, The German Dictatorship</li>\n'
    + '  <li>Broszat, The Hitler State</li>\n</ul>',
  '<p data-bf-category="footnote" data-bf-group="p0005" data-bf-blocks="p0004b009">'
    + 'See the discussion in Kershaw, The Nazi Dictatorship, chapter four.</p>',
].join('\n');

const UNSTAMPED_BODY = STAMPED_BODY.replace(/ data-bf-(?:category|group|blocks)="[^"]*"/g, '');

// The SAME book as written by the OTHER emitter — `foundry vlm-convert`, which
// has no working PDF and no paragraph groups, and states instead what the model
// called each block and which page of the PDF it was read off. The two stamps
// never appear together: a book was written by reflow or by a vision model.
const CONVERTED_BODY = [
  '<h1 data-bf-page="6" data-bf-cat="title">Working Towards the Fuhrer</h1>',
  '<p data-bf-page="1" data-bf-cat="text">'
    + 'The renewed emphasis on the intertwined fates of the Soviet Union and Germany has become intensified.</p>',
  '<blockquote data-bf-page="2" data-bf-cat="quote">'
    + '<p>Everyone works towards the Fuhrer along the lines he would wish.</p></blockquote>',
  '<ul data-bf-page="3" data-bf-cat="list-item">\n'
    + '  <li>Bracher, The German Dictatorship</li>\n'
    + '  <li>Broszat, The Hitler State</li>\n</ul>',
  '<p data-bf-page="4" data-bf-cat="footnote">'
    + 'See the discussion in Kershaw, The Nazi Dictatorship, chapter four.</p>',
].join('\n');

// The blocks mupdf would hand back for that page, in reading order.
const FIXTURE_BLOCKS = [
  block('b1', 10, 'Working Towards the Fuhrer'),
  block('b2', 40, 'The renewed emphasis on the intertwined fates of the Soviet Union and Germany has become intensified.'),
  block('b3', 90, 'Everyone works towards the Fuhrer along the lines he would wish.'),
  block('b4', 130, 'Bracher, The German Dictatorship'),
  block('b5', 145, 'Broszat, The Hitler State'),
  block('b6', 180, 'See the discussion in Kershaw, The Nazi Dictatorship, chapter four.'),
];

(async () => {
  // ── The rule ──────────────────────────────────────────────────────────────

  const stampedEpub = await writeEpub('stamped.epub', STAMPED_BODY, 'Stamped');

  await check('a stamped book is recognized as one', async () => {
    assert.strictEqual(await epubCarriesProvenance(stampedEpub), true);
  });

  await check('every stamped element hands its category to the blocks laid out from it', async () => {
    const reading = await readEpubBlockProvenance(stampedEpub, FIXTURE_BLOCKS);
    assert.strictEqual(reading.stamped, true);
    // `unaligned` is the LIST of blocks that could not be placed, and has been
    // since the aligner started saying which ones and why.
    assert.deepStrictEqual(reading.unaligned, [], 'every fixture block should align');
    const cat = (id) => reading.byBlockId.get(id).category;
    assert.strictEqual(cat('b1'), 'chapter',
      'the heading is the book\'s own `chapter` — the heuristic calls this a `title`');
    assert.strictEqual(cat('b2'), 'body');
    assert.strictEqual(cat('b3'), 'quote', 'a <p> inside a stamped <blockquote> takes the quote\'s stamp');
    assert.strictEqual(cat('b4'), 'list', 'an <li> takes the stamp of its <ul>');
    assert.strictEqual(cat('b5'), 'list');
    assert.strictEqual(cat('b6'), 'footnote');
  });

  await check('the group and the working PDF\'s block ids travel with the category', async () => {
    const reading = await readEpubBlockProvenance(stampedEpub, FIXTURE_BLOCKS);
    assert.strictEqual(reading.byBlockId.get('b1').group, 'p0001');
    assert.deepStrictEqual(reading.byBlockId.get('b1').sourceBlockIds, ['p0006b003']);
    assert.deepStrictEqual(reading.byBlockId.get('b2').sourceBlockIds, ['p0001b001', 'p0001b002']);
  });

  await check('several blocks from one element share its group — that is the truth, not a collision', async () => {
    const reading = await readEpubBlockProvenance(stampedEpub, FIXTURE_BLOCKS);
    assert.strictEqual(reading.byBlockId.get('b4').group, 'p0004');
    assert.strictEqual(reading.byBlockId.get('b5').group, 'p0004');
  });

  // ── The refusal ───────────────────────────────────────────────────────────

  await check('a stamped category outside the one palette throws, naming the value', async () => {
    const bad = await writeEpub(
      'unknown-category.epub',
      '<p data-bf-category="marginalia" data-bf-group="p0001" data-bf-blocks="p0001b001">'
        + 'A category that exists in neither program\'s palette.</p>',
      'Unknown',
    );
    await assert.rejects(
      () => readEpubBlockProvenance(bad, [block('b1', 10, 'A category that exists in neither program\'s palette.')]),
      (err) => {
        assert.match(err.message, /marginalia/, 'the refusal must name the value it refused');
        assert.match(err.message, /block-categories\.ts/, 'and where the palette lives');
        return true;
      },
    );
  });

  await check('a partial stamp is a broken writer, not a missing value', async () => {
    const partial = await writeEpub(
      'partial-stamp.epub',
      '<p data-bf-category="body">Category but no group and no block ids.</p>',
      'Partial',
    );
    await assert.rejects(
      () => readEpubBlockProvenance(partial, [block('b1', 10, 'Category but no group and no block ids.')]),
      (err) => {
        assert.match(err.message, /data-bf-group/);
        return true;
      },
    );
  });

  // ── The two input classes ─────────────────────────────────────────────────

  const unstampedEpub = await writeEpub('unstamped.epub', UNSTAMPED_BODY, 'Unstamped');

  await check('a book that states nothing is a different input class, not a failure', async () => {
    assert.strictEqual(await epubCarriesProvenance(unstampedEpub), false);
    const reading = await readEpubBlockProvenance(unstampedEpub, FIXTURE_BLOCKS);
    assert.strictEqual(reading.stamped, false);
    assert.strictEqual(reading.byBlockId.size, 0);
    assert.deepStrictEqual(reading.unaligned, [],
      'nothing was attempted, so nothing failed — an unstamped book must not report alignment damage');
  });

  // End to end through the analyzer that the picker actually calls: the same
  // book twice, differing only in the stamps.
  const { PDFAnalyzer } = require(path.join(DIST, 'electron', 'pdf-analyzer.js'));

  // Cache entries these fixtures produce, cleaned up at the end — the analysis
  // cache is the user's own directory and this suite is a guest in it.
  const fixtureHashes = new Set();
  async function analyzed(epubPath) {
    const analyzer = new PDFAnalyzer();
    try {
      const result = await analyzer.analyze(epubPath);
      fixtureHashes.add(result.sourceSha256);
      return result;
    } finally {
      analyzer.close();
    }
  }
  const heading = (result) => result.blocks.find((b) => /Working Towards the Fuhrer/.test(b.text));

  await check('the analyzer reports which class it read, and takes the stamped category verbatim', async () => {
    const result = await analyzed(stampedEpub);
    assert.strictEqual(result.categoryProvenance.source, 'document');
    assert.ok(result.categoryProvenance.stampedBlocks > 0, 'blocks should have been stamped');
    assert.strictEqual(result.categoryProvenance.unalignedBlocks, 0);
    const h = heading(result);
    assert.strictEqual(h.category_id, 'chapter',
      'the book says `chapter`; nothing downstream may re-derive it');
    assert.strictEqual(h.bf_group, 'p0001');
    assert.deepStrictEqual(h.bf_blocks, ['p0006b003']);
  });

  // The THIRD input class: a book a document vision model read. Same book, same
  // analyzer, a different dialect of the same idea — and the thing that makes it
  // worth its own case is `bf_element`, which is what a narration strike is
  // recorded as. A block that reaches the picker without one cannot be struck.
  const convertedEpub = await writeEpub('converted.epub', CONVERTED_BODY, 'Converted');

  await check('a converted book states its categories, its source pages and its element keys', async () => {
    const result = await analyzed(convertedEpub);
    assert.strictEqual(result.categoryProvenance.source, 'document');
    assert.ok(result.categoryProvenance.stampedBlocks > 0, 'blocks should have been stamped');
    const h = heading(result);
    // `title` in dots' vocabulary, `title` in BookForge's — and NOT `chapter`:
    // dots was never asked which of the middle two heading levels this is, so
    // nothing invents an answer.
    assert.strictEqual(h.category_id, 'title');
    assert.strictEqual(h.bf_cat, 'title');
    assert.strictEqual(h.bf_source_page, 6, 'the PDF page, not the laid-out page');
    assert.match(h.bf_element, /^EPUB\/text\/s0001\.xhtml#\d+$/);
    // The reflow dialect's fields stay absent: a book speaks one of the two.
    assert.strictEqual(h.bf_group, undefined);
    assert.strictEqual(h.bf_blocks, undefined);

    const note = result.blocks.find((b) => /Nazi Dictatorship, chapter four/.test(b.text));
    assert.strictEqual(note.category_id, 'footnote');
    assert.strictEqual(note.bf_source_page, 4);
    const list = result.blocks.find((b) => /German Dictatorship/.test(b.text));
    assert.strictEqual(list.category_id, 'list', 'dots says list-item; the palette says list');
  });

  await check('the same book without stamps is classified, and says so', async () => {
    const result = await analyzed(unstampedEpub);
    assert.strictEqual(result.categoryProvenance.source, 'heuristic');
    assert.strictEqual(result.categoryProvenance.stampedBlocks, 0);
    const h = heading(result);
    assert.strictEqual(h.category_id, 'title',
      'THE BUG: large type that does not start with the word "chapter" reads as a title');
    assert.strictEqual(h.bf_group, undefined);
    assert.strictEqual(h.bf_blocks, undefined);
  });

  // Regression: found by the provenance counters themselves, which reported 30
  // blocks stamped AND 30 unaligned out of 30. analyzeText re-extracts the whole
  // document, but its EPUB branch appended page by page, so running it over the
  // blocks a cache-hit analyzeQuick had already restored gave the book two
  // copies of everything. The picker does not take that route, so nothing else
  // would have caught it.
  await check('re-extracting text over a cached analysis does not double the book', async () => {
    const analyzer = new PDFAnalyzer();
    try {
      const quick = await analyzer.analyzeQuick(stampedEpub);
      assert.strictEqual(quick.textReady, true, 'the earlier analyze() should have cached this fixture');
      const text = await analyzer.analyzeText(stampedEpub);
      assert.strictEqual(text.blocks.length, quick.blocks.length, 'no block may appear twice');
      assert.strictEqual(text.categoryProvenance.source, 'document');
      assert.strictEqual(text.categoryProvenance.unalignedBlocks, 0);
      assert.strictEqual(text.categoryProvenance.stampedBlocks, text.blocks.length);
    } finally {
      analyzer.close();
    }
  });

  const cleaner = new PDFAnalyzer();
  for (const hash of fixtureHashes) cleaner.clearCache(hash);

  // ── Report ────────────────────────────────────────────────────────────────
  for (const [status, name, message] of results) {
    console.log(`${status === 'ok' ? '  ok' : 'FAIL'}  ${name}${message ? `\n        ${message}` : ''}`);
  }
  console.log(`\n${results.length - failures}/${results.length} passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
