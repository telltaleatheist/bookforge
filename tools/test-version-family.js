#!/usr/bin/env node
/**
 * Tests for shared/document/version-family.ts — the versions page's family.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-version-family.js
 *
 * Three things are under test, and each of them is a bug this module exists
 * because of (docs/PIPELINE_V2_PLAN.md, "Versions page"):
 *
 *  - **The working copy has a door.** A book cast and detected from the queue
 *    showed only its archive on the versions page: the work was on disk and
 *    unreachable. So the row exists exactly when the binding AND the file do,
 *    and never from a filename guess.
 *  - **A pass is not a version.** Footnote removal, simplify and translate mint
 *    no row — they are stars on the book they edited, collapsed latest-wins.
 *  - **The archive can never earn a star.** archive/ is never written to, so no
 *    stage has ever landed on it. Asserted here rather than commented, against
 *    an input carrying every boundary and every pass at once.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'version-family.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  VERSION_STARS,
  STAR_LABELS,
  latestPassByKind,
  starSlotsFor,
  starsFor,
  epubStaleness,
  versionFamily,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const CAST = '2026-08-05T00:05:35.903Z';
const DETECT = '2026-08-05T00:06:09.163Z';
const BUILT = '2026-08-05T01:00:00.000Z';

/** A book with nothing but its archive original on disk. */
const bare = (over = {}) => ({
  archive: { id: 'archive:archive/Book.pdf' },
  working: null,
  epub: null,
  appliedPasses: [],
  ...over,
});

/** A working copy with the boundaries named, and nothing curated since. */
const working = (stages, modifiedAt = DETECT) => ({
  id: 'working:Book.working.pdf',
  boundaries: stages.map((stage, i) => ({ stage, finishedAt: i === 0 ? CAST : DETECT })),
  modifiedAt,
});

const ids = (rows) => rows.map((r) => r.id);
const kinds = (rows) => rows.map((r) => r.kind);
const starsOf = (rows, kind) => rows.find((r) => r.kind === kind).stars;

// ── Which rows exist ────────────────────────────────────────────────────────

test('an uncast book is just its archive', () => {
  const rows = versionFamily(bare());
  assert.deepStrictEqual(kinds(rows), ['archive']);
  assert.strictEqual(rows[0].depth, 0);
});

test('a cast book has an openable working copy, indented under the archive', () => {
  // The bug, in one assertion: this row is what was missing when a book came
  // back from the queue with its work done and nowhere to go.
  const rows = versionFamily(bare({ working: working(['get-text']) }));
  assert.deepStrictEqual(kinds(rows), ['archive', 'working']);
  assert.strictEqual(rows[1].depth, 1);
});

test('no binding record, no working row — never a guess from a filename', () => {
  assert.deepStrictEqual(kinds(versionFamily(bare({ working: null }))), ['archive']);
});

test('a working copy with no archive on disk is shown flat, not under nothing', () => {
  // Indenting a child under a parent that is not there would make it read as
  // belonging to whatever row happened to be above it.
  const rows = versionFamily(bare({ archive: null, working: working(['get-text']) }));
  assert.deepStrictEqual(kinds(rows), ['working']);
  assert.strictEqual(rows[0].depth, 0);
});

test('the book is a child too, and passes add no rows of their own', () => {
  const rows = versionFamily(bare({
    working: working(['get-text', 'blocks']),
    epub: { id: 'exported', builtAt: BUILT },
    // Three passes, two of them the same kind. A pass is not a version: the row
    // count must not move.
    appliedPasses: [
      { kind: 'footnotes', at: '2026-08-05T02:00:00.000Z' },
      { kind: 'footnotes', at: '2026-08-05T03:00:00.000Z' },
      { kind: 'simplify', at: '2026-08-05T04:00:00.000Z' },
    ],
  }));
  assert.deepStrictEqual(kinds(rows), ['archive', 'working', 'epub']);
  assert.deepStrictEqual(ids(rows), ['archive:archive/Book.pdf', 'working:Book.working.pdf', 'exported']);
});

// ── Which stars are lit ─────────────────────────────────────────────────────

test('cast and detect come from the binding boundaries, not from the manifest', () => {
  const rows = versionFamily(bare({
    working: working(['get-text', 'blocks']),
    // The manifest remembers passes whose work has since been reset out of the
    // document. The working copy is the authority on what has landed in it.
    appliedPasses: [{ kind: 'get-text', at: CAST }, { kind: 'blocks', at: DETECT }],
  }));
  assert.deepStrictEqual(starsOf(rows, 'working'), ['cast', 'detect']);
});

test('a cast-but-undetected copy earns Cast only', () => {
  const rows = versionFamily(bare({ working: working(['get-text']) }));
  assert.deepStrictEqual(starsOf(rows, 'working'), ['cast']);
});

test('a manifest remembering a cast lights nothing without a boundary to prove it', () => {
  const rows = versionFamily(bare({
    working: working([]),
    appliedPasses: [{ kind: 'get-text', at: CAST }, { kind: 'blocks', at: DETECT }],
  }));
  assert.deepStrictEqual(starsOf(rows, 'working'), []);
});

test('the epub stars are the passes, collapsed by kind and in ladder order', () => {
  const rows = versionFamily(bare({
    working: working(['get-text', 'blocks']),
    epub: { id: 'exported', builtAt: BUILT },
    appliedPasses: [
      { kind: 'translate', at: '2026-08-05T05:00:00.000Z' },
      { kind: 'footnotes', at: '2026-08-05T02:00:00.000Z' },
      { kind: 'footnotes', at: '2026-08-05T03:00:00.000Z' },
      { kind: 'ocr-correction', at: '2026-08-05T01:30:00.000Z' },
    ],
  }));
  assert.deepStrictEqual(starsOf(rows, 'epub'), ['corrected', 'footnotes', 'translated']);
});

