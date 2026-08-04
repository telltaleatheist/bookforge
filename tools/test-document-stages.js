#!/usr/bin/env node
/**
 * Tests for electron/document-stages.ts — the pipeline's stages as
 * transformations of one document.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-document-stages.js
 *
 * ── Two halves, and the second one is opt-in ────────────────────────────────
 *
 * Most of what is worth defending here needs no foundry: which stages a document
 * reads as having had is derived from the file, so it can be set up by putting
 * files in a directory, and every refusal — a missing working document, a
 * missing scratch scan, a book with no block layer, a working document cast from
 * some other original — is reachable the same way.
 *
 * The rest of it is the claim this whole design rests on: **the boundary is the
 * file's length after foundry exits.** That one cannot be tested against a mock
 * of foundry, because the thing being tested IS foundry's write discipline. So
 * those tests run a REAL foundry against a real PDF, and they run only when one
 * is pointed at:
 *
 *   FOUNDRY_CLI_PATH=/path/to/foundry node tools/test-document-stages.js
 *
 * Without it they SKIP, loudly and by name. They are never quietly passed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'document-stages.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// pdf-analyzer reaches for a userData directory, which outside Electron only
// this variable can supply. Set before anything requires it.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docstage-'));
process.env.BOOKFORGE_USERDATA_DIR = process.env.BOOKFORGE_USERDATA_DIR
  || path.join(SCRATCH, 'userdata');
fs.mkdirSync(process.env.BOOKFORGE_USERDATA_DIR, { recursive: true });

const stages = require(path.join(DIST, 'document-stages.js'));
const binding = require(path.join(DIST, 'document-binding.js'));

const FIXTURE = path.join(REPO, 'tools', 'fixtures', 'document-pipeline');
const ORIGINAL_PDF = path.join(FIXTURE, 'original.pdf');
const WORKING_PDF = path.join(FIXTURE, 'working.pdf');

const foundryPath = (process.env.FOUNDRY_CLI_PATH || '').trim();
const haveFoundry = foundryPath.length > 0 && fs.existsSync(foundryPath);

let passed = 0;
let skipped = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const liveTest = (name, fn) => tests.push({ name, fn, live: true });

const projects = [];

/** A project directory laid out the way a real one is. `cast` places a working PDF. */
function makeProject({ cast = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docstage-p-'));
  projects.push(dir);
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.copyFileSync(ORIGINAL_PDF, path.join(dir, 'archive', 'A Test Book.pdf'));
  const project = {
    projectId: 'a-test-book',
    projectDir: dir,
    primaryRelPath: 'archive/A Test Book.pdf',
  };
  if (cast) fs.copyFileSync(WORKING_PDF, stages.workingAbsPath(project));
  return project;
}

/**
 * The scratch scan directory for a project's archive original.
 *
 * It is derived from that file's hash and lives under the user's HOME — it is
 * machine-global, and every project in this file holds the same fixture bytes,
 * so they all share one. Tests that care what is in it therefore have to say so
 * rather than assume a clean machine: the live tests below FILL it, and a run of
 * this file leaves it behind for the next one.
 */
function fixtureScratchDir() {
  const bytes = fs.readFileSync(ORIGINAL_PDF);
  return stages.documentScratchDir(
    require('crypto').createHash('sha256').update(bytes).digest('hex')
  );
}

async function bindCast(project) {
  const record = await binding.createDocumentBinding({
    projectId: project.projectId,
    projectDir: project.projectDir,
    primaryRelPath: project.primaryRelPath,
    workingAbsPath: stages.workingAbsPath(project),
    documentClass: 'text',
    foundryVersion: '0.3.1',
  });
  await binding.writeDocumentBinding(stages.bindingAbsPath(project), record);
  return record;
}

// ── progress parsing ────────────────────────────────────────────────────────

test('the LAST n/total on a line wins', () => {
  // `page 1/2: 20/20 blocks labelled` carries the page counter first and the
  // interesting number second.
  assert.deepStrictEqual(stages.parseProgress('  page 1/2: 20/20 blocks labelled'), { done: 20, total: 20 });
  assert.deepStrictEqual(stages.parseProgress('ocr: 100/2120 lines'), { done: 100, total: 2120 });
  assert.deepStrictEqual(stages.parseProgress('render: 3/50 pages at 200 dpi'), { done: 3, total: 50 });
});

test('a line with no counter is still a message, not a parse failure', () => {
  assert.strictEqual(stages.parseProgress('blocks: paragraph convention "indent" — DEGRADED: …'), null);
  assert.strictEqual(stages.parseProgress('scan: 0/0 nothing'), null);
});

// ── where things live ───────────────────────────────────────────────────────

test('the working document and the binding sit in the project root', () => {
  const project = { projectId: 'x', projectDir: path.join('/lib', 'proj'), primaryRelPath: 'archive/Book.pdf' };
  assert.strictEqual(path.basename(stages.workingAbsPath(project)), 'Book.working.pdf');
  assert.strictEqual(path.dirname(stages.workingAbsPath(project)), path.normalize('/lib/proj'));
  assert.strictEqual(path.basename(stages.bindingAbsPath(project)), 'Book.pdf.documents.json');
  assert.strictEqual(path.dirname(stages.bindingAbsPath(project)), path.normalize('/lib/proj'));
  // …and nothing derives a path INTO archive/ except the primary itself.
  assert.strictEqual(path.basename(path.dirname(stages.primaryAbsPath(project))), 'archive');
});

test('the scratch directory is derived from the original, not remembered', () => {
  const a = stages.documentScratchDir('a'.repeat(64));
  const b = stages.documentScratchDir('b'.repeat(64));
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, stages.documentScratchDir('a'.repeat(64)));
  // Machine-local, beside the other caches — never inside the synced project.
  assert.ok(a.includes('foundry-runs'), a);
});

