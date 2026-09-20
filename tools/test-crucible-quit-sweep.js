#!/usr/bin/env node
/**
 * WHAT THE APP GIVES BACK ON ITS WAY OUT — and what it takes back at the next
 * start when the way out was a ctrl-C.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-quit-sweep.js
 *
 * 2026-09-19: Owen hard-killed `electron:dev`. `before-quit` never ran, and an
 * hour later the Mac's Crucible still showed BookForge's `tts` job for
 * "mistborn" RUNNING at 70%, holding the card with 12 GB of voice resident, for
 * an app that no longer existed. Meanwhile `<library>/tmp` held five render
 * sessions and nine landing EPUBs from finished or dead jobs. Owen: *"send the
 * model kill command to crucible servers before actually closing … it should
 * clean up rendered files as well. and any other incomplete jobs … just clean it
 * up so nothing sits around afterward."*
 *
 * Two modules answer that, and this drives both against real sockets and a real
 * filesystem:
 *
 *  A. `crucible/in-flight-sweep.ts` — every recorded job DELETEd on every
 *     server, the lane polled until ours are off it, and an `unload-*` ONLY for
 *     a card whose resident nothing holds.
 *  B. `scratch-sweep.ts` — rescue first, delete second, and never either one for
 *     work another machine or the queue still wants.
 *
 * The rule A exists to not break: a Crucible is shared, and every BookForge
 * install reports the SAME `client` string, so the only thing this app can
 * honestly claim is a job id it wrote down itself. Anything else on that card —
 * another job, a claim, a lease, a stream, a chat — is hands off.
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');
const { REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer } = require('./fake-crucible');

const DIST = path.join(REPO, 'dist', 'electron');
for (const built of ['crucible/in-flight-sweep.js', 'crucible/in-flight-ledger.js', 'scratch-sweep.js', 'parallel-tts-bridge.js']) {
  if (!fs.existsSync(path.join(DIST, built))) {
    console.log(skipLine(`dist/electron/${built} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}
if (!fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'))) {
  console.log(skipLine('dist/electron/data is not staged — run npm run build:electron'));
  process.exit(0);
}

const { work } = installElectronStub('bf-quit-sweep-');
const servers = require(path.join(DIST, 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const ledger = require(path.join(DIST, 'crucible', 'in-flight-ledger.js'));
const sweep = require(path.join(DIST, 'crucible', 'in-flight-sweep.js'));
const scratchSweep = require(path.join(DIST, 'scratch-sweep.js'));
const { check, summary } = makeChecker();

/** Checks run in order so the shared ledger file is never two suites at once. */
const queued = [];
const it = (name, fn) => queued.push(() => check(name, fn));

/** Fast clocks: these fakes answer instantly, and a keeper must not sit for six seconds. */
const FAST = { confirmForMs: 600, pollEveryMs: 20 };

// ─────────────────────────────────────────────────────────────────────────────
// A fake Crucible that answers /v1/activity out of a mutable script
// ─────────────────────────────────────────────────────────────────────────────

function job(over) {
  return {
    job_id: 'job-x',
    type: 'tts',
    model: 'mistborn',
    status: 'running',
    position: null,
    progress: 0.7,
    message: null,
    created: '2026-09-19T22:00:00Z',
    started: '2026-09-19T22:00:01Z',
    client: 'bookforge crucible-client/1.0.6',
    ...over,
  };
}

/**
 * `GET /v1/activity` in the SDK's exact shape. `state` is the handful of fields
 * a keeper actually varies; everything else is the idle answer.
 */
