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
    cancel(stepId) {
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

// ── PK7 · A return to Pending is a START OVER ───────────────────────────────

/*
 * THE FINDING (bug hunt round 2). `returnToPending` clears output, metrics,
 * progress, notes, timestamps and the venue — and left `wasInterrupted`
 * standing. That flag is not decoration: it is what tells TTS to resume the
 * cached session instead of rendering from sentence zero. So Owen's *"move it
 * back to the queue to start over with exact same settings"* re-adopted the
 * session of the very attempt he had just pulled out of the queue, on whatever
 * machine he then picked. `lastError` goes with it: a staged run has no
 * "attempt before this one" to account for.
 */
test('PK7: a run sent back to Pending resumes NOTHING', async () => {
  const prep = fakeModule('prepare', { resource: () => 'cpu' });
  const tts = fakeModule('tts-conversion', { travels: true, stopIsResumable: true });
  await fresh('return-to-pending', [prep, tts], {
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
  prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.ok(tts.runs[0], 'precondition: the narration is on the card');

  // The exact state the hunt found live: a resumable Stop, which is what sets
  // the resume flag AND (P6) parks the runner's last words in `lastError`.
  await engine.cancel({ stepId: stepAt(job.id, 1).id }, 'Foundry stopped this job.',
    { resumable: true });
  await settle();
  assert.strictEqual(stepAt(job.id, 1).wasInterrupted, true,
    'precondition: a resumable stop is exactly what promises a resume');
  assert.ok(typeof stepAt(job.id, 1).lastError === 'string',
    'precondition (P6): and the account of it is kept');

  await engine.returnToPending(job.id);

  assert.strictEqual(jobOf(job.id).pending, true);
  // The row the finding is about, named before the sweep, so a failure here
  // reads as itself rather than as whichever step the loop reached first.
  assert.strictEqual(stepAt(job.id, 1).wasInterrupted, undefined,
    'THE FINDING: the narration still said "interrupted", so the next press RESUMED the session '
    + 'of the attempt Owen had just pulled out of the queue to start over');
  assert.strictEqual(stepAt(job.id, 1).lastError, undefined,
    'and a staged run has no attempt before this one to account for');

  for (const step of jobOf(job.id).steps) {
    assert.strictEqual(step.status, 'held', step.label);
    assert.strictEqual(step.wasInterrupted, undefined,
      `${step.label}: THE FINDING — a returned run that still says "interrupted" is resumed by `
      + 'the next press, so "start over" restarts nothing and the old session is re-adopted');
    assert.strictEqual(step.lastError, undefined,
      `${step.label}: a staged run has no attempt before this one to account for`);
    assert.strictEqual(step.error, undefined, step.label);
    assert.strictEqual(step.venue, undefined, step.label);
  }
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
