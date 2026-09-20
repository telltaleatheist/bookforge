#!/usr/bin/env node
/**
 * PREPARE → NARRATE → ALIGN, driven through the real scheduler.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-narration-plan.js
 *
 * ── The ruling this file defends (Owen, 2026-09-19) ────────────────────────
 *
 * 1. *"Prepare can be its own CPU step… we could start the CPU prep the moment
 *    a free CPU slot is open and an item enters the active (and unpaused)
 *    queue."*
 * 2. *"If the next step is guaranteed to use the currently loaded model, we can
 *    leave it loaded"* — otherwise the lease goes back at the step's end.
 * 3. Alignment is its own queue step; *"as soon as the GPU finishes, it
 *    releases the lease"*; and *"if alignment fails it should stop. But we need
 *    to fix it so it doesn't fail. It should only fail because of a
 *    misconfiguration, which can be repaired."*
 *
 * ── Why the SCHEDULER and not the plan ─────────────────────────────────────
 *
 * `tools/test-narration-chain.js` already pins what the plan SAYS — three rows,
 * in that order, each carrying its own fields. None of that is the property
 * Owen asked for. What he asked for is about admission: that the prepare row
 * starts while the GPU server is busy or absent, that the render's slot and
 * lease are given back at its own boundary rather than the run's, and that a
 * failed alignment stops the book instead of shipping an estimate. Every one of
 * those is the pump's answer, so the pump is what is driven — with fake modules
 * standing in for the three real ones, because what is under test is the shape
 * of the chain and not what narrator does inside it.
 *
 * It also pins the ONE pure rule the split made possible to get wrong:
 * chunks packed to one server's ceiling may only be read by a server whose own
 * ceiling is at least as high (`parallel-tts-bridge.packingTravelsTo`).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-engine.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/*
 * THE BRIDGE NEEDS AN `electron` TO IMPORT, and section 5 reads one pure rule
 * out of it. The engine itself imports nothing from Electron — that is the
 * property that makes this suite possible at all — so the stub is installed for
 * the bridge's sake and nothing here goes near a window.
 */
const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    app: {
      getPath: () => path.join(os.tmpdir(), 'bf-narration-plan-userdata'),
      getName: () => 'BookForge', isPackaged: false, getAppPath: () => REPO,
      on() {}, whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {}, ipcMain: { on() {}, handle() {} },
    powerSaveBlocker: { start() {}, stop() {} }, dialog: {}, shell: {},
  },
};

const engine = require(path.join(DIST, 'queue-engine.js'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narration-plan-'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
    process.exitCode = 1;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await wait(0); };

/** A module whose run the test resolves by hand — the same shape test-queue-engine uses. */
function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    ...(opts.machines === undefined ? {} : { machines: opts.machines }),
    ...(opts.leases === undefined ? {} : {
      leasesModel: () => true,
      // The CLASS, not a model id: the id is the server's answer and no module
      // can name it, so the carry-over compares classes (2026-09-19).
      crucibleClass: () => opts.leases,
    }),
    cancelled: [],
    runs,
    run(ctx) {
      const record = { ctx, input: ctx.input };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        record.reject = reject;
      });
      runs.push(record);
      return record.promise;
    },
    cancel(stepId) {
      mod.cancelled.push(stepId);
      const live = runs.find((r) => r.ctx.stepId === stepId && !r.settled);
      if (live) { live.settled = true; live.reject(new Error('Stopped by the user.')); }
    },
  };
  return mod;
}

/**
 * Records what the scheduler asked of the lease seam. No network.
 *
 * `subject` is what the row pretends to hold: the MACHINE and the CLASS, which
 * is all `leaseHeld` answers — the model id belongs to the server.
 */
function spyHost(subject) {
  const closed = [];
  const held = new Map();
  return {
    closed,
    held,
    host: {
      withRowScope(row, fn) { held.set(row, subject); return fn(); },
      async closeRow(row) { closed.push(row); held.delete(row); },
      leaseHeld(row) { return held.get(row) ?? null; },
    },
  };
}

/**
 * One enabled server that always answers. The render and the align TRAVEL
 * (`machines: 'any'`), so without a routing record the pump has nowhere to put
 * them and every case below would be testing admission rather than the chain.
 */
