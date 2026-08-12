#!/usr/bin/env node
/**
 * The stamped copy is gone and identity is no longer the bytes.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-quire-cache-identity.js
 *
 * Re-launches itself under Electron, because quire paginates in a real browser.
 *
 * Two claims used to hold this subsystem together, and this file is what
 * replaces them:
 *
 *  - "the stamps are in a copy of the book on disk" — they are not any more.
 *    They are handed to `Quire.openDocument(book, { sources })` and never
 *    written. So the FIRST thing proved here is that a book opened that way
 *    paginates into exactly the pages the same book stamped on disk does. If
 *    that is not true then everything the app knows about where a block is has
 *    quietly moved, and no other test in the tree would notice.
 *  - "a cache entry is named after the book's bytes" — it is named after the
 *    book, and the map says per document which bytes it was laid out from. So
 *    the SECOND thing proved is that editing one document invalidates that
 *    document, that laying it out again gives the same book as laying the whole
 *    thing out, and that the shapes this arithmetic cannot describe — a spine
 *    that gained a document — are laid out in full rather than believed.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { app } = require('electron');
const DIST = path.join(__dirname, '..', 'dist');
const { Quire, QuireError } = require(path.join(DIST, 'packages/quire/src/index.js'));
const { stampEpubForQuire } = require(path.join(DIST, 'electron/quire-stamp.js'));
const { ZipWriter } = require(path.join(DIST, 'electron/epub-processor.js'));
const {
  stampSpineOf, spineDocumentHashes,
} = require(path.join(DIST, 'electron/epub-quire-analysis.js'));
const {
  bookCacheKey, paginateBook, pageMapPath, quireCacheDir, saveCachedPageMap, loadCachedPageMap,
  staleDocuments, QUIRE_ANALYSIS_GEOMETRY,
} = require(path.join(DIST, 'electron/quire-page-map.js'));

Quire.registerScheme();
app.on('window-all-closed', () => { /* the harness decides when it is done */ });

const GEOMETRY = QUIRE_ANALYSIS_GEOMETRY;

let passed = 0;
const failures = [];
let scratch = null;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch((err) => {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err && err.message ? err.message : err}`);
    });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

/** A refusal is only useful if it says what went wrong. */
async function refuses(fn, mustSay, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (err === null) throw new Error(`${what}: nothing was refused`);
  for (const phrase of mustSay) {
    if (!String(err.message).includes(phrase)) {
      throw new Error(`${what}: the refusal does not mention "${phrase}" — ${err.message}`);
    }
  }
  return err;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function page(bodyInner, title = 't') {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${bodyInner}</body></html>`;
}

/** Enough prose that a document takes more than one page and a split is real. */
function prose(seed, paragraphs) {
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const words = [];
    for (let w = 0; w < 90; w++) words.push(`${seed}${p}w${w}`);
    out.push(`<p>${words.join(' ')}</p>`);
  }
  return out.join('');
}

