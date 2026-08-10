#!/usr/bin/env node
/**
 * Tests for the layout gate ON REAL PROJECT DIRECTORIES — what a saved project
 * is allowed to hand to a picker showing quire's pagination.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-legacy-layout-state.js
 *
 * `tools/test-editor-layout.js` covers the pure decision. This one covers the
 * three things that have to be true of a project on disk:
 *
 *   (a) a LEGACY EPUB project — records made against mupdf's 218-page reflow —
 *       is refused, by name, and its records are never resolved against quire's
 *       183-page layout;
 *   (b) a POST-CUTOVER project — one stamped by a save from this build — reads
 *       as current and round-trips with nothing withheld;
 *   (c) a PDF project is untouched by every part of it, because mupdf's
 *       pagination of a PDF is the PDF's own pages and did not change.
 *
 * The migration's ARITHMETIC (mupdf layout → element keys → quire layout) needs
 * two real paginations of a real book and belongs to the on-book validation; what
 * is asserted here is the decision, the transaction, and the refusal — the parts
 * that decide whether a wrong-block strike is possible at all.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'editor-layout.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { readEditorLayoutState, currentEpubEditorLayout, EDITOR_LAYOUT_MANIFEST_KEY } =
  require(path.join(DIST, 'editor-layout.js'));
const manifestService = require(path.join(DIST, 'manifest-service.js'));
const { editorStateTranslationRefusal } = require(path.join(DIST, 'narration-editor-state.js'));
const { migrateLegacyEpubEditorRecords } = require(path.join(DIST, 'legacy-epub-layout.js'));
// The editor records live in a per-project sidecar now, so the assertions about
// which of them survive a carry-over ask the module that owns that file. The
// fixtures below still WRITE them into `manifest.editor` on purpose: that is the
// pre-sidecar shape every project in the library is in, and the migration
// on contact is part of what is under test.
const { peekEditorStateSync } = require(path.join(DIST, 'editor-state-store.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── A throwaway library, so `requireLibraryProjectId` is satisfied ──────────
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-layout-test-'));
fs.mkdirSync(path.join(LIB, 'projects'), { recursive: true });
manifestService.setLibraryBasePath(LIB);

/** A project directory holding exactly the manifest it is given. */
function project(id, manifest) {
  const dir = path.join(LIB, 'projects', id);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  // A family is minted off the archive-grade original ON DISK, not off the
  // manifest's say-so, so a fixture that records one has to put the file there
  // too — even a project this test is deliberately keeping bookless still needs
  // its ARCHIVE original to exist, so `requireFamily` can mint the chain before
  // the code under test gets to ask about the working copy.
  for (const entry of manifest.archive ?? []) {
    const abs = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, Buffer.from('PK archive placeholder'));
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ version: 2, projectId: id, projectType: 'book', ...manifest }, null, 2),
  );
  return dir;
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

/**
 * The book record, where it lives now: under the family that owns it.
 *
 * `manifest.outputs.epub` was the one book a project could have; the record
 * moved inside the family whose archive-grade source it hangs off.
 */
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

/** The records a real legacy project carries — Apocalypse Delayed, from the census. */
const legacyRecords = {
  source: {
    type: 'epub',
    originalFilename: 'Apocalypse Delayed.epub',
    fileHash: 'abc123',
    deletedPages: [12, 13, 140, 141],
    deletedBlockIds: ['1e1e93ec0a08', 'f2eb0000e223'],
    pageOrder: [0, 1, 2],
  },
  metadata: { title: 'Apocalypse Delayed', author: 'Penton', language: 'en' },
  chapters: [{ id: 'toc-0', title: 'Cover', page: 0, level: 1, source: 'toc' }],
  chaptersSource: 'toc',
  editor: {
    undoStack: [{ type: 'delete', blockIds: ['1e1e93ec0a08'] }],
    redoStack: [{ type: 'restorePage', pageNumbers: [1330] }],
    categoryCorrections: [['9b4c3543d1dd', 'body']],
    paragraphBreaks: ['093224655e78'],
    // NOT layout-keyed — must survive everything below.
    ocrCategories: { title: { id: 'title', name: 'Titles' } },
    sourceFileSha256: 'deadbeef',
  },
  pipeline: {},
  // The stem an archive-grade original mints a family under is its own
  // basename, so this has to be "Apocalypse Delayed" to agree with the working
  // copy's recorded name below.
  archive: [{ path: 'archive/Apocalypse Delayed.epub', role: 'original', format: 'epub' }],
  outputs: { epub: { path: 'source/Apocalypse Delayed.working.epub', modifiedAt: 'x' } },
};

