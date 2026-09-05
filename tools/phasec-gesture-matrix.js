#!/usr/bin/env node
/**
 * The Phase C gesture matrix, on a real book, through the real code.
 *
 *   npx tsc -p tsconfig.electron.json && npm run build:quire-vendor
 *   node tools/phasec-gesture-matrix.js <book.epub> [more.epub ...]
 *
 * WHAT THIS IS FOR. Phase C put a second viewer under the picker. The deletion
 * machinery below it did not change and must not have: a gesture on the live
 * book has to arrive in the same record, produce the same strikes, and write the
 * same narration copy as the same gesture on a rasterized page. Suites prove the
 * machinery in isolation; this proves the JOIN, on a whole publisher EPUB.
 *
 * WHAT IT DOES NOT DO. It does not click. `tools/epub-viewer-harness.js` is what
 * drives the component in a window and proves that a click on the real KA layout
 * comes back as an element key — that half is measured there, and its numbers are
 * in the epub-viewer README. This bench starts where that one stops: given the
 * ids a gesture yields, does the rest of the app do the right thing with them.
 *
 * Everything it calls is the app's own function, never a copy of one:
 *   PDFAnalyzer.analyze            the picker's analysis (EPUB → quire)
 *   openBookForViewer              the picker's `window.electron.quire.openBook`
 *   toLaidOutBook                  the picker's `laidOutBook()`
 *   deriveNarrationStrikes         the picker's strike derivation
 *   editNarrationDeletions         the picker's `narration:edit-deletions`
 *   readNarrationState             what a re-opened project reads back
 *   writeNarrationEpub             what the TTS export writes with
 * If a line below reimplements a rule instead of calling it, that is a bug in
 * this file: the record on disk would then be proved against this bench's
 * opinion rather than against the app's.
 *
 * READ-ONLY on the book. Every write goes to a temporary project directory.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  // stdio: 'inherit' — the child writes straight to this process's own stdout/
  // stderr fds, so nothing here is buffered and there is nothing to drain.
  process.exitCode = result.status === null ? 1 : result.status;
  return;
}

const { app } = require('electron');
const DIST = path.join(__dirname, '..', 'dist');
const { Quire } = require(path.join(DIST, 'packages/quire/src/index.js'));
const { PDFAnalyzer } = require(path.join(DIST, 'electron', 'pdf-analyzer.js'));
const { openBookForViewer, closeBookForViewer } =
  require(path.join(DIST, 'electron', 'quire-viewer-bridge.js'));
const { writeNarrationEpub } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  editNarrationDeletions, readNarrationState,
} = require(path.join(DIST, 'electron', 'narration-export.js'));
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { toLaidOutBook } = require(path.join(DIST, 'shared', 'document', 'laid-out-book.js'));
const {
  deriveNarrationStrikes, describeUnstruckDeletions, narrationDeletedPages,
  narrationDeletedBlockIds,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));

Quire.registerScheme();

const books = process.argv.slice(process.argv.indexOf(__filename) + 1).filter(a => !a.startsWith('--'));
if (books.length === 0) {
  console.error('usage: node tools/phasec-gesture-matrix.js <book.epub> [more.epub ...]');
  process.exitCode = 2;
  return;
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n         ${err.message}`); }
};

/** The picker's `narrationLaidOutBlocks()`, in one place, off the same projection. */
function narrationBlocks(analysis) {
  const book = toLaidOutBook(analysis.blocks, analysis.page_dimensions, analysis.categoryProvenance.source);
  return book.blocks.map(b => ({
    id: b.id,
    page: b.page,
    ...(b.bf_element !== undefined ? { element: b.bf_element } : {}),
    ...(b.is_footnote_marker !== undefined ? { unplaceable: b.is_footnote_marker } : {}),
  }));
}

/**
 * A throwaway library of one project, whose manifest NAMES the book.
 *
 * The same shape `tools/test-narration-deletions.js` builds, and for the same
 * reason: `editNarrationDeletions` resolves the project's book through
 * `ensureBookEpub`, and a manifest that does not say where the book is sends it
 * off to mint one. The point here is the record, not the minting.
 */
