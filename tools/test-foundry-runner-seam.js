#!/usr/bin/env node
/**
 * FOUNDRY IS A RUNNER — what this engine does with each of the four outcomes.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-runner-seam.js
 *
 * PK6 (docs/BUG-HUNT-2026-09-20.md §H) re-cut the seam: hosted, Foundry is
 * handed a DESCRIPTION of one act and a VENUE, and it answers with a typed
 * OUTCOME. This keeper drives the `foundry-job` step against a FAKE runner — no
 * Foundry, no Crucible, no engine — and measures the four things this side owes:
 *
 *   `wait`      PARKS (Q4, Contract 2). Foundry takes its own Crucible lease, so
 *               a `409 leased` used to arrive as a `failed` row carrying prose
 *               and turned RED in *Needs you* over a card that was merely held.
 *               A park is a `StepParked` carrying the holder's own line, which
 *               PK1's engine re-queues on.
 *   `failed`    is a failure a person must read, wearing FOUNDRY's sentence.
 *   `cancelled` is NOT a failure: somebody spent GPU and took it back, and
 *               filing that as a failure is how `retry()` restarts work a person
 *               just stopped.
 *   `done`      is the row.
 *
 * And two facts about what crosses the seam:
 *
 *   `onPlaced` WRITES THE LEASE INTO THE IN-FLIGHT LEDGER and the outcome clears
 *   it (P8). Foundry's lease was the one claim on somebody's card this app could
 *   make and not record, so a ctrl-C left it held by a process that no longer
 *   existed with nothing on disk naming it.
 *
 *   THE REQUEST STORED ON THE STEP CARRIES NO `derived/` PATH (F1/F5). The book
 *   is made when the run starts; a path minted at the press is unlinked by
 *   Foundry's own settle and replayed by Retry, by Start, and by a queue
 *   restored from disk.
 *
 * No electron, no network, no GPU.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
for (const built of ['foundry-host-queue.js', 'queue-steps/foundry-job.js', 'crucible/in-flight-ledger.js']) {
  if (!fs.existsSync(path.join(DIST, built))) {
    console.log(skipLine(`dist/electron/${built} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}

/*
 * ── THE ELECTRON STUB, BEFORE ANY OF IT IS LOADED ──────────────────────────
 *
 * `in-flight-ledger` resolves its file through `app.getPath('userData')` at CALL
 * time (its own rule, so a headless door can install a stub), and half the graph
 * under `foundry-job` imports `electron` at module scope. One temp directory per
 * run, swept at the end: the ledger this keeper writes is a real file, because
 * what is under test includes that it is written at all.
 */
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-runner-seam-'));
const Module = require('module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: {
    app: {
      getPath: () => USER_DATA,
      getName: () => 'BookForge',
      getVersion: () => 'test',
      getAppPath: () => REPO,
      isPackaged: false,
      on: () => {},
      whenReady: async () => {},
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle: () => {}, on: () => {} },
    net: {},
    protocol: {},
    session: {},
    shell: {},
  },
};

const hostQueue = require(path.join(DIST, 'foundry-host-queue.js'));
const ledger = require(path.join(DIST, 'crucible', 'in-flight-ledger.js'));
const runtime = require(path.join(DIST, 'queue-steps', 'runtime.js'));
const { foundryJobStep } = require(path.join(DIST, 'queue-steps', 'foundry-job.js'));

