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
    // `orpheus`/`leah` until 2026-09-14. This suite is about the SHAPE of the
    // chain (which steps exist, who owns the chapter gap) and not about the
    // engine — but `narrationRunSteps` calls `assertRunnableTtsEngine`, so a
    // retired engine here fails every case for a reason none of them are about.
    ttsEngine: 'higgs',
    voice: 'deathstalker',
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
 * THREE STAGES, and there is no fourth. `align` was one for a day and Owen
 * removed it on 2026-09-08 — "remove the align the narration checkbox. lets just
 * have it permanently do it that way" — so a narration run composes no align
 * row and the cases that pinned its shape went with it.
 *
 * IT IS A ROW AGAIN SINCE 2026-09-19, and the distinction is the whole point:
 * it is not a STAGE the user chooses. `narrate` brings three rows with it —
 * `prepare` (CPU, in front), the render, and `align` (the qwen3 alignment that
 * had been happening inside the render since 2026-09-08 anyway) — because Owen
 * ruled that the render row must end when the render ends and that a failed
 * alignment must stop the book. Nothing was added to this object.
 */
const stages = (over = {}) =>
  Object.assign({ narrate: true, enhance: false, assemble: true }, over);

/** The step types of a run, in order — the shape, said in one line. */
const shapeOf = (steps) => steps.map((s) => s.type);

/**
 * The shape a run BEYOND the narration has — its enhancement and assembly rows.
 *
 * The three rows `narrate` brings are asserted once, on their own, rather than
 * repeated in front of every enhancement case: those cases are about which pass
 * bakes the gap, and prefixing each of them with the render's own shape would
 * make six tests fail for one change to it.
 */
const NARRATE_ROWS = ['prepare', 'tts-conversion', 'align'];
const afterNarration = (steps) => {
  assert.deepStrictEqual(shapeOf(steps).slice(0, 3), NARRATE_ROWS,
    'every run that narrates is prepare → render → align');
  return shapeOf(steps).slice(3);
};
const find = (steps, type) => steps.find((s) => s.type === type);

// ── the four shapes ─────────────────────────────────────────────────────────

test('NEITHER PASS: narrate → assemble, and the assembly owns the gap', () => {
  const steps = buildNarrationSteps(BOOK, settings({ sentenceGap: 0.4 }), stages());
  assert.deepStrictEqual(afterNarration(steps), ['reassembly']);
  assert.strictEqual(find(steps, 'reassembly').config.sentenceGap, 0.4,
    'nothing upstream bakes it, so the assembly states it');
});

test('DENOISE ONLY: narrate → denoise → assemble, gap on the denoise', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(afterNarration(steps), ['final-denoise', 'reassembly']);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false,
    'the assembly is handed a set the gap is already in');
});

