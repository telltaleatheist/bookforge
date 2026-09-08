#!/usr/bin/env node
/**
 * Tests for THE SHAPE OF A NARRATION RUN (shared/queue/narration-run.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-chain.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen's ruling of 2026-08-29 turned one enhancement pass into two, in an order
 * the user picks. That makes FOUR enhancement shapes where there was one, and the
 * things that can go wrong in them are all silent:
 *
 *  - the inter-sentence gap must be applied EXACTLY ONCE, on RAW sentences, by
 *    whichever pass touches them first. A gap applied twice pads every sentence
 *    twice; a gap applied to already-enhanced audio does nothing at all, because
 *    the exactly-zero pad it detects is gone. Neither reads as an error — you
 *    hear it, an hour later, in the finished book.
 *  - the conversion must NOT carry `finalDenoise` any more. If it did, the job
 *    would refuse the row, and the user would have spent a narration getting
 *    there.
 *  - the assembly must stop stating a gap the moment anything upstream bakes one,
 *    or one knob is answered in two places.
 *  - and a run that converts sentences it did not render must file as a SECOND
 *    audiobook, because filing it as the first destroys the original.
 *
 * Every one of those is a pure function of the settings and the stages, which is
 * exactly what this file drives — no queue, no disk, no Electron.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'narration-run.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  buildNarrationSteps,
  narrationEnhancementPasses,
  requireCoverageAligner,
  requireNarrationStages,
} = require(MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

const BOOK = {
  epubPath: 'E:/lib/projects/Twain-a1b2/exports/book.epub',
  projectDir: 'E:/lib/projects/Twain-a1b2',
  variantId: 'v-7',
  title: 'Roughing It',
  author: 'Mark Twain',
  year: '1872',
  coverPath: '',
  outputFilename: 'Roughing It.m4b',
  isArticle: false,
};

const RVC = {
  voiceId: 'deathstalker-sigma',
  indexRate: 0.3,
  protectRate: 0.1,
  nSemitones: -2,
};

/** Settings with the enhancement dials set however this case needs them. */
function settings(over = {}) {
  return Object.assign({
    language: 'en',
    // The cleanup is a question with three answers (9e1baa00): a run states it.
    textCleanup: 'required',
    ttsEngine: 'orpheus',
    voice: 'leah',
    device: 'gpu',
    temperature: 0.6,
    topP: 0.9,
    repetitionPenalty: 1.1,
    speed: 1,
    workers: 1,
    outputDir: 'E:/audiobooks',
    finalDenoise: false,
    enhancementOrder: 'denoise-first',
    applyDeRing: false,
    rvc: null,
    startFresh: false,
    // STATED, because the description refuses a run that cannot say it — and it
    // was missing here, which had this whole file failing 17 of its 22 cases
    // against a refusal that has nothing to do with what it tests. 'required' is
    // the ordinary answer: the book's stamp decides.
    textCleanup: 'required',
  }, over);
}

/*
 * `align` DEFAULTS TO FALSE HERE and is ticked by the cases that are about it.
 *
 * The dialog opens with it TICKED (Owen, 2026-09-07) — that default belongs to
 * the modal, not to the description, and pinning it here would make every one of
 * the enhancement-shape cases below carry an align row it is not testing.
 */
const stages = (over = {}) =>
  Object.assign({ narrate: true, enhance: false, assemble: true, align: false }, over);

/** The step types of a run, in order — the shape, said in one line. */
const shapeOf = (steps) => steps.map((s) => s.type);
const find = (steps, type) => steps.find((s) => s.type === type);

// ── the four shapes ─────────────────────────────────────────────────────────

test('NEITHER PASS: narrate → assemble, and the assembly owns the gap', () => {
  const steps = buildNarrationSteps(BOOK, settings({ sentenceGap: 0.4 }), stages());
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'reassembly']);
  assert.strictEqual(find(steps, 'reassembly').config.sentenceGap, 0.4,
    'nothing upstream bakes it, so the assembly states it');
});

test('DENOISE ONLY: narrate → denoise → assemble, gap on the denoise', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'final-denoise', 'reassembly']);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false,
    'the assembly is handed a set the gap is already in');
});

