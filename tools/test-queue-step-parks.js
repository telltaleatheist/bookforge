#!/usr/bin/env node
/**
 * EVERY STEP MODULE PARKS ON A HELD CARD — one road, no side call.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-step-parks.js
 *
 * ── The defect (bug hunt 2026-09-19, finding A5) ────────────────────────────
 *
 * Crucible answers `409 server_busy` when another job holds the lane and
 * `409 leased` when another client holds the model. BOTH ARE WAITS, NOT
 * FAILURES (crucible `docs/ARCHITECTURE.md` §3): nothing about the book is
 * wrong and none of its work is lost, because it never started.
 *
 * The queue parked a row only when the line reached `settleStep`, and the line
 * reached it through `noteStepBusy(stepId, line)` — a call each module had to
 * REMEMBER to make before it threw. The narration bridge, `pass.ts`,
 * `align.ts` and `generate-sentences.ts` made it. `translation.ts`,
 * `book-analysis.ts`, `rvc-enhancement.ts`, `final-denoise.ts` and
 * `vlm-convert.ts` did not — so a translation, an analysis, an enhancement, a
 * denoise or a page read that met a held card ended RED in *Needs you*,
 * waiting for a Retry press, while a simplify against the SAME card waited
 * politely. Owen: *"most step modules fail a row… let's fix that."*
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  1. ONE ROAD. The holder's line rides on the THROW — the one thing every
 *     module already does with a refusal — and `launch` reads it with
 *     `busyLineOf`. There is nothing left for a module to remember and nothing
 *     for a new one to forget.
 *  2. IT IS DUCK-TYPED ON PURPOSE, so every refusal class this app already
 *     mints for a held card (`CrucibleJobRefused`, `CrucibleRenderRefused`,
 *     `CruciblePagesError`, `CrucibleTextActError`, the SDK's own) parks a row
 *     without a table of classes that would go stale.
 *  3. THE PARK IS A QUEUED ROW, NOT A QUIET ONE: back to `queued`, `error`
 *     cleared, the holder's sentence in `progress.admissionHold`, and NOT in
 *     Needs you.
 *  4. THE DOOR IS REMEMBERED AS SHUT. `busyHolds` is keyed by server, so the
 *     next admission pass does not walk straight back into the same 409.
 *  5. A GENUINE FAILURE STILL FAILS. A refusal with no holder is a broken run,
 *     and parking one would be a row that waits for ever on nothing.
 *  6. EVERY MODULE IS DRIVEN, not read. Each one's bridge is replaced with a
 *     stub that answers the 409 the real server would, and the module's own
 *     `run` is called — so a module that drops the line on the floor goes red
 *     here, in the file that says why it must not.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { REPO, installElectronStub, makeChecker } = require('./fake-crucible.js');

const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-steps', 'runtime.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// Every module below reaches a bridge that imports `electron` for `app` and
// `BrowserWindow`; the stub keeps this suite off the real userData.
const stub = installElectronStub('bf-step-parks-');

const engine = require(path.join(DIST, 'queue-engine.js'));
const runtime = require(path.join(DIST, 'queue-steps', 'runtime.js'));
const bridgeEvents = require(path.join(DIST, 'bridge-events.js'));
const { check, summary } = makeChecker();

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-step-parks-work-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await wait(0); };

/** The SDK's own shape of sentence, as `/v1/jobs` sends it back on a 409. */
const BUSY = 'leased: foundry, translate, until 2026-09-19T21:00:00+00:00';

/**
 * A refusal exactly as a Crucible door mints one: the code in the message, the
 * holder's line beside it. Not a `StepParked` — the point of `busyLineOf` is
 * that a module hands over the refusal IT ALREADY HAS.
 */