const IDLE_SERVER = {
  routing: () => ({ ranked: [{ name: 'pc', enabled: true }], serversOnThisMachine: [] }),
  defaultWaitFor: () => 'pc',
  reach: async () => ({ reachable: true }),
};

async function freshEngine(name, mods, opts = {}) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(opts.routing === undefined ? IDLE_SERVER : opts.routing);
  engine.setCrucibleLeaseHost(opts.lease ?? null);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });
  return dir;
}

const stepsOf = (jobId) => {
  const job = engine.snapshot().jobs.find((j) => j.id === jobId);
  return job ? job.steps : [];
};

/** The three rows, as the real plan composes them — prepare on the CPU, the rest on the card. */
function narrationModules() {
  return {
    prep: fakeModule('prepare', {
      consumes: 'epub', produces: 'prepared-session', resource: () => 'cpu',
      // NO `machines`: the prepare row travels nowhere, which is what makes the
      // pump admit it with no venue decided.
    }),
    tts: fakeModule('tts-conversion', {
      consumes: ['prepared-session', 'epub'], produces: 'audio-session',
      resource: () => 'gpu', machines: () => 'any',
    }),
    align: fakeModule('align', {
      consumes: 'audio-session', produces: 'audio-session',
      resource: () => 'gpu', machines: () => 'any',
    }),
    asm: fakeModule('reassembly', {
      consumes: 'audio-session', produces: 'm4b', resource: () => 'cpu',
    }),
  };
}

function narrationRun(title, epubPath = '/a.epub') {
  return {
    title,
    release: true,
    steps: [
      { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: epubPath } },
      { type: 'tts-conversion', label: 'TTS', config: {}, parentIndex: 0 },
      { type: 'align', label: 'Align', config: {}, parentIndex: 1 },
      { type: 'reassembly', label: 'Assembly', config: {}, parentIndex: 2 },
    ],
  };
}