let passed = 0;
const failures = [];
const queued = [];
const it = (name, run) => queued.push(async () => {
  try {
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
});

/**
 * A ROW OF OURS AND THE REQUEST ON IT — a RENDERING, deliberately.
 *
 * `resourceFor` calls a rendering `cpu`, so `machines()` says `local` and the
 * step names no venue: it never reaches `decideWhereTextActRuns`, which would
 * want a Crucible registry this keeper has no business standing up. What is
 * under test is the OUTCOME mapping, which is the same for every kind.
 */
function stepContext(asked = {}) {
  const reported = [];
  return {
    stepId: asked.stepId ?? 'step_runner_seam',
    signal: new AbortController().signal,
    job: { id: 'job_runner_seam', waitForResolved: undefined },
    report: (line) => { reported.push(line); },
    reported,
    step: {
      id: asked.stepId ?? 'step_runner_seam',
      type: 'foundry-job',
      config: {
        type: 'foundry-job',
        projectDir: path.join(os.tmpdir(), 'not-a-real-project'),
        parentStep: null,
        label: 'Export EPUB',
        request: {
          kind: 'epub',
          inputPath: path.join(os.tmpdir(), 'not-a-real-project', 'archive', 'book.pdf'),
          outputPath: path.join(os.tmpdir(), 'not-a-real-project', 'final', 'book.epub'),
          readingsPath: path.join(os.tmpdir(), 'not-a-real-project', 'readings', 'book.jsonl'),
          // THE ROW THIS IS MADE FROM, which is what crosses instead of a path.
          at: 'step-the-press-was-standing-on',
          ...asked.request,
        },
      },
    },
  };
}

/** Install a fake runner and hand back what it was called with. */
function fakeRunner(answer) {
  const calls = [];
  hostQueue.setFoundrySeam({
    runJob: async (request, opts) => {
      calls.push({ request, opts });
      return typeof answer === 'function' ? answer(request, opts) : answer;
    },
    setQueueRows: null,
    drained: null,
  });
  return calls;
}

const A_ROW = {
  id: 'foundry-row-1',
  inputPath: 'book.pdf',
  outputPath: 'book.epub',
  kind: 'epub',
  state: 'done',
  progress: null,
  createdAt: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// The four outcomes
// ─────────────────────────────────────────────────────────────────────────────

it('wait: a busy card PARKS on the holder\'s own line, and is not a failure', async () => {
  fakeRunner({
    outcome: 'wait',
    busyLine: 'crucible@the-mac is translating "Deathstalker" until 12:04',
    standing: false,
  });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a wait must not resolve as a finished step');
  assert.strictEqual(thrown.name, 'StepParked',
    'THE FINDING (Q4): a 409 crossed this seam as prose and reddened a row in Needs you over a '
    + 'card that was merely held. A park is what every other module already does with one.');
  assert.strictEqual(runtime.busyLineOf(thrown),
    'crucible@the-mac is translating "Deathstalker" until 12:04',
    "and the line is the HOLDER'S own sentence, which is what the row shows");
});

it('wait: a STANDING wait parks too — it waits for a person, not for a clock', async () => {
  fakeRunner({
    outcome: 'wait',
    busyLine: '"the PC" cannot translate: no model fits its card (3.2 GiB short)',
    standing: true,
  });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.strictEqual(thrown && thrown.name, 'StepParked',
    'a server switched off, or a class its card cannot serve, is still a wait: the row says '
    + 'whose card it is waiting for instead of being refused by a second reading of this '
    + "machine's registry (the pre-check PK6 deleted)");
  assert.ok(runtime.busyLineOf(thrown).includes('cannot translate'),
    "and it wears the server's own reason");
});

it('failed: a row that BROKE is a failure a person reads, in Foundry\'s words', async () => {
  fakeRunner({
    outcome: 'failed',
    row: { ...A_ROW, state: 'failed', error: 'dots-ocr could not be loaded' },
    error: 'dots-ocr could not be loaded',
    stderrTail: 'Traceback (most recent call last):\n  OSError: no such model',
  });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a failed run must not resolve');
  assert.strictEqual(runtime.busyLineOf(thrown), undefined,
    'nothing held the card: this is a failure and must reach Needs you');
  assert.strictEqual(thrown.message, 'dots-ocr could not be loaded',
    "the engine knows more about why it stopped than this side does, so its sentence wins");
});

it('failed: a holder\'s line ON a failed row still parks (the field PK5 fills)', async () => {
  fakeRunner({
    outcome: 'failed',
    row: { ...A_ROW, state: 'failed', error: 'refused', busyLine: 'crucible@the-mac holds the lease' },
    error: 'refused',
    stderrTail: '',
  });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.strictEqual(runtime.busyLineOf(thrown), 'crucible@the-mac holds the lease',
    'ONE rule, one place: `foundryRowFailure` reads the busy line off whichever half of the '
    + 'outcome carries it, so a build whose Foundry states it on the ROW parks exactly as one '
    + 'that states it on the WAIT does');
});

it('cancelled: a stop is not a failure, and the step says so before it throws', async () => {
  fakeRunner({ outcome: 'cancelled', row: { ...A_ROW, state: 'cancelled' } });
  const ctx = stepContext();
  let thrown = null;
  try {
    await foundryJobStep.run(ctx);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a cancel still ends the step');
  assert.strictEqual(runtime.busyLineOf(thrown), undefined, 'a cancel is nobody holding a card');
  assert.ok(/stopped/i.test(thrown.message),
    'somebody spent GPU and took it back; filing that as a failure is how retry() restarts work '
    + `a person just stopped: ${thrown.message}`);
});

it('done: the step finishes, and claims no artifact of its own', async () => {
  fakeRunner({ outcome: 'done', row: A_ROW });
  const made = await foundryJobStep.run(stepContext());
  assert.deepStrictEqual(made, { kind: 'none' },
    "a read's product is a bank inside Foundry's project and a rendering's is announced as a "
    + 'landing; a path invented here would be a second claim about where the work went');
});

// ─────────────────────────────────────────────────────────────────────────────
// The in-flight ledger — P8's hosted half
// ─────────────────────────────────────────────────────────────────────────────

it('onPlaced records the LEASE, and the outcome clears it', async () => {
  let duringTheRun = [];
  fakeRunner((request, opts) => {
    opts.onPlaced({
      server: 'the Mac', model: 'qwen3-30b', leaseId: 'lease-42', concurrency: 4,
    });
    duringTheRun = ledger.readInFlightLedger();
    return { outcome: 'done', row: A_ROW };
  });
  await foundryJobStep.run(stepContext({ stepId: 'step_lease_seam' }));

  assert.strictEqual(duringTheRun.length, 1,
    'THE FINDING (P8): Foundry takes its own Crucible lease inside the vendored dispatcher and '
    + 'recorded it nowhere, so a ctrl-C left a card held by a process that no longer existed '
    + 'with nothing on disk able to name the claim');
  assert.strictEqual(duringTheRun[0].server, 'the Mac');
  assert.strictEqual(duringTheRun[0].jobId, 'lease-42',
    'the LEASE id, because that is what DELETE /v1/leases/{id} takes');
  assert.strictEqual(duringTheRun[0].jobType, 'foundry-lease',
    'and the type is what sends the sweep down the lease route rather than the jobs route');
  assert.strictEqual(duringTheRun[0].model, 'qwen3-30b');
  assert.strictEqual(duringTheRun[0].localId, 'step_lease_seam',
    "this app's own id, so a sweep's log line lands next to a row a person can see");

  assert.deepStrictEqual(ledger.readInFlightLedger(), [],
    'and the settle clears it: a row left behind sends the next startup sweep at a lease '
    + 'Foundry has already given back, which is a DELETE against a stranger\'s claim');
});

it('a placement with NO lease records nothing — there is nothing to release', async () => {
  let duringTheRun = null;
  fakeRunner((request, opts) => {
    opts.onPlaced({ server: '', model: '', leaseId: null, concurrency: 0 });
    duringTheRun = ledger.readInFlightLedger();
    return { outcome: 'done', row: A_ROW };
  });
  await foundryJobStep.run(stepContext());
  assert.deepStrictEqual(duringTheRun, [],
    'an export meets no model, takes no lease and puts nothing on a card; a row for it would '
    + 'be a sweep with nothing to do and a file that grows for no reason');
});

it('the ledger is cleared even when the run THROWS', async () => {
  fakeRunner((request, opts) => {
    opts.onPlaced({ server: 'the Mac', model: 'qwen3', leaseId: 'lease-99', concurrency: 4 });
    throw new Error('the seam itself blew up');
  });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'the throw still ends the step');
  assert.deepStrictEqual(ledger.readInFlightLedger(), [],
    'the record exists to survive a KILL, not a bug: a row that outlives its own run would be '
    + 'swept at a lease nobody holds');
});

// ─────────────────────────────────────────────────────────────────────────────
// What crosses the seam
// ─────────────────────────────────────────────────────────────────────────────

it('the request handed over carries the ROW, and no path under derived/', async () => {
  const calls = fakeRunner({ outcome: 'done', row: A_ROW });
  await foundryJobStep.run(stepContext());
  assert.strictEqual(calls.length, 1);
  const sent = JSON.stringify(calls[0].request);
  assert.ok(!/derived/.test(sent),
    'THE FINDING (F1/F5): a derived book is unlinked by Foundry\'s settle at EVERY ending, and '
    + 'the request outlives its row — Retry re-sends it byte for byte, a resumable Stop leaves '
    + `it on the step, and a restart restores it from disk. The engine said ENOENT: ${sent}`);
  assert.strictEqual(calls[0].request.at, 'step-the-press-was-standing-on',
    'what crosses instead is the row the press pinned, resolved there so a pointer moved while '
    + 'the job waited cannot change which book the spawn makes');
});

it('a rendering states NO venue, and states it rather than omitting it', async () => {
  const calls = fakeRunner({ outcome: 'done', row: A_ROW });
  await foundryJobStep.run(stepContext());
  assert.ok('venue' in calls[0].opts,
    '"this kind does not travel" and "I forgot to say" must not look the same at the seam — '
    + 'which is exactly how a choice made on one screen came to be answered by a setting on '
    + 'another (2026-09-18)');
  assert.strictEqual(calls[0].opts.venue, null,
    'a rendering is arithmetic over a bank already on disk: `resourceFor` calls it cpu and '
    + '`machines()` calls it local, so there is no machine for this side to name');
});

it('both line sinks cross: the row\'s reporter AND the log\'s copy', async () => {
  const calls = fakeRunner({ outcome: 'done', row: A_ROW });
  await foundryJobStep.run(stepContext());
  assert.strictEqual(typeof calls[0].opts.onProgress, 'function');
  assert.strictEqual(typeof calls[0].opts.onLine, 'function',
    'THE FINDING (P5/F7): the CLI wrote to no file, and a night of hosted failures left '
    + '`grep -c "[job]"` answering 0 over every log. `onLine` is the copy Foundry calls in the '
    + "reporter's own finally, so a parser that throws cannot cost the log the line that "
    + 'explains the failure');
  assert.strictEqual(typeof calls[0].opts.onPlaced, 'function');
});

it('no runner at all is a sentence, never a quiet fall back to Foundry\'s queue', async () => {
  hostQueue.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  let thrown = null;
  try {
    await foundryJobStep.run(stepContext());
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown && /Update Foundry/.test(thrown.message),
    'a subtree that predates the seam cannot execute this row, and the honest outcome is a '
    + `failed row naming the reason: ${thrown && thrown.message}`);
});

(async () => {
  console.log('the Foundry runner seam: one act, one venue, one typed outcome');
  for (const run of queued) await run();
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