function buildEpub(outPath, documents) {
  const manifest = documents
    .map((d, i) => `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = documents.map((_, i) => `<itemref idref="d${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:quire-cache-test</dc:identifier>
<dc:title>quire cache test</dc:title><dc:language>en</dc:language></metadata>
<manifest>${manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine>${spine}</spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol><li><a href="${documents[0].name}">Start</a></li></ol></nav></body></html>`;

  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  for (const d of documents) zw.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  return zw.write(outPath).then(() => outPath);
}

const THREE_DOCUMENTS = [
  { name: 'a.xhtml', xhtml: page(prose('a', 4), 'A') },
  { name: 'b.xhtml', xhtml: page(prose('b', 5), 'B') },
  { name: 'c.xhtml', xhtml: page(prose('c', 3), 'C') },
];

/** Everything about a laid-out book except how long it took. */
function snapshotOf(doc) {
  const report = doc.getReport();
  const pageCount = doc.countPages();
  const pages = [];
  for (let p = 0; p < pageCount; p++) pages.push(doc.loadPage(p).getBlocks());
  return {
    pageCount, pages,
    documents: report.documents,
    documentPageOffsets: report.documentPageOffsets,
    unplaced: report.unplaced,
    overflows: report.overflows,
  };
}

/** The same, for a page map — `layoutMs` is the time it took, not what it says. */
function comparableMap(map) {
  const { layoutMs, ...rest } = map;
  return rest;
}

function assertSame(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  throw new Error(
    `${what}: the two part company at character ${at} of their serialization — `
    + `one says …${a.slice(Math.max(0, at - 90), at + 90)}… and the other says `
    + `…${b.slice(Math.max(0, at - 90), at + 90)}…`);
}

async function sourcesFor(bookPath) {
  const spine = await stampSpineOf(bookPath);
  const sources = new Map();
  for (const [entry, doc] of spine) sources.set(entry, doc.stamped);
  return sources;
}

// ── 1. A book opened on its stamps beside a book opened on a stamped copy ───

/**
 * THE claim of this phase. If handing quire the stamped markup produced a
 * different pagination than opening a stamped file, every block coordinate in
 * the app would have moved and nothing else would have said so.
 */
async function testSourcesEqualAStampedCopy() {
  const book = path.join(scratch, 'equivalence.epub');
  await buildEpub(book, THREE_DOCUMENTS);

  const stampedCopy = path.join(scratch, 'equivalence.stamped.epub');
  await stampEpubForQuire(book, stampedCopy, 'equivalence');

  const viaFile = await Quire.openDocument(stampedCopy);
  let fromFile;
  try {
    await viaFile.layout(GEOMETRY);
    fromFile = snapshotOf(viaFile);
  } finally { await viaFile.close(); }

  const viaSources = await Quire.openDocument(book, { sources: await sourcesFor(book) });
  let fromSources;
  try {
    await viaSources.layout(GEOMETRY);
    fromSources = snapshotOf(viaSources);
  } finally { await viaSources.close(); }

  assert(fromFile.pageCount > 3, `the fixture is too small to be a test: ${fromFile.pageCount} page(s)`);
  assertSame(fromSources, fromFile, 'a book opened on in-memory stamps and one opened on a stamped copy');
}

/**
 * And the book on disk is NOT stamped. Without this the test above could pass
 * because something quietly wrote the stamps into the working copy, which is a
 * different design with different consequences for every export.
 */
async function testTheBookItselfIsNeverStamped() {
  const book = path.join(scratch, 'unstamped.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const doc = await Quire.openDocument(book, { sources: await sourcesFor(book) });
  try {
    await doc.layout(GEOMETRY);
  } finally { await doc.close(); }

  const { EpubProcessor } = require(path.join(DIST, 'electron/epub-processor.js'));
  const processor = new EpubProcessor();
  try {
    await processor.open(book);
    for (const entry of ['OEBPS/a.xhtml', 'OEBPS/b.xhtml', 'OEBPS/c.xhtml']) {
      const xhtml = await processor.readFile(entry);
      assert(
        !xhtml.includes('data-quire-id'),
        `${entry} carries a stamp: the book on disk was modified to lay it out`);
    }
  } finally { processor.close(); }
}

// ── 2. `sources` has to be the spine ───────────────────────────────────────

async function testSourcesMustCoverTheSpine() {
  const book = path.join(scratch, 'coverage.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const full = await sourcesFor(book);

  const short = new Map(full);
  short.delete('OEBPS/b.xhtml');
  const missing = await refuses(
    () => Quire.openDocument(book, { sources: short }),
    ['SOURCES_NOT_THE_SPINE', 'OEBPS/b.xhtml'],
    'a spine document with no source');
  assert(missing instanceof QuireError, 'the refusal is not a QuireError');

  const extra = new Map(full);
  extra.set('OEBPS/nowhere.xhtml', Buffer.from(page('<p>x</p>'), 'utf8'));
  await refuses(
    () => Quire.openDocument(book, { sources: extra }),
    ['SOURCES_NOT_THE_SPINE', 'OEBPS/nowhere.xhtml', 'not in the spine'],
    'a source for a document the book does not have');
}

// ── 3. Which book, and how fresh ───────────────────────────────────────────

async function testBookKeyIsTheBookNotItsBytes() {
  const book = path.join(scratch, 'key.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const before = bookCacheKey(book);

  await buildEpub(book, [
    THREE_DOCUMENTS[0],
    { name: 'b.xhtml', xhtml: page(prose('edited', 9), 'B') },
    THREE_DOCUMENTS[2],
  ]);
  assertEqual(bookCacheKey(book), before, 'editing the book moved its cache key');

  assert(
    bookCacheKey(path.join(scratch, 'other.epub')) !== before,
    'two different books share a cache key');
  assertEqual(
    bookCacheKey(book.replace(/\\/g, '/').toUpperCase()), before,
    'the same book reached by a differently-spelled path got a different key');
  assertEqual(before.length, 16, 'the cache key is not 16 hex characters');
}

async function testFreshnessIsPerDocument() {
  const book = path.join(scratch, 'freshness.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const map = await paginateBook(book, await stampSpineOf(book), GEOMETRY, null);

  assertEqual(map.documents.length, 3, 'the fixture did not paginate into three documents');
  assertEqual(map.documentHashes.length, 3, 'the map records the wrong number of document hashes');
  assertEqual(
    staleDocuments(map, await spineDocumentHashes(book, map.documents)).length, 0,
    'an untouched book reported stale documents');

  await buildEpub(book, [
    THREE_DOCUMENTS[0],
    { name: 'b.xhtml', xhtml: page(prose('edited', 6), 'B') },
    THREE_DOCUMENTS[2],
  ]);
  const stale = staleDocuments(map, await spineDocumentHashes(book, map.documents));
  assertSame(stale, ['OEBPS/b.xhtml'], 'editing one document');
}

// ── 4. Laying out only what moved gives the same book ──────────────────────

/**
 * The payoff, and the thing that would be worth nothing if it were even
 * slightly wrong: a map rebuilt by measuring one edited document has to be the
 * map a full pagination of the edited book produces, page for page and block
 * for block.
 */
async function testPartialRelayoutEqualsAFullLayout() {
  const book = path.join(scratch, 'partial.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const first = await paginateBook(book, await stampSpineOf(book), GEOMETRY, null);

  // An edit that changes the page count, so the arithmetic that renumbers the
  // documents after it is actually exercised.
  await buildEpub(book, [
    THREE_DOCUMENTS[0],
    { name: 'b.xhtml', xhtml: page(prose('b', 11), 'B') },
    THREE_DOCUMENTS[2],
  ]);
  const spine = await stampSpineOf(book);
  const stale = staleDocuments(first, await spineDocumentHashes(book, first.documents));
  assertSame(stale, ['OEBPS/b.xhtml'], 'the edit');

  const incremental = await paginateBook(book, spine, GEOMETRY, { map: first, stale });
  const full = await paginateBook(book, spine, GEOMETRY, null);

  assert(
    incremental.pageCount !== first.pageCount,
    'the edit did not change the page count, so this proves less than it should');
  assertSame(comparableMap(incremental), comparableMap(full),
    'a map rebuilt from one edited document and a map of the whole edited book');
}

/**
 * A book that GAINED a spine document cannot be described by the old map at
 * all, and the freshness check cannot see it — the map does not name the new
 * document. quire refuses to stand the map up and the book is laid out in full.
 */
async function testAGrownSpineIsLaidOutInFull() {
  const book = path.join(scratch, 'grown.epub');
  await buildEpub(book, THREE_DOCUMENTS.slice(0, 2));
  const first = await paginateBook(book, await stampSpineOf(book), GEOMETRY, null);
  assertEqual(first.documents.length, 2, 'the fixture did not start with two documents');

  await buildEpub(book, THREE_DOCUMENTS);
  const spine = await stampSpineOf(book);
  const stale = staleDocuments(first, await spineDocumentHashes(book, first.documents));
  assertEqual(stale.length, 0, 'adding a document should not disturb the ones already there');

  const after = await paginateBook(book, spine, GEOMETRY, { map: first, stale });
  const full = await paginateBook(book, spine, GEOMETRY, null);
  assertEqual(after.documents.length, 3, 'the added document got no pages');
  assertSame(comparableMap(after), comparableMap(full),
    'a book whose spine grew, stood down and laid out in full');
}

// ── 5. What is left in the cache ───────────────────────────────────────────

/**
 * Nothing but the map. The 25.7 MB stamped copy that used to sit here per book
 * — and per EDIT of that book — is what this phase deleted, so its absence is
 * worth asserting rather than assuming.
 */
async function testTheCacheHoldsOnlyTheMap() {
  const book = path.join(scratch, 'cache-contents.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const key = bookCacheKey(book);
  const dir = quireCacheDir(key);
  fs.rmSync(dir, { recursive: true, force: true });

  const map = await paginateBook(book, await stampSpineOf(book), GEOMETRY, null);
  await saveCachedPageMap(key, map);

  const left = fs.readdirSync(dir);
  assertEqual(left.length, 1, `the cache directory holds ${left.join(', ')}`);
  assertEqual(
    left[0], path.basename(pageMapPath(key, map.strategyName, GEOMETRY)),
    'the one file in the cache directory is not the page map');

  const reread = await loadCachedPageMap(key, map.strategyName, GEOMETRY);
  assertSame(reread, map, 'a map read back off disk');
}

/**
 * A map from before this phase says nothing about which bytes it was laid out
 * from. It is retired by name rather than believed — and it can only be reached
 * at all by a build that did not bump `QUIRE_ANALYSIS_VERSION`, which is the
 * failure this refusal is the last line against.
 */
async function testAMapWithNoFreshnessRecordIsRefused() {
  const book = path.join(scratch, 'legacy-map.epub');
  await buildEpub(book, THREE_DOCUMENTS);
  const key = bookCacheKey(book);
  const map = await paginateBook(book, await stampSpineOf(book), GEOMETRY, null);
  await saveCachedPageMap(key, map);

  const at = pageMapPath(key, map.strategyName, GEOMETRY);
  const legacy = JSON.parse(fs.readFileSync(at, 'utf-8'));
  delete legacy.documentHashes;
  fs.writeFileSync(at, JSON.stringify(legacy), 'utf-8');

  await refuses(
    () => loadCachedPageMap(key, map.strategyName, GEOMETRY),
    ['document hash', 'cannot be checked against the book'],
    'a page map with no per-document hashes');
}

// ── 6. Restating a document without measuring it ───────────────────────────

/** A book whose first document carries a labellable element, laid out and open. */
async function openLabelled(name, extraHead = '') {
  const book = path.join(scratch, `${name}.epub`);
  await buildEpub(book, [
    {
      name: 'a.xhtml',
      xhtml: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>A</title>${extraHead}</head><body>`
        + `<h1 data-bf-user-cat="title">A Chapter</h1>${prose('a', 4)}</body></html>`,
    },
    THREE_DOCUMENTS[1],
  ]);
  const doc = await Quire.openDocument(book, { sources: await sourcesFor(book) });
  await doc.layout(GEOMETRY);
  return { book, doc };
}

