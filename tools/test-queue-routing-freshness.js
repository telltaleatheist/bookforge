#!/usr/bin/env node
/**
 * EVERY CHANGE TO THE SERVER LIST TAKES EFFECT NOW — the scheduler's view of
 * which machines exist, and who is allowed to make it stale.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-routing-freshness.js
 *
 * ── What went wrong, twice ──────────────────────────────────────────────────
 *
 * `queue-ipc.ts` memoised the routing view for ten seconds, because the pump
 * asks the routing question on every pass over every queued row and the record
 * is a synchronous file read.
 *
 * The FIRST defect was the ENABLE switch, which is the one way to say "not that
 * machine, right now" (Owen, 2026-09-14) — the memo made the bench and the
 * scheduler disagree about it: `slotSets` greyed the card the instant it was
 * flipped, while admission went on placing work from the list it was holding.
 * Owen, 2026-09-19: a render refused by a busy Crucible, Retry step pressed,
 * *"i enabled the mac gpu slot, disabled wsl slot. it went to wsl anyway."*
 * Every press that pumps — Retry, Start, Send to queue — lands inside that
 * window. That was fixed by making `setServerEnabled` announce.
 *
 * The SECOND was every OTHER write. `addServer`, `removeServer`,
 * `setRoutingOrder` and `forgetRoutingName` did not announce, so for up to ten
 * seconds after a removal admission could still place an `any` book on a machine
 * the registry no longer has — the submit then fails against a missing entry and
 * the row FAILS, where a hold belongs — and a machine just added was invisible
 * to both the bench and admission
 * (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A3 and C1).
 *
 * Owen's ruling, 2026-09-19: *"it can be a BookForge and Foundry-side change
 * instantly. Nothing gets sent to the other server from the queue."* So the memo
 * is GONE — two small synchronous file reads per pump is the price of never
 * having to remember to invalidate one — and every registry and rank write
 * announces anyway, because the bench and everything else subscribed have to
 * REPUBLISH even when nothing was stale.
 *
 * ── Why it is tested through the whole stack ────────────────────────────────
 *
 * The defect was never in one function: it was that NOTHING CONNECTED THE
 * RECORD TO THE MEMO. A unit test of a private helper cannot see an absent
 * wire. So this brings the real engine up against real records in a temporary
 * `userData`, writes through the same doors the Settings panel and the bench
 * call, and reads the answer off `QueueSnapshot.servers` and `slotSets` — which
 * is `crucibleAdmission`'s own view of the world, the thing that was wrong.
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

/** …and what the BENCH draws from the same snapshot: one lane set per server. */
function asTheBenchDrawsIt(engine) {
  return engine.snapshot().slotSets.filter((set) => set.gpu > 0).map((set) => set.id).join(' ');
}

async function main() {
  const engine = require(path.join(DIST, 'queue-engine.js'));
  const { registerQueueIpc, startQueueEngine } = require(path.join(DIST, 'queue-ipc.js'));
  const { setRoutingOrder, setServerEnabled } = require(path.join(DIST, 'crucible', 'routing.js'));
  const { addServer, removeServer } = require(path.join(DIST, 'crucible', 'servers.js'));

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

  // ── The registry itself (A3) ────────────────────────────────────────────

  check('REMOVING a server takes it off the scheduler\'s list at once', () => {
    /*
     * The dangerous direction. Inside the old ten-second window, admission could
     * still place an `any` book on `pc` — and the submit then fails against a
     * registry entry that is not there, which FAILS the row rather than holding
     * it.
     */
    removeServer('pc');
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'mac:on',
      'a machine the operator has taken away must not be a candidate for one more pass');
    assert.ok(!asTheBenchDrawsIt(engine).includes('pc'),
      'and the bench republished without its card');
  });

  check('ADDING one puts it on the list at once, for the bench and for admission', () => {
    addServer({ name: 'studio', url: 'http://studio.invalid:7100', token: 't' });
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'mac:on studio:on',
      'a machine just registered is usable now, not in ten seconds');
    assert.ok(asTheBenchDrawsIt(engine).includes('studio'),
      'and it has a lane to be drawn on');
  });

  check('RE-RANKING is immediate too — rank is what `any` means', () => {
    // "`any` takes the first enabled server in rank order" (wait-for.ts), so a
    // stale order is a book sent to the machine the operator just demoted.
    setRoutingOrder(['studio', 'mac']);
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'studio:on mac:on',
      'the snapshot lists servers in RANK order, so this is the order admission walks');
  });

  // ── And the file is not a door (the memo is gone, not merely announced) ──

  check('A CHANGE MADE TO THE FILE is visible on the next read — there is no memo', () => {
    /*
     * The other half of the ruling. Until 2026-09-19 an unannounced edit was
     * deliberately invisible for ten seconds, and the fix for the enable switch
     * was a subscription rather than "stop caching". That trade is off: the memo
     * held the list of MACHINES THAT EXIST, and a stale copy of that is not a
     * slow answer but a wrong one. Two synchronous reads of small files under
     * `<userData>` is the price of never having to remember to invalidate one.
     *
     * If this check ever fails, a memo has come back and every write door has to
     * be audited again.
     */
    fs.writeFileSync(ROUTING_FILE, JSON.stringify({
      order: ['studio', 'mac'], disabled: ['studio', 'mac'], newJobsWaitFor: 'any',
    }));
    assert.strictEqual(asTheSchedulerSeesIt(engine), 'studio:off mac:off');
  });

  console.log(`\nqueue routing freshness: ${ran - failures.length}/${ran} passed`);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* temp dir */ }
  // The engine holds interval timers (the reach sweep, the thermal sampler) that
  // would keep node alive with nothing left to do.
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
