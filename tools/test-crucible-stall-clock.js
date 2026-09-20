#!/usr/bin/env node
/**
 * A WEDGED SERVER MUST NOT HOLD A BOOK FOREVER — bug hunt C2, 2026-09-20,
 * Owen's ruling 3 (ten minutes of silence is a wedged server, not a warm-up).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-stall-clock.js
 *
 * No `CrucibleClient` in this app is built with a `timeoutMs`, and the render
 * watchdog was deliberately removed on the grounds that *"the server's own
 * progress frames are the heartbeat"*. They are — and nothing measured the
 * interval between them. The SSE `for await` blocks on a TCP connection that is
 * alive and has stopped producing bytes: the row sits at processing, the GPU
 * slot stays charged, `gpuHoldOf` keeps the book atomic on that card, the
 * ledger row stays, and Stop is the only exit.
 *
 *  1. The clock RESETS on every frame. A long stream of frames inside the
 *     window never fires — a real render is hours of them.
 *  2. Silence past the window FIRES, and the job is CANCELLED rather than
 *     abandoned: hanging up leaves it running and holding the lane.
 *  3. It throws `CrucibleStreamWentQuiet`, its OWN class, so each door can
 *     re-mint its own refusal vocabulary rather than this module owning theirs.
 *  4. THE GRACE IS NOT A SECOND CHANCE. A stream that settles after the DELETE
 *     still went quiet; reporting "cancelled at this side's request" would hide
 *     the reason from the person reading the row.
 *  5. A DELETE THAT ITSELF HANGS does not become the new forever. The server is
 *     already not answering; `onStall` is bounded by the same grace.
 *  6. END TO END through `runCrucibleJob` against a fake that admits the job,
 *     sends two frames and then says NOTHING: the DELETE reaches the server and
 *     the refusal is `crucible_went_quiet`, TRANSIENT (Contract 1), so the row
 *     parks rather than reddening.
 *  7. TEN MINUTES is the shipped number.
 *
 * No GPU, no model, no network beyond 127.0.0.1 — and the clock is driven at
 * milliseconds, never at its real setting.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const STALL = path.join(REPO, 'dist', 'electron', 'crucible', 'stream-stall.js');
if (!fs.existsSync(STALL)) {
  console.log(skipLine('dist/electron/crucible/stream-stall.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

installElectronStub('bf-crucible-stall-');
const stall = require(STALL);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake whose `tts`-shaped job stream sends `frames` frames and then GOES
 * QUIET — the socket stays open and nothing more is written, which is exactly
 * what a live uvicorn in front of a wedged worker looks like.
 *
 * It answers the DELETE (recorded in `state.cancelled`) and, when
 * `endOnCancel`, then sends the `cancelled` frame a healthy server would.
 */