// ── state derived from the document ─────────────────────────────────────────

test('a project with nothing cast reads as no stage having run', async () => {
  const project = makeProject();
  const state = await stages.readDocumentPipelineState(project);
  assert.strictEqual(state.binding, null);
  assert.strictEqual(state.working, null);
  assert.strictEqual(state.documentClass, null);
  assert.deepStrictEqual(state.stages, { getText: false, blocks: false, footnotes: false, reflow: false });
});

test('a cast working document reads as Get Text done and nothing after it', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  const state = await stages.readDocumentPipelineState(project);
  assert.strictEqual(state.documentClass, 'text');
  assert.strictEqual(state.stages.getText, true);
  // `scan --pdf` writes the marker and the text layer; it writes no blocks.
  assert.strictEqual(state.stages.blocks, false);
  assert.strictEqual(state.stages.footnotes, false);
  assert.strictEqual(state.stages.reflow, false);
});

test('a working document cast from ANOTHER original reads as un-run, not as done', async () => {
  const project = makeProject({ cast: true });
  const record = await bindCast(project);
  // The archive original was replaced and re-bound; the working document on
  // disk still belongs to the old bytes.
  const wrong = { ...record, primary: { ...record.primary, sha256: 'f'.repeat(64) } };
  await binding.writeDocumentBinding(stages.bindingAbsPath(project), wrong);
  const state = await stages.readDocumentPipelineState(project);
  // The document is READ — it is a working document — but not this book's.
  assert.ok(state.working);
  assert.deepStrictEqual(state.stages, { getText: false, blocks: false, footnotes: false, reflow: false });
});

test('Reflow reads as done only while the book it vouches for is still there', async () => {
  const project = makeProject({ cast: true });
  let record = await bindCast(project);
  const epub = path.join(project.projectDir, 'source', 'A Test Book.epub');
  fs.mkdirSync(path.dirname(epub), { recursive: true });
  fs.writeFileSync(epub, 'PK pretend epub');
  record = await binding.recordExportedEpub(record, project.projectDir, epub);
  await binding.writeDocumentBinding(stages.bindingAbsPath(project), record);
  assert.strictEqual((await stages.readDocumentPipelineState(project)).stages.reflow, true);

  fs.rmSync(epub);
  assert.strictEqual((await stages.readDocumentPipelineState(project)).stages.reflow, false);
});

