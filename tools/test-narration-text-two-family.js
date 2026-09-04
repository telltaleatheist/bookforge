#!/usr/bin/env node
/**
 * test-narration-text-two-family.js — the narration text cleanup on a project
 * that holds TWO book chains, end to end, on files, with no GPU.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-text-two-family.js
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * The second adversarial review of 2026-09-04 found the family id was resolved
 * by the planner and then dropped by everything downstream of it:
 * `readExportEpub(projectDir)` and `readAppliedPasses(projectDir)` at plan time,
 * and `verifyNarrationCarry` / `replaceBookEpub` / `appendAppliedPass` /
 * `registerLedgerPass` after the model pass. `familyForListing` refuses to guess
 * between two chains, so "Clean text…" and "Run cleanup, then narrate" both died
 * — at plan time before the fix, and (had only the plan been fixed) at the most
 * expensive moment in the run after it.
 *
 * None of the other suites could see it: every one of them builds a project with
 * exactly one chain, where the resolvers guess correctly by having nothing to
 * guess between. So this one builds two, presses the button on the SECOND, and
 * follows the whole act through to the artifact a chained narration would read.
 *
 * The model is stubbed by replacing the runner module's exports in
 * `require.cache` before the pass loads it — the pass reaches it through a
 * dynamic import at call time, so the stub is what it gets, and production keeps
 * no test-only seam.
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'processing-passes.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narration-text-2fam-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

// The same shim `node --require ./cli/electron-stub.js` installs for the real
// headless doors: the pass reaches `app.getPath` and `app.isPackaged` through
// tool-paths on its way to the prompt, and there is no Electron here.
require(path.join(REPO, 'cli', 'electron-stub.js'));

const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));

// ── The model, stubbed before anything loads it ─────────────────────────────
const RUNNER_MODULE = require.resolve(path.join(DIST, 'electron', 'tts-number-normalizer-runner.js'));
require(RUNNER_MODULE);
const modelCalls = [];
require.cache[RUNNER_MODULE].exports.numberNormalizerModel = () => 'fake:1b';
require.cache[RUNNER_MODULE].exports.createOllamaNormalizerRunner = () => ({
  model: 'fake:1b',
  pinContextTo() { /* no window to size */ },
  async generate(input) { modelCalls.push(input); return '{"edits": []}'; },
  async release() { /* nothing resident */ },
});

const processingChain = require(path.join(DIST, 'electron', 'processing-chain.js'));
const processingPasses = require(path.join(DIST, 'electron', 'processing-passes.js'));
const narrationTextPass = require(path.join(DIST, 'electron', 'narration-text-pass.js'));
const queueEngine = require(path.join(DIST, 'electron', 'queue-engine.js'));
const { narrationTextStep } = require(path.join(DIST, 'electron', 'queue-steps', 'pass.js'));

manifestService.setLibraryBasePath(ROOT);
const projectsDir = path.join(ROOT, 'projects');

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const familiesOf = (dir) => readManifest(dir).families ?? [];

/** A REAL EPUB whose one chapter says `marker` and prints something to clean. */
async function writeBook(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = String(marker);
  const id = crypto.createHash('sha256').update(text).digest('hex');
  const opf = '<?xml version="1.0" encoding="utf-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="i">urn:uuid:${id}</dc:identifier>`
    + '<dc:title>A Book</dc:title><dc:language>en</dc:language></metadata>'
    + '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    + '</manifest><spine><itemref idref="c1"/></spine></package>';
  const container = '<?xml version="1.0" encoding="utf-8"?>'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
    + 'media-type="application/oebps-package+xml"/></rootfiles></container>';
  const nav = '<?xml version="1.0" encoding="utf-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    + '<head><title>nav</title></head><body><nav epub:type="toc"><ol>'
    + '<li><a href="ch1.xhtml">One</a></li></ol></nav></body></html>';
  // Curly quotes and a scripture reference, so the pass has real work to do and
  // the two chains' books come out visibly different from each other.
  const chapter = '<?xml version="1.0" encoding="utf-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>'
    + `<p data-bf-cat="text">“${text}” he said, reading Col. 3:19-4:1 aloud.</p>`
    + '</body></html>';
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zip.addFile('OEBPS/ch1.xhtml', Buffer.from(chapter, 'utf8'));
  await zip.write(file);
  return file;
}

/** A project with ONE archive EPUB and the chain minted off it. */
async function makeProject(id) {
  const dir = path.join(projectsDir, id);
  await writeBook(path.join(dir, 'archive', 'First Edition.epub'), 'the first edition');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    modifiedAt: '2026-09-01T00:00:00.000Z',
    metadata: { title: 'A Book' },
    source: { type: 'epub', originalFilename: 'First Edition.epub' },
    archive: [{ path: 'archive/First Edition.epub', role: 'original', format: 'epub' }],
  }, null, 2), 'utf8');
  await manifestService.ensureBookFamilies(dir);
  return dir;
}