function startSilentFake({ frames = 2, endOnCancel = false } = {}) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      return send(res, 200, { job_id: id }) || true;
    }
    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (events && req.method === 'GET') {
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      for (let n = 1; n < frames; n += 1) {
        sse.frame('progress', {
          fraction: n / 100, message: `chunk ${n}`, stage: 'rendering', processed: n, total: 100,
        });
      }
      // …AND THEN NOTHING. No end(), no terminal frame: the socket is held open.
      if (endOnCancel) {
        const watch = setInterval(() => {
          if (state.cancelled.length === 0) return;
          clearInterval(watch);
          sse.frame('cancelled', { status: 'cancelled' });
          sse.end();
        }, 10);
        req.on('close', () => clearInterval(watch));
      }
      return true;
    }
    return false;
  });
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // The pure clock
  // ───────────────────────────────────────────────────────────────────────────
  await check('a stream that keeps talking is never cut, however long it runs', async () => {
    let stalls = 0;
    const answer = await stall.withStreamStallClock({
      server: 'the-mac', jobId: 'job-1', stallMs: 60, graceMs: 20,
      onStall: () => { stalls += 1; },
      consume: async (beat) => {
        // 10 × 20 ms = 200 ms of stream against a 60 ms window: it only ever
        // survives because each frame RESETS the clock.
        for (let n = 0; n < 10; n += 1) { await after(20); beat(); }
        return 'the book';
      },
    });
    assert.strictEqual(answer, 'the book', 'the consumer\'s own value comes back untouched');
    assert.strictEqual(stalls, 0, 'nothing was cancelled');
  });

  await check('silence past the window cancels the job and throws CrucibleStreamWentQuiet', async () => {
    let cancels = 0;
    let stopped = false;
    await assert.rejects(
      stall.withStreamStallClock({
        server: 'the-mac', jobId: 'job-7', stallMs: 40, graceMs: 30,
        onStall: () => { cancels += 1; },
        consume: async (beat) => {
          beat();
          await after(5_000); // A socket that is open and saying nothing.
          stopped = true;
        },
      }),
      (err) => {
        assert.strictEqual(err.name, 'CrucibleStreamWentQuiet');
        assert.strictEqual(err.code, 'crucible_went_quiet');
        assert.strictEqual(err.server, 'the-mac');
        assert.strictEqual(err.jobId, 'job-7');
        assert.strictEqual(err.stallMs, 40);
        assert.ok(/sent no event/.test(err.message), err.message);
        assert.ok(/cancelled rather than waited on/.test(err.message), err.message);
        return true;
      },
    );
    assert.strictEqual(cancels, 1, 'a cancel, not a hang-up — the job holds the lane otherwise');
    assert.strictEqual(stopped, false, 'it did not wait for the stream that had stopped talking');
  });

  await check('the clock is armed BEFORE the first frame — a server that says nothing at all', async () => {
    await assert.rejects(
      stall.withStreamStallClock({
        server: 'the-mac', jobId: null, stallMs: 30, graceMs: 20,
        onStall: () => undefined,
        consume: () => after(5_000),
      }),
      (err) => err.name === 'CrucibleStreamWentQuiet' && err.jobId === null,
    );
  });

  await check('the grace is not a second chance: a stream that ends after the DELETE still went quiet', async () => {
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    await assert.rejects(
      stall.withStreamStallClock({
        server: 'the-mac', jobId: 'job-8', stallMs: 30, graceMs: 200,
        // The DELETE lands and the stream duly delivers its `cancelled` frame.
        onStall: () => { setTimeout(() => finish('cancelled'), 5); },
        consume: () => ended,
      }),
      (err) => err.name === 'CrucibleStreamWentQuiet',
      'reporting this as an ordinary cancellation would hide why the row stopped',
    );
  });

  await check('a DELETE that hangs does not become the new forever', async () => {
    const began = Date.now();
    await assert.rejects(
      stall.withStreamStallClock({
        server: 'the-mac', jobId: 'job-9', stallMs: 20, graceMs: 60,
        onStall: () => after(10_000), // The same wedged server, asked to cancel.
        consume: () => after(10_000),
      }),
      (err) => err.name === 'CrucibleStreamWentQuiet',
    );
    assert.ok(Date.now() - began < 2_000,
      `it gave up inside its own grace, not the hung DELETE's lifetime (${Date.now() - began} ms)`);
  });

  await check('ten minutes is the shipped window (Owen\'s ruling 3)', () => {
    assert.strictEqual(stall.CRUCIBLE_STREAM_STALL_MS, 10 * 60 * 1000);
    assert.strictEqual(stall.describeStallInterval(10 * 60 * 1000), '10 minutes');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // End to end through the door
  // ───────────────────────────────────────────────────────────────────────────
  {
    const fake = await startSilentFake({ frames: 3, endOnCancel: true });
    const server = registerFake(fake.url);
    let thrown = null;
    try {
      await job.runCrucibleJob({
        server,
        type: 'align',
        model: 'qwen3-aligner',
        params: {},
        inputs: {},
        localId: 'step_quiet_1',
        // A FEW MILLISECONDS, not ten minutes: the behaviour under test is what
        // happens when the window runs out, and the window itself is check 7.
        stallClock: { stallMs: 120, graceMs: 400 },
      });
    } catch (err) {
      thrown = err;
    } finally {
      await fake.close();
    }
    await check('a silent server\'s job is DELETEd and refused crucible_went_quiet, transient', () => {
      assert.ok(thrown !== null, 'a stream that stops must not resolve as a finished job');
      assert.strictEqual(thrown.name, 'CrucibleJobRefused');
      assert.strictEqual(thrown.code, 'crucible_went_quiet');
      assert.strictEqual(fake.state.cancelled.length, 1,
        'the DELETE reached the server — abandoning the stream leaves it holding the lane');
      assert.strictEqual(thrown.transient, true,
        'a wedged server is a wait, not a misconfiguration somebody can repair');
      assert.ok(/silent for/.test(thrown.transientLine), thrown.transientLine);
      assert.ok(/the align job/.test(thrown.message), thrown.message);
    });
  }

  summary('crucible stall clock');
})();
