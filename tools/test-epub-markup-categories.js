/**
 * Tests for reading a PUBLISHER's EPUB structure —
 * `readEpubMarkupCategories` in electron/epub-processor.ts and the way
 * electron/pdf-analyzer.ts uses it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-epub-markup-categories.js
 *
 * The book under test is shaped like the real ones this exists for: an EPUB 2
 * with a `toc.ncx` navMap, headings set as `<h1>`/`<h2>` in one document and as
 * bare styled `<p>` in another (Killing America, Harrison House 2024, carries
 * ZERO `<h1>`–`<h6>` across 21 documents), notes bound to their references by
 * `<sup><a href="#fn-1">` and nothing else, a figure with a caption, a
 * blockquote and a list.
 *
 * Four things are worth a test.
 *
 * THE MAPPING, because it is the contract: what a tag means, what `epub:type`
 * means, and what the link between a `<sup>` and the paragraph carrying the id
 * it points at means. A plain `<p>` is body text, which is a STATE and not a
 * fallback.
 *
 * THE CHAPTER OPENINGS, because that is what the Chapter tab lists. Both
 * answers: the structural one (the document opens with a heading tag) and the
 * one for books that use no heading tags at all (the navigation label names the
 * opening). Exactly ONE chapter block per document, because two would put the
 * same chapter in the tab twice.
 *
 * NO PAGE FURNITURE, because that is the bug. mupdf reflows an EPUB onto pages
 * of its own invention, so "near the bottom of the page" is a fact about the
 * reflow window — measured on Killing America it put `footer` on 34 paragraphs
 * of ordinary prose.
 *
 * STAMPED BOOKS ARE UNTOUCHED, because a book that states its categories must
 * keep stating them: none of this may run for one.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-epub-markup-'));
// The analyzer's caches resolve against the Electron userData dir, which does
// not exist outside the app. Point them at the temp tree BEFORE anything loads.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  readEpubMarkupCategories, readEpubTocTargets, ZipWriter,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));

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

// ── Fixture: an EPUB 2 shaped like a publisher's ────────────────────────────

const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
  + '  <rootfiles>\n'
  + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
  + '  </rootfiles>\n</container>\n';

// A per-run nonce in the identifier makes every fixture a new file, so the
// analysis cache (keyed by sha256) can never answer out of a previous run.
const RUN_NONCE = path.basename(ROOT);

const DOCS = ['fm01', 'ch01', 'ch02', 'copy', 'notes'];

const OPF = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pub-id">\n'
  + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
  + `    <dc:identifier id="pub-id">urn:uuid:${RUN_NONCE}-${title}</dc:identifier>\n`
  + `    <dc:title>${title}</dc:title>\n`
  + '    <dc:language>en</dc:language>\n'
  + '  </metadata>\n  <manifest>\n'
  + '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
  + DOCS.map((d) => `    <item id="${d}" href="${d}.xhtml" media-type="application/xhtml+xml"/>\n`).join('')
  + '    <item id="plate" href="plate.png" media-type="image/png"/>\n'
  + '  </manifest>\n  <spine toc="ncx">\n'
  + DOCS.map((d) => `    <itemref idref="${d}"/>\n`).join('')
  + '  </spine>\n</package>\n';

// The navMap: five entries, and only three of the documents they name open with
// anything the reader can call a chapter heading.
const NCX = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
  + '<head><meta name="dtb:uid" content="x"/></head>\n'
  + '<docTitle><text>Publisher Book</text></docTitle>\n<navMap>\n'
  + '<navPoint id="n1" playOrder="1"><navLabel><text>Endorsements</text></navLabel>'
  + '<content src="fm01.xhtml"/></navPoint>\n'
  + '<navPoint id="n2" playOrder="2"><navLabel><text>Chapter 1: Killing America</text></navLabel>'
  + '<content src="ch01.xhtml"/></navPoint>\n'
  + '<navPoint id="n3" playOrder="3"><navLabel><text>Chapter 2: An Opportunity to Hope</text></navLabel>'
  + '<content src="ch02.xhtml"/></navPoint>\n'
  + '<navPoint id="n4" playOrder="4"><navLabel><text>Copyright Page</text></navLabel>'
  + '<content src="copy.xhtml"/></navPoint>\n'
  + '<navPoint id="n5" playOrder="5"><navLabel><text>Notes</text></navLabel>'
  + '<content src="notes.xhtml"/></navPoint>\n'
  + '</navMap>\n</ncx>\n';

const PAGE = (bodyMarkup) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
  + '<head><title>x</title></head>\n<body>\n' + bodyMarkup + '\n</body>\n</html>\n';

// fm01: the STRUCTURAL answer — the document opens with heading tags, and the
// second one is the rest of that heading rather than a second chapter.
const FM01 = [
  '<h1>ENDORSEMENTS</h1>',
  '<h2>What people said about it</h2>',
  '<p>This book is a practical and sometimes blunt account of how we as a nation got here.</p>',
  '<blockquote><p>Everyone works towards the leader along the lines he would wish.</p></blockquote>',
  '<ul><li>Bracher, The German Dictatorship</li><li>Broszat, The Hitler State</li></ul>',
  '<figure><img src="plate.png" alt="a plate"/><figcaption>The author at his desk, 1974.</figcaption></figure>',
  '<table><tr><td>Koreans</td><td>171781</td></tr></table>',
].join('\n');

// ch01: the LABEL answer — no heading tag anywhere. The chapter number and the
// chapter title are styled paragraphs, exactly as Killing America sets them, and
// the navMap label is what says which of them is the opening.
const CH01 = [
  '<p class="cn"><b>1</b></p>',
  '<p class="ct">KILLING AMERICA</p>',
  '<p class="co">Look, it is no secret. We all know what is going down and it has been escalating '
    + 'for quite a while now, worse than we could have imagined.<sup><a href="#fn-1" id="fn_1">1</a></sup></p>',
  '<p class="tx">Our blessed America, the land of the free and home of the brave, the country we '
    + 'love, is being killed in cold blood by people who mean it.<sup><a href="#fn-2" id="fn_2">2</a></sup></p>',
  '<p class="h1">THEY ARE KILLING AMERICA</p>',
  '<p class="fn"><span class="fn"><a href="#fn_1" id="fn-1">1.</a></span>Thomas Paine, '
    + 'Common Sense (London: H.D. Symonds, 1776), Thomas Paine Society.</p>',
  '<p class="fn"><span class="fn"><a href="#fn_2" id="fn-2">2.</a></span>Julie Miller, '
    + 'A republic if you can keep it (Washington: Library of Congress, 2022).</p>',
].join('\n');

// ch02: the label answer again, with the number and the title set on ONE line —
// the run is one element long and the whole of it is the opening.
const CH02 = [
  '<p class="ct">2 AN OPPORTUNITY TO HOPE</p>',
  '<p class="tx">This is a unique way to start a chapter, but we wanted to use an illustration '
    + 'from a film that most people have already seen at least once.</p>',
].join('\n');

// copy: a navigation entry whose document opens with nothing that names it. No
// chapter block may be invented for it.
const COPY = [
  '<p class="crt">Copyright 2024 by the authors. All rights reserved worldwide.</p>',
  '<p class="crt">No portion of this book may be reproduced, stored in a retrieval system, or '
    + 'transmitted in any form or by any means without the prior permission of the publisher.</p>',
].join('\n');

// notes: the OTHER way a book says "these are notes" — epub:type on the section
// that holds them. The headings inside it are still headings: the tag is the
// more specific evidence, and a notes section's own headings are how a reader
// finds the notes for chapter one.
const NOTES = [
  '<section epub:type="endnotes">',
  '<h1>Notes</h1>',
  '<p>Kershaw, The Nazi Dictatorship, chapter four, discusses this at some length indeed.</p>',
  '<h2>Chapter One</h2>',
  '<p>Broszat, The Hitler State, is still the standard account of that whole argument today.</p>',
  '</section>',
].join('\n');

// A real 1×1 PNG, so mupdf draws the <figure>'s image instead of laying out its
// alt text as a text block nothing in the markup can be matched to.
const PLATE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

async function writePublisherEpub(name) {
  const out = path.join(ROOT, name);
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(OPF(name), 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(NCX, 'utf8'));
  zip.addFile('OEBPS/plate.png', PLATE_PNG);
  for (const [doc, body] of [
    ['fm01', FM01], ['ch01', CH01], ['ch02', CH02], ['copy', COPY], ['notes', NOTES],
  ]) {
    zip.addFile(`OEBPS/${doc}.xhtml`, Buffer.from(PAGE(body), 'utf8'));
  }
  await zip.write(out);
  return out;
}

/** A picker block in the aligner's input shape. Nothing is deleted at analysis time. */
function block(id, page, y, text, extra) {
  return Object.assign(
    { id, page, y, text, deleted: false, isImage: false, isFootnoteMarker: false },
    extra || {});
}