/** The text of a book's one chapter, as the narration walk reads it. */
async function chapterText(bookPath) {
  const { readNarrationNumberTargets } = require(path.join(DIST, 'electron', 'epub-processor.js'));
  const targets = await readNarrationNumberTargets(bookPath);
  const unit = targets.find((t) => t.kind === 'unit');
  assert.ok(unit !== undefined, `no unit in ${bookPath}`);
  return unit.text;
}

test('a project with two archive EPUBs has two chains', async () => {
  dir = await makeProject('two-chains');
  assert.strictEqual(familiesOf(dir).length, 1, 'the first chain is minted from the archive');

  const secondArchive = path.join(dir, 'archive', 'Second Edition.epub');
  await writeBook(secondArchive, 'the second edition');
  await manifestService.addBookFamily(dir, { absPath: secondArchive, kind: 'archive-epub' });

  const families = familiesOf(dir);
  assert.strictEqual(families.length, 2, 'and the second edition has one of its own');
  [first, second] = families;
  assert.notStrictEqual(first.id, second.id);
});

test('the resolvers REFUSE to guess between them — which is what made this a bug', async () => {
  // The refusal is correct and is not what changed. What changed is that the
  // pass no longer asks a question with no answer.
  await assert.rejects(
    () => manifestService.readAppliedPasses(dir),
    (err) => /version/i.test(err.message),
    'a family-less read of a two-chain project refuses by name');
});

test('the PLAN names the chain the pressed file belongs to', async () => {
  // Before the fix this threw: the planner resolved the family and then asked
  // `readExportEpub(projectDir)` and `readAppliedPasses(projectDir)` without it.
  const book = await manifestService.ensureBookEpub(dir, second.id);
  const plan = await processingChain.planProcessingChain({
    projectDir: dir,
    sourcePath: book.absPath,
    passes: [{ kind: 'narration-text' }],
  });
  assert.strictEqual(plan.jobs.length, 1);
  assert.strictEqual(plan.jobs[0].jobType, 'narration-text');
  assert.strictEqual(plan.jobs[0].config.familyId, second.id,
    'the config carries the SECOND chain, which is the one the button was pressed on');
  assert.strictEqual(plan.bookEpubPath, book.absPath);
});

test('the pass runs on THAT chain, end to end, and leaves the other alone', async () => {
  const firstBookBefore = await manifestService.ensureBookEpub(dir, first.id);
  const beforeText = await chapterText(firstBookBefore.absPath);

  const secondBook = await manifestService.ensureBookEpub(dir, second.id);
  const plan = await processingChain.planProcessingChain({
    projectDir: dir,
    sourcePath: secondBook.absPath,
    passes: [{ kind: 'narration-text' }],
  });
  const result = await processingPasses.runProcessingPass('test-2fam', plan.jobs[0].config, null);
  assert.ok(result.success, result.error);

  // 1. The pressed chain's book is cleaned: curly quotes canonical, the
  //    scripture reference read, and it is stamped.
  const cleaned = await chapterText(result.outputPath);
  assert.ok(cleaned.startsWith('"the second edition"'), cleaned);
  assert.ok(cleaned.includes('Colossians three nineteen through four one'), cleaned);
  const gate = await narrationTextPass.narrationTextGate(result.outputPath);
  assert.strictEqual(gate.ok, true, JSON.stringify(gate));

  // 2. The OTHER chain's book is untouched, text for text.
  const firstBookAfter = await manifestService.ensureBookEpub(dir, first.id);
  assert.strictEqual(await chapterText(firstBookAfter.absPath), beforeText,
    'the first chain was not read, written, or stamped');
  assert.strictEqual((await narrationTextPass.narrationTextGate(firstBookAfter.absPath)).ok, false);

  // 3. The record lands on the pressed chain and NOWHERE else.
  const after = familiesOf(dir);
  const pressed = after.find((f) => f.id === second.id);
  const other = after.find((f) => f.id === first.id);
  assert.strictEqual((pressed.epub?.appliedPasses ?? []).length, 1);
  assert.strictEqual(pressed.epub.appliedPasses[0].kind, 'narration-text');
  assert.strictEqual((other.epub?.appliedPasses ?? []).length, 0,
    'the other chain records nothing');
  assert.strictEqual((await manifestService.readAppliedPasses(dir, second.id)).length, 1);
  assert.strictEqual((await manifestService.readAppliedPasses(dir, first.id)).length, 0);

  // 4. The ledger row is on the pressed chain too.
  const ledger = await manifestService.readBookLedger(dir, second.id);
  assert.strictEqual(ledger.length, 1, JSON.stringify(ledger));
  assert.strictEqual(ledger[0].kind, 'narration-text');
  assert.strictEqual((await manifestService.readBookLedger(dir, first.id)).length, 0);

  // 5. And the artifact a chained narration reads is the pressed chain's
  //    REGENERATED narration copy — not the book, and not the other chain's.
  assert.ok(result.narrationInputPath, 'the pass names what a narration step reads');
  assert.notStrictEqual(result.narrationInputPath, result.outputPath,
    'which is the narration copy, not the book');
  const ttsRecorded = familiesOf(dir).find((f) => f.id === second.id).ttsEpub?.path;
  assert.ok(ttsRecorded, 'and the manifest records it on this chain');
  assert.strictEqual(
    path.resolve(result.narrationInputPath),
    path.resolve(path.join(dir, ttsRecorded.split('/').join(path.sep))));
  assert.strictEqual((await narrationTextPass.narrationTextGate(result.narrationInputPath)).ok,
    true, 'and the copy carries the stamp, so the render door takes it');
});