test('a record overclaiming past the end of the file is healed on disk, once', async () => {
  const project = makeProject({ cast: true });
  const record = await bindCast(project);
  const workingPath = stages.workingAbsPath(project);
  fs.appendFileSync(workingPath, Buffer.alloc(256, 0x25));
  const withBlocks = await binding.recordStageBoundary({
    binding: record, projectDir: project.projectDir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  await binding.writeDocumentBinding(stages.bindingAbsPath(project), withBlocks);
  // A reset interrupted after the cut and before the rewrite.
  fs.truncateSync(workingPath, record.boundaries[0].offset);

  await stages.readDocumentPipelineState(project);
  const healed = binding.readDocumentBinding(stages.bindingAbsPath(project));
  assert.deepStrictEqual(healed.boundaries.map((b) => b.stage), ['get-text']);
});

// ── every refusal names the stage that writes what is missing ───────────────

test('Blocks on a book with no working document names Get Text', async () => {
  const project = makeProject();
  await assert.rejects(
    () => stages.runBlocksStage({ project }),
    /Run Get Text/
  );
});

test('Reflow on a book with no working document names Get Text', async () => {
  const project = makeProject();
  await assert.rejects(() => stages.runReflowStage({
    project, outputPath: path.join(project.projectDir, 'source', 'Book.epub'),
  }), /Run Get Text/);
});

test('a binding whose working document has vanished says so rather than re-casting', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  fs.rmSync(stages.workingAbsPath(project));
  await assert.rejects(
    () => stages.runBlocksStage({ project }),
    /although this book has a binding record that says it was cast/
  );
});

test('an archive original replaced under a cast book stops every stage', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  fs.writeFileSync(path.join(project.projectDir, 'archive', 'A Test Book.pdf'), 'other bytes');
  await assert.rejects(
    () => stages.runBlocksStage({ project }),
    /is not the file this book's documents were built from/
  );
});

test('Blocks with no scan geometry names Get Text and says the scratch is machine-local', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  // Said, not assumed: an earlier run of this file (or a real cast of the same
  // fixture) leaves the scratch behind, and this test is about it being absent.
  fs.rmSync(fixtureScratchDir(), { recursive: true, force: true });
  await assert.rejects(
    () => stages.runBlocksStage({ project }),
    (err) => /line geometry/.test(err.message) && /not synced between machines/.test(err.message)
      && /Run Get Text/.test(err.message)
  );
});

test('Reflow on a document with no block layer names the Blocks stage', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  await assert.rejects(() => stages.runReflowStage({
    project, outputPath: path.join(project.projectDir, 'source', 'Book.epub'),
  }), /no block layer.*Run the Blocks stage/s);
});

test('footnotes-on-the-PDF is refused for a publisher’s own text layer', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);   // class `text`
  await assert.rejects(() => stages.runFootnotesPdfStage({
    project, reportPath: path.join(project.projectDir, 'report.json'),
  }), /would re-lay-out the book.*on the EPUB instead/s);
});

test('resetting a book that was never cast says so instead of inventing a binding', async () => {
  const project = makeProject();
  await assert.rejects(() => stages.resetDocumentTo(project, 'get-text'), /Run Get Text/);
});

test('discarding takes the working document and the record, never the archive original', async () => {
  const project = makeProject({ cast: true });
  await bindCast(project);
  await stages.discardDocumentPipeline(project);
  assert.ok(!fs.existsSync(stages.workingAbsPath(project)));
  assert.ok(!fs.existsSync(stages.bindingAbsPath(project)));
  assert.ok(fs.existsSync(stages.primaryAbsPath(project)));
});

// ── with a real foundry ─────────────────────────────────────────────────────