function refusal(code, busyLine) {
  return Object.assign(new Error(`${code}: crucible "mac" is held. ${busyLine}`), { busyLine });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. The seam: a thrown line parks the row; a failure without one fails it
// ────────────────────────────────────────────────────────────────────────────

/** A step module whose run the test settles by hand (the wait-for suite's). */
function fakeModule(type) {
  const runs = [];
  return {
    type,
    consumes: null,
    produces: 'epub',
    resource: () => 'gpu',
    machines: () => 'any',
    runs,
    run(ctx) {
      const record = { ctx, settled: false };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => { record.settled = true; resolve(out || { kind: 'epub', path: '/o' }); };
        record.reject = (err) => { record.settled = true; reject(err); };
      });
      runs.push(record);
      return record.promise;
    },
    cancel() {},
  };
}

function routingHost(ranked) {
  return {
    routing: () => ({ ranked: ranked.map((r) => ({ ...r })) }),
    defaultWaitFor: () => 'mac',
    dial: () => 'any',
    async reach() { return { reachable: true }; },
  };
}

async function freshEngine(name, mod) {
  engine.clearStepModules();
  engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(routingHost([{ name: 'mac', enabled: true }]));
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  // No background sweep: this suite is about what a SETTLE does, and a sweep
  // pinging a scripted host would only add turns to every `settle()`.
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000, reachSweepMs: 0 });
  return dir;
}

function sendBook(title) {
  const job = engine.enqueue({
    title,
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  });
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
}

const stepOf = (jobId) => engine.snapshot().jobs.find((j) => j.id === jobId).steps[0];

