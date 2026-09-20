#!/usr/bin/env node
/**
 * A WHOLE BOOK, THROUGH A SERVER THAT MISBEHAVES THE WAY THE REAL ONES DID.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chaos-book.js
 *
 * ── Owen's ruling, which is the whole specification ─────────────────────────
 *
 * *"the system is entirely too fragile. harden it so it works correctly. the no
 * fallbacks rule is about unexpected codepaths and band-aids."*
 *
 * So: **a transient fault must end in completion or in a PARK with a sentence,
 * never in a failed row.** Fail-by-name is for misconfiguration — a thing a
 * person can repair — and for nothing else. A reset socket, a restarted server,
 * a card somebody else is holding, a stream that went quiet, a 503 from an
 * engine reloading: none of them is a person's mistake, and every one of them
 * turned a row red on the night of 2026-09-19 (`docs/BUG-HUNT-2026-09-20.md`
 * §0, the fourteen live failures S1–S14).
 *
 * ── What this drives, and what it fakes ─────────────────────────────────────
 *
 * The REAL queue engine (`electron/queue-engine.ts`) with its seams injected,
 * and the REAL Crucible doors (`crucible/job.ts`, `crucible/render.ts`) against
 * a fault-injecting fake server on 127.0.0.1 — so the join under test is the
 * one the night turned on: **a door mints a refusal and the engine classifies
 * it.** Where a scenario needs a door's own refusal, the error the engine is
 * handed is the object the door actually threw, never a re-spelling of it.
 *
 * FAKED, and named here rather than discovered by a reader: the step BODIES of
 * `prepare`, `tts-conversion`, `align` and `reassembly`. Each spawns a python
 * narrator against a real session tree, and none of them can run on a machine
 * with no model and no GPU. What they are replaced by is a module that throws
 * the door's real refusal, or resolves — which is exactly the part of them the
 * queue can see. The step modules' OWN logic (packing, session resolution) is
 * pinned by their own keepers; what is pinned here is the lifecycle around them.
 *
 * ── Every scenario asserts the END STATE, not the path ──────────────────────
 *
 * Every step `done`, or the affected step `queued` carrying a park sentence
 * (`progress.admissionHold`) that names the cause — and NEVER `failed` for a
 * transient. Plus, for every scenario that ran a real door: the in-flight
 * ledger is empty, the fake server is holding nothing of ours, and the
 * persisted `queue-engine.json` round-trips to the same states.
 *
 * One line per scenario: `PASS`, `FAIL` or `PENDING-<packet>` for work another
 * packet is building. A `FAIL` prints the step, its status, its error and the
 * fake server's request log tail — the input to the next hardening packet.
 *
 * No GPU, no model, no network beyond 127.0.0.1, no library.
 *
 * ── AND THE SAME HARNESS AGAINST A REAL CRUCIBLE ────────────────────────────
 *
 *   node tools/test-chaos-book.js --real <server-name>
 *
 * Owen, 2026-09-20: *"we have a real crucible to test against."* The fake keeps
 * what only a fake can do — a socket destroyed at a chosen byte, a server that
 * forgets everything between two frames, a sub-second race run the same way
 * every time — and that is the half that belongs in the keeper set. What a fake
 * can never tell you is whether the SERVER agrees, and that is this mode: the
 * same doors, the same assertions, against a live engine.
 *
 * The rules it runs under, every one of them a refusal rather than a comment:
 *
 *  - THE SERVER IS NAMED, ALWAYS. There is no default, no "first enabled", no
 *    search. `--real` with no name, or a name not in the registry, refuses.
 *  - IT MUST BE IDLE. Anything resident, running, queued, claimed, leased,
 *    streaming or mid-chat and this refuses to start — a suite that interrupted
 *    a nine-hour narration to measure a cancel would be the defect it is looking
 *    for.
 *  - IT IS LEFT AS IT WAS FOUND, and that is asserted at the end: the same
 *    resident (which is normally nothing), no lease, no job of ours.
 *  - NOTHING THAT NEEDS A KILLED PROCESS OR A CHOSEN BYTE runs here. Those are
 *    the fake's, and asking a real server to be killed is not a test, it is an
 *    outage.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const H = require('./chaos-engine-harness.js');
const {
  startFakeCrucible, fakeNamer, faultyJobRoutes, leaseRoutes, cancelRefusedFault,
} = require('./fake-crucible.js');
const { skipLine } = require('./keeper-skip.js');

for (const needed of ['queue-engine.js', 'crucible/job.js', 'crucible/render.js', 'crucible/in-flight-ledger.js']) {
  if (!H.built(needed)) {
    console.log(skipLine(`dist/electron/${needed} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}

/*
 * ── WHICH MODE, AND WHICH SERVER ───────────────────────────────────────────
 *
 * `--real <name>` and nothing else. The name is REQUIRED and is matched against
 * the app's own registry; there is no default server and no search, because the
 * one thing this must never do is find a machine somebody is using and submit
 * work to it.
 */
const argv = process.argv.slice(2);
const realFlag = argv.indexOf('--real');
const REAL_SERVER = realFlag === -1 ? null : argv[realFlag + 1];
if (realFlag !== -1 && (REAL_SERVER === undefined || REAL_SERVER.startsWith('--'))) {
  console.error('--real needs the NAME of a registered Crucible server: '
    + 'node tools/test-chaos-book.js --real "crucible@<machine>"');
  process.exit(2);
}

/**
 * The app's own `crucible-servers.json`, at the platform path `servers.ts`
 * reads it from — composed from `os.homedir()` rather than written down,
 * because a tracked file may not carry a home path (`test-no-machine-addresses`).
 */
function appUserDataDir() {
  const home = require('os').homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BookForge');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BookForge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'BookForge');
}

/**
 * Put the ONE named server into this run's temp registry, so every door reaches
 * it through `crucibleClientFor` exactly as the app does — and so a name this
 * run was not given is not even present to be reached by accident.
 */
function adoptRealServer(name) {
  const file = path.join(appUserDataDir(), 'crucible-servers.json');
  if (!fs.existsSync(file)) {
    throw new Error(`there is no Crucible registry at ${file} — nothing to test against`);
  }
  const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const rows = Array.isArray(record.servers) ? record.servers : [];
  const row = rows.find((r) => r.name === name);
  if (row === undefined) {
    throw new Error(`no Crucible server named ${JSON.stringify(name)} is registered. `
      + `Registered: ${rows.map((r) => r.name).join(', ') || '(none)'}`);
  }
  fs.writeFileSync(
    path.join(H.USER_DATA, 'crucible-servers.json'),
    JSON.stringify({ servers: [row] }, null, 2),
  );
  return row;
}

const crucibleJob = require(path.join(H.DIST, 'crucible', 'job.js'));
const servers = require(path.join(H.DIST, 'crucible', 'servers.js'));
const sweep = require(path.join(H.DIST, 'crucible', 'in-flight-sweep.js'));
const registerFake = fakeNamer(servers);

// ────────────────────────────────────────────────────────────────────────────
// The runner
// ────────────────────────────────────────────────────────────────────────────

const results = [];
const scenarios = [];
/** The set that only a LIVE server can answer. See the header. */
const realScenarios = [];
function realScenario(id, title, fn, opts = {}) {
  realScenarios.push({ id, title, fn, pendingPacket: opts.pendingPacket });
}

/**
 * `pendingPacket` is the honest half of this suite: a scenario whose behaviour
 * another packet is building right now must be RUN and REPORTED, not omitted.
 * It prints `PENDING-PK10` with what it observed, and does not fail the suite —
 * and the day PK10 lands it turns green with no edit here.
 */
function scenario(id, title, fn, opts = {}) {
  scenarios.push({ id, title, fn, pendingPacket: opts.pendingPacket });
}

