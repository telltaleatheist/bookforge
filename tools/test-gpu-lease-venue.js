#!/usr/bin/env node
/**
 * test-gpu-lease-venue.js — a render on another machine holds no card here.
 *
 * `acquireGpuForJob` takes THIS machine's GPU lease before a render. Until
 * 2026-09-15 it took it for every render, including ones running on the Mac:
 * `resolveTtsDeviceArg` answers from this box's hardware ("is CUDA installed
 * here?") and knows nothing about the venue, so on a machine with CUDA present a
 * Mac-bound book resolved to `CUDA`, held this card's lock for the whole render,
 * and called `unloadOllamaModels()` to free VRAM for a render that would never
 * touch this card. AI cleanup and epub-align queued behind it.
 *
 * Nothing errored and nothing logged it. The lock was held correctly, for a job
 * that did not want it — which is why this is a SOURCE assertion: there is no
 * failure to observe at runtime, only a card that is busy for no reason.
 *
 * THE TEST IS WHETHER THERE IS A VENUE AT ALL, since Owen's ruling of
 * 2026-09-19: *"Crucible is configured to be system agnostic. Doesn't matter if
 * it's on this system or on a rented DigitalOcean GPU, it should effectively be
 * treated the same locally or otherwise."* A loopback server used to be
 * excepted — it took the lock and evicted Ollama — and that exception is gone.
 * Crucible owns its card's memory wherever the card is; this process takes the
 * lock only for a render it spawns itself, which is a session with NO venue.
 *
 * Run: node tools/test-gpu-lease-venue.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BRIDGE = path.join(REPO, 'electron', 'parallel-tts-bridge.ts');
const source = fs.readFileSync(BRIDGE, 'utf8');

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

/** The body of `acquireGpuForJob`, so the assertions are about THAT function. */
function acquireGpuBody() {
  const start = source.indexOf('async function acquireGpuForJob');
  assert.ok(start > 0, 'acquireGpuForJob is gone from parallel-tts-bridge.ts');
  // To the next top-level declaration.
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(async )?function [a-zA-Z_]/);
  return rest.slice(0, end === -1 ? undefined : end);
}

const body = acquireGpuBody();

check('EVERY crucible venue skips the lease, wherever that server answers', () => {
  assert.ok(/session\.venue\?\.server/.test(body),
    'the gate must read the RESOLVED venue off the session.');
  assert.ok(/venueServer !== undefined\) \{/.test(body),
    'a venue — any venue — must be the whole gate: Crucible owns its card.');
  assert.ok(!/serversOnThisMachine\(|isLoopbackUrl\(/.test(body),
    'acquireGpuForJob asks again where the server is. Owen, 2026-09-19: a Crucible on '
    + 'this box is treated exactly like one on a rented GPU, so a render there takes no '
    + 'lock here and evicts nothing.');
});

check('the gate returns BEFORE the lock is taken and before Ollama is evicted', () => {
  const gate = body.search(/venueServer !== undefined/);
  const lock = body.search(/acquireGpu\(/);
  const evict = body.search(/unloadOllamaModels\(/);
  assert.ok(gate > -1 && lock > -1 && evict > -1, 'expected all three in this function');
  assert.ok(gate < lock,
    'the venue gate must come before acquireGpu — after it, the lock is already held');
  assert.ok(gate < evict,
    'and before unloadOllamaModels — evicting this card\'s models for a render on '
    + 'another machine is the second half of the defect, not a side effect of the first');
});

check('a session with NO venue keeps the old behaviour', () => {
  // "I do not know where this is going" must not be read as "it is going
  // elsewhere" — an assembly-only run has no venue and must not lose its lock.
  assert.ok(/venueServer !== undefined/.test(body),
    'the gate must require a KNOWN venue before skipping the lease.');
});

check('NO DOOR ANYWHERE ANSWERS "is this server on this machine"', () => {
  /*
   * The rule has one owner because it has no owner: the question is not asked.
   * A re-introduced helper anywhere in the scheduler or the registry is a
   * second kind of server coming back, which is the thing the ruling deleted.
   */
  for (const rel of [
    ['shared', 'queue', 'slot-sets.ts'],
    ['shared', 'queue', 'bench.ts'],
    ['electron', 'queue-engine.ts'],
    ['electron', 'queue-ipc.ts'],
    ['electron', 'crucible', 'servers.ts'],
    ['electron', 'crucible', 'discovery.ts'],
  ]) {
    const text = fs.readFileSync(path.join(REPO, ...rel), 'utf8');
    assert.ok(!/serversOnThisMachine|isLoopbackUrl|thisMachinesCardHeldBy|thisMachineSetId/
      .test(text.replace(/GONE WITH THE SAME RULING[\s\S]*?\*\//, '')),
      `${rel.join('/')} asks where a Crucible server is again — Owen, 2026-09-19: every `
      + 'registered server is scheduled identically, local or otherwise.');
  }
});

console.log(`\ngpu lease venue: ${ran} check(s), exit ${process.exitCode || 0}`);
