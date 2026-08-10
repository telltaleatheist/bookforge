#!/usr/bin/env node
/**
 * quire's tests.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-quire.js
 *
 * Re-launches itself under Electron, because quire paginates in a real browser.
 *
 * What is proved here, and why each one:
 *
 *  1. IDENTITY — the stamps `electron/quire-stamp.ts` writes are, element for
 *     element and in order, what `writeNarrationEpub` would enumerate on the
 *     same book. This is the guarantee the package exists for. The reference
 *     walk is written out longhand here rather than shared with the stamper, so
 *     that a change to either side has something to disagree with.
 *  2. SPLIT DETECTION — an element that spans a page break is reported on both
 *     pages, with splitFrom/splitTo, and its words are divided between them
 *     rather than repeated. Run against BOTH strategies, because it is the one
 *     behaviour they have to agree about.
 *  3. GAP ARITHMETIC — if the pitch used for the arithmetic is not the pitch the
 *     layout used, quire REFUSES. Proved by laying a document out at one gutter
 *     and measuring it at another, which is the exact failure the assertion is
 *     for. This is what `MultiColumnStrategy` is kept in the tree FOR.
 *  4. PATH ESCAPE — the protocol refuses to serve anything outside the archive,
 *     both as a unit test of the rule and live through a loaded document.
 *  5. SANDBOX — a book's own script does not run, and a book's remote reference
 *     does not leave the machine.
 *  6. PAGED.JS — the product strategy on a real book: the vendored bundle is the
 *     one that was audited, every image lands on exactly one page, the map is
 *     the same twice running, the split runs are coherent, quire refuses when
 *     the page box is not the page box, quire refuses when Paged.js's own record
 *     of a split disagrees with the geometry, and the whole book paginates in
 *     seconds rather than in minutes — the last one because Paged.js's work
 *     queue ticks on requestAnimationFrame, and a throttled host turns that into
 *     a 60x slowdown that nothing else in this file would notice.
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
const {
  Quire, resolveQuireRequest, MultiColumnStrategy, PagedStrategy, PAGEDJS_VERSION, QuireError,
  MONOLITHIC_OVERFLOW_RULE,
} = require(path.join(DIST, 'packages/quire/src/index.js'));
const { stampEpubForQuire } = require(path.join(DIST, 'electron/quire-stamp.js'));
const {
  EpubProcessor, ZipWriter,
  parseXhtmlBody, collectExportUnits, collectImageElements, normalizeZipEntryName,
} = require(path.join(DIST, 'electron/epub-processor.js'));
const {
  narrationElementKey, narrationImageElementKey,
} = require(path.join(DIST, 'shared/vlm/narration-deletions.js'));

Quire.registerScheme();

// quire's analysis window is a real BrowserWindow, so destroying it can leave
// the app with none — and Electron's default reaction to that is to quit. In
// BookForge the main window keeps the app alive; in a headless harness nothing
// does, so the default is turned off explicitly.
app.on('window-all-closed', () => { /* the harness decides when it is done */ });

const KA = 'C:\\Users\\tellt\\AppData\\Local\\Temp\\claude\\C--Users-tellt-Projects-bookforge'
  + '\\086cf711-ae6e-4b04-8dab-8263f60b671f\\scratchpad\\ka-archive-copy.epub';

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