test('a second run on the same chain does nothing, and still names the copy to narrate', async () => {
  const book = await manifestService.ensureBookEpub(dir, second.id);
  const plan = await processingChain.planProcessingChain({
    projectDir: dir,
    sourcePath: book.absPath,
    passes: [{ kind: 'narration-text' }],
  });
  const again = await processingPasses.runProcessingPass('test-2fam-2', plan.jobs[0].config, null);
  // SUCCESS, not a failure: work is chained behind this pass, and a failed step
  // takes the run with it (the first review's Finding 3).
  assert.ok(again.success, again.error);
  assert.ok(again.summary.includes('already been through'), again.summary);
  // And the narration copy is still named, so the chained step does not fall
  // back to the raw book and read every passage the user struck out.
  assert.ok(again.narrationInputPath, 'the no-op exit names it too');
  assert.notStrictEqual(again.narrationInputPath, again.outputPath);
  // Nothing was recorded twice.
  assert.strictEqual((await manifestService.readAppliedPasses(dir, second.id)).length, 1);
  assert.strictEqual((await manifestService.readBookLedger(dir, second.id)).length, 1);
});

/**
 * THE REAL PATH: `processing:submit-chain`'s composition, the queue engine, and
 * `queue-steps/pass.ts` — not `runProcessingPass` called by hand.
 *
 * The third adversarial review asked for this because the whole of Finding 4 is
 * about what the QUEUE hands a chained step, and a test that calls the pass
 * directly cannot see it: the artifact resolution, the `parentIndex` chaining
 * and the step module's choice of `narrationInputPath` all live between them.
 */
