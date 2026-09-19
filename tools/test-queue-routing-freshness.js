#!/usr/bin/env node
/**
 * THE ENABLE SWITCH TAKES EFFECT NOW — the scheduler's routing memo and the one
 * thing that must drop it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-routing-freshness.js
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * `queue-ipc.ts` memoises the routing view for ten seconds, because the pump
 * asks the routing question on every pass over every queued row and the record
 * is a synchronous file read. That is a fair trade for a RANK ORDER. It is not a
 * fair trade for the ENABLE LIST, because that switch is the one way to say "not
 * that machine, right now" (Owen, 2026-09-14) — and the memo made the bench and
 * the scheduler disagree about it: `slotSets` greyed the card the instant it was
 * flipped, while admission went on placing work from the list it was holding.
 *
 * Owen, 2026-09-19: a render refused by a busy Crucible, Retry step pressed,
 * *"i enabled the mac gpu slot, disabled wsl slot. it went to wsl anyway."* Every
 * press that pumps — Retry, Start, Send to queue — lands inside that window.
 *
 * ── Why it is tested through the whole stack ────────────────────────────────
 *
 * The memo, the subscription and the invalidation are all private to
 * `queue-ipc.ts`, and the defect was not in any one of them: it was that NOTHING
 * CONNECTED THE RECORD TO THE MEMO. A unit test of a private helper cannot see
 * an absent wire. So this brings the real engine up against a real record in a
 * temporary `userData`, flips the switch through the same door the Settings
 * panel and the bench switch both call, and reads the answer off
 * `QueueSnapshot.servers` — which is `crucibleAdmission`'s own view of the world,
 * the thing that was wrong.
 *
 * The last check keeps the memo honest in the other direction: deleting the
 * cache would also pass the first two, and would put two file reads per row per
 * pump back on the main thread with nothing to notice.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

// BEFORE the stub loads: `app.getPath('userData')` is resolved at require time,
// and every compiled module below reads its record from there.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-routing-fresh-'));
process.env.BOOKFORGE_USER_DATA = USER_DATA;
require(path.join(REPO, 'cli', 'electron-stub.js'));

const ROUTING_FILE = path.join(USER_DATA, 'crucible-routing.json');

fs.writeFileSync(path.join(USER_DATA, 'crucible-servers.json'), JSON.stringify({
  servers: [
    { name: 'pc', url: 'http://pc.invalid:7100', token: 't', added: new Date().toISOString() },
    { name: 'mac', url: 'http://mac.invalid:7100', token: 't', added: new Date().toISOString() },
  ],
}));
fs.writeFileSync(ROUTING_FILE, JSON.stringify({
  order: ['pc', 'mac'], disabled: ['mac'], newJobsWaitFor: 'any',
}));

let ran = 0;
const failures = [];
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures.push(name); console.log(`FAIL ${name}\n     ${err.message}`); }
}

/** How the SCHEDULER sees the machines — `crucibleAdmission`'s own source. */
function asTheSchedulerSeesIt(engine) {
  return engine.snapshot().servers
    .map((s) => `${s.name}:${s.enabled ? 'on' : 'off'}`).join(' ');
}

async function main() {
  const engine = require(path.join(DIST, 'queue-engine.js'));
  const { registerQueueIpc, startQueueEngine } = require(path.join(DIST, 'queue-ipc.js'));
  const { setServerEnabled } = require(path.join(DIST, 'crucible', 'routing.js'));

  registerQueueIpc();
  await startQueueEngine();

  check('the record is what the scheduler starts from', () => {
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'pc:on mac:off');
  });

  check('SWITCHING A MACHINE OFF reaches the scheduler on the very next read', () => {
    setServerEnabled('pc', false);
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'pc:off mac:off',
      'the memo outlived the switch — this is the ten-second window a book slipped through');
  });

  check('and switching one ON is just as immediate', () => {
    setServerEnabled('mac', true);
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'pc:off mac:on');
  });

  check('a change made to the FILE without announcing is still memoised — this is a cache', () => {
    /*
     * The other half of the contract, and the reason the fix is a subscription
     * rather than "stop caching". An edit nobody announced is exactly what the
     * memo is for; it ages out on its own (ten seconds) and admission re-asks on
     * its own tick. If this check ever fails, the memo has been deleted and the
     * pump is back to two synchronous file reads per row per pass.
     */
    fs.writeFileSync(ROUTING_FILE, JSON.stringify({
      order: ['pc', 'mac'], disabled: ['pc', 'mac'], newJobsWaitFor: 'any',
    }));
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'pc:off mac:on',
      'an unannounced edit should NOT be visible yet');
  });

  check('…and announcing it makes it visible', () => {
    const { announceCrucibleRecordChanged } = require(path.join(DIST, 'crucible', 'routes.js'));
    announceCrucibleRecordChanged();
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'pc:off mac:off');
  });

  console.log(`\nqueue routing freshness: ${ran - failures.length}/${ran} passed`);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* temp dir */ }
  // The engine holds interval timers (the reach sweep, the thermal sampler) that
  // would keep node alive with nothing left to do.
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
