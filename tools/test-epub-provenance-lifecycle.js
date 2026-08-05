#!/usr/bin/env node
/**
 * Tests for the EPUB's provenance lifecycle in electron/manifest-service.ts —
 * against a REAL project directory on disk, in a temp library.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-epub-provenance-lifecycle.js
 *
 * `shared/document/pass-lifecycle.ts` decides WHICH passes survive an event and
 * `tools/test-pass-lifecycle.js` proves that rule without a project. This file
 * proves the other half: that the two code paths that end a book's life actually
 * carry the decision out, on files.
 *
 *  - `registerEpubExport` is what a REBUILD goes through. Its comment in
 *    processing-passes.ts has long claimed it "starts the book's provenance
 *    over"; asserted here rather than believed, because docs/PIPELINE_V2_PLAN.md
 *    promises the user that a rebuild clears the old book's stars.
 *  - `forgetEpubExport` is what a DELETE goes through: the record, the passes and
 *    the diffs those passes wrote, all in one act.
 *
 * And the rule that bounds both of them: nothing else comes off. A stage
 * directory no record names is left exactly where it is — a diff is a user's
 * record of what a model did to their book, and only the artifact it describes
 * going away takes it.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PROJECT_ID = 'Test_Book_-_A_Author_-_1999';
const BOOK_REL = 'source/Test Book.epub';

/**
 * A project with a book, three recorded passes (two with diffs), the stage
 * directories those diffs live in, and one orphan stage directory no record
 * names. Returned as its own temp library so nothing touches a real one.
 */
