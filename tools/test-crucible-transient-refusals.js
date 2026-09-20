#!/usr/bin/env node
/**
 * A SERVER THAT IS ASLEEP IS A WAIT, NOT A FAILURE — Contract 1 of the
 * 2026-09-20 bug hunt (§C1, §E).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-transient-refusals.js
 *
 * `queue-steps/runtime.ts busyLineOf` parks a step only when the refusal
 * carries `busyLine`/`leasedLine`. Every Crucible door minted
 * `crucible_unreachable` with NEITHER — so align's opening `GET /v1/info` on a
 * closed socket turned a Crucible that was merely asleep into a red row, the
 * chain stopped, and assembly with it. The identical wait on a BUSY card
 * parked and came back on its own. Owen's Sep 19 ruling — *"fail only on a
 * misconfiguration somebody can repair"* — was implemented in exactly one
 * module and no other door.
 *
 * The fix is a second pair beside `busyLine`: `transient: true` and a
 * `transientLine` naming the server and the cause. This pins the FLAG half (the
 * doors); `runtime.ts transientLineOf` and the park are the reader half.
 *
 *  1. `crucible_unreachable` carries the pair, through BOTH refusal readers —
 *     `job.ts describeCrucibleJobRefusal` and `render.ts
 *     describeCrucibleRefusal`.
 *  2. So does a 5xx. "The server broke" is not a run that needs repairing; it
 *     is the same wait with a different cause.
 *  2b. So does a socket that died MID-ANSWER (PK7, 2026-09-20). The SDK maps a
 *     connection never made; undici's bare `TypeError: terminated` for one
 *     destroyed under a live response came back unchanged and reddened the row.
 *     `crucible/transport-failure.ts` owns the question for both doors — and
 *     answers NO for a `TypeError` that is only a programming mistake.
 *  3. The refusals that are NOT waits do not carry it: a 4xx, a bad token, an
 *     API-version disagreement, a protocol violation, a non-crucible. Those are
 *     misconfigurations somebody must repair, and parking on one is a row that
 *     waits forever.
 *  4. A HELD CARD STILL PARKS ON `busyLine`, not on this. Two names for one
 *     wait would be the `busyLine`/`leasedLine` split again.
 *  5. ONE COMPOSER. Both doors' sentences come out of `crucibleTransientLine`,
 *     so a row's wait reads the same whichever door hit the socket.
 *  6. AND IT REACHES A BRIDGE THAT ANSWERS RATHER THAN THROWS:
 *     `coverage-align-job.ts` forwards the pair the way it forwards `busyLine`,
 *     driven end to end against a server that is not listening.
 *
 * No GPU, no model, no network beyond 127.0.0.1 — and for check 6, a port with
 * nothing on it at all.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, crucibleHost,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const JOB = path.join(REPO, 'dist', 'electron', 'crucible', 'job.js');
if (!fs.existsSync(JOB)) {
  console.log(skipLine('dist/electron/crucible/job.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const { work } = installElectronStub('bf-crucible-transient-');
const job = require(JOB);
const render = require(path.join(REPO, 'dist', 'electron', 'crucible', 'render.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const coverage = require(path.join(REPO, 'dist', 'electron', 'coverage-align-job.js'));
const sdk = require('@crucible/client');
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();
const transport = require(path.join(REPO, 'dist', 'electron', 'crucible', 'transport-failure.js'));

/** Both doors, asked the same question about the same SDK error. */
const asJob = (err) => job.describeCrucibleJobRefusal(err, 'the-mac', 'the align job');
const asRender = (err) => render.describeCrucibleRefusal(err, 'the-mac');

