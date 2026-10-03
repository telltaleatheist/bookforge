#!/usr/bin/env node
/**
 * WHAT IS ON A CRUCIBLE CARD, AS THE QUEUE READS IT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-card-shadow.js
 *
 * Owen, 2026-09-26: *"poll crucible to see if something is holding a lease. if
 * it is, show it as a shadow in the bookforge queue with a progress bar. when it
 * finishes, bookforge tries to take the lease."* `electron/crucible/card-shadow.ts`
 * turns one `GET /v1/activity` into the two answers that needs:
 *
 *  A. A FOREIGN job is the shadow, with its progress; OUR job never is.
 *  B. Ours is told apart by ID, never by client name: another BookForge's
 *     session is foreign even though it is a BookForge too.
 *  C. A foreign queue SESSION makes the card busy (one open per server, and
 *     nothing from another client runs while it is); our own session does not.
 *  D. A session or a stream has no denominator, so the shadow's progress is null,
 *     never 0.
 *  E. A shut lane with nothing foreign named and none of our jobs on it is a
 *     claim; with one of our jobs on it, there is no shadow at all.
 *
 * Pure: no server, no network, no Electron.
 */
'use strict';
const assert = require('assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { readCard, holderName } = require(path.join(REPO, 'dist', 'electron', 'crucible', 'card-shadow.js'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); } catch (err) {
    failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

const NONE = { jobs: new Set(), sessions: new Set() };

function activity(over = {}) {
  return {
    serverName: 'pc', uptimeS: 1, resident: { kind: 'llm', id: 'qwen3.5-9b', since: null },
    warming: null, claimedBy: null, streaming: null, chatInFlight: 0, session: null,
    slot: { busy: 0, of: 1, queueDepth: 0, acceptsWork: true }, running: [], queued: [],
    ...over,
  };
}
function job(id, over = {}) {
  return {
    jobId: id, type: 'tts', model: 'higgs', status: 'running', progress: 0.42,
    message: 'chunk 12/30', client: 'foundry crucible-client/1.0.40', started: '2026-09-26T10:00:00Z',
    ...over,
  };
}
const shut = { busy: 1, of: 1, queueDepth: 0, acceptsWork: false };

check('an idle card: no shadow, not busy', () => {
  assert.deepStrictEqual(readCard(activity(), NONE), { busy: null, shadow: null });
});

check('A: a foreign job is the shadow, with its progress and message', () => {
  const r = readCard(activity({ slot: shut, running: [job('j1')] }), NONE);
  assert.deepStrictEqual(r.shadow, {
    kind: 'job', holder: 'foundry', what: 'tts higgs', progress: 0.42,
    message: 'chunk 12/30', since: '2026-09-26T10:00:00Z',
  });
  assert.ok(r.busy !== null && /foundry/.test(r.busy.line), 'and the lane is busy, naming it');
});

check('A: OUR job is never a shadow, though the lane is still busy for our other books', () => {
  const r = readCard(activity({ slot: shut, running: [job('ours', { client: 'bookforge crucible-client/1.0.38' })] }),
    { jobs: new Set(['ours']), sessions: new Set() });
  assert.strictEqual(r.shadow, null);
  assert.ok(r.busy !== null, 'the own-card rule, not this read, keeps a run off its own line');
});

check('B+C: another BookForge\'s session is foreign and makes the card busy', () => {
  const session = { sessionId: 'S-mac', act: 'clean', client: 'bookforge@my-pc', model: null, since: '2026-09-26T09:00:00Z' };
  const r = readCard(activity({ session }), NONE);
  assert.deepStrictEqual(r.shadow, {
    kind: 'session', holder: 'bookforge@my-pc', what: 'clean on qwen3.5-9b', progress: null,
    message: null, since: '2026-09-26T09:00:00Z',
  });
  assert.ok(r.busy !== null && /a session for clean on qwen3\.5-9b/.test(r.busy.line), r.busy && r.busy.line);
});

check('C: OUR session is neither a shadow nor busy', () => {
  const session = { sessionId: 'S-ours', act: 'clean', client: 'bookforge@my-mac', model: null, since: '2026-09-26T09:00:00Z' };
  assert.deepStrictEqual(readCard(activity({ session }), { jobs: new Set(), sessions: new Set(['S-ours']) }),
    { busy: null, shadow: null });
  // The hosted Foundry's session is ours by the LEDGER, where it is recorded as a job id.
  assert.deepStrictEqual(readCard(activity({ session }), { jobs: new Set(['S-ours']), sessions: new Set() }),
    { busy: null, shadow: null });
});

check('D: a stream has no denominator: progress null, never 0', () => {
  const streaming = { sessionId: 's', voice: 'leah', since: null, client: 'bookforge-extension', said: 3, finished: 2, inFlight: 1, seconds: 9 };
  const r = readCard(activity({ slot: shut, streaming }), NONE);
  assert.strictEqual(r.shadow.kind, 'streaming');
  assert.strictEqual(r.shadow.progress, null);
});

check('E: a shut lane that names nobody is a claim, unless one of our jobs is on it', () => {
  const r = readCard(activity({ slot: shut, warming: 'higgs', claimedBy: 'narrator' }), NONE);
  assert.strictEqual(r.shadow.kind, 'claim');
  assert.strictEqual(r.shadow.what, 'loading higgs');
  const ours = readCard(activity({ slot: shut, warming: 'higgs', queued: [job('q1')] }),
    { jobs: new Set(['q1']), sessions: new Set() });
  assert.strictEqual(ours.shadow, null);
});

check('holderName: the User-Agent\'s product, and null stays null', () => {
  assert.strictEqual(holderName('foundry crucible-client/1.0.40'), 'foundry');
  assert.strictEqual(holderName('briefcase/2.1'), 'briefcase');
  assert.strictEqual(holderName(null), null);
});

console.log(`crucible card shadow: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
