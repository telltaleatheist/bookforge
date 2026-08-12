#!/usr/bin/env node
/**
 * Correcting what a book SAYS, in the book.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-block-text.js
 *
 * The writer under `book:set-block-text`. What it has to get right:
 *
 *  - the fix lands in the book's own markup, so every reader of the book sees it
 *    — that is the whole reason this stopped being an editor-state overlay;
 *  - the markup AROUND the change survives. An `<em>`, a footnote marker, the
 *    publisher's line breaks: a text fix is not permission to reflow a document;
 *  - the ELEMENT COUNT does not move. Keys are positions in the enumeration
 *    walk, so an edit that added or removed one would leave every narration
 *    strike below it naming the wrong element — the writer verifies this against
 *    the file it wrote, and so does this;
 *  - what it cannot do safely, it refuses, by name.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');

const {
  setElementTextInBookFile, ZipWriter, EpubProcessor,
} = require(path.join(DIST, 'electron/epub-processor.js'));
const {
  enumerateNarrationElements,
} = require(path.join(DIST, 'electron/quire-stamp.js'));

let passed = 0;
const failures = [];
let scratch = null;

async function check(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function refuses(fn, mustSay, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (err === null) throw new Error(`${what}: nothing was refused`);
  for (const phrase of mustSay) {
    if (!String(err.message).includes(phrase)) {
      throw new Error(`${what}: the refusal does not mention "${phrase}" — ${err.message}`);
    }
  }
}

// ── A book, built from a body ──────────────────────────────────────────────

let bookCounter = 0;
async function bookWith(body) {
  const out = path.join(scratch, `book-${++bookCounter}.epub`);
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>A</title></head><body>${body}</body></html>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:text-test</dc:identifier>
<dc:title>text test</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="d0" href="a.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine><itemref idref="d0"/></spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol><li><a href="a.xhtml">Start</a></li></ol></nav></body></html>`;

  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zw.addFile('OEBPS/a.xhtml', Buffer.from(xhtml, 'utf8'));
  await zw.write(out);
  return out;
}

/** The document's markup, as the book now holds it. */
async function documentOf(bookPath) {
  const processor = new EpubProcessor();
  try {
    await processor.open(bookPath);
    return await processor.readFile('OEBPS/a.xhtml');
  } finally { processor.close(); }
}