test('a chained narration reads the copy the PASS named, through the real queue', async () => {
  const book = await manifestService.ensureBookEpub(dir, second.id);
  const plan = await processingChain.planProcessingChain({
    projectDir: dir,
    sourcePath: book.absPath,
    passes: [{ kind: 'narration-text' }],
  });

  // The follow-on the narration modal builds, with the file it would have set.
  const narrated = [];
  queueEngine.clearStepModules();
  queueEngine.registerStepModule(narrationTextStep);
  queueEngine.registerStepModule({
    type: 'tts-conversion',
    consumes: 'epub',
    produces: 'audio',
    resource: () => 'gpu',
    async run(ctx) {
      narrated.push(ctx.input.path);
      return { kind: 'audio', path: `${ctx.input.path}.wav` };
    },
    cancel() { /* nothing to stop */ },
  });
  queueEngine.setGpuLockProbe(() => null);
  queueEngine.setGpuHolderProbe(() => null);
  await queueEngine.configure({ stateDir: path.join(ROOT, 'queue-state') });

  // Composed exactly as `processing:submit-chain` composes it: the pass first
  // with the book as its sourceRef, the follow-on chained to it by parentIndex.
  const steps = [
    {
      type: plan.jobs[0].jobType,
      label: plan.jobs[0].label,
      config: plan.jobs[0].config,
      sourceRef: { kind: 'epub', path: plan.bookEpubPath },
    },
    {
      type: 'tts-conversion',
      label: 'Narrate',
      config: { epubPath: '/a/stale/export.epub' },
      parentIndex: 0,
    },
  ];
  const job = queueEngine.enqueue({
    title: plan.title, projectId: dir, documentPath: plan.bookEpubPath, steps,
  });
  queueEngine.start();

  const deadline = Date.now() + 120000;
  for (;;) {
    const live = queueEngine.snapshot().jobs.find((j) => j.id === job.id);
    const done = live && live.steps.every((st) => st.status === 'done' || st.status === 'failed');
    if (done) {
      const failed = live.steps.filter((st) => st.status === 'failed');
      assert.strictEqual(failed.length, 0,
        failed.map((st) => `${st.type}: ${st.error}`).join('; '));
      break;
    }
    assert.ok(Date.now() < deadline, 'the run finished within two minutes');
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.strictEqual(narrated.length, 1, 'the narration step ran exactly once');
  // NOT the stale path its own config carried, and NOT the book: the narration
  // copy the pass re-cut from the book it had just written.
  assert.notStrictEqual(narrated[0], '/a/stale/export.epub');
  const ttsRecorded = familiesOf(dir).find((f) => f.id === second.id).ttsEpub.path;
  assert.strictEqual(
    path.resolve(narrated[0]),
    path.resolve(path.join(dir, ttsRecorded.split('/').join(path.sep))),
    'the chained step read the regenerated narration copy of the pressed chain');
  assert.strictEqual((await narrationTextPass.narrationTextGate(narrated[0])).ok, true);
  await queueEngine.pause();
});
/**
 * THE READINESS DOOR'S OWN BRANCHES.
 *
 * `narrationTextReadinessFor` is the whole body of the `narration:text-readiness`
 * IPC — the handler is a one-line call to it — so these exercise what the button
 * actually asks, not the pure helper underneath it.
 */
test('the readiness door: MANY chains, and a version that names none of them', async () => {
  const readiness = require(path.join(DIST, 'electron', 'narration-text-readiness.js'));
  const stray = path.join(dir, 'archive', 'Some Other File.epub');
  await writeBook(stray, 'a file no chain records');

  const answer = await readiness.narrationTextReadinessFor(dir, stray);
  assert.strictEqual(answer.success, true, 'it answers rather than throwing');
  assert.strictEqual(answer.readiness, null, 'no chain can be named');
  assert.strictEqual(answer.familyId, null);
  assert.ok(answer.familyNote.includes('more than one book chain'), answer.familyNote);
  // And the FILE's own answer stands, which is what keeps the button pressable.
  assert.strictEqual(answer.fileState.ok, false);
  assert.strictEqual(answer.fileState.state, 'missing');
});

test('the readiness door: a chain that CAN be named answers from the ledger', async () => {
  const readiness = require(path.join(DIST, 'electron', 'narration-text-readiness.js'));
  const book = await manifestService.ensureBookEpub(dir, second.id);
  const answer = await readiness.narrationTextReadinessFor(dir, book.absPath);
  assert.strictEqual(answer.familyId, second.id);
  assert.strictEqual(answer.readiness.ok, true, JSON.stringify(answer.readiness));
  assert.strictEqual(path.resolve(answer.bookPath), path.resolve(book.absPath));

  // The OTHER chain has not been cleaned, and says so.
  const other = await manifestService.ensureBookEpub(dir, first.id);
  const otherAnswer = await readiness.narrationTextReadinessFor(dir, other.absPath);
  assert.strictEqual(otherAnswer.familyId, first.id);
  assert.strictEqual(otherAnswer.readiness.ok, false);
  assert.strictEqual(otherAnswer.readiness.state, 'missing');
});

test('the readiness door: ZERO chains is MISSING, not the many-chain refusal', async () => {
  // `familyForOpen` answers null for a project with no chain as well as for one
  // with several, and calling both "more than one book chain" sent a project
  // that has simply never been opened down the path that offers nothing (the
  // second adversarial review, 2026-09-04).
  const readiness = require(path.join(DIST, 'electron', 'narration-text-readiness.js'));
  const bare = path.join(projectsDir, 'no-chains');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    projectId: 'no-chains',
    createdAt: '2026-09-01T00:00:00.000Z',
    modifiedAt: '2026-09-01T00:00:00.000Z',
    metadata: { title: 'Nothing Yet' },
    source: { type: 'pdf', originalFilename: 'Nothing Yet.pdf' },
    archive: [{ path: 'archive/Nothing Yet.pdf', role: 'original', format: 'pdf' }],
    families: [],
  }, null, 2), 'utf8');

  const answer = await readiness.narrationTextReadinessFor(bare, undefined);
  assert.strictEqual(answer.success, true);
  assert.ok(answer.readiness !== null, 'a project with no chain gets an ANSWER, not a refusal');
  assert.strictEqual(answer.readiness.ok, false);
  assert.strictEqual(answer.readiness.state, 'missing',
    'so the Narrate gate offers the cleanup rather than showing nothing');
  assert.strictEqual(answer.familyNote, undefined, 'and it is not called a many-chain project');
});


// ─────────────────────────────────────────────────────────────────────────────

let dir;
let first;
let second;


// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${String(err && err.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures.length === 0 ? 0 : 1);
})();
