#!/usr/bin/env node
/**
 * Tests for shared/document/rail-tasks.ts — what the picker's left rail offers.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-rail-tasks.js
 *
 * Two rules, and the bug that made them necessary. The rail used to be shown
 * "where curation is possible", which hid it at the EPUB station — the one place
 * the book's own passes now live. So:
 *
 *  - the rail's CONTENTS are a fact about the artifact on screen, and nothing
 *    else. The source gets the curation modes; the book gets its text passes;
 *    neither ever gets the other's, which is what stops a curation tool from
 *    appearing over an artifact that refuses it.
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
} = require(MODULE);
const { ARTIFACT_STATIONS } = require(path.join(REPO, 'dist', 'shared', 'document', 'stations.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** One recorded pass. `at` is what appendAppliedPass writes: an ISO timestamp. */
const ran = (kind, at) => ({ kind, at });

// ── Contents per artifact ───────────────────────────────────────────────────

test('every artifact the viewer can show has a rail', () => {
  for (const artifact of Object.keys(ARTIFACT_STATIONS)) {
    const groups = railGroupsForArtifact(artifact);
    assert.ok(Array.isArray(groups) && groups.length > 0,
      `${artifact} has no rail groups`);
  }
});

test('the source rail is the curation modes and their tasks', () => {
  const ids = railTaskIdsFor('source');
  assert.deepStrictEqual([...ids], ['select', 'crop', 'ocr', 'merge']);
});

test('the book rail is the text passes, in the plan\'s preferred order', () => {
  const ids = railTaskIdsFor('book');
  assert.deepStrictEqual([...ids], ['footnotes', 'simplify', 'translate']);
});

test('no curation entry is ever offered over the book', () => {
  const curation = new Set(railTaskIdsFor('source'));
  for (const id of railTaskIdsFor('book')) {
    assert.ok(!curation.has(id), `${id} is on both rails`);
  }
});

test('no pass entry is ever offered over the source', () => {
  const passes = new Set(railTaskIdsFor('book'));
  for (const id of railTaskIdsFor('source')) {
    assert.ok(!passes.has(id), `${id} is on both rails`);
  }
});

test('the pass ids are exactly the book rail', () => {
  assert.deepStrictEqual([...EPUB_PASS_TASK_IDS], [...railTaskIdsFor('book')]);
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
  // The book's first pass is 1 — not 4, which is where a global numbering would
  // have put it, advertising keys 1-3 that do nothing on that rail.
  assert.strictEqual(railTaskForDigit('book', 1), 'footnotes');
  assert.strictEqual(railTaskForDigit('book', 2), 'simplify');
  assert.strictEqual(railTaskForDigit('book', 3), 'translate');
  assert.strictEqual(railShortcutsFor('book').footnotes, '1');
});

test('select keeps its letter and takes no digit', () => {
  const shortcuts = railShortcutsFor('source');
  assert.strictEqual(shortcuts.select, 'S');
  assert.strictEqual(railTaskForDigit('source', 1), 'crop');
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
  const status = derivePassStatus('footnotes', []);
  assert.strictEqual(status.kind, 'untouched');
  assert.strictEqual(status.detail, 'not run');
});

test('a pass that has run says so, with the day it ran', () => {
  const status = derivePassStatus('footnotes', [ran('footnotes', '2026-08-04T12:00:00.000Z')]);
  assert.strictEqual(status.kind, 'done');
  assert.match(status.detail, /^applied 2026-08-0[34]$/);
});

test('another kind\'s pass does not light this one', () => {
  const passes = [ran('simplify', '2026-08-04T12:00:00.000Z')];
  assert.strictEqual(derivePassStatus('footnotes', passes).kind, 'untouched');
  assert.strictEqual(derivePassStatus('simplify', passes).kind, 'done');
});

test('the passes that PRODUCED the book light none of them', () => {
  // get-text, blocks and reflow are recorded against the book too. They are not
  // rail entries and must not read as one having run.
  const passes = [
    ran('get-text', '2026-08-04T10:00:00.000Z'),
    ran('blocks', '2026-08-04T10:30:00.000Z'),
    ran('reflow', '2026-08-04T11:00:00.000Z'),
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

console.log(`\nrail-tasks: ${passed}/${tests.length} passed`);
for (const f of failures) {
  console.error(`\n  FAIL ${f.name}\n    ${f.err.message}`);
}
process.exit(failures.length === 0 ? 0 : 1);
