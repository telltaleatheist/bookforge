/**
 * Tests for what a book calls its chapters, and for the one edit that changes it
 * — `readChapterTitlesOfBook` and `renameChapterInBookFile` in
 * electron/book-chapters.ts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-chapter-titles.js
 *
 * Five things are worth a test here, and they are the five ways a rename can
 * fail to reach the audiobook.
 *
 * BOTH DIALECTS, because a chapter's name is written in an EPUB 3 navigation
 * document, in an EPUB 2 NCX, or in both, and this app used to refuse every book
 * that carried an NCX — which made a publisher EPUB's chapters unrenameable and
 * a user's sixteen renames go nowhere near the book.
 *
 * BOTH AT ONCE, because renaming one list of a book that carries two leaves the
 * two disagreeing, and which one a reader believes is then a property of the
 * reader. The test asserts the NCX and the nav were BOTH rewritten.
 *
 * THE SURGICAL EDIT, because the book is also an alignment baseline: the only
 * entries that may differ after a rename are the tables of contents and the
 * chapter document, and within them only the naming text. A byte diff of every
 * zip entry is the assertion.
 *
 * THE NESTING, because an NCX nests and the obvious way to read one — match
 * `<navPoint>` to `</navPoint>` — swallows the first child inside its parent and
 * loses a whole level of the table of contents without saying so.
 *
 * THE TWO REFUSALS, because both alternatives are silent damage: a document
 * named in several places would have a SECTION renamed instead of the chapter,
 * and an entry pointing outside the manifest is a malformed book whose chapter
 * title e2a would read for a chapter that does not exist.
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
if (!fs.existsSync(path.join(DIST, 'electron', 'book-chapters.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-chapter-titles-'));
// The manifest service resolves the library against the Electron userData dir,
// which does not exist outside the app. Point it at the temp tree BEFORE
// anything loads.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const { ZipReader, ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  readChapterTitlesOfBook, renameChapterInBookFile,
} = require(path.join(DIST, 'electron', 'book-chapters.js'));

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

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function chapterDoc(title, heading) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${title}</title>
</head>
<body>
  <h1 id="top">${heading}</h1>
  <p id="mid">Body text that no rename may touch.</p>
</body>
</html>`;
}

/** A document whose head names it NOTHING, self-closed — Killing America's shape. */
function emptyTitleDoc(heading) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<title xml:lang="en"/>
<link href="template.css" rel="stylesheet" type="text/css"/>
</head>
<body>
<p class="ct">${heading}</p>
</body>
</html>`;
}

/** An EPUB 2 NCX. `points` may nest through a `children` array. */
function ncxFile(points) {
  const render = (list, depth) => list.map((p) => {
    const indent = '  '.repeat(depth);
    const kids = p.children ? `\n${render(p.children, depth + 1)}` : '';
    return `${indent}<navPoint id="${p.id}" playOrder="${p.id}">`
      + `<navLabel><text>${p.label}</text></navLabel>`
      + `<content src="${p.src}"/>${kids}${kids ? `\n${indent}` : ''}</navPoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="test"/></head>
<docTitle><text>A Test Book</text></docTitle>
<navMap>
${render(points, 0)}
</navMap>
</ncx>`;
}

/** An EPUB 3 navigation document. */
function navFile(entries) {
  const items = entries
    .map((e) => `      <li><a href="${e.href}">${e.label}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
  <nav epub:type="landmarks">
    <ol><li><a href="ch01.xhtml">Start of content</a></li></ol>
  </nav>
</body>
</html>`;
}

function opfFile({ version, documents, withNav, withNcx }) {
  const manifest = [
    ...(withNcx ? ['    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'] : []),
    ...(withNav
      ? ['    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
      : []),
    ...documents.map((d) =>
      `    <item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`),
  ].join('\n');
  const spine = documents.map((d) => `    <itemref idref="${d.id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>A Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine${withNcx ? ' toc="ncx"' : ''}>