async function runAll() {
  const set = REAL_SERVER === null ? scenarios : realScenarios;
  if (REAL_SERVER !== null) {
    const row = adoptRealServer(REAL_SERVER);
    console.log(`against the REAL ${row.name} at ${new URL(row.url).host}\n`);
  }
  for (const s of set) {
    let note = '';
    let outcome = 'PASS';
    let detail = null;
    try {
      detail = await s.fn();
      note = typeof detail === 'string' ? detail : (detail && detail.note) || '';
    } catch (err) {
      outcome = s.pendingPacket ? `PENDING-${s.pendingPacket}` : 'FAIL';
      note = err && err.message ? err.message.split('\n')[0] : String(err);
      detail = err;
    }
    results.push({ id: s.id, title: s.title, outcome, note, detail });
    const head = outcome === 'PASS' ? 'PASS' : outcome;
    console.log(`${head.padEnd(13)} ${s.id.padEnd(22)} ${s.title}`);
    if (note) console.log(`              ${note}`);
    if (outcome !== 'PASS' && detail && detail.stack) {
      console.log(detail.stack.split('\n').slice(1, 4).map((l) => `              ${l.trim()}`).join('\n'));
    }
    if (outcome !== 'PASS' && detail && detail.endState) {
      console.log(`              end state: ${JSON.stringify(detail.endState)}`);
    }
    await H.quiesce();
  }

  if (REAL_SERVER !== null) await leaveAsFound();

  const failed = results.filter((r) => r.outcome === 'FAIL');
  const pending = results.filter((r) => r.outcome.startsWith('PENDING'));
  console.log(`\ntest-chaos-book: ${results.length - failed.length - pending.length} passed, `
    + `${failed.length} failed, ${pending.length} pending`);
  if (failed.length) {
    console.log('  failed: ' + failed.map((r) => r.id).join(', '));
    process.exitCode = 1;
  }
  if (pending.length) console.log('  pending: ' + pending.map((r) => `${r.id} (${r.outcome})`).join(', '));
}

/**
 * THE THREE THINGS EVERY SCENARIO OWES, whatever it was about.
 *
 * A run that completed while leaving a job on somebody's card, a ledger row
 * naming a job nobody will ever settle, or a queue file that comes back as a
 * different queue, has not finished — it has stopped.
 */
function assertNothingLeftBehind(jobId, fake, what) {
  const left = H.ledger.readInFlightLedger();
  assert.strictEqual(left.length, 0,
    `${what}: the in-flight ledger still names ${JSON.stringify(left)} — a row nobody will settle `
    + 'is a card held by a process that has forgotten it');
  if (fake && fake.routes) {
    assert.deepStrictEqual(fake.routes.jobs.live(), [],
      `${what}: the fake server is still running ${JSON.stringify(fake.routes.jobs.live())} for us`);
  }
}

/** Every step `done`. */
function assertAllDone(jobId, what) {
  const state = H.endStateOf(jobId);
  for (const step of state.steps) {
    if (step.status !== 'done') {
      throw Object.assign(
        new Error(`${what}: ${step.label} is ${step.status}${step.error ? ` — ${step.error}` : ''}`),
        { endState: state },
      );
    }
  }
  return state;
}

/** A step PARKED: back in the queue, no error, and a sentence saying why. */
function assertParked(jobId, index, what, expect = {}) {
  const state = H.endStateOf(jobId);
  const step = state.steps[index];
  const fail = (msg) => { throw Object.assign(new Error(`${what}: ${msg}`), { endState: state }); };
  if (step.status === 'failed') {
    fail(`THE ROW FAILED on a transient — "${step.error}". Owen's ruling: a fault nobody can `
      + 'repair must park, not redden.');
  }
  if (step.status !== 'queued') fail(`${step.label} is ${step.status}, not queued`);
  if (step.error !== undefined) fail(`a parked row carries no error, and this one carries "${step.error}"`);
  if (typeof step.hold !== 'string' || step.hold === '') {
    fail('a park with no sentence reads to an operator as a stall with no cause');
  }
  if (expect.mentions) {
    for (const word of expect.mentions) {
      if (!step.hold.toLowerCase().includes(word.toLowerCase())) {
        fail(`the park sentence "${step.hold}" does not name ${word}`);
      }
    }
  }
  return step;
}

/** The fake server's request log tail, for a FAIL's report. */
function requestTail(fake, n = 12) {
  return fake.state.requests.slice(-n).map((r) => `${r.method} ${r.path}${r.fault ? ` [${r.fault}]` : ''}`);
}

// ────────────────────────────────────────────────────────────────────────────
// The shape of a book
// ────────────────────────────────────────────────────────────────────────────

const ONE_SERVER = [{ name: 'mac', enabled: true }];
const TWO_SERVERS = [{ name: 'pc', enabled: true }, { name: 'mac', enabled: true }];

/**
 * The narration chain's SHAPE, with fake bodies: prepare (CPU) → tts (GPU) →
 * align (GPU) → reassembly (CPU). `shared/queue/narration-run.ts` composes the
 * real one out of a project on disk; what the queue sees is four rows in a line
 * with those resources, which is what every scenario here is about.
 */
function narrationSpec(title, opts = {}) {
  return {
    title,
    projectId: opts.projectId || '/tmp/chaos/project',
    steps: [
      {
        type: 'prepare', label: 'Prepare', config: { bfpPath: '/tmp/chaos/project' },
        sourceRef: { kind: 'epub', path: '/tmp/chaos/book.epub' },
      },
      { type: 'tts-conversion', label: 'Narrate', config: { bfpPath: '/tmp/chaos/project' }, parentIndex: 0 },
      { type: 'align', label: 'Align', config: { bfpPath: '/tmp/chaos/project' }, parentIndex: 1 },
      { type: 'reassembly', label: 'Assemble', config: { bfpPath: '/tmp/chaos/project' }, parentIndex: 2 },
    ],
  };
}

/** The four modules of that chain, each a fake whose fault a scenario states. */
function narrationModules(faults = {}) {
  return {
    prepare: H.fakeModule('prepare', {
      produces: 'sentences', resource: () => 'cpu', travels: false, ...(faults.prepare || {}),
    }),
    tts: H.fakeModule('tts-conversion', {
      consumes: 'sentences', produces: 'audio-session', resource: () => 'gpu',
      stopIsResumable: true, ...(faults.tts || {}),
    }),
    align: H.fakeModule('align', {
      consumes: 'audio-session', produces: 'audio-session', resource: () => 'gpu', ...(faults.align || {}),
    }),
    reassembly: H.fakeModule('reassembly', {
      consumes: 'audio-session', produces: 'audiobook', resource: () => 'cpu', travels: false,
      ...(faults.reassembly || {}),
    }),
  };
}

const allOf = (m) => [m.prepare, m.tts, m.align, m.reassembly];

/** One reachable server, nobody holding it. */
function freeHost(ranked = ONE_SERVER, waitFor = 'any') {
  const reach = {};
  for (const row of ranked) reach[row.name] = { reachable: true };
  return H.fakeHost({ ranked, defaultWaitFor: waitFor, reach });
}

// ────────────────────────────────────────────────────────────────────────────
// A fake Crucible with faults, wired to a registry name
// ────────────────────────────────────────────────────────────────────────────

async function startFaulty(behaviour = {}, faults = {}) {
  // `behaviour` is read on every request, so a scenario MUTATES it to play a
  // server that stops misbehaving — which is what every "and then it worked"
  // half of a fault scenario needs.
  const routes = faultyJobRoutes(behaviour);
  const lease = leaseRoutes(behaviour.lease || {});
  const fake = await startFakeCrucible(async (req, res, ctx) => {
    if (await lease.handler(req, res, ctx)) return true;
    return routes.handle(req, res, ctx);
  }, { faults });
  fake.routes = routes;
  fake.behaviour = behaviour;
  fake.lease = lease.lease;
  fake.server = registerFake(fake.url);
  return fake;
}

