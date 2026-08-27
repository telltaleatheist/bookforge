#!/usr/bin/env node
/**
 * The queue over HTTP: what a phone reads, and what it is allowed to do.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bookshelf-queue-routes.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * test-bookshelf-standalone.js proves these routes are GATED. It cannot prove
 * what they SAY, because it runs against an engine with nothing in it — every
 * claim about a real run is vacuous there. This drives the compiled server over
 * a real socket with a real job in a real engine, and defends three things:
 *
 *   THE CREDENTIAL   A step's `config` is the job type's verbatim configuration
 *                    and the AI job types keep their API keys in it
 *                    (queue-steps/ai-provider.ts: claudeApiKey, openaiApiKey).
 *                    /api/queue/snapshot must not serve it. Nothing in
 *                    shared/queue/bench.ts reads `config`, so dropping it costs
 *                    the page nothing — and the failure it prevents is silent,
 *                    which is why it is asserted rather than remembered.
 *
 *   THE SHAPE        The wire shape must still be the shape bench.ts takes. The
 *                    web queue page runs those functions verbatim, so this
 *                    imports them and runs them on the parsed HTTP body: if the
 *                    endpoint ever grows a projection of its own, the bands go
 *                    with it and the page draws a queue nobody scheduled.
 *
 *   THE REFUSALS     A control that names nothing is refused rather than widened
 *                    into "everything", and a control that names something
 *                    missing answers with the ENGINE's own sentence. Both are
 *                    what a phone shows the user; a silent failure there is a
 *                    person pressing Stop again on a run that never stopped.
 */
'use strict';
require('../cli/electron-stub.js'); // the compiled modules require('electron')

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'bookshelf-server.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const engine = require(path.join(DIST, 'queue-engine.js'));
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));
const { bookshelfServer } = require(path.join(DIST, 'bookshelf-server.js'));
const { setLibraryBasePath } = require(path.join(DIST, 'manifest-service.js'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
  }
}

const SCRATCH_PREFIX = 'bf-queue-http-';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));

/** Best-effort: this run's scratch and anything an earlier run could not remove. */
function sweepScratch() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    } catch { /* a directory still being written into is next run's problem */ }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** A step module that never finishes, so the run stays exactly where it is put. */
const stalled = (type) => ({
  type,
  consumes: null,
  produces: 'epub',
  resource: () => 'gpu',
  stopIsResumable: false,
  run: () => new Promise(() => { /* the test decides when anything moves */ }),
  cancel: () => { /* nothing is running */ },
});

/** The credential a leak would expose. Long and unmistakable so a substring
 *  search over the whole response cannot miss it. */
const SECRET = 'sk-ant-THIS-KEY-MUST-NEVER-LEAVE-THIS-MACHINE';