(async () => {
  console.log('1. the chain composes and runs in order');

  await check('the four rows compose — the render reads a PREPARED SESSION, not the book', async () => {
    const m = narrationModules();
    await freshEngine('chain', [m.prep, m.tts, m.align, m.asm]);
    const job = engine.enqueue(narrationRun('Roughing It'));
    engine.start();
    await settle();

    assert.strictEqual(m.prep.runs.length, 1, 'the prepare row is what starts');
    assert.strictEqual(m.tts.runs.length, 0, 'nothing renders before the chunks exist');
    assert.deepStrictEqual(stepsOf(job.id).map((s) => s.type),
      ['prepare', 'tts-conversion', 'align', 'reassembly']);

    m.prep.runs[0].resolve({
      kind: 'prepared-session', path: '/s/proc', sessionId: 'ebook-1',
      sessionDir: '/s', processDir: '/s/proc',
      detail: { epubPath: '/a.epub', totalSentences: 344, totalChapters: 12 },
    });
    await settle();
    assert.strictEqual(m.tts.runs.length, 1, 'the render starts behind the pack');
    assert.strictEqual(m.tts.runs[0].input.kind, 'prepared-session',
      'the render must be handed the packed session — being handed the EPUB again is '
      + 'the shape that packs the book twice');
    assert.strictEqual(m.tts.runs[0].input.detail.epubPath, '/a.epub',
      'and the DOCUMENT prep actually packed, which every resume match keys on');
  });

  await check('a chain that would hand a PREPARED session to the assembly is refused at compose time',
    async () => {
      // `checkLineage` validates a child against its parent's static `produces`.
      // A prepared session holds `session-state.json` and not one `.flac`, so
      // an assembly composed straight behind the prep would find an empty
      // sentences directory and assemble silence.
      const m = narrationModules();
      await freshEngine('lineage', [m.prep, m.tts, m.align, m.asm]);
      assert.throws(() => engine.enqueue({
        title: 'Bad chain', release: true,
        steps: [
          { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'reassembly', label: 'Assembly', config: {}, parentIndex: 0 },
        ],
      }), /reads an audio-session|reads a audio-session|audio-session/);
    });

  await check('an OLD row with no prepare step still runs — the render takes an epub', async () => {
    // A queue.json written before 2026-09-19 holds `tts-conversion` rows rooted
    // at the document. Refusing them would fail work in flight for a reason
    // that has nothing to do with it; the step preps inline instead.
    const m = narrationModules();
    await freshEngine('restored-old', [m.prep, m.tts, m.align, m.asm]);
    const job = engine.enqueue({
      title: 'Queued before the prepare row existed', release: true,
      steps: [
        { type: 'tts-conversion', label: 'TTS', config: {}, sourceRef: { kind: 'epub', path: '/old.epub' } },
        { type: 'reassembly', label: 'Assembly', config: {}, parentIndex: 0 },
      ],
    });
    engine.start();
    await settle();
    assert.strictEqual(m.tts.runs.length, 1, 'the restored render must run');
    assert.strictEqual(m.tts.runs[0].input.kind, 'epub');
    assert.strictEqual(stepsOf(job.id)[0].status, 'running');
  });

  console.log('2. the prepare row does not wait for a server');

  await check('PREPARE RUNS WHILE THE GPU SERVER IS BUSY, and the render waits', async () => {
    /*
     * Owen's ruling 1, and the whole reason the row exists: prep is CPU work
     * that used to be paid for inside the GPU step and thrown away when the
     * server answered 409 (finding A2). A routing host that holds every GPU row
     * stands in for a busy card.
     */
    const m = narrationModules();
    await freshEngine('prep-while-busy', [m.prep, m.tts, m.align, m.asm], {
      routing: {
        routing: () => ({
          ranked: [{ name: 'pc', enabled: true, busy: 'GPU busy: foundry, tts 62% done' }],
          serversOnThisMachine: [],
        }),
        defaultWaitFor: () => 'pc',
        // Reachable, and its lane is taken — which is the state that must not
        // stop the prepare row.
        reach: async () => ({ reachable: true, busy: 'GPU busy: foundry, tts 62% done' }),
      },
    });
    const job = engine.enqueue(narrationRun('Busy server'));
    engine.start();
    await settle();

    assert.strictEqual(m.prep.runs.length, 1,
      'THE PREPARE ROW DID NOT START. It travels nowhere and takes a local CPU slot, so a '
      + 'busy — or absent — GPU server has nothing to say about it.');
    assert.strictEqual(stepsOf(job.id)[0].status, 'running');
    assert.strictEqual(m.tts.runs.length, 0, 'and the render has not started');
  });

  await check('a PAUSED queue starts no prepare row either', async () => {
    // Ruling 1 says "active (and unpaused)". Pending and Paused are the two
    // states in which nothing is admitted, and a CPU step is not an exception.
    const m = narrationModules();
    await freshEngine('prep-paused', [m.prep, m.tts, m.align, m.asm]);
    engine.enqueue(narrationRun('Paused'));
    await settle();
    assert.strictEqual(m.prep.runs.length, 0,
      'the queue was never started, so nothing may be admitted — not even CPU work');
    engine.start();
    await settle();
    assert.strictEqual(m.prep.runs.length, 1);
  });

  console.log('3. the render ends at the render');

  await check('the render hands its SLOT back at its own boundary, and Align takes the next one',
    async () => {
      const m = narrationModules();
      await freshEngine('slot-boundary', [m.prep, m.tts, m.align, m.asm]);
      engine.enqueue(narrationRun('Slot'));
      engine.start();
      await settle();
      m.prep.runs[0].resolve({
        kind: 'prepared-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p',
        detail: { epubPath: '/a.epub' },
      });
      await settle();
      assert.strictEqual(m.align.runs.length, 0, 'one GPU slot: the align waits for the render');

      m.tts.runs[0].resolve({
        kind: 'audio-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p',
      });
      await settle();
      assert.strictEqual(m.align.runs.length, 1,
        'the align row must claim the card the moment the render settles — the ten minutes '
        + 'Owen measured were this act happening INSIDE the render step');
      assert.strictEqual(m.asm.runs.length, 0, 'and the assembly waits behind the measurement');
    });

  await check('NARRATE → ALIGN RELEASES THE ROW LEASE — the aligner is a different model',
    async () => {
      /*
       * Owen's ruling 2, feed-forward: the lease is kept only when the NEXT act
       * is guaranteed to use the model that is loaded. A render takes no lease
       * of its own (`crucible/render.ts`: a `tts` job already holds the lane,
       * and `tts` evicts the resident model), and the align loads the ALIGNER.
       * So anything a text act earlier in the row left open must go back here.
       */
      const m = narrationModules();
      const spy = spyHost({ server: 'mac', act: 'clean' });
      await freshEngine('lease-release', [m.prep, m.tts, m.align, m.asm], { lease: spy.host });
      const job = engine.enqueue(narrationRun('Lease'));
      engine.start();
      await settle();
      m.prep.runs[0].resolve({
        kind: 'prepared-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p',
        detail: { epubPath: '/a.epub' },
      });
      await settle();
      m.tts.runs[0].resolve({ kind: 'audio-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p' });
      await settle();
      assert.ok(spy.closed.includes(job.id),
        'the row lease is still open behind the render. `leaseWantedAfter` asks the children '
        + 'of the settled step whether the SAME card is wanted next; neither tts-conversion '
        + 'nor align declares leasesModel, so the card must go back.');
    });

  await check('and the carry-over rule for same-class text acts is untouched', async () => {
    // The archetypal row the lease scope exists for: two acts, one card. The
    // release above must not have been bought by breaking this.
    const a = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: 'clean' });
    const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report', leases: 'clean' });
    const spy = spyHost({ server: 'mac', act: 'clean' });
    await freshEngine('lease-keep', [a, b], { lease: spy.host });
    const job = engine.enqueue({
      title: 'Two acts, one model', release: true,
      steps: [
        { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' } },
        { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'crucible' }, parentIndex: 0 },
      ],
    });
    engine.start();
    await settle();
    a.runs[0].resolve({ kind: 'epub', path: '/a.epub' });
    await settle();
    assert.ok(!spy.closed.includes(job.id),
      'the lease was given back between two acts against the SAME model — that is the '
      + 'keep-it-loaded half of the ruling, and it is not what this packet changed');
  });

  console.log('4. a failed align stops the book');

  await check('a FAILED ALIGN fails the row and the assembly never runs', async () => {
    /*
     * Owen's ruling 3. Until the alignment was a row, a failure was announced
     * and swallowed: the book was sealed with the proportional ESTIMATE and
     * nothing stopped. That is how a misconfigured aligner goes a month
     * unnoticed — and every remaining failure names a misconfiguration
     * somebody can repair and press Retry on.
     */
    const m = narrationModules();
    await freshEngine('align-fails', [m.prep, m.tts, m.align, m.asm]);
    const job = engine.enqueue(narrationRun('Misconfigured'));
    engine.start();
    await settle();
    m.prep.runs[0].resolve({
      kind: 'prepared-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p',
      detail: { epubPath: '/a.epub' },
    });
    await settle();
    m.tts.runs[0].resolve({ kind: 'audio-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p' });
    await settle();
    m.align.runs[0].reject(new Error(
      'This alignment row does not say which language the book was rendered in.'));
    await settle();

    const steps = stepsOf(job.id);
    const align = steps.find((s) => s.type === 'align');
    const asm = steps.find((s) => s.type === 'reassembly');
    assert.strictEqual(align.status, 'failed', 'the align row must land in Needs you');
    assert.match(align.error, /which language/, 'carrying the reason a person repairs');
    assert.strictEqual(m.asm.runs.length, 0, 'and the assembly must not have run');
    assert.strictEqual(asm.status, 'cancelled',
      'the assembly is held behind the measurement, with a reason of its own');
  });

  console.log('5. chunks packed for one machine, read by another');

  await check('packing travels UP a ceiling and never down', () => {
    /*
     * The one pure rule the prep/render split made possible to get wrong: prep
     * packs to the band ONE server stated, and the render may be admitted
     * somewhere else. Crucible refuses an over-long chunk rather than
     * re-splitting it, so a tighter ceiling downstream is a book that fails
     * chunk by chunk, an hour in.
     */
    const { packingTravelsTo } = require(path.join(DIST, 'parallel-tts-bridge.js'));
    assert.strictEqual(packingTravelsTo(700, 800), true, 'a roomier ceiling takes them');
    assert.strictEqual(packingTravelsTo(800, 800), true, 'the same ceiling is the ordinary case');
    assert.strictEqual(packingTravelsTo(800, 700), false,
      'a TIGHTER ceiling must be refused by name before the render is submitted');
  });

  console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log(`FAILING: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
})();