test('RVC ONLY: narrate → convert → assemble, and THE CONVERSION owns the gap', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(afterNarration(steps), ['rvc-enhancement', 'reassembly']);
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
  assert.deepStrictEqual(afterNarration(steps),
    ['final-denoise', 'rvc-enhancement', 'reassembly']);
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
  assert.deepStrictEqual(afterNarration(steps),
    ['rvc-enhancement', 'final-denoise', 'reassembly']);
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

// ── prepare → render → align, and what each of the three carries ────────────
//
// Owen, 2026-09-19: "Prepare can be its own CPU step… we could start the CPU
// prep the moment a free CPU slot is open and an item enters the active (and
// unpaused) queue", and "as soon as the GPU finishes, it releases the lease" —
// the render row ends at the render, and the alignment is a row of its own.

test('the HEAD of a narrating run is the prepare row, and it reads the DOCUMENT', () => {
  const steps = buildNarrationSteps(BOOK, settings(), stages());
  const head = steps[0];
  assert.strictEqual(head.type, 'prepare',
    'the render must not be the first step: nothing about a card may be asked for until the '
    + 'chunks exist');
  assert.deepStrictEqual(head.sourceRef, { kind: 'epub', path: BOOK.epubPath },
    'the prepare row is what reads the book — the render behind it reads the packed session');
  assert.strictEqual(head.epubPath, BOOK.epubPath);
  assert.strictEqual(head.bfpPath, BOOK.projectDir);
});

test('the prepare row carries what the CHUNKS depend on, and nothing about output', () => {
  const prep = find(buildNarrationSteps(BOOK, settings(), stages()), 'prepare').config;
  // The engine, the voice and the band decide where one chunk ends; the cleanup
  // answer decides the shape of the copy prep cuts; "start fresh" is what
  // authorises deleting the checkpoints BEFORE the pack.
  assert.strictEqual(prep.ttsEngine, 'higgs');
  assert.strictEqual(prep.fineTuned, 'deathstalker');
  assert.strictEqual(prep.language, 'en');
  assert.strictEqual(prep.textCleanup, 'required');
  assert.strictEqual(prep.startFresh, false);
  for (const key of ['outputDir', 'skipAssembly', 'finalDenoise', 'metadata']) {
    assert.strictEqual(key in prep, false,
      `the prepare row states ${key}, which is a fact about output — it packs chunks and `
      + 'nothing else');
  }
});

test('"Start fresh" is the PREPARE row\'s answer — it is what deletes the checkpoints', () => {
  const steps = buildNarrationSteps(BOOK, settings({ startFresh: true }), stages());
  assert.strictEqual(find(steps, 'prepare').config.startFresh, true);
});

test('the align row follows the render, on the GPU, and says which language', () => {
  const steps = buildNarrationSteps(BOOK, settings(), stages());
  assert.strictEqual(shapeOf(steps).indexOf('align'), shapeOf(steps).indexOf('tts-conversion') + 1,
    'the alignment measures the RENDER, so nothing may sit between them');
  const align = find(steps, 'align').config;
  // NEVER defaulted: the aligner loads a per-language checkpoint, and one
  // pointed at the wrong language refuses a book that was read correctly.
  assert.strictEqual(align.language, 'en');
  // A Crucible has only the card; `runCoverageAlignOnCrucible` refuses a CPU row.
  assert.strictEqual(align.device, 'gpu');
  // Discovered at run time from the session the render actually wrote.
  assert.deepStrictEqual(
    [align.sessionId, align.sessionDir, align.processDir], ['', '', '']);
});

test('the align row is measured on the ASSEMBLY\'s chapter gap, or on neither', () => {
  // Absent is not zero: it means this run did not choose, and both sides
  // resolve it to DEFAULT_CHAPTER_GAP. A transcript measured at a gap the
  // assembly does not use drifts by that gap at every chapter boundary — which
  // is what every book sealed between 2026-09-09 and 2026-09-11 carries.
  const stated = buildNarrationSteps(BOOK, settings({ chapterGap: 1.5 }), stages());
  assert.strictEqual(find(stated, 'align').config.chapterGap, 1.5);
  assert.strictEqual(find(stated, 'reassembly').config.chapterGap, 1.5,
    'the two must be measured and assembled on ONE number');

  const unstated = buildNarrationSteps(BOOK, settings(), stages());
  assert.strictEqual('chapterGap' in find(unstated, 'align').config, false);
  assert.strictEqual('chapterGap' in find(unstated, 'reassembly').config, false);
});

test('a CACHE-ONLY run composes NO prepare and NO align row', () => {
  // There is nothing to pack — the sentences exist — and the alignment measures
  // a RENDER, whose thresholds were calibrated on raw engine output. An align
  // behind an enhancement pass would refuse books that were read perfectly, and
  // the step's own `consumes` makes it a compose-time refusal anyway.
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC }), stages({ narrate: false, enhance: true }));
  assert.deepStrictEqual(shapeOf(steps), ['rvc-enhancement', 'reassembly']);
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' },
    'the head of a cache run reads the session this project has cached');
});

// ── what the stage flag means ───────────────────────────────────────────────

test('enhance OFF runs neither pass however the settings are set', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: false }));
  assert.deepStrictEqual(afterNarration(steps), ['reassembly']);
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
      { narrate: true, enhance: true, assemble: false },
      settings({ finalDenoise: true })),
    /leave nothing to listen to/);
});

test('a run with no stage at all is refused', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: false, enhance: false, assemble: false }, settings()),
    /nothing to queue/);
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

// ── the align row is GONE (Owen, 2026-09-08) ────────────────────────────────
//
// A dozen cases lived here from 2026-09-07 to 2026-09-08: that align is a STAGE
// rather than an engine property, that its row is a LEAF the assembly does not
// wait on, that it states cpu or gpu and is refused when it cannot, and that the
// aligner add-on is demanded by name before anything is queued. Owen removed the
// checkbox they all describe — "remove the align the narration checkbox. lets
// just have it permanently do it that way. if the user wants an exact alignment
// they can hit generate sentences on the bookforge library" — so the shape they
// pinned is not a shape a narration run can have. What replaced the measurement
// is assembly's own proportional estimate, which is narrator's to test
// (python/narrator/assemble/sentence_vtt.py), not this file's.

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
