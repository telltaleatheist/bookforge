#!/usr/bin/env node
/**
 * KEEPER: Crucible's server-side queue (crucible docs/QUEUE.md, v1.0.71) as
 * BookForge reads it — `shared/crucible/server-queue.ts`,
 * `electron/crucible/queue-wait.ts`, the `removed` arms of `crucible/job.ts`,
 * the step seam (`queue-steps/runtime.ts`) and the scheduler's
 * `queuesOnServer` (`shared/queue/wait-for.ts`).
 *
 * What it pins:
 *  - the job door SUBMITS WITH `queue` (24 h), and a `queued` frame becomes the
 *    row's "waiting, #N of M in crucible "X"'s line" sentence;
 *  - `removed {expired}` is a TRANSIENT refusal (the row parks and resubmits);
 *  - `removed {operator}` carries `removedLine` and is NOT transient (the row
 *    goes back to Pending, never resubmitted); `removed {client}` is a cancel;
 *  - a step that queues on the server joins a POLLED busy card, never a REFUSED
 *    one, and an `any` row takes the shortest line.
 *
 * Runs against dist/electron (npx tsc -p tsconfig.electron.json).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const DIST = path.join(REPO, 'dist');
const JOB = path.join(DIST, 'electron', 'crucible', 'job.js');
if (!fs.existsSync(JOB)) {
  console.log(skipLine('dist/electron/crucible/job.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
installElectronStub('bf-crucible-server-queue-');
const job = require(JOB);
const servers = require(path.join(DIST, 'electron', 'crucible', 'servers.js'));
const policy = require(path.join(DIST, 'shared', 'crucible', 'server-queue.js'));
const queueWait = require(path.join(DIST, 'electron', 'crucible', 'queue-wait.js'));
const runtime = require(path.join(DIST, 'electron', 'queue-steps', 'runtime.js'));
const waitFor = require(path.join(DIST, 'shared', 'queue', 'wait-for.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/** A fake whose one job waits in line at #2 of 3, then ends as `ending` says. */
function startQueueFake(ending) {
  const submitted = [];
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      submitted.push(body);
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      send(res, 202, { job_id: id, resume_id: null, queued: true, position: 2 });
      return true;
    }
    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (events && req.method === 'GET') {
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: 2, of: 3, max_wait_s: 86400, expires_at: '2026-10-01T00:00:00Z' });
      sse.frame('queued', { position: 1, of: 2, max_wait_s: 86400, expires_at: '2026-10-01T00:00:00Z' });
      if (ending === 'done') {
        sse.frame('started', { waited_s: 12 });
        sse.frame('done', { artifacts: [], resident: null });
      } else {
        sse.frame('removed', {
          reason: ending, message: `removed (${ending}) by the fake`, waited_s: 30, at: '2026-09-30T12:00:00Z',
        });
      }
      sse.end();
      return true;
    }
    return false;
  }).then((fake) => Object.assign(fake, { submitted }));
}

async function runAgainst(ending) {
  const fake = await startQueueFake(ending);
  const server = registerFake(fake.url);
  const progress = [];
  let thrown = null;
  try {
    await job.runCrucibleJob({
      server, type: 'echo', params: {}, inputs: { 'a.txt': Buffer.from('x') },
      onProgress: (p) => progress.push(p),
    });
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }
  return { server, submitted: fake.submitted, progress, thrown };
}

