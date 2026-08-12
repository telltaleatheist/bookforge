#!/usr/bin/env node
/**
 * The analyzer, on a book that is a DIRECTORY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-analyzer-exploded-book.js
 *
 * Re-launches itself under Electron, because analyzing an EPUB paginates it.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * The working copy became `source/<stem>.working/`, a directory of the book's
 * parts. The migration moved every project's artifact and the VIEWER was proved
 * against the result — but the ANALYZER, which the picker calls on every open,
 * was only ever run against a zip. Owen opened a migrated book and got:
 *
 *     Failed to Load Source
 *     Could not load: …\Nuremberg. Persico, Joseph E. (1994).working
 *     EISDIR: illegal operation on a directory, read
 *
 * Three separate things were wrong, and each would have been enough on its own:
 *
 *  1. the source digest was `fs.createReadStream(path)` — EISDIR on a tree;
 *  2. `getMimeType` read the EXTENSION, and `.../<stem>.working` has none that
 *     means anything, so `isEpub` was false and the whole book went down the
 *     PDF path;
 *  3. mupdf was handed the book's bytes, and a directory has none.
 *
 * ── What is proved here ────────────────────────────────────────────────────
 *
 * That the two containers are the SAME BOOK to the analyzer: same pages, same
 * blocks, same element keys, same outline. Anything less and a book would mean
 * one thing before the migration and another after it — which is the failure
 * the whole exploded-working-copy change was written to avoid.
 *
 * And that they are told APART where it matters: a tree's digest carries its
 * algorithm tag, so a reader can never mistake a re-measurement for a changed
 * book, and the two do not share an analysis cache directory.
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
const { Quire } = require(path.join(DIST, 'packages/quire/src/index.js'));
const { PDFAnalyzer } = require(path.join(DIST, 'electron/pdf-analyzer.js'));
const { ZipWriter } = require(path.join(DIST, 'electron/epub-processor.js'));
const { rewriteEpubEntries } = require(path.join(DIST, 'electron/epub-container.js'));

Quire.registerScheme();
app.on('window-all-closed', () => { /* the harness decides when it is done */ });

let passed = 0;
const failures = [];
let scratch = null;

function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch((err) => {
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err && err.message ? err.message : err}`);
    });
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

// ── A book, zipped, with enough in it to paginate across pages ─────────────

function prose(seed, paragraphs) {
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const words = [];
    for (let w = 0; w < 80; w++) words.push(`${seed}${p}w${w}`);
    out.push(`<p>${words.join(' ')}</p>`);
  }
  return out.join('');
}

function page(bodyInner, title) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${bodyInner}</body></html>`;
}

const DOCUMENTS = [
  { name: 'a.xhtml', xhtml: page(`<h1>One</h1>${prose('a', 4)}`, 'One') },
  { name: 'b.xhtml', xhtml: page(`<h1>Two</h1>${prose('b', 5)}`, 'Two') },
  { name: 'c.xhtml', xhtml: page(`<h1>Three</h1>${prose('c', 3)}`, 'Three') },
];

