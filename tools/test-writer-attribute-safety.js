/**
 * Tests that every writer that rewrites a book's markup PRESERVES the attributes
 * on the elements it leaves behind.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-writer-attribute-safety.js
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * An element's attributes are not decoration. `data-bf-uid` is the element's
 * IDENTITY — the stable id that is replacing `<zip entry>#<index>` as the way a
 * narration strike, a chapter marker or a saved deletion names an element.
 * `data-bf-cat` is what the model that read the page said the block was.
 * `data-bf-user-cat` is what a PERSON said it was, which outranks every reading.
 * `data-bf-page` says which page it came off. `data-bf-category` /
 * `data-bf-group` / `data-bf-blocks` are the reflow's provenance and travel as a
 * set.
 *
 * A writer that emits an element without them destroys all of that silently, and
 * two of them were doing exactly that on 2026-08-10:
 *
 *   • `rebuildChapterPreservingHeadings` — the AI simplify/cleanup writer —
 *     rebuilt every chapter from scratch as bare `<p>` and `<h1>` with NO
 *     attributes at all, which was a live regression against the category
 *     override merged the same night.
 *   • `mergeXhtmlParagraphs` — run unconditionally over the simplify output —
 *     collected `<h1-6>` and `<p>` with a REGEX and rebuilt the body from only
 *     what it collected, silently deleting every `<div>`, `<blockquote>`, `<li>`,
 *     `<figure>` and loose `<img>` in it, and emitting attribute-free `<p>`.
 *
 * The other five round-trip today (xmldom serialize, or byte-exact string ops).
 * They are here so that stays true: this suite is the thing that fails when
 * somebody adds a writer, or changes one, without carrying the attributes.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-writer-attrs-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

// ai-bridge statically requires 'electron' for the power blocker; the CLI's own
// shim answers it, so the module under test loads exactly as it does headless.
require('../cli/electron-stub.js');

// It also loads its prompt files on import and calls a missing one FATAL, which
// `npm run build:electron` copies into dist and a bare `npx tsc` does not. Put
// them there — the same copy the build makes — so a suite about writers does not
// print an unrelated stack trace.
const PROMPTS = path.join(DIST, 'electron', 'prompts');
if (!fs.existsSync(PROMPTS)) {
  fs.cpSync(path.join(REPO, 'electron', 'prompts'), PROMPTS, { recursive: true });
}

const {
  ZipReader, ZipWriter,
  stripFootnoteReferencesFromBook,
  foldChapterOpeningInBookFile,
  nameChapterOpeningsInBookFile,
  setElementCategoryInBookFile,
  replaceBlockTexts,
  ELEMENT_UID_ATTR,
  USER_CATEGORY_ATTR,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const { mergeXhtmlParagraphs } = require(path.join(DIST, 'electron', 'epub-paragraph-merger.js'));
const { rebuildChapterPreservingHeadings } = require(path.join(DIST, 'electron', 'ai-bridge.js'));

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
 * A book whose every element is fully attributed: an identity, the model's
 * reading, a page number, and — on the chapter opening — a person's own word for
 * what the block is.
 */
const CHAPTER_ONE = [
  `<h1 ${ELEMENT_UID_ATTR}="a1a1a1a1" data-bf-page="7" data-bf-cat="title" `
  + `${USER_CATEGORY_ATTR}="chapter">II</h1>`,
  `<p ${ELEMENT_UID_ATTR}="b2b2b2b2" data-bf-page="7" data-bf-cat="text">The court rose at four `
  + 'and the corridor outside was already full<sup>12</sup>.</p>',
  `<p ${ELEMENT_UID_ATTR}="c3c3c3c3" data-bf-page="7" data-bf-cat="text">Twenty-one men sat in two `
  + 'rows, and none of them looked at each other.</p>',
  `<div class="image" ${ELEMENT_UID_ATTR}="d4d4d4d4" data-bf-page="8" data-bf-cat="picture">`
  + `<img ${ELEMENT_UID_ATTR}="e5e5e5e5" src="plate.png" alt="a plate"/></div>`,
].join('\n');

const CHAPTER_ZERO = [
  `<h1 ${ELEMENT_UID_ATTR}="f6f6f6f6" data-bf-page="1" data-bf-cat="chapter">The Nazi `
  + 'Revolution</h1>',
  `<p ${ELEMENT_UID_ATTR}="a7a7a7a7" data-bf-page="1" data-bf-cat="text">Hitler came to power in a `
  + 'country that had been governed by decree for three years.</p>',
  `<p ${ELEMENT_UID_ATTR}="b8b8b8b8" data-bf-page="2" data-bf-cat="text">The number above the `
  + 'chapter is a number, and the words beside it are the chapter.</p>',
];