/** The raw `/v1/activity` document — the SDK drops 1.0.11's two new fields. */
async function rawActivity(fake) {
  const res = await fetch(`${fake.url}/v1/activity`, { headers: { Authorization: 'Bearer test-token-abcd' } });
  return res.json();
}

/** Run one real Crucible job and hand back what it threw, or what it produced. */
async function driveDoor(fake, options = {}) {
  const dir = fs.mkdtempSync(path.join(H.WORK, 'artifacts-'));
  const input = path.join(dir, 'in.txt');
  fs.writeFileSync(input, 'a book');
  try {
    const outcome = await crucibleJob.runCrucibleJob({
      server: fake.server,
      type: options.type || 'align',
      model: options.model || 'qwen-align',
      params: options.params || {},
      inputs: { 'in.txt': input },
      artifactsTo: dir,
      localId: options.localId || 'chaos-step',
      stallClock: options.stallClock,
      signal: options.signal,
      onStarted: options.onStarted,
      onProgress: options.onProgress,
    });
    return { ok: true, outcome, dir };
  } catch (err) {
    return { ok: false, err, dir };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE SCENARIOS
// ════════════════════════════════════════════════════════════════════════════

// ── S5 · a stale keep-alive socket, reset on align's first GET ──────────────

scenario('S5a', 'ONE reset on the events GET is resumed by the SDK; the job still lands', async () => {
  // The cheapest half of S5, and the one that must not regress: a single stale
  // keep-alive socket is a reconnect, not an incident. Measured here because
  // the expensive half below only means something if this one is true.
  const fake = await startFaulty({}, {
    resetAfterBytes: [{ match: { method: 'GET', path: /\/events$/ }, afterBytes: 0, times: 1 }],
  });
  try {
    const result = await driveDoor(fake, { type: 'align' });
    assert.strictEqual(result.ok, true,
      `one reset must be resumed, not reported: ${result.err && result.err.message}`);
    assertNothingLeftBehind(null, fake, 'S5a');
    return `resumed after ${fake.state.requests.filter((r) => r.path.endsWith('/events')).length} events GET(s)`;
  } finally {
    await fake.close();
  }
});

scenario('S5', 'a reset the SDK cannot resume PARKS the row; it does not redden it', async () => {
  // The night's shape: the Mac had just rendered for this very book, so the
  // keep-alive socket was seconds old and uvicorn had closed it. Reset every
  // time and the SDK's own resume runs out — which is the moment BookForge has
  // to decide what a dead socket MEANS.
  const fake = await startFaulty({}, {
    resetAfterBytes: [{ match: { method: 'GET', path: /\/events$/ }, afterBytes: 0, times: 20 }],
  });
  try {
    const first = await driveDoor(fake, { type: 'align' });
    assert.strictEqual(first.ok, false, 'twenty resets cannot read as a finished job');
    const err = first.err;
    assert.strictEqual(err.transient, true,
      'C1/PK7: a socket this app never got a byte out of is transport, not a repair. It arrived as '
      + `${err.name}/${err.code}: ${err.message}`);
    assertNothingLeftBehind(null, fake, 'S5 (the door)');

    // AND THE ENGINE'S HALF: that same error, thrown by the align row.
    const mods = narrationModules({ align: { throws: (n) => (n === 1 ? err : null) } });
    const host = freeHost();
    const seam = H.fakeLeaseSeam();
    await H.fresh('s5', allOf(mods), host, seam);
    const job = H.enqueueSent(narrationSpec('Shift'));
    H.engine.start();
    await H.waitUntil('align to park', () => H.stepOf(job.id, 2).status === 'queued'
      && H.stepOf(job.id, 2).progress.admissionHold !== undefined);
    assertParked(job.id, 2, 'S5');
    // …the cool-off passes, the row is asked again, and the book finishes.
    await H.waitUntil('the book to finish', () => H.stepOf(job.id, 3).status === 'done',
      { timeoutMs: 6000 });
    assertAllDone(job.id, 'S5');
    return `door: ${err.code}; the row parked and the book finished on the retry`;
  } finally {
    await fake.close();
  }
});

// ── S3 · killed mid-render, restarted, swept, resumed ───────────────────────

scenario('S3', 'a render killed mid-stream is swept off the server at the next launch, and resumes', async () => {
  const fake = await startFaulty({ holdUntilCancelled: true });
  try {
    // A render is running and the ledger knows about it…
    const started = [];
    const controller = new AbortController();
    const door = driveDoor(fake, {
      type: 'tts', localId: 'chaos-render', signal: controller.signal,
      onStarted: (s) => started.push(s),
    });
    await H.waitUntil('the job to exist', () => started.length === 1);
    const rows = H.ledger.readInFlightLedger();
    assert.strictEqual(rows.length, 1, 'the render must be on the ledger BEFORE the kill — S3\'s '
      + 'whole finding was that a ctrl-C left a 12 GB voice resident with nothing on disk naming it');

    // …and the app dies. The door's promise is abandoned exactly as a killed
    // process abandons it; the ledger row is what the next launch finds.
    controller.abort();
    await door.catch(() => undefined);

    // THE NEXT LAUNCH'S SWEEP.
    const report = await sweep.sweepCrucibleInFlight({ timing: { confirmForMs: 200, pollEveryMs: 20 } });
    assert.ok(report, 'the sweep must report');
    assertNothingLeftBehind(null, fake, 'S3');

    // AND THE RESUME COMPLETES — a second render on the same server, which is
    // now behaving (the fault was the kill, and the kill is over).
    fake.behaviour.holdUntilCancelled = false;
    fake.routes.jobs.submitted.length = 0;
    const again = await driveDoor(fake, { type: 'tts', localId: 'chaos-render' });
    assert.strictEqual(again.ok, true, `the resume must complete: ${again.err && again.err.message}`);
    assertNothingLeftBehind(null, fake, 'S3 (after the resume)');
    return `swept ${fake.state.cancelled.length} job(s), then the resume finished`;
  } finally {
    await fake.close();
  }
});

// ── S7 · a HELD next act gives the card back ────────────────────────────────

scenario('S7', 'a book whose next GPU act is HELD does not go on holding the card', async () => {
  const mods = narrationModules();
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  await H.fresh('s7', allOf(mods), host, seam);
  const job = H.enqueueSent(narrationSpec('Pursuit of Power'));
  H.engine.start();
  // Let prepare and the render land, then HOLD the align before it starts.
  await H.waitUntil('the render to land', () => H.stepOf(job.id, 1).status === 'done');
  const alignId = H.stepOf(job.id, 2).id;
  H.engine.release({ stepId: alignId });
  await H.settle(20);
  const slotSets = require(path.join(H.REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));
  const live = H.jobOf(job.id);
  const hold = slotSets.gpuHoldOf(live);
  const state = H.endStateOf(job.id);
  if (hold !== null && state.steps[2].status === 'held') {
    throw Object.assign(new Error(
      `S7: the book is still "holding the card" (${hold.server}) while its next GPU act is HELD — `
      + 'a person pressed Hold and the card stayed taken'), { endState: state });
  }
  return `align is ${state.steps[2].status}; gpuHold=${hold === null ? 'none' : hold.server}`;
});

// ── Ruling 9 · a book is ATOMIC on the card, and two books do not share it ──

scenario('ruling9', 'two books on one card: the second waits, and the first keeps its hold across a CPU step', async () => {
  const mods = narrationModules({ tts: { hold: true }, align: { hold: true } });
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  await H.fresh('ruling9', allOf(mods), host, seam);
  const first = H.enqueueSent(narrationSpec('Hitler\'s People'));
  const second = H.enqueueSent(narrationSpec('Conspiracies'));
  H.engine.start();
  await H.waitUntil('the first render to start', () => mods.tts.runs.length === 1);
  const slotSets = require(path.join(H.REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));
  assert.strictEqual(mods.tts.runs.length, 1,
    'ONE GPU slot: the second book must not be rendering beside the first');
  const held = slotSets.gpuHoldOf(H.jobOf(first.id));
  assert.ok(held !== null, 'the first book holds the card from its first travelling GPU step');
  // The render lands; the align of the SAME book is next and takes the hold on.
  mods.tts.runs[0].resolve();
  await H.waitUntil('the first align to start', () => mods.align.runs.length === 1, { timeoutMs: 4000 });
  const stillHeld = slotSets.gpuHoldOf(H.jobOf(first.id));
  assert.ok(stillHeld !== null && stillHeld.server === held.server,
    'ruling 9: the hold stays on the same server from the first travelling GPU step to the last');
  assert.strictEqual(mods.tts.runs.length, 1,
    'and the second book STILL has not taken the card while the first is mid-act');
  return `both books queued, one card, hold on ${held.server}`;
});

// ── A 409 from the book's OWN server during the hold parks on its own tail ──

scenario('own-tail', 'a 409 from the book\'s own server mid-hold parks on its own tail, keeping the venue', async () => {
  const busy = H.refusedBusy('busy: bookforge, tts deathstalker, 61% done');
  const mods = narrationModules({ align: { throws: (n) => (n === 1 ? busy : null) } });
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  await H.fresh('own-tail', allOf(mods), host, seam);
  const job = H.enqueueSent(narrationSpec('Deathstalker'));
  H.engine.start();
  await H.waitUntil('align to park', () => H.stepOf(job.id, 2).status === 'queued'
    && H.stepOf(job.id, 2).progress.admissionHold !== undefined);
  const parked = assertParked(job.id, 2, 'own-tail');
  const venue = H.jobOf(job.id).waitForResolved;
  assert.ok(venue !== undefined && venue !== null,
    'a book refused by its OWN tail keeps the machine it is standing on — releasing it would '
    + 'send the next act to a card that has none of its work');
  await H.waitUntil('the book to finish', () => H.stepOf(job.id, 3).status === 'done', { timeoutMs: 6000 });
  assertAllDone(job.id, 'own-tail');
  return `parked on "${parked.hold}", venue kept (${venue})`;
});

// ── S10 · a 503 ladder with Retry-After ends in a finished book ─────────────

scenario('S10', 'a 503 chat_queue_full storm parks and re-asks; it never fails the row', async () => {
  const fake = await startFaulty({}, {
    refuse: [{
      match: { method: 'POST', path: '/v1/jobs' },
      times: 3,
      status: 503,
      code: 'chat_queue_full',
      message: 'two in flight is this engine\'s cap; try again',
      retryAfter: 1,
    }],
  });
  try {
    const refusals = [];
    for (let i = 0; i < 3; i += 1) {
      const attempt = await driveDoor(fake, { type: 'align' });
      assert.strictEqual(attempt.ok, false, `attempt ${i + 1} should have been refused`);
      refusals.push(attempt.err);
    }
    for (const err of refusals) {
      assert.strictEqual(err.transient, true,
        `a 5xx is an engine that is busy or reloading, not a misconfiguration: got ${err.code} `
        + `(transient=${err.transient})`);
    }
    // The fourth is admitted, and the row finishes.
    const landed = await driveDoor(fake, { type: 'align' });
    assert.strictEqual(landed.ok, true, `the fourth attempt must land: ${landed.err && landed.err.message}`);

    // The engine's half: three parks, then done, never failed.
    const errs = refusals.slice();
    const mods = narrationModules({ align: { throws: (n) => (n <= 3 ? errs[n - 1] : null) } });
    await H.fresh('s10', allOf(mods), freeHost(), H.fakeLeaseSeam());
    const job = H.enqueueSent(narrationSpec('Lying About Hitler'));
    H.engine.start();
    await H.waitUntil('the book to finish', () => H.stepOf(job.id, 3).status === 'done', { timeoutMs: 8000 });
    assertAllDone(job.id, 'S10');
    assertNothingLeftBehind(job.id, fake, 'S10');
    return `3 × 503 (Retry-After: 1) parked, the 4th landed, book finished`;
  } finally {
    await fake.close();
  }
});

// ── A server RESTART mid-render: unknown_job is transport, not a repair ─────

scenario('restart', 'a server that restarts mid-render is a wait, and no DELETE chases a job it forgot', async () => {
  const fake = await startFaulty({ slowFramesMs: 30 });
  try {
    const started = [];
    const door = driveDoor(fake, {
      type: 'tts', localId: 'chaos-restart', onStarted: (s) => started.push(s),
    });
    await H.waitUntil('the job to exist', () => started.length === 1);
    // The box goes down and comes back with no memory of the job.
    fake.routes.restart();
    // Kill the open stream so the client reconnects into the forgotten job.
    fake.state.faults.resetAfterBytes = [
      { match: { method: 'GET', path: /\/events$/ }, afterBytes: 0, times: 1 },
    ];
    const result = await door;
    assert.strictEqual(result.ok, false, 'a forgotten job cannot have finished');
    const err = result.err;
    const cancels = fake.state.requests.filter((r) => r.method === 'DELETE');
    if (err.transient !== true) {
      throw Object.assign(new Error(
        `a restarted server answers 404 unknown_job, and this arrived as ${err.code} with `
        + `transient=${err.transient} — a row that reddens because the box rebooted is the exact `
        + 'shape Owen\'s ruling forbids'), { endState: { code: err.code, message: err.message, cancels: cancels.length } });
    }
    return `code=${err.code}, transient=${err.transient}, ${cancels.length} DELETE(s) crossed`;
  } finally {
    await fake.close();
  }
});

// ── C2 · a stream that goes quiet is cancelled by name and parks ────────────

scenario('stall', 'a stream that goes quiet is cancelled by name, once, and the row parks', async () => {
  const fake = await startFaulty({ neverFinishes: true });
  try {
    const result = await driveDoor(fake, {
      type: 'tts', localId: 'chaos-stall', stallClock: { stallMs: 250, graceMs: 250 },
    });
    assert.strictEqual(result.ok, false, 'a stalled stream cannot have finished');
    const err = result.err;
    assert.strictEqual(err.code, 'crucible_went_quiet',
      `ruling 3: a stall is cancelled BY NAME. Got ${err.code}: ${err.message}`);
    assert.strictEqual(err.transient, true, 'and it is a wait — nobody misconfigured anything');
    const cancels = fake.state.requests.filter((r) => r.method === 'DELETE');
    assert.strictEqual(cancels.length, 1,
      `exactly one DELETE: ${cancels.length} were sent. A stall that does not cancel leaves the `
      + 'job running on somebody\'s card; one that cancels twice is a client arguing with itself');
    const left = H.ledger.readInFlightLedger();
    assert.strictEqual(left.length, 0,
      'AND THE ROW IS OURS TO SETTLE. `settleInFlight` fires only on a TERMINAL FRAME '
      + '(crucible/job.ts:734), and a stalled stream never sees one — so the job this app '
      + 'cancelled ITSELF, by name, stays on the ledger for the rest of the session. The reset '
      + 'path does not have this hole: Q7 sweeps the server before it throws. Two endings of one '
      + `stream, two answers. Left behind: ${JSON.stringify(left)}`);
    return 'crucible_went_quiet after 250 ms, one DELETE, ledger empty';
  } finally {
    await fake.close();
  }
});

// ── S14 · Stop during a model load leaves the card stranded, and it SAYS so ─

scenario('S14', 'a Stop during a load strands the card, and nothing in this app comes back for it', async () => {
  const fake = await startFaulty({ holdUntilCancelled: true }, {
    // THE ONE-TICK RACE: the load reached `done` just before the cancel landed.
    refuse: [cancelRefusedFault('not-cancellable', 1)],
  });
  try {
    const started = [];
    const controller = new AbortController();
    const door = driveDoor(fake, {
      type: 'load-model', model: 'qwen3.5-9b', localId: 'chaos-load',
      signal: controller.signal, onStarted: (s) => started.push(s),
    });
    await H.waitUntil('the load to exist', () => started.length === 1);
    controller.abort();
    const result = await door;
    assert.strictEqual(result.ok, false, 'the cancelled load did not finish for us');
    const refusedCancels = fake.state.requests.filter((r) => r.method === 'DELETE' && r.fault);
    assert.ok(refusedCancels.length >= 1, 'the 409 must have crossed');

    /*
     * WHAT THE SERVER NOW SAYS — Crucible 1.0.11's two fields, and the exact
     * signature a reconciler keys on. The load COMPLETED; the thing it put on
     * the card is held by no lease, no chat, no job and no stream.
     */
    fake.routes.stranded('qwen3.5-9b', '2026-09-20T14:29:00Z');
    const activity = await rawActivity(fake);
    assert.ok(activity.resident !== null, 'the model is still on the card \u2014 that is the whole problem');
    assert.strictEqual(activity.resident.held_by, null,
      `held_by must be null: ${JSON.stringify(activity.resident.held_by)}`);
    assert.strictEqual(activity.resident.unclaimed_since, '2026-09-20T14:29:00Z',
      "and unclaimed_since says since when \u2014 the load's own completion time");

    /*
     * AND THIS SIDE'S HALF, WHICH IS THE PACKET (PK12).
     *
     * The app HAS a reconciler \u2014 `sweepCrucibleInFlight` submits
     * `unload-model` when `cardHeldBy` answers null \u2014 but it only ever looks at
     * servers named by a LEDGER ROW, and a cancelled load leaves none: the
     * refusal settled the row on its way out. So the 12 GB stays, and the next
     * sweep does not even ask this server.
     */
    const left = H.ledger.readInFlightLedger();
    assert.strictEqual(left.length, 0, 'the ledger is clear, as the doors intend');
    fake.routes.jobs.submitted.length = 0;
    await sweep.sweepCrucibleInFlight({ timing: { confirmForMs: 200, pollEveryMs: 20 } });
    const unloads = fake.routes.jobs.submitted.filter((b) => String(b.type).startsWith('unload'));
    assert.ok(unloads.length >= 1,
      'PK12: nothing came back for the card. The reconciler EXISTS \u2014 `sweepCrucibleInFlight` '
      + 'submits `unload-model` when `cardHeldBy` answers null \u2014 but it is driven by the '
      + 'in-flight LEDGER, and a cancelled load leaves no row, so this server is never even asked. '
      + '1.0.11 put the answer ON THE CARD (`resident.unclaimed_since`, surfaced by the SDK as '
      + '`Activity.resident.unclaimedSince`) and nothing in BookForge reads it: `cardHeldBy` still '
      + 're-derives the same fact from seven other fields.');
    return 'the stranded card was reclaimed';
  } finally {
    await fake.close();
  }
}, { pendingPacket: 'PK12' });

// ── The unload lock hazard: /v1/activity must answer while a card is unloading ─

scenario('unload-poll', '/v1/activity answers in under a second while an unload holds the card', async () => {
  // The settlement is SLOW — an unload taking a 12 GB model off — and the read
  // route must not be behind that lock. The hazard it models would have hung
  // every poll in the queue for up to 180 s, and it fires under exactly the
  // rows above (a restart mid-job, a reset socket) because those are when an
  // unload happens.
  const fake = await startFaulty({ settleHoldsMs: 2500, doneShape: 'resident' });
  try {
    fake.routes.loaded('qwen3.5-9b', { fact: 'job', who: 'bookforge', details: {} });
    const door = driveDoor(fake, { type: 'unload-model', model: 'qwen3.5-9b', localId: 'chaos-unload' });
    await H.waitUntil('the unload to be running', () => fake.routes.jobs.live().length === 1);
    await H.wait(200);
    const polls = [];
    for (let i = 0; i < 3; i += 1) {
      const at = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const doc = await rawActivity(fake);
      polls.push({ ms: Date.now() - at, resident: doc.resident === null ? null : doc.resident.id });
      // eslint-disable-next-line no-await-in-loop
      await H.wait(100);
    }
    const slowest = Math.max(...polls.map((p) => p.ms));
    assert.ok(slowest < 1000,
      `a poll took ${slowest} ms while the card was unloading. /v1/activity is a READ and must never `
      + 'queue behind the card lock: the real server hung it for the whole unload, up to 180 s, and '
      + 'every bench and every admission poll in this queue hung with it');
    await door;
    const after = await rawActivity(fake);
    assert.strictEqual(after.resident, null, 'and when the unload lands the card is empty');
    return `3 polls during a 2.5 s unload, slowest ${slowest} ms`;
  } finally {
    await fake.close();
  }
});

// ── S11 · the interrupt-cache and the completion publish UNION ──────────────

scenario('S11', 'a cache holding 5 chunks and a scratch holding 2267 publish the union, not the shortcut', async () => {
  const merge = require(path.join(H.DIST, 'session-cache-merge.js'));
  const work = fs.mkdtempSync(path.join(H.WORK, 's11-'));
  const cache = path.join(work, 'cache');
  const scratch = path.join(work, 'scratch');
  for (const root of [cache, scratch]) {
    fs.mkdirSync(path.join(root, 'sentences'), { recursive: true });
    fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
  }
  // The 02:39 interrupt cached five chunks…
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(path.join(cache, 'sentences', `${String(i).padStart(4, '0')}.wav`), 'old');
  }
  // …and the render that finished wrote all of them.
  const total = 120;
  for (let i = 1; i <= total; i += 1) {
    fs.writeFileSync(path.join(scratch, 'sentences', `${String(i).padStart(4, '0')}.wav`), 'new');
  }
  const cacheSet = await merge.renderedChunkSet(path.join(cache, 'sentences'));
  const sourceSet = await merge.renderedChunkSet(path.join(scratch, 'sentences'));
  assert.strictEqual(merge.cacheIsAtLeastAsComplete(cacheSet, sourceSet), false,
    'THE FINDING: "a cache dir with sentences in it" returned success without comparing anything, '
    + 'so 5 chunks stood in for 2267');
  await merge.mergeSessionTree(scratch, cache);
  const after = await merge.renderedChunkSet(path.join(cache, 'sentences'));
  assert.strictEqual(after.size, total,
    `the cache must be the UNION of everything ever rendered: it holds ${after.size} of ${total}`);
  assert.ok(merge.cacheIsAtLeastAsComplete(after, sourceSet),
    'and the publish verifies the set after the rename');
  return `cache 5 → ${after.size}, superset verified`;
});

// ── S9 · Retry after the parent's scratch was swept re-plans; it is not ENOENT ─

scenario('S9', 'Retry re-runs a Foundry row from its stored request, and that request names no scratch path', async () => {
  const hostQueue = require(path.join(H.DIST, 'foundry-host-queue.js'));
  const seen = [];
  hostQueue.setFoundrySeam({
    runJob: async (request, opts) => {
      seen.push(JSON.parse(JSON.stringify(request)));
      if (opts && opts.onPlaced) opts.onPlaced({ server: 'mac', model: 'qwen3.5-9b', leaseId: `lease-${seen.length}`, concurrency: 4 });
      if (seen.length === 1) return { outcome: 'failed', error: 'the model fell over', stderrTail: '' };
      return { outcome: 'done', row: { id: 'r1', state: 'done', kind: 'epub', inputPath: 'a', outputPath: 'b', progress: null, createdAt: 0 } };
    },
    setQueueRows: null,
    drained: null,
  });
  const { foundryJobStep } = require(path.join(H.DIST, 'queue-steps', 'foundry-job.js'));
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  await H.fresh('s9', [foundryJobStep], host, seam);
  const job = H.enqueueSent({
    title: 'Lying About Hitler',
    projectId: '/tmp/chaos/project',
    steps: [{
      type: 'foundry-job',
      label: 'Clean text',
      config: {
        type: 'foundry-job',
        projectDir: '/tmp/chaos/project',
        parentStep: null,
        label: 'Clean text',
        /*
         * A RENDERING, deliberately, exactly as `test-foundry-runner-seam.js`
         * does: `resourceFor` calls one `cpu`, so `machines()` says `local` and
         * the row never reaches `decideWhereTextActRuns` — which would want a
         * Crucible registry and a Foundry binary this suite has no business
         * standing up. What is under test is the LIFECYCLE around the outcome,
         * which is the same for every kind.
         */
        request: {
          kind: 'epub',
          inputPath: '/tmp/chaos/project/archive/book.pdf',
          outputPath: '/tmp/chaos/project/source/book.epub',
          at: 'the-step-the-press-was-standing-on',
        },
      },
      sourceRef: { kind: 'pdf', path: '/tmp/chaos/project/archive/book.pdf' },
    }],
  });
  H.engine.start();
  await H.waitUntil('the row to fail', () => H.stepOf(job.id, 0).status === 'failed', { timeoutMs: 4000 });
  // THE FINDING (F1/F5): the stored request must not carry a path Foundry's own
  // settle has already unlinked, because Retry replays it byte for byte.
  const stored = JSON.stringify(H.stepOf(job.id, 0).config.request);
  assert.ok(!stored.includes('derived/'),
    `the request persisted on the step names a scratch path: ${stored}`);
  H.engine.retry({ stepId: H.stepOf(job.id, 0).id });
  // A retried row lands HELD — Retry revives it, Start runs it (Q8). Pressing
  // it here is the person pressing it.
  H.engine.start({ stepId: H.stepOf(job.id, 0).id });
  await H.waitUntil('the retry to finish', () => H.stepOf(job.id, 0).status === 'done', { timeoutMs: 4000 });
  assert.strictEqual(seen.length, 2, 'the retry must reach the runner a second time');
  assert.deepStrictEqual(seen[0], seen[1],
    'and it re-sends the same DESCRIPTION — the book is made at spawn, not replayed from a press');
  assertNothingLeftBehind(job.id, null, 'S9');
  return 'the request carries `at`, not a derived path; the retry ran and landed';
});

// ── A chat 503 storm on the Foundry door parks, again and again, and lands ──

scenario('foundry-wait', 'a Foundry row refused by a holder parks every time and never reddens', async () => {
  const hostQueue = require(path.join(H.DIST, 'foundry-host-queue.js'));
  let calls = 0;
  hostQueue.setFoundrySeam({
    runJob: async () => {
      calls += 1;
      if (calls <= 5) {
        return {
          outcome: 'wait',
          busyLine: 'busy: crucible@mac, clean qwen3.5-9b, 24% done',
          standing: false,
        };
      }
      return { outcome: 'done', row: { id: 'r1', state: 'done', kind: 'epub', inputPath: 'a', outputPath: 'b', progress: null, createdAt: 0 } };
    },
    setQueueRows: null,
    drained: null,
  });
  const { foundryJobStep } = require(path.join(H.DIST, 'queue-steps', 'foundry-job.js'));
  await H.fresh('foundry-wait', [foundryJobStep], freeHost(), H.fakeLeaseSeam());
  const job = H.enqueueSent({
    title: 'Third Reich in History',
    projectId: '/tmp/chaos/project',
    steps: [{
      type: 'foundry-job',
      label: 'Clean text',
      config: {
        type: 'foundry-job', projectDir: '/tmp/chaos/project', parentStep: null, label: 'Clean text',
        request: { kind: 'epub', inputPath: '/tmp/a.pdf', outputPath: '/tmp/a.epub', at: 'row-1' },
      },
      sourceRef: { kind: 'pdf', path: '/tmp/a.pdf' },
    }],
  });
  H.engine.start();
  await H.waitUntil('the row to land after five waits',
    () => H.stepOf(job.id, 0).status === 'done', { timeoutMs: 10000 });
  assert.ok(calls >= 6, `the row must have been re-asked: ${calls} call(s)`);
  return `${calls - 1} waits parked, then done — no Retry press needed`;
});

// ── Send back to Pending, then Start, resumes NOTHING ───────────────────────

scenario('pending-restart', 'a run sent back to Pending and started again resumes nothing and completes', async () => {
  // The render HOLDS its first attempt — that is the run a person pulls out of
  // the queue — and finishes every attempt after it.
  const mods = narrationModules({
    tts: { hold: true, onRun: (record, n) => { if (n > 1) setTimeout(() => record.resolve(), 0); } },
  });
  await H.fresh('pending-restart', allOf(mods), freeHost(), H.fakeLeaseSeam());
  const job = H.enqueueSent(narrationSpec('Shift'));
  H.engine.start();
  await H.waitUntil('the render to start', () => mods.tts.runs.length === 1);
  await H.engine.cancel({ stepId: H.stepOf(job.id, 1).id });
  await H.settle(20);
  await H.engine.returnToPending(job.id);
  await H.settle(10);
  for (const step of H.jobOf(job.id).steps) {
    assert.notStrictEqual(step.wasInterrupted, true,
      `${step.label} came back from Pending still marked interrupted — that turns "start over with `
      + 'the same settings" into a resume of the attempt just pulled out of the queue (PK7)');
    assert.strictEqual(step.lastError, undefined,
      `${step.label} kept the account of an attempt a staged run no longer has`);
  }
  // Now let it run clean.
  H.engine.sendToQueue(job.id);
  H.engine.start();
  await H.waitUntil('the book to finish', () => H.stepOf(job.id, 3).status === 'done', { timeoutMs: 8000 });
  assertAllDone(job.id, 'pending-restart');
  return 'wasInterrupted and lastError cleared; the restarted run finished';
});

// ── A relaunch: Running releases the rows a kill left interrupted ───────────

scenario('relaunch', 'after a relaunch, Running picks up the rows the kill left held', async () => {
  const mods = narrationModules({ tts: { hold: true } });
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  const dir = await H.fresh('relaunch', allOf(mods), host, seam);
  const job = H.enqueueSent(narrationSpec('Hitler\'s People'));
  H.engine.start();
  await H.waitUntil('the render to start', () => mods.tts.runs.length === 1);
  // THE KILL: persist while the render is running, then configure again.
  await H.engine.persist();
  const after = narrationModules();
  await H.fresh('relaunch-second', allOf(after), host, seam, {});
  // Load the SAME state directory the kill left behind.
  H.engine.clearStepModules();
  for (const mod of allOf(after)) H.engine.registerStepModule(mod);
  H.engine.setCrucibleRoutingHost(host.host);
  H.engine.setCrucibleLeaseHost(seam.host);
  await H.engine.configure({ stateDir: dir, admissionRecheckMs: 40, heldJobRecheckMs: 40, reachSweepMs: 0 });
  const restored = H.jobOf(job.id);
  assert.ok(restored, 'the queue must come back');
  const tts = restored.steps[1];
  assert.strictEqual(tts.status, 'held',
    `a step that was running when the process ended is HELD and marked interrupted, not ${tts.status}`);
  assert.strictEqual(tts.wasInterrupted, true, 'and it says it was interrupted');
  // AND RUNNING PICKS IT UP. This is the half PK10 is building.
  H.engine.start();
  await H.waitUntil('the interrupted render to resume',
    () => after.tts.runs.length === 1, { timeoutMs: 4000 });
  await H.waitUntil('the book to finish',
    () => H.stepOf(job.id, 3).status === 'done', { timeoutMs: 8000 });
  assertAllDone(job.id, 'relaunch');
  return 'the interrupted row resumed on Start and the book finished';
}, { pendingPacket: 'PK10' });

// ── The queue file round-trips ──────────────────────────────────────────────

scenario('round-trip', 'the persisted queue comes back as the same queue', async () => {
  const mods = narrationModules();
  const host = freeHost();
  const seam = H.fakeLeaseSeam();
  const dir = await H.fresh('round-trip', allOf(mods), host, seam);
  const job = H.enqueueSent(narrationSpec('Mistborn'));
  H.engine.start();
  await H.waitUntil('the book to finish', () => H.stepOf(job.id, 3).status === 'done', { timeoutMs: 8000 });
  const after = narrationModules();
  const trip = await H.roundTrip(dir, allOf(after), host, seam);
  assert.deepStrictEqual(trip.after, trip.before,
    `the queue came back different:\n  before ${JSON.stringify(trip.before)}\n  after  ${JSON.stringify(trip.after)}`);
  const file = path.join(dir, 'queue-engine.json');
  assert.ok(fs.existsSync(file), 'and the file is where the engine says it is');
  const litter = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepStrictEqual(litter, [],
    `Q10/P7: ${JSON.stringify(litter)} was left behind — the unique-named writes accumulated for ever`);
  return `${trip.after.length} job(s) restored identically, no .tmp litter`;
});

// ── A partial artifact fetch is not a failed job ────────────────────────────

scenario('artifacts', 'a done frame whose artifact fetch fails once does not lose the run', async () => {
  const fake = await startFaulty({ partialArtifacts: true });
  try {
    const result = await driveDoor(fake, { type: 'align' });
    if (result.ok) return 'the door retried the fetch and landed the artifacts';
    const err = result.err;
    const left = H.ledger.readInFlightLedger();
    throw Object.assign(new Error(
      'C4: ONE 500 on ONE artifact fetch loses a job that RAN. The stream never reaches a terminal '
      + `frame, so nothing settles the ledger either — ${err.code || err.name} `
      + `(transient=${err.transient === true}), ledger rows left: ${left.length}`),
    { endState: { code: err.code, transient: err.transient === true, message: String(err.message).slice(0, 200), ledger: left.length } });
  } finally {
    await fake.close();
  }
});

// ── S13 · the connection dies mid-align, and the row must not be a repair ────

scenario('S13', 'a connection that hangs and dies mid-align is a wait; what it does about the job is recorded', async () => {
  /*
   * A SLOW SOCKET THAT THEN DIES. On loopback a listening server always
   * completes TCP connect, so what a `connectDelay` models is the observable
   * half of undici's 10 s connect timeout: headers that never arrive and a
   * connection that then goes away. The ALIGN row met exactly this on the
   * night of Sep 19, on the machine that had just rendered for the same book.
   *
   * What is asserted is the CLASS (a wait, never a repair). What is only
   * RECORDED is the DELETE, because the two endings disagree on purpose: Q7
   * cancels our own orphan before it throws, which is right for a job that may
   * still be running, and "no cancel" would be right for a reconnect that is
   * about to resume. This line is where that decision is visible.
   */
  const fake = await startFaulty({ slowFramesMs: 40 }, {
    connectDelay: [{ match: { method: 'GET', path: /\/events$/ }, ms: 400, times: 6 }],
  });
  try {
    const result = await driveDoor(fake, { type: 'align', localId: 'chaos-s13' });
    const cancels = fake.state.requests.filter((r) => r.method === 'DELETE');
    if (result.ok) {
      assertNothingLeftBehind(null, fake, 'S13');
      return `the SDK resumed through the dead connections; ${cancels.length} DELETE(s) crossed`;
    }
    const err = result.err;
    assert.strictEqual(err.transient, true,
      'a connection that hung and died is transport. It arrived as '
      + `${err.name}/${err.code}: ${String(err.message).slice(0, 160)}`);
    assertNothingLeftBehind(null, fake, 'S13');
    return `${err.code}, transient; ${cancels.length} DELETE(s) crossed `
      + '(Q7 cancels our own orphan before throwing — recorded, not asserted)';
  } finally {
    await fake.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AGAINST A REAL CRUCIBLE  (`--real <server-name>`)
// ════════════════════════════════════════════════════════════════════════════

/** The SDK client for the one named server, through the app's own factory. */
async function realClient() {
  return servers.crucibleClientFor(REAL_SERVER, 'bookforge-chaos');
}

/** What the card said before this suite touched anything. */
let baseline = null;

/**
 * THE IDLE GATE. A machine with anything on it is a machine somebody is using,
 * and every scenario below either cancels something or takes the lane.
 */
function whatHolds(activity) {
  if (activity.running.length > 0) return `a ${activity.running[0].type} job is running`;
  if (activity.queued.length > 0) return `a ${activity.queued[0].type} job is queued`;
  if (activity.claim !== null) return `a claim held by ${activity.claim.heldBy}`;
  if (activity.lease !== null) return 'an open lease';
  if (activity.streaming !== null) return 'an open streaming session';
  if (activity.chat.inFlight > 0) return `${activity.chat.inFlight} chat completion(s) in flight`;
  if (activity.stopping !== null) return 'a stop already under way';
  if (activity.warming !== null) return `${activity.warming} is loading`;
  return null;
}

/** Take off whatever this suite put on the card, whatever it was. */
async function takeOffTheCard(what) {
  const client = await realClient();
  const now = await client.activity();
  if (now.resident === null) return 'nothing resident';
  const type = now.resident.kind === 'tts' ? 'unload-voice'
    : now.resident.kind === 'llm' ? 'unload-model'
      : now.resident.kind === 'align' ? 'unload-aligner' : null;
  if (type === null) return `left ${now.resident.kind} ${now.resident.id} — no unload job type for it`;
  const jobId = await client.submit({ type, model: now.resident.id, params: {}, inputs: {} });
  for await (const event of client.events(jobId)) {
    if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') break;
  }
  return `${what}: unloaded ${now.resident.id}`;
}

/**
 * The last word: the server is as it was found, and this SAYS so.
 *
 * POLLED, not asked once. A settlement takes a moment — the first run of this
 * read *"a claim held by the settlement clearing the card"* a millisecond after
 * the last unload and called a perfectly tidy server dirty. What is asserted is
 * where the machine COMES TO REST, and that is a question with a clock in it.
 */
async function leaveAsFound(graceMs = 20000) {
  try {
    await takeOffTheCard('teardown');
    const client = await realClient();
    const wanted = baseline === null || baseline.resident === null ? null : baseline.resident.id;
    const deadline = Date.now() + graceMs;
    let now = await client.activity();
    let held = whatHolds(now);
    while ((held !== null || now.lease !== null) && Date.now() < deadline) {
      await H.wait(500);
      // eslint-disable-next-line no-await-in-loop
      now = await client.activity();
      held = whatHolds(now);
    }
    const same = (now.resident === null ? null : now.resident.id) === wanted;
    const clean = same && now.lease === null && held === null;
    console.log(`\nleft as found: ${clean ? 'yes' : 'NO'} — resident `
      + `${now.resident === null ? 'nothing' : now.resident.id}, lease `
      + `${now.lease === null ? 'none' : 'OPEN'}, holding ${held || 'nothing'}`);
    if (!clean) process.exitCode = 1;
  } catch (err) {
    console.log(`\nleft as found: UNKNOWN — ${err.message}`);
    process.exitCode = 1;
  }
}

realScenario('real-activity', 'the live card answers the stranded-card question, and answers it coherently', async () => {
  const client = await realClient();
  const activity = await client.activity();
  baseline = activity;
  const held = whatHolds(activity);
  assert.strictEqual(held, null,
    `REFUSING TO RUN: ${REAL_SERVER} is busy (${held}). Every scenario below cancels something or `
    + 'takes the lane, and interrupting somebody\'s run to measure a cancel is the defect, not the test.');
  if (activity.resident !== null) {
    const r = activity.resident;
    assert.ok((r.heldBy === null) !== (r.unclaimedSince === null),
      'ONE FACT, TWO SPELLINGS: held_by and unclaimed_since are exclusive. This card says '
      + `heldBy=${JSON.stringify(r.heldBy)} and unclaimedSince=${JSON.stringify(r.unclaimedSince)}`);
  }
  return `${activity.server.name} ${activity.server.version} (${activity.server.backend}), resident `
    + `${activity.resident === null ? 'nothing' : activity.resident.id}, `
    + `chat.maxInFlight=${activity.chat.maxInFlight}`;
});

realScenario('real-409', 'a second job while the lane is taken is refused 409 BY NAME, and nothing is lost', async () => {
  const client = await realClient();
  const voice = 'mistborn';
  // A load is the cheapest thing that holds the lane for long enough to race.
  const loading = await client.loadVoice(voice);
  try {
    let refusal = null;
    for (let attempt = 0; attempt < 20 && refusal === null; attempt += 1) {
      const now = await client.activity();
      if (now.running.length === 0 && now.warming === null) { await H.wait(100); continue; }
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.submit({ type: 'load-voice', model: 'thirdreich', params: {}, inputs: {} });
        throw new Error('the second job was ADMITTED while the lane was taken');
      } catch (err) {
        if (err && (err.code === 'server_busy' || err.code === 'leased')) { refusal = err; break; }
        if (err && String(err.message).includes('ADMITTED')) throw err;
        throw err;
      }
    }
    assert.ok(refusal !== null, 'the lane never reported taken, so nothing was raced');
    assert.ok(typeof refusal.busyLine === 'string' && refusal.busyLine !== '',
      `a 409 must carry the holder's own sentence; got ${JSON.stringify(refusal.busyLine)}`);
    assert.strictEqual(H.ledger.readInFlightLedger().length, 0,
      'a refused submit records nothing — it never started');
    return `${refusal.code}: ${refusal.busyLine}`;
  } finally {
    // Let the load settle either way; the next scenario owns what it left.
    try {
      for await (const event of client.events(loading)) {
        if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') break;
      }
    } catch { /* the load's own ending is the next scenario's subject */ }
  }
});

realScenario('real-S14', 'a Stop during a real load: what the card says afterwards', async () => {
  const client = await realClient();
  // Start from an empty card, so what is resident afterwards is ours.
  await takeOffTheCard('before the load');
  const controller = new AbortController();
  const started = [];
  const door = driveRealLoad(client, 'mistborn', controller.signal, started);
  await H.waitUntil('the load to be admitted', () => started.length === 1, { timeoutMs: 20000 });
  // STOP, mid-load — the press that stranded qwen3.5-9b on the PC at 14:29.
  controller.abort();
  const result = await door;
  const after = await client.activity();
  const resident = after.resident;
  const line = `stop → ${result.ok ? 'the load finished anyway' : result.err.code}; `
    + `resident ${resident === null ? 'nothing' : resident.id}, `
    + `heldBy ${JSON.stringify(resident === null ? null : resident.heldBy)}, `
    + `unclaimedSince ${resident === null ? null : resident.unclaimedSince}`;
  if (resident !== null) {
    // THE STRANDED-CARD SIGNATURE, measured on a real server.
    assert.strictEqual(resident.heldBy, null,
      `the load was stopped, so nothing can be holding what it left: ${JSON.stringify(resident.heldBy)}`);
    assert.ok(typeof resident.unclaimedSince === 'string' && resident.unclaimedSince !== '',
      'and the card must say since WHEN nobody has been coming back for it — that is the fact a '
      + 'reconciler keys on, and without it a stranded card is indistinguishable from a busy one');
  }
  assert.strictEqual(H.ledger.readInFlightLedger().length, 0,
    'and this side settled its own ledger row');
  return line;
});

realScenario('real-render-stop', 'a Stop mid-render of three chunks: the job ends and the card comes back', async () => {
  const render = require(path.join(H.DIST, 'crucible', 'render.js'));
  const client = await realClient();
  const dir = fs.mkdtempSync(path.join(H.WORK, 'real-render-'));
  const chunks = [
    { index: 1, text: 'The queue is not the work; the queue is who may begin.' },
    { index: 2, text: 'A refusal that names a holder is a wait, not a failure.' },
    { index: 3, text: 'What is on the card, and is anybody coming back for it?' },
  ];
  const started = [];
  const controller = new AbortController();
  const run = render.runCrucibleRender({
    server: REAL_SERVER,
    renderId: 'chaos-real-render',
    voice: 'mistborn',
    language: 'en',
    chunks,
    sentencesDir: dir,
    onStarted: (s) => { started.push(s); },
  }).then((outcome) => ({ ok: true, outcome }), (err) => ({ ok: false, err }));
  await H.waitUntil('the render to be admitted', () => started.length === 1, { timeoutMs: 120000 });
  await H.wait(1500);
  await started[0].cancel();
  const result = await run;
  const after = await client.activity();
  assert.strictEqual(whatHolds(after), null,
    `after a cancel the lane must be free; it holds ${whatHolds(after)}`);
  assert.strictEqual(H.ledger.readInFlightLedger().length, 0,
    'and the cancelled render leaves no in-flight row behind');
  const wrote = fs.readdirSync(dir).filter((n) => n.endsWith('.flac')).length;
  const how = result.ok
    ? 'finished before the cancel landed'
    : `${result.err.code || result.err.name}: ${String(result.err.message).slice(0, 90)}`;
  return `${how}; ${wrote} chunk(s) on disk, lane free`;
});

realScenario('real-chat-full', 'more chats than the engine admits: the extra ones are refused by name', async () => {
  const client = await realClient();
  await takeOffTheCard('before the chat storm');
  const model = 'qwen3.5-9b';
  const loadId = await client.submit({ type: 'load-model', model, params: {}, inputs: {} });
  for await (const event of client.events(loadId)) {
    if (event.event === 'failed') throw new Error(`the load failed: ${JSON.stringify(event.data)}`);
    if (event.event === 'done' || event.event === 'cancelled') break;
  }
  const stated = (await client.activity()).chat.maxInFlight;
  const width = (stated === null ? 2 : stated) + 2;
  const asks = [];
  for (let i = 0; i < width; i += 1) {
    asks.push(client.chat({
      model,
      messages: [{ role: 'user', content: `Say the number ${i} and nothing else.` }],
      maxTokens: 64,
    }).then(() => ({ ok: true }), (err) => ({ ok: false, code: err && err.code, retryAfter: err && err.retryAfter })));
  }
  const answers = await Promise.all(asks);
  const refused = answers.filter((a) => !a.ok);
  const codes = [...new Set(refused.map((a) => a.code))];
  assert.ok(answers.some((a) => a.ok), 'at least one chat must have been admitted');
  return `stated max_in_flight=${stated}; ${width} asked, ${refused.length} refused `
    + `${JSON.stringify(codes)}`;
});

/** One real `load-voice`, through the app's own door, cancellable. */
function driveRealLoad(client, voice, signal, started) {
  return crucibleJob.runCrucibleJob({
    server: REAL_SERVER,
    type: 'load-voice',
    model: voice,
    params: {},
    inputs: {},
    localId: 'chaos-real-load',
    signal,
    onStarted: (s) => started.push(s),
  }).then((outcome) => ({ ok: true, outcome }), (err) => ({ ok: false, err }));
}

runAll().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
