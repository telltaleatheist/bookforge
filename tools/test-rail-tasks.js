#!/usr/bin/env node
/**
 * Tests for shared/document/rail-tasks.ts — what the picker's left rail offers,
 * and which kind of file it is offering it over.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-rail-tasks.js
 *
 * The picker is one screen and the FILE decides the tools (Owen, 2026-08-07).
 * So there are three rules here, and the first two are the ones the deleted
 * station ladder used to get wrong:
 *
 *  - the artifact is measured from the file's own extension, and nothing else.
 *    A `.epub` is a book wherever it came from; anything else is a source
 *    document to curate.
 *  - the rail's CONTENTS follow from that and nothing else. The source gets the
 *    curation modes; the book gets its text passes; neither ever gets the
 *    other's, which is what stops a curation tool from appearing over a file
 *    that has no pages to curate.
 *  - a pass entry's STATUS is derived from the book's own provenance
 *    (`appliedPasses`), through the ONE latest-wins implementation the versions
 *    page reads. A pass that has run says so; one that has not says "not run".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'rail-tasks.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  ARTIFACT_RAIL_GROUPS,
  ALL_RAIL_TASK_IDS,
  NARRATION_EXPORT_LABEL,
  RAIL_TASK_LABELS,
  railGroupsForArtifact,
  railTaskIdsFor,
  railShortcutsFor,
  railTaskForDigit,
  viewedArtifactOf,
  viewingWorkingCopy,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ARTIFACTS = ['source', 'book'];

// ── Which file is in the viewer ─────────────────────────────────────────────

test('an EPUB is a book, wherever it came from', () => {
  // The project's own export, the original of a project that arrived as an
  // EPUB, and a loose ebook are all read the same way and offer the same tools.
  assert.strictEqual(viewedArtifactOf('/lib/projects/x/source/The Waste Land.epub'), 'book');
  assert.strictEqual(viewedArtifactOf('/lib/projects/x/source/original.epub'), 'book');
  assert.strictEqual(viewedArtifactOf('/Users/me/Downloads/loose.EPUB'), 'book');
});

test('anything that is not an EPUB is a source document', () => {
  assert.strictEqual(viewedArtifactOf('/lib/projects/x/source/original.pdf'), 'source');
  assert.strictEqual(viewedArtifactOf('/lib/projects/x/source/original.working.pdf'), 'source');
  assert.strictEqual(viewedArtifactOf(''), 'source');
});

test('the working copy is recognised by the project record, not by its name', () => {
  const workingPath = '/lib/projects/x/source/original.working.pdf';
  assert.strictEqual(
    viewingWorkingCopy({ displayedPath: workingPath, workingPath }), true);
  // The archive original, with a working copy sitting beside it.
  assert.strictEqual(
    viewingWorkingCopy({
      displayedPath: '/lib/projects/x/source/original.pdf', workingPath }), false);
});

test('no working copy, or nothing open, is not a working copy', () => {
  assert.strictEqual(viewingWorkingCopy({
    displayedPath: '/lib/projects/x/source/original.working.pdf', workingPath: null }), false);
  assert.strictEqual(viewingWorkingCopy({ displayedPath: '', workingPath: '/a.working.pdf' }), false);
});

// ── Contents per artifact ───────────────────────────────────────────────────

test('every artifact answers with a rail, and only the source has rows', () => {
  for (const artifact of ARTIFACTS) {
    assert.ok(Array.isArray(railGroupsForArtifact(artifact)), `${artifact} has no rail`);
  }
  assert.ok(railGroupsForArtifact('source').length > 0, 'source has no rail groups');
});

test('the source rail is the curation modes and their tasks', () => {
  const ids = railTaskIdsFor('source');
  assert.deepStrictEqual([...ids], ['select', 'crop', 'merge']);
});

test('the source rail carries no OCR entry', () => {
  // The Tesseract pipeline is gone (Aug 2026) and reading the pages produces a
  // BOOK rather than a curated document, so it is not a curation tool at all.
  assert.ok(!railTaskIdsFor('source').includes('ocr'));
  assert.ok(!ALL_RAIL_TASK_IDS.includes('ocr'));
});

test('the book rail is EMPTY — the passes moved to the versions page', () => {
  // Owen, 2026-08-10: "ai simplify and translate are done through that modal
  // instead of through the pdf picker window." The one offer of the text passes
  // is shared/processing/book-passes.ts, rendered by the versions page's modal;
  // a book in the picker is there to be read.
  assert.deepStrictEqual([...railTaskIdsFor('book')], []);
});

test('the narration copy is NOT a rail entry', () => {
  // Owen's call, 2026-08-08: the rail is a checklist of work you do TO the
  // book, and writing the narration copy is what you do when you are done with
  // it. It is the primary action at the bottom-right of the viewer now, owned
  // by the picker directly — so nothing derives a status, a digit shortcut or a
  // disabled-reason for it through the rail, and an id that reappeared here
  // would be a second control for the same act.
  assert.ok(!ALL_RAIL_TASK_IDS.includes('export-tts'));
  assert.ok(!railTaskIdsFor('book').includes('export-tts'));
  assert.strictEqual(typeof NARRATION_EXPORT_LABEL, 'string');
  assert.ok(NARRATION_EXPORT_LABEL.length > 0);
});

test('no pass id survives on any rail', () => {
  // The retired AI 'footnotes' pass never comes back, and since 2026-08-10 the
  // three live passes ('footnote-refs', 'simplify', 'translate') are not rail
  // entries either — they are the versions page modal's list.
  for (const gone of ['footnotes', 'footnote-refs', 'simplify', 'translate']) {
    assert.ok(!ALL_RAIL_TASK_IDS.includes(gone), `${gone} is still on a rail`);
  }
});

test('no curation entry is ever offered over the book', () => {
  const curation = new Set(railTaskIdsFor('source'));
  for (const id of railTaskIdsFor('book')) {
    assert.ok(!curation.has(id), `${id} is on both rails`);
  }
});

test('no book entry is ever offered over the source', () => {
  const bookOnly = new Set(railTaskIdsFor('book'));
  for (const id of railTaskIdsFor('source')) {
    assert.ok(!bookOnly.has(id), `${id} is on both rails`);
  }
});

test('every entry on every rail has a label', () => {
  for (const id of ALL_RAIL_TASK_IDS) {
    assert.strictEqual(typeof RAIL_TASK_LABELS[id], 'string', `${id} has no label`);
    assert.ok(RAIL_TASK_LABELS[id].length > 0, `${id}'s label is empty`);
  }
});

test('ALL_RAIL_TASK_IDS is every rail\'s entries, once each', () => {
  const seen = new Set(ALL_RAIL_TASK_IDS);
  assert.strictEqual(seen.size, ALL_RAIL_TASK_IDS.length, 'a task id is listed twice');
  for (const artifact of Object.keys(ARTIFACT_RAIL_GROUPS)) {
    for (const id of railTaskIdsFor(artifact)) {
      assert.ok(seen.has(id), `${id} is on the ${artifact} rail but not in ALL_RAIL_TASK_IDS`);
    }
  }
});

// ── Shortcuts ───────────────────────────────────────────────────────────────

test('an empty rail binds no digits at all', () => {
  assert.strictEqual(railTaskForDigit('book', 1), undefined,
    'the book rail has no rows, so 1 reaches nothing');
  assert.deepStrictEqual(railShortcutsFor('book'), {});
});

test('select keeps its letter and takes no digit', () => {
  const shortcuts = railShortcutsFor('source');
  assert.strictEqual(shortcuts.select, 'S');
  assert.strictEqual(railTaskForDigit('source', 1), 'crop');
  assert.strictEqual(railTaskForDigit('source', 2), 'merge');
});

test('a digit never reaches an entry that is not on the rail', () => {
  for (const artifact of Object.keys(ARTIFACT_RAIL_GROUPS)) {
    const shown = new Set(railTaskIdsFor(artifact));
    for (let digit = 1; digit <= 9; digit += 1) {
      const id = railTaskForDigit(artifact, digit);
      if (id === undefined) continue;
      assert.ok(shown.has(id), `${artifact}: digit ${digit} reaches ${id}, which is not on it`);
    }
  }
});

test('every entry on a rail has a key hint', () => {
  for (const artifact of Object.keys(ARTIFACT_RAIL_GROUPS)) {
    const shortcuts = railShortcutsFor(artifact);
    for (const id of railTaskIdsFor(artifact)) {
      assert.strictEqual(typeof shortcuts[id], 'string', `${artifact}/${id} has no key hint`);
    }
  }
});

for (const t of tests) {
  try {
    t.fn();
    passed += 1;
  } catch (err) {
    failures.push({ name: t.name, err });
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`FAIL  ${f.name}`);
    console.error(`      ${f.err.message}`);
  }
  console.error(`\n${passed}/${tests.length} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`rail-tasks: ${passed}/${tests.length} passed`);