test('the document passes light no star on the book — they are the working copy\'s', () => {
  const rows = versionFamily(bare({
    working: working(['get-text']),
    epub: { id: 'exported', builtAt: BUILT },
    appliedPasses: [
      { kind: 'get-text', at: CAST }, { kind: 'blocks', at: DETECT },
      { kind: 'reflow', at: BUILT },
    ],
  }));
  assert.deepStrictEqual(starsOf(rows, 'epub'), []);
});

test('a book with no epub on disk has no epub row to hold its stars', () => {
  // The Kershaw case: the manifest still records a footnote pass against a book
  // that has since been deleted. No file, no row, no star.
  const rows = versionFamily(bare({
    working: working(['get-text', 'blocks']),
    epub: null,
    appliedPasses: [{ kind: 'footnotes', at: '2026-08-05T02:00:00.000Z' }],
  }));
  assert.deepStrictEqual(kinds(rows), ['archive', 'working']);
});

// ── The archive is starless, by construction ────────────────────────────────

test('the archive earns no star from ANY input', () => {
  // Everything at once: every boundary the pipeline records and every pass kind
  // a manifest can carry. archive/ is never written to, so none of it can be
  // about the archive — and `starsFor('archive', …)` reads neither list.
  const everything = {
    archive: { id: 'archive:archive/Book.pdf' },
    working: working(['get-text', 'blocks', 'footnotes']),
    epub: { id: 'exported', builtAt: BUILT },
    appliedPasses: [
      'get-text', 'blocks', 'reflow', 'footnotes', 'simplify', 'translate',
      'tesseract', 'ocr-correction', 'detection',
    ].map((kind) => ({ kind, at: BUILT })),
  };
  assert.deepStrictEqual(starsFor('archive', everything), []);
  assert.deepStrictEqual(starSlotsFor('archive'), []);
  assert.deepStrictEqual(starsOf(versionFamily(everything), 'archive'), []);
});

test('a row is only ever offered star columns it could actually earn', () => {
  // An unlit "Simplified" beside the working copy would read as work not done
  // yet, when simplifying a working PDF is not a thing that exists.
  assert.deepStrictEqual(starSlotsFor('working'), ['cast', 'detect']);
  assert.deepStrictEqual(starSlotsFor('epub'), ['corrected', 'footnotes', 'simplified', 'translated']);
});

test('every star has a label', () => {
  for (const star of VERSION_STARS) {
    assert.ok(STAR_LABELS[star], `${star} has no label`);
  }
});

// ── Latest-wins, the one implementation ─────────────────────────────────────

test('latestPassByKind keeps the last run and counts them all', () => {
  const collapsed = latestPassByKind([
    { kind: 'footnotes', at: 'first' },
    { kind: 'simplify', at: 'only' },
    { kind: 'footnotes', at: 'last' },
  ]);
  assert.strictEqual(collapsed.get('footnotes').latest.at, 'last');
  assert.strictEqual(collapsed.get('footnotes').count, 2);
  assert.strictEqual(collapsed.get('simplify').count, 1);
  assert.strictEqual(collapsed.get('translate'), undefined);
});

// ── Staleness: said, and only when it can be proved ─────────────────────────

test('curation after the build says the book is behind', () => {
  const stale = epubStaleness(bare({
    working: working(['get-text', 'blocks'], '2026-08-05T09:00:00.000Z'),
    epub: { id: 'exported', builtAt: BUILT },
  }));
  assert.ok(stale, 'expected a staleness sentence');
  // No invented number: nothing on disk records the individual edits.
  assert.ok(!/\d/.test(stale), `staleness must not claim a count: ${stale}`);
});

test('a book built after the last edit is not stale', () => {
  assert.strictEqual(epubStaleness(bare({
    working: working(['get-text', 'blocks'], '2026-08-05T00:30:00.000Z'),
    epub: { id: 'exported', builtAt: BUILT },
  })), null);
});

test('an unrecorded build time claims nothing at all', () => {
  // Falling back to the EPUB's own mtime would read a footnote pass — which
  // rewrites the book in place — as a rebuild, clearing a warning still true.
  assert.strictEqual(epubStaleness(bare({
    working: working(['get-text'], '2026-08-05T09:00:00.000Z'),
    epub: { id: 'exported', builtAt: null },
  })), null);
});

test('an unreadable timestamp claims nothing either', () => {
  assert.strictEqual(epubStaleness(bare({
    working: working(['get-text'], 'not a date'),
    epub: { id: 'exported', builtAt: BUILT },
  })), null);
});

test('staleness rides the epub row and nothing else', () => {
  const rows = versionFamily(bare({
    working: working(['get-text', 'blocks'], '2026-08-05T09:00:00.000Z'),
    epub: { id: 'exported', builtAt: BUILT },
  }));
  assert.strictEqual(rows.find((r) => r.kind === 'archive').staleness, null);
  assert.strictEqual(rows.find((r) => r.kind === 'working').staleness, null);
  assert.ok(rows.find((r) => r.kind === 'epub').staleness);
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\nversion family: ${failures.length} test(s) failed`);
  process.exit(1);
}
console.log(`\nversion family: ${passed} test(s) passed`);
