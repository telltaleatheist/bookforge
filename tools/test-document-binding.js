#!/usr/bin/env node
/**
 * Tests for electron/document-binding.ts and electron/working-document.ts — the
 * two halves of "which stage has run is a fact about the document".
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-document-binding.js
 *
 * ── What is actually being defended ─────────────────────────────────────────
 *
 * The run-directory model this replaces kept pipeline state in a JSON file that
 * could disagree with the artifacts beside it, and did: a failed stage left a
 * record saying a book had output it did not have, and that record then gated
 * export for the rest of the book's life. The document model's claim is that no
 * such disagreement is REPRESENTABLE, because the state is measured off the file.
 *
 * Three properties carry that claim, and each one is a way the old model failed:
 *
 *  1. **A boundary is the file's length**, so "reset to Blocks" is a truncation
 *     that cannot be approximately right. A boundary past the end of the file is
 *     refused, not clamped.
 *  2. **The archive original is re-proved every time.** archive/ is never
 *     written to, so the check should never fire — which is exactly why it is
 *     worth making, because a convention that is never tested is a convention
 *     nobody notices breaking.
 *  3. **A corrupt binding says so.** The m4b reading returns null for both
 *     "absent" and "unreadable"; here they are different answers, because
 *     "absent" sends a caller to run a stage and "unreadable" must not send them
 *     to re-run every model over a working document that is sitting right there.
 *
 * The fixture is a REAL working PDF cast by `foundry scan --pdf` (checked in
 * under tools/fixtures/), so the marker reader is tested against bytes foundry
 * actually wrote rather than against a mock of what it was thought to write.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'document-binding.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const binding = require(path.join(DIST, 'document-binding.js'));
const working = require(path.join(DIST, 'working-document.js'));

const FIXTURE = path.join(REPO, 'tools', 'fixtures', 'document-pipeline');
const WORKING_PDF = path.join(FIXTURE, 'working.pdf');
const ORIGINAL_PDF = path.join(FIXTURE, 'original.pdf');
if (!fs.existsSync(WORKING_PDF) || !fs.existsSync(ORIGINAL_PDF)) {
  console.error(
    `Missing fixtures under ${FIXTURE}. They are a three-page PDF and the working\n`
    + 'document `foundry scan --pdf` casts from it; both are checked in.'
  );
  process.exit(1);
}

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A throwaway project directory laid out the way a real one is. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docbind-'));
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  const primaryRel = 'archive/A Test Book.pdf';
  fs.copyFileSync(ORIGINAL_PDF, path.join(dir, 'archive', 'A Test Book.pdf'));
  const workingAbs = binding.workingDocumentPath(dir, primaryRel);
  fs.copyFileSync(WORKING_PDF, workingAbs);
  return { dir, primaryRel, workingAbs };
}

async function freshBinding(project) {
  return binding.createDocumentBinding({
    projectId: 'a-test-book',
    projectDir: project.dir,
    primaryRelPath: project.primaryRel,
    workingAbsPath: project.workingAbs,
    documentClass: 'text',
    foundryVersion: '0.3.1',
  });
}

// ── names ───────────────────────────────────────────────────────────────────

test('the working document and the book are named after the original', () => {
  assert.strictEqual(binding.originalStem('archive/Kershaw. Hitler. (2008).pdf'), 'Kershaw. Hitler. (2008)');
  assert.strictEqual(
    path.basename(binding.workingDocumentPath('/p', 'archive/Kershaw. Hitler.pdf')),
    'Kershaw. Hitler.working.pdf'
  );
  assert.strictEqual(
    path.basename(binding.documentBindingPath('/p', 'archive/Kershaw. Hitler.pdf')),
    'Kershaw. Hitler.pdf.documents.json'
  );
});

test('the binding sits in the project root, never in archive/', () => {
  const bindingPath = binding.documentBindingPath('/p', 'archive/Book.pdf');
  assert.strictEqual(path.dirname(bindingPath), path.normalize('/p'));
  const workingPath = binding.workingDocumentPath('/p', 'archive/Book.pdf');
  assert.strictEqual(path.dirname(workingPath), path.normalize('/p'));
});

test('a name too long for the filesystem gets the protocol’s hashed tail', () => {
  const long = `archive/${'x'.repeat(400)}.pdf`;
  const name = path.basename(binding.documentBindingPath('/p', long));
  assert.ok(Buffer.byteLength(name) < 255, `name is ${Buffer.byteLength(name)} bytes`);
  // Deterministic: the reader derives the same name the writer did.
  assert.strictEqual(name, path.basename(binding.documentBindingPath('/p', long)));
});

test('a primary that is nothing but an extension is refused rather than named ""', () => {
  // `archive/.pdf` would otherwise produce `.working.pdf` and `.epub` — hidden
  // files on every platform, and two different books colliding on both names.
  assert.throws(() => binding.originalStem('archive/.pdf'), /no filename/);
});

// ── the marker, read off bytes foundry wrote ────────────────────────────────

test('the working document says what class it is and which original it came from', async () => {
  const state = await working.readWorkingDocumentState(WORKING_PDF);
  assert.strictEqual(state.marker.documentClass, 'text');
  assert.strictEqual(state.marker.dpi, 200);
  assert.strictEqual(state.marker.sourceSha256, sha256Of(ORIGINAL_PDF));
  assert.match(state.marker.producer, /^foundry /);
  assert.strictEqual(state.pages.length, 3);
  // scan --pdf writes the marker and reads the text layer; it writes no blocks.
  assert.strictEqual(state.blockCount, 0);
  assert.strictEqual(state.bytes, fs.statSync(WORKING_PDF).size);
});

test('a PDF with no marker is not a working document, and the error says which stage writes one', async () => {
  await assert.rejects(
    () => working.readWorkingDocumentState(ORIGINAL_PDF),
    (err) => err instanceof working.WorkingDocumentError && /carries no foundry marker/.test(err.message)
      && /Get Text/.test(err.message)
  );
});

test('a file that is not a PDF at all is named, not swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docbind-'));
  const junk = path.join(dir, 'not.pdf');
  fs.writeFileSync(junk, 'this is not a PDF');
  await assert.rejects(
    () => working.readWorkingDocumentState(junk),
    (err) => err instanceof working.WorkingDocumentError && err.file === junk
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing working document reports the stage that casts one', async () => {
  await assert.rejects(
    () => working.readWorkingDocumentState(path.join(FIXTURE, 'nope.pdf')),
    (err) => /Get Text stage/.test(err.message)
  );
});

// ── the binding record ──────────────────────────────────────────────────────

test('a fresh cast binds the working document to the archive original', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  assert.strictEqual(record.primary.sha256, sha256Of(path.join(project.dir, 'archive', 'A Test Book.pdf')));
  assert.strictEqual(record.working.sha256, sha256Of(project.workingAbs));
  // The cast is the one full rewrite, so its boundary is the whole file.
  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text']);
  assert.strictEqual(record.boundaries[0].offset, fs.statSync(project.workingAbs).size);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('it round-trips through disk unchanged', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  const file = binding.documentBindingPath(project.dir, project.primaryRel);
  await binding.writeDocumentBinding(file, record);
  assert.deepStrictEqual(binding.readDocumentBinding(file), record);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('no binding is null — that is "Get Text has not run", not a failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docbind-'));
  assert.strictEqual(binding.readDocumentBinding(path.join(dir, 'absent.documents.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CORRUPT binding throws and never comes back as "no binding"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-docbind-'));
  const file = path.join(dir, 'Book.pdf.documents.json');

  fs.writeFileSync(file, '{ this is not json');
  assert.throws(
    () => binding.readDocumentBinding(file),
    (err) => err instanceof binding.DocumentBindingError && /not valid JSON/.test(err.message)
      && /not regenerated behind your back/.test(err.message)
  );

  // Right JSON, wrong shape: a hash that is not a hash cannot prove anything.
  fs.writeFileSync(file, JSON.stringify({
    protocol: 'bookforge-sidecar-binding-v1',
    kind: 'document-pipeline-v1',
    projectId: 'x',
    primary: { path: 'archive/Book.pdf', sha256: 'nope', bytes: 1 },
    working: { path: 'Book.working.pdf', sha256: 'nope', bytes: 1 },
    documentClass: 'text',
    boundaries: [],
  }));
  assert.throws(() => binding.readDocumentBinding(file), binding.DocumentBindingError);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the archive invariant ───────────────────────────────────────────────────

test('an untouched archive original verifies', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  await binding.verifyPrimary(record, project.dir);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('an archive original replaced from outside the app is refused by name', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  // Exactly the case a convention cannot catch: someone re-imported over it.
  fs.writeFileSync(path.join(project.dir, 'archive', 'A Test Book.pdf'), 'different bytes entirely');
  await assert.rejects(
    () => binding.verifyPrimary(record, project.dir),
    (err) => /is not the file this book's documents were built from/.test(err.message)
      && /archive\/ is never written to/.test(err.message)
  );
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('an archive original that has gone missing says so, and does not verify by default', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  fs.rmSync(path.join(project.dir, 'archive', 'A Test Book.pdf'));
  await assert.rejects(() => binding.verifyPrimary(record, project.dir), /could not be read/);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

// ── boundaries ──────────────────────────────────────────────────────────────

/** Append plausible stage bytes, the way an incremental update does. */
function appendUpdate(file, bytes) {
  fs.appendFileSync(file, Buffer.alloc(bytes, 0x25));
}

