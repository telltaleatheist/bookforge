#!/usr/bin/env node
/**
 * Tests for the layout-identity gate — the records a change of paginator
 * invalidates, and what is said about them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-editor-layout.js
 *
 * ── The failure this guards ────────────────────────────────────────────────
 *
 * `manifest.source.deletedPages` is a page number of the LAYOUT the picker was
 * showing, and in August 2026 that layout changed for EPUBs: mupdf's reflow put
 * *Killing America* on 218 pages, quire's fragmentation of the book's own DOM
 * puts it on 183. Page 140 exists in both and holds different paragraphs in
 * each. Replaying a saved project against the new pagination therefore strikes
 * out text the user never touched — silently, in a book they have no reason to
 * re-read. Measured across the library the same day: of 378 projects, 163 came
 * from an EPUB and 49 of those carry such records (613 deleted pages on one).
 *
 * What is asserted here is everything that is PURE: the identity comparison, the
 * census of what a manifest holds, the status a project reads as, and the
 * sentences. The two layouts themselves and the manifest writes are exercised by
 * the migration on a real book; what must never regress is the DECISION.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'editor-layout.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  EDITOR_LAYOUT_MANIFEST_KEY,
  LAYOUT_KEYED_EDITOR_FIELDS,
  censusLayoutKeyedRecords,
  describeEditorLayout,
  describeLayoutMigration,
  describeStaleLayoutRecords,
  editorLayoutStatus,
  layoutKeyedRecordTotal,
  sameEditorLayout,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The layout this build lays an EPUB out in. */
const quire = {
  engine: 'quire',
  strategy: 'pagedjs-0.4.3',
  version: 1,
  width: 600,
  height: 900,
  fontSize: 18,
  recordedAt: '2026-08-09T12:00:00.000Z',
};

/** A real legacy project, from the census: Apocalypse Delayed. */
const legacySource = {
  type: 'epub',
  originalFilename: 'Apocalypse Delayed.epub',
  deletedPages: Array.from({ length: 157 }, (_, i) => i),
  deletedBlockIds: Array.from({ length: 228 }, (_, i) => `blk${i}`),
};
const legacyEditor = {
  undoStack: Array.from({ length: 43 }, () => ({ type: 'delete', blockIds: ['x'] })),
  ocrCategories: { title: { id: 'title' } },
};
const legacyChapters = Array.from({ length: 137 }, (_, i) => ({
  id: `toc-${i}`, title: `Chapter ${i}`, page: i * 3, level: 1, source: 'toc',
}));

// ── The identity ───────────────────────────────────────────────────────────

test('a layout is the same layout only when all five facts agree', () => {
  assert.ok(sameEditorLayout(quire, { ...quire, recordedAt: 'much later' }),
    'the timestamp must not make two saves in one build different layouts');
  for (const [field, other] of [
    ['engine', 'mupdf'], ['strategy', 'pagedjs-0.5.0'], ['version', 2],
    ['width', 700], ['height', 1000], ['fontSize', 16],
  ]) {
    assert.ok(!sameEditorLayout(quire, { ...quire, [field]: other }),
      `a different ${field} is a different layout`);
  }
});

test('nothing is the same layout as an absent stamp', () => {
  assert.ok(!sameEditorLayout(quire, null), 'null compared equal');
  assert.ok(!sameEditorLayout(null, null), 'two absences compared equal');
});

test('an absent stamp is DESCRIBED as mupdf rather than as unknown', () => {
  const said = describeEditorLayout(null);
  assert.ok(/mupdf/.test(said), `no mupdf in: ${said}`);
  assert.ok(/600×900×18/.test(said), `no geometry in: ${said}`);
  assert.ok(!/unknown/i.test(said), `it hedges: ${said}`);
});

// ── The status ─────────────────────────────────────────────────────────────

test('a PDF project is not-an-epub, whatever it holds and whatever it says', () => {
  assert.strictEqual(editorLayoutStatus('pdf', null, quire, true), 'not-an-epub');
  assert.strictEqual(editorLayoutStatus('pdf', quire, quire, true), 'not-an-epub');
  assert.strictEqual(
    editorLayoutStatus('pdf', { ...quire, engine: 'mupdf' }, quire, true), 'not-an-epub');
});

test('an EPUB stamped with this build\'s layout is current', () => {
  assert.strictEqual(editorLayoutStatus('epub', { ...quire }, quire, true), 'current');
});

test('an EPUB with records and NO stamp is legacy', () => {
  assert.strictEqual(editorLayoutStatus('epub', null, quire, true), 'legacy');
});

test('an EPUB with no records and no stamp is clean, not legacy', () => {
  assert.strictEqual(editorLayoutStatus('epub', null, quire, false), 'clean');
});

test('an EPUB stamped with any OTHER layout is foreign', () => {
  assert.strictEqual(
    editorLayoutStatus('epub', { ...quire, strategy: 'pagedjs-0.5.0' }, quire, true), 'foreign');
  assert.strictEqual(
    editorLayoutStatus('epub', { ...quire, height: 1200 }, quire, false), 'foreign');
});

// ── The census ─────────────────────────────────────────────────────────────

test('the census counts every class a layout explains', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  assert.strictEqual(c.deletedPages, 157);
  assert.strictEqual(c.deletedBlockIds, 228);
  assert.strictEqual(c.pageOrder, 0);
  assert.strictEqual(c.undoStack, 43);
  assert.strictEqual(c.redoStack, 0);
  assert.strictEqual(c.chaptersWithPage, 137);
});