/** Every element the app enumerates in this book, key → its collapsed text. */
async function elementsOf(bookPath) {
  const { unitTextContent } = require(path.join(DIST, 'electron/epub-processor.js'));
  const out = new Map();
  for (const doc of await enumerateNarrationElements(bookPath, 'test')) {
    for (const entry of doc.entries) {
      if (entry.kind !== 'text') continue;
      out.set(entry.key, unitTextContent(entry.el).replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

/** Edit one element and hand back the book that came out. */
async function edit(bookPath, key, newText) {
  const out = path.join(scratch, `edited-${++bookCounter}.epub`);
  const result = await setElementTextInBookFile(bookPath, out, key, newText);
  return { out, result };
}

// ── The tests ──────────────────────────────────────────────────────────────

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'book-text-'));
  console.log('correcting a book\'s text\n');
  try {
    console.log('the fix lands in the book');
    await check('a wrong title is corrected, and the book reads it back', async () => {
      const book = await bookWith('<h1>A Chpater</h1><p>Body text follows.</p>');
      const { out, result } = await edit(book, 'OEBPS/a.xhtml#0', 'A Chapter');
      assert(result.written, 'nothing was written');
      assertEqual(result.edit.textBefore, 'A Chpater', 'what it read before');
      assertEqual(result.edit.textAfter, 'A Chapter', 'what it reads now');
      assertEqual((await elementsOf(out)).get('OEBPS/a.xhtml#0'), 'A Chapter', 'the book');
    });
    await check('a trailing run of body text can be deleted', async () => {
      const book = await bookWith(
        '<h1>A Chapter</h1><p>The chapter ends here. Buy our other books at example.com!</p>');
      const { out } = await edit(book, 'OEBPS/a.xhtml#1', 'The chapter ends here.');
      assertEqual((await elementsOf(out)).get('OEBPS/a.xhtml#1'), 'The chapter ends here.',
        'the book');
    });
    await check('an element that already reads that way is not rewritten', async () => {
      const book = await bookWith('<h1>A Chapter</h1><p>Body.</p>');
      const { result } = await edit(book, 'OEBPS/a.xhtml#0', 'A Chapter');
      assert(!result.written, 'the book was rewritten to say what it already said');
    });
    await check('whitespace the reader cannot see is not a change', async () => {
      const book = await bookWith('<h1>A\n   Chapter</h1><p>Body.</p>');
      const { result } = await edit(book, 'OEBPS/a.xhtml#0', 'A Chapter');
      assert(!result.written, 'a retype of the same words rewrote the book');
    });

    console.log('\nthe markup around it survives');
    await check('inline markup outside the change is untouched, byte for byte', async () => {
      const book = await bookWith(
        '<p>He wrote to <em>Bethge</em> from Tegel, in November.</p>');
      const { out } = await edit(
        book, 'OEBPS/a.xhtml#0', 'He wrote to Bethge from Tegel, in December.');
      const markup = await documentOf(out);
      assert(markup.includes('<em>Bethge</em>'), `the <em> did not survive: ${markup}`);
      assertEqual((await elementsOf(out)).get('OEBPS/a.xhtml#0'),
        'He wrote to Bethge from Tegel, in December.', 'the book');
    });
    await check('a footnote marker after the change survives', async () => {
      const book = await bookWith('<p>He wrote in November.<sup>12</sup></p>');
      const { out } = await edit(book, 'OEBPS/a.xhtml#0', 'He wrote in December. 12');
      assert((await documentOf(out)).includes('<sup>12</sup>'), 'the marker did not survive');
    });
    await check('the publisher\'s line breaks survive a fix on one line', async () => {
      const book = await bookWith('<p>He wrote to Bethge\n     in November.</p>');
      const { out } = await edit(book, 'OEBPS/a.xhtml#0', 'He wrote to Bethge in December.');
      assert((await documentOf(out)).includes('\n     '), 'the line break was flattened');
    });
    await check('every other element of the document is left alone', async () => {
      const book = await bookWith(
        '<h1>A Chapter</h1><p>First.</p><p>Second.</p><p>Third.</p>');
      const before = await elementsOf(book);
      const { out } = await edit(book, 'OEBPS/a.xhtml#2', 'Second, corrected.');
      const after = await elementsOf(out);
      assertEqual(after.size, before.size, 'the number of elements');
      for (const [key, text] of before) {
        if (key === 'OEBPS/a.xhtml#2') continue;
        assertEqual(after.get(key), text, `${key} changed and should not have`);
      }
      assertEqual(after.get('OEBPS/a.xhtml#2'), 'Second, corrected.', 'the edited element');
    });

    console.log('\nwhat it refuses, and why');
    await check('a change that would swallow inline markup is refused, naming the tag', async () => {
      const book = await bookWith('<p>He wrote to <em>Bethge</em> from Tegel.</p>');
      await refuses(
        () => edit(book, 'OEBPS/a.xhtml#0', 'She telephoned somebody else entirely.'),
        ['<em>', 'delete that markup', 'Nothing was written'],
        'a change spanning an inline element');
    });
    await check('emptying an element is refused — that is not how a block is removed', async () => {
      const book = await bookWith('<h1>A Chapter</h1><p>Body.</p>');
      await refuses(
        () => edit(book, 'OEBPS/a.xhtml#1', '   '),
        ['no text at all', 'Strike it instead', 'Nothing was written'],
        'an edit that empties an element');
    });
    await check('a key naming a picture is refused', async () => {
      const book = await bookWith('<p>Body.</p><p><img src="x.png" alt="x"/></p>');
      await refuses(
        () => edit(book, 'OEBPS/a.xhtml#img0', 'anything'),
        ['names a picture', 'Nothing was written'],
        'a picture key');
    });
    await check('a key naming a document the book does not have is refused', async () => {
      const book = await bookWith('<p>Body.</p>');
      await refuses(
        () => edit(book, 'OEBPS/nowhere.xhtml#0', 'anything'),
        ['no spine document', 'Nothing was written'],
        'a document key');
    });
    await check('a key past the end of the document is refused', async () => {
      const book = await bookWith('<p>Body.</p>');
      await refuses(
        () => edit(book, 'OEBPS/a.xhtml#40', 'anything'),
        ['names nothing in it', 'Nothing was written'],
        'an index past the end');
    });
    await check('a refused edit writes no file at all', async () => {
      const book = await bookWith('<p>Body.</p>');
      const before = fs.readdirSync(scratch).length;
      await refuses(
        () => edit(book, 'OEBPS/a.xhtml#0', ''),
        ['no text at all'],
        'an emptying edit');
      assertEqual(fs.readdirSync(scratch).length, before,
        'a refused edit left a file behind in the staging directory');
    });
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows */ }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