async function seamChecks() {
  await check('a refusal carrying the holder\'s line parks the row — queued, no error, in the queue',
    async () => {
      const mod = fakeModule('tts-conversion');
      await freshEngine('parks', mod);
      const job = sendBook('Behind Foundry');
      engine.start();
      await settle();
      assert.strictEqual(stepOf(job.id).status, 'running');

      mod.runs[0].reject(refusal('crucible_model_leased', BUSY));
      await settle();

      const step = stepOf(job.id);
      assert.strictEqual(step.status, 'queued', 'a 409 is a wait, not a failure');
      assert.strictEqual(step.error, undefined, 'and nothing about this row is wrong');
      assert.ok(step.progress.admissionHold.includes(BUSY),
        `the holder's own line is what the row says; got: ${step.progress.admissionHold}`);
      assert.match(step.progress.admissionHold, /^Waiting for mac: /,
        'and it names the machine being waited for');
      assert.strictEqual(step.finishedAt, undefined, 'a parked step has not finished');
      // NOT in Needs you: that band is `failed` steps, and this one is queued.
      const failed = engine.snapshot().jobs
        .flatMap((j) => j.steps).filter((s) => s.status === 'failed');
      assert.strictEqual(failed.length, 0, 'a parked book must not appear in Needs you');
    });

  await check('a `CrucibleLeased` parks on its `leasedLine` — the SDK\'s other spelling',
    async () => {
      /*
       * THE SDK SPELLS THE TWO WAITS DIFFERENTLY and this seam reads one rule.
       * A held LANE is `CrucibleBusy.busyLine`; a held MODEL is
       * `CrucibleLeased.leasedLine` — the same sentence about a longer clock,
       * and `busyLine` is UNDEFINED on it. `busyLineOf`'s docstring claimed
       * otherwise until 2026-09-19 (bug hunt §H), so a `409 leased` that
       * propagated out of a module untranslated failed the row over a card
       * that was merely held.
       *
       * The REAL class, not a shape typed out here: this check is worth having
       * only while it tracks what `@crucible/client` actually mints.
       */
      const { CrucibleLeased } = require('@crucible/client');
      const held = new CrucibleLeased(409, 'leased', 'model is leased', {}, {
        leaseId: 'lease-9', kind: 'llm', holder: 'foundry', act: 'translate',
        since: '2026-09-19T03:00:00+00:00', expiresAt: '2026-09-19T04:00:00+00:00',
      });
      assert.strictEqual(held.busyLine, undefined,
        'if the SDK ever grows a `busyLine` on this class, this check is testing nothing');
      assert.strictEqual(runtime.busyLineOf(held), held.leasedLine,
        'the one rule has to read both spellings, or a held model reddens a row');

      const mod = fakeModule('tts-conversion');
      await freshEngine('leased-parks', mod);
      const job = sendBook('Leased model');
      engine.start();
      await settle();
      mod.runs[0].reject(held);
      await settle();
      const step = stepOf(job.id);
      assert.strictEqual(step.status, 'queued', 'a held model is a wait, not a failure');
      assert.ok(step.progress.admissionHold.includes(held.leasedLine),
        `the holder's own line is what the row says; got: ${step.progress.admissionHold}`);
    });

  await check('the door is remembered as shut — no immediate re-submit into the same 409',
    async () => {
      const mod = fakeModule('tts-conversion');
      await freshEngine('cool-off', mod);
      const job = sendBook('Cool off');
      engine.start();
      await settle();
      mod.runs[0].reject(refusal('crucible_server_busy', 'GPU busy: foundry, tts 62% done.'));
      await settle();
      assert.strictEqual(stepOf(job.id).status, 'queued');
      assert.strictEqual(mod.runs.length, 1,
        'the busy hold was not recorded, so the pump re-launched straight into the refusal');
    });

  await check('a genuine failure still FAILS — a park needs a holder, never a guess', async () => {
    const mod = fakeModule('tts-conversion');
    await freshEngine('fails', mod);
    const job = sendBook('Really broken');
    engine.start();
    await settle();
    mod.runs[0].reject(new Error('narrator died reading chunk 41'));
    await settle();
    const step = stepOf(job.id);
    assert.strictEqual(step.status, 'failed', 'a run that broke is not waiting for anything');
    assert.match(step.error, /narrator died/);
    assert.strictEqual(step.progress.admissionHold, undefined);
  });

  await check('an EMPTY busyLine is not a line — it fails, and minting one is refused', () => {
    assert.strictEqual(runtime.busyLineOf(Object.assign(new Error('x'), { busyLine: '' })), undefined,
      'a blank sentence would park a row on a stall with no cause');
    assert.strictEqual(runtime.busyLineOf(Object.assign(new Error('x'), { busyLine: 7 })), undefined);
    assert.strictEqual(runtime.busyLineOf(null), undefined);
    assert.strictEqual(runtime.busyLineOf(new Error('plain')), undefined);
    assert.strictEqual(runtime.busyLineOf(refusal('c', BUSY)), BUSY);
    assert.throws(() => new runtime.StepParked('m', ''), /empty busyLine/);
    assert.ok(!(runtime.stepFailure('m') instanceof runtime.StepParked));
    assert.ok(runtime.stepFailure('m', BUSY) instanceof runtime.StepParked);
    assert.strictEqual(runtime.stepFailure('m', BUSY).busyLine, BUSY);
  });

  // ── Contract 1 · A refusal that will pass on its own ──────────────────────
  //
  // bug hunt 2026-09-20 (C1/Q3). Between "somebody holds the card" and "this is
  // a misconfiguration somebody can repair" sits everything that is neither: a
  // reset socket, a host asleep, a 5xx from an engine reloading, a stream that
  // went quiet. Every one of them FAILED the row, red, in *Needs you*, on a
  // machine that would have answered a minute later. PK2 sets the flag in the
  // Crucible doors; this half is the reader and the park, so the fake below is
  // deliberately a bare object — the seam must read the two FIELDS, never a
  // class.

  await check('transientLineOf reads the flag and the sentence, and nothing else', () => {
    const line = 'crucible@mac did not answer (read ECONNRESET); asking again in 15 s';
    assert.strictEqual(
      runtime.transientLineOf(Object.assign(new Error('x'), { transient: true, transientLine: line })),
      line);
    assert.strictEqual(
      runtime.transientLineOf(Object.assign(new Error('socket hang up'), { transient: true })),
      'socket hang up',
      'a door that set the flag and no sentence falls back to its own message');
    assert.strictEqual(runtime.transientLineOf(new Error('plain')), undefined,
      'no flag is no wait: an ordinary failure must still fail');
    assert.strictEqual(
      runtime.transientLineOf(Object.assign(new Error('x'), { transient: 'yes' })), undefined,
      'the flag is `true`, never truthy — a string would make every typo a park');
    assert.strictEqual(
      runtime.transientLineOf(Object.assign(new Error('x'), { transient: true, transientLine: '' })),
      'x', 'a blank sentence is not a sentence; the message answers instead');
    assert.strictEqual(runtime.transientLineOf(null), undefined);
  });

  await check('a TRANSIENT refusal parks the row and is re-launched after the cool-off',
    async () => {
      const line = 'crucible@mac did not answer (read ECONNRESET); asking again in 15 s';
      const mod = fakeModule('tts-conversion');
      await freshEngine('transient-parks', mod);
      /*
       * The cool-off IS the admission tick, so this suite's 5 s default would
       * outlast the test. 300 ms is long enough that `settle()` — twenty real
       * `setTimeout(0)` turns — cannot walk through it, and short enough to
       * wait out; a value under that would make the park look like a relaunch.
       */
      await engine.configure({
        stateDir: path.join(SCRATCH, 'transient-parks'), admissionRecheckMs: 300, reachSweepMs: 0,
      });
      const job = sendBook('Reset socket');
      engine.start();
      await settle();
      assert.strictEqual(stepOf(job.id).status, 'running');

      mod.runs[0].reject(Object.assign(new Error('crucible_unreachable'), {
        transient: true, transientLine: line,
      }));
      await settle();

      const step = stepOf(job.id);
      assert.strictEqual(step.status, 'queued', 'transport is a wait, not a failure');
      assert.strictEqual(step.error, undefined, 'and nothing about this row is wrong');
      assert.ok(String(step.progress.admissionHold).includes(line),
        `the door's own sentence is what the row says; got: ${step.progress.admissionHold}`);
      assert.strictEqual(step.progress.percent, undefined,
        'a percent from the attempt that never landed is a measurement nobody made');
      assert.strictEqual(mod.runs.length, 1, 'the cool-off held it off the immediate re-pump');

      await wait(400);
      await settle();
      assert.strictEqual(mod.runs.length, 2, 'and the admission tick tried it again');
    });

  await check('a transient refusal records NO server-wide hold — a reset is not a holder',
    async () => {
      /*
       * THE ONE DIFFERENCE FROM A 409, and the reason it matters: `busyHolds`
       * is keyed by SERVER and holds every book bound for that machine off it.
       * A dropped socket on one conversation is not evidence that the machine
       * is occupied, and recording one would be the queue inventing a jam.
       * Read through the SECOND book, which is the only thing that can see it.
       */
      const mod = fakeModule('tts-conversion');
      await freshEngine('transient-no-server-hold', mod);
      const first = sendBook('Reset socket');
      const second = sendBook('Behind it');
      engine.start();
      await settle();
      assert.strictEqual(mod.runs.length, 1, 'one GPU slot: the second book waits its turn');

      mod.runs[0].reject(Object.assign(new Error('socket hang up'), { transient: true }));
      await settle();

      assert.strictEqual(stepOf(first.id).status, 'queued', 'the first book parked');
      assert.strictEqual(mod.runs.length, 2,
        'and the machine was NOT held off: the freed slot went straight to the next book');
      assert.strictEqual(mod.runs[1].ctx.jobId, second.id);
    });

  await check('a transient refusal of a step whose BOOK holds the card keeps the venue',
    async () => {
      // Ruling 9: a book is atomic on the card. A render that landed stands on
      // that machine, so an align that meets a reset socket waits for the SAME
      // machine — the model it needs is the one loaded there.
      const render = fakeModule('tts-conversion');
      const align = fakeModule('align');
      engine.clearStepModules();
      for (const m of [render, align]) engine.registerStepModule(m);
      engine.setGpuLockProbe(() => null);
      engine.setGpuHolderProbe(() => null);
      engine.setCrucibleRoutingHost(routingHost([{ name: 'mac', enabled: true }]));
      const dir = path.join(SCRATCH, 'transient-holds-card');
      fs.mkdirSync(dir, { recursive: true });
      await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000, reachSweepMs: 0 });

      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [
          { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'align', label: 'Align', config: {}, parentIndex: 0 },
        ],
      });
      if (job.pending === true) engine.sendToQueue(job.id);
      engine.start();
      await settle();
      render.runs[0].resolve({ kind: 'audio', path: '/out/render' });
      await settle();
      assert.strictEqual(engine.snapshot().jobs.find((j) => j.id === job.id).waitForResolved, 'mac');

      align.runs[0].reject(Object.assign(new Error('crucible_unreachable'), { transient: true }));
      await settle();
      const row = engine.snapshot().jobs.find((j) => j.id === job.id);
      assert.strictEqual(row.steps[1].status, 'queued');
      assert.strictEqual(row.waitForResolved, 'mac',
        'the render stands on that machine, so the book stays on it');
    });

  await check('the retired side call is GONE — one road, or a module can take the wrong one', () => {
    assert.strictEqual(engine.noteStepBusy, undefined,
      'noteStepBusy is back: the line must ride on the throw, not on a call five modules forgot');
    const src = fs.readFileSync(path.join(REPO, 'electron', 'queue-engine.ts'), 'utf-8');
    assert.ok(!/export function noteStepBusy/.test(src));
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Every module, driven with its bridge answering the 409
// ────────────────────────────────────────────────────────────────────────────

/** What a step is handed. Nothing here reports anywhere. */
function context(config, input = { kind: 'none' }) {
  return {
    jobId: 'job-1',
    stepId: 'step-1',
    step: { id: 'step-1', label: 'The step', config, progress: {}, metrics: {} },
    // A row the queue ASSIGNED — every travelling module refuses by name
    // without one, which is a different (and already-pinned) refusal.
    job: { id: 'job-1', waitForResolved: 'mac', projectId: config.projectDir || config.bfpPath },
    input,
    signal: new AbortController().signal,
    report: () => {},
    releaseGpu: () => {},
  };
}

/**
 * Call a module's `run` and say what came back — the thrown refusal, or the
 * artifact if it did not throw at all.
 */
async function caught(mod, ctx) {
  try {
    const out = await mod.run(ctx);
    return { threw: null, out };
  } catch (err) {
    return { threw: err, out: null };
  }
}

/** The one assertion every module owes. */
function assertParks(what, err) {
  assert.ok(err, `${what} did not throw at all on a held card`);
  assert.strictEqual(runtime.busyLineOf(err), BUSY,
    `${what} dropped the holder's line, so its row reddens in Needs you instead of waiting `
    + `(got: ${err.message})`);
}

/**
 * THE HEAVY HALF NEEDS THE BUILD'S OWN COPY STEP.
 *
 * Five of these modules pull in the bridge graph, and `rvc-models` reads
 * `dist/electron/data/rvc-voice-assets.json` AT IMPORT TIME — a file
 * `npm run build:electron` copies and `tsc` does not. The seam checks above
 * need none of it, so this suite does not skip whole: it says, on an indented
 * per-check line, which checks could not run and what supplies them (the skip
 * contract is for a suite that could not run at all — tools/keeper-skip.js).
 */
const STAGED = fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'));
const STAGE_NOTE = 'dist/electron/data is not staged, so this module could not be loaded — '
  + 'npx shx cp -r electron/data dist/electron/';

async function moduleChecks() {
  if (!STAGED) console.log(`  note  ${STAGE_NOTE}`);
  await check('translation: the bridge\'s busyLine reaches the seam', async () => {
    const bridge = require(path.join(DIST, 'translation-bridge.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'translation.js')).translationStep;
    const original = bridge.translationBridge.translateEpub;
    bridge.translationBridge.translateEpub = async () => ({
      success: false, error: 'crucible_model_leased: crucible "mac" is held.', busyLine: BUSY,
    });
    try {
      const ctx = context({ aiProvider: 'crucible', aiModel: 'm' }, { kind: 'epub', path: '/b.epub' });
      assertParks('translation', (await caught(mod, ctx)).threw);

      // And the negative, through the same door: no holder, a red row.
      bridge.translationBridge.translateEpub = async () => ({ success: false, error: 'the book is unreadable' });
      const plain = (await caught(mod, ctx)).threw;
      assert.strictEqual(runtime.busyLineOf(plain), undefined);
      assert.match(plain.message, /unreadable/);
    } finally {
      bridge.translationBridge.translateEpub = original;
    }
  });

  await check('book-analysis: the bridge\'s busyLine reaches the seam', async () => {
    if (!STAGED) return;
    const analysis = require(path.join(DIST, 'book-analysis.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'book-analysis.js')).bookAnalysisStep;
    const original = analysis.analyzeBook;
    analysis.analyzeBook = async () => ({
      success: false, error: 'crucible_model_leased: crucible "mac" is held.', busyLine: BUSY,
    });
    try {
      const ctx = context({
        aiProvider: 'crucible', aiModel: 'm', projectDir: SCRATCH,
        source: { kind: 'document', epubPath: '/b.epub' },
        categories: [{ id: 'c', name: 'C', description: 'd', color: '#fff', enabled: true }],
      });
      assertParks('book-analysis', (await caught(mod, ctx)).threw);
    } finally {
      analysis.analyzeBook = original;
    }
  });

  await check('rvc-enhancement: the bridge\'s busyLine reaches the seam', async () => {
    if (!STAGED) return;
    const job = require(path.join(DIST, 'rvc-job.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'rvc-enhancement.js')).rvcEnhancementStep;
    const original = job.runRvcEnhancement;
    job.runRvcEnhancement = async () => ({
      success: false, error: 'crucible_server_busy: crucible "mac" is running a job.', busyLine: BUSY,
    });
    try {
      const ctx = context({
        voiceId: 'deathstalker', sessionId: 's', sessionDir: '/s', processDir: '/p',
      });
      assertParks('rvc-enhancement', (await caught(mod, ctx)).threw);
    } finally {
      job.runRvcEnhancement = original;
    }
  });

  await check('final-denoise: the bridge\'s busyLine reaches the seam', async () => {
    if (!STAGED) return;
    const job = require(path.join(DIST, 'denoise-job.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'final-denoise.js')).finalDenoiseStep;
    const original = job.runFinalDenoise;
    job.runFinalDenoise = async () => ({
      success: false, error: 'crucible_server_busy: crucible "mac" is running a job.', busyLine: BUSY,
    });
    try {
      const ctx = context({ sessionId: 's', sessionDir: '/s', processDir: '/p' });
      assertParks('final-denoise', (await caught(mod, ctx)).threw);
    } finally {
      job.runFinalDenoise = original;
    }
  });

  await check('pass (simplify / translate / clean): the pass result\'s busyLine reaches the seam',
    async () => {
      const passes = require(path.join(DIST, 'processing-passes.js'));
      const mod = require(path.join(DIST, 'queue-steps', 'pass.js')).simplifyStep;
      const original = passes.runProcessingPass;
      passes.runProcessingPass = async () => ({
        success: false, error: 'crucible_model_leased: crucible "mac" is held.', busyLine: BUSY,
      });
      try {
        const ctx = context({
          kind: 'simplify', projectDir: SCRATCH, stageRelDir: 'stages/01',
          simplify: { mode: 'dejargon', aiProvider: 'crucible', aiModel: 'm' },
        });
        assertParks('pass', (await caught(mod, ctx)).threw);
      } finally {
        passes.runProcessingPass = original;
      }
    });

  await check('align: the job\'s busyLine reaches the seam', async () => {
    if (!STAGED) return;
    const job = require(path.join(DIST, 'coverage-align-job.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'align.js')).alignStep;
    const original = job.runCoverageAlign;
    job.runCoverageAlign = async () => ({
      success: false, error: 'crucible_server_busy: crucible "mac" is running a job.', busyLine: BUSY,
    });
    try {
      const ctx = context({
        sessionId: 's', sessionDir: '/s', processDir: '/p', language: 'en', device: 'gpu',
      });
      assertParks('align', (await caught(mod, ctx)).threw);
    } finally {
      job.runCoverageAlign = original;
    }
  });

  await check('generate-sentences: the completion event\'s busyLine reaches the seam', async () => {
    if (!STAGED) return;
    const bridge = require(path.join(DIST, 'generate-sentences-bridge.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'generate-sentences.js')).generateSentencesStep;
    const original = bridge.startGenerateSentences;
    // The transcription reports through a window and refuses without one — a
    // different refusal, already the module's own, so give it a window.
    runtime.setQueueMainWindow({ isDestroyed: () => false, webContents: { send() {} } });
    bridge.startGenerateSentences = async (jobId) => {
      bridgeEvents.publishBridgeEvent('generate-sentences:complete', {
        jobId, success: false,
        error: 'crucible_server_busy: crucible "mac" is running a job.', busyLine: BUSY,
      });
    };
    try {
      const ctx = context({ projectId: 'p', variantId: 'v', m4bPath: '/b.m4b', method: 'epub-align' });
      assertParks('generate-sentences', (await caught(mod, ctx)).threw);
    } finally {
      bridge.startGenerateSentences = original;
      runtime.setQueueMainWindow(null);
    }
  });

  await check('vlm-convert: the page reader\'s refusal travels as ITSELF, uncaught', async () => {
    if (!STAGED) return;
    /*
     * The one module that needs no line of its own: `crucible/pages.ts` throws
     * `CruciblePagesError` carrying `busyLine`, nothing between here and there
     * rewraps it, and `launch` reads the line off the throw. What is pinned is
     * that the module does not swallow or re-dress it on the way past.
     */
    const convert = require(path.join(DIST, 'vlm-convert.js'));
    const mod = require(path.join(DIST, 'queue-steps', 'vlm-convert.js')).vlmConvertStep;
    const original = convert.runVlmConversion;
    convert.runVlmConversion = async () => { throw refusal('crucible_pages_model_leased', BUSY); };
    try {
      const ctx = context({ projectDir: SCRATCH, sourceLabel: 'The Waste Land.pdf' });
      assertParks('vlm-convert', (await caught(mod, ctx)).threw);
    } finally {
      convert.runVlmConversion = original;
    }
  });

  await check('tts-conversion: the render\'s 409 rides the session out to the step', () => {
    /*
     * SOURCE-READ, and it says so rather than pretending otherwise: driving the
     * narration step for real needs a prepped session, a voice, a settings
     * block and a worker pool, and what is at risk here is not arithmetic but
     * the WIRING — three links that each silently drop the line if one is
     * forgotten. The refusal itself (that `CrucibleRenderRefused` carries
     * `busyLine` at all) is driven for real by `tools/test-crucible-render.js`.
     */
    const read = (...bits) => fs.readFileSync(path.join(REPO, ...bits), 'utf-8');
    const bridge = read('electron', 'parallel-tts-bridge.ts');
    assert.match(bridge, /session\.crucibleBusyLine = err\.busyLine;/,
      'the render\'s 409 is not kept on the session, so nothing can carry it to the step');
    assert.match(bridge, /busyLine: session\.crucibleBusyLine/,
      'the completion event does not carry the line, so the step cannot park on it');
    const step = read('electron', 'queue-steps', 'tts-conversion.ts');
    assert.match(step, /throw stepFailure\([\s\S]*?result\.busyLine\)/,
      'the narration step does not hand the line to the seam, so a refused render reddens');
  });
}

(async () => {
  await seamChecks();
  await moduleChecks();
  summary('queue step parks');
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  try { fs.rmSync(stub.work, { recursive: true, force: true }); } catch { /* scratch */ }
})();
