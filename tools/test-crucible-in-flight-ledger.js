#!/usr/bin/env node
/**
 * THE RECORD A HARD KILL MUST NOT LOSE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-in-flight-ledger.js
 *
 * On 2026-09-19 Owen hard-killed `electron:dev` and the Mac's Crucible went on
 * running BookForge's `tts` job at 70% for an hour — voice resident, card
 * claimed — because the only thing that knew that job's id was a closure in a
 * process that no longer existed. `electron/crucible/in-flight-ledger.ts` is the
 * fix and this is what it has to be true of:
 *
 *  A. A submitted job is on DISK, not in a variable. Read it back from a fresh
 *     process and the row is there — that is the whole point, and a keeper that
 *     only asked the module it just wrote to would prove nothing.
 *  B. The key is (server, jobId). Two servers minting `job-1` is the ordinary
 *     case, and one settling must not forget the other.
 *  C. A settled job is gone; settling twice says nothing and breaks nothing.
 *  D. A corrupt or truncated ledger reads as EMPTY and never throws. This file
 *     exists to make a crash survivable; one that stopped the app from starting
 *     would be worse than the hole it fills.
 *  E. The write is atomic — temp-and-rename — so no reader ever sees half a
 *     file, and no `.tmp` is left behind.
 *  F. The RESUME POINT moves with the job (bug hunt C4, 2026-09-20).
 *     `attachTo.lastEventId` was documented and persisted nowhere, so after the
 *     one event this file exists for, a resume could not say where the job had
 *     got to and the only answer was the whole hour again.
 *
 * No server, no network, no GPU.
 */
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');
const { REPO, installElectronStub, makeChecker } = require('./fake-crucible');

