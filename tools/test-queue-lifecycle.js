#!/usr/bin/env node
/**
 * WHAT HAPPENS TO A ROW AFTER IT STOPS RUNNING — retry, stop, revive, persist.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-lifecycle.js
 *
 * The scheduler's admission is kept honest by `test-queue-admission.js` and its
 * parks by `test-queue-step-parks.js`. This file is the OTHER half of the
 * engine: the paths a step takes once its work has ended, every one of which
 * was found losing something in the bug hunt of 2026-09-20
 * (`docs/BUG-HUNT-2026-09-20.md`).
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - A RETRY REVIVES THE WHOLE SUBTREE (Q2/F6). A failure cancels everything
 *    under it, transitively; a retry that walked ONE link left a grandchild
 *    cancelled, so Owen's clean re-ran for hours, the export landed, and the
 *    narration it was ordered for never happened and nothing said so.
 *  - NOTHING ERASES THE ACCOUNT OF A FAILURE (P6/F7). `step.error` was the one
 *    persisted copy — the engine's stderr lives in memory and a progress line
 *    overwrites — and both a Retry press and a resumable stop deleted it. It
 *    moves to `lastError`, which no status is derived from.
 *  - A PARK THAT HOLDS THE CARD HAS A CEILING (Q6). A mid-chain reserve refused
 *    for a non-holder reason parked for ever WHILE HOLDING the server's only
 *    slot, re-asking every 15 s, with every other book reading "holding the
 *    card for <title>" and no clock. Four identical answers is a
 *    misconfiguration somebody can repair, and failing is what gives the card
 *    back.
 *  - AN INTERRUPTED ROW KEEPS NO PERCENT (Q9). A render killed during its
 *    session copy came back saying 100%, and the bench reads the number out:
 *    *"Stopped at 100% — it picks up where it left off"*, about a book that is
 *    not there.
 *  - PERSISTENCE IS FENCED (Q10/P7). One tmp name that self-heals, an fsync
 *    before the rename, no legacy `queue.json` resurrection behind a corrupt
 *    modern file, no throw out of `configure` over an unreadable one, and the
 *    `.corrupt-` path said where somebody will see it.
 *  - NO MAP OUTLIVES ITS STEP. Four per-step maps are keyed by step id and
 *    `remove`/`removeStep`/`cancel` cleared none of them.
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
const routes = require(path.join(DIST, 'crucible', 'routes.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-queue-lifecycle-'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await wait(0); };

/** A step module whose run the test settles by hand. */
function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    stopIsResumable: opts.stopIsResumable === true,
    runs,
    run(ctx) {
      const record = { ctx, settled: false };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => {
          record.settled = true;
          resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        };
        record.reject = (err) => { record.settled = true; reject(err); };
      });
      runs.push(record);
      return record.promise;
    },
    // WHAT THE ENGINE TOLD THIS MODULE, kept so S12 can read it: a module's own
    // bridge is what words a stop for the user, so the reason has to arrive here
    // or the sentence on the row is written by a door that does not know.
    cancelledWith: [],
    cancel(stepId, _step, opts) {
      mod.cancelledWith.push(opts === undefined ? null : { ...opts });
      const live = runs.find((r) => r.ctx.stepId === stepId && !r.settled);
      if (live) live.reject(new Error('Stopped by the user.'));
    },
  };
  if (opts.travels === true) mod.machines = () => 'any';
  if (opts.leases === true) {
    mod.leasesModel = () => true;
    mod.crucibleClass = () => opts.act || 'tts';
  }
  return mod;
}

/** The routing record and the prober, scripted. */
function routingHost(ranked, defaultWaitFor = 'mac') {
  return {
    routing: () => ({ ranked: ranked.map((r) => ({ ...r })) }),
    defaultWaitFor: () => defaultWaitFor,
    async reach() { return { reachable: true, busy: null }; },
  };
}

/**
 * The lease seam, scripted: `answer` may return an Error to refuse the reserve.
 * `reserves` is what admission asked of it, which is how the ceiling is counted
 * from the outside.
 */
function leaseSeam(answer) {
  const seam = { reserves: [], closed: [], held: new Map() };
  seam.host = {
    withRowScope(row, fn) { return fn(); },
    async reserveRow(row, where) {
      seam.reserves.push({ row, ...where });
      const said = answer === undefined ? null : answer({ row, ...where });
      if (said instanceof Error) throw said;
      seam.held.set(row, { server: where.server, act: where.act });
    },
    async closeRow(row) { seam.closed.push(row); seam.held.delete(row); },
    leaseHeld(row) { return seam.held.get(row) ?? null; },
  };
  return seam;
}

async function fresh(name, mods, opts = {}) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(opts.host === undefined ? null : opts.host);
  engine.setCrucibleLeaseHost(opts.seam === undefined ? null : opts.seam);
  routes.forgetCrucibleRoutes();
  for (const row of opts.ranked ?? []) {
    routes.noteCrucibleRoutes(row.name, { tts: 'local', align: 'local', clean: 'local' });
  }
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({
    stateDir: dir, admissionRecheckMs: 20, reachSweepMs: 0, ...(opts.configure ?? {}),
  });
  return dir;
}

const jobOf = (id) => engine.snapshot().jobs.find((j) => j.id === id);
const stepAt = (id, i) => jobOf(id).steps[i];