/** The same document with the label changed — what a relabel actually writes. */
function relabelled(source, from, to) {
  const out = source.replace(`data-bf-user-cat="${from}"`, `data-bf-user-cat="${to}"`);
  if (out === source) throw new Error(`the fixture does not carry data-bf-user-cat="${from}"`);
  return out;
}

/**
 * The claim: every page, every block and every box is exactly what it was, and
 * the document now serves the new bytes. If the pages moved at all, a page
 * number the user is about to strike a paragraph by is wrong.
 */
async function testRestateKeepsEveryPage() {
  const { doc } = await openLabelled('restate');
  try {
    const before = snapshotOf(doc);
    const source = doc.sourceOf('OEBPS/a.xhtml');
    await doc.restateDocumentSource(
      'OEBPS/a.xhtml', relabelled(source, 'title', 'chapter'), ['data-bf-user-cat']);
    assertSame(snapshotOf(doc), before, 'a restated document');
    assert(
      doc.sourceOf('OEBPS/a.xhtml').includes('data-bf-user-cat="chapter"'),
      'the document did not take the new bytes');
  } finally { await doc.close(); }
}

/**
 * And it holds through a geometry change — which is the whole reason the source
 * has to move at all. A label that survived until the reader resized and then
 * vanished would be worse than one that never landed.
 */
