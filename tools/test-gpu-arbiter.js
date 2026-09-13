/**
 * Tests for the GPU arbiter's ANSWER — crucible/docs/ARCHITECTURE.md R3:
 * "you either hold the card or you do not; a caller is never handed an ambiguous
 * answer."
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-gpu-arbiter.js
 *
 * Every check here fails against the pre-2026-09-13 arbiter, and each fails for a
 * DIFFERENT reason, which is the point:
 *
 *  - the verdict checks fail because `acquireGpu` resolved with `undefined`, so a
 *    caller could not tell a lease from a lapsed wait and three of them recorded
 *    `holdsGpu = true` either way;
 *  - the yield checks fail because a waiter's `onYield` was only ever attached when
 *    it BECAME the holder, so a caller that timed out and started anyway (the text
 *    server, up on ~20 GB) could never be asked to step off again.
 *
 * Pure: no processes are spawned, nothing touches a GPU. Timeouts are tens of
 * milliseconds — the real call sites pass ten minutes.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'gpu-arbiter.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  acquireGpu,
  releaseGpu,
  gpuHolder,
  isGpuBusy,
  unleasedGpuOccupants,
  warnProceedingWithoutGpu,
} = require(MODULE);

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.log(`  FAIL ${label}`); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every block starts on an empty card, or the block after it is measuring noise. */
function assertClean(where) {
  check(gpuHolder() === null && unleasedGpuOccupants().length === 0,
    `[${where}] starts with nobody on the card`);
}