function attributedBook(name = 'attributed.epub') {
  return writeEpub(name, {
    'OEBPS/content.opf': OPF3(['c0000', 'c0001']),
    'OEBPS/nav.xhtml': NAV([
      ['c0000.xhtml', 'The Nazi Revolution'],
      ['c0001.xhtml', 'Working Towards the Führer'],
    ]),
    'OEBPS/c0000.xhtml': PAGE('The Nazi Revolution', CHAPTER_ZERO.join('\n')),
    'OEBPS/c0001.xhtml': PAGE('Working Towards the Führer', CHAPTER_ONE),
  });
}

async function documentText(bookPath, entry) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    return (await reader.readEntry(entry)).toString('utf8');
  } finally {
    reader.close();
  }
}

/**
 * Every `data-bf-*` attribute the document carries, as a set of `name=value`
 * strings — the measurement every test below makes, because the QUESTION is
 * always "did anything the book said about its elements stop being said".
 */
function stampsIn(xhtml) {
  const out = new Set();
  const re = /(data-bf-[a-z-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xhtml)) !== null) out.add(`${m[1]}=${m[2]}`);
  return out;
}

function assertKeepsAll(before, after, what) {
  const missing = [...before].filter((s) => !after.has(s));
  assert.deepStrictEqual(missing, [], `${what} destroyed: ${missing.join(', ')}`);
}

// ── The tests ───────────────────────────────────────────────────────────────