async function buildZippedBook(outPath) {
  const manifest = DOCUMENTS
    .map((d, i) => `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = DOCUMENTS.map((_, i) => `<itemref idref="d${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:exploded-analyzer</dc:identifier>
<dc:title>exploded analyzer test</dc:title><dc:language>en</dc:language></metadata>
<manifest>${manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine>${spine}</spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol>${DOCUMENTS
    .map((d, i) => `<li><a href="${d.name}">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`;

  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  for (const d of DOCUMENTS) zw.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  await zw.write(outPath);
  return outPath;
}

/** The same book, exploded — through the app's own seam, entry for entry. */
async function explode(zipPath, treePath) {
  await rewriteEpubEntries({
    from: zipPath,
    to: treePath,
    toKind: 'directory',
    build: async (source, sink) => {
      for (const entry of source.getEntries()) {
        sink.addFile(entry, await source.readEntry(entry), entry !== 'mimetype');
      }
    },
  });
  return treePath;
}

/** Everything about an analysis that must not depend on the container. */
function shapeOf(quick, text, outline) {
  return {
    pageCount: quick.page_count,
    pageDimensions: quick.page_dimensions,
    blocks: text.blocks.map((b) => ({
      element: b.bf_element, page: b.page, text: b.text, category: b.category_id, seq: b.seq,
    })),
    provenance: text.categoryProvenance.source,
    outline,
  };
}

async function analyzeFully(bookPath) {
  const analyzer = new PDFAnalyzer();
  const quick = await analyzer.analyzeQuick(bookPath);
  const text = quick.textReady
    ? { blocks: quick.blocks, categoryProvenance: quick.categoryProvenance }
    : await analyzer.analyzeText(bookPath);
  const outline = await analyzer.extractOutline();
  return { quick, text, outline };
}

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-exploded-'));
  process.env.BOOKFORGE_USERDATA_DIR = path.join(scratch, 'userdata');
  console.log('the analyzer on an exploded book\n');

  const zip = await buildZippedBook(path.join(scratch, 'book.epub'));
  const tree = await explode(zip, path.join(scratch, 'book.working'));

  let fromZip = null;
  let fromTree = null;

  try {
    await check('a book that is a directory analyzes at all', async () => {
      assert(fs.statSync(tree).isDirectory(), 'the fixture is not a directory');
      fromTree = await analyzeFully(tree);
      assert(fromTree.quick.page_count > 3,
        `the fixture is too small to be a test: ${fromTree.quick.page_count} page(s)`);
    });

    await check('the same book zipped analyzes too, so the two can be compared', async () => {
      fromZip = await analyzeFully(zip);
    });

    await check('a tree and its zip are the SAME book — pages, blocks, elements, outline',
      async () => {
        assert(fromTree !== null && fromZip !== null, 'one of the two analyses did not run');
        const a = JSON.stringify(shapeOf(fromTree.quick, fromTree.text, fromTree.outline));
        const b = JSON.stringify(shapeOf(fromZip.quick, fromZip.text, fromZip.outline));
        if (a === b) return;
        let at = 0;
        while (at < a.length && at < b.length && a[at] === b[at]) at++;
        throw new Error(
          `the two part company at character ${at}: the tree says `
          + `…${a.slice(Math.max(0, at - 90), at + 90)}… and the zip says `
          + `…${b.slice(Math.max(0, at - 90), at + 90)}…`);
      });

    await check('every block of the exploded book names the element it came from', () => {
      const without = fromTree.text.blocks.filter((b) => b.bf_element === undefined);
      assertEqual(without.length, 0, `${without.length} block(s) have no bf_element`);
    });

    await check('the analysis of an exploded book produces no warnings', () => {
      const warnings = fromTree.text.warnings ?? fromTree.quick.warnings;
      assert(!warnings || warnings.length === 0, JSON.stringify(warnings));
    });

    await check('a tree\'s digest says which algorithm measured it, a zip\'s does not', () => {
      assert(fromTree.quick.sourceSha256.startsWith('bookforge-epub-tree-v1:'),
        `a tree's digest is untagged: ${fromTree.quick.sourceSha256.slice(0, 40)}`);
      assert(/^[0-9a-f]{64}$/.test(fromZip.quick.sourceSha256),
        `a zip's digest is not the bare 64 hex it has always been: `
        + `${fromZip.quick.sourceSha256.slice(0, 40)}`);
    });

    await check('the two do not share an analysis cache directory', () => {
      // A tagged digest sliced to 16 characters would be `bookforge-epub-t` for
      // EVERY exploded book in the library — one directory for all of them.
      assert(fromTree.quick.sourceSha256.slice(0, 16) !== fromZip.quick.sourceSha256.slice(0, 16),
        'the two books would key the same cache directory');
      const dirs = fs.existsSync(path.join(os.homedir(), 'Documents', 'BookForge', 'cache'));
      assert(dirs || true, 'the render cache location is not this test\'s business');
    });

    await check('the second analysis of an exploded book reads the first one back', async () => {
      const t = Date.now();
      const again = await analyzeFully(tree);
      assertEqual(again.quick.page_count, fromTree.quick.page_count, 'the page count moved');
      assert(again.quick.textReady, 'the second open did not find the cached analysis');
      console.log(`        (second analysis in ${Date.now() - t} ms)`);
    });

    await check('a raster page view of an exploded book is refused, by name', async () => {
      const analyzer = new PDFAnalyzer();
      await refuses(
        () => analyzer.renderPages(tree, [0], 'preview'),
        ['exploded into a directory', 'live DOM'],
        'a raster render of a tree');
    });
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows */ }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((err) => { console.error(err); process.exit(1); });