// ── (a) A legacy EPUB project ──────────────────────────────────────────────

test('(a) a legacy EPUB project reads as legacy and earns a refusal', () => {
  const dir = project('legacy-epub', legacyRecords);
  const state = readEditorLayoutState('Apocalypse Delayed', 'epub', readManifest(dir));
  assert.strictEqual(state.status, 'legacy');
  assert.ok(state.refusal !== null, 'a legacy project must produce a refusal');
  assert.ok(state.refusal.includes('4 deleted page(s)'), state.refusal);
  assert.ok(state.refusal.includes('2 deleted block(s)'), state.refusal);
  assert.ok(/mupdf/.test(state.refusal), state.refusal);
});

test('(a) the narration translation REFUSES a legacy EPUB instead of resolving it', async () => {
  const dir = project('legacy-epub-2', legacyRecords);
  const deletions = await manifestService.readEditorStateDeletions(dir);
  assert.deepStrictEqual(deletions.pages, [12, 13, 140, 141]);
  assert.strictEqual(deletions.layout, null, 'a legacy project states no layout');
  const refusal = editorStateTranslationRefusal(deletions, dir);
  assert.ok(refusal !== null,
    'page 140 of mupdf\'s 218-page layout must never be resolved against quire\'s 183');
  assert.ok(/NOT applied/.test(refusal), refusal);
});

test('(a) the census sees every class, including the undo and redo stacks', () => {
  const dir = project('legacy-epub-3', legacyRecords);
  const state = readEditorLayoutState('Apocalypse Delayed', 'epub', readManifest(dir));
  assert.strictEqual(state.census.deletedPages, 4);
  assert.strictEqual(state.census.deletedBlockIds, 2);
  assert.strictEqual(state.census.pageOrder, 3);
  assert.strictEqual(state.census.undoStack, 1);
  assert.strictEqual(state.census.redoStack, 1);
  assert.strictEqual(state.census.chaptersWithPage, 1);
  const fields = state.census.blockKeyedEditorFields.map(f => f.field).sort();
  assert.deepStrictEqual(fields, ['categoryCorrections', 'paragraphBreaks']);
});

test('(a) the carry-over is ONE transaction: new records, new stamp, the rest retired',
  async () => {
    const dir = project('legacy-migrated', legacyRecords);
    const layout = currentEpubEditorLayout('2026-08-09T00:00:00.000Z');
    await manifestService.applyEditorLayoutMigration(dir, {
      layout,
      deletions: { deletedPages: [9, 10], deletedBlockIds: ['aa11bb22cc33'] },
      narration: { epubSha256: 'sha-of-the-book', elements: ['OEBPS/ch1.xhtml#4'] },
    });
    const m = readManifest(dir);

    // The deletions came across, in the CURRENT layout.
    assert.deepStrictEqual(m.source.deletedPages, [9, 10]);
    assert.deepStrictEqual(m.source.deletedBlockIds, ['aa11bb22cc33']);
    // And the stamp now says which layout that is.
    assert.deepStrictEqual(m.source[EDITOR_LAYOUT_MANIFEST_KEY], layout);
    // The durable form of the same intent, under the family now.
    const book = bookRecordOf(dir);
    assert.deepStrictEqual(book.narrationDeletions.elements, ['OEBPS/ch1.xhtml#4']);
    assert.strictEqual(book.narrationDeletions.epubSha256, 'sha-of-the-book');

    // Everything the old layout explained is gone. The editor records were
    // carried out of the manifest into the sidecar on the way, so that is where
    // this reads them — and the manifest must no longer hold the key at all.
    const editor = peekEditorStateSync(dir);
    assert.strictEqual(m.editor, undefined, 'the pre-sidecar key must not survive a write');
    assert.strictEqual(m.source.pageOrder, undefined);
    assert.strictEqual(editor.undoStack, undefined);
    assert.strictEqual(editor.redoStack, undefined);
    assert.strictEqual(editor.categoryCorrections, undefined);
    assert.strictEqual(editor.paragraphBreaks, undefined);
    assert.deepStrictEqual(m.chapters, []);

    // And everything that never named a position is untouched.
    assert.deepStrictEqual(editor.ocrCategories, { title: { id: 'title', name: 'Titles' } });
    assert.strictEqual(editor.sourceFileSha256, 'deadbeef');
    assert.strictEqual(m.source.type, 'epub');
    assert.strictEqual(m.source.fileHash, 'abc123');
    assert.strictEqual(m.metadata.title, 'Apocalypse Delayed');
  });

