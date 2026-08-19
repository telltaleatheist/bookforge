#!/usr/bin/env node
/**
 * Tests for electron/foundry-host-queue.ts — BookForge's queue, as the hosted
 * Foundry window sees it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host-queue.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen's ruling of 2026-08-18 moved scheduling across a seam: a press inside the
 * hosted Foundry window mints a row HERE and runs through this engine. The seam
 * was designed over the switchboard with Foundry's agent, and in the course of
 * one evening FIVE defects were found in it by reading — none by a test, on any
 * of three machines. Four of the five live in the behaviour below.
 *
 * That is the argument for this file. Reading found them once; nothing was
 * holding them found.
 *
 *  - THE ROW IS MINTED SYNCHRONOUSLY AND NOTHING STARTS ON THAT STACK. Foundry's
 *    shelf requires the row back immediately ("pressing Add cannot leave a moment
 *    where nothing has appeared"), and our enqueue ends `changed(); pump();`
 *    inline — so without the deferred pump a step could begin executing inside
 *    the call, re-entering Foundry from inside its own enqueue.
 *  - THE DEDUPE CAME WITH THE SCHEDULING. Foundry's own enqueue refused a second
 *    row writing one output; once a press routes here that guard exists only if
 *    this side keeps it, and it would otherwise have been a hole nobody owned.
 *  - A PROJECT THAT LOSES ITS LAST ROW IS TOLD, ONCE. Their shelf mirrors one
 *    global list and replaces what it is told; silence leaves stale rows on it
 *    for the life of the window.
 *  - DRAIN IS ASKED AFTER THE PUMP HAS DECIDED. Asked on `changed()` it reads the
 *    trough between one step settling and the next starting, and Foundry's
 *    keep-warm default of 0 turns that into an immediate teardown — making a
 *    batch of N reads pay N model reloads.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-host-queue.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const engine = require(path.join(DIST, 'queue-engine.js'));
const host = require(path.join(DIST, 'foundry-host-queue.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-hostq-'));

/*
 * Armed ONCE, exactly as main does after the mount. The two listeners live on the
 * engine for the life of the process, so every test below shares them — which is
 * why each test uses its OWN project directory: the falling-edge bookkeeping is
 * keyed by project, and reusing one path would let one test's teardown be read as
 * another's news.
 */
host.watchFoundryQueue();

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await wait(0); };

/** A `foundry-job` module whose run the test resolves by hand. */
function jobModule() {
  const runs = [];
  const mod = {
    type: 'foundry-job',
    consumes: null,
    produces: 'none',
    resource: (config) => (config.request.kind === 'read' ? 'gpu' : 'cpu'),
    stopIsResumable: true,
    runs,
    run(ctx) {
      const rec = { ctx, resolve: null, reject: null };
      rec.promise = new Promise((res, rej) => {
        rec.resolve = () => res({ kind: 'none' });
        rec.reject = rej;
      });
      runs.push(rec);
      return rec.promise;
    },
    cancel() { /* the signal is the cancel */ },
  };
  return mod;
}

async function fresh(name) {
  // A project nobody else in this file has used. The two listeners armed above
  // live for the whole process and their falling-edge bookkeeping is keyed by
  // project, so reusing a path would let one test's teardown read as another's
  // news. Every test calls fresh() first, so every PROJ below is its own.
  projectSeq += 1;
  PROJ = `Z:\bookforge\foundry\projects\Book-${projectSeq}`;
  engine.clearStepModules();
  const mod = jobModule();
  engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir });
  return mod;
}

let projectSeq = 0;
let PROJ = '';
const readRequest = (key = 'k1', project = PROJ) => ({
  kind: 'read',
  inputPath: `${project}\\archive\\book.pdf`,
  readingsPath: `${project}\\readings\\${key}.jsonl`,
  language: 'en',
});

// ── The row comes back, and nothing has started ─────────────────────────────

test('enqueue returns the row SYNCHRONOUSLY and starts nothing on that stack', async () => {
  const mod = await fresh('sync');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest(), null, PROJ);
  // The row exists before any await — this is Foundry's whole requirement.
  assert.ok(row && typeof row.id === 'string', 'no row came back');
  assert.strictEqual(row.state, 'held', 'a read must arrive held');
  assert.strictEqual(
    mod.runs.length, 0,
    'a step began executing inside enqueue — the pump was not deferred, and this '
    + 're-enters Foundry from inside its own enqueue call',
  );
  await settle();
  // Still nothing: held is held, deferring the pump does not release it.
  assert.strictEqual(mod.runs.length, 0, 'a held read ran without Start');
});