// ── A synthetic EPUB, so the sandbox tests can carry hostile markup ────────
function buildEpub(outPath, documents) {
  const manifest = documents
    .map((d, i) => `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = documents.map((_, i) => `<itemref idref="d${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:quire-test</dc:identifier>
<dc:title>quire test</dc:title><dc:language>en</dc:language></metadata>
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
  for (const d of documents) {
    zw.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  }
  return zw.write(outPath).then(() => outPath);
}

function page(bodyInner, title = 't') {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${bodyInner}</body></html>`;
}

// ── 1. Identity ───────────────────────────────────────────────────────────
/**
 * The reference walk, written out as `writeNarrationEpub` writes it: spine
 * order from the processor's structure, deduped per file, `collectExportUnits`
 * first and `collectImageElements` second (that order matters — the unit walk
 * MOVES stray runs into synthesized wrappers, and the picture ordinals are read
 * off the tree that walk leaves behind).
 */
async function referenceEnumeration(epubPath) {
  const processor = new EpubProcessor();
  const keys = [];
  const seen = new Set();
  try {
    const structure = await processor.open(epubPath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      if (seen.has(entryName)) continue;
      seen.add(entryName);
      const xhtml = await processor.readFile(entryName);
      const { doc, body } = parseXhtmlBody(xhtml, entryName);
      let indexInFile = 0;
      for (const _c of collectExportUnits(doc, body, entryName)) {
        keys.push(narrationElementKey(entryName, indexInFile++));
      }
      collectImageElements(body).forEach((_el, ordinal) => {
        keys.push(narrationImageElementKey(entryName, ordinal));
      });
    }
  } finally {
    processor.close();
  }
  return keys;
}

async function testIdentity() {
  const stampedPath = path.join(scratch, 'ka.stamped.epub');
  const stamp = await stampEpubForQuire(KA, stampedPath, 'ka');
  const reference = await referenceEnumeration(KA);

  assertEqual(stamp.stamped.length, reference.length,
    'the stamper and the narration walk disagree about how many elements the book has');
  for (let i = 0; i < reference.length; i++) {
    if (stamp.stamped[i].key !== reference[i]) {
      throw new Error(
        `the enumerations diverge at position ${i}: the stamper says "${stamp.stamped[i].key}", `
        + `the narration walk says "${reference[i]}"`);
    }
  }

  // And the ids quire actually SEES in the stamped file are those same ids.
  const doc = await Quire.openDocument(stampedPath);
  try {
    const report = await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const seen = new Set(report.stampedIds);
    const missing = reference.filter((k) => !seen.has(k));
    assert(missing.length === 0,
      `${missing.length} enumerated key(s) never reached quire, e.g. ${missing.slice(0, 5).join(', ')}`);
    assertEqual(report.stampedIds.length, reference.length,
      'quire saw a different number of stamps than the book has elements');
    assertEqual(report.unplaced.length, 0,
      `${report.unplaced.length} stamped element(s) got no page`);
    // Named, so a change in the stamper's enumeration shows up here as a number
    // rather than as a silent shift in what "every element" means.
    assertEqual(stamp.textUnitCount, 1350, 'Killing America has 1350 text units');
    assertEqual(stamp.imageElementCount, 10, 'Killing America has 10 image elements');
    assertEqual(reference.length, 1360, 'Killing America has 1360 stamped keys in total');
  } finally {
    await doc.close();
  }
}

// ── 2. Split detection ────────────────────────────────────────────────────
/**
 * Run against BOTH strategies. Splitting is the one thing a column strip and a
 * stack of page boxes have to agree about — an element that spans a break is
 * reported on every page it touches, with the same splitFrom/splitTo, and its
 * words divided rather than repeated — and they arrive at it by completely
 * different routes (character-by-character column arithmetic on one side,
 * Paged.js's own cut text nodes on the other).
 */
async function testSplitDetection(strategy) {
  const words = [];
  for (let i = 0; i < 400; i++) words.push(`word${i}`);
  const long = words.join(' ');
  const epub = path.join(scratch, `split-${strategy.name}.epub`);
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: page(`<p>${long}</p>`) }]);

  const stamped = path.join(scratch, `split-${strategy.name}.stamped.epub`);
  await stampEpubForQuire(epub, stamped, 'split');
  const doc = await Quire.openDocument(stamped, { strategy });
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    assert(doc.countPages() > 1, 'the fixture was meant to be longer than one page');

    const blocks = [];
    for (let p = 0; p < doc.countPages(); p++) {
      for (const b of doc.loadPage(p).getBlocks()) blocks.push({ page: p, ...b });
    }
    const mine = blocks.filter((b) => b.id === 'OEBPS/a.xhtml#0');
    assert(mine.length > 1, `the paragraph should span pages; it produced ${mine.length} block(s)`);

    const first = mine[0], last = mine[mine.length - 1];
    assertEqual(first.splitFrom, first.page, 'splitFrom must be the first page the element touches');
    assertEqual(last.splitTo, last.page, 'splitTo must be the last page the element touches');
    for (const b of mine) {
      assertEqual(b.splitFrom, first.page, 'every block of a split element reports the same splitFrom');
      assertEqual(b.splitTo, last.page, 'every block of a split element reports the same splitTo');
    }

    // The words are DIVIDED, not repeated: concatenating the fragments gives
    // back the paragraph exactly once.
    const rejoined = mine.map((b) => b.text).filter((t) => t.length > 0).join(' ');
    assertEqual(rejoined, long, 'the fragments do not rejoin into the original paragraph');

    // An element on ONE page reports no split at all.
    const singles = blocks.filter((b) => b.id !== 'OEBPS/a.xhtml#0');
    for (const b of singles) {
      assert(b.splitFrom === null && b.splitTo === null,
        `${b.id} sits on one page but reports a split`);
    }
  } finally {
    await doc.close();
  }
}

/**
 * A spine document that renders nothing still takes a page, the way a blank leaf
 * in a printed book is still a leaf. This is a definition rather than a guess —
 * it is what mupdf does with the same document, and dropping the page would
 * shift every page number after it — so both strategies have to agree about it.
 */
async function testEmptyDocumentStillTakesAPage(strategy) {
  const epub = path.join(scratch, `empty-${strategy.name}.epub`);
  await buildEpub(epub, [
    { name: 'a.xhtml', xhtml: page('<p>first</p>') },
    { name: 'b.xhtml', xhtml: page('') },
    { name: 'c.xhtml', xhtml: page('<p>third</p>') },
  ]);
  const stamped = path.join(scratch, `empty-${strategy.name}.stamped.epub`);
  await stampEpubForQuire(epub, stamped, 'empty');

  const doc = await Quire.openDocument(stamped, { strategy });
  try {
    const report = await doc.layout({ width: 600, height: 900, fontSize: 18 });
    assertEqual(doc.countPages(), 3,
      'three spine documents must produce three pages even when the middle one is blank');
    assertEqual(report.documentPageOffsets.join(','), '0,1,2',
      'the blank document must occupy a page of its own rather than be skipped');
    const third = doc.loadPage(2).getBlocks();
    assert(third.some((b) => b.id.startsWith('OEBPS/c.xhtml')),
      'the document after the blank one must start on the page after it');
  } finally {
    await doc.close();
  }
}

// ── 3. Gap arithmetic ─────────────────────────────────────────────────────
/**
 * A strategy that lays out with one gutter and measures with another. Nothing
 * else changes. If quire were rounding fragments into the nearest column instead
 * of checking them, this would quietly produce page numbers that drift by one
 * more column every column; instead it must refuse.
 */
class MismatchedGutterStrategy extends MultiColumnStrategy {
  constructor(laidOutGap) { super(); this.laidOutGap = laidOutGap; }
  layoutCss(g) { return super.layoutCss({ ...g, gap: this.laidOutGap }); }
}

/**
 * Lays out correctly but does its arithmetic at the wrong pitch — the case the
 * per-fragment check exists for. A pitch of width+100 against a real pitch of
 * width+24 puts the very first column-1 fragment 24px past the column's right
 * edge, i.e. in the gutter, so it must be refused rather than rounded in.
 */
class DriftingPitchStrategy extends MultiColumnStrategy {
  measureConfig(g) { return { ...super.measureConfig(g), pitch: g.width + 100 }; }
}

async function testGapArithmeticRefused() {
  const paras = [];
  for (let i = 0; i < 300; i++) paras.push(`<p>Paragraph ${i} with enough words to fill some lines.</p>`);
  const epub = path.join(scratch, 'gap.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: page(paras.join('')) }]);
  const stamped = path.join(scratch, 'gap.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'gap');

  // Sanity: the same book with a CONSISTENT gutter lays out fine. The strategy
  // is named rather than defaulted — the default is Paged.js, which has no
  // gutter at all, so a defaulted document here would prove nothing about the
  // arithmetic the two refusals below are about.
  const ok = await Quire.openDocument(stamped, { strategy: new MultiColumnStrategy() });
  try {
    await ok.layout({ width: 600, height: 900, fontSize: 18, gap: 24 });
    assert(ok.countPages() > 3, 'the fixture was meant to run to several pages');
  } finally {
    await ok.close();
  }

  const refuse = async (strategy, mustName, what) => {
    const bad = await Quire.openDocument(stamped, { strategy });
    let threw = null;
    try {
      await bad.layout({ width: 600, height: 900, fontSize: 18, gap: 24 });
    } catch (err) {
      threw = err;
    } finally {
      await bad.close();
    }
    assert(threw !== null, `quire accepted ${what}`);
    assert(threw instanceof QuireError, `expected a QuireError for ${what}, got ${threw && threw.name}`);
    assert(mustName.test(threw.message),
      `the refusal for ${what} should name the arithmetic; it said: ${threw.message}`);
  };

  // (a) The gutter the document was laid out with is not the gutter the
  //     arithmetic assumes. Caught immediately, against the layout itself.
  await refuse(new MismatchedGutterStrategy(60), /COLUMN_GAP_MISMATCH/,
    'a layout whose gutter did not match its arithmetic');

  // (b) The gutter agrees but the PITCH does not. Caught by a fragment landing
  //     in a gutter, which is the check that does not depend on the layout
  //     being willing to describe itself.
  await refuse(new DriftingPitchStrategy(), /FRAGMENT_IN_GUTTER/,
    'a layout measured at the wrong column pitch');
}

// ── 4. Path escape ────────────────────────────────────────────────────────
async function testPathEscapeUnit() {
  const inArchive = (name) => name === 'OEBPS/a.xhtml' || name === 'OEBPS/images/x.png';
  const S = 'sess';

  const good = resolveQuireRequest('quire://sess/OEBPS/a.xhtml', S, inArchive);
  assert(good.ok === true && good.entry === 'OEBPS/a.xhtml', 'a legitimate entry must resolve');

  const refusals = [
    ['quire://sess/../../../etc/passwd', 'a plain .. traversal'],
    ['quire://sess/OEBPS/../../secret', 'a .. traversal after a real segment'],
    ['quire://sess/OEBPS/%2e%2e/%2e%2e/secret', 'a percent-encoded .. traversal'],
    ['quire://sess/C:/Windows/win.ini', 'a drive-absolute path'],
    ['quire://sess/OEBPS%5C..%5Csecret', 'a backslash traversal'],
    ['quire://sess/./OEBPS/a.xhtml', 'a . segment'],
    ['quire://sess//OEBPS/a.xhtml', 'an empty segment'],
    ['quire://other/OEBPS/a.xhtml', "another document's session"],
    ['quire://sess/OEBPS/nope.xhtml', 'an entry the archive does not have'],
  ];
  for (const pair of refusals) {
    const url = pair[0], what = pair[1];
    const r = resolveQuireRequest(url, S, inArchive);
    assert(r.ok === false, `${what} must be refused (${url})`);
    assert(r.status === 403 || r.status === 404 || r.status === 400,
      `${what} refused with an odd status ${r.status}`);
  }

  // The refusal must not be a normalisation: `a/../b` must NOT quietly become `b`.
  const sneaky = resolveQuireRequest('quire://sess/OEBPS/images/../a.xhtml', S, inArchive);
  assert(sneaky.ok === false,
    'a traversal that normalises to a real entry must still be refused, not silently rewritten');
}

async function testPathEscapeLive() {
  // A document that reaches outside the archive for its stylesheet and its
  // picture. Both must be refused by the handler, and the refusal recorded.
  const hostile = page(
    '<p>text</p>'
    + '<img src="../../../../../../Windows/win.ini" alt="escape"/>'
    + '<img src="/OEBPS/../../secret.png" alt="escape2"/>',
  );
  const epub = path.join(scratch, 'escape.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: hostile }]);
  const stamped = path.join(scratch, 'escape.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'escape');

  const doc = await Quire.openDocument(stamped);
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const escapes = doc.refusals.filter((r) => /\.\.|win\.ini|secret/.test(r.url));
    assert(escapes.length > 0,
      'a document reaching outside the archive produced no refusal at all');
    for (const r of escapes) {
      assert(/\.\." segment|backslash|drive|no entry|empty segment/.test(r.reason),
        `refusal reason should name the rule that fired, got: ${r.reason}`);
    }
  } finally {
    await doc.close();
  }
}

// ── 5. Sandbox ────────────────────────────────────────────────────────────
async function testScriptDoesNotRun() {
  const hostile = page(
    '<p id="p">text</p>'
    + '<script>document.body.setAttribute("data-book-script-ran","YES");</script>'
    + '<p onclick="document.body.setAttribute(\'data-handler\',\'YES\')">clicky</p>'
    + '<p><a href="javascript:document.body.setAttribute(\'data-href\',\'YES\')">link</a></p>',
  );
  const epub = path.join(scratch, 'script.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: hostile }]);
  const stamped = path.join(scratch, 'script.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'script');

  const { buildPaginationShell } = require(path.join(DIST, 'packages/quire/src/epub/shell.js'));
  const shell = buildPaginationShell(hostile, 'a.xhtml', '/* css */');
  assertEqual(shell.removed.scripts, 1, 'the shell must remove the book\'s <script>');
  assertEqual(shell.removed.handlers, 1, 'the shell must remove the book\'s on* handler');
  assertEqual(shell.removed.javascriptUrls, 1, 'the shell must remove the book\'s javascript: URL');
  assert(!/<script/i.test(shell.xhtml), 'a <script> tag survived into the served bytes');
  assert(!/onclick/i.test(shell.xhtml), 'an on* handler survived into the served bytes');
  assert(!/javascript:/i.test(shell.xhtml), 'a javascript: URL survived into the served bytes');

  // And live: nothing the book carried has touched the DOM.
  const doc = await Quire.openDocument(stamped);
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const { OffscreenWindowHost } = require(path.join(DIST, 'packages/quire/src/index.js'));
    const host = await OffscreenWindowHost.create({ session: doc.session, width: 600, height: 900 });
    try {
      await host.load(doc.getPageMount(0).url);
      const probe = await host.evaluate(`JSON.stringify({
        ran: document.body.getAttribute('data-book-script-ran'),
        handler: document.body.getAttribute('data-handler'),
        href: document.body.getAttribute('data-href'),
        scriptTags: document.querySelectorAll('script').length
      })`);
      const seen = JSON.parse(probe);
      assertEqual(seen.ran, null, 'the book\'s script ran');
      assertEqual(seen.handler, null, 'the book\'s event handler ran');
      assertEqual(seen.scriptTags, 0, 'a <script> element reached the renderer');
    } finally {
      host.destroy();
    }
  } finally {
    await doc.close();
  }
}

async function testRemoteLoadsBlocked() {
  const hostile = page(
    '<p>text</p>'
    + '<img src="https://example.invalid/tracker.png" alt="remote"/>'
    + '<link rel="stylesheet" href="https://example.invalid/style.css"/>',
  );
  const epub = path.join(scratch, 'remote.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: hostile }]);
  const stamped = path.join(scratch, 'remote.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'remote');

  const doc = await Quire.openDocument(stamped);
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    // Nothing that is not quire: may have been ALLOWED. Either the CSP stopped
    // it before the network layer, or webRequest cancelled it — both are proof,
    // and between them nothing reaches example.invalid.
    const escaped = doc.refusals.filter((r) => /^https?:/.test(r.url));
    const cspBlocked = doc.consoleMessages.filter(
      (m) => /Content Security Policy/i.test(m) && /example\.invalid/.test(m));
    assert(escaped.length + cspBlocked.length > 0,
      'a remote reference produced neither a CSP violation nor a cancelled request — '
      + 'it may have been fetched');
    for (const r of escaped) {
      assertEqual(r.reason, 'the session allows no scheme but quire:',
        'a remote request should be cancelled by the session rule');
    }
  } finally {
    await doc.close();
  }
}

async function testSandboxPreferencesEnforced() {
  const { QUIRE_REQUIRED_WEB_PREFERENCES, AttachedWebContentsHost } =
    require(path.join(DIST, 'packages/quire/src/index.js'));
  assertEqual(QUIRE_REQUIRED_WEB_PREFERENCES.sandbox, true, 'sandbox must be required');
  assertEqual(QUIRE_REQUIRED_WEB_PREFERENCES.contextIsolation, true, 'contextIsolation must be required');
  assertEqual(QUIRE_REQUIRED_WEB_PREFERENCES.nodeIntegration, false, 'nodeIntegration must be refused');
  assertEqual(QUIRE_REQUIRED_WEB_PREFERENCES.webSecurity, true, 'webSecurity must be required');

  // An unsandboxed surface is refused rather than used.
  const { BrowserWindow } = require('electron');
  const unsafe = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false },
  });
  try {
    let threw = null;
    try {
      AttachedWebContentsHost.attach(unsafe.webContents, unsafe.webContents.session);
    } catch (err) { threw = err; }
    assert(threw !== null, 'quire attached a book to an unsandboxed surface');
    assert(/SANDBOX_VIOLATION/.test(threw.message),
      `the refusal should name the sandbox; it said: ${threw.message}`);
  } finally {
    unsafe.destroy();
  }
}

// ── 6. Paged.js, the product strategy ─────────────────────────────────────

/**
 * The vendored bundle is the artifact that was audited, byte for byte.
 *
 * The repo has `core.autocrlf=true`, so without the `-text` attribute beside it
 * this file would be rewritten on checkout and this test would fail on Windows
 * and pass on macOS — which is exactly the kind of "works on my machine" the
 * hash is here to make impossible.
 */
async function testVendoredBundle() {
  const crypto = require('crypto');
  const bundle = path.join(__dirname, '..', 'packages', 'quire', 'vendor', 'pagedjs', 'paged.js');
  assert(fs.existsSync(bundle), `the vendored bundle is missing from ${bundle}`);
  const bytes = fs.readFileSync(bundle);
  assertEqual(bytes.length, 920798, 'the vendored paged.js is not the size npm published');
  assertEqual(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '4cae0c875c89084b353ceee87bcc742388de3133f2bbf48830b63f1d2d357e4f',
    'the vendored paged.js is not byte-for-byte what packages/quire/vendor/pagedjs/README.md records');
  assertEqual(PAGEDJS_VERSION, '0.4.3', 'the pinned Paged.js version changed');
  assertEqual(new PagedStrategy().name, 'pagedjs-0.4.3',
    'the strategy must name the version it paginated with — a cached page map is only '
    + 'valid for the paginator that produced it');

  // And the compiled copy the run time actually reads is the same bytes.
  const shipped = path.join(DIST, 'packages/quire/vendor/pagedjs/paged.js');
  assert(fs.existsSync(shipped),
    `dist has no vendored bundle at ${shipped} — run \`npm run build:quire-vendor\``);
  assert(fs.readFileSync(shipped).equals(bytes),
    'the bundle in dist/ is not the bundle in packages/quire/vendor/');
}

