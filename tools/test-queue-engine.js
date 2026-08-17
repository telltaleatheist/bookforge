#!/usr/bin/env node
/**
 * Tests for electron/queue-engine.ts — the scheduler, now that it is MAIN's.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-engine.js
 *
 * ── Why this is testable at all ─────────────────────────────────────────────
 *
 * The engine imports nothing from Electron and holds no list of job types: it is
 * given a state directory and the modules REGISTER themselves. So the whole
 * scheduler — ordering, lineage, slots, GPU admission, cancellation, persistence
 * and the migration of the retired renderer blob — is reachable with three fake
 * modules and a temp folder, at the speed of a unit test. That property is worth
 * as much as any single assertion below and is why `configure`, `setGpuLockProbe`
 * and `registerStepModule` are shaped the way they are.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - FIFO, and one GPU. Two narrations on one card is two runs each taking twice
 *    as long, and it is the failure the old two-lane renderer scheduler could
 *    produce by starting a "standalone" job beside the queue's.
 *  - Chaining onto work that has not run. The act the old queue could not
 *    express: an assemble step queued behind a narration resolves its input from
 *    that narration's OUTPUT when it lands, rather than being handed paths that
 *    do not exist yet and re-discovering them with a retry ladder.
 *  - Held vs released. Composing a run must not be the moment it commits the GPU.
 *  - The external-GPU lock. New behaviour, and the point of it is that the queue
 *    says WHY it is waiting rather than appearing to be broken.
 *  - Cancellation cascades. A step whose parent failed is cancelled WITH A
 *    REASON, never left waiting in a queue that silently steps over it.
 *  - Persistence and migration. A queue written by an older build outlives the
 *    code that understood it; a row of a type nobody claims becomes a failed row
 *    carrying the sentence that explains it, never a row that never runs.
 */
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

const engine = require(path.join(DIST, 'queue-engine.js'));
const types = require(path.join(REPO, 'dist', 'shared', 'queue', 'engine-types.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-queue-'));

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let the scheduler's promise chain settle. Nothing here sleeps for real work. */
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await wait(0); };

/**
 * A step module whose run is a promise the test resolves by hand.
 *
 * Controlling completion is the whole point: the interesting states of a
 * scheduler are the ones where something is HALFWAY, and a module that finished
 * on its own would race every assertion.
 */
function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    stopIsResumable: opts.stopIsResumable === true,
    cancelled: [],
    runs,
    run(ctx) {
      const record = { ctx, input: ctx.input, resolve: null, reject: null };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        record.reject = reject;
      });
      runs.push(record);
      return record.promise;
    },
    cancel(stepId, step) {
      mod.cancelled.push({ stepId, label: step.label });
      const live = runs.find((r) => r.ctx.stepId === stepId && !r.settled);
      if (live) { live.settled = true; live.reject(new Error('Stopped by the user.')); }
    },
  };
  return mod;
}

/** A fresh engine: no modules, no state, no lock, in its own directory. */
async function fresh(name, mods) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir });
  return dir;
}

function stepsOf(jobId) {
  const job = engine.snapshot().jobs.find((j) => j.id === jobId);
  return job ? job.steps : [];
}

// ── Enqueue and FIFO ────────────────────────────────────────────────────────

test('a run is HELD until Start, and Start releases what is there', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('held', [gpu]);
  const job = engine.enqueue({
    title: 'Book A',
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  await settle();
  assert.strictEqual(stepsOf(job.id)[0].status, 'held', 'composing must not commit the GPU');
  assert.strictEqual(gpu.runs.length, 0);

  engine.start();
  await settle();
  assert.strictEqual(stepsOf(job.id)[0].status, 'running');
  assert.strictEqual(gpu.runs.length, 1);
});

test('runs start in the order they were queued, one GPU at a time', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('fifo', [gpu]);
  const ids = ['A', 'B', 'C'].map((n) => engine.enqueue({
    title: n,
    steps: [{ type: 'tts-conversion', label: `Narrate ${n}`, config: {}, sourceRef: { kind: 'epub', path: `/${n}.epub` } }],
  }).id);
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'one GPU slot, so exactly one is running');
  assert.strictEqual(gpu.runs[0].ctx.job.title, 'A');

  gpu.runs[0].resolve();
  await settle();
  assert.strictEqual(gpu.runs.length, 2);
  assert.strictEqual(gpu.runs[1].ctx.job.title, 'B');
  assert.strictEqual(stepsOf(ids[0])[0].status, 'done');
  assert.strictEqual(stepsOf(ids[2])[0].status, 'queued');
});