const DIST = path.join(REPO, 'dist', 'electron');
const BUILT = path.join(DIST, 'crucible', 'in-flight-ledger.js');
if (!fs.existsSync(BUILT)) {
  console.log(skipLine('dist/electron/crucible/in-flight-ledger.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const { userData } = installElectronStub('bf-in-flight-ledger-');
const ledger = require(BUILT);
const { check, summary } = makeChecker();

const LEDGER_FILE = path.join(userData, 'crucible-in-flight.json');

/** Every check below is queued here and awaited at the bottom, so the summary is last. */
const queued = [];
const it = (name, fn) => queued.push(() => check(name, fn));

function entry(over) {
  return {
    server: 'the-mac',
    jobId: 'job-1',
    jobType: 'tts',
    model: 'mistborn',
    localId: 'step_abc_1',
    owns: ['/scratch/ebook-1111'],
    submittedAt: '2026-09-19T23:00:00.000Z',
    ...over,
  };
}

function resetLedger() {
  try { fs.unlinkSync(LEDGER_FILE); } catch { /* not there */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// The pure half — the rule, with no disk under it
// ─────────────────────────────────────────────────────────────────────────────

it('ledgerWith replaces the row for the same server+jobId, and keeps the rest', () => {
  const first = ledger.ledgerWith([], entry());
  const second = ledger.ledgerWith(first, entry({ server: 'the-pc' }));
  const replaced = ledger.ledgerWith(second, entry({ localId: 'step_abc_2' }));
  assert.strictEqual(replaced.length, 2, 'the same server+jobId is one row, not two');
  const mac = replaced.find((row) => row.server === 'the-mac');
  assert.strictEqual(mac.localId, 'step_abc_2');
  assert.ok(replaced.some((row) => row.server === 'the-pc'), 'the other server kept its row');
});

it('ledgerWithout removes only the named (server, jobId) pair', () => {
  const both = ledger.ledgerWith(ledger.ledgerWith([], entry()), entry({ server: 'the-pc' }));
  const left = ledger.ledgerWithout(both, 'the-mac', 'job-1');
  assert.deepStrictEqual(left.map((row) => row.server), ['the-pc'],
    'the pc job-1 is a DIFFERENT job from the mac job-1');
});

it('a ledger that does not parse reads as empty, with a named warning', () => {
  const warnings = [];
  assert.deepStrictEqual(ledger.parseInFlightLedger('{"jobs": [', (line) => warnings.push(line)), []);
  assert.strictEqual(warnings.length, 1, 'the unreadable file is named once');
  assert.ok(/does not parse/.test(warnings[0]), warnings[0]);
});

it('a ledger with no "jobs" array reads as empty, named', () => {
  const warnings = [];
  assert.deepStrictEqual(ledger.parseInFlightLedger('{"servers": []}', (line) => warnings.push(line)), []);
  assert.ok(/no "jobs" array/.test(warnings[0]), warnings[0]);
});

it('a row with no jobId is DROPPED by name, and its neighbours survive', () => {
  const warnings = [];
  const rows = ledger.parseInFlightLedger(
    JSON.stringify({ jobs: [{ server: 'x', jobType: 'tts' }, entry()] }),
    (line) => warnings.push(line),
  );
  assert.strictEqual(rows.length, 1, 'half a row cannot cancel anything');
  assert.strictEqual(rows[0].jobId, 'job-1');
  assert.ok(/dropping/.test(warnings[0]), warnings[0]);
});

it('a row missing its optional fields comes back with honest defaults', () => {
  const rows = ledger.parseInFlightLedger(
    JSON.stringify({ jobs: [{ server: 'x', jobId: 'j', jobType: 'align' }] }));
  assert.deepStrictEqual(rows, [{
    server: 'x', jobId: 'j', jobType: 'align', model: null, localId: '', owns: [], submittedAt: '',
    // A row written before 2026-09-20 has no resume point. Zero is not a guess:
    // it means "replay the whole history", which is correct and merely slower.
    lastEventId: 0,
  }], 'a missing model is null and a missing owns is empty — never invented');
});

// ─────────────────────────────────────────────────────────────────────────────
// F. THE RESUME POINT (bug hunt C4, 2026-09-20)
//
// `attachTo.lastEventId` is the server's own counter and the whole mechanism
// behind a resume that does not re-render an hour of audio. It was documented
// and persisted NOWHERE, so after the one event it exists for — a hard kill —
// nothing on this side knew where the job had got to.
// ─────────────────────────────────────────────────────────────────────────────

/** A ledger ROW: `entry()` is the submit shape, where `lastEventId` is optional. */
const row = (over) => ({ lastEventId: 0, ...entry(over) });

it('ledgerNotingEvent moves the row forward, and NEVER backwards', () => {
  const rows = [row(), row({ server: 'the-pc', jobId: 'job-9' })];
  const moved = ledger.ledgerNotingEvent(rows, 'the-mac', 'job-1', 7);
  assert.strictEqual(moved.find((r) => r.jobId === 'job-1').lastEventId, 7);
  assert.strictEqual(moved.find((r) => r.jobId === 'job-9').lastEventId, 0,
    'the other server\'s row is untouched');
  // A replay after an attach re-delivers ids this side has already acted on.
  // Taking the smaller number would move the resume point BACKWARDS and
  // re-render what was already landed.
  const back = ledger.ledgerNotingEvent(moved, 'the-mac', 'job-1', 3);
  assert.strictEqual(back, moved, 'nothing to do is the same array, so no write happens');
  const same = ledger.ledgerNotingEvent(moved, 'the-mac', 'job-1', 7);
  assert.strictEqual(same, moved, 'the same id twice costs no disk');
});

it('ledgerNotingEvent on a job that has settled is a no-op, not a resurrection', () => {
  const rows = [row()];
  assert.strictEqual(ledger.ledgerNotingEvent(rows, 'the-mac', 'gone', 4), rows);
  assert.strictEqual(ledger.ledgerNotingEvent([], 'the-mac', 'job-1', 4).length, 0,
    'a frame for a row that is not there does not put it back');
});

it('THREE FRAMES LATER THE LEDGER ROW ON DISK SAYS 3', () => {
  resetLedger();
  ledger.recordInFlight(entry());
  for (const id of [1, 2, 3]) ledger.noteInFlightEvent('the-mac', 'job-1', id);
  const onDisk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
  assert.strictEqual(onDisk.jobs.length, 1);
  assert.strictEqual(onDisk.jobs[0].lastEventId, 3,
    'write-through: the resume point is on disk, not in a variable a ctrl-C takes with it');
});

it('an ATTACH records the resume point it was handed, rather than starting at zero', () => {
  resetLedger();
  ledger.recordInFlight(entry({ lastEventId: 412 }));
  assert.strictEqual(ledger.readInFlightLedger()[0].lastEventId, 412);
  resetLedger();
  ledger.recordInFlight(entry());
  assert.strictEqual(ledger.readInFlightLedger()[0].lastEventId, 0,
    'a fresh submit has acted on no frame and says so');
});

// ─────────────────────────────────────────────────────────────────────────────
// The disk half
// ─────────────────────────────────────────────────────────────────────────────

it('recordInFlight puts the row on disk, pretty-printed for a person to read', () => {
  resetLedger();
  ledger.recordInFlight(entry());
  const onDisk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
  assert.strictEqual(onDisk.jobs.length, 1);
  assert.strictEqual(onDisk.jobs[0].jobId, 'job-1');
  assert.strictEqual(onDisk.jobs[0].model, 'mistborn', 'what to unload is recorded, not re-derived');
  assert.ok(fs.readFileSync(LEDGER_FILE, 'utf-8').includes('\n  '), 'written for a human after a crash');
});

it('the write leaves no .tmp behind — temp-and-rename, not write-in-place', () => {
  resetLedger();
  ledger.recordInFlight(entry());
  ledger.recordInFlight(entry({ jobId: 'job-2' }));
  const strays = fs.readdirSync(userData).filter((name) => name.includes('crucible-in-flight') && name !== 'crucible-in-flight.json');
  assert.deepStrictEqual(strays, [], `a temp file survived the write: ${strays.join(', ')}`);
});

it('settleInFlight forgets exactly one job, and settling twice is a no-op', () => {
  resetLedger();
  ledger.recordInFlight(entry());
  ledger.recordInFlight(entry({ server: 'the-pc' }));
  ledger.settleInFlight('the-mac', 'job-1');
  assert.deepStrictEqual(ledger.readInFlightLedger().map((row) => row.server), ['the-pc']);
  ledger.settleInFlight('the-mac', 'job-1');
  assert.deepStrictEqual(ledger.readInFlightLedger().map((row) => row.server), ['the-pc'],
    'a door that settles twice (a cancel, then the terminal frame) must not throw or churn');
});

it('no ledger file at all is no jobs — the ordinary state, never a throw', () => {
  resetLedger();
  assert.deepStrictEqual(ledger.readInFlightLedger(), []);
});

it('a ledger corrupted on disk reads as empty rather than stopping the app', () => {
  resetLedger();
  fs.writeFileSync(LEDGER_FILE, '{"jobs": [ {"server":', 'utf-8');
  assert.deepStrictEqual(ledger.readInFlightLedger(), []);
});

/*
 * THE CLAIM THIS WHOLE MODULE MAKES, and it cannot be tested inside one
 * process: a job submitted by a process that then DIES is still on disk for the
 * next one. So a child node writes the row and is killed with SIGKILL — no
 * exit handler, no flush, nothing cooperative — and this process reads it back.
 */
it('a row written by a process that is then SIGKILLed survives into the next one', () => {
  resetLedger();
  const child = path.join(os.tmpdir(), `bf-ledger-child-${process.pid}.js`);
  fs.writeFileSync(child, `
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === 'electron') {
        return { app: { getPath: () => ${JSON.stringify(userData)} } };
      }
      return origLoad.apply(this, arguments);
    };
    const ledger = require(${JSON.stringify(BUILT)});
    ledger.recordInFlight(${JSON.stringify(entry({ jobId: 'job-killed', localId: 'step_hardkill' }))});
    process.kill(process.pid, 'SIGKILL');
  `, 'utf-8');
  try {
    execFileSync(process.execPath, [child], { stdio: 'ignore' });
    assert.fail('the child was supposed to SIGKILL itself');
  } catch (err) {
    assert.ok(err.signal === 'SIGKILL' || err.status !== 0, `child ended oddly: ${err.signal} / ${err.status}`);
  } finally {
    try { fs.unlinkSync(child); } catch { /* fine */ }
  }
  const rows = ledger.readInFlightLedger();
  assert.deepStrictEqual(rows.map((row) => row.jobId), ['job-killed'],
    'this is the whole point: the record outlives the process that made it');
  assert.strictEqual(rows[0].localId, 'step_hardkill');
  assert.deepStrictEqual(rows[0].owns, ['/scratch/ebook-1111'],
    'and it still names the scratch the dead run owned');
});

(async () => {
  for (const run of queued) await run();
  summary('crucible in-flight ledger');
})();