test('a rendering is RELEASED while a read is HELD — Foundry\'s rule, kept', async () => {
  await fresh('release');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const read = host.foundryHostQueue.enqueue(readRequest(), null, PROJ);
  const render = host.foundryHostQueue.enqueue({
    kind: 'epub',
    inputPath: `${PROJ}\\archive\\book.pdf`,
    outputPath: `${PROJ}\\final\\book.epub`,
    readingsPath: `${PROJ}\\readings\\k1.jsonl`,
  }, null, PROJ);

  assert.strictEqual(read.state, 'held', 'a read spends GPU and must wait for a person');
  assert.strictEqual(
    render.state, 'queued',
    'a rendering is arithmetic over a bank already on disk; holding it applies the '
    + 'mechanism to the case it was never about',
  );
});

// ── The dedupe that moved across the seam ───────────────────────────────────

test('a second press for the same product returns the EXISTING row', async () => {
  await fresh('dedupe');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const first = host.foundryHostQueue.enqueue(readRequest('same'), null, PROJ);
  const second = host.foundryHostQueue.enqueue(readRequest('same'), null, PROJ);
  assert.strictEqual(
    second.id, first.id,
    'two rows now write one bank: the second run overwrites the first while the '
    + 'first is still reading, and the file on disk ends up neither',
  );
  assert.strictEqual(host.foundryHostQueue.rows(PROJ).length, 1, 'the shelf shows two rows for one file');
});

test('the dedupe folds the path — one Windows file spelled two ways is one row', async () => {
  await fresh('dedupe-fold');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const a = host.foundryHostQueue.enqueue(readRequest('Cased'), null, PROJ);
  const shouted = readRequest('Cased');
  shouted.readingsPath = shouted.readingsPath.toUpperCase().replace(/\\/g, '/');
  const b = host.foundryHostQueue.enqueue(shouted, null, PROJ);
  assert.strictEqual(b.id, a.id, 'a dedupe comparing spellings lets through the collision it exists to prevent');
});

test('a FINISHED read does not block a fresh press — that is a person asking again', async () => {
  const mod = await fresh('dedupe-terminal');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const first = host.foundryHostQueue.enqueue(readRequest('again'), null, PROJ);
  engine.start({ stepId: first.id });
  await settle();
  assert.strictEqual(mod.runs.length, 1, 'the released read did not run');
  mod.runs[0].resolve();
  await settle();

  const second = host.foundryHostQueue.enqueue(readRequest('again'), null, PROJ);
  assert.notStrictEqual(second.id, first.id, 'a finished row is history, not a lock on ever doing it again');
});

// ── What Foundry's shelf is told ────────────────────────────────────────────

test('rows() is per project and carries the request\'s own identity', async () => {
  await fresh('rows');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  const other = 'Z:\\bookforge\\foundry\\projects\\Other-Book-def456';

  host.foundryHostQueue.enqueue(readRequest('a'), null, PROJ);
  host.foundryHostQueue.enqueue(readRequest('b', other), null, other);

  const mine = host.foundryHostQueue.rows(PROJ);
  assert.strictEqual(mine.length, 1, 'rows() leaked another project\'s work');
  assert.strictEqual(mine[0].kind, 'read');
  assert.ok(mine[0].outputPath.endsWith('a.jsonl'), 'a read\'s identity is the BANK it fills');
  assert.strictEqual(host.foundryHostQueue.rows(other).length, 1);
});