function activityBody(state) {
  const resident = state.resident ?? null;
  /*
   * ── CRUCIBLE 1.0.11: THE CARD SAYS WHO HOLDS IT ────────────────────────────
   *
   * `resident.held_by` and `resident.unclaimed_since` are READ STRICTLY by the
   * 1.0.11 SDK — the keys must be on the wire, null or not — so a fake that
   * left them out answered `crucible_protocol: activity.resident has no field
   * "held_by"` and two checks here failed on a document that was merely a
   * version behind. They are DERIVED from the state this keeper already varies,
   * not taken as a fourteenth knob: a running job, a claim, a lease or a chat
   * in flight IS a holder, and a fake that let a test say "nothing holds it"
   * while a job ran would model a server that does not exist.
   */
  const holder = (state.running ?? []).length > 0
    ? { fact: 'job', who: (state.running ?? [])[0].client ?? 'a client', details: {} }
    : state.claim ? { fact: 'claim', who: state.claim.held_by ?? 'a client', details: {} }
      : state.lease ? { fact: 'lease', who: state.lease.client ?? 'a client', details: {} }
        : (state.chatInFlight ?? 0) > 0 ? { fact: 'chat', who: 'a client', details: {} }
          : null;
  return {
    server: { name: 'fake-crucible', version: '1.0.11', api_version: 1, backend: 'cuda-linux', uptime_s: 99 },
    resident: resident === null ? null : {
      ...resident,
      held_by: holder,
      // Non-null EXACTLY when nothing holds it: one fact, two spellings, and
      // the stranded card is the pair (held_by null, unclaimed_since set).
      unclaimed_since: holder === null ? '2026-09-19T22:05:00Z' : null,
    },
    stopping: state.stopping ?? null,
    warming: null,
    claim: state.claim ?? null,
    streaming: null,
    lease: state.lease ?? null,
    chat: {
      in_flight: state.chatInFlight ?? 0,
      max_in_flight: state.chatMaxInFlight ?? null,
      max_in_flight_basis: state.chatMaxInFlightBasis ?? null,
      rows: [],
    },
    slots: { accelerated: { busy: 0, of: 1, queue_depth: 0, accepts_work: true } },
    running: state.running ?? [],
    queued: state.queued ?? [],
  };
}

/**
 * A fake whose activity answer is whatever `script.current` says at the moment
 * it is asked, so a keeper can make the card clear between one poll and the next
 * exactly as a real cancel does.
 */
async function fakeWithActivity(script) {
  return startFakeCrucible(async (req, res, ctx) => {
    if (req.url.startsWith('/v1/activity') && req.method === 'GET') {
      script.activityReads += 1;
      if (script.unreachableActivity) {
        res.destroy();
        return true;
      }
      ctx.send(res, 200, activityBody(script.current()));
      return true;
    }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      script.submitted.push(body);
      if (script.refuseSubmit) {
        ctx.send(res, 409, {
          error: { code: 'leased', message: 'mistborn is leased by foundry, translate, until 23:30', details: {} },
        });
        return true;
      }
      ctx.send(res, 200, { job_id: ctx.newJobId() });
      return true;
    }
    return false;
  });
}

function newScript(over) {
  return {
    activityReads: 0,
    submitted: [],
    refuseSubmit: false,
    unreachableActivity: false,
    current: () => ({}),
    ...over,
  };
}

function entry(over) {
  return {
    jobType: 'tts',
    model: 'mistborn',
    localId: 'step_hardkill',
    owns: [],
    submittedAt: '2026-09-19T22:00:00.000Z',
    ...over,
  };
}