test('RVC ONLY: narrate → convert → assemble, and THE CONVERSION owns the gap', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'rvc-enhancement', 'reassembly']);
  // The case the split fixed: with no denoise in the run, nothing used to apply
  // the gap at all — the assembly skipped it because "rvc bakes it" and the rvc
  // job only ran a gap pass as part of a denoise it was no longer doing.
  assert.strictEqual(find(steps, 'rvc-enhancement').config.sentenceGap, 0.4);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false);
});

test('BOTH, default order: narrate → denoise → convert → assemble', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({ finalDenoise: true, rvc: RVC, sentenceGap: 0.4 }),
    stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'final-denoise', 'rvc-enhancement', 'reassembly']);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4,
    'the denoise is first, so it reads the raw sentences and bakes the gap');
  assert.strictEqual('sentenceGap' in find(steps, 'rvc-enhancement').config, false,
    'the second pass must NOT restate it — the pad it needs is already gone');
});

test('BOTH, reversed: narrate → convert → denoise → assemble, gap moves with it', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({
      finalDenoise: true, rvc: RVC, sentenceGap: 0.4, enhancementOrder: 'rvc-first',
    }),
    stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'rvc-enhancement', 'final-denoise', 'reassembly']);
  assert.strictEqual(find(steps, 'rvc-enhancement').config.sentenceGap, 0.4,
    'the conversion is first now, so the gap is its job');
  assert.strictEqual('sentenceGap' in find(steps, 'final-denoise').config, false);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false);
});

test('the gap is stated EXACTLY ONCE in every shape', () => {
  for (const order of ['denoise-first', 'rvc-first']) {
    for (const finalDenoise of [false, true]) {
      for (const rvc of [null, RVC]) {
        const enhance = finalDenoise || rvc !== null;
        const steps = buildNarrationSteps(
          BOOK,
          settings({ finalDenoise, rvc, sentenceGap: 0.4, enhancementOrder: order }),
          stages({ enhance }));
        const stated = steps.filter(
          (s) => s.type !== 'tts-conversion' && s.config.sentenceGap !== undefined);
        assert.strictEqual(stated.length, 1,
          `${order}/denoise=${finalDenoise}/rvc=${rvc !== null}: ${stated.length} steps state a gap`);
      }
    }
  }
});

test('an untouched gap is stated NOWHERE — provenance stays in charge', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: true }));
  for (const step of steps) {
    assert.strictEqual(step.config.sentenceGap, undefined, step.type);
  }
});

// ── the coupling that had to go ─────────────────────────────────────────────

test('THE CONVERSION NEVER CARRIES finalDenoise ANY MORE', () => {
  for (const order of ['denoise-first', 'rvc-first']) {
    const steps = buildNarrationSteps(
      BOOK,
      settings({ finalDenoise: true, rvc: RVC, enhancementOrder: order }),
      stages({ enhance: true }));
    const rvc = find(steps, 'rvc-enhancement');
    assert.strictEqual('finalDenoise' in rvc.config, false,
      `${order}: the job refuses that flag by name, so it must never be set`);
  }
});

test('the two enhancement rows are named apart', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: true }));
  assert.strictEqual(find(steps, 'final-denoise').metadata.title, 'Denoise');
  assert.strictEqual(find(steps, 'rvc-enhancement').metadata.title, 'Voice conversion');
});

// ── what the stage flag means ───────────────────────────────────────────────

test('enhance OFF runs neither pass however the settings are set', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: false }));
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'reassembly']);
});

test('the order is only consulted when both passes run', () => {
  // A nonsense order beside ONE pass is not an error, because no order is being
  // stated: with one pass there is nothing to order.
  const s = settings({ finalDenoise: true, enhancementOrder: 'nonsense' });
  assert.deepStrictEqual(narrationEnhancementPasses(s, stages({ enhance: true })), ['denoise']);
});

test('an unreadable order beside BOTH passes is refused, never assumed', () => {
  const s = settings({ finalDenoise: true, rvc: RVC, enhancementOrder: 'nonsense' });
  assert.throws(() => narrationEnhancementPasses(s, stages({ enhance: true })),
    /neither "denoise-first" nor "rvc-first"/);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('a checked Enhance with neither pass on is refused BY NAME', () => {
  assert.throws(
    () => requireNarrationStages(stages({ enhance: true }), settings()),
    /neither enhancement pass is turned on/);
});

test('enhancement with no assembly is refused', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: true, enhance: true, assemble: false, align: false },
      settings({ finalDenoise: true })),
    /leave nothing to listen to/);
});