function makeProject(over = {}) {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-provenance-'));
  const projectDir = path.join(library, 'projects', PROJECT_ID);
  fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, BOOK_REL.split('/').join(path.sep)), 'BOOK BYTES');

  const write = (rel, body) => {
    const abs = path.join(projectDir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('stages/04-footnotes/diff.json', '{"units":[]}');
  write('stages/04-footnotes/report.json', '{"totals":{}}');
  write('stages/05-simplify/diff.json', '{"units":[]}');
  // No record names this one. It must survive everything below.
  write('stages/09-translate/diff.json', '{"units":[]}');
  // The LL pipeline's own directory, which holds real books. Reserved by name.
  write('stages/02-translate/de.epub', 'A REAL BOOK');
  write('stages/02-translate/diff.json', '{"units":[]}');

  const manifest = {
    version: 2,
    projectId: PROJECT_ID,
    type: 'book',
    metadata: { title: 'Test Book' },
    outputs: {
      epub: {
        path: BOOK_REL,
        modifiedAt: '2026-08-05T01:00:00.000Z',
        appliedPasses: [
          { kind: 'reflow', at: '2026-08-05T01:00:00.000Z' },
          { kind: 'footnotes', at: '2026-08-05T02:00:00.000Z', diff: 'stages/04-footnotes/diff.json' },
          { kind: 'simplify', at: '2026-08-05T03:00:00.000Z', diff: 'stages/05-simplify/diff.json' },
        ],
      },
    },
    ...over,
  };
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  manifestService.setLibraryBasePath(library);
  return {
    library,
    projectDir,
    abs: (rel) => path.join(projectDir, rel.split('/').join(path.sep)),
    read: () => JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf-8')),
    cleanup: () => fs.rmSync(library, { recursive: true, force: true }),
  };
}

const run = async (fn) => {
  const p = makeProject();
  try { await fn(p); } finally { p.cleanup(); }
};

// ── The rebuild ─────────────────────────────────────────────────────────────

test('a rebuild starts the provenance over — the stars clear', () => run(async (p) => {
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  const after = p.read();
  assert.strictEqual(after.outputs.epub.path, BOOK_REL, 'the book is still recorded');
  assert.ok(!after.outputs.epub.appliedPasses || after.outputs.epub.appliedPasses.length === 0,
    'the passes applied to the OLD book did not happen to this one');
}));

test('a rebuild takes the superseded passes\' stage directories with it', () => run(async (p) => {
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  assert.ok(!fs.existsSync(p.abs('stages/04-footnotes')), 'the footnote pass\'s stage dir survived');
  assert.ok(!fs.existsSync(p.abs('stages/05-simplify')), 'the simplify pass\'s stage dir survived');
}));

test('a rebuild leaves a stage directory no record names', () => run(async (p) => {
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  assert.ok(fs.existsSync(p.abs('stages/09-translate/diff.json')),
    'a diff nothing records is still the user\'s — only the artifact it describes takes it');
}));

test('a rebuild never touches the book itself', () => run(async (p) => {
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  assert.strictEqual(fs.readFileSync(p.abs(BOOK_REL), 'utf-8'), 'BOOK BYTES');
}));

test('a rebuild of a book with no passes removes nothing', () => run(async (p) => {
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  // Second rebuild: the provenance is already empty.
  await manifestService.registerEpubExport(p.projectDir, p.abs(BOOK_REL));
  assert.ok(fs.existsSync(p.abs('stages/09-translate/diff.json')));
  assert.ok(fs.existsSync(p.abs('stages/02-translate/de.epub')));
}));

// ── The delete ──────────────────────────────────────────────────────────────

test('forgetting the book drops the record, the passes and their diffs', () => run(async (p) => {
  const summary = await manifestService.forgetEpubExport(p.projectDir);
  assert.strictEqual(summary.relPath, BOOK_REL);
  assert.strictEqual(summary.droppedPasses, 3);
  assert.deepStrictEqual(summary.removedPaths, ['stages/04-footnotes', 'stages/05-simplify']);
  assert.ok(!p.read().outputs.epub, 'the record still names a book that is being deleted');
  assert.ok(!fs.existsSync(p.abs('stages/04-footnotes')));
  assert.ok(!fs.existsSync(p.abs('stages/05-simplify')));
}));

test('forgetting the book does NOT delete it — the file is the caller\'s act', () => run(async (p) => {
  await manifestService.forgetEpubExport(p.projectDir);
  assert.ok(fs.existsSync(p.abs(BOOK_REL)),
    'the record goes first and the file after, so a failure between them leaves a stray, not a lie');
}));

test('forgetting the book leaves the user\'s block deletions alone', () => run(async (p) => {
  // `clearProcessingRecords` (Start over) takes these. Deleting the book must not.
  const before = p.read();
  before.source = { deletedBlockLines: [{ scanId: 'abc', line: 3 }] };
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(before, null, 2));
  await manifestService.forgetEpubExport(p.projectDir);
  assert.deepStrictEqual(p.read().source.deletedBlockLines, [{ scanId: 'abc', line: 3 }]);
}));

test('a RESERVED stage directory keeps its books', () => run(async (p) => {
  const m = p.read();
  m.outputs.epub.appliedPasses.push(
    { kind: 'translate', at: '2026-08-05T04:00:00.000Z', diff: 'stages/02-translate/diff.json' });
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));
  await manifestService.forgetEpubExport(p.projectDir);
  assert.ok(!fs.existsSync(p.abs('stages/02-translate/diff.json')), 'the diff file comes off');
  assert.ok(fs.existsSync(p.abs('stages/02-translate/de.epub')),
    'the LL pipeline\'s own book shares that directory and must survive');
}));

test('forgetting a book that is not recorded refuses by name', () => run(async (p) => {
  await manifestService.forgetEpubExport(p.projectDir);
  await assert.rejects(
    () => manifestService.forgetEpubExport(p.projectDir),
    /no outputs\.epub/,
    'a second delete must say there is no book, not silently succeed');
}));

test('a diff recorded outside the project refuses, and removes nothing', () => run(async (p) => {
  const m = p.read();
  m.outputs.epub.appliedPasses = [
    { kind: 'footnotes', at: '2026-08-05T02:00:00.000Z', diff: '../../../elsewhere' },
  ];
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));
  await assert.rejects(
    () => manifestService.forgetEpubExport(p.projectDir),
    /outside the project/);
}));

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nepub provenance lifecycle: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