test('a stage boundary is the file length after it, measured not claimed', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  const castOffset = record.boundaries[0].offset;

  appendUpdate(project.workingAbs, 512);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });

  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text', 'blocks']);
  assert.strictEqual(record.boundaries[1].offset, castOffset + 512);
  assert.strictEqual(record.working.bytes, castOffset + 512);
  assert.strictEqual(record.working.sha256, sha256Of(project.workingAbs));
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('re-running a stage drops every boundary after it', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  appendUpdate(project.workingAbs, 100);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  appendUpdate(project.workingAbs, 100);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'footnotes', foundryVersion: '0.3.1',
  });
  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text', 'blocks', 'footnotes']);

  // Blocks again: the footnotes pass was applied on top of the OLD block layer,
  // so its offset names bytes that no longer mean the same thing.
  appendUpdate(project.workingAbs, 100);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text', 'blocks']);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('a stage that left the document SHORTER records nothing and says why', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  appendUpdate(project.workingAbs, 512);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  // A stage only ever appends. A shorter file is a different document.
  fs.truncateSync(project.workingAbs, 10);
  await assert.rejects(
    () => binding.recordStageBoundary({
      binding: record, projectDir: project.dir, stage: 'footnotes', foundryVersion: '0.3.1',
    }),
    /SHORTER than the blocks boundary/
  );
  fs.rmSync(project.dir, { recursive: true, force: true });
});