(async () => {
  fs.mkdirSync(path.join(TMP, 'library', 'projects'), { recursive: true });
  setLibraryBasePath(path.join(TMP, 'library'));

  engine.clearStepModules();
  engine.registerStepModule(stalled('tts-conversion'));
  engine.registerStepModule(stalled('translation'));
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  await engine.configure({ stateDir: path.join(TMP, 'state') });

  const job = engine.enqueue({
    title: 'Smoke Book',
    steps: [
      {
        type: 'translation',
        label: 'Translate',
        config: { aiProvider: 'claude', claudeApiKey: SECRET },
        sourceRef: { kind: 'epub', path: '/a.epub' },
      },
      { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
    ],
  });

  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  await bookshelfServer.start({ port, userDataPath: path.join(TMP, 'state') });

  const snapshot = async () => {
    const res = await fetch(`${BASE}/api/queue/snapshot`);
    assert.strictEqual(res.status, 200, `/api/queue/snapshot answered ${res.status}`);
    return res.json();
  };
  const post = async (route, body) => {
    const res = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  await check('the snapshot carries the run, its steps, and the server clock', async () => {
    const body = await snapshot();
    assert.strictEqual(body.snapshot.jobs.length, 1);
    assert.strictEqual(body.snapshot.jobs[0].steps.length, 2);
    assert.strictEqual(typeof body.snapshot.running, 'boolean');
    // The phone's clock is not this machine's, and every elapsed figure on the
    // page is a difference against timestamps stamped HERE.
    assert.ok(Math.abs(body.now - Date.now()) < 60000, 'the server clock must be the server\'s');
  });

  await check('no step config — and therefore no API key — reaches the wire', async () => {
    const body = await snapshot();
    for (const step of body.snapshot.jobs[0].steps) {
      assert.ok(!('config' in step), `${step.label} shipped its config`);
    }
    assert.ok(!JSON.stringify(body).includes(SECRET),
      'AN API KEY WENT OVER THE WIRE — /api/queue/snapshot must drop each step\'s config');
  });

  await check('bench.ts reads the wire shape exactly as it reads main\'s own', async () => {
    const { snapshot: snap } = await snapshot();
    const plans = bench.bookPlans(snap);
    assert.strictEqual(plans.length, 1, 'one book, one plan');
    assert.strictEqual(plans[0].steps.length, 2);
    assert.strictEqual(plans[0].allHeld, true, 'composing a run must not commit the GPU');
    // The sentence is the product: the page prints it, never re-derives it.
    assert.strictEqual(plans[0].steps[0].reason.sentence, "Held — you haven't started it.");
    assert.strictEqual(plans[0].steps[1].reason.sentence, 'Held — behind Translate.');
    // One GPU slot and two CPU slots, free ones included — a free slot is a fact.
    assert.strictEqual(bench.benchLanes(snap).length, 3);
    assert.strictEqual(bench.needsYou(snap).length, 0);
  });

  for (const route of ['/api/queue/cancel', '/api/queue/remove', '/api/queue/retry']) {
    await check(`POST ${route} refuses a body that names no target`, async () => {
      const r = await post(route, {});
      assert.strictEqual(r.status, 400, `${route} accepted a body naming nothing`);
      assert.match(r.body.error, /\.$/, 'a refusal is a whole sentence the phone can show');
    });
  }

  await check('a control naming something absent answers with the engine\'s own sentence', async () => {
    const r = await post('/api/queue/cancel', { stepId: 'not-a-step' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'There is no step "not-a-step" in the queue.');
  });

  await check('Stop cancels the step AND everything downstream of it', async () => {
    const { snapshot: snap } = await snapshot();
    const stepId = snap.jobs[0].steps[0].id;
    const r = await post('/api/queue/cancel', { stepId });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const steps = engine.snapshot().jobs[0].steps;
    assert.strictEqual(steps[0].status, 'cancelled');
    // The cascade is the point: a step whose parent was cancelled must never be
    // left waiting in a queue that silently steps over it.
    assert.strictEqual(steps[1].status, 'cancelled');
    assert.match(steps[1].error, /Translate was cancelled/);
  });

  await check('Retry puts the step back HELD, not queued', async () => {
    const stepId = engine.snapshot().jobs[0].steps[0].id;
    const r = await post('/api/queue/retry', { stepId });
    assert.strictEqual(r.status, 200);
    const steps = engine.snapshot().jobs[0].steps;
    // Re-running is a decision. A failure nobody has looked at must not restart
    // itself because the queue happened to be running.
    assert.strictEqual(steps[0].status, 'held');
    assert.strictEqual(steps[0].error, undefined);
  });

  await check('Remove takes the whole run out', async () => {
    const r = await post('/api/queue/remove', { jobId: job.id });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(engine.snapshot().jobs.length, 0);
  });

  await check('removing it twice is refused, not silently accepted', async () => {
    const r = await post('/api/queue/remove', { jobId: job.id });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /There is no run/);
  });

  await check('clear-finished is accepted on an empty queue', async () => {
    const r = await post('/api/queue/clear-finished', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
  });

  await bookshelfServer.stop();
  // The VERDICT is the product. The engine persists its state on a tick of its
  // own, so a scratch directory can still be written into as this returns — and
  // a failed rmdir has never been evidence that anything under test is wrong.
  // Swept on the next run instead of waited out with a sleep that guesses.
  sweepScratch();
  console.log(`${failed === 0 ? 'ok' : 'FAILED'}  bookshelf queue routes: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  try { await bookshelfServer.stop(); } catch { /* the verdict is the product */ }
  console.error(`FAILED  bookshelf queue routes: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