test('a run with no stage at all is refused', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: false, enhance: false, assemble: false, align: false }, settings()),
    /nothing to queue/);
});

test('ALIGN ON ITS OWN is refused by name — it rides with what it describes', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: false, enhance: false, assemble: false, align: true }, settings()),
    /align the narration and do nothing else/);
  // With either of the two things it can describe, it is a run.
  requireNarrationStages(
    { narrate: false, enhance: false, assemble: true, align: true }, settings());
  requireNarrationStages(
    { narrate: true, enhance: false, assemble: false, align: true }, settings());
});

test('a conversion with no voice is refused before anything is built', () => {
  assert.throws(
    () => buildNarrationSteps(
      BOOK,
      settings({ rvc: Object.assign({}, RVC, { voiceId: '' }) }),
      stages({ enhance: true })),
    /no enhancement voice is selected/);
});

// ── where the audiobook is filed ────────────────────────────────────────────

test('a CACHE run that converts files as a SECOND audiobook, named by the voice', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC }), stages({ narrate: false, enhance: true }));
  const asm = find(steps, 'reassembly').config;
  assert.strictEqual(asm.registerAsNewVariant, true);
  assert.strictEqual(asm.rvcVoiceId, RVC.voiceId);
});

test('a CACHE run that only DENOISES files into the base slot', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true }), stages({ narrate: false, enhance: true }));
  const asm = find(steps, 'reassembly').config;
  assert.strictEqual(asm.registerAsNewVariant, false,
    'a denoise is the same narration with its hiss taken out, not a second edition');
  assert.strictEqual('rvcVoiceId' in asm, false);
});

test('a run that RENDERED what it converts files into the base slot', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC }), stages({ enhance: true }));
  assert.strictEqual(find(steps, 'reassembly').config.registerAsNewVariant, false);
});

// ── what the first step reads ───────────────────────────────────────────────

test('a cache run starting on a DENOISE points at the session, by kind', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true }), stages({ narrate: false, enhance: true }));
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' },
    'named by kind with no path: which session it is, is a question about the disk');
  assert.strictEqual(steps[1].sourceRef, undefined, 'only the first step says');
});

test('a cache run starting on a CONVERSION points at the session too', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({ finalDenoise: true, rvc: RVC, enhancementOrder: 'rvc-first' }),
    stages({ narrate: false, enhance: true }));
  assert.strictEqual(steps[0].type, 'rvc-enhancement');
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' });
});

test('a run that narrates reads the DOCUMENT it names', () => {
  const steps = buildNarrationSteps(BOOK, settings(), stages());
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'epub', path: BOOK.epubPath });
});

// ── the align row ───────────────────────────────────────────────────────────
//
// It was composed for an ENGINE until 2026-09-07 (`coverageAuditedFor`: Higgs
// yes, Orpheus no), which meant an assemble-only run got a lone `reassembly`
// row and the finished M4B carried narrator's ESTIMATED sentence cues. Owen:
// "put a pre-checked checkbox in the assembly modal that creates the alignment
// step and the assembly step. alignment and assembly should happen in tandem,
// each taking up one of the free cpu slots." So it is a STAGE now, and these
// pin what that means for the shape of the run.

const higgs = (over = {}) => settings(Object.assign({ ttsEngine: 'higgs' }, over));

test('ALIGN IS A STAGE: narrate + align ⇒ narrate → align → assemble', () => {
  const steps = buildNarrationSteps(BOOK, settings(), stages({ align: true }));
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'align', 'reassembly']);
});

test('THE ENGINE NO LONGER DECIDES: orpheus aligns when the run says so', () => {
  // The whole point of the 2026-09-07 ruling. The aligner is whisperx CTC over
  // the book's own text; it knows nothing about which engine spoke it.
  for (const engine of ['orpheus', 'higgs']) {
    const steps = buildNarrationSteps(BOOK, settings({ ttsEngine: engine }), stages({ align: true }));
    assert.ok(shapeOf(steps).includes('align'), `${engine} did not get an align row`);
  }
});