liveTest('Get Text casts a text PDF, and the cast IS the boundary', async () => {
  const project = makeProject();
  const seen = [];
  const { binding: record, documentClass } = await stages.runGetTextStage({
    project,
    onProgress: (p) => seen.push(p),
  });

  assert.strictEqual(documentClass, 'text');
  const workingPath = stages.workingAbsPath(project);
  assert.ok(fs.existsSync(workingPath), 'no working document was written');

  // The claim: the boundary is the file's length after foundry exited.
  assert.strictEqual(record.boundaries.length, 1);
  assert.strictEqual(record.boundaries[0].stage, 'get-text');
  assert.strictEqual(record.boundaries[0].offset, fs.statSync(workingPath).size);
  assert.strictEqual(record.working.bytes, fs.statSync(workingPath).size);

  // The marker foundry wrote names the archive original, and the binding agrees.
  const state = await stages.readDocumentPipelineState(project);
  assert.strictEqual(state.stages.getText, true);
  assert.strictEqual(state.working.marker.sourceSha256, record.primary.sha256);
  assert.ok(seen.length > 0, 'no progress was reported');
});

liveTest('a re-cast replaces the working document rather than resuming into it', async () => {
  const project = makeProject();
  const first = await stages.runGetTextStage({ project });
  fs.appendFileSync(stages.workingAbsPath(project), Buffer.alloc(999, 0x25));
  const second = await stages.runGetTextStage({ project });
  assert.strictEqual(second.binding.boundaries.length, 1);
  assert.strictEqual(second.binding.working.bytes, first.binding.working.bytes);
  assert.strictEqual(second.binding.working.sha256, first.binding.working.sha256);
});

liveTest('reset to Get Text restores the exact document, byte for byte', async () => {
  const project = makeProject();
  const cast = await stages.runGetTextStage({ project });
  const workingPath = stages.workingAbsPath(project);
  const castBytes = fs.readFileSync(workingPath);

  // Stand in for a later stage's append — the arithmetic is the same whichever
  // stage wrote it, and this one needs no 8 GB of weights.
  fs.appendFileSync(workingPath, Buffer.alloc(4096, 0x25));
  let record = await binding.recordStageBoundary({
    binding: cast.binding, projectDir: project.projectDir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  await binding.writeDocumentBinding(stages.bindingAbsPath(project), record);

  record = await stages.resetDocumentTo(project, 'get-text');
  assert.ok(fs.readFileSync(workingPath).equals(castBytes), 'the document is not what it was');
  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text']);
  // …and it is still a working document a reader can open.
  const state = await stages.readDocumentPipelineState(project);
  assert.strictEqual(state.stages.getText, true);
});

liveTest('Reflow refuses the cast document until Blocks has labelled it', async () => {
  const project = makeProject();
  await stages.runGetTextStage({ project });
  await assert.rejects(() => stages.runReflowStage({
    project, outputPath: path.join(project.projectDir, 'source', 'A Test Book.epub'),
  }), /no block layer/);
  // Nothing half-written was left behind by the refusal.
  assert.ok(!fs.existsSync(path.join(project.projectDir, 'source', 'A Test Book.epub')));
  assert.ok(!fs.existsSync(path.join(project.projectDir, 'source', 'A Test Book.epub.bookforge-tmp')));
});

(async () => {
  for (const { name, fn, live } of tests) {
    if (live && !haveFoundry) {
      skipped++;
      console.log(`  SKIP  ${name}`);
      continue;
    }
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err && err.message ? err.message : err}`);
    }
  }
  // The scratch scan directory is machine-global (see scratchOf); a live run
  // fills it with this fixture's geometry, and leaving that behind would be this
  // file littering a real BookForge install's cache with a test book.
  for (const dir of projects) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fixtureScratchDir(), { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (skipped > 0) {
    console.log(
      `\n${skipped} test(s) SKIPPED: they run a real foundry against a real PDF, which is the only\n`
      + 'way to test that a stage boundary is the file length foundry leaves behind. Set\n'
      + 'FOUNDRY_CLI_PATH to a foundry >= 0.3.1 binary to run them.'
    );
  }
  console.log(`document-stages: ${passed} test(s) passed${skipped ? `, ${skipped} skipped` : ''}`);
})();