// The blocks mupdf hands back for that book, in reading order. Text matches the
// markup exactly, which is what the aligner compares.
const BLOCKS = [
  block('fm-h1', 0, 10, 'ENDORSEMENTS'),
  block('fm-h2', 0, 30, 'What people said about it'),
  block('fm-p', 0, 60, 'This book is a practical and sometimes blunt account of how we as a nation got here.'),
  block('fm-q', 0, 100, 'Everyone works towards the leader along the lines he would wish.'),
  block('fm-l1', 0, 140, 'Bracher, The German Dictatorship'),
  block('fm-l2', 0, 155, 'Broszat, The Hitler State'),
  block('fm-cap', 0, 200, 'The author at his desk, 1974.'),
  block('fm-tab', 0, 240, 'Koreans171781'),

  block('c1-num', 1, 10, '1'),
  block('c1-title', 1, 40, 'KILLING AMERICA'),
  block('c1-p1', 1, 80, 'Look, it is no secret. We all know what is going down and it has been escalating '
    + 'for quite a while now, worse than we could have imagined.1'),
  block('c1-p2', 1, 140, 'Our blessed America, the land of the free and home of the brave, the country we '
    + 'love, is being killed in cold blood by people who mean it.2'),
  block('c1-h', 1, 200, 'THEY ARE KILLING AMERICA'),
  // The two notes sit at the very bottom of the reflowed page — which is exactly
  // where the old classifier read `footer` off, and where the markup reads the
  // id the <sup> above points at.
  block('c1-fn1', 1, 760, '1.Thomas Paine, Common Sense (London: H.D. Symonds, 1776), Thomas Paine Society.'),
  block('c1-fn2', 1, 780, '2.Julie Miller, A republic if you can keep it (Washington: Library of Congress, 2022).'),
  block('c1-ref1', 1, 82, '1', { isFootnoteMarker: true }),

  block('c2-title', 2, 10, '2 AN OPPORTUNITY TO HOPE'),
  block('c2-p', 2, 50, 'This is a unique way to start a chapter, but we wanted to use an illustration '
    + 'from a film that most people have already seen at least once.'),

  block('cp-1', 3, 10, 'Copyright 2024 by the authors. All rights reserved worldwide.'),
  block('cp-2', 3, 40, 'No portion of this book may be reproduced, stored in a retrieval system, or '
    + 'transmitted in any form or by any means without the prior permission of the publisher.'),

  block('nt-h', 4, 10, 'Notes'),
  block('nt-p', 4, 40, 'Kershaw, The Nazi Dictatorship, chapter four, discusses this at some length indeed.'),
  block('nt-h2', 4, 80, 'Chapter One'),
  block('nt-p2', 4, 110, 'Broszat, The Hitler State, is still the standard account of that whole argument today.'),
];