// ── reset ───────────────────────────────────────────────────────────────────

test('reset to a stage truncates to that exact byte and the document is still a PDF', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  const castOffset = record.boundaries[0].offset;
  const castBytes = fs.readFileSync(project.workingAbs);

  appendUpdate(project.workingAbs, 4096);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });

  record = await binding.resetToStage({ binding: record, projectDir: project.dir, target: 'get-text' });
  assert.strictEqual(fs.statSync(project.workingAbs).size, castOffset);
  // Byte-for-byte the document as it stood when that stage finished.
  assert.ok(fs.readFileSync(project.workingAbs).equals(castBytes));
  assert.deepStrictEqual(record.boundaries.map((b) => b.stage), ['get-text']);
  // …and it still opens.
  const state = await working.readWorkingDocumentState(project.workingAbs);
  assert.strictEqual(state.marker.documentClass, 'text');
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('reset drops the book too — it was built from bytes that are gone', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  const epub = path.join(project.dir, 'A Test Book.epub');
  fs.writeFileSync(epub, 'PK pretend epub');
  record = await binding.recordExportedEpub(record, project.dir, epub);
  assert.ok(record.epub);

  appendUpdate(project.workingAbs, 64);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  record = await binding.resetToStage({ binding: record, projectDir: project.dir, target: 'get-text' });
  assert.strictEqual(record.epub, undefined);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('resetting past Get Text removes the working document outright', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  record = await binding.resetToStage({ binding: record, projectDir: project.dir, target: 'none' });
  assert.ok(!fs.existsSync(project.workingAbs));
  assert.deepStrictEqual(record.boundaries, []);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('resetting to a stage that never ran is refused, and names the ones that did', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  await assert.rejects(
    () => binding.resetToStage({ binding: record, projectDir: project.dir, target: 'blocks' }),
    /no recorded blocks boundary/
  );
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('a boundary past the end of the file is refused, never clamped', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  appendUpdate(project.workingAbs, 200);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  // A boundary recorded against a different document.
  fs.truncateSync(project.workingAbs, record.boundaries[0].offset - 1);
  await assert.rejects(
    () => binding.resetToStage({ binding: record, projectDir: project.dir, target: 'blocks' }),
    /recorded against a different document/
  );
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('a record overclaiming after an interrupted reset is brought back to the file', async () => {
  const project = makeProject();
  let record = await freshBinding(project);
  appendUpdate(project.workingAbs, 300);
  record = await binding.recordStageBoundary({
    binding: record, projectDir: project.dir, stage: 'blocks', foundryVersion: '0.3.1',
  });
  // Crash between the truncate and the rewrite: the file was cut, the record was not.
  fs.truncateSync(project.workingAbs, record.boundaries[0].offset);
  const { binding: healed, dropped } = binding.reconcileBoundaries(
    record, fs.statSync(project.workingAbs).size
  );
  assert.deepStrictEqual(dropped.map((d) => d.stage), ['blocks']);
  assert.deepStrictEqual(healed.boundaries.map((b) => b.stage), ['get-text']);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('a record that matches the file is left exactly as it is', async () => {
  const project = makeProject();
  const record = await freshBinding(project);
  const { binding: same, dropped } = binding.reconcileBoundaries(
    record, fs.statSync(project.workingAbs).size
  );
  assert.strictEqual(same, record);
  assert.deepStrictEqual(dropped, []);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test('a document outside the project cannot be recorded in its binding', () => {
  assert.throws(
    () => binding.toProjectRelative(path.join('/projects', 'book'), path.join('/elsewhere', 'x.pdf')),
    /is not inside the project/
  );
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
  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`document-binding: ${passed} test(s) passed`);
})();