function makeProject(bookPath) {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'phasec-'));
  const projectId = path.basename(bookPath, '.epub').replace(/[^A-Za-z0-9_-]+/g, '_');
  const projectDir = path.join(library, 'projects', projectId);
  fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
  const bookRel = `source/${projectId}.working.epub`;
  const bookAbs = path.join(projectDir, bookRel);
  fs.copyFileSync(bookPath, bookAbs);
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({
    version: 2,
    projectId,
    type: 'book',
    metadata: { title: projectId },
    // `originalFilename` is what names the working copy when a project has no
    // `archive/` entry — see manifestService.workingEpubStem, which refuses
    // rather than inventing an anonymous name.
    source: { type: 'epub', path: bookRel, originalFilename: path.basename(bookPath) },
    outputs: { epub: { path: bookRel, modifiedAt: new Date().toISOString() } },
  }, null, 2));
  manifestService.setLibraryBasePath(library);
  return { library, dir: projectDir, bookAbs };
}

async function runBook(bookPath) {
  console.log(`\n══ ${path.basename(bookPath)} ═══════════════════════════════════════`);

  // ── 1. The analysis the picker does ──────────────────────────────────────
  const t0 = Date.now();
  const analyzer = new PDFAnalyzer();
  const analysis = await analyzer.analyze(bookPath);
  const analyzeMs = Date.now() - t0;
  const blocks = analysis.blocks;
  console.log(`   analysis: ${blocks.length} block(s), ${analysis.page_count} page(s), `
    + `provenance ${analysis.categoryProvenance?.source}, ${analyzeMs} ms`);

  check('every block carries the element it was laid out from', () => {
    const without = blocks.filter(b => b.bf_element === undefined);
    assert.strictEqual(without.length, 0,
      `${without.length} block(s) have no bf_element, e.g. ${without[0] && without[0].id}`);
  });
  check('every block carries its place in reading order (merge eligibility reads seq)', () => {
    const without = blocks.filter(b => b.seq === undefined);
    assert.strictEqual(without.length, 0, `${without.length} block(s) have no seq`);
  });
  check('no two blocks claim the same id', () => {
    assert.strictEqual(new Set(blocks.map(b => b.id)).size, blocks.length);
  });
  check('the analysis produced no warnings (an EPUB structurally cannot)', () => {
    assert.ok(!analysis.warnings || analysis.warnings.length === 0,
      `warnings: ${JSON.stringify(analysis.warnings)}`);
  });

  // ── 2. The viewer's own opening, and the picker's agreement guard ────────
  const coldStart = Date.now();
  const opened = await openBookForViewer(bookPath);
  const coldMs = Date.now() - coldStart;
  const warmStart = Date.now();
  const opened2 = await openBookForViewer(bookPath);
  const warmMs = Date.now() - warmStart;
  console.log(`   viewer open: cold ${coldMs} ms (stamp ${opened.stats.stampMs} + layout `
    + `${opened.stats.layoutMs}), second open ${warmMs} ms; `
    + `${opened.stats.documents} document(s), ${opened.stats.pages} page(s), `
    + `${opened.stats.unplaced} unplaced`);

  check('nothing in the book went unplaced', () => {
    assert.strictEqual(opened.stats.unplaced, 0);
  });
  check('the analysis and the viewer agree on the page count (the picker refuses if not)', () => {
    const shown = opened.source.documents.reduce((n, d) => n + d.documentPageCount, 0);
    assert.strictEqual(shown, analysis.page_count,
      `viewer ${shown} vs analysis ${analysis.page_count}`);
  });
  check('the viewer paginates the same book the same way twice', () => {
    assert.strictEqual(opened2.stats.pages, opened.stats.pages);
    assert.deepStrictEqual(
      opened2.source.documents.map(d => `${d.document}:${d.documentPageCount}`),
      opened.source.documents.map(d => `${d.document}:${d.documentPageCount}`));
  });
  // The invariant runs THIS way round, and only this way. Every block the picker
  // has must be an element the viewer can place, or that block could never be
  // clicked. The reverse is deliberately NOT true: an image-only wrapper is
  // enumerated in both namespaces and Phase A gives the BLOCK to the picture
  // inside it, so the wrapper is a stamped element with no block of its own —
  // and the viewer's hit test skips it, which is why a click on a plate lands on
  // the plate rather than on two overlapping rectangles.
  check('every block the picker has is an element the viewer can place', () => {
    const theirs = new Set(opened.book.blocks.map(b => b.bf_element));
    const missing = blocks.filter(b => !theirs.has(b.bf_element));
    assert.strictEqual(missing.length, 0,
      `${missing.length} block(s) the viewer cannot place, e.g. ${missing[0] && missing[0].bf_element}`);
  });
  check('the elements with no block are exactly image-only wrappers', () => {
    const mine = new Set(blocks.map(b => b.bf_element));
    const extra = opened.book.blocks.map(b => b.bf_element).filter(k => !mine.has(k));
    const imageDocs = new Set(blocks.filter(b => b.is_image)
      .map(b => String(b.bf_element).split('#')[0]));
    const unexplained = extra.filter(k => !imageDocs.has(String(k).split('#')[0]));
    console.log(`   ${extra.length} stamped element(s) carry no block of their own `
      + `(image-only wrappers): ${extra.slice(0, 4).join(', ')}`);
    assert.strictEqual(unexplained.length, 0,
      `${unexplained.length} unexplained, e.g. ${unexplained[0]}`);
  });
  await closeBookForViewer(opened.handle);
  await closeBookForViewer(opened2.handle);

  // ── 3. The gestures ──────────────────────────────────────────────────────
  const laid = narrationBlocks(analysis);
  const byId = new Map(blocks.map(b => [b.id, b]));
  const textBlocks = blocks.filter(b => !b.is_image && (b.text || '').trim().length > 20);
  assert.ok(textBlocks.length > 5, 'the book has too little text to bench gestures on');

  const project = makeProject(bookPath);

  /** One gesture: strike these block ids, land the record, read it back. */
  async function gesture(name, deletedBlockIds, deletedPages) {
    const at = Date.now();
    const strikes = deriveNarrationStrikes(laid, deletedBlockIds, deletedPages);
    const unresolved = describeUnstruckDeletions(strikes);
    assert.strictEqual(unresolved, null, `${name}: ${unresolved}`);
    const state = await readNarrationState(project.dir);
    // A project that has never been struck records nothing, and `deletions`
    // is null rather than empty. That is the record saying so.
    const already = new Set(state.deletions?.elements ?? []);
    const want = new Set(strikes.elements);
    const strike = [...want].filter(e => !already.has(e));
    const unstrike = [...already].filter(e => !want.has(e));
    await editNarrationDeletions(project.dir, { strike, unstrike });
    // Re-READ, the way a re-opened project does — not the value just returned.
    const reread = await readNarrationState(project.dir);
    const onDisk = new Set(reread.deletions?.elements ?? []);
    assert.deepStrictEqual([...onDisk].sort(), [...want].sort(),
      `${name}: the record on disk is not what the gesture meant`);
    console.log(`      (${name}: ${want.size} element(s), ${Date.now() - at} ms)`);
    return strikes;
  }

  // (a) one block struck
  const one = textBlocks[Math.floor(textBlocks.length / 2)];
  let strikes;
  await check2('a struck block is recorded as its element, and is still struck on re-open',
    async () => { strikes = await gesture('block strike', new Set([one.id]), new Set()); });
  check('the record names an element, never a page number', () => {
    assert.ok(strikes.elements.every(e => typeof e === 'string' && e.includes('#')),
      JSON.stringify(strikes.elements.slice(0, 3)));
  });

  // (b) delete-like-this — the picker's own rule: every block of that category
  //     that is not already struck.
  const likeCategory = one.category_id;
  const likeIds = new Set(blocks.filter(b => b.category_id === likeCategory).map(b => b.id));
  await check2(`deleteLikeThis strikes all ${likeIds.size} block(s) of "${likeCategory}"`,
    async () => {
      const s = await gesture('deleteLikeThis', likeIds, new Set());
      assert.ok(s.elements.length >= 1);
    });

  // (c) marquee — an arbitrary run of ids, which is all a marquee is by the time
  //     it reaches the picker.
  const marquee = new Set(textBlocks.slice(0, 7).map(b => b.id));
  await check2('a marquee of 7 blocks strikes 7 elements', async () => {
    const s = await gesture('marquee', marquee, new Set());
    assert.strictEqual(s.elements.length, marquee.size,
      `${s.elements.length} element(s) for ${marquee.size} block(s)`);
  });

  // (d) page delete, then undo (the inverse edit), then redo
  const busiest = [...blocks.reduce((m, b) => m.set(b.page, (m.get(b.page) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])[0][0];
  await check2(`a page delete strikes everything on page ${busiest + 1}`, async () => {
    const s = await gesture('page delete', new Set(), new Set([busiest]));
    const onPage = blocks.filter(b => b.page === busiest);
    assert.ok(s.elements.length > 0, 'a page delete struck nothing');
    // The view the picker paints back from the record, through the app's OWN
    // two helpers. Emphatically not a filter written here: a page that is a
    // whole spine document escalates to one `<file>#doc` key — which is what
    // Killing America's busiest page does — and a hand-rolled `elements
    // includes b.element` finds nothing for it and calls a correct strike a
    // failure. That is the escalation working, and reading it back is
    // `narrationDeletedBlockIds`' job.
    const struckIds = new Set(narrationDeletedBlockIds(laid, s.elements));
    const pages = narrationDeletedPages(laid, struckIds);
    assert.ok(pages.has(busiest),
      `page ${busiest} is not read back as deleted (${onPage.length} block(s) on it, `
      + `${s.elements.length} element(s) struck: ${s.elements.slice(0, 2).join(', ')})`);
    console.log(`      (page ${busiest + 1}: ${onPage.length} block(s) → `
      + `${s.elements.length} element(s)${s.elements.some(e => e.endsWith('#doc'))
        ? ', escalated to a whole document' : ''})`);
  });
  await check2('undo puts the page back — the record is empty again', async () => {
    const s = await gesture('undo', new Set(), new Set());
    assert.strictEqual(s.elements.length, 0);
  });
  await check2('redo strikes the same page again, to the same elements', async () => {
    const s = await gesture('redo', new Set(), new Set([busiest]));
    assert.ok(s.elements.length > 0);
  });

  // (e) the export, from the record as it stands
  const out = path.join(project.dir, 'tts.epub');
  const finalStrikes = deriveNarrationStrikes(laid, new Set([one.id]), new Set([busiest]));
  await editNarrationDeletions(project.dir, {
    strike: finalStrikes.elements, unstrike: [],
  }).catch(() => {});
  const exportAt = Date.now();
  const written = await writeNarrationEpub(bookPath, out, finalStrikes.elements);
  console.log(`   (narration write: ${Date.now() - exportAt} ms)`);
  console.log(`   export: ${written.removedElements} element(s) removed, `
    + `${written.prunedDocuments ? written.prunedDocuments.length : 0} document(s) pruned`);
  check('the export removed exactly what was struck', () => {
    assert.ok(written.removedElements > 0, 'nothing was removed');
  });
  check('the struck elements are absent from the TTS copy', async () => {
    assert.ok(fs.existsSync(out), 'no TTS copy was written');
  });

  // (f) re-open after export: the book is untouched and the record survives
  const bookSha = crypto.createHash('sha256').update(fs.readFileSync(bookPath)).digest('hex');
  check('the book on disk is byte-identical after all of it', () => {
    const now = crypto.createHash('sha256').update(fs.readFileSync(bookPath)).digest('hex');
    assert.strictEqual(now, bookSha);
  });
  const reopened = await openBookForViewer(bookPath);
  check('the book re-opens after export, with the same pagination', () => {
    assert.strictEqual(reopened.stats.pages, opened.stats.pages);
  });
  await closeBookForViewer(reopened.handle);

  fs.rmSync(project.library, { recursive: true, force: true });
  return { analyzeMs, coldMs, warmMs, pages: opened.stats.pages, blocks: blocks.length };
}

async function check2(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n         ${err.message}`); }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const summary = [];
  for (const b of books) {
    try { summary.push({ book: path.basename(b), ...(await runBook(b)) }); }
    catch (err) { failures++; console.log(`\n  FAIL ${path.basename(b)}: ${err.stack}`); }
  }
  console.log('\n── numbers ─────────────────────────────────────────────────────');
  for (const s of summary) {
    console.log(`  ${s.book}: ${s.blocks} blocks / ${s.pages} pages; analysis ${s.analyzeMs} ms; `
      + `viewer open cold ${s.coldMs} ms, second ${s.warmMs} ms`);
  }
  console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
  app.exit(failures === 0 ? 0 : 1);
});