test('the cpu pool takes two at once, beside a running GPU step', async () => {
  const gpu = fakeModule('tts-conversion');
  const cloud = fakeModule('translation', { resource: () => 'cpu' });
  await fresh('pools', [gpu, cloud]);
  engine.enqueue({ title: 'Narration', steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }] });
  for (const n of [1, 2, 3]) {
    engine.enqueue({ title: `T${n}`, steps: [{ type: 'translation', label: `Translate ${n}`, config: {}, sourceRef: { kind: 'epub', path: `/t${n}.epub` } }] });
  }
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'the GPU step is not held up by cloud work');
  assert.strictEqual(cloud.runs.length, 2, 'two cpu slots, and only two');
});

// ── Lineage ─────────────────────────────────────────────────────────────────

test('a step waits for its parent and is handed the parent OUTPUT', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('chain', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book',
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();

  assert.strictEqual(stepsOf(job.id)[1].status, 'waiting');
  assert.strictEqual(asm.runs.length, 0);

  tts.runs[0].resolve({ kind: 'audio-session', path: '/sentences', sessionId: 'sess-1', sessionDir: '/s' });
  await settle();

  assert.strictEqual(asm.runs.length, 1, 'the parent landing releases the child');
  assert.strictEqual(asm.runs[0].input.sessionId, 'sess-1');
  assert.strictEqual(asm.runs[0].input.path, '/sentences');
});

test('a step appended to a parent that has NOT run resolves its input when it lands', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('append-pending', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book',
    release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();
  assert.strictEqual(tts.runs.length, 1, 'the narration is under way');

  // The act the old queue could not express: chain Assemble onto a narration
  // that is still running, without knowing the session it has not written yet.
  const appended = engine.appendStep(job.id, {
    type: 'reassembly', label: 'Assemble', config: {}, parentStepId: stepsOf(job.id)[0].id,
  });
  await settle();
  assert.strictEqual(stepsOf(job.id)[1].status, 'waiting');
  assert.strictEqual(appended.parentStepId, stepsOf(job.id)[0].id);

  tts.runs[0].resolve({ kind: 'audio-session', sessionId: 'late-session', sessionDir: '/late' });
  await settle();
  assert.strictEqual(asm.runs.length, 1);
  assert.strictEqual(asm.runs[0].input.sessionId, 'late-session',
    'the child reads what its parent actually wrote');
});

test('a chain whose steps cannot read each other is refused when it is COMPOSED', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const pass = fakeModule('simplify', { consumes: 'epub', produces: 'epub' });
  await fresh('lineage-refusal', [tts, pass]);
  assert.throws(() => engine.enqueue({
    title: 'Nonsense',
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'simplify', label: 'Simplify', config: {}, parentIndex: 0 },
    ],
  }), /reads a epub.*writes a audio-session/s);
});

// ── GPU admission ───────────────────────────────────────────────────────────

test('an external GPU lock holds the queue, and the row says why', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('gpu-lock', [gpu]);
  engine.setGpuLockProbe(() => 'orpheus fine-tune, epoch 3');
  const job = engine.enqueue({
    title: 'Book',
    release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'the queue does not fight an external job for the card');
  const step = stepsOf(job.id)[0];
  assert.strictEqual(step.status, 'queued');
  assert.match(step.progress.message, /orpheus fine-tune, epoch 3/,
    'a queue that appears to do nothing is indistinguishable from a broken one');

  engine.setGpuLockProbe(() => null);
  engine.pump();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'and it starts the moment the lock is gone');
});

test('another holder of the arbiter holds the queue too', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('gpu-arbiter', [gpu]);
  engine.setGpuHolderProbe(() => 'llama:cleanup');
  engine.enqueue({
    title: 'Book',
    release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0);
  assert.match(engine.snapshot().jobs[0].steps[0].progress.message, /llama:cleanup/);
});

// ── Cancellation ────────────────────────────────────────────────────────────

test('cancelling a running step cascades to everything waiting on it', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('cancel-cascade', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book',
    release: true,
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();

  await engine.cancel({ stepId: stepsOf(job.id)[0].id });
  await settle();

  const [narrate, assemble] = stepsOf(job.id);
  assert.deepStrictEqual(tts.cancelled.map((c) => c.label), ['Narrate'],
    'the module is asked to stop its own work');
  assert.strictEqual(narrate.status, 'cancelled');
  assert.strictEqual(assemble.status, 'cancelled');
  assert.match(assemble.error, /Skipped: Narrate was stopped/,
    'a skipped step says why it was skipped');
  assert.strictEqual(engine.isRunning(), false, 'a stop idles the queue');
});

