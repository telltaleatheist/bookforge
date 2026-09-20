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

  summary('crucible transient refusals');
})();