async function testRestateSurvivesARelayoutAtAnotherGeometry() {
  const { doc } = await openLabelled('restate-resize');
  try {
    const source = doc.sourceOf('OEBPS/a.xhtml');
    await doc.restateDocumentSource(
      'OEBPS/a.xhtml', relabelled(source, 'title', 'chapter'), ['data-bf-user-cat']);
    await doc.layout({ width: 500, height: 800, fontSize: 18 });
    assert(
      doc.sourceOf('OEBPS/a.xhtml').includes('data-bf-user-cat="chapter"'),
      'the label was lost when the book was laid out at another page box');
  } finally { await doc.close(); }
}

/** Anything else in the bytes and it is not restated — it is measured. */
async function testRestateRefusesARealEdit() {
  const { doc } = await openLabelled('restate-refuse');
  try {
    const source = doc.sourceOf('OEBPS/a.xhtml');
    const before = snapshotOf(doc);
    await refuses(
      () => doc.restateDocumentSource(
        'OEBPS/a.xhtml',
        relabelled(source, 'title', 'chapter').replace('A Chapter', 'A Much Longer Chapter Name'),
        ['data-bf-user-cat']),
      ['RESTATE_CHANGED_MORE_THAN_ATTRIBUTES', 'differ at character'],
      'a rewrite that changed a word');
    assertSame(snapshotOf(doc), before, 'the document after a refused restate');
    assert(
      doc.sourceOf('OEBPS/a.xhtml') === source,
      'a refused restate took the new bytes anyway');
  } finally { await doc.close(); }
}

