#!/usr/bin/env node
/**
 * The pieces behind "Narrate on a pending export" (Owen, 2026-09-07) that can be
 * held without a library: the landing-announcement wait, the version lookup, and
 * the run description's one relaxed refusal.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-export-landing.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIST = path.join(path.resolve(__dirname, '..'), 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'foundry-landing-wait.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// The step module reaches for manifest-service, which reaches for electron:
// the same stub cli/library.js runs under.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bf-landing-step-ud-'));
}
require(path.join(path.resolve(__dirname, '..'), 'cli', 'electron-stub.js'));
const sweep = require(path.join(DIST, 'electron', 'foundry-landing-wait.js'));
const landingStep = require(path.join(DIST, 'electron', 'queue-steps', 'foundry-export-landing.js')).foundryExportLandingStep;
const landing = sweep;
const run = require(path.join(DIST, 'shared', 'queue', 'narration-run.js'));

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  await test('a wait started BEFORE the announcement resolves once the recording settles', async () => {
    let done = false;
    const waited = sweep.awaitFoundryLandingRecorded('proj-a', 'Book.epub', new AbortController().signal)
      .then(() => { done = true; });
    await tick();
    assert.strictEqual(done, false, 'nothing announced yet');
    let settle;
    sweep.noteFoundryLandingAnnounced('proj-a', 'book.EPUB', new Promise((r) => { settle = r; }));
    await tick();
    assert.strictEqual(done, false, 'announced but not yet recorded');
    settle('variant-1');
    await waited;
    assert.strictEqual(done, true);
  });

  await test('a wait started AFTER the announcement resolves with the recording, and a FAILED recording still settles it', async () => {
    let reject;
    sweep.noteFoundryLandingAnnounced('proj-b', 'x.epub', new Promise((_r, rej) => { reject = rej; }));
    let done = false;
    const waited = sweep.awaitFoundryLandingRecorded('proj-b', 'X.epub', new AbortController().signal)
      .then(() => { done = true; });
    await tick();
    assert.strictEqual(done, false);
    reject(new Error('the manifest could not be written'));
    await waited;
    assert.strictEqual(done, true, 'a failed filing is a settled wait — the step then finds no version and refuses by name');
  });

  await test('the wait rejects on the abort signal and nothing else', async () => {
    const ac = new AbortController();
    const waited = sweep.awaitFoundryLandingRecorded('proj-c', 'y.epub', ac.signal);
    ac.abort();
    await assert.rejects(waited, /Stopped/);
  });

  await test('the version lookup matches on project key + file name (case-insensitive), epub only, live over kept', () => {
    const v = (id, src, format = 'epub', kept = false) => ({
      id, kind: 'text', format, path: `archive/${id}.${format}`, metadata: {}, addedAt: 't',
      ...(kept ? { promotedFrom: src } : { foundrySource: src }),
    });
    const variants = [
      v('other', { projectKey: 'k', fileName: 'Other.epub', parentVariantId: null, landedAt: 't' }),
      v('kept', { projectKey: 'k', fileName: 'Book.epub', parentVariantId: null, landedAt: 't' }, 'epub', true),
      v('live', { projectKey: 'k', fileName: 'book.epub', parentVariantId: null, landedAt: 't' }),
      v('pdf', { projectKey: 'k', fileName: 'Book.pdf', parentVariantId: null, landedAt: 't' }, 'pdf'),
      { id: 'archive', kind: 'text', format: 'epub', path: 'archive/a.epub', metadata: {}, addedAt: 't' },
    ];
    assert.strictEqual(landing.findLandedExport(variants, 'k', 'BOOK.EPUB').id, 'live');
    assert.strictEqual(landing.findLandedExport(variants.filter((x) => x.id !== 'live'), 'k', 'book.epub').id, 'kept');
    assert.strictEqual(landing.findLandedExport(variants, 'k', 'nope.epub'), null);
    assert.strictEqual(landing.findLandedExport(variants, 'other-key', 'book.epub'), null);
  });

  await test('the run description admits an EMPTY version only when a landing step is named', () => {
    // 'higgs' — BookForge's PICKER id, which is the only spelling a
    // `NarrationRunSettings` ever carries (the modal's engine signal is one).
    // This fixture said 'higgs-v3', narrator's model-generation spelling, and
    // passed only because the coverage table aliased the two; the run
    // description now asks the ENGINE table, which knows what this build renders
    // and refuses anything else by name.
    const settings = { language: 'en', ttsEngine: 'higgs', voice: 'deathstalker', device: 'auto', speed: 1,
      workers: 1, textCleanup: 'required', rvc: null, finalDenoise: false, sentenceGap: 0,
      alignDevice: 'cpu' };
    const book = { epubPath: 'Z:\\p\\final\\Book.epub', projectDir: 'Z:\\lib\\Book', variantId: '',
      title: 'Book', author: 'A', year: '', coverPath: '', outputFilename: 'Book.m4b', isArticle: false };
    assert.throws(() => run.requireNarrationRun(book, settings), /which version/);
    run.requireNarrationRun({ ...book, landing: { jobId: 'job_1', stepId: 'step_1' } }, settings);
    assert.throws(() => run.requireNarrationRun({ ...book, landing: { jobId: '', stepId: 'step_1' } }, settings),
      /does not name the step/);
    const plan = run.narrationTtsStep({ ...book, landing: { jobId: 'job_1', stepId: 'step_1' } }, settings, false);
    assert.strictEqual(plan.type, 'tts-conversion');
    // The sourceRef it states is dropped by the append (the parent's artifact wins);
    // stating the file it will be is not a lookup.
    assert.strictEqual(plan.sourceRef.path, book.epubPath);
  });

  await test('AN IMPLIED EXPORT: the landing step waits for the FILE, not a version record (Owen, 2026-09-08)', async () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-implied-'));
    const epub = path.join(dir, 'Book. Author. (2001).epub');
    const reports = [];
    const ctx = (config) => ({
      step: { config }, stepId: 'step_x', job: {}, signal: new AbortController().signal,
      report: (r) => reports.push(r), input: null,
    });
    // Not there, and nobody in this process is making it: refused by name, and the
    // sentence says WHY nothing is coming rather than blaming the file.
    await assert.rejects(
      landingStep.run(ctx({ bookDir: dir, projectKey: 'k', fileName: path.basename(epub), unfiledPath: epub })),
      /nothing in this app is making it/);
    fs.writeFileSync(epub, 'EPUB');
    const out = await landingStep.run(ctx({ bookDir: dir, projectKey: 'k', fileName: path.basename(epub), unfiledPath: epub, forStep: 's1' }));
    assert.strictEqual(out.kind, 'epub');
    assert.strictEqual(out.path, epub);
    assert.deepStrictEqual(out.detail, { projectDir: dir, forStep: 's1' });
    assert.ok(reports.some((r) => r.percent === 100), 'the step reports done');
    // A relative path is a composition error, said before anything is looked at.
    await assert.rejects(
      landingStep.run(ctx({ bookDir: dir, projectKey: 'k', fileName: 'x.epub', unfiledPath: 'relative/x.epub' })),
      /not an absolute path/);
  });

  await test('THE LANDING STEP AWAITS FOUNDRY\'S OWN PROMISE — the export is on their queue, never ours', async () => {
    const os = require('os');
    const wait = require(path.join(DIST, 'electron', 'foundry-landing-wait.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-implied-wait-'));
    const epub = path.join(dir, 'Held. Author. (2001).epub');
    const ctx = (config) => ({
      step: { config }, stepId: 's', job: {}, signal: new AbortController().signal,
      report: () => {}, input: null,
    });
    // Held and settling late: the step waits for the promise, not for a poll.
    let settle;
    wait.noteImpliedExportOrdered(epub, new Promise((r) => { settle = r; }));
    const running = landingStep.run(ctx({ bookDir: dir, projectKey: 'k', fileName: path.basename(epub), unfiledPath: epub }));
    let done = false;
    void running.then(() => { done = true; }, () => { done = true; });
    await tick();
    assert.strictEqual(done, false, 'it is still waiting on the promise');
    fs.writeFileSync(epub, 'EPUB');
    settle({ path: epub, unfiled: true });
    const out = await running;
    assert.strictEqual(out.path, epub);

    // A FAILED export rejects the wait with the engine's own sentence.
    const bad = path.join(dir, 'Bad. Author. (2001).epub');
    wait.noteImpliedExportOrdered(bad, Promise.reject(new Error('the model is not pulled')));
    await assert.rejects(
      landingStep.run(ctx({ bookDir: dir, projectKey: 'k', fileName: path.basename(bad), unfiledPath: bad })),
      /the model is not pulled/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('THE IMPLIED-EXPORT PATH: minted top-level in scratch as implied-<id>/<book>.epub, and recognised back; sessions and versions are not', () => {
    const os = require('os');
    const np = require(path.join(DIST, 'electron', 'narrator-paths.js'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-scratch-'));
    try {
      np.setNarratorScratchRoot(root);
      const minted = np.mintImpliedExportPath('Book. Author. (2001).epub');
      assert.strictEqual(path.dirname(path.dirname(minted)), root, 'top level in the scratch root - the sweep decides by top-level name');
      assert.ok(path.basename(path.dirname(minted)).startsWith(np.IMPLIED_EXPORT_PREFIX));
      assert.ok(fs.existsSync(path.dirname(minted)), 'the folder is made; the file is not');
      assert.ok(!fs.existsSync(minted));
      assert.strictEqual(np.impliedExportDirOf(minted), path.dirname(minted));
      assert.strictEqual(np.impliedExportDirOf(path.join(root, 'ebook-123', 'abc', 'book.epub')), null, 'a session is not an implied export');
      assert.strictEqual(np.impliedExportDirOf(path.join(root, '..', 'projects', 'x', 'output', 'y.epub')), null, 'a version is not');
      assert.strictEqual(np.impliedExportDirOf(root), null, 'the root itself is not');
      assert.throws(() => np.mintImpliedExportPath('book.txt'), /one EPUB file name/);
      assert.throws(() => np.mintImpliedExportPath('a/b.epub'), /one EPUB file name/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(failures.length === 0
    ? `\nfoundry-export-landing: ${passed}/${passed} passed`
    : `\nFAILED  foundry-export-landing: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