test('(a) a migrated project then reads current, and the translation stops refusing',
  async () => {
    const dir = project('legacy-then-current', legacyRecords);
    await manifestService.applyEditorLayoutMigration(dir, {
      layout: currentEpubEditorLayout(new Date().toISOString()),
      deletions: { deletedPages: [9], deletedBlockIds: ['aa11bb22cc33'] },
      narration: null,
    });
    const state = readEditorLayoutState('Apocalypse Delayed', 'epub', readManifest(dir));
    assert.strictEqual(state.status, 'current');
    assert.strictEqual(state.refusal, null);
    const deletions = await manifestService.readEditorStateDeletions(dir);
    assert.strictEqual(editorStateTranslationRefusal(deletions, dir), null);
  });

test('(a) a legacy project with NO book on disk is refused, not half-migrated', async () => {
  const dir = project('legacy-no-book', legacyRecords);
  const outcome = await migrateLegacyEpubEditorRecords(dir);
  assert.strictEqual(outcome.kind, 'refused');
  // The USER's sentence is short (Owen: "very short. like, 3 sentences") and
  // states the three things: what happened, that nothing changed, what to do.
  assert.ok(/no longer records/.test(outcome.message), outcome.message);
  assert.ok(/Nothing was changed/.test(outcome.message), outcome.message);
  assert.ok(outcome.message.split(/[.!?]\s/).length <= 4, `too long for a dialog: ${outcome.message}`);
  // The trap it refuses to walk into is still named — in the DETAIL, which is
  // the log's, not the dialog's.
  assert.ok(/strike the wrong text/.test(outcome.detail), outcome.detail);
  // Nothing was changed.
  const m = readManifest(dir);
  assert.deepStrictEqual(m.source.deletedPages, [12, 13, 140, 141]);
  assert.strictEqual(m.source[EDITOR_LAYOUT_MANIFEST_KEY], undefined);
});

test('(a) a FOREIGN stamp is refused outright — no layout can reproduce it', async () => {
  const foreign = { ...currentEpubEditorLayout('x'), strategy: 'pagedjs-9.9.9' };
  const dir = project('foreign-epub', {
    ...legacyRecords,
    source: { ...legacyRecords.source, [EDITOR_LAYOUT_MANIFEST_KEY]: foreign },
  });
  const outcome = await migrateLegacyEpubEditorRecords(dir);
  assert.strictEqual(outcome.kind, 'refused');
  // The layout identity moved to the detail with the rest of the reasoning;
  // the dialog sentence stays short and states that nothing changed.
  assert.ok(/Nothing was changed/.test(outcome.message), outcome.message);
  assert.ok(outcome.detail.includes('pagedjs-9.9.9'), outcome.detail);
  assert.deepStrictEqual(readManifest(dir).source.deletedPages, [12, 13, 140, 141]);
});

// ── (b) A post-cutover project ─────────────────────────────────────────────

