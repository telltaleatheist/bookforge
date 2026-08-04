#!/usr/bin/env node
/**
 * Tests for electron/processing-chain.ts — the planner that decides what a run
 * would do before a single job is queued.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-processing-chain.js
 *
 * ── What is worth defending here ────────────────────────────────────────────
 *
 * Every refusal. A chain that cannot work has to be refused with the reason, at
 * plan time — never accepted and discovered at step four, three hours in, by a
 * stage that cannot find its input. So each test below asserts BOTH that the
 * plan is refused and that the message names the pass the user has to add or
 * move: a refusal nobody can act on is a failure with extra steps.
 *
 * None of this needs foundry. The planner's prerequisites are read off the
 * DOCUMENTS — a marker means Get Text has run, annotations mean Blocks has — so
 * the whole state space is reachable by putting files in a directory, which is
 * exactly the property the document pipeline was built for.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'processing-chain.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chain-'));
process.env.BOOKFORGE_USERDATA_DIR = process.env.BOOKFORGE_USERDATA_DIR
  || path.join(SCRATCH, 'userdata');
fs.mkdirSync(process.env.BOOKFORGE_USERDATA_DIR, { recursive: true });

const chain = require(path.join(DIST, 'processing-chain.js'));
const binding = require(path.join(DIST, 'document-binding.js'));
const stages = require(path.join(DIST, 'document-stages.js'));

const FIXTURE = path.join(REPO, 'tools', 'fixtures', 'document-pipeline');
const ORIGINAL_PDF = path.join(FIXTURE, 'original.pdf');
const WORKING_PDF = path.join(FIXTURE, 'working.pdf');

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const dirs = [];

const PDF_NAME = 'A Test Book.pdf';

/**
 * A project laid out the way a real one is.
 *
 * `cast` places a working document AND the binding that vouches for it, which is
 * what makes `readDocumentPipelineState` report Get Text as done — a working
 * document alone is not this book's until the binding says the original it names
 * is this project's original.
 */
