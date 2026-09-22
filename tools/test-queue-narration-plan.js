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
 *
 * ── And the two things the split LEFT OWED (2026-09-19, bug hunt §H) ───────
 *
 * 6. **A prepare row can be cancelled.** Its spawn was registered nowhere a
 *    stop could reach, so `prepare.cancel()` was empty and a stopped row left
 *    narrator running into a scratch session a later run could read back.
 * 7. **Prepare PARKS when no machine will state the band**, and fails only on
 *    something a person repairs. *"It should only fail because of a
 *    misconfiguration, which can be repaired."*
 *
 * ── And WHOSE band it packs to (2026-09-19, second pass) ──────────────────
 *
 * The same section pins the rule that question needed. A book that HOLDS a card
 * (ruling 9) is packed for that card, a row that NAMED a server is packed for
 * that server, and only a book bound to nothing compares machines — taking the
 * TIGHTEST enabled band, so its chunks fit wherever the pump later admits the
 * render. The venue DECISION is never asked about a book whose machine is
 * settled: asking it is what packed a card-holding book to the ranked-first
 * machine's 700-character band and rendered it somewhere else.
 */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
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
  routing: () => ({ ranked: [{ name: 'pc', enabled: true }] }),
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

  console.log('6. a prepare row can be cancelled');

  /*
   * The gap this closes (bug hunt §H): `prepareSession` registered its spawn
   * NOWHERE a stop could reach, so `prepare.cancel()` was deliberately empty,
   * the python ran on after a Stop, and it finished writing a scratch session
   * — `session-state.json` and all — that a resume or the clean-session sweep
   * could read back as a session somebody had packed.
   *
   * Driven through the MODULE's own `cancel`, with a real child process and a
   * real directory standing in for narrator: what is under test is the door,
   * not what narrator does behind it.
   */
  const handles = require(path.join(DIST, 'prep-handles.js'));

  /** A process that will not exit on its own, the way a wedged prep does not. */
  async function longRunningChild() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    return {
      child,
      gone: new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); }),
    };
  }

  /** A half-written session exactly as prep leaves one. */
  function halfWrittenSession(name) {
    const dir = path.join(SCRATCH, 'scratch', `ebook-${name}`);
    fs.mkdirSync(path.join(dir, 'proc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proc', 'session-state.json'),
      JSON.stringify({ session_id: name, total_sentences: 12, chapters: [{ chapter_num: 1 }] }));
    return dir;
  }

  await check('CANCELLING A RUNNING PREPARE KILLS THE SPAWN AND LEAVES NO SESSION DIR', async () => {
    const { prepareStep } = require(path.join(DIST, 'queue-steps', 'prepare.js'));
    const stepId = 'step-prep-cancel';
    const dir = halfWrittenSession('cancelme');
    const { child, gone } = await longRunningChild();
    const handle = handles.beginPrepare(stepId);
    handle.noteSpawn(() => { child.kill('SIGKILL'); }, gone);
    handle.noteSession(dir);

    await prepareStep.cancel(stepId);

    assert.ok(child.exitCode !== null || child.signalCode !== null,
      'the prep spawn is still alive after a Stop — this is the whole defect: the engine '
      + 'abandons the step and narrator keeps reading the book');
    assert.ok(!fs.existsSync(dir),
      `the half-written session survived the stop (${dir}). It holds a session-state.json, `
      + 'which a resume and the clean-session sweep read as a session that was packed.');
    assert.strictEqual(handle.cancelled, true, 'and the run itself must know it was stopped');
    handle.release();
    assert.strictEqual(handles.isPreparing(stepId), false, 'the handle is dropped when released');
  });

  await check('a prepare that is only WAITING is stopped too — there is no process to kill',
    async () => {
      // The park cool-off (`queue-steps/prepare.ts`) is time spent inside the
      // step with nothing spawned. A stop pressed there has only the handle to
      // break, and a wait that ignored it would walk on and prep the book.
      const stepId = 'step-prep-waiting';
      const handle = handles.beginPrepare(stepId);
      const waiting = handles.waitUnlessStopped(handle, 60_000, 'while it was waiting to ask again');
      await handles.cancelPrepare(stepId);
      await assert.rejects(waiting, /stopped/);
      handle.release();
    });

  await check('stopping a job that is not preparing is FALSE, not a thrown error', async () => {
    assert.strictEqual(await handles.cancelPrepare('nothing-by-that-name'), false,
      'the render door calls this for every stop; an unknown id is simply "not mine"');
  });

  await check('a directory that is not a narrator scratch session is NEVER removed', async () => {
    const stepId = 'step-prep-rail';
    const notASession = path.join(SCRATCH, 'precious');
    fs.mkdirSync(notASession, { recursive: true });
    fs.writeFileSync(path.join(notASession, 'book.epub'), 'x');
    const handle = handles.beginPrepare(stepId);
    handle.noteSession(notASession);
    await handles.cancelPrepare(stepId);
    assert.ok(fs.existsSync(path.join(notASession, 'book.epub')),
      'every scratch session is "ebook-<uuid>"; a recursive delete of anything else is a '
      + 'mistake nothing gives back, so the rail refuses and says so');
    handle.release();
  });

  console.log('7. whose band prep packs to — and parking when nobody will state one');

  /*
   * Owen, 2026-09-19: a book *"would just sit there in the queue until it's
   * free"*, and *"it should only fail because of a misconfiguration, which can
   * be repaired."* Prep packs to the RENDERING machine's `max_chars` and pace
   * block, so it asks one server before it packs anything — and with every
   * machine asleep or switched off that question FAILED the row until tonight:
   * a red line in Needs you for a card that was simply not on yet.
   */
  const { bandForPrep, PrepBandUnavailable } = require(path.join(DIST, 'crucible', 'prep-band.js'));
  const runtime = require(path.join(DIST, 'queue-steps', 'runtime.js'));

  /** A refusal as a real door mints one: the code in the message and on the error. */
  const refusal = (code, message, extra = {}) =>
    Object.assign(new Error(`${code}: ${message}`), { code, ...extra });

  const ROSTER = [{ name: 'M1 Ultra', enabled: true }, { name: '3090 Ti', enabled: false }];
  /** Both switched on, the Mac ranked FIRST — the shape Owen's case needs. */
  const BOTH_ON = [{ name: 'M1 Ultra', enabled: true }, { name: '3090 Ti', enabled: true }];
  const BAND = { server: 'M1 Ultra', voice: 'deathstalker', maxChars: 800, ceilingChars: 700 };
  const bandOf = (server, ceiling) =>
    ({ server, voice: 'deathstalker', maxChars: ceiling + 100, ceilingChars: ceiling });

  /** The card this book holds, and the machine its row named — the two rungs. */
  const HELD = (server) => ({ server, because: 'the card this book holds' });
  const NAMED = (server) => ({ server, because: 'the server this row named' });

  /**
   * A host, with every method this rule may reach RECORDED.
   *
   * `decide` is on it and it THROWS: the venue decision — "where does
   * unassigned work go" — is the rule that packed a PC-held book to the Mac's
   * band, and a book whose machine is already settled must never reach it. The
   * property is asserted by the rule not having it to call.
   */
  function prepHost(parts) {
    const asked = [];
    return {
      asked,
      decide: () => {
        throw new Error('the venue decision must not be asked about a book whose machine '
          + 'is already settled');
      },
      enabled: () => {
        asked.push('enabled');
        return parts.enabled === undefined ? ROSTER.filter((row) => row.enabled) : parts.enabled();
      },
      band: (server) => { asked.push(`band:${server}`); return parts.band(server); },
      venueFor: async (server) => {
        asked.push(`venueFor:${server}`);
        return { where: 'crucible', server, because: 'the caller named it' };
      },
      roster: () => (parts.roster === undefined ? ROSTER : parts.roster()),
    };
  }

  async function askedFor(host, assigned) {
    try {
      return { threw: null, got: await bandForPrep('deathstalker', assigned, host) };
    } catch (err) {
      return { threw: err, got: null };
    }
  }

  await check('NO SERVER ANSWERS → PARKED, naming every machine asked and every one switched off',
    async () => {
      // `any`, and not one enabled machine will state a band: the park case,
      // now reached through the tightest-band rung rather than a venue ping.
      const { threw } = await askedFor(prepHost({
        band: async (server) => {
          throw refusal('crucible_unreachable',
            `crucible "${server}" could not be reached: connect ECONNREFUSED.`);
        },
      }), undefined);
      assert.ok(threw instanceof PrepBandUnavailable,
        `an absent machine is availability, not a misconfiguration; got: ${threw && threw.message}`);
      assert.strictEqual(runtime.busyLineOf(threw), threw.busyLine,
        'the line must ride on the throw under the name `busyLine` — that duck-type is the ONE '
        + 'rule that decides whether settleStep parks the row or fails it');
      assert.match(threw.busyLine, /deathstalker/, 'the voice it could not get numbers for');
      assert.match(threw.busyLine, /M1 Ultra did not answer/,
        'each machine that was asked for the band and would not state one');
      assert.match(threw.busyLine, /switched off: 3090 Ti/,
        'and the machine that was never asked because its switch is off — half of why nothing '
        + 'answered, and invisible in a list of what was tried');
    });

  await check('EVERY SERVER SWITCHED OFF → parked, naming the switch', async () => {
    const { threw } = await askedFor(prepHost({
      enabled: () => {
        throw refusal('no_enabled_server',
          'every Crucible server is paused (M1 Ultra, 3090 Ti). Set one to Running in Settings.');
      },
      band: async () => { throw new Error('the band must not be asked for'); },
      roster: () => [{ name: 'M1 Ultra', enabled: false }, { name: '3090 Ti', enabled: false }],
    }), undefined);
    assert.ok(threw instanceof PrepBandUnavailable,
      'a switch somebody flicked is exactly the wait docs/PENDING-QUEUE-AND-GPU-DIAL.md files '
      + 'under "a parked row says what would unblock it"');
    assert.match(threw.busyLine, /switched off: M1 Ultra, 3090 Ti/);
  });

  await check('NO SERVER REGISTERED AT ALL → failed, in routing\'s own words', async () => {
    const { threw } = await askedFor(prepHost({
      enabled: () => {
        throw refusal('no_enabled_server',
          'no Crucible server is available to the queue: this machine has none, and none is '
          + 'registered. Add one in Settings → Crucible Servers.');
      },
      band: async () => { throw new Error('the band must not be asked for'); },
      roster: () => [],
    }), undefined);
    assert.ok(!(threw instanceof PrepBandUnavailable),
      'nothing is coming: parking would be a row waiting for ever on an act nobody is going '
      + 'to perform');
    assert.strictEqual(runtime.busyLineOf(threw), undefined, 'so the row must FAIL, not park');
    assert.match(threw.message, /Add one in Settings/);
  });

  await check('THE ROW NAMED A SERVER → the band comes back and the book is packed', async () => {
    const host = prepHost({ band: async (server) => {
      assert.strictEqual(server, 'M1 Ultra'); return BAND;
    } });
    const { threw, got } = await askedFor(host, NAMED('M1 Ultra'));
    assert.strictEqual(threw, null, 'nothing is wrong when a machine answers');
    assert.strictEqual(got.venue.server, 'M1 Ultra');
    assert.strictEqual(got.band.ceilingChars, 700,
      'and the WHOLE venue travels back, because prepareSession derives the session home from it');
    assert.strictEqual(got.because, 'the server this row named',
      'and the row says WHY those numbers, because the three answers are three different bugs '
      + 'when the chunks turn out wrong');
    assert.ok(!host.asked.includes('enabled'),
      'naming a machine means waiting for it: no other server is asked, and none is compared');
  });

  await check('A VOICE NOBODY SERVES, while the servers ANSWERED → failed by name', async () => {
    const { threw } = await askedFor(prepHost({
      band: async () => {
        throw refusal('crucible_unknown_voice',
          'crucible "M1 Ultra" has no voice "deathstalker" (known: belinda, tara).');
      },
    }), NAMED('M1 Ultra'));
    assert.ok(!(threw instanceof PrepBandUnavailable),
      'the machine answered — waiting for it to change its mind about which voices it has is '
      + 'waiting for nothing');
    assert.strictEqual(runtime.busyLineOf(threw), undefined);
    assert.match(threw.message, /no voice "deathstalker"/);
  });

  await check('THE MACHINE THE ROW IS BOUND TO STOPS ANSWERING → parked',
    async () => {
      const { threw } = await askedFor(prepHost({
        band: async () => {
          throw refusal('crucible_unreachable',
            'crucible "M1 Ultra" could not be reached: socket hang up. A render is not retried '
            + 'here — start the server and queue the book again, or pick another one.');
        },
      }), NAMED('M1 Ultra'));
      assert.ok(threw instanceof PrepBandUnavailable);
      assert.ok(!/queue the book again/.test(threw.busyLine),
        'the render\'s advice is about a thing the queue is already doing — a parked row must '
        + 'not tell its operator to do the queue\'s job');
      assert.match(threw.busyLine, /M1 Ultra did not answer/);
    });

  await check('a HELD lane still parks on the holder\'s own line, untouched', async () => {
    const held = 'GPU busy: foundry, tts 62% done';
    const { threw } = await askedFor(prepHost({
      band: async () => { throw refusal('crucible_server_busy', 'held.', { busyLine: held }); },
    }), NAMED('M1 Ultra'));
    assert.strictEqual(runtime.busyLineOf(threw), held,
      'a refusal that already names a holder takes the road every other module takes; '
      + 're-dressing it would lose the holder and the progress');
  });

  /*
   * ── WHICH MACHINE'S BAND (the bug measured 2026-09-19) ────────────────────
   *
   * A row whose foundry step resolved the job's venue to one machine holds THAT
   * card for the rest of the chain (ruling 9: a book is atomic on the card).
   * Prepare packed it for a DIFFERENT one, because it asked the venue DECISION
   * — "the first enabled server that answers, in rank order", which is the rule
   * for work that has not been placed. The render then ran on the held card
   * against chunks cut to the other machine's band.
   */
  await check('A BOOK THAT HOLDS A CARD IS PACKED FOR THAT CARD, never for the ranked-first one',
    async () => {
      const host = prepHost({
        enabled: () => BOTH_ON,
        band: async (server) => {
          assert.notStrictEqual(server, 'M1 Ultra',
            'the ranked-first machine was asked for a band for a book that cannot go there');
          return bandOf('3090 Ti', 1000);
        },
        roster: () => BOTH_ON,
      });
      const { threw, got } = await askedFor(host, HELD('3090 Ti'));
      assert.strictEqual(threw, null);
      assert.strictEqual(got.venue.server, '3090 Ti',
        'the book holds this card; packing it to anyone else\'s numbers is an hour of GPU '
        + 'judged against a band the book was never cut to');
      assert.strictEqual(got.band.ceilingChars, 1000);
      assert.strictEqual(got.because, 'the card this book holds');
      assert.deepStrictEqual(host.asked, ['band:3090 Ti', 'venueFor:3090 Ti'],
        'and nothing else was asked: no roster scan, no comparison, and above all not the '
        + 'venue decision, which answers a question about UNASSIGNED work');
    });

  await check('A HELD CARD IS NOT POLLED — a busy server still states the band it packs to',
    async () => {
      /*
       * There is no reachability poll and no activity read in this seam at all,
       * which is the property: the book holds the card, so "is it busy" is
       * answered by the hold's own tail rule (a 409 from its own server during
       * the hold is re-asked), not by packing somewhere else. The host proves it
       * by having nothing else to answer with — `enabled` throws.
       */
      const host = prepHost({
        enabled: () => { throw new Error('a held card is never compared with another'); },
        band: async (server) => bandOf(server, 700),
      });
      const { threw, got } = await askedFor(host, HELD('M1 Ultra'));
      assert.strictEqual(threw, null, 'a busy card is still this book\'s card');
      assert.strictEqual(got.band.ceilingChars, 700);
      assert.ok(!host.asked.includes('enabled'));
    });

  await check('`any` WITH NO CARD HELD PACKS TO THE TIGHTEST BAND, so the chunks travel',
    async () => {
      const ceilings = { 'M1 Ultra': 1000, '3090 Ti': 700 };
      const { threw, got } = await askedFor(prepHost({
        enabled: () => BOTH_ON,
        band: async (server) => bandOf(server, ceilings[server]),
        roster: () => BOTH_ON,
      }), undefined);
      assert.strictEqual(threw, null);
      assert.strictEqual(got.band.ceilingChars, 700,
        'the render is admitted by the pump, not by this rule, so the only length that fits '
        + 'every machine the book might land on is the smallest ceiling any of them states '
        + '(`packingTravelsTo`)');
      assert.strictEqual(got.venue.server, '3090 Ti');
      assert.strictEqual(got.because, 'the tightest of 2 enabled servers');
    });

  await check('`any` WITH ONE MACHINE ASLEEP PACKS TO THE ONE THAT ANSWERED', async () => {
    const { threw, got } = await askedFor(prepHost({
      enabled: () => BOTH_ON,
      band: async (server) => {
        if (server === 'M1 Ultra') {
          throw refusal('crucible_unreachable', 'crucible "M1 Ultra" could not be reached.');
        }
        return bandOf(server, 800);
      },
      roster: () => BOTH_ON,
    }), undefined);
    assert.strictEqual(threw, null,
      'a machine that is off states no ceiling, and a ceiling nobody stated is not a number '
      + 'to pack to');
    assert.strictEqual(got.venue.server, '3090 Ti');
    assert.strictEqual(got.band.ceilingChars, 800);
    assert.strictEqual(got.because, 'the only enabled server that stated a band');
  });

  await check('`any` WHERE ONLY ONE MACHINE SERVES THE VOICE PACKS TO THAT ONE', async () => {
    const { threw, got } = await askedFor(prepHost({
      enabled: () => BOTH_ON,
      band: async (server) => {
        if (server === 'M1 Ultra') {
          throw refusal('crucible_unknown_voice',
            'crucible "M1 Ultra" has no voice "deathstalker" (known: belinda, tara).');
        }
        return bandOf(server, 640);
      },
      roster: () => BOTH_ON,
    }), undefined);
    assert.strictEqual(threw, null,
      'one machine not having the voice is not a misconfiguration of the book — the render '
      + 'goes where the voice is, and that machine stated its numbers');
    assert.strictEqual(got.venue.server, '3090 Ti');
    assert.strictEqual(got.band.ceilingChars, 640);
  });

  await check('A PARKED PREPARE ROW GOES BACK TO QUEUED AND IS ASKED AGAIN', async () => {
    /*
     * The engine half, driven through the real pump, and it pins the MEASURED
     * behaviour rather than the one the packet assumed (2026-09-19):
     *
     * A parked CPU step is re-admitted IMMEDIATELY. `settleStep` puts it back
     * to `queued`, writes the sentence, and calls `pump()` in the same breath;
     * the pump's CPU branch asks NOTHING about admission — `busyHolds` is read
     * by `decideWaitFor`, which is only asked for a travelling step, and
     * `admissionBlocked`/`admissionRecheckTimer` are armed only there. So by
     * the time this check looks, the row is RUNNING again: there is no cool-off
     * in the engine for a CPU park, which is exactly why the cadence lives in
     * the module (`queue-steps/prepare.ts`, PARK_RECHECK_MS) — without it the
     * main process would spin flat out on a park that costs nothing.
     *
     * What must hold: the row waits IN THE QUEUE carrying its sentence, never
     * in Needs you, and the next pass really does ask again.
     */
    const m = narrationModules();
    /*
     * AN `any` ROW, and the reason is a finding of its own (2026-09-19):
     * `settleStep` answers EVERY park with `holdServerBusy(job, line)`, which
     * keys a 15 s cool-off by the ROW'S SERVER — so a prepare park, which is
     * not about a card being held at all, marks that machine busy for every
     * other book bound for it, quoting a sentence about a band. It is a no-op
     * for an `any` row, which is what this check wants: the property under test
     * is the PREPARE row being asked again, not the render behind it inheriting
     * the prepare row's cool-off.
     */
    await freshEngine('prep-parks', [m.prep, m.tts, m.align, m.asm], {
      routing: {
        routing: () => ({ ranked: [{ name: 'pc', enabled: true }], serversOnThisMachine: [] }),
        defaultWaitFor: () => 'any',
        reach: async () => ({ reachable: true }),
      },
    });
    const job = engine.enqueue(narrationRun('Every machine asleep'));
    engine.start();
    await settle();

    const line = 'no Crucible server will state the chunk lengths for voice "deathstalker" — '
      + 'M1 Ultra (unreachable: socket hang up). switched off: 3090 Ti.';
    /*
     * WATCHED, because the sentence does not survive the relaunch: `launch`
     * resets `step.progress` to `{ percent: 0 }`, and the relaunch is the very
     * next turn. So the row's admission hold is a state the queue passes
     * THROUGH rather than one it rests in — which is why the module also keeps
     * the line and reports it while it waits out the cool-off, or an operator
     * would never see why a book is not moving.
     */
    const held = [];
    const unwatch = engine.onQueueChanged((snap) => {
      const s = snap.jobs.flatMap((j) => j.steps).find((x) => x.type === 'prepare');
      if (s && s.status === 'queued' && s.progress.admissionHold) held.push(s.progress.admissionHold);
    });
    m.prep.runs[0].reject(Object.assign(new Error(line), { busyLine: line }));
    await settle();
    unwatch();

    const step = stepsOf(job.id)[0];
    assert.notStrictEqual(step.status, 'failed',
      'a book nobody can pack for yet is waiting, not broken');
    assert.strictEqual(step.status, 'running',
      'the parked row is back in flight already — see the note above: a CPU park has no '
      + 'cool-off in the engine, and the module is what paces the asking');
    assert.strictEqual(step.error, undefined, 'and nothing about it is wrong');
    assert.ok(held.some((sentence) => sentence.includes(line)),
      `the parked row never said what would unblock it; it said: ${JSON.stringify(held)}`);
    const failed = engine.snapshot().jobs.flatMap((j) => j.steps).filter((s) => s.status === 'failed');
    assert.strictEqual(failed.length, 0, 'a parked book must not appear in Needs you');
    assert.ok(m.prep.runs.length >= 2,
      'the parked row was never asked again — a park that is never re-tried is a stall');

    m.prep.runs[m.prep.runs.length - 1].resolve({
      kind: 'prepared-session', sessionId: 'e1', sessionDir: '/s', processDir: '/s/p',
      detail: { epubPath: '/a.epub' },
    });
    await settle();
    assert.strictEqual(m.tts.runs.length, 1,
      'and when a machine answers, the pass that follows preps and the render starts behind it');
  });

  console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log(`FAILING: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
})();