test('stopping a RESUMABLE step leaves it held and interrupted, not cancelled', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session', stopIsResumable: true });
  await fresh('resumable-stop', [tts]);
  const job = engine.enqueue({
    title: 'Book',
    release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();
  await engine.cancel({ stepId: stepsOf(job.id)[0].id });
  await settle();

  const step = stepsOf(job.id)[0];
  assert.strictEqual(step.status, 'held', 'nothing revives a cancelled step; held is revivable');
  assert.strictEqual(step.wasInterrupted, true);
  assert.strictEqual(step.error, undefined, 'a stop is not a failure and must not read as one');

  engine.start();
  await settle();
  assert.strictEqual(tts.runs.length, 2, 'Start picks it up again');
  assert.strictEqual(tts.runs[1].ctx.step.wasInterrupted, true,
    'and the runner is told to resume rather than render from zero');
});

test('a failed step fails its job and cancels what came after it, with a reason', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('failure-cascade', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book',
    release: true,
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();
  tts.runs[0].settled = true;
  tts.runs[0].reject(new Error('the model would not load'));
  await settle();

  const [narrate, assemble] = stepsOf(job.id);
  assert.strictEqual(narrate.status, 'failed');
  assert.strictEqual(narrate.error, 'the model would not load');
  assert.strictEqual(assemble.status, 'cancelled');
  assert.match(assemble.error, /Skipped: Narrate failed/);
  assert.strictEqual(asm.runs.length, 0, 'nothing runs on input that was never written');
  assert.strictEqual(types.jobStatus(engine.snapshot().jobs[0]), 'failed',
    'a job whose step failed is failed, not "cancelled" after its own cascade');
});

// ── Derived job status ──────────────────────────────────────────────────────

test('a job has no status of its own — it is read off its steps', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('derived-status', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book',
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  const read = () => types.jobStatus(engine.snapshot().jobs.find((j) => j.id === job.id));
  assert.strictEqual(read(), 'held');

  engine.start();
  await settle();
  assert.strictEqual(read(), 'running');

  tts.runs[0].resolve({ kind: 'audio-session', sessionId: 's' });
  await settle();
  assert.strictEqual(read(), 'running', 'still running: its second step is');

  asm.runs[0].resolve({ kind: 'm4b', path: '/book.m4b' });
  await settle();
  assert.strictEqual(read(), 'done');
  assert.ok(engine.snapshot().jobs[0].finishedAt, 'and the run is stamped finished');
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('the queue survives a restart, and a step that was running comes back interrupted', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  const dir = await fresh('persist', [tts, asm]);
  const job = engine.enqueue({
    title: 'Persisted Book',
    projectId: '/library/projects/book',
    release: true,
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: { voice: 'leah' }, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();
  await engine.persist();

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-engine.json'), 'utf-8'));
  assert.strictEqual(saved.version, 1);
  assert.strictEqual(saved.jobs.length, 1);

  // Come back up against the same directory.
  engine.clearStepModules();
  engine.registerStepModule(fakeModule('tts-conversion', { produces: 'audio-session' }));
  engine.registerStepModule(fakeModule('reassembly', { produces: 'm4b' }));
  await engine.configure({ stateDir: dir });

  const back = engine.snapshot();
  assert.strictEqual(back.running, false,
    'coming back up claiming the GPU would be the app deciding for the user');
  assert.strictEqual(back.jobs.length, 1);
  assert.strictEqual(back.jobs[0].title, 'Persisted Book');
  assert.strictEqual(back.jobs[0].steps[0].config.voice, 'leah', 'the config is what it was');
  assert.strictEqual(back.jobs[0].steps[0].status, 'held');
  assert.strictEqual(back.jobs[0].steps[0].wasInterrupted, true);
  assert.match(back.jobs[0].steps[0].progress.message, /Interrupted when BookForge closed/);
  assert.strictEqual(back.jobs[0].steps[1].parentStepId, back.jobs[0].steps[0].id,
    'lineage survives the round trip');
});

test('a persisted step of a type this build does not have becomes a failed row that says so', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const dir = await fresh('unknown-type', [tts]);
  engine.enqueue({
    title: 'Book',
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  await engine.persist();

  engine.clearStepModules();
  engine.registerStepModule(fakeModule('reassembly', { produces: 'm4b' }));
  await engine.configure({ stateDir: dir });

  const step = engine.snapshot().jobs[0].steps[0];
  assert.strictEqual(step.status, 'failed');
  assert.match(step.error, /Nothing in this build knows how to run a "tts-conversion" step/);
});

// ── Migration of the retired renderer blob ──────────────────────────────────

test('an old queue.json becomes runs with steps, and is kept as .bak', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  const analysis = fakeModule('book-analysis', { produces: 'report', resource: () => 'cpu' });
  engine.clearStepModules();
  for (const m of [tts, asm, analysis]) engine.registerStepModule(m);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);

  const dir = path.join(SCRATCH, 'migrate');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = {
    jobs: [
      {
        id: 'master-1', type: 'audiobook', status: 'processing',
        workflowId: 'wf-1', epubPath: '/lib/book.epub', epubFilename: 'book.epub',
        metadata: { title: 'Deathstalker' }, bfpPath: '/lib/projects/deathstalker',
        addedAt: '2026-08-01T10:00:00.000Z',
      },
      {
        id: 'child-tts', type: 'tts-conversion', status: 'processing',
        workflowId: 'wf-1', parentJobId: 'master-1',
        metadata: { title: 'Narrate' }, config: { language: 'en', fineTuned: 'leah' },
        epubPath: '/lib/book.epub', addedAt: '2026-08-01T10:00:01.000Z',
      },
      {
        id: 'child-asm', type: 'reassembly', status: 'pending',
        workflowId: 'wf-1', parentJobId: 'master-1',
        metadata: { title: 'Assemble' }, config: { outputDir: '/out' },
        addedAt: '2026-08-01T10:00:02.000Z',
      },
      {
        id: 'standalone-1', type: 'book-analysis', status: 'complete',
        metadata: { title: 'Analyse' }, config: { aiProvider: 'claude' },
        outputPath: '/lib/report.json', addedAt: '2026-08-01T11:00:00.000Z',
      },
      {
        id: 'retired-1', type: 'document-get-text', status: 'pending',
        metadata: { title: 'Get Text' }, addedAt: '2026-08-01T12:00:00.000Z',
      },
    ],
    isRunning: true,
    currentJobId: 'child-tts',
    savedAt: '2026-08-01T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(legacy, null, 2));

  await engine.configure({ stateDir: dir });
  const snap = engine.snapshot();

  const run = snap.jobs.find((j) => j.title === 'Deathstalker');
  assert.ok(run, 'the master row became the RUN');
  assert.strictEqual(run.projectId, '/lib/projects/deathstalker');
  assert.strictEqual(run.steps.length, 2, 'its children became its steps');
  assert.deepStrictEqual(run.steps.map((s) => s.label), ['Narrate', 'Assemble']);
  assert.strictEqual(run.steps[1].parentStepId, run.steps[0].id,
    'array order became lineage');
  assert.strictEqual(run.steps[0].status, 'held');
  assert.strictEqual(run.steps[0].wasInterrupted, true,
    'a processing row was interrupted, and comes back resumable');
  assert.strictEqual(run.steps[0].config.fineTuned, 'leah');

  const standalone = snap.jobs.find((j) => j.title === 'Analyse');
  assert.ok(standalone, 'a row with no workflow became a one-step run');
  assert.strictEqual(standalone.steps.length, 1);
  assert.strictEqual(standalone.steps[0].status, 'done');
  assert.strictEqual(standalone.steps[0].output.path, '/lib/report.json',
    'a finished step keeps what it wrote, so a step behind it could read it');

  const retired = snap.jobs.find((j) => j.title === 'Get Text');
  assert.ok(retired, 'a retired type is NOT dropped');
  assert.strictEqual(retired.steps[0].status, 'failed');
  assert.match(retired.steps[0].error, /Get Text is gone/,
    'it carries the recorded sentence, so the user reads what replaced it');

  assert.strictEqual(engine.isRunning(), false, 'the old isRunning is not restored');
  assert.ok(fs.existsSync(path.join(dir, 'queue.json.bak')),
    'the old file is kept — it is the only record of what was queued at upgrade');
  assert.ok(!fs.existsSync(path.join(dir, 'queue.json')));
});

// ── Removal, retry, clearing ────────────────────────────────────────────────

test('removing a run stops what it is running', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('remove', [gpu]);
  const job = engine.enqueue({
    title: 'Book', release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();
  await engine.remove(job.id);
  await settle();
  assert.deepStrictEqual(gpu.cancelled.map((c) => c.label), ['Narrate']);
  assert.strictEqual(engine.snapshot().jobs.length, 0);
});

test('retrying a run leaves the steps that already succeeded alone', async () => {
  const tts = fakeModule('tts-conversion', { produces: 'audio-session' });
  const asm = fakeModule('reassembly', { produces: 'm4b' });
  await fresh('retry', [tts, asm]);
  const job = engine.enqueue({
    title: 'Book', release: true,
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();
  tts.runs[0].resolve({ kind: 'audio-session', sessionId: 's' });
  await settle();
  asm.runs[0].settled = true;
  asm.runs[0].reject(new Error('ffmpeg fell over'));
  await settle();

  engine.retry({ jobId: job.id });
  const [narrate, assemble] = stepsOf(job.id);
  assert.strictEqual(narrate.status, 'done', 're-narrating a book is an hour nobody asked for');
  assert.strictEqual(assemble.status, 'held', 'a retry is a decision, so it is held');
  assert.strictEqual(assemble.error, undefined);
});

test('clear-finished drops the runs that are over and nothing else', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('clear', [gpu]);
  const done = engine.enqueue({ title: 'Done', release: true, steps: [{ type: 'tts-conversion', label: 'A', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }] });
  engine.enqueue({ title: 'Waiting', steps: [{ type: 'tts-conversion', label: 'B', config: {}, sourceRef: { kind: 'epub', path: '/b.epub' } }] });
  engine.start();
  await settle();
  gpu.runs[0].resolve();
  await settle();
  assert.strictEqual(stepsOf(done.id)[0].status, 'done');

  engine.clearFinished();
  const titles = engine.snapshot().jobs.map((j) => j.title);
  assert.deepStrictEqual(titles, ['Waiting']);
});

// ── Progress and the rate anchor ────────────────────────────────────────────

test('a report merges, and the rate anchor is stamped once per run', async () => {
  const gpu = fakeModule('tts-conversion');
  await fresh('progress', [gpu]);
  const job = engine.enqueue({
    title: 'Book', release: true,
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  });
  engine.start();
  await settle();

  const ctx = gpu.runs[0].ctx;
  ctx.report({ percent: 10, message: 'first', stages: [{ name: 's', label: 'S', pct: 10, status: 'running' }], metrics: { chunksDoneInSession: 128 } });
  await settle();
  let step = stepsOf(job.id)[0];
  const anchor = step.metrics.firstChunkCompletedAt;
  assert.ok(anchor, 'the first observation opens the window');
  assert.strictEqual(step.metrics.chunksAtFirstStamp, 128,
    'and records the count at that instant — batched engines arrive 128 chunks deep');

  // A later report with no stages must not blank the bars.
  ctx.report({ percent: 40, message: 'second', metrics: { chunksDoneInSession: 192 } });
  await settle();
  step = stepsOf(job.id)[0];
  assert.strictEqual(step.progress.message, 'second');
  assert.strictEqual(step.progress.stages.length, 1, 'a one-off event must not erase the breakdown');
  assert.strictEqual(step.metrics.firstChunkCompletedAt, anchor, 'the anchor is set once, never moved');
  assert.strictEqual(step.metrics.chunksAtFirstStamp, 128);
});

// ── Everything else the engine refuses ──────────────────────────────────────

test('a run with no steps, and a step of an unknown type, are both refused by name', async () => {
  await fresh('refusals', [fakeModule('tts-conversion')]);
  assert.throws(() => engine.enqueue({ title: 'Nothing', steps: [] }), /would do nothing/);
  assert.throws(() => engine.enqueue({
    title: 'Ghost',
    steps: [{ type: 'not-a-job-type', label: 'Ghost', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } }],
  }), /Nothing in this build knows how to run a "not-a-job-type" step/);
});

test('a source step with nothing to read is refused when it is composed', async () => {
  await fresh('no-source', [fakeModule('tts-conversion')]);
  assert.throws(() => engine.enqueue({
    title: 'Book',
    steps: [{ type: 'tts-conversion', label: 'Narrate', config: {} }],
  }), /needs a source to read/);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  await engine.shutdown();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nqueue-engine: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