(async () => {
  await check('the job door submits WITH queue, for the batch wait (24 h)', async () => {
    const { submitted, thrown } = await runAgainst('done');
    assert.strictEqual(thrown, null, `the job should finish: ${thrown && thrown.message}`);
    assert.strictEqual(submitted.length, 1);
    assert.deepStrictEqual(submitted[0].queue, { max_wait_s: policy.CRUCIBLE_BATCH_QUEUE.maxWaitS });
    assert.strictEqual(policy.CRUCIBLE_BATCH_QUEUE.maxWaitS, 86400);
    assert.strictEqual(policy.CRUCIBLE_CLIENT_QUEUE_DEFAULT, false, 'nothing queues by accident');
  });

  await check('a `queued` frame surfaces as the row\'s position sentence', async () => {
    const { server, progress } = await runAgainst('done');
    const queued = progress.filter((p) => p.kind === 'queued');
    assert.ok(queued.length >= 2, `two queued frames, got ${JSON.stringify(progress)}`);
    assert.strictEqual(queued[0].message, `waiting, #2 of 3 in crucible "${server}"'s line`);
    assert.strictEqual(queued[1].message, `waiting, #1 of 2 in crucible "${server}"'s line`);
  });

  await check('removed {expired} is WEATHER: transient, so the row parks and resubmits', async () => {
    const { thrown } = await runAgainst('expired');
    assert.ok(thrown instanceof job.CrucibleJobRefused, `got ${thrown}`);
    assert.strictEqual(thrown.code, 'crucible_removed_expired');
    assert.ok(runtime.transientLineOf(thrown), 'a transient line parks the row');
    assert.strictEqual(runtime.removedLineOf(thrown), undefined);
    assert.strictEqual(runtime.busyLineOf(thrown), undefined);
  });

  await check('removed {server_restart} is weather too', async () => {
    const { thrown } = await runAgainst('server_restart');
    assert.ok(runtime.transientLineOf(thrown), 'transient');
  });

  await check('removed {operator} goes back to Pending: removedLine, never transient', async () => {
    const { thrown } = await runAgainst('operator');
    assert.ok(thrown instanceof job.CrucibleJobRefused, `got ${thrown}`);
    assert.strictEqual(runtime.transientLineOf(thrown), undefined, 'an operator removal is NOT resubmitted');
    assert.match(runtime.removedLineOf(thrown), /removed from crucible ".*"'s line by an operator/);
    const step = runtime.stepFailure('x', undefined, undefined, runtime.removedLineOf(thrown));
    assert.strictEqual(runtime.removedLineOf(step), runtime.removedLineOf(thrown), 'the seam carries it');
    assert.strictEqual(step.transient, undefined);
  });

  await check('removed {client} is our own cancel, not a failure', async () => {
    const { thrown } = await runAgainst('client');
    assert.ok(thrown instanceof job.CrucibleJobCancelled, `got ${thrown}`);
  });

  await check('an unknown removal reason is read as an operator\'s (conservative: no resubmit)', () => {
    assert.strictEqual(policy.crucibleRemovalDisposition('some_future_reason'), 'operator');
    assert.strictEqual(policy.crucibleRemovalDisposition('expired'), 'weather');
    assert.strictEqual(policy.crucibleRemovalDisposition('client'), 'ours');
  });

  await check('the line watch: heartbeat answers beat the stall clock, `started` ends the wait', async () => {
    let beats = 0;
    const places = [];
    const watch = queueWait.watchQueueWait({
      server: 's', jobId: 'j', everyMs: 10,
      client: { queueHeartbeat: async () => ({ position: 1, expiresAt: 'x' }) },
      beat: () => { beats += 1; },
      onPlace: (p) => places.push(p.line),
    });
    watch.seen('queued', { position: 3, of: 4 });
    assert.ok(watch.waiting());
    await new Promise((r) => setTimeout(r, 45));
    assert.ok(beats >= 1, 'a heartbeat answer is the server talking about this job');
    assert.ok(places.includes('waiting, #1 of 4 in crucible "s"\'s line'), places.join(' | '));
    watch.seen('started', { waited_s: 1 });
    assert.ok(!watch.waiting());
    const after = beats;
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(beats, after, 'no heartbeat once the job is on the lane');
    watch.stop();
  });

  await check('scheduler: a step that queues on the server JOINS a polled busy card', () => {
    const facts = (state, queuesOnServer) => ({
      waitFor: 'a', resolved: undefined,
      ranked: [{ name: 'a', enabled: true }, { name: 'b', enabled: true }],
      state, gpuSlotTaken: () => null, holdsThisCard: false,
      needClass: undefined, canServe: () => true, queuesOnServer,
    });
    const polled = () => ({ kind: 'busy', line: 'GPU busy: foundry', polled: { queueDepth: 2 } });
    const refused = () => ({ kind: 'busy', line: 'GPU busy: foundry' });
    assert.deepStrictEqual(waitFor.decideWaitFor(facts(polled, true)), { kind: 'run', server: 'a' });
    assert.strictEqual(waitFor.decideWaitFor(facts(polled, false)).kind, 'hold', 'non-queueable work parks');
    assert.strictEqual(waitFor.decideWaitFor(facts(refused, true)).kind, 'hold',
      'a REFUSED busy (a door that shut) is honoured by everyone');
  });

  await check('scheduler: `any` prefers a free server, then the SHORTEST line', () => {
    const depth = { a: 5, b: 1, c: 3 };
    const base = (state) => ({
      waitFor: waitFor.WAIT_FOR_ANY, resolved: undefined,
      ranked: [{ name: 'a', enabled: true }, { name: 'b', enabled: true }, { name: 'c', enabled: true }],
      state, gpuSlotTaken: () => null, holdsThisCard: false,
      needClass: undefined, canServe: () => true, queuesOnServer: true,
    });
    const allBusy = (n) => ({ kind: 'busy', line: `busy ${n}`, polled: { queueDepth: depth[n] } });
    assert.deepStrictEqual(waitFor.decideWaitFor(base(allBusy)), { kind: 'run', server: 'b' });
    const cFree = (n) => (n === 'c' ? { kind: 'ready' } : allBusy(n));
    assert.deepStrictEqual(waitFor.decideWaitFor(base(cFree)), { kind: 'run', server: 'c' });
    const aUnknown = (n) => (n === 'a' ? { kind: 'unknown' } : allBusy(n));
    assert.strictEqual(waitFor.decideWaitFor(base(aUnknown)).kind, 'ask',
      'an unasked server is asked before a line is joined — it may be free');
  });

  await check('409 queue_full is a WAIT with the line named, not a failure', () => {
    const { CrucibleRefused } = require('@crucible/client');
    const err = new CrucibleRefused(409, 'queue_full', 'too many waiting', { scope: 'client', limit: 50, depth: 50 });
    const described = job.describeCrucibleJobRefusal(err, 'shift', 'the asr job');
    assert.match(runtime.busyLineOf(described), /crucible "shift"'s line is full/);
  });

  summary('crucible server queue');
  try { fs.rmSync(path.join(os.tmpdir(), 'bf-crucible-server-queue-'), { recursive: true, force: true }); } catch { /* scratch */ }
})();
