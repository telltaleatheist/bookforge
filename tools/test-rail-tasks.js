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
 *    curation modes; the book gets its text passes and the narration copy;
 *    neither ever gets the other's, which is what stops a curation tool from
 *    appearing over a file that has no pages to curate.
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
  EPUB_PASS_TASK_IDS,
  RAIL_TASK_LABELS,
  railGroupsForArtifact,
  railTaskIdsFor,
  railShortcutsFor,
  railTaskForDigit,
  derivePassStatus,
  viewedArtifactOf,
  viewingWorkingCopy,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** One recorded pass. `at` is what appendAppliedPass writes: an ISO timestamp. */
const ran = (kind, at) => ({ kind, at });

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

test('every artifact the viewer can show has a rail', () => {
  for (const artifact of ARTIFACTS) {
    const groups = railGroupsForArtifact(artifact);
    assert.ok(Array.isArray(groups) && groups.length > 0,
      `${artifact} has no rail groups`);
  }
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

test('the book rail is the text passes, then the narration copy', () => {
  const ids = railTaskIdsFor('book');
  assert.deepStrictEqual([...ids], ['simplify', 'translate', 'export-tts']);
});

test('the AI footnote pass is gone from every rail', () => {
  // Footnote references come out as the narration copy is written now, and no
  // pass edits the book for them.
  assert.ok(!ALL_RAIL_TASK_IDS.includes('footnotes'));
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

test('the pass ids are the pass group, and NOT the whole book rail', () => {
  // Export TTS copy sits beside them and is not a pass: it writes a second file
  // and records no provenance, so nothing may ask it for a pass status.
  assert.deepStrictEqual([...EPUB_PASS_TASK_IDS], ['simplify', 'translate']);
  assert.ok(!EPUB_PASS_TASK_IDS.includes('export-tts'));
  assert.ok(railTaskIdsFor('book').includes('export-tts'));
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

test('the digits run over the rows that are actually on screen', () => {
  // The book's first pass is 1 — not 3, which is where a global numbering would
  // have put it, advertising keys 1-2 that do nothing on that rail.
  assert.strictEqual(railTaskForDigit('book', 1), 'simplify');
  assert.strictEqual(railTaskForDigit('book', 2), 'translate');
  assert.strictEqual(railTaskForDigit('book', 3), 'export-tts');
  assert.strictEqual(railShortcutsFor('book').simplify, '1');
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

// ── Pass status ─────────────────────────────────────────────────────────────

test('a pass that has never run says so', () => {
  const status = derivePassStatus('simplify', []);
  assert.strictEqual(status.kind, 'untouched');
  assert.strictEqual(status.detail, 'not run');
});

test('a pass that has run says so, with the day it ran', () => {
  const status = derivePassStatus('simplify', [ran('simplify', '2026-08-04T12:00:00.000Z')]);
  assert.strictEqual(status.kind, 'done');
  assert.match(status.detail, /^applied 2026-08-0[34]$/);
});

test('another kind\'s pass does not light this one', () => {
  const passes = [ran('simplify', '2026-08-04T12:00:00.000Z')];
  assert.strictEqual(derivePassStatus('translate', passes).kind, 'untouched');
  assert.strictEqual(derivePassStatus('simplify', passes).kind, 'done');
});

test('the passes that PRODUCED the book light none of them', () => {
  // The retired document passes are recorded against books that still exist, and
  // `vlm-convert` is recorded against every converted one. None is a rail entry
  // and none may read as one having run.
  const passes = [
    ran('get-text', '2026-08-04T10:00:00.000Z'),
    ran('blocks', '2026-08-04T10:30:00.000Z'),
    ran('reflow', '2026-08-04T11:00:00.000Z'),
    ran('vlm-convert', '2026-08-07T11:00:00.000Z'),
  ];
  for (const id of EPUB_PASS_TASK_IDS) {
    assert.strictEqual(derivePassStatus(id, passes).kind, 'untouched', `${id} lit`);
  }
});

test('a pass run twice is counted, and the LAST run is the one described', () => {
  const status = derivePassStatus('translate', [
    ran('translate', '2026-08-01T12:00:00.000Z'),
    ran('translate', '2026-08-04T12:00:00.000Z'),
  ]);
  assert.strictEqual(status.kind, 'done');
  assert.match(status.detail, /^applied 2 times, last 2026-08-0[34]$/);
});

test('a record with an unreadable timestamp still reports the pass as run', () => {
  // A manifest outlives the build that wrote it. An `at` this app cannot read is
  // still proof the pass ran, which is what the status is about.
  const status = derivePassStatus('simplify', [ran('simplify', 'last Tuesday')]);
  assert.strictEqual(status.kind, 'done');
  assert.strictEqual(status.detail, 'applied');
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
