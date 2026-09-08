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
const sweep = require(path.join(DIST, 'electron', 'foundry-landing-wait.js'));
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

  console.log(failures.length === 0
    ? `\nfoundry-export-landing: ${passed}/${passed} passed`
    : `\nFAILED  foundry-export-landing: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