/**
 * Killing America through PagedStrategy, laid out once and read many times. The
 * layout is the expensive part and every assertion below is about the same one.
 */
let kaPaged = null;
async function layoutKaWithPagedStrategy() {
  const stampedPath = path.join(scratch, 'ka.paged.epub');
  if (!fs.existsSync(stampedPath)) await stampEpubForQuire(KA, stampedPath, 'ka');
  const doc = await Quire.openDocument(stampedPath, { strategy: new PagedStrategy() });
  try {
    const started = Date.now();
    const report = await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const wallMs = Date.now() - started;
    const pageCount = doc.countPages();
    const blocks = [];
    for (let p = 0; p < pageCount; p++) {
      for (const b of doc.loadPage(p).getBlocks()) blocks.push({ page: p, ...b });
    }
    return { report, pageCount, blocks, wallMs, strategyName: doc.strategyName };
  } finally {
    await doc.close();
  }
}
async function ka() {
  if (!kaPaged) kaPaged = await layoutKaWithPagedStrategy();
  return kaPaged;
}

function pagesById(blocks) {
  const map = new Map();
  for (const b of blocks) {
    const list = map.get(b.id);
    if (list) { if (!list.includes(b.page)) list.push(b.page); } else map.set(b.id, [b.page]);
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

async function testPagedCoverage() {
  const run = await ka();
  assertEqual(run.strategyName, 'pagedjs-0.4.3', 'openDocument must default to Paged.js');
  assertEqual(run.report.unplaced.length, 0,
    `${run.report.unplaced.length} stamped element(s) got no page`);
  assertEqual(run.report.stampedIds.length, 1360, 'quire must see all 1360 stamps');
  assert(run.pageCount > 100, `the book should run to well over 100 pages, got ${run.pageCount}`);
  assertEqual(run.report.documents.length, 24, 'Killing America has 24 spine documents');
}

/**
 * The headline result of gate G0. mupdf slices two of bm01's plates across a
 * page break and CSS multi-column reproduces exactly that failure; Paged.js
 * detects that an over-tall plate does not fit and moves it to a fresh page. Ten
 * image elements, ten unambiguous pages.
 */
async function testPagedImagesEachOnOnePage() {
  const run = await ka();
  const byId = pagesById(run.blocks.filter((b) => /#img\d+$/.test(b.id)));
  assertEqual(byId.size, 10, 'Killing America has 10 image elements');
  const split = [];
  for (const [id, pages] of byId) {
    if (pages.length !== 1) split.push(`${id} on pages ${pages.join(',')}`);
  }
  assert(split.length === 0,
    `${split.length} image(s) span a page break, which is the failure Paged.js was chosen to `
    + `fix: ${split.join('; ')}`);
  for (const b of run.blocks.filter((x) => /#img\d+$/.test(x.id))) {
    assert(b.splitFrom === null && b.splitTo === null,
      `${b.id} sits on one page but reports a split ${b.splitFrom}..${b.splitTo}`);
  }
  // And the three plates that mupdf and multicol straddle are each somewhere.
  for (const id of ['OEBPS/bm01.xhtml#img0', 'OEBPS/bm01.xhtml#img1', 'OEBPS/bm01.xhtml#img2']) {
    assert(byId.has(id), `${id} is not in the page map at all`);
  }
}

/**
 * Every split run must be coherent as quire reports it, on the real book: the
 * pages an element touches are consecutive, and every block of it names the same
 * first and last page. The OTHER half of this — that quire's geometry and
 * Paged.js's own data-split-from/data-split-to agree — is enforced inside the
 * measurement on every element of every document, and is proved to actually fire
 * by testPagedSplitDisagreementRefused below.
 */
async function testPagedSplitRunsCoherent() {
  const run = await ka();
  const byId = pagesById(run.blocks);
  let spanning = 0;
  for (const [id, pages] of byId) {
    for (let i = 1; i < pages.length; i++) {
      assertEqual(pages[i], pages[0] + i, `${id} occupies non-consecutive pages ${pages.join(',')}`);
    }
    const blocks = run.blocks.filter((b) => b.id === id);
    if (pages.length === 1) {
      for (const b of blocks) {
        assert(b.splitFrom === null && b.splitTo === null,
          `${id} sits on one page but reports splitFrom=${b.splitFrom} splitTo=${b.splitTo}`);
      }
      continue;
    }
    spanning++;
    for (const b of blocks) {
      assertEqual(b.splitFrom, pages[0], `${id} reports the wrong splitFrom`);
      assertEqual(b.splitTo, pages[pages.length - 1], `${id} reports the wrong splitTo`);
    }
  }
  assert(spanning > 20,
    `a book this long must have elements spanning page breaks; only ${spanning} did, which `
    + 'suggests the split detection is not running at all');
}

/**
 * The same book, paginated twice from scratch, produces the same map. This is
 * what makes caching a page map sound — and Paged.js mints a random `data-ref`
 * per element per run, so it is worth proving that none of that randomness
 * reaches the answer.
 */
async function testPagedDeterminism() {
  const first = await ka();
  const second = await layoutKaWithPagedStrategy();
  assertEqual(second.pageCount, first.pageCount,
    'two consecutive layouts disagree about how many pages the book has');
  const a = pagesById(first.blocks);
  const b = pagesById(second.blocks);
  assertEqual(b.size, a.size, 'two consecutive layouts placed a different number of ids');
  const differ = [];
  for (const [id, pages] of a) {
    const other = b.get(id);
    if (!other) { differ.push(`${id} vanished`); continue; }
    if (pages.join(',') !== other.join(',')) {
      differ.push(`${id}: ${pages.join(',')} then ${other.join(',')}`);
    }
  }
  assert(differ.length === 0,
    `${differ.length} id(s) landed on different pages the second time: ${differ.slice(0, 5).join('; ')}`);
}

/**
 * A small book, paginated with the product strategy and left open. Used by the
 * tests that need a live paginated document rather than a page map — the host
 * probe and the display path — so that neither of them pays for Killing America.
 * The caller closes it.
 */
async function smallPagedFixture() {
  const epubPath = path.join(scratch, 'paged-fixture.epub');
  const stamped = path.join(scratch, 'paged-fixture.stamped.epub');
  if (!fs.existsSync(stamped)) {
    const paras = [];
    for (let i = 0; i < 200; i++) {
      paras.push(`<p>Paragraph ${i} with enough words in it to fill a line or two of a page.</p>`);
    }
    await buildEpub(epubPath, [{ name: 'a.xhtml', xhtml: page(paras.join('')) }]);
    await stampEpubForQuire(epubPath, stamped, 'fixture');
  }
  const doc = await Quire.openDocument(stamped, { strategy: new PagedStrategy() });
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
  } catch (err) {
    await doc.close();
    throw err;
  }
  return doc;
}

/**
 * The rAF trap, as numbers rather than a belief — and there are TWO of them.
 *
 * Paged.js's work queue ticks on requestAnimationFrame (`src/utils/queue.js`),
 * so its throughput is the surface's frame rate. Every answer stays right when
 * that collapses; only the clock changes, which is exactly why it needs its own
 * test. Measured on this machine, one chapter of Killing America (13 pages):
 *
 * | host                                             | rAF    | per page |
 * |--------------------------------------------------|--------|----------|
 * | offscreen:true, backgroundThrottling:false       | 61 fps |    18 ms |
 * | shown at opacity 0, parked off-screen            | 60 fps |    18 ms |
 * | hidden, NOT offscreen (any backgroundThrottling) | 61 fps |   853 ms |
 * | offscreen with the frame rate forced to 1        |  1 fps |  1076 ms |
 *
 * Note the third row. A merely-hidden window paginates at about one page per
 * second — the figure the spike reported — while a naive rAF counter in it still
 * reads 60 fps: the callbacks fire, the layout work between them does not
 * progress. So counting frames alone would not catch the trap quire is actually
 * exposed to. Both are therefore asserted: the frame rate, which catches the
 * fourth row, and milliseconds per page on the real book, which catches the
 * third.
 *
 * quire's analysis host dodges it with `offscreen: true` rather than by showing
 * a transparent window, which is the same fix by a different route and does not
 * put a window on the user's desktop.
 */
async function testAnalysisHostIsNotThrottled() {
  const { OffscreenWindowHost } = require(path.join(DIST, 'packages/quire/src/index.js'));
  const doc = await smallPagedFixture();
  try {
    const host = await OffscreenWindowHost.create({ session: doc.session, width: 600, height: 900 });
    try {
      await host.load(doc.getPageMount(0).url);
      const raw = await host.evaluate(`new Promise((resolve) => {
        let n = 0; const t0 = performance.now();
        const tick = () => {
          n++;
          const dt = performance.now() - t0;
          if (dt >= 1000) { resolve(JSON.stringify({ fps: +(n / (dt / 1000)).toFixed(2) })); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`);
      const { fps } = JSON.parse(raw);
      console.log(`        (analysis host runs requestAnimationFrame at ${fps} fps)`);
      assert(fps >= 30,
        `the analysis host runs requestAnimationFrame at ${fps} fps. Paged.js's work queue ticks `
        + 'on rAF, so at this rate the book paginates at one page per frame. The surface must '
        + 'get real frames — quire\'s host asks for them with `offscreen: true`.');
    } finally {
      host.destroy();
    }
  } finally {
    await doc.close();
  }

  const run = await ka();
  const perPage = run.wallMs / run.pageCount;
  console.log(`        (Killing America: ${run.pageCount} pages in ${run.wallMs} ms, `
    + `${perPage.toFixed(1)} ms/page)`);
  assert(perPage < 100,
    `Killing America paginated at ${perPage.toFixed(1)} ms per page. A surface that gets real `
    + 'frames does about 20 ms/page and a merely-hidden one about 850 ms/page, so this is the '
    + 'host rather than the book. Check that the analysis window is still `offscreen: true`.');
  assert(run.wallMs < 25000,
    `Killing America took ${run.wallMs} ms to paginate; it takes about four seconds on a host `
    + 'that is getting frames and about two and a half minutes on one that is not.');
}

/**
 * The page box, checked against the layout — the Paged.js counterpart of
 * COLUMN_GAP_MISMATCH.
 *
 * If `@page { size }` never reaches the fragmenter, Paged.js silently uses its
 * own default (US Letter) and every page-local coordinate is measured against a
 * box that is not the page. Here the layout is correct and the ARITHMETIC is
 * doctored, which is the same disagreement from the other side, and quire must
 * refuse rather than report coordinates in a box nobody asked for.
 */
class WrongPageBoxStrategy extends PagedStrategy {
  pagedConfig(g) { return { ...super.pagedConfig(g), width: g.width - 50 }; }
}

/**
 * Paged.js's own record of a split, made to disagree with the geometry.
 *
 * The prelude is composed rather than rewritten: the real one runs first, and
 * then `Previewer.prototype.preview` is wrapped so that after a perfectly good
 * pagination one `data-split-to` marker is removed. Nothing about the layout
 * changes — the element still occupies two pages and quire still measures it on
 * both — so the only thing wrong is the engine's account of it. That is exactly
 * the disagreement quire promises to refuse instead of silently believing one
 * side of.
 */
class SplitMarkerTamperingStrategy extends PagedStrategy {
  preludeScript() {
    const real = super.preludeScript();
    return `(function(){
      var first = ${real};
      if (JSON.parse(first).error) return first;
      var P = globalThis.Paged.Previewer.prototype;
      var realPreview = P.preview;
      P.preview = async function () {
        var flow = await realPreview.apply(this, arguments);
        var victim = document.querySelector('.pagedjs_page [data-quire-id][data-split-to]');
        if (!victim) throw new Error('the tampering fixture found no split element to tamper with');
        victim.removeAttribute('data-split-to');
        return flow;
      };
      return first;
    })()`;
  }
}

async function testPagedRefusals() {
  const words = [];
  for (let i = 0; i < 400; i++) words.push(`word${i}`);
  const epub = path.join(scratch, 'paged-refuse.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: page(`<p>${words.join(' ')}</p>`) }]);
  const stamped = path.join(scratch, 'paged-refuse.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'refuse');

  // Sanity: the fixture paginates fine when nothing is doctored.
  const ok = await Quire.openDocument(stamped, { strategy: new PagedStrategy() });
  try {
    await ok.layout({ width: 600, height: 900, fontSize: 18 });
    assert(ok.countPages() > 1, 'the fixture was meant to be longer than one page');
  } finally {
    await ok.close();
  }

  const refuse = async (strategy, mustName, what) => {
    const bad = await Quire.openDocument(stamped, { strategy });
    let threw = null;
    try {
      await bad.layout({ width: 600, height: 900, fontSize: 18 });
    } catch (err) {
      threw = err;
    } finally {
      await bad.close();
    }
    assert(threw !== null, `quire accepted ${what}`);
    assert(threw instanceof QuireError, `expected a QuireError for ${what}, got ${threw && threw.name}`);
    assert(mustName.test(threw.message),
      `the refusal for ${what} should name what disagreed; it said: ${threw.message}`);
  };

  await refuse(new WrongPageBoxStrategy(), /PAGE_BOX_MISMATCH/,
    'a page box that is not the box the arithmetic assumes');
  await refuse(new SplitMarkerTamperingStrategy(), /SPLIT_DISAGREEMENT/,
    "Paged.js's own split record disagreeing with the measured pages");
}

/**
 * A box the book made SCROLL, taller than the page — the CES letter's failure.
 *
 * Reported live 2026-08-10: the CES letter would not open at all, on
 * `SPLIT_DISAGREEMENT` for a `<p>` said to occupy two pages with no split
 * marker on either. Measured, it was not a mis-recorded split. Foundry's own
 * converter stylesheet wraps every table in `.tablewrap { overflow-x: auto }`,
 * which makes the wrapper a scroll container, which CSS Fragmentation calls
 * MONOLITHIC — never broken across fragmentainers. Paged.js fragments by laying
 * the page content out one column wide, so a monolithic box taller than that
 * column (859px of table in an 804px content box) cannot go anywhere: Chromium
 * pushed it clean out of the visible column, Paged.js took its "stop removal if
 * we are in a loop" branch, warned `Unable to layout item`, LEFT the overflow in
 * the page and restarted the next page at the following sibling. Page 11 of that
 * chapter was blank, and every element of page 12 was also still sitting in page
 * 11's clipped overflow — nine of them, whole, twice.
 *
 * The geometry here is that geometry: the converter's stylesheet verbatim, a
 * twenty-row table with a two-line header, and two paragraphs before it so the
 * wrapper lands at the top of a page that is not the last. Both halves are
 * asserted, and they need each other:
 *
 *  - WITHOUT the rule (a strategy that strips exactly it from the layout CSS,
 *    which is why the rule is exported as its own constant), quire must still
 *    refuse — and refuse as `CONTENT_REPEATED`, naming repetition rather than a
 *    disagreement about a split, because that is what actually happened;
 *  - WITH it, the book paginates, the table breaks across the two pages like a
 *    table, and nothing is parked a whole column off the page.
 */
class NoOverflowRuleStrategy extends PagedStrategy {
  layoutCss(g) {
    const css = super.layoutCss(g);
    if (!css.includes(MONOLITHIC_OVERFLOW_RULE)) {
      throw new Error('the fixture could not find MONOLITHIC_OVERFLOW_RULE in the layout CSS to '
        + 'strip; the rule and this test have drifted apart');
    }
    return css.replace(MONOLITHIC_OVERFLOW_RULE, '');
  }
}

async function testMonolithicOverflowIsFragmented() {
  // Foundry's converter stylesheet, as it ships in a vlm-converted EPUB.
  const css = '.tablewrap { margin: 1em 0; overflow-x: auto; }'
    + 'table { border-collapse: collapse; margin: 0 auto; }'
    + 'td, th { border: none; padding: 0.35em 1.1em; }'
    + 'th { border-bottom: 1px solid currentColor; }'
    + 'body { margin: 0 5%; line-height: 1.5; }'
    + 'p { margin: 0 0 0.4em; text-indent: 1.4em; }'
    + 'p.centered { text-indent: 0; text-align: center; }'
    + 'h2 { line-height: 1.2; margin: 1.4em 0 0.8em; }';

  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(`<tr><td>Placename ${i}</td><td>Bookname ${i}</td></tr>`);
  }
  // The trailing text is long ON PURPOSE. Paged.js only re-checks for a break
  // every MAX_CHARS_PER_BREAK (1500) characters, and it is that re-check — not
  // the end-of-document one — whose "unable to layout" branch keeps the overflow
  // and restarts the next page at the following sibling. With a short tail the
  // fragmenter reaches the end of the document first, takes the other branch,
  // and merely leaves a blank page: the same root fault without the repetition.
  const trailing = [
    '<p class="centered">Source paragraph immediately after the table, which is the element the '
    + 'live failure named, and which runs on for long enough to give the fragmenter real work.</p>',
  ];
  for (let i = 0; i < 6; i++) {
    trailing.push(`<p>Trailing paragraph ${i}. `
      + 'Every one of these carries enough words that the running character count reaches the '
      + 'fragmenter\'s own break threshold before the walker runs out of document. '.repeat(2)
      + '</p>');
  }
  trailing.push('<h2>A HEADING AFTER THE TABLE</h2>');
  // The wrapper opens the document, which is what puts it at the top of a page
  // with the page's break token already pointing at it — the state the CES
  // letter's chapter reached at its page 11.
  const body = '<div class="tablewrap"><table><thead><tr><th>MODERN<br/>GEOGRAPHIC PLACE</th>'
    + `<th>BOOK OF<br/>MORMON NAME</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    + trailing.join('');
  const xhtml = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>'
    + `<style>${css}</style></head><body>${body}</body></html>`;

  const epubPath = path.join(scratch, 'monolithic.epub');
  const stamped = path.join(scratch, 'monolithic.stamped.epub');
  await buildEpub(epubPath, [{ name: 'a.xhtml', xhtml }]);
  await stampEpubForQuire(epubPath, stamped, 'monolithic');

  // ── Without the rule: the failure, and the refusal that names it ────────
  const unfixed = await Quire.openDocument(stamped, { strategy: new NoOverflowRuleStrategy() });
  let threw = null;
  try {
    await unfixed.layout({ width: 600, height: 900, fontSize: 18 });
  } catch (err) {
    threw = err;
  } finally {
    await unfixed.close();
  }
  assert(threw !== null,
    'the fixture no longer reproduces the CES letter\'s failure without the overflow rule, so it '
    + 'is no longer proving that the rule is what fixes it');
  assert(/CONTENT_REPEATED/.test(threw.message),
    'a scroll container taller than the page makes Paged.js emit whole elements twice, and quire '
    + `must say so rather than call it a split disagreement; it said: ${threw.message}`);

  // ── With it: a table that breaks like a table ───────────────────────────
  const doc = await Quire.openDocument(stamped, { strategy: new PagedStrategy() });
  try {
    const report = await doc.layout({ width: 600, height: 900, fontSize: 18 });
    assertEqual(report.unplaced.length, 0, 'a stamped element of the fixture got no page');
    assert(doc.countPages() >= 2,
      `the fixture was meant to run past one page; it made ${doc.countPages()}`);

    const idPages = new Map();
    for (let p = 0; p < doc.countPages(); p++) {
      for (const block of doc.loadPage(p).getBlocks()) {
        if (!idPages.has(block.id)) idPages.set(block.id, []);
        if (!idPages.get(block.id).includes(p)) idPages.get(block.id).push(p);
      }
    }
    // The table is the thing that was unfragmentable, so the proof that it is
    // fragmentable now is that it is on two pages — as a SPLIT, which is a claim
    // quire will only make after checking Paged.js's markers agree with it.
    const tablePages = idPages.get('OEBPS/a.xhtml#0');
    assert(tablePages && tablePages.length === 2,
      'the table is taller than a page and must now break across two, rather than be pushed off '
      + `the page whole; quire puts it on ${tablePages ? tablePages.join(',') : 'no page'}`);

    // And nothing that FOLLOWS the table may sit off the page at all. That is
    // the shape of the failure: with the wrapper unfragmentable, every element
    // after it was parked in the next column, 1600px away, while the page the
    // reader sees stayed blank.
    //
    // The table itself is allowed one, and only it. Chromium splits the row that
    // straddles the column boundary rather than moving it whole, so a sliver of
    // that row stays behind where Paged.js has already moved the row on — which
    // makes the table's union box reach into the next column. That is a
    // fragmenter artifact of tables, not of this rule; it is CLIPPED, it is
    // reported in `report.overflows` where a caller can see it, and the row's
    // words are on the next page in full.
    const parked = report.overflows.filter((o) => o.id !== 'OEBPS/a.xhtml#0');
    assertEqual(parked.length, 0,
      'nothing after the table may reach outside its page box; '
      + parked.map((o) => `${o.id} by ${o.overshoot}px on ${o.axis}`).join(', ')
      + ' does, which is where Paged.js parks overflow it could not extract');
  } finally {
    await doc.close();
  }
}

/**
 * The DISPLAY path — the half of the package that is the product — through the
 * fragmenter, and the sandbox still intact on the other side.
 *
 * `presentPage` loads a spine document into a surface, puts the engine in front
 * of it (from the isolated world, never as a `<script>` the book could see),
 * builds the page boxes and brings one of them to the origin. Afterwards the
 * book's own document must still hold zero `<script>` elements: quire added the
 * fragmenter to the frame without adding anything the book can reach.
 */
async function testPagedDisplayPath() {
  const { OffscreenWindowHost } = require(path.join(DIST, 'packages/quire/src/index.js'));
  const doc = await smallPagedFixture();
  try {
    const last = doc.countPages() - 1;
    assert(last >= 2, 'the display fixture was meant to run to several pages');

    const mount = doc.getPageMount(last);
    assertEqual(mount.boxModel, 'fragmented-boxes', 'the Paged.js mount must say fragmented-boxes');
    assert(typeof mount.preludeScript === 'string',
      'the mount must carry the engine, since the page boxes do not exist in the served bytes');
    assert(/@license Paged\.js v0\.4\.3/.test(mount.preludeScript),
      "the mount's prelude is not the vendored Paged.js bundle");

    const host = await OffscreenWindowHost.create({ session: doc.session, width: 600, height: 900 });
    try {
      await doc.presentPage(last, host);
      const raw = await host.evaluate(`JSON.stringify({
        scripts: document.querySelectorAll('script').length,
        boxes: document.querySelectorAll('.pagedjs_page').length,
        atOrigin: (function () {
          const p = document.querySelectorAll('.pagedjs_page')[${last}];
          if (!p) return null;
          const r = p.getBoundingClientRect();
          return { left: Math.round(r.left), top: Math.round(r.top),
                   w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      })`);
      const seen = JSON.parse(raw);
      assertEqual(seen.scripts, 0,
        'the fragmenter put a <script> into the book\'s document, which the book could then read');
      assertEqual(seen.boxes, doc.countPages(),
        'the display surface produced a different number of page boxes than the measurement did');
      assert(seen.atOrigin !== null, `page ${last} has no box on the display surface`);
      assertEqual(seen.atOrigin.left, 0, `page ${last} is not at the surface origin horizontally`);
      assertEqual(seen.atOrigin.top, 0, `page ${last} is not at the surface origin vertically`);
      assertEqual(seen.atOrigin.w, 600, 'the presented page box is not the page width');
      assertEqual(seen.atOrigin.h, 900, 'the presented page box is not the page height');
    } finally {
      host.destroy();
    }

    // And the raster really follows the page. `capturePage` hands back the LAST
    // PAINTED frame, so a surface that is scrolled and photographed in the same
    // turn produces a confident picture of the page it used to be showing — the
    // sort of failure where every page number is right and every thumbnail is
    // wrong. Two different pages must produce two different images.
    const firstPng = await doc.loadPage(0).toPng(1);
    const lastPng = await doc.loadPage(last).toPng(1);
    assert(firstPng.length > 0 && lastPng.length > 0, 'a page rasterized to nothing');
    assert(!firstPng.equals(lastPng),
      `page 0 and page ${last} produced byte-identical rasters, which means the capture is a `
      + 'stale frame rather than the page that was asked for');
  } finally {
    await doc.close();
  }
}

// ── Incremental relayout ──────────────────────────────────────────────────
/**
 * The oracle: an incrementally relaid book must be INDISTINGUISHABLE from the
 * same edited book opened from scratch.
 *
 * That equality is the whole claim `relayoutDocument` makes. Renaming a chapter
 * rewrites one spine document, and the window lays that one out again instead of
 * re-opening the book — which is only allowed if the result is the same book.
 * Not "close enough" and not "the same page count": every page's blocks, every
 * box, every split run, every document offset, every stamped id, in order.
 *
 * The edit is deliberately one that CHANGES THE PAGE COUNT — a chapter heading
 * long enough to run past a page on its own — because the arithmetic being
 * tested is the re-numbering of every document after the one that moved. An edit
 * that fitted in the same pages would prove nothing about it.
 */
function relayoutSnapshot(doc) {
  const report = doc.getReport();
  const pageCount = doc.countPages();
  const pages = [];
  for (let p = 0; p < pageCount; p++) pages.push(doc.loadPage(p).getBlocks());
  return {
    pageCount,
    pages,
    documents: report.documents,
    documentPageOffsets: report.documentPageOffsets,
    stampedIds: report.stampedIds,
    unplaced: report.unplaced,
    overflows: report.overflows,
  };
}

/** Deep equality that NAMES where two snapshots part company. */
function assertSameSnapshot(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  throw new Error(
    `${what}: the two page maps diverge at character ${at} of their serialization — `
    + `incremental says …${a.slice(Math.max(0, at - 80), at + 80)}… and a fresh layout says `
    + `…${b.slice(Math.max(0, at - 80), at + 80)}…`);
}

/** One zip entry of a book, as text. */
async function entryText(epubPath, entry) {
  const processor = new EpubProcessor();
  try {
    await processor.open(epubPath);
    return await processor.readFile(entry);
  } finally {
    processor.close();
  }
}

/** The four-chapter fixture, with chapter two written either way. */
function relayoutFixtureDocuments(chapterTwoHeading) {
  const body = (n, heading) => {
    const paras = [];
    for (let i = 0; i < n; i++) {
      paras.push(`<p>Paragraph ${i} of this chapter, carrying enough words to set a line or two `
        + 'of the page and give the fragmenter somewhere to break.</p>');
    }
    return `<h1>${heading}</h1>${paras.join('')}`;
  };
  return [
    { name: 'a.xhtml', xhtml: page(body(12, 'Chapter One'), 'One') },
    { name: 'b.xhtml', xhtml: page(body(40, chapterTwoHeading), 'Two') },
    { name: 'c.xhtml', xhtml: page(body(18, 'Chapter Three'), 'Three') },
    { name: 'd.xhtml', xhtml: page(body(9, 'Chapter Four'), 'Four') },
  ];
}

/** A chapter name long enough that it fills more than a page by itself. */
function overlongChapterName() {
  const words = [];
  for (let i = 0; i < 150; i++) words.push(`Renamed${i}`);
  return words.join(' ');
}

async function testRelayoutMatchesAFreshLayout() {
  const before = path.join(scratch, 'relayout-before.epub');
  const after = path.join(scratch, 'relayout-after.epub');
  const stampedBefore = path.join(scratch, 'relayout-before.stamped.epub');
  const stampedAfter = path.join(scratch, 'relayout-after.stamped.epub');
  await buildEpub(before, relayoutFixtureDocuments('Chapter Two'));
  await buildEpub(after, relayoutFixtureDocuments(overlongChapterName()));
  await stampEpubForQuire(before, stampedBefore, 'relayout-before');
  await stampEpubForQuire(after, stampedAfter, 'relayout-after');

  // The stamps of the UNCHANGED documents must be identical in the two books —
  // the premise the whole incremental path rests on, and the reason a caller may
  // re-stamp only what it rewrote. Asserted here rather than assumed.
  for (const entry of ['OEBPS/a.xhtml', 'OEBPS/c.xhtml', 'OEBPS/d.xhtml']) {
    assertEqual(await entryText(stampedAfter, entry), await entryText(stampedBefore, entry),
      `${entry} was not rewritten, so its stamped bytes must be the same in both books`);
  }

  const edited = await entryText(stampedAfter, 'OEBPS/b.xhtml');

  const doc = await Quire.openDocument(stampedBefore, { strategy: new PagedStrategy() });
  let incremental;
  let pagesBefore;
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    pagesBefore = doc.countPages();
    await doc.relayoutDocument('OEBPS/b.xhtml', edited);
    incremental = relayoutSnapshot(doc);
  } finally {
    await doc.close();
  }

  const fresh = await Quire.openDocument(stampedAfter, { strategy: new PagedStrategy() });
  let whole;
  try {
    await fresh.layout({ width: 600, height: 900, fontSize: 18 });
    whole = relayoutSnapshot(fresh);
  } finally {
    await fresh.close();
  }

  assert(incremental.pageCount > pagesBefore,
    `the fixture was meant to GAIN pages so the re-numbering of the documents after chapter two `
    + `is under test; it went from ${pagesBefore} to ${incremental.pageCount}`);
  assertEqual(incremental.pageCount, whole.pageCount,
    'the relaid book and the freshly opened one disagree about how many pages the book has');
  assertSameSnapshot(incremental, whole, 'a relaid book against a fresh open of the same bytes');
}

/**
 * A relayout that trips the measurement's own verification refuses, and the
 * document goes on answering exactly what it answered before the attempt.
 *
 * The doctored pattern is the CES letter's, reused: a scroll container taller
 * than the page, laid out by a strategy with `MONOLITHIC_OVERFLOW_RULE` stripped,
 * which makes Paged.js emit whole elements twice. It is the same check the full
 * layout runs — nothing about the incremental path is exempt from it — and the
 * point here is the state AFTERWARDS.
 */
async function testRelayoutRefusalLeavesTheBookAsItWas() {
  const bookPath = path.join(scratch, 'relayout-refuse.epub');
  const stamped = path.join(scratch, 'relayout-refuse.stamped.epub');
  await buildEpub(bookPath, relayoutFixtureDocuments('Chapter Two'));
  await stampEpubForQuire(bookPath, stamped, 'relayout-refuse');

  // The poison, stamped under the entry name it will be relaid into, so the ids
  // that come back are the ids that document's elements would really carry.
  const css = '.tablewrap { margin: 1em 0; overflow-x: auto; }'
    + 'table { border-collapse: collapse; margin: 0 auto; }'
    + 'td, th { border: none; padding: 0.35em 1.1em; }'
    + 'th { border-bottom: 1px solid currentColor; }'
    + 'body { margin: 0 5%; line-height: 1.5; }'
    + 'p { margin: 0 0 0.4em; text-indent: 1.4em; }';
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(`<tr><td>Placename ${i}</td><td>Bookname ${i}</td></tr>`);
  const trailing = [];
  for (let i = 0; i < 6; i++) {
    trailing.push(`<p>Trailing paragraph ${i}. `
      + 'Every one of these carries enough words that the running character count reaches the '
      + 'fragmenter\'s own break threshold before the walker runs out of document. '.repeat(2)
      + '</p>');
  }
  const poisonBody = '<div class="tablewrap"><table><thead><tr><th>MODERN<br/>GEOGRAPHIC PLACE</th>'
    + `<th>BOOK OF<br/>MORMON NAME</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    + trailing.join('');
  const poisonPath = path.join(scratch, 'relayout-poison.epub');
  const poisonStamped = path.join(scratch, 'relayout-poison.stamped.epub');
  await buildEpub(poisonPath, [{
    name: 'b.xhtml',
    xhtml: '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title>'
      + `<style>${css}</style></head><body>${poisonBody}</body></html>`,
  }]);
  await stampEpubForQuire(poisonPath, poisonStamped, 'relayout-poison');
  const poison = await entryText(poisonStamped, 'OEBPS/b.xhtml');

  const doc = await Quire.openDocument(stamped, { strategy: new NoOverflowRuleStrategy() });
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const was = relayoutSnapshot(doc);

    let threw = null;
    try {
      await doc.relayoutDocument('OEBPS/b.xhtml', poison);
    } catch (err) {
      threw = err;
    }
    assert(threw !== null,
      'quire accepted a relayout of markup that makes the fragmenter emit whole elements twice; '
      + 'the incremental path is not running the verification the full one does');
    assert(threw instanceof QuireError,
      `expected a QuireError from a refused relayout, got ${threw && threw.name}`);
    assert(/CONTENT_REPEATED/.test(threw.message),
      `the refusal must name the repetition; it said: ${threw.message}`);

    assertSameSnapshot(relayoutSnapshot(doc), was,
      'a book after a REFUSED relayout, against the same book before it');

    // And it is still a working document, not merely an unchanged one: the pages
    // still load and a good relayout still lands.
    assertEqual(doc.loadPage(0).getBlocks().length, was.pages[0].length,
      'page 0 stopped answering after a refused relayout');
  } finally {
    await doc.close();
  }
}

async function testRelayoutOfAnUnknownEntryIsRefused() {
  const bookPath = path.join(scratch, 'relayout-unknown.epub');
  const stamped = path.join(scratch, 'relayout-unknown.stamped.epub');
  await buildEpub(bookPath, relayoutFixtureDocuments('Chapter Two'));
  await stampEpubForQuire(bookPath, stamped, 'relayout-unknown');

  const doc = await Quire.openDocument(stamped, { strategy: new PagedStrategy() });
  try {
    await doc.layout({ width: 600, height: 900, fontSize: 18 });
    const was = relayoutSnapshot(doc);

    for (const [entry, source, code] of [
      ['OEBPS/nav.xhtml', page('<p>the navigation document has no pages</p>'), /NOT_A_SPINE_DOCUMENT/],
      ['OEBPS/never-existed.xhtml', page('<p>nor does this</p>'), /NOT_A_SPINE_DOCUMENT/],
      ['OEBPS/b.xhtml', '   ', /EMPTY_RELAYOUT_SOURCE/],
    ]) {
      let threw = null;
      try {
        await doc.relayoutDocument(entry, source);
      } catch (err) {
        threw = err;
      }
      assert(threw !== null, `quire accepted a relayout of ${entry}`);
      assert(threw instanceof QuireError,
        `expected a QuireError for ${entry}, got ${threw && threw.name}`);
      assert(code.test(threw.message),
        `the refusal for ${entry} should name what was wrong; it said: ${threw.message}`);
    }

    assertSameSnapshot(relayoutSnapshot(doc), was,
      'a book after three refused relayouts, against the same book before them');
  } finally {
    await doc.close();
  }
}

// ── run ───────────────────────────────────────────────────────────────────
async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-test-'));
  console.log('quire tests');
  console.log('');
  console.log('identity');
  await check('stamps match the narration enumeration, element for element', testIdentity);
  console.log('pagination');
  await check('an element spanning a page break is split, not repeated (Paged.js)',
    () => testSplitDetection(new PagedStrategy()));
  await check('an element spanning a page break is split, not repeated (multi-column)',
    () => testSplitDetection(new MultiColumnStrategy()));
  await check('a document that renders nothing still takes a page (Paged.js)',
    () => testEmptyDocumentStillTakesAPage(new PagedStrategy()));
  await check('a document that renders nothing still takes a page (multi-column)',
    () => testEmptyDocumentStillTakesAPage(new MultiColumnStrategy()));
  await check('a gutter that disagrees with the arithmetic is refused', testGapArithmeticRefused);
  console.log('protocol');
  await check('path escapes are refused by rule', testPathEscapeUnit);
  await check('path escapes are refused live', testPathEscapeLive);
  console.log('sandbox');
  await check('the book\'s own script never runs', testScriptDoesNotRun);
  await check('remote references never leave the machine', testRemoteLoadsBlocked);
  await check('an unsandboxed surface is refused', testSandboxPreferencesEnforced);
  console.log('paged.js');
  await check('the vendored bundle is the artifact that was audited', testVendoredBundle);
  await check('every stamped element of Killing America gets a page', testPagedCoverage);
  await check('all ten images land on exactly one page each', testPagedImagesEachOnOnePage);
  await check('every split run is coherent across the whole book', testPagedSplitRunsCoherent);
  await check('two layouts of the same book produce the same map', testPagedDeterminism);
  await check('the analysis host is not rAF-throttled', testAnalysisHostIsNotThrottled);
  await check('a doctored page box and a doctored split record are both refused', testPagedRefusals);
  await check('a box the book made scroll is fragmented, not emitted twice',
    testMonolithicOverflowIsFragmented);
  await check('the display path shows the asked-for page and adds no script', testPagedDisplayPath);
  console.log('incremental relayout');
  await check('a relaid document produces the same book as a fresh layout of the edited file',
    testRelayoutMatchesAFreshLayout);
  await check('a refused relayout leaves the book answering exactly as it did',
    testRelayoutRefusalLeavesTheBookAsItWas);
  await check('a relayout of a document the spine does not have is refused',
    testRelayoutOfAnUnknownEntryIsRefused);

  console.log('');
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('');
    for (const f of failures) {
      console.log(`FAILED: ${f.name}`);
      console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
      console.log('');
    }
  }
  return failures.length === 0 ? 0 : 1;
}

app.whenReady()
  .then(main)
  .then((code) => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(code);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(1);
  });