${spine}
  </spine>
</package>`;
}

async function writeEpub(name, entries) {
  const out = path.join(ROOT, name);
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  for (const [entry, text] of Object.entries(entries)) {
    zip.addFile(entry, Buffer.from(text, 'utf8'));
  }
  await zip.write(out);
  return out;
}

/** The three documents every fixture book contains. */
const DOCUMENTS = [
  { id: 'front', href: 'front.xhtml' },
  { id: 'ch01', href: 'ch01.xhtml' },
  { id: 'ch02', href: 'ch02.xhtml' },
];

const DOCUMENT_FILES = {
  'OEBPS/front.xhtml': chapterDoc('Foreword', 'FOREWORD'),
  'OEBPS/ch01.xhtml': chapterDoc('Chapter 1: The Fa&#x00E7;ade', 'CHAPTER ONE'),
  'OEBPS/ch02.xhtml': chapterDoc('Chapter 2: Drawing the Line', 'CHAPTER TWO'),
};

const NCX_POINTS = [
  { id: 'np-front', label: 'Foreword', src: 'front.xhtml' },
  { id: 'np-ch01', label: 'Chapter 1: The Fa&#x00E7;ade', src: 'ch01.xhtml' },
  { id: 'np-ch02', label: 'Chapter 2: Drawing the Line', src: 'ch02.xhtml' },
];

const NAV_ENTRIES = [
  { href: 'front.xhtml', label: 'Foreword' },
  { href: 'ch01.xhtml', label: 'Chapter 1: The Fa&#x00E7;ade' },
  { href: 'ch02.xhtml', label: 'Chapter 2: Drawing the Line' },
];

function ncxOnlyBook(name, points = NCX_POINTS) {
  return writeEpub(name, {
    'OEBPS/content.opf': opfFile({
      version: '2.0', documents: DOCUMENTS, withNav: false, withNcx: true,
    }),
    'OEBPS/toc.ncx': ncxFile(points),
    ...DOCUMENT_FILES,
  });
}

function navOnlyBook(name) {
  return writeEpub(name, {
    'OEBPS/content.opf': opfFile({
      version: '3.0', documents: DOCUMENTS, withNav: true, withNcx: false,
    }),
    'OEBPS/nav.xhtml': navFile(NAV_ENTRIES),
    ...DOCUMENT_FILES,
  });
}

function dualTocBook(name) {
  return writeEpub(name, {
    'OEBPS/content.opf': opfFile({
      version: '3.0', documents: DOCUMENTS, withNav: true, withNcx: true,
    }),
    'OEBPS/nav.xhtml': navFile(NAV_ENTRIES),
    'OEBPS/toc.ncx': ncxFile(NCX_POINTS),
    ...DOCUMENT_FILES,
  });
}

// ── Reading a book back ─────────────────────────────────────────────────────

async function entriesOf(epubPath) {
  const reader = new ZipReader(epubPath);
  await reader.open();
  try {
    const out = new Map();
    for (const name of reader.getEntries()) out.set(name, await reader.readEntry(name));
    return out;
  } finally {
    reader.close();
  }
}

/** Which zip entries differ between two books — the whole of "nothing else moved". */
async function changedEntries(before, after) {
  const a = await entriesOf(before);
  const b = await entriesOf(after);
  assert.deepStrictEqual([...b.keys()], [...a.keys()], 'the rewrite changed the zip\'s entry list');
  const changed = [];
  for (const [name, data] of a) {
    if (!data.equals(b.get(name))) changed.push(name);
  }
  return changed.sort();
}

async function textOf(epubPath, entry) {
  return (await entriesOf(epubPath)).get(entry).toString('utf8');
}

function titleOf(titles, file) {
  const row = titles.chapters.find((c) => c.file === file);
  assert.ok(row, `${file} is not in the chapter list`);
  return row.navTitle;
}

// ── The tests ───────────────────────────────────────────────────────────────

(async () => {
  await check('an NCX-only book lists its chapters', async () => {
    const book = await ncxOnlyBook('ncx-only.epub');
    const titles = await readChapterTitlesOfBook(book);
    assert.deepStrictEqual(titles.tocFiles, ['OEBPS/toc.ncx']);
    assert.deepStrictEqual(titles.chapters.map((c) => c.file), [
      'OEBPS/front.xhtml', 'OEBPS/ch01.xhtml', 'OEBPS/ch02.xhtml',
    ]);
    // The numeric character reference is read as the character it names: a title
    // shown with the escape still in it is one a user would "correct" by hand.
    assert.strictEqual(titleOf(titles, 'OEBPS/ch01.xhtml'), 'Chapter 1: The Façade');
    assert.strictEqual(titles.chapters[0].docTitle, 'Foreword');
  });

  await check('a nested navMap lists every level', async () => {
    const book = await ncxOnlyBook('ncx-nested.epub', [
      { id: 'np-front', label: 'Foreword', src: 'front.xhtml' },
      {
        id: 'np-part', label: 'Part One', src: 'ch01.xhtml',
        children: [{ id: 'np-ch02', label: 'Chapter 2: Drawing the Line', src: 'ch02.xhtml' }],
      },
    ]);
    const titles = await readChapterTitlesOfBook(book);
    assert.deepStrictEqual(titles.chapters.map((c) => c.navTitle), [
      'Foreword', 'Part One', 'Chapter 2: Drawing the Line',
    ]);
  });

  await check('renaming in an NCX-only book rewrites the navLabel and the document title', async () => {
    const book = await ncxOnlyBook('ncx-rename.epub');
    const out = path.join(ROOT, 'ncx-rename.out.epub');
    const answer = await renameChapterInBookFile(book, out, 'OEBPS/ch01.xhtml', 'One: The Facade');
    assert.strictEqual(answer.previousTitle, 'Chapter 1: The Façade');
    assert.deepStrictEqual(answer.rewrittenTocs, ['OEBPS/toc.ncx']);

    assert.deepStrictEqual(
      await changedEntries(book, out), ['OEBPS/ch01.xhtml', 'OEBPS/toc.ncx']);

    const ncx = await textOf(out, 'OEBPS/toc.ncx');
    assert.ok(ncx.includes('<navLabel><text>One: The Facade</text></navLabel>'), ncx);
    assert.ok(!ncx.includes('Fa&#x00E7;ade'), 'the old label is still in the NCX');
    assert.ok(ncx.includes('<text>Chapter 2: Drawing the Line</text>'), 'a sibling label moved');

    const chapter = await textOf(out, 'OEBPS/ch01.xhtml');
    assert.ok(chapter.includes('<title>One: The Facade</title>'), chapter);
    // The print is the print: the heading the page carried is untouched.
    assert.ok(chapter.includes('<h1 id="top">CHAPTER ONE</h1>'), 'the printed heading was rewritten');

    const titles = await readChapterTitlesOfBook(out);
    assert.strictEqual(titleOf(titles, 'OEBPS/ch01.xhtml'), 'One: The Facade');
  });

  await check('a book carrying both lists has both of them rewritten', async () => {
    const book = await dualTocBook('dual.epub');
    const titles = await readChapterTitlesOfBook(book);
    assert.deepStrictEqual(titles.tocFiles, ['OEBPS/nav.xhtml', 'OEBPS/toc.ncx']);
    // One row per DOCUMENT, however many lists name it.
    assert.strictEqual(titles.chapters.length, 3);

    const out = path.join(ROOT, 'dual.out.epub');
    const answer = await renameChapterInBookFile(book, out, 'OEBPS/ch02.xhtml', 'Two: The Line');
    assert.deepStrictEqual(answer.rewrittenTocs, ['OEBPS/nav.xhtml', 'OEBPS/toc.ncx']);
    assert.deepStrictEqual(
      await changedEntries(book, out),
      ['OEBPS/ch02.xhtml', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx']);

    const nav = await textOf(out, 'OEBPS/nav.xhtml');
    assert.ok(nav.includes('<a href="ch02.xhtml">Two: The Line</a>'), nav);
    const ncx = await textOf(out, 'OEBPS/toc.ncx');
    assert.ok(ncx.includes('<navLabel><text>Two: The Line</text></navLabel>'), ncx);
    assert.ok(!ncx.includes('Chapter 2: Drawing the Line'), 'the NCX still says the old title');
  });

  await check('a nav-only book renames exactly as it did before', async () => {
    const book = await navOnlyBook('nav-only.epub');
    const titles = await readChapterTitlesOfBook(book);
    assert.deepStrictEqual(titles.tocFiles, ['OEBPS/nav.xhtml']);

    const out = path.join(ROOT, 'nav-only.out.epub');
    const answer = await renameChapterInBookFile(book, out, 'OEBPS/ch01.xhtml', 'One: The Facade');
    assert.deepStrictEqual(answer.rewrittenTocs, ['OEBPS/nav.xhtml']);
    assert.deepStrictEqual(
      await changedEntries(book, out), ['OEBPS/ch01.xhtml', 'OEBPS/nav.xhtml']);

    const nav = await textOf(out, 'OEBPS/nav.xhtml');
    assert.ok(nav.includes('<a href="ch01.xhtml">One: The Facade</a>'), nav);
    // The landmarks nav links to the same document and is NOT a chapter list.
    assert.ok(nav.includes('<a href="ch01.xhtml">Start of content</a>'), 'the landmarks were edited');
  });

  await check('one document named by several navPoints is refused by name', async () => {
    const book = await ncxOnlyBook('ncx-ambiguous.epub', [
      { id: 'np-front', label: 'Foreword', src: 'front.xhtml' },
      { id: 'np-ch01-a', label: 'Chapter 1, part one', src: 'ch01.xhtml#top' },
      { id: 'np-ch01-b', label: 'Chapter 1, part two', src: 'ch01.xhtml#mid' },
      { id: 'np-ch02', label: 'Chapter 2: Drawing the Line', src: 'ch02.xhtml' },
    ]);
    const out = path.join(ROOT, 'ncx-ambiguous.out.epub');
    await assert.rejects(
      renameChapterInBookFile(book, out, 'OEBPS/ch01.xhtml', 'One'),
      (err) => /np-ch01-a/.test(err.message) && /np-ch01-b/.test(err.message));
    assert.ok(!fs.existsSync(out), 'a refused rename wrote a file anyway');

    // The document the SAME book names once is still renameable: the refusal is
    // about one chapter, not about the book.
    const ok = path.join(ROOT, 'ncx-ambiguous.ok.epub');
    await renameChapterInBookFile(book, ok, 'OEBPS/ch02.xhtml', 'Two');
    assert.deepStrictEqual(await changedEntries(book, ok), ['OEBPS/ch02.xhtml', 'OEBPS/toc.ncx']);
  });

  await check('an entry the manifest does not declare is refused by name', async () => {
    const book = await ncxOnlyBook('ncx-malformed.epub', [
      { id: 'np-front', label: 'Foreword', src: 'front.xhtml' },
      { id: 'np-ghost', label: 'Chapter 1: The Ghost', src: 'ghost.xhtml' },
    ]);
    const out = path.join(ROOT, 'ncx-malformed.out.epub');
    await assert.rejects(
      renameChapterInBookFile(book, out, 'OEBPS/front.xhtml', 'Foreword by Someone'),
      (err) => /np-ghost/.test(err.message) && /ghost\.xhtml/.test(err.message));
    await assert.rejects(
      readChapterTitlesOfBook(book), /ghost\.xhtml/);
    assert.ok(!fs.existsSync(out), 'a refused rename wrote a file anyway');
  });

  await check('a self-closing <title/> is filled in, not refused', async () => {
    const book = await writeEpub('empty-title.epub', {
      'OEBPS/content.opf': opfFile({
        version: '2.0', documents: DOCUMENTS, withNav: false, withNcx: true,
      }),
      'OEBPS/toc.ncx': ncxFile(NCX_POINTS),
      'OEBPS/front.xhtml': emptyTitleDoc('FOREWORD'),
      'OEBPS/ch01.xhtml': emptyTitleDoc('CHAPTER ONE'),
      'OEBPS/ch02.xhtml': emptyTitleDoc('CHAPTER TWO'),
    });
    const titles = await readChapterTitlesOfBook(book);
    // A head that names the document nothing states the empty string, and says so.
    assert.strictEqual(titles.chapters.find((c) => c.file === 'OEBPS/ch01.xhtml').docTitle, '');

    const out = path.join(ROOT, 'empty-title.out.epub');
    await renameChapterInBookFile(book, out, 'OEBPS/ch01.xhtml', 'One: The Facade');
    const chapter = await textOf(out, 'OEBPS/ch01.xhtml');
    // Rebuilt around the new name, with the element's own attributes kept.
    assert.ok(
      chapter.includes('<title xml:lang="en">One: The Facade</title>'), chapter);
    const reread = await readChapterTitlesOfBook(out);
    assert.strictEqual(
      reread.chapters.find((c) => c.file === 'OEBPS/ch01.xhtml').docTitle, 'One: The Facade');
  });

  await check('a navigation document that lists itself is edited once, not twice', async () => {
    // The printed contents page IS the nav: renaming it puts two edits in one
    // file, and rewriting that file twice from its original bytes would keep
    // only the second of them.
    const documents = [...DOCUMENTS, { id: 'nav', href: 'nav.xhtml' }];
    const book = await writeEpub('nav-self.epub', {
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>A Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${DOCUMENTS.map((d) => `    <item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${documents.map((d) => `    <itemref idref="${d.id}"/>`).join('\n')}
  </spine>
