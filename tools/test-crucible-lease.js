#!/usr/bin/env node
/**
 * THE LEASE — the thing that stops a Crucible unloading the model mid-run.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-lease.js
 *
 * Owen, 2026-09-14: *"Models should always be unloaded when we're done with
 * them. Every time."* Crucible now unloads the resident model the moment no job,
 * no lease, no streaming session and no chat hold it. Three of those four hold
 * themselves; a chat holds NOTHING, deliberately. So every chat-shaped run this
 * app makes — a cleanup, a text act, a page read — is a sequence of requests
 * between which that server is idle by every measure it publishes.
 *
 * **And the chat door never loads.** So the failure is not slowness: the run's
 * next request is answered `model_not_resident` and the book dies at chunk 2 of
 * 600. The lease is what makes these doors work at all, which is why every check
 * below is about a way it could quietly not be held.
 *
 *  1. The happy path, ON THE WIRE — the act and the ttl in the body, the model in
 *     the path, the User-Agent that makes the holder nameable, and a DELETE at
 *     the end. A lease nobody can see is a lease that is not being taken.
 *  2. THE HEARTBEAT CADENCE IS A THIRD OF THE TTL. A half means one dropped
 *     packet costs the card; nothing means the lease expires under a live run,
 *     which is the eviction it exists to prevent, arriving on a schedule.
 *  3. RELEASED ON EVERY PATH — success, a throw, a cancel, and the app quitting.
 *     A leak holds somebody else's card for the whole ttl and refuses their work
 *     by name while nothing is running.
 *  4. `404 unknown_lease` ON A RELEASE IS A NO-OP. Released and expired both mean
 *     nothing is held, which is what the release wanted. Failing a finished book
 *     over tidying that already happened would be reporting a loss that did not
 *     occur.
 *  5. `404 unknown_lease` ON A HEARTBEAT IS A RE-LEASE. Leases live in memory and
 *     a restart forgets them, so this means the card is unprotected NOW, mid-book.
 *     Foundry's dispatch re-leases; two clients guessing differently at one
 *     restart is how one of them loses a book.
 *  5b. AND A RE-LEASE THAT IS REFUSED ENDS THE BEAT. It is asked once. A model
 *     that has left the card refuses it `not_resident` and a lease never loads
 *     one, so the refusal cannot become a success — and the timer that went on
 *     asking was measured on Foundry's identical branch at 264 × (404 → 409)
 *     over ten hours with nothing in any log. One line, then the run goes on
 *     unprotected AND SAID SO.
 *  6. `409 leased` IS A WAIT WITH A NAME. The holder, the act, the kind and the
 *     expiry reach the reader — through the same `busyLine` road `server_busy`
 *     already travels, so a queue row holds instead of failing. It is the SDK's
 *     own `CrucibleLeased`, not a second class of the same name beside it: two
 *     were catchable in different doors and the same 409 was a wait in one and
 *     an unnamed failure in the next. And it is never retried here: a sleep loop
 *     in a client library is a queue with a policy nobody chose.
 *  6b. AND THE CLEANUP DOOR'S WAIT REACHES THE QUEUE. `ai-bridge`'s leased arm
 *     said "a WAIT, not a crash" and returned a plain failure; the line now
 *     travels `cleanupEpub` → `runSimplifyPass` → `noteStepBusy`, three links
 *     each of which silently drops it if forgotten.
 *  7. ONE LEASE FOR A WHOLE MULTI-REQUEST ACT. One per request would be the
 *     reload this exists to prevent, wearing a different hat — and on the unload
 *     build the model is gone between the release and the next take.
 *  8. THE ONE-JOB DOORS DO NOT LEASE. A job already holds the lane, and `tts`/
 *     `align` are in crucible's `EVICTS_THE_RESIDENT_MODEL` — so a lease around
 *     one would have the server refuse the very job that took it. Pinned twice:
 *     a real job through `runCrucibleJob` takes no lease, and no one-job door
 *     module mentions the lease module at all.
 *
 *  9. A HUNG HEARTBEAT HAS A CLOCK (bug hunt C7, 2026-09-20). The POST was a
 *     bare `fetch` with no signal and the timer skips a tick while one is in
 *     flight, so ONE request that never settled silenced every later beat: the
 *     lease lapsed at its ttl with nothing in any log, and `release()` then
 *     awaited the same promise on the quit path.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no registry but its own.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
  leaseRoutes, modelLeasedRefusal, unknownLeaseRefusal,
} = require('./fake-crucible.js');
const { skipLine } = require('./keeper-skip.js');

const LEASE = path.join(REPO, 'dist', 'electron', 'crucible', 'lease.js');
if (!fs.existsSync(LEASE)) {
  console.log(skipLine('dist/electron/crucible/lease.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

installElectronStub('bf-crucible-lease-');

const lease = require(LEASE);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const textVenue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-venue.js'));
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
// The SDK ITSELF, for the one table it owns: `isServerSpecificRefusal` lists
// `leased` since v1.0.0, so this suite asks the owner rather than a local copy.
const sdk = require('@crucible/client');

// The shared fake names both the resolved SDK client and its lease token source.
const nameFake = fakeNamer(servers);

/** A wait of `ms`, for the checks that watch a heartbeat actually arrive. */
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { check, summary } = makeChecker();

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. The happy path, on the wire
  // ───────────────────────────────────────────────────────────────────────────
  await check('a run takes one lease, names its act and ttl, and releases it', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const answer = await lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
        async (held) => {
          assert.strictEqual(held.server, server);
          assert.strictEqual(held.kind, 'model');
          assert.strictEqual(held.leased, 'qwen3.5-9b');
          assert.strictEqual(held.act, 'clean');
          assert.strictEqual(lease.openCrucibleLeaseCount(), 1, 'the lease is open while the run is');
          return 'the book';
        },
      );
      assert.strictEqual(answer, 'the book', 'the run\'s own value comes back untouched');

      assert.strictEqual(routes.lease.taken.length, 1, 'exactly one lease was taken');
      const taken = routes.lease.taken[0];
      assert.strictEqual(taken.model, 'qwen3.5-9b', 'the model is in the ROUTE, not the body');
      assert.strictEqual(taken.act, 'clean', 'the act is named truthfully in the body');
      assert.strictEqual(taken.ttlSeconds, lease.CRUCIBLE_LEASE_TTL_SECONDS,
        'the module\'s declared liveness ttl crossed, not a number invented per call');
      // The server records the User-Agent as the lease's `client`, which is what
      // a bench shows when it says whose run is on the card. A lease taken
      // anonymously is a `leased` nobody can act on.
      assert.match(taken.userAgent, /^bookforge crucible-client\//,
        'the holder names itself the way every other BookForge call does');

      assert.deepStrictEqual(routes.lease.released.map((r) => r.leaseId), [taken.leaseId],
        'the lease it took is the lease it gave back');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0, 'nothing is left open');
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. The heartbeat
  // ───────────────────────────────────────────────────────────────────────────
  await check('the heartbeat cadence is a THIRD of the ttl, not a half and not never', () => {
    assert.strictEqual(lease.crucibleHeartbeatIntervalMs(120), 40000);
    assert.strictEqual(lease.crucibleHeartbeatIntervalMs(30), 10000);
    assert.strictEqual(lease.crucibleHeartbeatIntervalMs(3600), 1200000);
    // Two consecutive losses must be survivable: three beats inside one ttl.
    assert.ok(lease.crucibleHeartbeatIntervalMs(lease.CRUCIBLE_LEASE_TTL_SECONDS) * 3
      <= lease.CRUCIBLE_LEASE_TTL_SECONDS * 1000);
  });

  await check('a long run is heartbeated while it is in flight', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'translate', heartbeatMs: 25, onLog: () => {} },
        async () => { await after(140); },
      );
      assert.ok(routes.lease.heartbeats.length >= 3,
        `a 140 ms run at a 25 ms cadence heartbeats at least 3 times, saw `
        + `${routes.lease.heartbeats.length}`);
      const id = routes.lease.taken[0].leaseId;
      assert.ok(routes.lease.heartbeats.every((h) => h.leaseId === id),
        'every heartbeat names the lease this run holds');
    } finally {
      await fake.close();
    }
  });

  await check('the heartbeat stops when the run does', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', heartbeatMs: 20, onLog: () => {} },
        async () => { await after(60); },
      );
      const beatsAtRelease = routes.lease.heartbeats.length;
      await after(120);
      assert.strictEqual(routes.lease.heartbeats.length, beatsAtRelease,
        'a released lease is not still being heartbeated — that would keep somebody '
        + 'else\'s card claimed by a run that finished');
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Released on every path
  // ───────────────────────────────────────────────────────────────────────────
  await check('a run that THROWS still releases, and the throw is not swallowed', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await assert.rejects(
        () => lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'simplify', onLog: () => {} },
          async () => { throw new Error('the engine died at block 400'); },
        ),
        /the engine died at block 400/,
        'the run\'s own failure reaches the caller unchanged',
      );
      assert.strictEqual(routes.lease.released.length, 1, 'and the card went back anyway');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  await check('a CANCELLED run releases — the ✕ must not pin a card for the whole ttl', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const controller = new AbortController();
      const running = lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', heartbeatMs: 20, onLog: () => {} },
        () => new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Job cancelled')));
        }),
      );
      await after(40);
      controller.abort();
      await assert.rejects(() => running, /Job cancelled/);
      assert.strictEqual(routes.lease.released.length, 1);
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  await check('the app quitting releases every lease it is still holding', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      // A lease taken directly, as a run in flight holds one, and then the quit
      // path rather than the run's own `finally`.
      const held = await lease.takeCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'analysis', heartbeatMs: 20, onLog: () => {} });
      assert.strictEqual(lease.openCrucibleLeaseCount(), 1);
      await lease.releaseAllCrucibleLeases();
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
      assert.deepStrictEqual(routes.lease.released.map((r) => r.leaseId), [held.id]);
      // Idempotent: a release that ran twice would DELETE an id somebody else may
      // by then hold.
      await held.release();
      assert.strictEqual(routes.lease.released.length, 1, 'release is idempotent');
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. 404 on a release is a no-op
  // ───────────────────────────────────────────────────────────────────────────
  await check('a 404 unknown_lease on RELEASE is a no-op, not a failed run', async () => {
    const routes = leaseRoutes({
      refuseRelease: (leaseId) => unknownLeaseRefusal(
        leaseId, 'it expired at 2026-09-14T02:02:00+00:00 and nothing heartbeated it'),
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const answer = await lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
        async () => 'the book was cleaned',
      );
      assert.strictEqual(answer, 'the book was cleaned',
        'a lease that was already gone is the state a release wanted — the finished run '
        + 'reports success, because nothing was lost');
      assert.strictEqual(routes.lease.released.length, 1, 'the DELETE was still sent');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. 404 on a heartbeat is a RE-LEASE
  // ───────────────────────────────────────────────────────────────────────────
  await check('a 404 unknown_lease on a HEARTBEAT re-leases rather than failing the run', async () => {
    // The server forgot — which is exactly what a restart does, since leases live
    // in memory there. The first heartbeat is refused; everything after it works.
    const routes = leaseRoutes({
      refuseHeartbeat: (leaseId, n) => (n === 1
        ? unknownLeaseRefusal(leaseId, 'this server never had it, or has forgotten it')
        : null),
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    const lines = [];
    try {
      await lease.withCrucibleLease(
        {
          server, kind: 'model', id: 'qwen3.5-9b', act: 'translate',
          heartbeatMs: 25, onLog: (line) => lines.push(line),
        },
        async () => { await after(160); },
      );
      assert.strictEqual(routes.lease.taken.length, 2,
        'the forgotten lease was replaced with a NEW one on the same model — not logged and '
        + 'left unprotected, and not failed');
      const [first, second] = routes.lease.taken;
      assert.strictEqual(second.model, first.model, 'the re-lease is on the same model');
      assert.strictEqual(second.act, first.act, 'and names the same act');
      assert.notStrictEqual(second.leaseId, first.leaseId);
      assert.ok(lines.some((l) => /had forgotten the lease/.test(l)),
        'and it is SAID: an eviction later in the book needs a visible cause');
      // The release must name the lease the run actually ends up holding.
      assert.deepStrictEqual(routes.lease.released.map((r) => r.leaseId), [second.leaseId]);
    } finally {
      await fake.close();
    }
  });

  await check('a heartbeat that fails for any other reason does NOT stop the run', async () => {
    const routes = leaseRoutes({
      refuseHeartbeat: (leaseId) => ({
        status: 503, code: 'server_unavailable', message: 'a blip', details: { lease_id: leaseId },
      }),
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    const lines = [];
    try {
      const answer = await lease.withCrucibleLease(
        {
          server, kind: 'model', id: 'qwen3.5-9b', act: 'clean',
          heartbeatMs: 25, onLog: (line) => lines.push(line),
        },
        async () => { await after(120); return 'finished anyway'; },
      );
      assert.strictEqual(answer, 'finished anyway',
        'the run is the thing that would notice a real problem; a lost heartbeat is a blip');
      assert.ok(lines.some((l) => /heartbeat for qwen3\.5-9b .* failed/.test(l)),
        'but never silent — a later eviction needs a cause in the log');
      assert.strictEqual(routes.lease.taken.length, 1, 'a non-404 is NOT a reason to re-lease');
    } finally {
      await fake.close();
    }
  });

  await check('a re-lease that is REFUSED stops the heartbeat: one line, and no loop',
    async () => {
      /*
       * THE OTHER HALF OF THE RESTART BRANCH, and the one that had no ending.
       *
       * `unknown_lease` says the server forgot the lease, so the client takes a
       * new one. But a re-lease is refused `not_resident` whenever the model is
       * no longer on the card — and a lease never loads one, so that refusal can
       * NEVER become a success. The branch logged it and let the timer run:
       * measured 2026-09-15 against Foundry's identical branch, 264 × (404 →
       * 409 `not_resident`) forty seconds apart for ten hours, with no backoff,
       * no give-up and nothing in the app log a person would find.
       *
       * So a refused re-lease ENDS the beat. The run continues — it is talking
       * to the same server over its own sockets and is the thing that would
       * notice a real problem — and it continues UNPROTECTED AND SAID SO, once.
       */
      const routes = leaseRoutes({
        refuseHeartbeat: (leaseId) => unknownLeaseRefusal(
          leaseId, 'this server restarted and has forgotten it'),
        refuseLease: (attempt, n) => (n === 1 ? null : {
          status: 409,
          code: 'not_resident',
          message: `nothing is serving '${attempt.model}' on this server; load it first`,
          details: { subject: attempt.model },
        }),
      });
      const fake = await startFakeCrucible(routes.handler);
      const server = nameFake(fake.url);
      const lines = [];
      try {
        const answer = await lease.withCrucibleLease(
          {
            server, kind: 'model', id: 'qwen3.5-9b', act: 'clean',
            heartbeatMs: 20, onLog: (line) => lines.push(line),
          },
          async () => { await after(300); return 'the book was cleaned'; },
        );
        assert.strictEqual(answer, 'the book was cleaned',
          'a heartbeat that gave up is not a failed run — the run is what would notice');
        assert.strictEqual(routes.lease.heartbeats.length, 1,
          'the timer STOPPED: a beat every 20ms for 300ms would have been fifteen');
        assert.strictEqual(routes.lease.refusals.length, 2,
          'exactly two refusals — the 404 that started it and the ONE re-lease it answered '
          + 'with; anything more is the loop');
        assert.strictEqual(routes.lease.taken.length, 1, 'and no new lease was ever granted');
        const gaveUp = lines.filter((l) => /gave up/i.test(l));
        assert.strictEqual(gaveUp.length, 1,
          `ONE line, not 264 — got ${lines.length} line(s): ${JSON.stringify(lines)}`);
        assert.ok(/not_resident|nothing is serving/.test(gaveUp[0]),
          `the server's OWN message is what says why; got: ${gaveUp[0]}`);
        assert.ok(/unprotected/i.test(gaveUp[0]),
          'and it says the run is going on without a lease, which is the fact a later '
          + `eviction needs a cause for; got: ${gaveUp[0]}`);
      } finally {
        await fake.close();
      }
    });

  await check('release waits for an in-flight replacement lease and deletes the new id', async () => {
    const routes = leaseRoutes({
      refuseHeartbeat: (id, n) => n === 1 ? unknownLeaseRefusal(id, 'engine restarted') : null,
    });
    let allowReplacement;
    const replacementGate = new Promise((resolve) => { allowReplacement = resolve; });
    let replacementStarted;
    const started = new Promise((resolve) => { replacementStarted = resolve; });
    let takes = 0;
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (/^\/v1\/models\/[^/]+\/lease$/.test(ctx.url.pathname) && req.method === 'POST') {
        takes++;
        if (takes === 2) { replacementStarted(); await replacementGate; }
      }
      return routes.handler(req, res, ctx);
    });
    try {
      const held = await lease.takeCrucibleLease({
        server: nameFake(fake.url), kind: 'model', id: 'qwen3.5-9b', act: 'clean', heartbeatMs: 10, onLog() {},
      });
      await started;
      const releasing = held.release();
      allowReplacement();
      await releasing;
      assert.deepStrictEqual(routes.lease.taken.map((r) => r.leaseId), ['lease-1', 'lease-2']);
      assert.deepStrictEqual(routes.lease.released.map((r) => r.leaseId), ['lease-2']);
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally { allowReplacement(); await fake.close(); }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. 409 leased is a wait with a name
  // ───────────────────────────────────────────────────────────────────────────
  const HELD = {
    leaseId: 'lease-held', client: 'foundry', act: 'translate', model: 'qwen3.5-27b',
    since: '2026-09-14T01:00:00+00:00', expiresAt: '2026-09-14T01:02:00+00:00',
  };

  await check('409 leased arrives typed, with the holder, the act and the since', async () => {
    const routes = leaseRoutes({ refuseLease: () => modelLeasedRefusal(HELD) });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      let caught = null;
      try {
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-27b', act: 'clean', onLog: () => {} },
          async () => { throw new Error('the run must never start'); },
        );
      } catch (err) { caught = err; }
      assert.ok(caught instanceof lease.CrucibleLeased, 'its own type, not a generic refusal');
      // `leased`, not `model_leased`: since crucible 5e04e5f a lease names the
      // resident THING, and a code naming one kind would be false whenever
      // narrator or the aligner holds the card.
      assert.strictEqual(caught.code, 'leased');
      assert.strictEqual(caught.holder, 'foundry');
      assert.strictEqual(caught.act, 'translate');
      assert.strictEqual(caught.since, HELD.since);
      assert.strictEqual(caught.expiresAt, HELD.expiresAt);
      assert.strictEqual(caught.leaseId, 'lease-held');
      assert.strictEqual(caught.kind, 'llm',
        'WHICH resident kind is held — a `leased` on a load-voice means one thing when a 27B '
        + 'holds the card and another when narrator does');
      /*
       * THE SDK'S LINE, because the SDK's is the ONLY `CrucibleLeased` now.
       * This module used to declare a second class of the same name for a
       * v0.5.0 pin, and the two were catchable in different doors — the SDK's
       * routes threw one, `leaseRequest` threw the other, and neither `catch`
       * saw both. The wording moved with the owner: "until <expiry>" rather
       * than "since <start>", which is the half a reader deciding whether to
       * wait actually needs.
       */
      assert.strictEqual(caught.leasedLine, `leased: foundry, translate, until ${HELD.expiresAt}`,
        'the one line a bench or a held queue row puts in front of a person');
      assert.ok(sdk.isServerSpecificRefusal(caught.code),
        'and it is server-specific: another machine\'s card is not held by this run. The SDK '
        + 'owns that table now — `isCrucibleLeasedElsewhere` was this file standing in for a '
        + 'pin that did not list `leased`, and the pin does');
      assert.strictEqual(routes.lease.taken.length, 0, 'nothing was granted');
      assert.strictEqual(routes.lease.released.length, 0,
        'and nothing is released — a lease that was never taken has no id to give back');
      assert.strictEqual(routes.lease.refusals.length, 1,
        'asked ONCE: nothing here retries a 409, because a sleep loop in a library is a '
        + 'queue with a policy nobody chose');
    } finally {
      await fake.close();
    }
  });

  await check('an unnamed holder is said to be unnamed, never guessed at', async () => {
    const routes = leaseRoutes({
      refuseLease: () => modelLeasedRefusal({ ...HELD, client: null }),
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await assert.rejects(
        () => lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-27b', act: 'clean', onLog: () => {} },
          async () => 'never'),
        (err) => {
          assert.strictEqual(err.holder, null, 'null means IT DID NOT SAY');
          assert.match(err.leasedLine, /^leased: an unnamed client, translate, until /);
          return true;
        },
      );
    } finally {
      await fake.close();
    }
  });

  await check('a text act renders leased as a WAIT the queue can hold on', async () => {
    const routes = leaseRoutes({ refuseLease: () => modelLeasedRefusal(HELD) });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const engine = {
        server, endpoint: `${fake.url}/openai`, model: 'qwen3.5-27b', act: 'clean',
        env: {}, maskedHeaders: '{}',
      };
      let caught = null;
      try {
        await textVenue.withCrucibleTextActLease(engine, async () => 'never');
      } catch (err) { caught = err; }
      assert.ok(caught instanceof Error);
      assert.strictEqual(caught.name, 'CrucibleTextActError');
      assert.strictEqual(caught.code, 'crucible_model_leased');
      // `foundry-job.ts` holds a row on ANY error carrying a string `busyLine`,
      // which is the road `server_busy` already travels. A lease wait that did not
      // carry one would FAIL the book instead of holding it.
      assert.strictEqual(caught.busyLine, `leased: foundry, translate, until ${HELD.expiresAt}`);
      assert.match(caught.message, /^crucible_model_leased: /,
        'the code is in the sentence, because a CLI and a queue row show only the message');
      assert.match(caught.message, /foundry/, 'and the holder is named in it');
    } finally {
      await fake.close();
    }
  });

  await check('a CLEANUP RUN\'s leased refusal reaches the queue as a park, link by link',
    async () => {
      /*
       * THE OTHER LEASING DOOR, AND ITS WHOLE CHAIN.
       *
       * `ai-bridge.cleanupEpub` takes the run's lease itself, and its `leased`
       * arm opened with "A 409 `leased` is a WAIT, not a crash" and then
       * returned a plain `success: false` — nothing waited, the row went red,
       * and a person had to press Retry while Foundry parked on the identical
       * refusal and came back.
       *
       * SOURCE-READ, and it says so rather than pretending otherwise: driving
       * it for real needs an EPUB, a provider record and a cleanup pass, and
       * the thing at risk is not the arithmetic but the WIRING — three links
       * that each silently drop the line if one is forgotten. Each is pinned
       * where it lives, and each assertion names what breaks without it.
       */
      const read = (...bits) => fs.readFileSync(path.join(REPO, ...bits), 'utf-8');

      const bridge = read('electron', 'ai-bridge.ts');
      assert.match(bridge, /busyLine\?: string;/,
        'EpubCleanupResult carries no busyLine, so a cleanup can no longer say "this is a wait"');
      const arm = bridge.indexOf('if (err instanceof CrucibleLeased) {');
      assert.ok(arm > 0, 'the leased arm is gone — read why before deleting this check');
      const armEnd = bridge.indexOf('    }', arm);
      assert.match(bridge.slice(arm, armEnd), /busyLine: err\.leasedLine/,
        'the leased arm reports a failure with no wait line, which is a red row');

      const passes = read('electron', 'processing-passes.ts');
      assert.match(passes, /busyLine: result\.busyLine/,
        'runSimplifyPass drops the wait line on the floor, so the step never sees it');

      /*
       * THE LAST LINK MOVED ONTO THE THROW (A5, 2026-09-19). It used to be a
       * side call — `noteStepBusy(ctx.stepId, result.busyLine)` before the
       * throw — which four modules made and five forgot. The line now rides on
       * the refusal the module throws (`stepFailure`), `launch` reads it with
       * `busyLineOf`, and `settleStep` parks the row. So what is pinned here is
       * that the pass hands the bridge's line to the seam at all, and that it
       * does not throw a bare Error past it.
       */
      const step = read('electron', 'queue-steps', 'pass.ts');
      assert.match(step, /throw stepFailure\([\s\S]*?result\.busyLine\)/,
        'the pass step no longer hands the leased card\'s holder line to the seam, so the row '
        + 'reddens instead of waiting');
      assert.ok(!/throw new Error\(result\.error/.test(step),
        'a bare Error past `stepFailure` is a row that fails on a refusal it could have waited out');
    });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. One lease for a whole multi-request act
  // ───────────────────────────────────────────────────────────────────────────
  await check('a text act takes ONE lease for a run of many requests', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const engine = {
        server, endpoint: `${fake.url}/openai`, model: 'qwen3.5-9b', act: 'simplify',
        env: {}, maskedHeaders: '{}',
      };
      let requests = 0;
      const answer = await textVenue.withCrucibleTextActLease(engine, async () => {
        // Stands in for the engine spawn: 40 blocks of a book, each an ordinary
        // chat completion that holds NOTHING on the server.
        for (let n = 0; n < 40; n += 1) {
          requests += 1;
          assert.strictEqual(routes.lease.taken.length, 1,
            `the lease is held across request ${n + 1}, not taken and released around it`);
          assert.strictEqual(routes.lease.released.length, 0,
            'and it is not released until the whole act is done');
        }
        return 'cleaned';
      });
      assert.strictEqual(answer, 'cleaned');
      assert.strictEqual(requests, 40);
      assert.strictEqual(routes.lease.taken.length, 1, 'ONE lease for forty requests');
      assert.strictEqual(routes.lease.taken[0].act, 'simplify',
        'named truthfully — the same act the engine sends in X-Crucible-Act');
      assert.strictEqual(routes.lease.released.length, 1, 'released once, at the end of the act');
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. The one-job doors do not lease
  // ───────────────────────────────────────────────────────────────────────────
  await check('a job on the lane takes NO lease — it already holds everything one would', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname === '/v1/jobs' && req.method === 'POST') {
        ctx.state.submitted.push(JSON.parse((await ctx.readBody(req)).toString('utf-8')));
        ctx.send(res, 200, { job_id: 'j-1' });
        return true;
      }
      if (/^\/v1\/jobs\/[^/]+\/events$/.test(ctx.url.pathname) && req.method === 'GET') {
        const sse = ctx.sseWriter(req, res);
        sse.frame('queued', { position: null });
        sse.frame('progress', { fraction: 1, message: 'done' });
        sse.frame('done', { artifacts: [] });
        sse.end();
        return true;
      }
      return routes.handler(req, res, ctx);
    });
    // Named through BOTH doors, at the same address: `runCrucibleJob` reaches the
    // fake through the SDK, and anything that leased would reach the same server's
    // lease routes — so a lease taken behind the job's back would show up here.
    const server = nameFake(fake.url);
    try {
      const outcome = await job.runCrucibleJob({
        server, type: 'asr', params: {}, inputs: {}, onLog: () => {},
      });
      assert.strictEqual(outcome.jobId, 'j-1');
      assert.strictEqual(routes.lease.taken.length, 0,
        'a job holds the LANE — /v1/activity reports it running and a second submit is '
        + 'refused server_busy. A lease beside it would be one fact with two owners, and for '
        + 'tts/align it would make the server refuse the job that took it.');
      assert.strictEqual(routes.lease.heartbeats.length, 0);
      assert.strictEqual(routes.lease.released.length, 0);
    } finally {
      await fake.close();
    }
  });

  await check('no one-job door, and no streaming door, reaches for the lease module', () => {
    /*
     * The behavioural pin above proves ONE door. This proves the rule, and it is
     * the check that survives somebody adding a seventh door: a module whose work
     * is one job on the lane — or a streaming session, which holds the resident
     * engine's claim outright — has no business importing this.
     */
    /*
     * `denoise.ts` LEFT this list on 2026-09-15, and it is the one exception the
     * rule always implied: the rule is about a door whose work is ONE job, and a
     * denoise pass is ~44 of them. Crucible holds the separator across those jobs
     * now (`KIND_DENOISE`), and `crucible/settle.py` clears the card the moment
     * the last holder lets go — so between block 3 and block 4 there is no holder
     * at all and the checkpoint is reloaded. The lease is what states "one more
     * block is coming", which is a fact only the client has. `align.ts` stays on
     * the list because one align job carries the whole book's chunks; if it ever
     * aligns chapter by chapter it belongs here too, for the same reason.
     */
    const mustNot = ['render.ts', 'asr.ts', 'align.ts', 'rvc.ts', 'reroll.ts', 'stream.ts'];
    for (const name of mustNot) {
      const file = path.join(REPO, 'electron', 'crucible', name);
      const source = fs.readFileSync(file, 'utf8');
      // Comments SAY why they do not lease, and that is required reading rather
      // than a violation — so only real module references count.
      const imports = /(?:from\s+['"]\.\/lease(?:\.js)?['"]|require\(\s*['"]\.\/lease(?:\.js)?['"])/.test(source);
      assert.ok(!imports, `${name} imports ./lease — a one-job or streaming door must not lease`);
      assert.match(source, /lease/i,
        `${name} says nothing about the lease; a reader asking "why not here?" must find the answer`);
    }
  });

  await check('the MANY-job door DOES lease, and says why', () => {
    /*
     * The other half of the rule above. A pass of ~44 denoise jobs against one
     * resident separator is exactly what a lease is for, and the cost of losing
     * it is measured: BookForge's own `separator_worker.py` (bookforge
     * `019afa52`) replaced a per-block model load because it was *"roughly a
     * third of the pass"*. A future edit that quietly drops the lease would put
     * that back with every job succeeding and every log clean.
     */
    const source = fs.readFileSync(
      path.join(REPO, 'electron', 'crucible', 'denoise.ts'), 'utf8');
    assert.match(source, /from\s+['"]\.\/lease(?:\.js)?['"]/,
      'denoise.ts must import ./lease — a pass is ~44 jobs and the card is cleared between them');
    assert.match(source, /takeCrucibleLease/, 'denoise.ts must actually take one');
    assert.match(source, /release\(\)/, 'and give it back, or it holds a card it has finished with');
  });

  await check('the KIND never reaches the wire — the server supplies it from the card', async () => {
    /*
     * `crucible/leases.py`: a lease names the resident THING, and there is one
     * route for all three kinds because at the moment a lease is taken the card
     * holds exactly one candidate. A `kind` in the body would be a field with no
     * question to answer and a second thing able to disagree with `resident.kind`
     * (R1). This side keeps the kind for its own log line and nothing else — so a
     * future voice lease is a caller passing a different word, not a new route.
     */
    const bodies = [];
    const routes = leaseRoutes({
      refuseLease: (attempt) => { bodies.push(attempt); return null; },
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      for (const [kind, id] of [['model', 'qwen3.5-9b'], ['voice', 'deathstalker'], ['aligner', 'qwen3-aligner']]) {
        await lease.withCrucibleLease(
          { server, kind, id, act: 'clean', onLog: () => {} }, async () => id);
      }
      assert.deepStrictEqual(
        routes.lease.taken.map((t) => t.model),
        ['qwen3.5-9b', 'deathstalker', 'qwen3-aligner'],
        'each id went on the ONE route, whatever kind the caller called it',
      );
      for (const body of bodies) {
        assert.deepStrictEqual(Object.keys(body).sort(), ['act', 'model', 'ttlSeconds', 'userAgent'],
          'the body carries the act and the ttl and nothing else — no kind');
      }
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. A HUNG HEARTBEAT (bug hunt C7, 2026-09-20)
  //
  // `leaseRequest` was a bare `fetch` with no signal, and the timer skips a tick
  // while one is in flight. So a POST that never settled made EVERY LATER TICK A
  // NO-OP: the lease lapsed at its 120 s ttl with no log line (the `catch` runs
  // only if the promise settles) and the resident model could be evicted at
  // chunk 400 of 2000 — the exact failure this module exists to prevent. And
  // `release()` then awaited the same promise and hung with it, on the quit path.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A fake whose heartbeat route NEVER ANSWERS — the socket is accepted, the
   * request is read, and nothing is ever written. Wrapped around the ordinary
   * lease routes so take and release behave normally.
   */
  function withHungHeartbeat(routes) {
    const held = [];
    return {
      lease: routes.lease,
      held,
      async handler(req, res, ctx) {
        if (/^\/v1\/leases\/[^/]+\/heartbeat$/.test(ctx.url.pathname) && req.method === 'POST') {
          routes.lease.heartbeats.push({ leaseId: 'never-answered' });
          held.push(res);
          req.resume();
          return true; // …and no answer, ever.
        }
        return routes.handler(req, res, ctx);
      },
    };
  }

  await check('a hung heartbeat FAILS on its own clock, so the NEXT beat still goes out', async () => {
    const routes = leaseRoutes();
    const hung = withHungHeartbeat(routes);
    const fake = await startFakeCrucible(hung.handler);
    const server = nameFake(fake.url);
    const lines = [];
    try {
      await lease.withCrucibleLease(
        {
          server, kind: 'model', id: 'qwen3.5-9b', act: 'clean',
          heartbeatMs: 25,
          // Milliseconds, never the shipped ten seconds: the behaviour under
          // test is what happens when the clock runs out.
          requestTimeoutMs: 40,
          onLog: (line) => lines.push(line),
        },
        async () => { await after(260); },
      );
      assert.ok(routes.lease.heartbeats.length >= 3,
        'the beat kept going out — before the clock, ONE hung POST silenced every later tick '
        + `for the rest of the book; saw ${routes.lease.heartbeats.length}`);
      assert.ok(lines.some((l) => /timed out after 40 ms/.test(l)),
        `the timeout is named, not silent: ${JSON.stringify(lines)}`);
      assert.strictEqual(lines.filter((l) => /It is ABANDONED rather than waited on/.test(l)).length, 1,
        'the RULE is stated once, not on every tick');
    } finally {
      for (const res of hung.held) res.destroy();
      await fake.close();
    }
  });

  await check('release RACES an in-flight heartbeat instead of hanging on it', async () => {
    const routes = leaseRoutes();
    const hung = withHungHeartbeat(routes);
    const fake = await startFakeCrucible(hung.handler);
    const server = nameFake(fake.url);
    const began = Date.now();
    try {
      await lease.withCrucibleLease(
        {
          server, kind: 'model', id: 'qwen3.5-9b', act: 'clean',
          heartbeatMs: 20,
          // LONGER THAN THE RUN, so a beat is genuinely in flight at release
          // and its own clock cannot be what rescues this.
          requestTimeoutMs: 30_000,
          onLog: () => {},
        },
        async () => { await after(60); },
      );
      const took = Date.now() - began;
      assert.ok(took < 5_000,
        `the release gave the card back under its own grace, not the hung beat's (${took} ms)`);
      assert.strictEqual(routes.lease.released.length, 1,
        'and the DELETE still went out — a release that gave up entirely would hold the card '
        + 'for the whole ttl');
    } finally {
      for (const res of hung.held) res.destroy();
      await fake.close();
    }
  });

  await check('the clock is shorter than the beat, so a hung POST is over before the next tick', () => {
    assert.ok(
      lease.CRUCIBLE_LEASE_REQUEST_TIMEOUT_MS
        < lease.crucibleHeartbeatIntervalMs(lease.CRUCIBLE_LEASE_TTL_SECONDS),
      'a clock longer than the cadence would let two hung beats overlap and skip a tick anyway',
    );
    assert.ok(lease.CRUCIBLE_LEASE_RELEASE_GRACE_MS < lease.CRUCIBLE_LEASE_REQUEST_TIMEOUT_MS,
      'release must not wait out a whole request clock on the quit path');
  });

  summary('crucible lease');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