async function main() {
  // ── the verdict ────────────────────────────────────────────────────────────
  console.log('the verdict');
  {
    assertClean('verdict');
    const lease = await acquireGpu('a');
    check(lease.held === true, 'a free card answers held:true');
    check(lease.owner === 'a', 'the verdict names the owner it was given');
    check(gpuHolder() === 'a' && isGpuBusy(), 'and that owner is the holder');
    releaseGpu('a');
    check(gpuHolder() === null, 'release empties the card');
  }

  console.log('the wait that runs out');
  {
    assertClean('timeout');
    const held = await acquireGpu('long-render');
    check(held.held === true, 'the first owner holds');

    const t0 = Date.now();
    const lapsed = await acquireGpu('latecomer', { timeoutMs: 40 });
    const elapsed = Date.now() - t0;

    check(lapsed.held === false, 'a wait that runs out answers held:FALSE, not a bare resolve');
    check(lapsed.reason === 'timeout', 'and says why');
    check(lapsed.heldBy === 'long-render', 'and names who had the card at the deadline');
    check(typeof lapsed.waitedMs === 'number' && lapsed.waitedMs >= 30,
      `and how long it waited (${lapsed.waitedMs}ms over a ${elapsed}ms call)`);
    check(gpuHolder() === 'long-render',
      'the timed-out owner did NOT become the holder — that is the whole lie being removed');

    // The bookkeeping the call sites now do.
    check(unleasedGpuOccupants().includes('latecomer'),
      'it is recorded as an UNLEASED occupant instead: on the card, without the lease');

    releaseGpu('latecomer');
    check(!unleasedGpuOccupants().includes('latecomer'),
      'and the same releaseGpu(owner) door clears that registration');
    releaseGpu('long-render');
    check(gpuHolder() === null, 'the real holder still releases normally');
  }

  // ── the dropped yield handler (consequence 2) ──────────────────────────────
  console.log('a timed-out occupant stays preemptable');
  {
    assertClean('yield-after-timeout');
    let stepOffs = 0;

    await acquireGpu('render');                       // someone has the card
    const lapsed = await acquireGpu('text-server', {  // ...and the text server gives up waiting
      onYield: () => { stepOffs += 1; },
      timeoutMs: 30,
    });
    check(lapsed.held === false, 'the text server is answered held:false');
    check(stepOffs === 0, 'nothing has asked it to step off yet');

    releaseGpu('render');
    check(gpuHolder() === null, 'the render finished and the LEASE is free');
    check(unleasedGpuOccupants().includes('text-server'),
      'but the text server is still on the card holding its ~20 GB');

    // THE REGRESSION. Old arbiter: this handler was thrown away with the waiter, so
    // the next render took the free lease and loaded on top of 20 GB nobody could
    // reach. It is the R3 sentence "nothing can ever ask it to step off again".
    const next = await acquireGpu('render-2');
    check(next.held === true, 'the next render takes the free lease');
    check(stepOffs === 1, 'and the timed-out text server IS asked to step off (exactly once)');

    // A nudge, not a wait: the acquirer holds the lease immediately and its own VRAM
    // preflight is what rides out the shutdown. Asserted so the doc stays true.
    check(gpuHolder() === 'render-2', 'the acquirer did not block on the step-off');

    releaseGpu('text-server');
    releaseGpu('render-2');
    const after = stepOffs;
    await acquireGpu('render-3');
    check(stepOffs === after, 'once released, a former occupant is never nudged again');
    releaseGpu('render-3');
    check(gpuHolder() === null, 'card empty');
  }

  console.log('nobody nudges themselves');
  {
    assertClean('self-nudge');
    let stepOffs = 0;
    const lease = await acquireGpu('solo', { onYield: () => { stepOffs += 1; } });
    check(lease.held === true, 'solo holds');
    releaseGpu('solo');
    // Re-acquire by the same owner must not fire its own handler.
    await acquireGpu('solo', { onYield: () => { stepOffs += 1; } });
    check(stepOffs === 0, 'an owner re-acquiring never asks itself to step off');
    releaseGpu('solo');
  }

  // ── handoff ────────────────────────────────────────────────────────────────
  console.log('the handoff');
  {
    assertClean('handoff');
    let nudges = 0;
    await acquireGpu('holder', { onYield: () => { nudges += 1; } });

    // No timeout: this one can only ever be answered held:true.
    const pending = acquireGpu('waiter');
    await sleep(5);
    check(nudges === 1, 'a waiter arriving nudges the holder once');
    check(gpuHolder() === 'holder', 'and does not take the card by asking');

    releaseGpu('holder');
    const lease = await pending;
    check(lease.held === true && lease.owner === 'waiter',
      'the handoff answers the waiter held:true, with its own name');
    check(gpuHolder() === 'waiter', 'and it is now the holder');
    check(unleasedGpuOccupants().length === 0, 'a promoted waiter is not also an occupant');
    releaseGpu('waiter');
  }

  console.log('an abandoned waiter is skipped on handoff');
  {
    assertClean('abandoned-handoff');
    await acquireGpu('busy');
    const lapsed = await acquireGpu('gave-up', { timeoutMs: 25 });
    check(lapsed.held === false, 'the first waiter gave up');

    const pending = acquireGpu('still-waiting');
    await sleep(5);
    releaseGpu('busy');
    const lease = await pending;
    check(lease.held === true && gpuHolder() === 'still-waiting',
      'the card goes to the waiter that is still there, not to the one that left');
    releaseGpu('still-waiting');
    releaseGpu('gave-up');
  }

  console.log('release is idempotent and cannot be stolen');
  {
    assertClean('release');
    await acquireGpu('owner-a');
    releaseGpu('someone-else');
    check(gpuHolder() === 'owner-a', 'a non-holder cannot release the holder\'s lease');
    releaseGpu('owner-a');
    releaseGpu('owner-a');
    check(gpuHolder() === null, 'a double release is harmless');
  }

  // ── the deliberate "proceed anyway" ────────────────────────────────────────
  console.log('warnProceedingWithoutGpu');
  {
    const lines = [];
    const realWarn = console.warn;
    console.warn = (line) => lines.push(String(line));
    try {
      warnProceedingWithoutGpu({ held: true, owner: 'x' }, 'a job');
      check(lines.length === 0, 'a held lease says nothing — the warning is not noise');
      warnProceedingWithoutGpu(
        { held: false, owner: 'x', reason: 'timeout', waitedMs: 600_000, heldBy: 'tts:A' },
        'the text server');
      check(lines.length === 1, 'an unleased start is said exactly once');
      check(lines[0].includes('the text server') && lines[0].includes('tts:A')
        && lines[0].includes('600s'),
        'and names what started, who had the card, and how long it waited');
    } finally {
      console.warn = realWarn;
    }
  }

  console.log(failures === 0 ? '\nAll GPU-arbiter checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