function sendChain(title, steps) {
  const job = engine.enqueue({ title, steps });
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
}

/** The chain the hunt is written about: prepare → tts → align → reassembly. */
function narrationChain(title) {
  return sendChain(title, [
    { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
    { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
    { type: 'align', label: 'Align', config: {}, parentIndex: 1 },
    { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 2 },
  ]);
}

function chainModules() {
  return {
    prep: fakeModule('prepare', { resource: () => 'cpu' }),
    tts: fakeModule('tts-conversion'),
    align: fakeModule('align'),
    asm: fakeModule('reassembly', { resource: () => 'cpu' }),
  };
}

// ── PK16 · Send back to Pending UNASSIGNS THE MACHINE AND KEEPS THE WORK ────

/*
 * THE RULING, and it CORRECTS A MISREADING rather than reversing a decision.
 *
 * Owen, 2026-09-20 ~19:20 ET: *"when i send an item back to pending and then
 * submit back to the queue, it starts its whole thing over and discards all the
 * progress it made. if it already did ai cleanup and tts and only has alignment
 * left, when i send it back, it schedules ai cleanup again."*
 *
 * And, asked what he had meant on 2026-09-18: *"when i said send it back i
 * didnt mean erase progress it already made, i meant it should go back with
 * everything configured so i dont have to re-configure it."*
 *
 * So *"start over with exact same settings"* was about the SETTINGS surviving
 * the trip, and PK7 — which read it as "from zero" and cleared `wasInterrupted`
 * three hours earlier — is superseded by these tests. What the door retires is
 * the MACHINE; what it keeps is everything the book has done and every answer
 * the operator typed.
 */

/** A deep, order-insensitive copy, for "the config was not touched". */
const frozen = (value) => JSON.parse(JSON.stringify(value));

test("PK16 (Owen's case): cleanup and tts stay done; only the alignment re-runs", async () => {
  const clean = fakeModule('foundry-job', { travels: true, produces: 'epub' });
  const tts = fakeModule('tts-conversion', { travels: true, stopIsResumable: true });
  const align = fakeModule('align', { travels: true });
  await fresh('pk16-owens-case', [clean, tts, align], {
    host: routingHost([{ name: 'the-mac', enabled: true }], 'the-mac'),
    seam: leaseSeam().host,
    ranked: [{ name: 'the-mac' }],
  });
  const job = sendChain('Hitler\'s People', [
    {
      type: 'foundry-job',
      label: 'Clean text',
      config: { request: { kind: 'clean' }, voice: 'zac' },
      sourceRef: { kind: 'epub', path: '/a.epub' },
    },
    { type: 'tts-conversion', label: 'Narrate', config: { speed: 1.1 }, parentIndex: 0 },
    { type: 'align', label: 'Align', config: { chapterGap: 3 }, parentIndex: 1 },
  ]);
  const configsBefore = jobOf(job.id).steps.map((s) => frozen(s.config));

  engine.start();
  await settle();
  clean.runs[0].resolve({ kind: 'epub', path: '/out/cleaned.epub' });
  await settle();
  tts.runs[0].resolve({ kind: 'audio-session', path: '/out/sentences' });
  await settle();
  assert.strictEqual(stepAt(job.id, 0).status, 'done', 'precondition: the clean landed');
  assert.strictEqual(stepAt(job.id, 1).status, 'done', 'precondition: the narration landed');
  assert.ok(align.runs[0], 'precondition: the alignment is the only thing left');

  // Stop the alignment by hand so the book is sitting with one act to go —
  // exactly the shape Owen described before pressing Send back to Pending.
  await engine.cancel({ stepId: stepAt(job.id, 2).id }, 'Stopped by the user.');
  await settle();

  await engine.returnToPending(job.id);

  assert.strictEqual(jobOf(job.id).pending, true, 'the book is back in the staging band');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'AND THE MACHINE IS A QUESTION AGAIN — that is the whole of what this door retires');

  assert.strictEqual(stepAt(job.id, 0).status, 'done',
    'THE RULING: "if it already did ai cleanup and tts … when i send it back, it schedules ai '
    + 'cleanup again" — a finished step is history, not work');
  assert.strictEqual(stepAt(job.id, 0).outputPath, '/out/cleaned.epub',
    'with the artifact the steps behind it read');
  assert.strictEqual(stepAt(job.id, 1).status, 'done', 'and the hours of GPU with it');
  assert.strictEqual(stepAt(job.id, 1).outputPath, '/out/sentences');
  assert.strictEqual(stepAt(job.id, 2).status, 'held', 'the only unfinished act goes back to held');
  assert.strictEqual(stepAt(job.id, 2).venue, undefined,
    'the machine it was pencilled in for is not an answer any more');

  assert.deepStrictEqual(
    jobOf(job.id).steps.map((s) => frozen(s.config)), configsBefore,
    'OWEN, VERBATIM: "i meant it should go back with everything configured so i dont have to '
    + 're-configure it" — every answer he typed survives the trip untouched');

  // And the press back out re-runs the alignment and NOTHING ELSE.
  const ranBefore = { clean: clean.runs.length, tts: tts.runs.length, align: align.runs.length };
  engine.sendToQueue(job.id);
  engine.start();
  await settle();
  assert.strictEqual(clean.runs.length, ranBefore.clean,
    'THE COMPLAINT ITSELF: the clean must not be scheduled a second time');
  assert.strictEqual(tts.runs.length, ranBefore.tts,
    'nor the narration — a done step is never re-launched, because `release` moves only held rows '
    + 'and `pump` launches only queued ones');
  assert.strictEqual(align.runs.length, ranBefore.align + 1, 'the alignment, and only it, runs');
});

test('PK16: a half-rendered narration keeps wasInterrupted, so it RESUMES', async () => {
  const prep = fakeModule('prepare', { resource: () => 'cpu' });
  const tts = fakeModule('tts-conversion', { travels: true, stopIsResumable: true });
  await fresh('pk16-resume', [prep, tts], {
    host: routingHost([{ name: 'the-mac', enabled: true }], 'the-mac'),
    seam: leaseSeam().host,
    ranked: [{ name: 'the-mac' }],
  });
  const job = sendChain('Deathstalker', [
    { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
    { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
  ]);
  engine.start();
  await settle();
  prep.runs[0].resolve({
    kind: 'prepared-session', path: '/scratch/ebook-1', sessionId: 'ebook-1',
    detail: { packedForServer: 'the-mac' },
  });
  await settle();
  assert.ok(tts.runs[0], 'precondition: the narration is on the card');

  // A resumable Stop: what sets the resume flag AND (P6) parks the runner's
  // last words in `lastError`.
  await engine.cancel({ stepId: stepAt(job.id, 1).id }, 'Foundry stopped this job.',
    { resumable: true });
  await settle();
  assert.strictEqual(stepAt(job.id, 1).wasInterrupted, true, 'precondition');

  await engine.returnToPending(job.id);

  assert.strictEqual(stepAt(job.id, 0).status, 'done',
    'THE PACK IS KEPT, and it is what makes keeping the resume flag mean anything: the chunks a '
    + 'resumed render skips over are the ones this row wrote');
  assert.strictEqual(stepAt(job.id, 1).status, 'held');
  assert.strictEqual(stepAt(job.id, 1).wasInterrupted, true,
    'PK7 CLEARED THIS AND PK16 KEEPS IT: it is what tells the render to pick the session up at '
    + 'chunk N instead of reading the whole book again');
  assert.ok(typeof stepAt(job.id, 1).lastError === 'string',
    'and the account of the stop is still there to read before pressing Send to queue');
  assert.strictEqual(stepAt(job.id, 1).error, undefined, 'moved, so the row is not red');

  engine.sendToQueue(job.id);
  engine.start();
  await settle();
  assert.strictEqual(prep.runs.length, 1, 'the pack is not cut again');
  assert.strictEqual(tts.runs.length, 2, 'the render goes again…');
  assert.strictEqual(tts.runs[1].ctx.step.wasInterrupted, true,
    '…and the module can still see that it is a resume');
});

test('PK16: a failed step goes back held, carrying its account', async () => {
  const mods = {
    prep: fakeModule('prepare', { resource: () => 'cpu' }),
    tts: fakeModule('tts-conversion', { travels: true, stopIsResumable: true }),
    align: fakeModule('align', { travels: true }),
    asm: fakeModule('reassembly', { resource: () => 'cpu' }),
  };
  await fresh('pk16-failed', Object.values(mods), {
    host: routingHost([{ name: 'the-mac', enabled: true }], 'the-mac'),
    seam: leaseSeam().host,
    ranked: [{ name: 'the-mac' }],
  });
  const job = narrationChain('Pursuit of Power');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  mods.tts.runs[0].resolve({ kind: 'audio', path: '/out/audio' });
  await settle();
  mods.align.runs[0].reject(new Error('whisper died on chapter 4'));
  await settle();
  assert.strictEqual(stepAt(job.id, 2).status, 'failed', 'precondition');
  assert.strictEqual(stepAt(job.id, 3).status, 'cancelled', 'precondition: the cascade');

  await engine.returnToPending(job.id);

  assert.strictEqual(stepAt(job.id, 2).status, 'held', 'the failure goes back to held');
  assert.strictEqual(stepAt(job.id, 2).lastError, 'whisper died on chapter 4',
    'AND ITS ACCOUNT SURVIVES: a book comes back to Pending so somebody can look at it before '
    + 'deciding where it goes next, and "it failed, but the queue has forgotten why" makes that '
    + 'decision impossible');
  assert.strictEqual(stepAt(job.id, 2).error, undefined,
    'on `lastError`, which no status is derived from, so the row is not red (P6/F7)');
  assert.strictEqual(stepAt(job.id, 3).status, 'held', 'the cascade-cancelled child comes back too');
  assert.strictEqual(stepAt(job.id, 1).status, 'done', 'and the render is untouched');
});

/*
 * THE PREPARE DECISION, PINNED.
 *
 * `prepare` packs the book to ONE server's stated band, so a book that lands
 * somewhere else could read its chunks against the wrong cap. The tempting
 * answer — re-pack on every return — was measured against the code and is
 * WRONG: `prepareSession` mints a fresh `ebook-<uuid>` per call, and
 * `tts-conversion` disables every resume mode when a prepare row is in front of
 * it ("A PREPARED SESSION IS NOT A RESUME"), so a re-packed session is a set of
 * file names nothing rendered has. Re-packing on return would throw away the
 * half-rendered book the test above defends — the exact defect this packet is
 * about, arriving by a second road.
 *
 * So the pack is KEPT, and the mismatch is answered where it is actually known:
 * `packingVerdictFor` already refuses chunks over the admitted machine's cap,
 * and that refusal is routed into re-running the prepare row FOR THAT MACHINE
 * instead of failing the book.
 */
test('PK16: a pack cut for another machine re-runs PREPARE, it does not fail the book', async () => {
  const prep = fakeModule('prepare', { resource: () => 'cpu' });
  const tts = fakeModule('tts-conversion', { travels: true, stopIsResumable: true });
  await fresh('pk16-repack', [prep, tts], {
    host: routingHost([{ name: 'the-pc', enabled: true }], 'the-pc'),
    seam: leaseSeam().host,
    ranked: [{ name: 'the-pc' }],
  });
  const job = sendChain('Tender is the Flesh', [
    { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
    { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
  ]);
  engine.start();
  await settle();
  // Packed for the machine the book was on before the operator moved it.
  prep.runs[0].resolve({
    kind: 'prepared-session', path: '/scratch/ebook-1', sessionId: 'ebook-1',
    detail: { packedForServer: 'the-mac', packedCeilingChars: 800 },
  });
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'the-pc',
    'precondition: the render was admitted to the other machine');

  const refusal = Object.assign(
    new Error('crucible_packing_over_venue_cap: packed to 800 for "the-mac", cap 700 on "the-pc".'),
    { repack: true, repackLine: 'packed for the-mac, admitted to the-pc' },
  );
  tts.runs[0].reject(refusal);
  await settle();

  assert.strictEqual(stepAt(job.id, 1).status, 'waiting',
    'THE RENDER IS NOT RED: nothing was submitted, no lease taken, no GPU second spent');
  assert.strictEqual(stepAt(job.id, 1).error, undefined);
  assert.strictEqual(prep.runs.length, 2,
    'THE PACK IS CUT AGAIN — for the machine that actually took the render');
  assert.strictEqual(stepAt(job.id, 0).output, undefined,
    'and its landed artifact went with its `done`: a queued step carrying the previous pack is '
    + 'how a render reads chunks that are no longer there');

  // The pack comes back naming this machine, and the render goes again.
  prep.runs[1].resolve({
    kind: 'prepared-session', path: '/scratch/ebook-2', sessionId: 'ebook-2',
    detail: { packedForServer: 'the-pc', packedCeilingChars: 700 },
  });
  await settle();
  assert.strictEqual(tts.runs.length, 2, 'the render is launched again on the re-packed session');

  // And a SECOND refusal naming the same machine is a misconfiguration, not a
  // loop: the pack already carries that server's name, so nothing would come
  // back different and the row fails with the server's own sentence.
  tts.runs[1].reject(Object.assign(
    new Error('crucible_packing_over_venue_cap: still over the cap on "the-pc".'),
    { repack: true, repackLine: 'still over the cap' },
  ));
  await settle();
  assert.strictEqual(stepAt(job.id, 1).status, 'failed',
    'THE CEILING: a pack already cut for this machine that is still refused is a repair somebody '
    + 'makes, and ruling 3 says that is the only thing a step may fail on');
  assert.strictEqual(prep.runs.length, 2, 'and the pack is not cut a third time');
});

// ── Q2/F6 · Retry revives the whole subtree ─────────────────────────────────

test('Q2/F6: retrying a failed step revives its GRANDCHILDREN too', async () => {
  const mods = chainModules();
  await fresh('retry-subtree', Object.values(mods));
  const job = narrationChain('Hitler\'s People');
  engine.start();
  await settle();

  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  mods.tts.runs[0].reject(new Error('narrator died reading chunk 41'));
  await settle();

  assert.strictEqual(stepAt(job.id, 1).status, 'failed');
  assert.strictEqual(stepAt(job.id, 2).status, 'cancelled', 'the cascade is transitive');
  assert.strictEqual(stepAt(job.id, 3).status, 'cancelled');

  engine.retry({ stepId: stepAt(job.id, 1).id });

  assert.strictEqual(stepAt(job.id, 0).status, 'done', 'the prepare is untouched: it succeeded');
  assert.strictEqual(stepAt(job.id, 1).status, 'held');
  assert.strictEqual(stepAt(job.id, 2).status, 'held', 'the child, as it always was');
  assert.strictEqual(stepAt(job.id, 3).status, 'held',
    'AND THE GRANDCHILD — a render and an align that re-run for hours and then '
    + 'leave the book with no m4b is the defect this line is here for');
  assert.strictEqual(jobOf(job.id).finishedAt, undefined, 'the run is no longer over');
});

test('Q2/F6: a DONE step under the retried one is left alone', async () => {
  // Nothing downstream of a failure is `done` today, because `cascadeCancel`
  // only touches non-terminal rows. The skip is here so a chain that forks
  // later is not owed an hour of GPU by this walk.
  const mods = chainModules();
  await fresh('retry-subtree-done', Object.values(mods));
  const job = narrationChain('Pursuit of Power');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  mods.tts.runs[0].resolve({ kind: 'audio', path: '/out/audio' });
  await settle();
  mods.align.runs[0].resolve({ kind: 'transcript', path: '/out/vtt' });
  await settle();
  mods.asm.runs[0].reject(new Error('ffmpeg exited 1'));
  await settle();

  engine.retry({ stepId: stepAt(job.id, 1).id });
  assert.strictEqual(stepAt(job.id, 1).status, 'held', 'the retried step');
  assert.strictEqual(stepAt(job.id, 2).status, 'done', 'a finished descendant is history, not work');
  assert.strictEqual(stepAt(job.id, 3).status, 'held', 'the failed one goes back');
});

// ── P6/F7 · The account of a failure is kept ────────────────────────────────

test('P6/F7: a retry MOVES the failure to lastError instead of deleting it', async () => {
  const mods = chainModules();
  await fresh('retry-keeps-account', Object.values(mods));
  const job = narrationChain('Lying About Hitler');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  mods.tts.runs[0].reject(new Error('ENOENT: no such file, open \'/scratch/derived.epub\''));
  await settle();

  const failed = stepAt(job.id, 1);
  assert.match(failed.error, /ENOENT/);

  engine.retry({ stepId: failed.id });
  const retried = stepAt(job.id, 1);
  assert.strictEqual(retried.error, undefined, 'the row is not red: it is about to run again');
  assert.match(retried.lastError, /ENOENT/,
    'and the ONE persisted copy of what went wrong survived the press');
});

test('P6/F7: a RESUMABLE STOP keeps the reason too', async () => {
  const tts = fakeModule('tts-conversion', { stopIsResumable: true });
  await fresh('stop-keeps-account', [tts]);
  const job = sendChain('Mistborn', [
    { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
  ]);
  engine.start();
  await settle();
  // A runner that stopped ITSELF with something to say — the shape the hunt
  // found live: a held, interrupted row whose descendants remembered a failure
  // the row denied.
  await engine.cancel({ stepId: stepAt(job.id, 0).id }, 'Foundry stopped this job.',
    { resumable: true });
  await settle();

  const step = stepAt(job.id, 0);
  assert.strictEqual(step.status, 'held', 'resumable: present, not auto-picked');
  assert.strictEqual(step.wasInterrupted, true);
  assert.strictEqual(step.error, undefined, 'a stop is not a failure');
  assert.ok(typeof step.lastError === 'string' && step.lastError.length > 0,
    'but what it was carrying is still readable');
});

// ── Q6 · The reserve-refusal ceiling ────────────────────────────────────────

test('Q6: four identical non-busy reserve refusals FAIL the row, with the last reason',
  async () => {
    /*
     * The park is right — the act never ran and the refusal names the thing to
     * repair — but a book partway through HOLDS its server's card (ruling 9),
     * and a `queued` next act keeps the hold standing. So this park held the
     * machine for ever. Owen's ruling 2: four consecutive identical answers is
     * a misconfiguration somebody can repair, which is the one thing a step may
     * fail on.
     */
    const reason = 'crucible "mac" names no model for align work (model_not_resident).';
    const tts = fakeModule('tts-conversion', { travels: true, leases: true, act: 'tts' });
    const align = fakeModule('align', { travels: true, leases: true, act: 'align' });
    const seam = leaseSeam(({ act }) => (act === 'align' ? new Error(reason) : null));
    const ranked = [{ name: 'mac', enabled: true }];
    await fresh('reserve-ceiling', [tts, align], {
      host: routingHost(ranked), seam: seam.host, ranked,
    });

    const job = sendChain('Deathstalker', [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'align', label: 'Align', config: {}, parentIndex: 0 },
    ]);
    engine.start();
    await settle();
    tts.runs[0].resolve({ kind: 'audio', path: '/out/audio' });
    await settle();

    // The refusals arrive one per admission tick (20 ms here). Wait out enough
    // of them that the ceiling must have been reached, then read the row.
    const ceiling = engine.RESERVE_REFUSAL_CEILING;
    assert.strictEqual(ceiling, 4, 'ruling 2: four, about a minute at the 15 s tick');
    for (let i = 0; i < ceiling + 4 && stepAt(job.id, 1).status !== 'failed'; i += 1) {
      await wait(40);
      await settle();
    }

    const step = stepAt(job.id, 1);
    assert.strictEqual(step.status, 'failed',
      'a park that holds the card cannot be allowed to hold it for ever');
    assert.strictEqual(step.error, reason,
      'and the error IS the server\'s own sentence, verbatim — that is what a repair reads');
    assert.ok(seam.reserves.filter((r) => r.act === 'align').length >= ceiling,
      'it was asked the full count of times before it gave up');
  });

test('Q6: a DIFFERENT refusal restarts the count — the server is saying something new',
  async () => {
    let nth = 0;
    const tts = fakeModule('tts-conversion', { travels: true, leases: true, act: 'tts' });
    const align = fakeModule('align', { travels: true, leases: true, act: 'align' });
    // Every answer differs, so no streak can ever reach the ceiling.
    const seam = leaseSeam(({ act }) => {
      if (act !== 'align') return null;
      nth += 1;
      return new Error(`refusal number ${nth}`);
    });
    const ranked = [{ name: 'mac', enabled: true }];
    await fresh('reserve-ceiling-varied', [tts, align], {
      host: routingHost(ranked), seam: seam.host, ranked,
    });

    const job = sendChain('Deathstalker II', [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'align', label: 'Align', config: {}, parentIndex: 0 },
    ]);
    engine.start();
    await settle();
    tts.runs[0].resolve({ kind: 'audio', path: '/out/audio' });
    await settle();

    for (let i = 0; i < 8; i += 1) { await wait(40); await settle(); }
    assert.ok(nth > engine.RESERVE_REFUSAL_CEILING,
      `it was refused more than the ceiling (${nth} times)`);
    assert.strictEqual(stepAt(job.id, 1).status, 'queued',
      'but never the same answer twice running, so the row is owed its patience');
  });

// ── Q9 · An interrupted row keeps no percent ────────────────────────────────

test('Q9: a row revived after a kill carries the message and NOTHING else', async () => {
  const tts = fakeModule('tts-conversion');
  const dir = await fresh('revive-percent', [tts]);
  const job = sendChain('Tender Is the Night', [
    { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
  ]);
  engine.start();
  await settle();
  // The render reports 100% and then the process dies during the session copy —
  // S7's "TTS 100%", the shape that made the bench promise a book that is not
  // there.
  tts.runs[0].ctx.report({ percent: 100, message: 'caching the session' });
  await engine.persist();

  // A new process reads the file it left behind.
  await fresh('revive-percent', [tts], { configure: { stateDir: dir } });
  const revived = stepAt(job.id, 0);
  assert.strictEqual(revived.status, 'held');
  assert.strictEqual(revived.wasInterrupted, true);
  assert.match(revived.progress.message, /Interrupted when BookForge closed/);
  assert.strictEqual(revived.progress.percent, undefined,
    'the percent was measured against a session this process cannot see');
  assert.deepStrictEqual(Object.keys(revived.progress), ['message'],
    'nothing else of the dead run survives either');
});

// ── Q10/P7 · Persistence ────────────────────────────────────────────────────

test('Q10/P7: the temp file has ONE name, so a kill cannot orphan a second', async () => {
  const tts = fakeModule('tts-conversion');
  const dir = await fresh('persist-tmp', [tts]);
  for (let i = 0; i < 5; i += 1) {
    sendChain(`Book ${i}`, [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
    ]);
    await engine.persist();
  }
  const left = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepStrictEqual(left, [],
    'the rename takes it away, and the next write truncates it — never a new name per write');
  const src = fs.readFileSync(path.join(REPO, 'electron', 'queue-engine.ts'), 'utf-8');
  assert.ok(/const tmp = `\$\{target\}\.tmp`;/.test(src), 'one fixed name');
  assert.ok(/await handle\.sync\(\);/.test(src),
    'and an fsync before the rename: a rename is atomic against a crash, not a power cut');
});

test('Q10/P7: configure sweeps the orphans the old unique-named writes left', async () => {
  const tts = fakeModule('tts-conversion');
  const dir = path.join(SCRATCH, 'persist-sweep');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue-engine.json.tmp-901-1758300000000'), '', 'utf-8');
  fs.writeFileSync(path.join(dir, 'queue-engine.json.tmp-902-1758300000001'), '{"jobs":[]}', 'utf-8');
  const keep = path.join(dir, 'queue-engine.json.corrupt-1758300000002');
  fs.writeFileSync(keep, 'not json', 'utf-8');

  await fresh('persist-sweep', [tts], { configure: { stateDir: dir } });
  const left = fs.readdirSync(dir);
  assert.ok(!left.some((n) => n.includes('.tmp-')), 'the dead ones are gone');
  assert.ok(fs.existsSync(keep),
    'and a PRESERVED queue is not litter — it is named so it survives');
});

test('Q10: a corrupt queue is preserved, said out loud, and does NOT resurrect queue.json',
  async () => {
    const tts = fakeModule('tts-conversion');
    const dir = path.join(SCRATCH, 'persist-corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue-engine.json'), '{"jobs": [ {"id"', 'utf-8');
    // The retired renderer blob, sitting right beside it. A corrupt modern file
    // answered `false` — the same answer as "there has never been one" — so this
    // was migrated and drawn as the current queue.
    const legacy = path.join(dir, 'queue.json');
    fs.writeFileSync(legacy, JSON.stringify([{
      id: 'old_1', type: 'audiobook', status: 'pending', epubPath: '/ancient.epub',
      metadata: { title: 'An Ancient Run' },
    }]), 'utf-8');

    await fresh('persist-corrupt', [tts], { configure: { stateDir: dir, legacyQueueFile: legacy } });

    assert.deepStrictEqual(engine.snapshot().jobs, [],
      'an unparseable queue starts EMPTY — never as whatever the last format held');
    const preserved = fs.readdirSync(dir).filter((n) => n.startsWith('queue-engine.json.corrupt-'));
    assert.strictEqual(preserved.length, 1, 'the file is kept under a name that says so');
    const report = engine.waitForMigrationReport();
    assert.ok(report !== null && report.includes(preserved[0]),
      `and the path is surfaced where main logs it; got: ${report}`);
  });

test('Q10: an UNREADABLE queue is an empty queue and a sentence, never a dead app', async () => {
  const tts = fakeModule('tts-conversion');
  const dir = path.join(SCRATCH, 'persist-unreadable');
  fs.mkdirSync(dir, { recursive: true });
  // A directory where the file should be: `readFile` answers EISDIR, which is
  // the same class of answer as a volume that has not mounted — the live cause
  // (`configure` is awaited by `startQueueEngine`, so it took startup down).
  fs.mkdirSync(path.join(dir, 'queue-engine.json'), { recursive: true });

  await fresh('persist-unreadable', [tts], { configure: { stateDir: dir } });
  assert.deepStrictEqual(engine.snapshot().jobs, []);
  const report = engine.waitForMigrationReport();
  assert.ok(report !== null && /could not be read/.test(report),
    `the reason is carried out rather than thrown; got: ${report}`);
});

// ── S12 · One fact, one sentence; and Running picks up what the close cut ───

/*
 * THE FINDING (bug hunt round 2, S12). Owen relaunched on 2026-09-20 and found
 * two narration rows aimed at two IDLE Crucible servers reading *"Stopped by
 * user — press Start to resume"*. He had stopped neither; the quit had. The
 * bridge's one stop door wore the Stop button's sentence for both gestures,
 * while the hard-kill revive wrote a different sentence for the same fact. Then
 * he pressed Running and the two books did not move: *"it isn't accepting
 * anything even though some in the queue are assigned to it."*
 *
 * Both halves are one field — `QueueStep.stopReason` — and these four checks
 * are what it is for.
 */

const STOP_REASON = require(path.join(DIST, '..', 'shared', 'queue', 'stop-reason.js'));

test('S12: a stop that is the APP CLOSING does not blame the user', async () => {
  const mods = chainModules();
  mods.tts.stopIsResumable = true;
  await fresh('s12-closed-sentence', Object.values(mods));
  const job = narrationChain('Shift - Book 2');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.ok(mods.tts.runs[0], 'precondition: the narration is on the card');

  await engine.cancel({ stepId: stepAt(job.id, 1).id }, 'BookForge is closing.',
    { resumable: true, stopReason: 'closed' });
  await settle();

  const step = stepAt(job.id, 1);
  assert.strictEqual(step.status, 'held', 'a close is resumable, exactly like a stop');
  assert.strictEqual(step.wasInterrupted, true);
  assert.strictEqual(step.stopReason, 'closed', 'THE FINDING: whose gesture it was is recorded');
  assert.strictEqual(step.progress.message,
    STOP_REASON.stopSentence('closed'),
    'and the row wears the SAME sentence the hard-kill revive writes — one fact, one sentence');
  assert.strictEqual(step.progress.percent, undefined,
    'with no percent: it was measured against a session this process is losing (Q9)');
  // The module was told, because ITS bridge is what words the stop for the user.
  assert.deepStrictEqual(mods.tts.cancelledWith, [{ reason: 'closed' }],
    'the reason reaches the module, which is where the bridge writes its own line');
});

test('S12: a USER stop keeps its own sentence and its percent', async () => {
  const mods = chainModules();
  mods.tts.stopIsResumable = true;
  await fresh('s12-user-sentence', Object.values(mods));
  const job = narrationChain('Wool');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  // What the bridge reports for a live render, so the percent has somewhere to
  // come from — a user stop has just flushed those chunks to the durable cache,
  // which is why "Stopped at 61%" is true of it and not of a close.
  mods.tts.runs[0].ctx.report({ percent: 61 });

  await engine.cancel({ stepId: stepAt(job.id, 1).id }, 'Stopped by the user.',
    { resumable: true });
  await settle();

  const step = stepAt(job.id, 1);
  assert.strictEqual(step.stopReason, 'user', 'the default gesture is a person');
  assert.strictEqual(step.progress.percent, 61,
    'a user stop keeps what it rendered: the cache has it and the row may say so');
  assert.deepStrictEqual(mods.tts.cancelledWith, [{ reason: 'user' }]);
});

test('S12: Running releases what the CLOSE interrupted and leaves a user stop held', async () => {
  const mods = chainModules();
  mods.tts.stopIsResumable = true;
  await fresh('s12-running-releases', Object.values(mods));
  const closed = narrationChain('Shift - Book 2');
  const stopped = narrationChain('Wool');
  engine.start();
  await settle();
  for (const job of [closed, stopped]) {
    const prep = mods.prep.runs.find((r) => r.ctx.jobId === job.id);
    prep.resolve({ kind: 'prepared-session', path: '/out/prepared' });
  }
  await settle();

  await engine.cancel({ stepId: stepAt(closed.id, 1).id }, 'BookForge is closing.',
    { resumable: true, stopReason: 'closed' });
  await engine.cancel({ stepId: stepAt(stopped.id, 1).id }, 'Stopped by the user.',
    { resumable: true });
  await settle();
  assert.strictEqual(stepAt(closed.id, 1).status, 'held', 'precondition');
  assert.strictEqual(stepAt(stopped.id, 1).status, 'held', 'precondition');

  // The press Owen made: the toolbar's Running, which is `start()` with no target.
  engine.start();
  await settle();

  assert.notStrictEqual(stepAt(closed.id, 1).status, 'held',
    'THE FINDING: Running skipped the very books it was pressed for — a row the close '
    + 'interrupted is one nobody asked to stop');
  assert.strictEqual(stepAt(stopped.id, 1).status, 'held',
    'and a row somebody stopped BY HAND waits for its own press: they took the card back '
    + 'on purpose (StepStatus: "needs an explicit gesture")');

  // …which the per-row ▶ is. A TARGETED press releases it.
  engine.start({ stepId: stepAt(stopped.id, 1).id });
  await settle();
  assert.notStrictEqual(stepAt(stopped.id, 1).status, 'held',
    'the explicit gesture releases the row it names');
});

test('S12: a closed-interrupted step behind an unfinished parent stays WAITING', async () => {
  /*
   * The shape Owen's own queue was in: a `tts-conversion` the close interrupted,
   * with `align` and `reassembly` behind it. RELEASED is not RUNNABLE — the row
   * Running picks back up is the one whose parent has landed, and the rest of
   * the chain goes back to waiting on it, which is what it was doing before
   * anybody quit.
   *
   * Built through a persist and a reload, because that is the only door that
   * mints this state: a kill leaves the row `running` on disk and
   * `reviveInterrupted` is what reads it as a close.
   */
  const mods = chainModules();
  const dir = await fresh('s12-waiting-parent', Object.values(mods));
  const job = narrationChain('Hitler\'s People');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.strictEqual(stepAt(job.id, 1).status, 'running', 'precondition: the render is on the card');
  await engine.persist();

  // A new process reads the file the kill left behind.
  await fresh('s12-waiting-parent', Object.values(mods), { configure: { stateDir: dir } });
  assert.strictEqual(stepAt(job.id, 1).stopReason, 'closed',
    'the revive agrees with the orderly quit about what ended it');
  assert.strictEqual(stepAt(job.id, 2).status, 'waiting', 'Align was released before the kill');

  engine.start();
  await settle();

  assert.notStrictEqual(stepAt(job.id, 1).status, 'held',
    'the row the close cut is back in play — its parent landed before the kill, so it is '
    + 'released and (nothing else wanting the card) straight onto it');
  assert.strictEqual(stepAt(job.id, 2).status, 'waiting',
    'and the step behind it waits on it, exactly as it did before the app went');
});

test('S12: `shutdown` stamps what it is on the work it is ending', async () => {
  const mods = chainModules();
  mods.tts.stopIsResumable = true;
  await fresh('s12-shutdown-stamp', Object.values(mods));
  const job = narrationChain('Pursuit of Power');
  engine.start();
  await settle();
  mods.prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.strictEqual(stepAt(job.id, 1).status, 'running', 'precondition');

  await engine.shutdown();

  assert.strictEqual(stepAt(job.id, 1).stopReason, 'closed',
    'a row still running when the app quits is interrupted by the close, whichever door '
    + 'reaches it — the teardown, or the process simply going');

  // And from that moment a stop that does not name a reason is the CLOSE: the
  // renderer is still alive during the quit and nothing can enumerate its doors.
  await engine.cancel({ stepId: stepAt(job.id, 1).id }, 'torn down', { resumable: true });
  await settle();
  assert.strictEqual(stepAt(job.id, 1).stopReason, 'closed',
    'the ambient fact answers for every door the quit chain cannot name');
});

test('S12: `closedInterrupted` reads an OLD row — no reason, interrupted — as a close', () => {
  // Every queue written before the field existed looks like this, and it was
  // written overwhelmingly by the revive path, which is a close. See the
  // predicate's own docstring for what the other reading would have cost.
  assert.strictEqual(
    STOP_REASON.closedInterrupted({ status: 'held', wasInterrupted: true }), true);
  assert.strictEqual(
    STOP_REASON.closedInterrupted({ status: 'held', wasInterrupted: true, stopReason: 'user' }),
    false, 'a stated user stop is never read as a close');
  assert.strictEqual(
    STOP_REASON.closedInterrupted({ status: 'queued', wasInterrupted: true }), false,
    'only a HELD row is waiting for a gesture');
  assert.strictEqual(STOP_REASON.userStopped({ status: 'held', stopReason: 'user' }), true);
  assert.strictEqual(STOP_REASON.userStopped({ status: 'held', wasInterrupted: true }), false);
  assert.notStrictEqual(STOP_REASON.stopSentence('user'), STOP_REASON.stopSentence('closed'),
    'two gestures, two sentences — and exactly one copy of each in the tree');
});

// ── The per-step maps ───────────────────────────────────────────────────────

test('no per-step park outlives its step — remove, removeStep and cancel clear them', () => {
  /*
   * A leak rather than a bug, until a COUNT decides whether a row fails (Q6) —
   * at which point a stale entry keyed by a recycled id is a wrong answer.
   * Asserted on the source because the maps are module-private by design: the
   * defence is that there is ONE door, so a fifth map cannot be added and
   * forgotten by four callers.
   */
  const src = fs.readFileSync(path.join(REPO, 'electron', 'queue-engine.ts'), 'utf-8');
  const door = /function forgetStepParks\(stepId: string\): void \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(door !== null, 'the one door exists');
  for (const map of ['heldTailParks', 'transientParks', 'reserveHolds', 'reserveRefusals']) {
    assert.ok(door[1].includes(`${map}.delete(stepId)`), `${map} is forgotten there`);
  }
  for (const caller of ['launch', 'settleNotStarted', 'cascadeCancel', 'removeStep', 'remove']) {
    const body = new RegExp(
      `(async )?function ${caller}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`).exec(src);
    assert.ok(body !== null, `${caller} is in the file`);
    assert.ok(/forgetStepParks\(/.test(body[0]),
      `${caller} forgets the parks of the rows it disposes of`);
  }
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${err && err.message}`);
    }
  }
  engine.setCrucibleRoutingHost(null);
  engine.setCrucibleLeaseHost(null);
  routes.forgetCrucibleRoutes();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  console.log(`\nqueue lifecycle: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
