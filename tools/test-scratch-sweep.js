#!/usr/bin/env node
/**
 * WHAT THE SCRATCH SWEEP KEEPS, WHAT IT DELETES, AND WHAT IT SAYS IT DID.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-scratch-sweep.js
 *
 * Three findings from the 2026-09-20 bug hunt, all in this one module:
 *
 *  P2 — the sweep reported deletions it had not performed. Every `rm` was
 *       swallowed (`.catch(() => undefined)`) and then "Cleaned N item(s)" was
 *       logged over the whole list. Live: `ebook-8e3344a0` half-deleted over
 *       SMB — `bookforge-session.json` gone, 507 FLACs still there — reported
 *       as cleaned, and warned about as an unrescuable checkpoint on every
 *       launch since.
 *  Q5 — `liveStepIds` read a step's CONFIG and never its OUTPUT, so the
 *       `ebook-<uuid>` a DONE `prepare` had written for a HELD `tts-conversion`
 *       was classified as a leftover and removed. Two books were in exactly
 *       that state.
 *  Ruling 5 — `narration-cuts` is a content-addressed cache no step can name,
 *       and was therefore `rm -rf`'d at every start by the "anything else goes"
 *       rule.
 *
 * Real filesystem, no network, no electron: `scratch-sweep.ts` is pure except
 * for the `fs` calls this drives directly.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');
// `narrator-paths` reaches tool-paths -> managed-bins, which insists on a
// userData dir at require time. The shared stub is what every keeper that
// loads a dist module through electron uses.
const { REPO, installElectronStub } = require('./fake-crucible');

const DIST = path.join(REPO, 'dist', 'electron');
for (const built of ['scratch-sweep.js', 'narrator-paths.js']) {
  if (!fs.existsSync(path.join(DIST, built))) {
    console.log(skipLine(`dist/electron/${built} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}

installElectronStub('bf-scratch-sweep-');
const sweep = require(path.join(DIST, 'scratch-sweep.js'));
const narratorPaths = require(path.join(DIST, 'narrator-paths.js'));

let passed = 0;
const failures = [];
const queued = [];
const it = (name, run) => queued.push(async () => {
  try {
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
});

const mkScratch = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bf-scratch-${tag}-`));
  // The scratch root is module state in narrator-paths, and
  // `scratchNamesWantedBy` turns an absolute path into a top-level name through
  // it — so a keeper has to say where the root is, exactly as startup does.
  narratorPaths.setNarratorScratchRoot(dir);
  return dir;
};
const noRescue = async () => undefined;
const noForeign = async () => null;

// ─────────────────────────────────────────────────────────────────────────────
// Q5 · what the queue still wants is read off OUTPUTS too
// ─────────────────────────────────────────────────────────────────────────────

it('Q5: a done prepare\'s session survives while its tts child is held', () => {
  const scratch = mkScratch('q5');
  const session = path.join(scratch, 'ebook-X');

  // The live shape: prepare DONE, its output naming the session; the render
  // HELD behind it, naming nothing at all (its config has no path yet).
  const names = sweep.scratchNamesWantedBy([
    {
      id: 'step_prepare', status: 'done', parentStepId: 'source',
      output: { kind: 'prepared-session', sessionDir: session, processDir: path.join(session, 'abc') },
    },
    { id: 'step_tts', status: 'held', parentStepId: 'step_prepare', config: {} },
  ]);

  assert.ok(names.has('ebook-X'),
    'THE WHOLE FINDING: the only record of which session a held render will resume into is its '
    + `DONE parent's output. Wanted names were: ${[...names].join(', ')}`);

  const plan = sweep.planScratchSweep({
    names: ['ebook-X'], wantedByQueue: names, foreignHosts: new Map(),
  });
  assert.deepStrictEqual([...plan.remove], [],
    'and so it is not removed — Start refused by name after this was swept, and neither '
    + 'retry(stepId) nor retry(jobId) could re-run the finished prepare');
  assert.deepStrictEqual([...plan.keptForQueue], [{ name: 'ebook-X', wanted: 'ebook-X' }]);
});

it('Q5: a TERMINAL parent of a terminal step wants nothing', () => {
  const scratch = mkScratch('q5-done');
  const names = sweep.scratchNamesWantedBy([
    {
      id: 'step_prepare', status: 'done', parentStepId: 'source',
      output: { sessionDir: path.join(scratch, 'ebook-Y') },
    },
    { id: 'step_tts', status: 'done', parentStepId: 'step_prepare' },
  ]);
  assert.deepStrictEqual([...names], [],
    'a finished run holds nothing: the parent is only consulted for a LIVE child');
});

it('Q5: a live step\'s own output is named too', () => {
  const scratch = mkScratch('q5-own');
  const names = sweep.scratchNamesWantedBy([{
    id: 'step_tts', status: 'processing', parentStepId: 'source',
    output: { sessionDir: path.join(scratch, 'ebook-Z') },
  }]);
  assert.ok(names.has('ebook-Z'));
  assert.ok(names.has('step_tts'), 'and the id, as it always was');
});

it('Q5: an implied export a live step reads is still kept, by config and by sourceRef', () => {
  const scratch = mkScratch('q5-implied');
  const names = sweep.scratchNamesWantedBy([
    {
      id: 'a', status: 'queued', parentStepId: 'source',
      config: { epubPath: path.join(scratch, 'implied-1', 'A Book.epub') },
    },
    {
      id: 'b', status: 'queued', parentStepId: 'source',
      sourceRef: { path: path.join(scratch, 'implied-2', 'Another.epub') },
    },
  ]);
  assert.ok(names.has('implied-1') && names.has('implied-2'),
    `the behaviour that was already there must not be lost: ${[...names].join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ruling 5 · narration-cuts
// ─────────────────────────────────────────────────────────────────────────────

it('ruling 5: narration-cuts is a named survivor, not a leftover', async () => {
  const scratch = mkScratch('cuts');
  const cuts = path.join(scratch, 'narration-cuts');
  fs.mkdirSync(cuts, { recursive: true });
  fs.writeFileSync(path.join(cuts, 'abc123.epub'), 'PK');
  fs.mkdirSync(path.join(scratch, 'implied-old'), { recursive: true });

  const plan = await sweep.planScratchSweepOf(scratch, new Set(), noForeign);
  assert.deepStrictEqual([...plan.keptSurvivors], ['narration-cuts']);
  assert.deepStrictEqual([...plan.remove], ['implied-old'],
    'a shared cache no step can ever name is not a leftover — it is the model calls already paid for');

  await sweep.runScratchSweep(scratch, plan, noRescue, () => undefined);
  assert.ok(fs.existsSync(path.join(cuts, 'abc123.epub')));
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 · a delete that failed is not a delete that happened
// ─────────────────────────────────────────────────────────────────────────────

it('P2: an rm that throws is logged by name and NOT counted as cleaned', async () => {
  const scratch = mkScratch('p2');
  for (const name of ['ebook-good', 'ebook-stuck']) {
    fs.mkdirSync(path.join(scratch, name), { recursive: true });
  }

  const plan = await sweep.planScratchSweepOf(scratch, new Set(), noForeign);
  assert.deepStrictEqual([...plan.remove].sort(), ['ebook-good', 'ebook-stuck']);

  // One name refuses to go — the SMB shape: a real `rm` that raises partway.
  const realRm = fs.promises.rm;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  fs.promises.rm = async (target, opts) => {
    if (String(target).endsWith('ebook-stuck')) {
      const err = new Error('EIO: i/o error, rm');
      err.code = 'EIO';
      throw err;
    }
    return realRm.call(fs.promises, target, opts);
  };
  const lines = [];
  try {
    await sweep.runScratchSweep(scratch, plan, noRescue, (line) => lines.push(line));
  } finally {
    fs.promises.rm = realRm;
    console.error = realError;
  }

  const cleaned = lines.find((l) => l.startsWith('Cleaned'));
  assert.ok(cleaned, `something must say what WAS cleaned: ${lines.join(' | ')}`);
  assert.ok(cleaned.includes('ebook-good'), cleaned);
  assert.ok(!cleaned.includes('ebook-stuck'),
    `THE FINDING: the failed one must never be counted as cleaned — "${cleaned}"`);
  assert.ok(cleaned.startsWith('Cleaned 1 item'), `and the count is of what went: "${cleaned}"`);

  const named = errors.join(' | ');
  assert.ok(named.includes('ebook-stuck') && named.includes('EIO'),
    `the failure is reported BY NAME with its reason: ${named}`);
  assert.ok(fs.existsSync(path.join(scratch, 'ebook-stuck')));
  assert.ok(!fs.existsSync(path.join(scratch, 'ebook-good')));
});

it('P2: the condemned list is written before the rm and survives a torn one', async () => {
  const scratch = mkScratch('p2-ledger');
  const torn = path.join(scratch, 'ebook-torn');
  fs.mkdirSync(path.join(torn, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(torn, 'chapters', '0001.flac'), 'audio');
  // The sidecar the torn rm took — the fact that made the tree anonymous.
  fs.writeFileSync(path.join(torn, 'bookforge-session.json'), '{}');

  const plan = await sweep.planScratchSweepOf(scratch, new Set(), noForeign);
  const realRm = fs.promises.rm;
  const realError = console.error;
  console.error = () => undefined;
  fs.promises.rm = async (target, opts) => {
    if (String(target).endsWith('ebook-torn')) {
      // A partial delete: the sidecar goes, the audio stays, the call raises.
      fs.rmSync(path.join(torn, 'bookforge-session.json'), { force: true });
      throw new Error('ETIMEDOUT: operation timed out, rm');
    }
    return realRm.call(fs.promises, target, opts);
  };
  try {
    await sweep.runScratchSweep(scratch, plan, noRescue, () => undefined);
  } finally {
    fs.promises.rm = realRm;
    console.error = realError;
  }

  const ledger = path.join(scratch, sweep.DELETING_LEDGER);
  assert.ok(fs.existsSync(ledger),
    'the ledger is what still names a half-deleted tree once its own sidecar is gone');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledger, 'utf-8')).deleting, ['ebook-torn']);
  assert.ok(!fs.existsSync(path.join(torn, 'bookforge-session.json')),
    'the session is now anonymous — which is exactly the state the ledger exists to explain');

  // NEXT LAUNCH. The condemned tree is not offered to the rescue and not asked
  // who owns it; it is simply finished off.
  let rescueSawIt = false;
  const plan2 = await sweep.planScratchSweepOf(scratch, new Set(), async () => {
    throw new Error('the ownership probe must not be asked about a condemned tree');
  });
  assert.deepStrictEqual([...plan2.halfDeleted], ['ebook-torn']);
  assert.deepStrictEqual([...plan2.rescue], [],
    'NEVER rescued a second time: a torn tree is not a checkpoint, and warning about it as one '
    + 'on every launch is the noise this finding is made of');
  await sweep.runScratchSweep(scratch, plan2, async () => { rescueSawIt = true; }, () => undefined);
  assert.ok(!rescueSawIt, 'the rescue is not even run when nothing is to be rescued');
  assert.ok(!fs.existsSync(torn), 'and the delete finishes');
  assert.ok(!fs.existsSync(ledger), 'an empty condemned list removes the file');
});

it('P2: the ledger is never itself a sweepable name', async () => {
  const scratch = mkScratch('p2-self');
  fs.writeFileSync(path.join(scratch, sweep.DELETING_LEDGER), '{"deleting":[]}');
  fs.mkdirSync(path.join(scratch, 'implied-x'), { recursive: true });
  const plan = await sweep.planScratchSweepOf(scratch, new Set(), noForeign);
  assert.deepStrictEqual([...plan.remove], ['implied-x'],
    'our own bookkeeping is not scratch — sweeping it would erase the record of the last tear');
});

it('P2: a happy sweep leaves no ledger behind', async () => {
  const scratch = mkScratch('p2-clean');
  fs.mkdirSync(path.join(scratch, 'implied-a'), { recursive: true });
  const plan = await sweep.planScratchSweepOf(scratch, new Set(), noForeign);
  await sweep.runScratchSweep(scratch, plan, noRescue, () => undefined);
  assert.ok(!fs.existsSync(path.join(scratch, sweep.DELETING_LEDGER)),
    'the ledger existing at the next start means, and only means, an unfinished delete');
});

(async () => {
  console.log('scratch sweep — what it keeps, what it deletes, what it says it did');
  for (const run of queued) await run();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