async function makeProject({ cast = false, pdf = true, exported = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chain-p-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  if (pdf) fs.copyFileSync(ORIGINAL_PDF, path.join(dir, 'archive', PDF_NAME));

  const manifest = {
    projectId: path.basename(dir),
    createdAt: new Date().toISOString(),
    metadata: { title: 'A Test Book', author: 'Nobody' },
    source: { type: 'pdf', originalFilename: PDF_NAME },
    archive: pdf
      ? [{ path: `archive/${PDF_NAME}`, role: 'original', format: 'pdf', archivedAt: new Date().toISOString() }]
      : [{ path: 'archive/A Test Book.epub', role: 'original', format: 'epub', archivedAt: new Date().toISOString() }],
  };
  if (exported) {
    fs.writeFileSync(path.join(dir, 'source', 'A Test Book.epub'), 'not really an epub');
    manifest.outputs = { epub: { path: 'source/A Test Book.epub', modifiedAt: new Date().toISOString() } };
  }
  if (!pdf) fs.writeFileSync(path.join(dir, 'archive', 'A Test Book.epub'), 'not really an epub');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const project = {
    projectId: manifest.projectId,
    projectDir: dir,
    primaryRelPath: `archive/${PDF_NAME}`,
  };
  if (cast) {
    fs.copyFileSync(WORKING_PDF, stages.workingAbsPath(project));
    const record = await binding.createDocumentBinding({
      projectId: project.projectId,
      projectDir: dir,
      primaryRelPath: project.primaryRelPath,
      workingAbsPath: stages.workingAbsPath(project),
      documentClass: 'text',
      foundryVersion: 'test',
    });
    await binding.writeDocumentBinding(stages.bindingAbsPath(project), record);
  }
  return dir;
}

async function refuses(projectDir, passes, ...needles) {
  let message = null;
  try {
    await chain.planProcessingChain({ projectDir, passes });
  } catch (err) {
    message = err && err.message ? err.message : String(err);
  }
  assert.ok(message !== null, `expected a refusal for ${JSON.stringify(passes.map(p => p.kind))}`);
  for (const needle of needles) {
    assert.ok(
      message.includes(needle),
      `refusal should name ${JSON.stringify(needle)}, said: ${message}`
    );
  }
  return message;
}

// ─────────────────────────────────────────────────────────────────────────────

test('the document chain plans in order, and Reflow is what produces the book', async () => {
  const dir = await makeProject();
  const plan = await chain.planProcessingChain({
    projectDir: dir,
    passes: [{ kind: 'get-text' }, { kind: 'blocks' }, { kind: 'reflow' }],
  });
  assert.deepStrictEqual(
    plan.jobs.map(j => j.jobType),
    ['document-get-text', 'document-blocks', 'document-reflow']
  );
  assert.deepStrictEqual(plan.jobs.map(j => j.config.kind), ['get-text', 'blocks', 'reflow']);
  assert.strictEqual(plan.producesEpub, true, 'the chain contains a Reflow');
  // Every document job names the PDF the plan resolved, so a project that gains
  // a second one before the job runs cannot switch books underneath it.
  for (const job of plan.jobs) {
    assert.ok(job.config.sourcePath.endsWith(PDF_NAME), job.config.sourcePath);
  }
  // No run-directory fields survive: these are what sequenced a run directory.
  for (const job of plan.jobs) {
    for (const gone of ['pages', 'bookKey', 'detectionMode', 'exportAfter', 'exportPasses']) {
      assert.strictEqual(job.config[gone], undefined, `${gone} should be gone from the job config`);
    }
  }
});

test('a chain with no Reflow produces no book', async () => {
  const dir = await makeProject();
  const plan = await chain.planProcessingChain({
    projectDir: dir,
    passes: [{ kind: 'get-text' }, { kind: 'blocks' }],
  });
  assert.strictEqual(plan.producesEpub, false);
});

test('the retired passes are refused, and the refusal says where each one went', async () => {
  const dir = await makeProject();
  await refuses(dir, [{ kind: 'ocr-correction' }], 'Build the book', 'blocks you kept');
  await refuses(dir, [{ kind: 'detection' }], 'Detect blocks');
  await refuses(dir, [{ kind: 'tesseract' }], 'Get Text');
});

test('Detect blocks on a book with no working document names Get Text', async () => {
  const dir = await makeProject();
  await refuses(dir, [{ kind: 'blocks' }], 'Detect blocks', 'Get Text', 'above it');
});

test('a cast working document is enough — Detect blocks alone then plans', async () => {
  const dir = await makeProject({ cast: true });
  const plan = await chain.planProcessingChain({ projectDir: dir, passes: [{ kind: 'blocks' }] });
  assert.deepStrictEqual(plan.jobs.map(j => j.jobType), ['document-blocks']);
  // The prerequisite was answered by the DOCUMENT, not by a record of a run.
  assert.strictEqual(plan.producesEpub, false);
});

test('Reflow with no block layer names Detect blocks', async () => {
  const dir = await makeProject({ cast: true });
  // The fixture working document carries a marker and no annotations, which is
  // exactly what `foundry scan --pdf` leaves behind.
  await refuses(dir, [{ kind: 'reflow' }], 'Build the book', 'Detect blocks', 'above it');
});

test('Get Text without a Detect after it is refused — the cast leaves no blocks', async () => {
  const dir = await makeProject();
  await refuses(
    dir,
    [{ kind: 'get-text' }, { kind: 'reflow' }],
    'casts the working document fresh', 'Detect blocks'
  );
});

test('an EPUB pass ahead of a document pass is refused, never reordered', async () => {
  const dir = await makeProject({ exported: true });
  await refuses(
    dir,
    [{ kind: 'simplify', simplify: { mode: 'dejargon', aiProvider: 'local', aiModel: 'x' } },
      { kind: 'get-text' }, { kind: 'blocks' }, { kind: 'reflow' }],
    'rebuilds the book from the working document', 'Simplify'
  );
});

test('an EPUB pass behind a document chain that writes no book is refused', async () => {
  const dir = await makeProject({ cast: true, exported: true });
  await refuses(
    dir,
    [{ kind: 'blocks' },
      { kind: 'simplify', simplify: { mode: 'dejargon', aiProvider: 'local', aiModel: 'x' } }],
    'Nothing in this run writes the book', 'Build the book'
  );
});

test('a project with no PDF says so, and says what does work on it', async () => {
  const dir = await makeProject({ pdf: false, exported: true });
  await refuses(dir, [{ kind: 'get-text' }], 'no PDF', 'imported as a book');
});

test('footnote removal is one name and two documents, and the plan says which', async () => {
  const pdfProject = await makeProject({ cast: true });
  const onPdf = await chain.planProcessingChain({
    projectDir: pdfProject,
    passes: [{ kind: 'blocks' }, { kind: 'footnotes' }],
  });
  assert.strictEqual(onPdf.jobs[1].config.footnotesMode, 'pdf');

  const epubProject = await makeProject({ pdf: false, exported: true });
  const onEpub = await chain.planProcessingChain({
    projectDir: epubProject,
    passes: [{ kind: 'footnotes' }],
  });
  assert.strictEqual(onEpub.jobs[0].config.footnotesMode, 'epub');
  assert.strictEqual(onEpub.jobs[0].config.sourcePath, undefined,
    'an EPUB pass reads the book, not a PDF the plan resolved');
});

test("the EPUB-only footnote option is refused on a PDF run rather than ignored", async () => {
  const dir = await makeProject({ cast: true });
  await refuses(
    dir,
    [{ kind: 'blocks' }, { kind: 'footnotes', footnotes: { askEverything: true } }],
    'note bodies and index entries', 'working PDF'
  );
});

test('a run with no passes at all is refused', async () => {
  const dir = await makeProject();
  await refuses(dir, [], 'at least one pass');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err && err.message ? err.message : err}`);
    }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`processing-chain: ${passed} test(s) passed`);
})();
