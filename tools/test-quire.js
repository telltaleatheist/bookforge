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
 *     rather than repeated.
 *  3. GAP ARITHMETIC — if the pitch used for the arithmetic is not the pitch the
 *     layout used, quire REFUSES. Proved by laying a document out at one gutter
 *     and measuring it at another, which is the exact failure the assertion is
 *     for.
 *  4. PATH ESCAPE — the protocol refuses to serve anything outside the archive,
 *     both as a unit test of the rule and live through a loaded document.
 *  5. SANDBOX — a book's own script does not run, and a book's remote reference
 *     does not leave the machine.
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
  Quire, resolveQuireRequest, MultiColumnStrategy, QuireError,
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
  } finally {
    await doc.close();
  }
}

// ── 2. Split detection ────────────────────────────────────────────────────
async function testSplitDetection() {
  const words = [];
  for (let i = 0; i < 400; i++) words.push(`word${i}`);
  const long = words.join(' ');
  const epub = path.join(scratch, 'split.epub');
  await buildEpub(epub, [{ name: 'a.xhtml', xhtml: page(`<p>${long}</p>`) }]);

  const stamped = path.join(scratch, 'split.stamped.epub');
  await stampEpubForQuire(epub, stamped, 'split');
  const doc = await Quire.openDocument(stamped);
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

  // Sanity: the same book with a CONSISTENT gutter lays out fine.
  const ok = await Quire.openDocument(stamped);
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

// ── run ───────────────────────────────────────────────────────────────────
async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-test-'));
  console.log('quire tests');
  console.log('');
  console.log('identity');
  await check('stamps match the narration enumeration, element for element', testIdentity);
  console.log('pagination');
  await check('an element spanning a page break is split, not repeated', testSplitDetection);
  await check('a gutter that disagrees with the arithmetic is refused', testGapArithmeticRefused);
  console.log('protocol');
  await check('path escapes are refused by rule', testPathEscapeUnit);
  await check('path escapes are refused live', testPathEscapeLive);
  console.log('sandbox');
  await check('the book\'s own script never runs', testScriptDoesNotRun);
  await check('remote references never leave the machine', testRemoteLoadsBlocked);
  await check('an unsandboxed surface is refused', testSandboxPreferencesEnforced);

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
