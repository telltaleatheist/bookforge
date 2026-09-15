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
 * THE TEST IS WHICH SERVER, NOT WHETHER CRUCIBLE, and that distinction is the
 * whole fix. `GenerationVenue` has one member, so "is it Crucible" is now always
 * yes; a Crucible server can BE this machine (the WSL engine on the PC), and
 * that render does use this card and must still take the lease. The question is
 * only whether the venue's server is one of `serversOnThisMachine()`.
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

check('the lease is gated on the venue being a server ON THIS MACHINE', () => {
  assert.ok(/serversOnThisMachine\(\)/.test(body),
    'acquireGpuForJob no longer asks which servers are on this machine, so a render '
    + 'bound for the Mac will take this card\'s lock again and evict Ollama for nothing.');
  assert.ok(/session\.venue\?\.server/.test(body),
    'the gate must read the RESOLVED venue off the session.');
});

check('the gate returns BEFORE the lock is taken and before Ollama is evicted', () => {
  const gate = body.search(/serversOnThisMachine\(\)/);
  const lock = body.search(/acquireGpu\(/);
  const evict = body.search(/unloadOllamaModels\(/);
  assert.ok(gate > -1 && lock > -1 && evict > -1, 'expected all three in this function');
  assert.ok(gate < lock,
    'the venue gate must come before acquireGpu — after it, the lock is already held');
  assert.ok(gate < evict,
    'and before unloadOllamaModels — evicting this card\'s models for a render on '
    + 'another machine is the second half of the defect, not a side effect of the first');
});

check('it tests WHICH server, never merely whether the venue is crucible', () => {
  /*
   * `GenerationVenue` has one member, so `where === 'crucible'` is now always
   * true. A gate written that way would skip the lease for EVERY render —
   * including the WSL engine on this PC, which really does use this card — and
   * two GPU jobs would then run on one card with nothing arbitrating.
   */
  assert.ok(!/venue\?\.where\s*===\s*'crucible'/.test(body),
    'acquireGpuForJob gates on `where === crucible`, which is always true now. That '
    + 'skips the lease for the WSL engine on this machine too, and lets a local render '
    + 'run unarbitrated beside AI cleanup.');
});

check('a session with NO venue keeps the old behaviour', () => {
  // "I do not know where this is going" must not be read as "it is going
  // elsewhere" — an assembly-only run has no venue and must not lose its lock.
  assert.ok(/venueServer !== undefined/.test(body),
    'the gate must require a KNOWN venue before skipping the lease.');
});

check('the fact has one owner — the same one the bench reads', () => {
  const slots = fs.readFileSync(
    path.join(REPO, 'shared', 'queue', 'slot-sets.ts'), 'utf8');
  assert.ok(/serversOnThisMachine/.test(slots),
    'shared/queue/slot-sets.ts no longer uses serversOnThisMachine, so "is this server '
    + 'here" now has two answers — the bench\'s and the GPU lease\'s — and they will drift.');
});

console.log(`\ngpu lease venue: ${ran} check(s), exit ${process.exitCode || 0}`);