test('ocrCategories is NOT counted — it is keyed by category, not by block', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  assert.ok(!c.blockKeyedEditorFields.some(f => f.field === 'ocrCategories'),
    'a category id is not a position in a layout');
  assert.ok(!LAYOUT_KEYED_EDITOR_FIELDS.includes('ocrCategories'));
  assert.ok(!LAYOUT_KEYED_EDITOR_FIELDS.includes('classificationThresholds'));
  assert.ok(!LAYOUT_KEYED_EDITOR_FIELDS.includes('sourceFileSha256'));
  assert.ok(!LAYOUT_KEYED_EDITOR_FIELDS.includes('rubricPredictions'));
});

test('every block-keyed editor field the picker writes IS counted', () => {
  const editor = {};
  for (const field of LAYOUT_KEYED_EDITOR_FIELDS) editor[field] = ['one'];
  const c = censusLayoutKeyedRecords({}, editor, []);
  assert.strictEqual(c.blockKeyedEditorFields.length, LAYOUT_KEYED_EDITOR_FIELDS.length);
  // The four shapes these fields really take on disk all count as non-empty.
  const shapes = censusLayoutKeyedRecords({}, {
    blockEdits: { ff8270da4472: { text: 'Preface' } },        // object
    paragraphBreaks: ['093224655e78'],                        // array of ids
    categoryCorrections: [['9b4c3543d1dd', 'body']],          // array of pairs
    blockMerges: [{ mergedBlockId: 'm', sourceBlockIds: [] }], // array of objects
  }, []);
  assert.strictEqual(shapes.blockKeyedEditorFields.length, 4);
});

test('an empty field is not a record — it is a project nobody edited', () => {
  const c = censusLayoutKeyedRecords(
    { deletedPages: [], deletedBlockIds: [] }, { undoStack: [], blockEdits: {} }, []);
  assert.strictEqual(layoutKeyedRecordTotal(c), 0);
  assert.strictEqual(c.blockKeyedEditorFields.length, 0);
});

test('the total is the sum of every class, so "clean" cannot hide a record', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  assert.strictEqual(layoutKeyedRecordTotal(c), 157 + 228 + 43 + 137);
});

// ── The refusal ────────────────────────────────────────────────────────────

test('the refusal names the book, every record class, and both layouts', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  const said = describeStaleLayoutRecords('Apocalypse Delayed', c, null, quire);
  assert.ok(said.includes('Apocalypse Delayed'), `no book in: ${said}`);
  assert.ok(said.includes('157 deleted page(s)'), `no page count in: ${said}`);
  assert.ok(said.includes('228 deleted block(s)'), `no block count in: ${said}`);
  assert.ok(said.includes('43 undo step(s)'), `no undo count in: ${said}`);
  assert.ok(said.includes('137 chapter marker'), `no chapter count in: ${said}`);
  assert.ok(/mupdf/.test(said), `the old layout is not named in: ${said}`);
  assert.ok(/quire\/pagedjs-0\.4\.3/.test(said), `the new layout is not named in: ${said}`);
});

test('the refusal says they are NOT applied, and why that matters', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  const said = describeStaleLayoutRecords('Apocalypse Delayed', c, null, quire);
  assert.ok(/NOT applied/.test(said), `it does not say they are withheld: ${said}`);
  assert.ok(/never touched/.test(said), `it does not say what a replay would do: ${said}`);
});

test('the refusal says what happens next, and what happens to the old records', () => {
  const c = censusLayoutKeyedRecords(legacySource, legacyEditor, legacyChapters);
  const said = describeStaleLayoutRecords('Apocalypse Delayed', c, null, quire);
  assert.ok(/strike out what you want left out .* again/.test(said),
    `no instruction in: ${said}`);
  assert.ok(/stay in the project/.test(said), `it does not say the records survive: ${said}`);
});

test('a FOREIGN stamp is named in the refusal, not flattened into "mupdf"', () => {
  const c = censusLayoutKeyedRecords(legacySource, {}, []);
  const older = { ...quire, strategy: 'pagedjs-0.3.9' };
  const said = describeStaleLayoutRecords('Some Book', c, older, quire);
  assert.ok(said.includes('pagedjs-0.3.9'), `the recorded layout is not named in: ${said}`);
  assert.ok(said.includes('pagedjs-0.4.3'), `the current layout is not named in: ${said}`);
  assert.ok(!/mupdf/.test(said), `it invented a mupdf origin: ${said}`);
});

// ── The migration's own sentence ───────────────────────────────────────────

test('a carry-over states both counts and explains why they differ', () => {
  const said = describeLayoutMigration(
    'Apocalypse Delayed',
    { deletedPages: 157, deletedBlockIds: 228 },
    { deletedPages: 131, deletedBlockIds: 205, elements: 1402 },
    null, quire);
  assert.ok(said.includes('157 deleted page(s)'), `no before-count in: ${said}`);
  assert.ok(said.includes('131 deleted page(s)'), `no after-count in: ${said}`);
  assert.ok(said.includes('1402 element(s)'), `no element count in: ${said}`);
  assert.ok(/the same text/.test(said),
    `it does not reassure that the counts differing is not a loss: ${said}`);
});

// ── The key ────────────────────────────────────────────────────────────────

test('the stamp lives under one agreed manifest key', () => {
  assert.strictEqual(EDITOR_LAYOUT_MANIFEST_KEY, 'editorLayout');
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
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