function resetLedger() {
  try { fs.unlinkSync(ledger.inFlightLedgerPath()); } catch { /* not there */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// The pure rule: who is allowed to keep the card
// ─────────────────────────────────────────────────────────────────────────────

it('the unload job type is a LOOKUP, never `unload-${kind}` spelled out', () => {
  assert.strictEqual(sweep.unloadJobTypeForResidentKind('llm'), 'unload-model');
  assert.strictEqual(sweep.unloadJobTypeForResidentKind('tts'), 'unload-voice');
  assert.strictEqual(sweep.unloadJobTypeForResidentKind('align'), 'unload-aligner');
  assert.strictEqual(sweep.unloadJobTypeForResidentKind('denoise'), 'unload-denoiser');
  assert.strictEqual(sweep.unloadJobTypeForResidentKind('embed'), null,
    'a kind this build has not heard of is null — a manufactured job type is a 400 mid-quit');
});

it('cardHeldBy names every real holder, and only ours is not one', () => {
  const ours = new Set(['job-ours']);
  const base = { running: [], queued: [] };
  assert.strictEqual(sweep.cardHeldBy(activityShape(base), ours), null);
  assert.strictEqual(sweep.cardHeldBy(activityShape({ ...base, running: [job({ job_id: 'job-ours' })] }), ours), null,
    'our own cancelled job is not somebody else holding the card');
  assert.match(sweep.cardHeldBy(activityShape({ ...base, running: [job({ job_id: 'job-theirs' })] }), ours), /job-theirs/);
  assert.match(sweep.cardHeldBy(activityShape({ ...base, queued: [job({ job_id: 'job-next' })] }), ours), /queued/);
  assert.match(sweep.cardHeldBy(activityShape({ ...base, claim: { heldBy: 'the extension' } }), ours), /claim/);
  assert.match(sweep.cardHeldBy(activityShape({ ...base, lease: { leaseId: 'l1' } }), ours), /lease/);
  assert.match(sweep.cardHeldBy(activityShape({ ...base, chat: { inFlight: 3, rows: [] } }), ours), /3 chat/);
  assert.match(sweep.cardHeldBy(activityShape({ ...base, stopping: { id: 'qwen3', pids: [] } }), ours), /stop of qwen3/);
});

/** The SDK's camelCase `Activity`, as `cardHeldBy` receives it. */
function activityShape(over) {
  return {
    running: [], queued: [], claim: null, lease: null, streaming: null,
    chat: { inFlight: 0, rows: [] }, stopping: null, resident: null,
    ...over,
    running: (over.running ?? []).map(camelJob),
    queued: (over.queued ?? []).map(camelJob),
  };
}
function camelJob(row) {
  return { jobId: row.job_id, type: row.type, client: row.client };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Two entries on two servers
// ─────────────────────────────────────────────────────────────────────────────

it('two jobs on two servers are both DELETEd, and a resident nobody holds is unloaded', async () => {
  resetLedger();
  const scriptA = newScript();
  const scriptB = newScript();
  const fakeA = await fakeWithActivity(scriptA);
  const fakeB = await fakeWithActivity(scriptB);
  const nameA = registerFake(fakeA.url);
  const nameB = registerFake(fakeB.url);

  // Each server starts with OUR job on the lane and the voice resident. It
  // leaves the lane once the DELETE has landed — which is what the poll is for.
  scriptA.current = () => (fakeA.state.cancelled.includes('job-a')
    ? { resident: { kind: 'tts', id: 'mistborn', since: 'x', memory_bytes_estimate: null } }
    : { resident: { kind: 'tts', id: 'mistborn', since: 'x', memory_bytes_estimate: null }, running: [job({ job_id: 'job-a' })] });
  scriptB.current = () => (fakeB.state.cancelled.includes('job-b')
    ? { resident: { kind: 'llm', id: 'qwen3', since: 'x', memory_bytes_estimate: null } }
    : { resident: { kind: 'llm', id: 'qwen3', since: 'x', memory_bytes_estimate: null }, running: [job({ job_id: 'job-b', type: 'align', model: 'qwen3' })] });

  ledger.recordInFlight(entry({ server: nameA, jobId: 'job-a', owns: ['/scratch/ebook-a'] }));
  ledger.recordInFlight(entry({ server: nameB, jobId: 'job-b', jobType: 'align', model: 'qwen3' }));

  const lines = [];
  const report = await sweep.sweepCrucibleInFlight({
    reason: 'a keeper is quitting', timing: FAST, log: (line) => lines.push(line),
  });

  try {
    assert.deepStrictEqual(fakeA.state.cancelled, ['job-a'], 'server A got exactly one DELETE');
    assert.deepStrictEqual(fakeB.state.cancelled, ['job-b'], 'server B got exactly one DELETE');
    assert.ok(scriptA.activityReads > 0 && scriptB.activityReads > 0,
      'each server is POLLED — a 200 on the DELETE is not the job having stopped');
    assert.deepStrictEqual(scriptA.submitted.map((body) => body.type), ['unload-voice'],
      'a tts resident nobody holds is taken off with unload-voice');
    assert.strictEqual(scriptA.submitted[0].model, 'mistborn', 'and it names the voice that was resident');
    assert.deepStrictEqual(scriptB.submitted.map((body) => body.type), ['unload-model'],
      'an llm resident takes unload-model — the kind decides, not the job type');
    assert.deepStrictEqual(ledger.readInFlightLedger(), [],
      'a job the server confirmed cancelled is forgotten');
    assert.deepStrictEqual([...report.scratchOwned], ['/scratch/ebook-a'],
      'the scratch a dead job owned is handed on to the scratch sweep');
    assert.strictEqual(report.servers.length, 2);
    assert.ok(report.servers.every((row) => row.unloadJobId !== null));
  } finally {
    await fakeA.close();
    await fakeB.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) The card belongs to somebody else
// ─────────────────────────────────────────────────────────────────────────────

it('a resident another client is running against is LEFT ALONE, with one named line', async () => {
  resetLedger();
  const script = newScript();
  const fake = await fakeWithActivity(script);
  const name = registerFake(fake.url);
  // Ours goes; a stranger's translate job is still on the card.
  script.current = () => ({
    resident: { kind: 'llm', id: 'qwen3', since: 'x', memory_bytes_estimate: null },
    running: fake.state.cancelled.includes('job-ours')
      ? [job({ job_id: 'job-theirs', type: 'translate', model: 'qwen3', client: 'foundry crucible-client/1.0.6' })]
      : [job({ job_id: 'job-ours' }), job({ job_id: 'job-theirs', type: 'translate', model: 'qwen3', client: 'foundry crucible-client/1.0.6' })],
  });
  ledger.recordInFlight(entry({ server: name, jobId: 'job-ours' }));

  const lines = [];
  await sweep.sweepCrucibleInFlight({ reason: 'a keeper is quitting', timing: FAST, log: (line) => lines.push(line) });

  try {
    assert.deepStrictEqual(fake.state.cancelled, ['job-ours'],
      'OUR job is cancelled and the stranger\'s is not touched');
    assert.deepStrictEqual(script.submitted, [],
      'nothing is unloaded out from under another client — every install reports the same name, '
      + 'so a job id we wrote down is the only thing this app can claim');
    const said = lines.filter((line) => /using it — leaving it alone/.test(line));
    assert.strictEqual(said.length, 1, `exactly one named line, got: ${lines.join(' | ')}`);
    assert.match(said[0], /job-theirs/, 'and it names WHO is holding it');
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) A server that is not there
// ─────────────────────────────────────────────────────────────────────────────

it('an unreachable server is logged, the sweep goes on, and its row is KEPT for next start', async () => {
  resetLedger();
  const live = newScript();
  const fakeLive = await fakeWithActivity(live);
  const nameLive = registerFake(fakeLive.url);
  live.current = () => ({});

  // A fake started and immediately closed: a port with nothing on it.
  const dead = await fakeWithActivity(newScript());
  const nameDead = registerFake(dead.url);
  await dead.close();

  ledger.recordInFlight(entry({ server: nameDead, jobId: 'job-gone', owns: ['/scratch/ebook-gone'] }));
  ledger.recordInFlight(entry({ server: nameLive, jobId: 'job-live' }));

  const lines = [];
  const report = await sweep.sweepCrucibleInFlight({
    reason: 'a keeper is quitting', timing: FAST, log: (line) => lines.push(line),
  });

  try {
    assert.deepStrictEqual(fakeLive.state.cancelled, ['job-live'],
      'the reachable server is still swept — one dead machine does not stop the rest');
    const kept = report.kept.map((row) => row.jobId);
    assert.deepStrictEqual(kept, ['job-gone'],
      'a job on a machine that is asleep KEEPS its row — forgetting it is a card held forever');
    assert.ok(lines.some((line) => /could NOT cancel .*job-gone/.test(line)),
      `the failure is named: ${lines.join(' | ')}`);
    assert.deepStrictEqual([...report.scratchOwned], [],
      'and its scratch is NOT swept: a job that may still be running owns what it is writing');
  } finally {
    await fakeLive.close();
  }
});

it('an empty ledger asks nothing of anybody', async () => {
  resetLedger();
  const lines = [];
  const report = await sweep.sweepCrucibleInFlight({ reason: 'nothing to do', timing: FAST, log: (line) => lines.push(line) });
  assert.deepStrictEqual(report.jobs, []);
  assert.deepStrictEqual(report.servers, []);
  assert.deepStrictEqual(lines, [], 'a clean quit says nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring: the ledger is written by the DOOR, not by the caller
// ─────────────────────────────────────────────────────────────────────────────

it('runCrucibleJob records the job at submit and forgets it at the terminal frame', async () => {
  resetLedger();
  const job = require(path.join(DIST, 'crucible', 'job.js'));
  let duringTheJob = null;

  const fake = await startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      send(res, 200, { job_id: id });
      return true;
    }
    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (events && req.method === 'GET') {
      // READ HERE: the job exists on the server and its stream is open, which
      // is exactly the moment a ctrl-C strands it. The row must already be on
      // disk — recording it after the job ends would record nothing that
      // matters.
      duringTheJob = ledger.readInFlightLedger();
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      sse.frame('done', { artifacts: [] });
      sse.end();
      return true;
    }
    return false;
  });
  const name = registerFake(fake.url);

  try {
    await job.runCrucibleJob({
      server: name, type: 'align', model: 'qwen3-aligner', params: {}, inputs: {},
      localId: 'step_wiring', owns: ['/scratch/ebook-wiring'],
    });
    assert.strictEqual(duringTheJob.length, 1, 'the row is on disk WHILE the job runs');
    assert.strictEqual(duringTheJob[0].jobType, 'align');
    assert.strictEqual(duringTheJob[0].model, 'qwen3-aligner');
    assert.strictEqual(duringTheJob[0].localId, 'step_wiring', "the app's own id, so a log line names a row a person can see");
    assert.deepStrictEqual(duringTheJob[0].owns, ['/scratch/ebook-wiring']);
    assert.deepStrictEqual(ledger.readInFlightLedger(), [],
      'and the `done` frame takes it out — a finished job is not a card to give back');
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) The scratch root
// ─────────────────────────────────────────────────────────────────────────────

it('a rescuable session is promoted into the project cache and THEN removed; a held landing EPUB is kept', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-scratch-sweep-'));
  const scratch = path.join(root, 'tmp');
  const project = path.join(root, 'projects', 'A_Book_-_An_Author_(2026)');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  // A real-shaped render session: ebook-<uuid>/<hash>/{session-state.json,
  // chapters/sentences/*.flac} plus the ownership sidecar prep writes.
  const session = path.join(scratch, 'ebook-1111');
  const hash = path.join(session, 'abcdef0123456789');
  fs.mkdirSync(path.join(hash, 'chapters', 'sentences'), { recursive: true });
  fs.writeFileSync(path.join(hash, 'chapters', 'sentences', '0001.flac'), 'not really audio');
  fs.writeFileSync(path.join(hash, 'session-state.json'), JSON.stringify({
    chapter_sentences: [['One sentence.']],
  }), 'utf-8');
  fs.writeFileSync(path.join(session, 'bookforge-session.json'), JSON.stringify({
    jobId: 'step_rescue', bfpPath: project, language: 'en',
    createdAt: '2026-09-19T22:00:00.000Z', host: os.hostname(), pid: process.pid,
  }), 'utf-8');

  const heldLanding = path.join(scratch, 'implied-held');
  const staleLanding = path.join(scratch, 'implied-stale');
  fs.mkdirSync(heldLanding, { recursive: true });
  fs.mkdirSync(staleLanding, { recursive: true });
  fs.writeFileSync(path.join(heldLanding, 'A Book.epub'), 'PK');
  fs.writeFileSync(path.join(staleLanding, 'An Old Book.epub'), 'PK');

  const { rescueOrphanedScratchSessions, foreignSessionHost } = require(path.join(DIST, 'parallel-tts-bridge.js'));
  // What the queue still names: the held landing folder, by its own basename —
  // exactly what main.ts's liveStepIds contributes for a step whose config
  // points into it.
  const wanted = new Set(['implied-held']);
  const plan = await scratchSweep.planScratchSweepOf(scratch, wanted, foreignSessionHost);

  assert.deepStrictEqual([...plan.rescue], ['ebook-1111'], 'the session is handed to the rescue');
  assert.deepStrictEqual([...plan.keptForQueue], [{ name: 'implied-held', wanted: 'implied-held' }],
    'a landing EPUB a live step still names is KEPT — deleting it is deleting the book prep reads');
  assert.deepStrictEqual([...plan.remove].sort(), ['ebook-1111', 'implied-stale'],
    'everything else goes, session included — after the rescue');

  const lines = [];
  await scratchSweep.runScratchSweep(scratch, plan, rescueOrphanedScratchSessions, (line) => lines.push(line));

  assert.ok(fs.existsSync(heldLanding), 'the held landing folder survived the sweep');
  assert.ok(!fs.existsSync(staleLanding), 'the unreferenced one did not');
  assert.ok(!fs.existsSync(session), 'and neither did the session, once it had been rescued');
  const cached = path.join(project, 'stages', '03-tts', 'sessions', 'en', 'ebook-1111');
  assert.ok(fs.existsSync(cached),
    `RESCUE FIRST, DELETE SECOND: the sentences must be in the project cache at ${cached} before `
    + 'the session is removed — this is the resume checkpoint an interrupted run leaves behind');
  assert.ok(lines.some((line) => /implied-stale/.test(line)), `deletions are logged by name: ${lines.join(' | ')}`);
});

it("another machine's session is neither rescued nor removed", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-scratch-foreign-'));
  const session = path.join(scratch, 'ebook-2222');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'bookforge-session.json'), JSON.stringify({
    jobId: 'step_elsewhere', bfpPath: '/elsewhere/projects/X', language: 'en',
    createdAt: '2026-09-18T06:36:59.096Z', host: 'a-different-computer', pid: 1,
  }), 'utf-8');

  const { rescueOrphanedScratchSessions, foreignSessionHost } = require(path.join(DIST, 'parallel-tts-bridge.js'));
  const plan = await scratchSweep.planScratchSweepOf(scratch, new Set(), foreignSessionHost);
  assert.deepStrictEqual([...plan.keptForeign], [{ name: 'ebook-2222', host: 'a-different-computer' }]);
  assert.deepStrictEqual([...plan.remove], [],
    'MEASURED 2026-09-05: this sweep deleted a session the other machine was rendering into, and '
    + 'the render went on to publish audio with no text over a complete cache');

  await scratchSweep.runScratchSweep(scratch, plan, rescueOrphanedScratchSessions, () => undefined);
  assert.ok(fs.existsSync(session));
});

it('the plan is pure: the same input always decides the same way', () => {
  const plan = scratchSweep.planScratchSweep({
    names: ['ebook-a', 'ebook-b', 'implied-c', 'gap-step_7', 'something-else'],
    wantedByQueue: new Set(['step_7']),
    foreignHosts: new Map([['ebook-b', 'the-pc']]),
  });
  assert.deepStrictEqual([...plan.rescue], ['ebook-a']);
  assert.deepStrictEqual([...plan.remove], ['ebook-a', 'implied-c', 'something-else'],
    'an unrecognised scratch kind is swept too — that is how the root stays empty');
  assert.deepStrictEqual([...plan.keptForQueue], [{ name: 'gap-step_7', wanted: 'step_7' }],
    'a name that CONTAINS a live step id is kept: `gap-<stepId>` is named FOR a step, not after it');
  assert.deepStrictEqual([...plan.keptForeign], [{ name: 'ebook-b', host: 'the-pc' }]);
});

(async () => {
  for (const run of queued) await run();
  summary('crucible quit/start sweep');
})();