test('ALIGN UNTICKED ⇒ no align row, in any shape or engine', () => {
  for (const engine of ['orpheus', 'higgs']) {
    for (const order of ['denoise-first', 'rvc-first']) {
      for (const finalDenoise of [false, true]) {
        for (const rvc of [null, RVC]) {
          for (const narrate of [true, false]) {
            const enhance = finalDenoise || rvc !== null;
            if (!narrate && !enhance) continue; // not a run; refused elsewhere
            const steps = buildNarrationSteps(
              BOOK,
              settings({ ttsEngine: engine, finalDenoise, rvc, enhancementOrder: order }),
              stages({ narrate, enhance, align: false }));
            assert.ok(!shapeOf(steps).includes('align'),
              `${engine}/${order}/denoise=${finalDenoise}/rvc=${rvc !== null}/narrate=${narrate} `
              + 'grew an align row the run did not ask for');
            for (const step of steps) {
              assert.strictEqual(step.sideBranch, undefined,
                `${step.type} carries sideBranch in a run that has no align row`);
            }
          }
        }
      }
    }
  }
});

test('the align row sits BEHIND the render and IN FRONT of every enhancement', () => {
  // Both orders, both passes: the guard measures the RENDER, its thresholds were
  // calibrated on raw engine output, and it must fail before an hour of GPU.
  for (const order of ['denoise-first', 'rvc-first']) {
    const steps = buildNarrationSteps(
      BOOK,
      higgs({ finalDenoise: true, rvc: RVC, enhancementOrder: order }),
      stages({ enhance: true, align: true }));
    assert.strictEqual(shapeOf(steps)[0], 'tts-conversion', order);
    assert.strictEqual(shapeOf(steps)[1], 'align',
      `${order}: the guard must not measure what a pass made of the render`);
    assert.strictEqual(shapeOf(steps).filter((t) => t === 'align').length, 1,
      `${order}: exactly one align row`);
  }
});

test('ASSEMBLE-ONLY + ALIGN: two steps, SIBLINGS off the source (Owen, 2026-09-07)', () => {
  // Tonight's shape: the Assembly tab of the cached-session door, Align ticked,
  // nothing to render. Both rows are cpu and both root at the source, so they
  // take the two CPU slots at once — the assembly's tail joins on the align
  // before it seals the transcript (queue-steps/reassembly.ts `awaitCoverage`).
  const steps = buildNarrationSteps(
    BOOK, settings(), stages({ narrate: false, assemble: true, align: true }));
  assert.deepStrictEqual(shapeOf(steps), ['align', 'reassembly']);
  const { narrationStepParentIndex } = require(MODULE);
  assert.deepStrictEqual(
    shapeOf(steps).map((_t, i) => narrationStepParentIndex(shapeOf(steps), i)),
    [null, null],
    'the assembly must NOT wait on the align: they are siblings off the source');
  for (const step of steps) {
    assert.deepStrictEqual(step.sourceRef, { kind: 'audio-session' },
      `${step.type} roots at the source and must say what it reads`);
  }
  assert.strictEqual(find(steps, 'align').sideBranch, true);
  assert.strictEqual(find(steps, 'reassembly').sideBranch, undefined);
});

test('ALIGN IS A LEAF: assembly and every pass wait on the nearest non-align step (Owen, 2026-09-07)', () => {
  const { narrationStepParentIndex } = require(MODULE);
  const parents = (types) => types.map((_, i) => narrationStepParentIndex(types, i));
  assert.deepStrictEqual(parents(['tts-conversion', 'align', 'reassembly']), [null, 0, 0],
    'assembly hangs off the render, beside the align — two CPU slots at once');
  assert.deepStrictEqual(
    parents(['tts-conversion', 'align', 'final-denoise', 'rvc-enhancement', 'reassembly']),
    [null, 0, 0, 2, 3],
    'passes and the assembly chain through each other; none of them waits on the audit');
  assert.deepStrictEqual(parents(['tts-conversion', 'reassembly']), [null, 0], 'a run with no align row is the straight line it was');
  assert.deepStrictEqual(parents(['simplify', 'tts-conversion', 'align', 'reassembly']), [null, 0, 1, 1],
    'a text pass in front is still the render\'s parent');
  assert.deepStrictEqual(parents(['align', 'reassembly']), [null, null],
    'nothing in front of the align: both root at the source and run in tandem');
});