test('a project that loses its last row is pushed an EMPTY list, exactly once', async () => {
  const mod = await fresh('empty-edge');
  const pushes = [];
  host.setFoundrySeam({
    runJob: null,
    setQueueRows: (dir, rows) => pushes.push({ dir, n: rows.length }),
    drained: null,
  });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('edge'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();
  await host.foundryHostQueue.clearFinished();
  await settle();

  const empties = pushes.filter((p) => p.n === 0);
  assert.ok(
    empties.length >= 1,
    'the shelf mirrors one global list and REPLACES what it is told; with no empty '
    + 'push it keeps this project\'s stale rows for the life of the window',
  );
  assert.strictEqual(empties.length, 1, 'emptiness is news once — repeating it is a heartbeat');
});

test('clearFinished sweeps FOUNDRY rows only — not the narration history next door', async () => {
  const mod = await fresh('clear');
  // A second module standing in for BookForge's own work.
  engine.registerStepModule({
    type: 'tts-conversion', consumes: null, produces: 'audio-session',
    resource: () => 'gpu', run: () => Promise.resolve({ kind: 'audio-session' }), cancel() {},
  });
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const tts = engine.enqueue({
    title: 'A narration', release: true,
    steps: [{ type: 'tts-conversion', label: 'TTS', config: {}, sourceRef: { kind: 'epub', path: '/b.epub' } }],
  });
  await settle();

  const row = host.foundryHostQueue.enqueue(readRequest('sweep'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();

  await host.foundryHostQueue.clearFinished();
  const left = engine.snapshot().jobs.map((j) => j.id);
  assert.ok(left.includes(tts.id), 'a press on Foundry\'s shelf swept a finished narration in another window');
  assert.strictEqual(host.foundryHostQueue.rows(PROJ).length, 0, 'the Foundry row was not swept');
});

// ── The drain signal ────────────────────────────────────────────────────────

test('drain is NOT said in the trough between one read ending and the next starting', async () => {
  const mod = await fresh('drain-batch');
  let drains = 0;
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: () => { drains += 1; } });
  engine.start();

  const a = host.foundryHostQueue.enqueue(readRequest('a'), null, PROJ);
  const b = host.foundryHostQueue.enqueue(readRequest('b'), null, PROJ);
  engine.start();               // release both — the batch gesture
  await settle();
  assert.strictEqual(mod.runs.length, 1, 'one GPU, one read at a time');

  mod.runs[0].resolve();        // A ends; B is queued and about to be launched
  await settle();

  assert.strictEqual(
    drains, 0,
    'drain was said between two reads. Foundry\'s keepServerWarmMinutes defaults to 0, '
    + 'so that is an immediate stopServer and B pays a full model reload — N reads, N starts',
  );
  assert.strictEqual(mod.runs.length, 2, 'B did not start');

  mod.runs[1].resolve();
  await settle();
  assert.strictEqual(drains, 1, 'the queue emptied of Foundry work and nobody said so');
  assert.ok(a.id !== b.id);
});

test('drain IS said when the queue keeps running non-Foundry work', async () => {
  const mod = await fresh('drain-mixed');
  let drains = 0;
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: () => { drains += 1; } });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('solo'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();

  assert.strictEqual(
    drains, 1,
    'with no Foundry step running, the reading server must be told — otherwise it holds '
    + 'twenty gigabytes of VRAM against whatever the card is doing next',
  );
  await settle();
  assert.strictEqual(drains, 1, 'drain repeated without any Foundry work having run in between');
});

// ── The runner ──────────────────────────────────────────────────────────────

test('with no runJob the row FAILS WITH A SENTENCE — it does not fall back to Foundry', async () => {
  engine.clearStepModules();
  const real = require(path.join(DIST, 'queue-steps', 'foundry-job.js'));
  engine.registerStepModule(real.foundryJobStep);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  projectSeq += 1;
  PROJ = `Z:\bookforge\foundry\projects\Book-${projectSeq}`;
  const dir = path.join(SCRATCH, 'no-runner');
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir });
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('norunner'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle(40);

  const step = engine.snapshot().jobs.flatMap((j) => j.steps).find((s) => s.id === row.id);
  assert.strictEqual(step.status, 'failed', 'a row with nothing to run it must fail, not sit or succeed');
  assert.match(
    step.error, /queue seam|runJob/i,
    'the refusal must name the missing seam; a silent skip is the fallback the ruling removed',
  );
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      failures.push({ name: t.name, err });
    }
  }
  try { await engine.shutdown(); } catch { /* nothing running */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  for (const f of failures) {
    console.error(`FAIL  ${f.name}\n      ${f.err && f.err.message}`);
  }
  console.log(`foundry-host-queue: ${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 1 - 1 : 1);
})();