</package>`,
      'OEBPS/nav.xhtml': navFile([{ href: 'nav.xhtml', label: 'Contents' }, ...NAV_ENTRIES]),
      ...DOCUMENT_FILES,
    });

    const out = path.join(ROOT, 'nav-self.out.epub');
    await renameChapterInBookFile(book, out, 'OEBPS/nav.xhtml', 'Table of Contents');
    assert.deepStrictEqual(await changedEntries(book, out), ['OEBPS/nav.xhtml']);
    const nav = await textOf(out, 'OEBPS/nav.xhtml');
    assert.ok(nav.includes('<a href="nav.xhtml">Table of Contents</a>'), nav);
    assert.ok(nav.includes('<title>Table of Contents</title>'), nav);
    assert.ok(nav.includes('<a href="ch01.xhtml">Chapter 1: The Fa&#x00E7;ade</a>'), 'a sibling moved');
  });

  await check('a document no table of contents lists is refused', async () => {
    const book = await dualTocBook('dual-unlisted.epub');
    const out = path.join(ROOT, 'dual-unlisted.out.epub');
    await assert.rejects(
      renameChapterInBookFile(book, out, 'OEBPS/nowhere.xhtml', 'Nowhere'),
      /OEBPS\/nowhere\.xhtml/);
    assert.ok(!fs.existsSync(out), 'a refused rename wrote a file anyway');
  });

  await check('a book with no table of contents at all is refused', async () => {
    const book = await writeEpub('no-toc.epub', {
      'OEBPS/content.opf': opfFile({
        version: '3.0', documents: DOCUMENTS, withNav: false, withNcx: false,
      }),
      ...DOCUMENT_FILES,
    });
    await assert.rejects(readChapterTitlesOfBook(book), /no table of contents/);
  });

  // ── report ────────────────────────────────────────────────────────────────
  for (const [status, name, message] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
})();