test('THE ALIGN ROW SAYS IT IS A LEAF, for the composer that appends one step at a time', () => {
  // `narrationStepParentIndex` is the same rule for a composer that can see the
  // whole list (main's processing:submit-chain). QueueService.addJob cannot —
  // it is called once per step and knows only the run so far — so the step
  // itself carries the flag, and the two must never disagree about which type
  // is a leaf.
  const steps = buildNarrationSteps(BOOK, higgs(), stages({ align: true }));
  for (const step of steps) {
    const isLeaf = step.type === 'align';
    assert.strictEqual(step.sideBranch === true, isLeaf,
      `${step.type}: sideBranch must be set on the align row and on nothing else`);
  }
  const types = shapeOf(steps);
  const { narrationStepParentIndex } = require(MODULE);
  types.forEach((type, i) => {
    const parent = narrationStepParentIndex(types, i);
    // NOTHING is ever parented to a step the plan marked as a side branch.
    if (parent === null) return;
    assert.notStrictEqual(types[parent], 'align',
      `${type} waits on an align row; the two rules disagree`);
  });
});

test('a cache-only run that aligns and converts reads the session by kind', () => {
  const steps = buildNarrationSteps(
    BOOK, higgs({ rvc: RVC }), stages({ narrate: false, enhance: true, align: true }));
  assert.strictEqual(shapeOf(steps)[0], 'align');
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' },
    'named by kind with no path, like every other cache-run first step');
  assert.deepStrictEqual(steps[1].sourceRef, { kind: 'audio-session' },
    'the conversion is the align\'s sibling off the source, so it says so too');
  assert.strictEqual(steps[2].sourceRef, undefined,
    'the assembly waits on the conversion, so it reads what that wrote');
});

test('a narrate-only run can still align — tonight, not next week', () => {
  const steps = buildNarrationSteps(
    BOOK, higgs(), stages({ narrate: true, enhance: false, assemble: false, align: true }));
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'align']);
});

test('the align row carries the language and blank session fields', () => {
  const steps = buildNarrationSteps(BOOK, higgs({ language: 'de' }), stages({ align: true }));
  const align = find(steps, 'align');
  assert.strictEqual(align.metadata.title, 'Align');
  assert.strictEqual(align.config.type, 'align');
  assert.strictEqual(align.config.language, 'de',
    'the aligner loads a per-language model; a guess refuses a book that was read right');
  assert.strictEqual(align.config.sessionId, '');
  assert.strictEqual(align.config.sessionDir, '');
  assert.strictEqual(align.config.processDir, '',
    'resolved at run time from the parent step, like the denoise and the assembly');
});

test('the align row never states a sentence gap', () => {
  // It transforms no audio, so a gap on it would be a knob with no hand on it —
  // and the "exactly once" invariant above counts every non-render step.
  const steps = buildNarrationSteps(
    BOOK, higgs({ finalDenoise: true, sentenceGap: 0.4 }), stages({ enhance: true, align: true }));
  assert.strictEqual('sentenceGap' in find(steps, 'align').config, false);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4,
    'the align row must not shift the gap off the first pass that reads raw audio');
});

test('AN ENGINE THIS BUILD CANNOT RENDER is refused before anything is queued', () => {
  // It was refused by the COVERAGE table until 2026-09-07 — a true sentence
  // about the wrong thing, and one that left with the coverage gate. The engine
  // table answers it now, which is the table that owns the question.
  assert.throws(
    () => buildNarrationSteps(BOOK, settings({ ttsEngine: 'xtts' }), stages()),
    /retired/);
  assert.throws(
    () => buildNarrationSteps(BOOK, settings({ ttsEngine: 'nosuchengine' }), stages()),
    /Unknown TTS engine "nosuchengine"/);
});

test('the aligner add-on is required BY NAME when the run aligns, and only then', () => {
  assert.throws(
    () => requireCoverageAligner(stages({ align: true }), false),
    /Ebook Alignment \(WhisperX\)[\s\S]*Settings → Add-ons/);
  assert.throws(
    () => requireCoverageAligner(stages({ align: true }), false),
    /untick Align/);
  // Installed, or not aligning: nothing to say.
  requireCoverageAligner(stages({ align: true }), true);
  requireCoverageAligner(stages({ align: false }), false);
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`narration-chain: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