(async () => {
  await check('an unreachable server is TRANSIENT in both doors, with the cause in the line', () => {
    const unreachable = new sdk.CrucibleUnreachable(
      'http://crucible.invalid:7444', 'read ECONNRESET', new Error('read ECONNRESET'));
    for (const [door, refusal] of [['job', asJob(unreachable)], ['render', asRender(unreachable)]]) {
      assert.strictEqual(refusal.code, 'crucible_unreachable', door);
      assert.strictEqual(refusal.transient, true, `${door}: a sleeping server is a wait`);
      assert.ok(/^crucible "the-mac" did not answer \(.*read ECONNRESET\)/.test(refusal.transientLine),
        `${door}: the line names the server and the SERVER'S OWN cause — ${refusal.transientLine}`);
      assert.ok(/asking again shortly/.test(refusal.transientLine),
        `${door}: it says what happens next, not "start the server and queue it again"`);
      assert.strictEqual(refusal.busyLine, undefined,
        `${door}: nothing is holding the card; the other pair stays absent`);
    }
  });

  await check('a 5xx is transient too — a server that broke is not a run that needs repairing', () => {
    const broke = new sdk.CrucibleServerError(503, 'engine_crashed', 'the worker pool is gone', null);
    for (const [door, refusal] of [['job', asJob(broke)], ['render', asRender(broke)]]) {
      assert.strictEqual(refusal.transient, true, door);
      assert.ok(/HTTP 503/.test(refusal.transientLine), `${door}: ${refusal.transientLine}`);
      assert.ok(/the worker pool is gone/.test(refusal.transientLine),
        `${door}: the server's own words, not a category invented here`);
    }
  });

  /*
   * PK7 — THE SOCKET THAT DIED MID-ANSWER.
   *
   * PK2 measured it and left it owed: undici answers a socket destroyed once
   * the response had started with a bare `TypeError: terminated`, which is not
   * one of the SDK's types, so both describers returned it UNCHANGED and the
   * row went red for a server that was merely rebooting. One owner now —
   * `crucible/transport-failure.ts` — and both doors mint the same
   * `crucible_unreachable` refusal PK2 already marks transient.
   */
  await check('a socket destroyed MID-ANSWER is transient in both doors', () => {
    const terminated = new TypeError('terminated');
    for (const [door, refusal] of [['job', asJob(terminated)], ['render', asRender(terminated)]]) {
      assert.strictEqual(refusal.code, 'crucible_unreachable',
        `${door}: a dropped stream is the same wait a closed socket is`);
      assert.strictEqual(refusal.transient, true,
        `${door}: a Crucible restarting its engine must PARK the row, not redden it`);
      assert.ok(/^crucible "the-mac" did not answer \(terminated\)/.test(refusal.transientLine),
        `${door}: the line names the server and undici's own word — ${refusal.transientLine}`);
      assert.strictEqual(refusal.busyLine, undefined, `${door}: nothing is holding the card`);
    }
  });

  await check('a `fetch failed` carrying ECONNRESET is transient, with the errno in the line', () => {
    const reset = new TypeError('fetch failed');
    reset.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    for (const [door, refusal] of [['job', asJob(reset)], ['render', asRender(reset)]]) {
      assert.strictEqual(refusal.code, 'crucible_unreachable', door);
      assert.strictEqual(refusal.transient, true, door);
      assert.ok(/ECONNRESET/.test(refusal.transientLine),
        `${door}: the errno is the most specific TRUE thing and belongs in the sentence — `
        + refusal.transientLine);
      assert.ok(/asking again shortly/.test(refusal.transientLine), door);
    }
  });

  await check('a programming mistake is NOT transient — a TypeError alone proves nothing', () => {
    const bug = new TypeError('client.events is not a function');
    for (const [door, refusal] of [['job', asJob(bug)], ['render', asRender(bug)]]) {
      assert.strictEqual(refusal, bug,
        `${door}: an unexpected exception comes back UNCHANGED, with its stack`);
      assert.strictEqual(refusal.transient, undefined,
        `${door}: parking on a bug is a row that waits forever with nobody told`);
    }
  });

  await check('a misconfiguration is NOT transient — parking on one waits forever', () => {
    const notWaits = [
      ['a 4xx', new sdk.CrucibleRefused(400, 'invalid_params', 'chunks must be a list', null)],
      ['a bad token', new sdk.CrucibleAuthError(401, 'bad_token', 'that is not this server\'s token', null)],
      ['an api version', new sdk.CrucibleVersionError(400, 'api_version', 'v2 here', null, 2, 1)],
      ['a protocol violation', new sdk.CrucibleProtocolError('http://x', 'no job_id in the answer')],
      ['not a crucible', new sdk.CrucibleNotACrucible('http://x', '<html>hello</html>')],
    ];
    for (const [what, err] of notWaits) {
      for (const [door, refusal] of [['job', asJob(err)], ['render', asRender(err)]]) {
        assert.strictEqual(refusal.transient, undefined, `${door}: ${what} is somebody's to repair`);
        assert.strictEqual(refusal.transientLine, undefined, `${door}: ${what}`);
      }
    }
  });

  await check('a HELD card still parks on busyLine, and never claims to be transient', () => {
    const busy = new sdk.CrucibleBusy(409, 'server_busy', 'one at a time', null, {
      holder: 'foundry', jobId: 'j-held', jobType: 'tts', model: 'deathstalker',
      jobStatus: 'running', since: '2026-09-20T01:00:00Z', progress: 0.62,
      jobMessage: '640 of 1030 chunk(s) rendered',
    });
    for (const [door, refusal] of [['job', asJob(busy)], ['render', asRender(busy)]]) {
      assert.ok(typeof refusal.busyLine === 'string' && refusal.busyLine !== '', door);
      assert.strictEqual(refusal.transient, undefined,
        `${door}: one wait, one road — a second name for it is the leasedLine split again`);
    }
  });

  await check('ONE composer owns the sentence, so both doors read the same on a row', () => {
    assert.strictEqual(
      job.crucibleTransientLine('the-mac', 'read ECONNRESET'),
      'crucible "the-mac" did not answer (read ECONNRESET) — asking again shortly',
    );
    const src = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'render.ts'), 'utf-8');
    assert.ok(/crucibleTransientLine/.test(src) && /from '\.\/job'/.test(src),
      'render.ts composes through job.ts rather than writing its own sentence');
    // PK7: and ONE module decides what counts as the wire dying, for the same
    // reason — two readers of one question drift apart.
    for (const door of ['job', 'render']) {
      const text = fs.readFileSync(path.join(REPO, 'electron', 'crucible', `${door}.ts`), 'utf-8');
      assert.ok(/from '\.\/transport-failure'/.test(text),
        `${door}.ts asks transport-failure.ts rather than sniffing undici's messages itself`);
    }
  });

  /*
   * PK11 — UNDICI'S OWN CLOCKS, which were not in the errno set until a book
   * paid for it. 14:27 ET, 2026-09-20: one TCP connect to the render host took
   * longer than undici's 10 s, on a server that had been up eleven hours, and
   * the align of a 2,267-chunk book at 1,901 went red.
   */
  await check('PK11: undici\'s three timeouts are transport failures, not red rows', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      const timedOut = new TypeError('fetch failed');
      timedOut.cause = Object.assign(new Error('Connect Timeout Error (timeout: 10000ms)'), { code });
      assert.ok(transport.isTransportFailure(timedOut), `${code} is the wire, not the work`);
      for (const [door, refusal] of [['job', asJob(timedOut)], ['render', asRender(timedOut)]]) {
        assert.strictEqual(refusal.transient, true, `${door}: ${code}`);
        assert.ok(refusal.transientLine.includes(code),
          `${door}: the errno is the most specific true thing — ${refusal.transientLine}`);
      }
    }
  });

  /*
   * PK11 — ONE MEMBERSHIP TEST, and the describers agree with it.
   *
   * `crucibleUnavailableCause` is what the callers holding a RAW error ask:
   * `coverage-align-job.ts`'s generic catch and the reconnect ladder. The
   * describers keep their own per-class prose, so what must not drift is the
   * SET and the CAUSE — checked here rather than assumed, because a door that
   * parked on something the ladder would not retry (or the reverse) is exactly
   * the shape of this bug.
   */
  await check('PK11: crucibleUnavailableCause and the two describers agree, member by member', () => {
    const waits = [
      ['unreachable', new sdk.CrucibleUnreachable('http://x:7444', 'read ECONNRESET', new Error('x'))],
      ['a 5xx', new sdk.CrucibleServerError(503, 'engine_crashed', 'the worker pool is gone', null)],
      ['terminated', new TypeError('terminated')],
    ];
    for (const [what, err] of waits) {
      const cause = transport.crucibleUnavailableCause(err);
      assert.ok(typeof cause === 'string' && cause !== '', `${what} is a wait, in the server's words`);
      const line = job.crucibleTransientLine('the-mac', cause);
      assert.strictEqual(asJob(err).transientLine, line, `${what}: job.ts composes the same sentence`);
      assert.strictEqual(asRender(err).transientLine, line, `${what}: render.ts composes the same sentence`);
    }
    const notWaits = [
      new sdk.CrucibleRefused(400, 'invalid_params', 'chunks must be a list', null),
      new sdk.CrucibleAuthError(401, 'bad_token', 'not this server\'s token', null),
      new sdk.CrucibleProtocolError('http://x', 'no job_id in the answer'),
      new TypeError('client.events is not a function'),
    ];
    for (const err of notWaits) {
      assert.strictEqual(transport.crucibleUnavailableCause(err), null,
        `${err.constructor.name} is somebody's to repair — the ladder must not retry it either`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. The bridge that ANSWERS rather than throws
  // ───────────────────────────────────────────────────────────────────────────
  {
    /*
     * A REAL CLOSED SOCKET. The fake is started only to get a port nothing else
     * is on, then closed — which is what a Crucible that is asleep, rebooting
     * or behind a blipped tailnet looks like to `GET /v1/info`.
     */
    const parked = await startFakeCrucible(async () => false);
    const asleep = registerFake(parked.url);
    await parked.close();

    const dir = path.join(work, `session-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(dir, 'chapters', 'sentences'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({
      chapter_sentences: [['He had been walking for some time.']],
    }));
    fs.writeFileSync(path.join(dir, 'chapters', 'sentences', '0.flac'), 'fLaC-0');

    const result = await coverage.runCoverageAlign(
      'step-asleep', { processDir: dir, language: 'en', device: 'gpu' }, null,
      { venueHost: crucibleHost(asleep) },
    );

    await check('coverage-align forwards the transient pair the way it forwards busyLine', () => {
      assert.strictEqual(result.success, false);
      assert.ok(/crucible_unreachable/.test(result.error), result.error);
      assert.strictEqual(result.transient, true,
        'a sleeping server must PARK the align row, not send the book to Needs you');
      assert.ok(/^crucible "/.test(result.transientLine) && /asking again shortly/.test(result.transientLine),
        result.transientLine);
      assert.strictEqual(result.busyLine, undefined, 'nothing is holding the card');
    });
  }

  /*
   * PK11 — AND THE GENERIC CATCH, which is where the book was actually lost.
   *
   * The check above drives the door against a closed port and the refusal
   * arrives DESCRIBED (`assertCrucibleModelOffered` builds it). At 14:27 on
   * 2026-09-20 the SDK's own `CrucibleUnreachable` arrived from a plain SDK
   * call instead, fell past the `CrucibleJobRefused` arm, and the last line of
   * the catch returned a plain fail: red row, assembly stopped, for a network
   * blip. Driven here by making the client factory itself throw one, because
   * that is the shape — a raw SDK error from ANYWHERE inside the align door.
   */
  {
    const dir = path.join(work, `session-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(dir, 'chapters', 'sentences'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({
      chapter_sentences: [['He had been walking for some time.']],
    }));
    fs.writeFileSync(path.join(dir, 'chapters', 'sentences', '0.flac'), 'fLaC-0');

    const blipped = registerFake('http://127.0.0.1:1');
    const previous = servers.crucibleClientFor;
    servers.crucibleClientFor = function throwsRawUnreachable(name, clientName) {
      if (name !== blipped) return previous(name, clientName);
      throw new sdk.CrucibleUnreachable(
        'http://127.0.0.1:7444',
        'fetch failed (Connect Timeout Error (attempted address: 127.0.0.1:7444, timeout: 10000ms))',
        new Error('fetch failed'));
    };
    let result;
    try {
      result = await coverage.runCoverageAlign(
        'step-blip', { processDir: dir, language: 'en', device: 'gpu' }, null,
        { venueHost: crucibleHost(blipped) });
    } finally {
      servers.crucibleClientFor = previous;
    }

    await check('PK11: a RAW CrucibleUnreachable out of the align door is a wait, not a red row', () => {
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.transient, true,
        'THE FINDING: the generic catch returned a plain fail, so one 10 s connect timeout sent a '
        + 'book at 1,901 of 2,267 chunks to Needs you and stopped assembly');
      assert.ok(/^crucible "/.test(result.transientLine)
        && /asking again shortly/.test(result.transientLine), result.transientLine);
      assert.ok(/^The Crucible alignment did not finish/.test(result.error),
        'it is the GENERIC catch answering — the described-refusal arm is a different sentence: '
        + result.error);
      assert.ok(/Connect Timeout Error/.test(result.error),
        'and the sentence still carries the server\'s own words — ' + result.error);
      assert.strictEqual(result.busyLine, undefined, 'nothing is holding the card');
    });
  }

  await check('PK11: the generic catch asks the ONE membership test, it does not sniff classes', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'coverage-align-job.ts'), 'utf-8');
    assert.ok(/crucibleUnavailableCause/.test(src),
      'coverage-align-job.ts asks transport-failure.ts rather than growing its own list of '
      + 'SDK classes, which is how the two readers of one question drift apart');
    assert.ok(/crucibleTransientLine/.test(src),
      'and composes the sentence through the one composer');
  });

  summary('crucible transient refusals');
})();