test('(b) a project saved by this build reads current and withholds nothing', async () => {
  const stamp = currentEpubEditorLayout('2026-08-09T10:00:00.000Z');
  const dir = project('current-epub', {
    ...legacyRecords,
    source: { ...legacyRecords.source, [EDITOR_LAYOUT_MANIFEST_KEY]: stamp },
  });
  const state = readEditorLayoutState('Apocalypse Delayed', 'epub', readManifest(dir));
  assert.strictEqual(state.status, 'current');
  assert.strictEqual(state.refusal, null);
  assert.strictEqual((await migrateLegacyEpubEditorRecords(dir)).kind, 'current');

  const deletions = await manifestService.readEditorStateDeletions(dir);
  assert.deepStrictEqual(deletions.pages, [12, 13, 140, 141]);
  assert.deepStrictEqual(deletions.layout, stamp, 'the stamp travels with the deletions');
  assert.strictEqual(editorStateTranslationRefusal(deletions, dir), null);
});

test('(b) an EPUB project with no records at all is clean, and stays openable', async () => {
  const dir = project('clean-epub', {
    source: { type: 'epub', originalFilename: 'x.epub' },
    metadata: { title: 'x', author: 'y', language: 'en' },
    chapters: [], pipeline: {}, outputs: {},
  });
  const state = readEditorLayoutState('x', 'epub', readManifest(dir));
  assert.strictEqual(state.status, 'clean');
  assert.strictEqual(state.refusal, null);
  assert.strictEqual((await migrateLegacyEpubEditorRecords(dir)).kind, 'clean');
});

test('(b) a half-written stamp is NO stamp, not a permanent refusal', () => {
  const dir = project('broken-stamp', {
    ...legacyRecords,
    source: { ...legacyRecords.source, [EDITOR_LAYOUT_MANIFEST_KEY]: { engine: 'quire' } },
  });
  const state = readEditorLayoutState('x', 'epub', readManifest(dir));
  assert.strictEqual(state.recorded, null, 'an incomplete stamp must not be believed');
  assert.strictEqual(state.status, 'legacy', 'and it falls to the legacy path, which can act');
});

// ── (c) A PDF project ──────────────────────────────────────────────────────

const pdfRecords = {
  source: {
    type: 'pdf',
    originalFilename: 'scan.pdf',
    deletedPages: [12, 13, 140, 141],
    deletedBlockIds: ['1e1e93ec0a08'],
    pageOrder: [0, 1, 2],
  },
  metadata: { title: 'A Scan', author: 'Nobody', language: 'en' },
  chapters: [{ id: 'toc-0', title: 'Cover', page: 0, level: 1, source: 'toc' }],
  editor: { undoStack: [{ type: 'delete', blockIds: ['x'] }] },
  pipeline: {}, outputs: {},
};

test('(c) a PDF project is not-an-epub, whatever it holds', () => {
  const dir = project('pdf-project', pdfRecords);
  const state = readEditorLayoutState('A Scan', 'pdf', readManifest(dir));
  assert.strictEqual(state.status, 'not-an-epub');
  assert.strictEqual(state.refusal, null, 'a PDF must never be refused for a layout reason');
});

test('(c) the migration returns without reading or writing anything for a PDF', async () => {
  const dir = project('pdf-project-2', pdfRecords);
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
  const outcome = await migrateLegacyEpubEditorRecords(dir);
  assert.strictEqual(outcome.kind, 'not-an-epub');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'), before,
    'the manifest of a PDF project must be byte-identical afterwards');
});

test('(c) a PDF still gets its OWN refusal — the one about the PDF, not the layout', async () => {
  const dir = project('pdf-project-3', pdfRecords);
  const deletions = await manifestService.readEditorStateDeletions(dir);
  const refusal = editorStateTranslationRefusal(deletions, dir);
  assert.ok(refusal !== null, 'a PDF project\'s editor deletions are still not book strikes');
  assert.ok(/made from a PDF/.test(refusal), refusal);
  assert.ok(!/mupdf/.test(refusal), `it must not blame the paginator: ${refusal}`);
});

test('(c) a PDF project with no deletions is not refused for anything', async () => {
  const dir = project('pdf-project-4', {
    ...pdfRecords,
    source: { type: 'pdf', originalFilename: 'scan.pdf' },
  });
  const deletions = await manifestService.readEditorStateDeletions(dir);
  assert.strictEqual(editorStateTranslationRefusal(deletions, dir), null);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