/**
 * An attribute a stylesheet can select on is a layout input, whatever it is
 * called. quire answers for the styles IT can see — its own injected CSS and the
 * document's inline `<style>` — and says so rather than assuming.
 */
async function testRestateRefusesAStyledAttribute() {
  const { doc } = await openLabelled(
    'restate-styled',
    '<style type="text/css">h1[data-bf-user-cat="chapter"] { margin-top: 20em }</style>');
  try {
    const source = doc.sourceOf('OEBPS/a.xhtml');
    await refuses(
      () => doc.restateDocumentSource(
        'OEBPS/a.xhtml', relabelled(source, 'title', 'chapter'), ['data-bf-user-cat']),
      ['NEUTRAL_ATTRIBUTE_IS_STYLED', 'data-bf-user-cat'],
      'a document whose own stylesheet selects the attribute');
  } finally { await doc.close(); }
}

/** The refusals that stop this being used for something it cannot prove. */
async function testRestateRefusesTheAskItselfWhenItCannot() {
  const { doc } = await openLabelled('restate-guards');
  try {
    const source = doc.sourceOf('OEBPS/a.xhtml');
    await refuses(
      () => doc.restateDocumentSource('OEBPS/nowhere.xhtml', source, ['data-bf-user-cat']),
      ['NOT_LAID_OUT', 'OEBPS/nowhere.xhtml'],
      'a document the book does not have');
    await refuses(
      () => doc.restateDocumentSource('OEBPS/a.xhtml', source, []),
      ['NO_NEUTRAL_ATTRIBUTES'],
      'a restate that named no difference');
    await refuses(
      () => doc.restateDocumentSource('OEBPS/a.xhtml', source, ['data-bf-[a-z]+']),
      ['BAD_ATTRIBUTE_NAME'],
      'a pattern offered where an attribute name belongs');
    await refuses(
      () => doc.restateDocumentSource('OEBPS/a.xhtml', '   ', ['data-bf-user-cat']),
      ['EMPTY_RESTATED_SOURCE'],
      'a restate with no source');
  } finally { await doc.close(); }
}

/** `sourceOf` answers about the book, never about the archive behind it. */
async function testSourceOfRefusesWhatItDoesNotHold() {
  const { doc } = await openLabelled('source-of');
  try {
    await refuses(
      async () => doc.sourceOf('OEBPS/nav.xhtml'),
      ['NO_SOURCE_HELD', 'OEBPS/nav.xhtml'],
      'a document with no source of its own');
  } finally { await doc.close(); }
}

// ── Run ────────────────────────────────────────────────────────────────────

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-cache-'));
  console.log('quire cache identity\n');
  try {
    console.log('stamps without a stamped copy');
    await check('a book opened on in-memory stamps paginates exactly as a stamped copy does',
      testSourcesEqualAStampedCopy);
    await check('laying a book out never writes a stamp into the book', testTheBookItselfIsNeverStamped);
    await check('sources that are not the spine are refused, in both directions',
      testSourcesMustCoverTheSpine);

    console.log('identity');
    await check('the cache key is the book, not its bytes', testBookKeyIsTheBookNotItsBytes);
    await check('an edit makes exactly its own document stale', testFreshnessIsPerDocument);

    console.log('laying out only what moved');
    await check('a map rebuilt from one edited document equals a map of the whole edited book',
      testPartialRelayoutEqualsAFullLayout);
    await check('a book whose spine grew is laid out in full', testAGrownSpineIsLaidOutInFull);

    console.log('the cache');
    await check('the cache directory holds the page map and nothing else', testTheCacheHoldsOnlyTheMap);
    await check('a map with no per-document hashes is refused', testAMapWithNoFreshnessRecordIsRefused);

    console.log('restating a document without measuring it');
    await check('a relabel keeps every page, every block and every box',
      testRestateKeepsEveryPage);
    await check('a restated label survives the book being laid out at another page box',
      testRestateSurvivesARelayoutAtAnotherGeometry);
    await check('a rewrite that changed a word is refused, and changes nothing',
      testRestateRefusesARealEdit);
    await check('an attribute the document\'s own stylesheet selects on is refused',
      testRestateRefusesAStyledAttribute);
    await check('a restate it cannot prove is refused, each way by name',
      testRestateRefusesTheAskItselfWhenItCannot);
    await check('sourceOf refuses a document it holds no source for',
      testSourceOfRefusesWhatItDoesNotHold);
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows holds files */ }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  process.exit(1);
});