async function run() {
  // ── The five that already round-tripped ──────────────────────────────────

  await check('the footnote-reference strip keeps every stamp', async () => {
    const book = await attributedBook('strip-in.epub');
    const before = stampsIn(await documentText(book, 'OEBPS/c0001.xhtml'));
    const out = path.join(ROOT, 'strip-out.epub');
    const strip = await stripFootnoteReferencesFromBook(book, out);
    assert.strictEqual(strip.removed, 1, 'the fixture marker was not found');
    const after = await documentText(out, 'OEBPS/c0001.xhtml');
    assert.ok(!after.includes('<sup>12</sup>'), 'the marker survived the strip');
    assertKeepsAll(before, stampsIn(after), 'the footnote strip');
  });

  await check('the fold keeps the opening\'s stamps and takes only what it folds', async () => {
    const book = await attributedBook('fold-in.epub');
    const out = path.join(ROOT, 'fold-out.epub');
    // Fold the second paragraph of c0000 into its chapter opening.
    await foldChapterOpeningInBookFile(
      book, out, 'OEBPS/c0000.xhtml#0', ['OEBPS/c0000.xhtml#2'], 'The Nazi Revolution');
    const after = stampsIn(await documentText(out, 'OEBPS/c0000.xhtml'));
    // The opening and the paragraph left standing keep everything.
    assert.ok(after.has(`${ELEMENT_UID_ATTR}=f6f6f6f6`), 'the opening lost its identity');
    assert.ok(after.has(`${ELEMENT_UID_ATTR}=a7a7a7a7`), 'an untouched paragraph lost its identity');
    assert.ok(after.has('data-bf-cat=chapter'), 'the opening lost its reading');
    // The folded element is GONE, so its identity is gone with it — correct.
    assert.ok(!after.has(`${ELEMENT_UID_ATTR}=b8b8b8b8`), 'a removed element kept its identity');
  });

  await check('the naming pass keeps every stamp', async () => {
    const book = await attributedBook('name-in.epub');
    const before = stampsIn(await documentText(book, 'OEBPS/c0001.xhtml'));
    const out = path.join(ROOT, 'name-out.epub');
    const named = await nameChapterOpeningsInBookFile(book, out, new Map([
      ['OEBPS/c0001.xhtml', 'Working Towards the Führer'],
    ]));
    assert.strictEqual(named.edits.length, 1,
      `nothing was named — skipped: ${JSON.stringify(named.skipped)}`);
    const after = await documentText(out, 'OEBPS/c0001.xhtml');
    assert.ok(after.includes('Working Towards the Führer</h1>'), 'the name was not written');
    assertKeepsAll(before, stampsIn(after), 'the naming pass');
  });

  await check('the relabel keeps every stamp and adds its own', async () => {
    const book = await attributedBook('relabel-in.epub');
    const before = stampsIn(await documentText(book, 'OEBPS/c0001.xhtml'));
    const out = path.join(ROOT, 'relabel-out.epub');
    await setElementCategoryInBookFile(book, out, 'OEBPS/c0001.xhtml#1', 'heading');
    const after = stampsIn(await documentText(out, 'OEBPS/c0001.xhtml'));
    assertKeepsAll(before, after, 'the relabel');
    assert.ok(after.has(`${USER_CATEGORY_ATTR}=heading`), 'the relabel was not written');
  });

  await check('translate\'s writer keeps every stamp', async () => {
    const xhtml = PAGE('Working Towards the Führer', CHAPTER_ONE);
    const before = stampsIn(xhtml);
    const after = replaceBlockTexts(xhtml, [
      'II', 'Le tribunal se leva à quatre heures.', 'Vingt et un hommes assis en deux rangées.',
    ]);
    assertKeepsAll(before, stampsIn(after), 'replaceBlockTexts');
    assert.ok(after.includes('Le tribunal'), 'the translation was not written');
  });

  // ── The simplify rebuild, which used to destroy all of it ────────────────

  await check('the simplify rebuild carries a 1:1 chapter\'s stamps through', async () => {
    const xhtml = PAGE('Working Towards the Führer', CHAPTER_ONE);
    const rebuilt = rebuildChapterPreservingHeadings(xhtml, [
      'The court rose at four and the corridor outside was already full.'
      + '\n\nTwenty-one men sat in two rows, and none of them looked at each other.',
    ]);
    const after = stampsIn(rebuilt);
    // The heading keeps its own three, INCLUDING the person's word for it.
    assert.ok(after.has(`${ELEMENT_UID_ATTR}=a1a1a1a1`), 'the heading lost its identity');
    assert.ok(after.has(`${USER_CATEGORY_ATTR}=chapter`), 'the heading lost the user\'s category');
    assert.ok(after.has('data-bf-cat=title'), 'the heading lost the model\'s reading');
    // Each paragraph keeps its own — not the other's.
    assert.ok(/<p [^>]*data-bf-uid="b2b2b2b2"[^>]*>The court rose/.test(rebuilt),
      `the first paragraph does not carry its own identity:\n${rebuilt}`);
    assert.ok(/<p [^>]*data-bf-uid="c3c3c3c3"[^>]*>Twenty-one men/.test(rebuilt),
      `the second paragraph does not carry its own identity:\n${rebuilt}`);
  });

  await check('a MERGED paragraph keeps the FIRST source\'s stamps, and only those', async () => {
    const xhtml = PAGE('Working Towards the Führer', CHAPTER_ONE);
    // The model ran the two paragraphs together into one.
    const rebuilt = rebuildChapterPreservingHeadings(xhtml, [
      'The court rose at four and the corridor outside was already full. '
      + 'Twenty-one men sat in two rows, and none of them looked at each other.',
    ]);
    assert.ok(/<p [^>]*data-bf-uid="b2b2b2b2"[^>]*>The court rose/.test(rebuilt),
      `the merged paragraph does not carry the first source's identity:\n${rebuilt}`);
    // The second source no longer exists as an element, so its identity is gone.
    assert.ok(!rebuilt.includes('c3c3c3c3'),
      'a merged-away element\'s identity survived onto an element that is not it');
  });

  await check('a SPLIT paragraph gives the first fragment the stamps and the rest none', async () => {
    const xhtml = PAGE('Working Towards the Führer', CHAPTER_ONE);
    // The model broke the first paragraph in two and left the second alone.
    const rebuilt = rebuildChapterPreservingHeadings(xhtml, [
      'The court rose at four.\n\nand the corridor outside was already full.'
      + '\n\nTwenty-one men sat in two rows, and none of them looked at each other.',
    ]);
    assert.ok(/<p [^>]*data-bf-uid="b2b2b2b2"[^>]*>The court rose at four\.<\/p>/.test(rebuilt),
      `the first fragment does not carry the source's identity:\n${rebuilt}`);
    assert.ok(/<p>and the corridor outside/.test(rebuilt),
      `the second fragment is not a new, unstamped element:\n${rebuilt}`);
    // And the split did NOT cascade: the paragraph after it keeps its OWN identity
    // rather than inheriting its neighbour's.
    assert.ok(/<p [^>]*data-bf-uid="c3c3c3c3"[^>]*>Twenty-one men/.test(rebuilt),
      `the split shifted the next paragraph's identity:\n${rebuilt}`);
  });

  // ── The paragraph merger, which used to delete half the body ─────────────

  await check('the merger keeps every non-paragraph element in the body', async () => {
    const xhtml = PAGE('A Page', [
      '<h1 data-bf-uid="1111aaaa">A Heading</h1>',
      '<p data-bf-uid="2222bbbb">A line with no full stop</p>',
      '<p data-bf-uid="3333cccc">that finishes here.</p>',
      '<blockquote data-bf-uid="4444dddd"><p>A quotation nobody may delete.</p></blockquote>',
      '<div class="image" data-bf-uid="5555eeee"><img src="plate.png" alt="a plate"/></div>',
      '<ul data-bf-uid="6666ffff"><li>A list item.</li></ul>',
      '<figure data-bf-uid="7777aaaa"><figcaption>A caption.</figcaption></figure>',
    ].join('\n'));

    const merged = mergeXhtmlParagraphs(xhtml);
    for (const survivor of ['blockquote', 'div', 'ul', 'li', 'figure', 'figcaption', 'img']) {
      assert.ok(merged.includes(`<${survivor}`), `the merger deleted every <${survivor}>`);
    }
    assert.ok(merged.includes('A quotation nobody may delete.'), 'the quotation was deleted');
    assert.ok(merged.includes('A list item.'), 'the list was deleted');
    assert.ok(merged.includes('A caption.'), 'the figure was deleted');
    // Every stamp survives EXCEPT the one on the paragraph the merge consumed —
    // that element no longer exists, so its identity goes with it.
    const expected = new Set(stampsIn(xhtml));
    expected.delete(`${ELEMENT_UID_ATTR}=3333cccc`);
    assertKeepsAll(expected, stampsIn(merged), 'the paragraph merger');
    assert.ok(!merged.includes('3333cccc'),
      'a merged-away paragraph\'s identity survived onto an element that is not it');
  });

  await check('the merger joins the run and the joined paragraph keeps the first\'s stamps', async () => {
    const xhtml = PAGE('A Page', [
      '<p data-bf-uid="2222bbbb" data-bf-cat="text">A line with no full stop</p>',
      '<p data-bf-uid="3333cccc" data-bf-cat="text">that finishes here.</p>',
    ].join('\n'));
    const merged = mergeXhtmlParagraphs(xhtml);
    assert.ok(
      /<p [^>]*data-bf-uid="2222bbbb"[^>]*>A line with no full stop that finishes here\.<\/p>/
        .test(merged),
      `the run did not merge into the first paragraph:\n${merged}`);
    assert.ok(!merged.includes('3333cccc'),
      'a merged-away paragraph\'s identity survived onto an element that is not it');
  });

  await check('the merger rejoins a word broken across two paragraphs', async () => {
    const xhtml = PAGE('A Page', [
      '<p data-bf-uid="2222bbbb">The excep-</p>',
      '<p data-bf-uid="3333cccc">tional case ends here.</p>',
    ].join('\n'));
    const merged = mergeXhtmlParagraphs(xhtml);
    assert.ok(merged.includes('The exceptional case ends here.'),
      `the hyphenated word was not rejoined:\n${merged}`);
  });

  await check('a document with nothing to merge comes back byte for byte', async () => {
    const xhtml = PAGE('A Page', [
      '<p data-bf-uid="2222bbbb">One complete sentence.</p>',
      '<p data-bf-uid="3333cccc">And another one.</p>',
    ].join('\n'));
    assert.strictEqual(mergeXhtmlParagraphs(xhtml), xhtml,
      'a document needing no merge was re-serialized anyway');
  });

  await check('a paragraph inside a container merges with its own siblings only', async () => {
    const xhtml = PAGE('A Page', [
      '<p data-bf-uid="1111aaaa">Outside the box with no stop</p>',
      '<div data-bf-uid="2222bbbb"><p data-bf-uid="3333cccc">Inside the box with no stop</p>'
      + '<p data-bf-uid="4444dddd">and its own ending.</p></div>',
    ].join('\n'));
    const merged = mergeXhtmlParagraphs(xhtml);
    assert.ok(merged.includes('<div'), 'the container was deleted');
    assert.ok(
      /<p [^>]*data-bf-uid="3333cccc"[^>]*>Inside the box with no stop and its own ending\.<\/p>/
        .test(merged),
      `the nested run did not merge inside its container:\n${merged}`);
    // The outside paragraph did NOT swallow the container's contents.
    assert.ok(!/Outside the box with no stop Inside/.test(merged),
      'a paragraph merged across a container boundary');
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