(async () => {
  const epub = await writePublisherEpub('publisher.epub');

  // ── The table of contents ─────────────────────────────────────────────────

  await check('the EPUB 2 navMap is read in navigation order, with its labels', async () => {
    const targets = await readEpubTocTargets(epub);
    assert.strictEqual(targets.length, 5);
    assert.deepStrictEqual(targets.map((t) => t.label), [
      'Endorsements', 'Chapter 1: Killing America', 'Chapter 2: An Opportunity to Hope',
      'Copyright Page', 'Notes',
    ]);
    assert.deepStrictEqual(targets[1].entryCandidates, ['OEBPS/ch01.xhtml']);
    assert.strictEqual(targets[1].fragment, null);
  });

  // ── The mapping ───────────────────────────────────────────────────────────

  let reading;
  await check('every block is placed in the markup it was laid out from', async () => {
    reading = await readEpubMarkupCategories(epub, BLOCKS);
    assert.deepStrictEqual(reading.unaligned, [], 'every fixture block should align');
    for (const b of BLOCKS) {
      if (b.isFootnoteMarker) continue;
      assert.ok(reading.elementByBlockId.has(b.id), `${b.id} should carry an element key`);
    }
  });

  const cat = (id) => reading.byBlockId.get(id);

  await check('a tag that means something is read as what it means', async () => {
    assert.strictEqual(cat('fm-p'), 'body', 'a plain <p> IS body text — a state, not a fallback');
    assert.strictEqual(cat('fm-q'), 'quote', 'a <p> inside a <blockquote> is the quote');
    assert.strictEqual(cat('fm-l1'), 'list', 'an <li> is its <ul>');
    assert.strictEqual(cat('fm-l2'), 'list');
    assert.strictEqual(cat('fm-cap'), 'caption', 'the only text a <figure> carries is its caption');
    assert.strictEqual(cat('fm-tab'), 'table');
    assert.strictEqual(cat('fm-h2'), 'heading');
    assert.strictEqual(cat('c1-h'), 'body',
      'a styled <p> mid-chapter says nothing in markup, and body text is what it says');
  });

  await check('a note is found by the <sup> that points at it, with no epub:type anywhere', async () => {
    assert.ok(reading.noterefs >= 2, `expected note references, found ${reading.noterefs}`);
    assert.strictEqual(cat('c1-fn1'), 'footnote');
    assert.strictEqual(cat('c1-fn2'), 'footnote');
    // The paragraphs the notes point BACK at must not become footnotes: the
    // backlink is not a reference.
    assert.strictEqual(cat('c1-p1'), 'body');
    assert.strictEqual(cat('c1-p2'), 'body');
    // The superscript marker never reaches the aligner — it duplicates its
    // parent's text — but the book has just proved it carries note references.
    assert.strictEqual(cat('c1-ref1'), 'footnote');
  });

  await check('epub:type on the section that holds the notes says the same thing', async () => {
    assert.strictEqual(cat('nt-p'), 'footnote');
    assert.strictEqual(cat('nt-p2'), 'footnote');
    assert.strictEqual(cat('nt-h2'), 'heading',
      'the heading OF a notes section is a heading — the tag is the more specific evidence');
  });

  // ── The chapter openings ──────────────────────────────────────────────────

  await check('a document that opens with a heading tag opens a chapter', async () => {
    assert.strictEqual(cat('fm-h1'), 'chapter');
    assert.strictEqual(cat('nt-h'), 'chapter',
      'the navigation lists the notes as a top-level entry, so the book itself says it is one');
  });

  await check('a book with no heading tags opens its chapters where the navMap says', async () => {
    assert.strictEqual(cat('c1-num'), 'chapter',
      'the navMap says ch01 is "Chapter 1: Killing America"; the document spells that over two '
      + 'elements, and the first of them is the opening');
    assert.strictEqual(cat('c1-title'), 'heading',
      'the rest of the opening is the chapter\'s heading, not a second chapter');
    assert.strictEqual(cat('c2-title'), 'chapter',
      'ch02 spells the whole label on one line');
  });

  await check('exactly one chapter block per document the navigation names', async () => {
    const byDoc = new Map();
    for (const [id, c] of reading.byBlockId) {
      if (c !== 'chapter') continue;
      const key = reading.elementByBlockId.get(id).split('#')[0];
      byDoc.set(key, (byDoc.get(key) || 0) + 1);
    }
    for (const [doc, n] of byDoc) {
      assert.strictEqual(n, 1, `${doc} carries ${n} chapter blocks; two rows would be one chapter twice`);
    }
    assert.strictEqual(reading.chapterOpenings, 4,
      'fm01, ch01, ch02 and the notes open; the copyright page names nothing and does not');
  });

  await check('a navigation entry whose document names nothing gets no chapter invented for it', async () => {
    assert.strictEqual(cat('cp-1'), 'body');
    assert.strictEqual(cat('cp-2'), 'body');
  });

  // ── End to end through the analyzer the picker calls ──────────────────────

  const { PDFAnalyzer } = require(path.join(DIST, 'electron', 'pdf-analyzer.js'));
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

  let analysis;
  await check('the analyzer says its categories came off the markup', async () => {
    analysis = await analyzed(epub);
    assert.strictEqual(analysis.categoryProvenance.source, 'markup');
    assert.ok(analysis.categoryProvenance.stampedBlocks > 0);
    assert.strictEqual(analysis.categoryProvenance.unstampedElementBlocks, 0,
      'every aligned element yields a category, so none can be aligned-but-unstated');
  });

  await check('NO page furniture is invented for a reflow', async () => {
    const furniture = analysis.blocks.filter(
      (b) => b.category_id === 'header' || b.category_id === 'footer');
    assert.deepStrictEqual(
      furniture.map((b) => `${b.category_id}: ${b.text.slice(0, 40)}`), [],
      'an EPUB has no running heads and no folios — mupdf invented the pages');
  });

  await check('the chapter openings reach the picker as `chapter` blocks', async () => {
    const chapters = analysis.blocks.filter((b) => b.category_id === 'chapter' && !b.is_image);
    const docs = chapters.map((b) => b.bf_element.split('#')[0]).sort();
    assert.deepStrictEqual(docs, [
      'OEBPS/ch01.xhtml', 'OEBPS/ch02.xhtml', 'OEBPS/fm01.xhtml', 'OEBPS/notes.xhtml',
    ]);
  });

  await check('every category is a member of the one palette', async () => {
    const { BLOCK_CATEGORY_IDS } = require(path.join(DIST, 'shared', 'ocr', 'block-categories.js'));
    const legal = new Set(BLOCK_CATEGORY_IDS);
    for (const b of analysis.blocks) {
      assert.ok(legal.has(b.category_id),
        `block ${b.id} carries category "${b.category_id}", which is not in the palette`);
    }
  });

  // ── A stamped book is untouched ───────────────────────────────────────────
  //
  // The SAME markup with foundry's stamps on it. Every stamp here contradicts
  // what the markup alone would say, so if any of this reader ran, the test
  // would see it: the <h1> that opens a navMap target would come back `chapter`
  // rather than the stated `title`, and the note bound by its <sup> would come
  // back `footnote` rather than the stated `body`.

  const STAMPED = [
    '<h1 data-bf-category="title" data-bf-group="p0001" data-bf-blocks="p0001b001">ENDORSEMENTS</h1>',
    '<p data-bf-category="quote" data-bf-group="p0002" data-bf-blocks="p0002b001">'
      + 'This book is a practical and sometimes blunt account of how we as a nation got here.</p>',
    '<p data-bf-category="body" data-bf-group="p0003" data-bf-blocks="p0003b001">'
      + '<span><a href="#fn-9" id="fn_9">9</a></span>Thomas Paine, Common Sense, Thomas Paine Society.</p>',
  ].join('\n');

  async function writeStampedEpub(name) {
    const out = path.join(ROOT, name);
    const zip = new ZipWriter();
    zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
    zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
    zip.addFile('OEBPS/content.opf', Buffer.from(
      OPF(name).replace(/<item id="(ch01|ch02|copy|notes)"[^>]*>\n/g, '')
        .replace(/<itemref idref="(ch01|ch02|copy|notes)"\/>\n/g, ''), 'utf8'));
    zip.addFile('OEBPS/toc.ncx', Buffer.from(NCX, 'utf8'));
    zip.addFile('OEBPS/plate.png', PLATE_PNG);
    zip.addFile('OEBPS/fm01.xhtml', Buffer.from(PAGE(STAMPED), 'utf8'));
    await zip.write(out);
    return out;
  }

  await check('a stamped book keeps its stamped categories — none of this runs for one', async () => {
    const stamped = await writeStampedEpub('stamped.epub');
    const result = await analyzed(stamped);
    assert.strictEqual(result.categoryProvenance.source, 'document',
      'the stamps are the record; the markup reader must not have been reached');
    const by = (re) => result.blocks.find((b) => re.test(b.text));
    assert.strictEqual(by(/ENDORSEMENTS/).category_id, 'title',
      'the book says `title` even though the navMap names this document and the tag is <h1>');
    assert.strictEqual(by(/practical and sometimes blunt/).category_id, 'quote',
      'the book says `quote` even though the tag is a plain <p>');
    assert.strictEqual(by(/Thomas Paine/).category_id, 'body',
      'the book says `body` even though an anchor points at this paragraph\'s id');
    assert.strictEqual(by(/ENDORSEMENTS/).bf_group, 'p0001');
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
