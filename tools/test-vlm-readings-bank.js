/**
 * Tests for WHAT HAPPENS TO THE ANSWERS ALREADY BANKED for a book — the decision
 * behind Convert to EPUB when a previous run left readings on disk.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-vlm-readings-bank.js
 *
 * Everything here is pure (shared/vlm/readings-bank.ts), and it is the part of
 * the feature worth testing without a GPU, because it is the part that decides
 * whether ninety minutes of work happens at all.
 *
 * THE BUG this closes, in Owen's words (2026-08-09): "i told it to run the VLM
 * by scheduling the job in the queue, and instead of doing what i told it to do,
 * it used an unexpected codepath to completely ignore my order and do something
 * different. fallbacks are bugs." A conversion that had already FINISHED could be
 * ordered again and satisfy itself entirely from the bank, doing no VLM work.
 *
 * THE DEFAULTS, because they are what a person will actually press: fresh after
 * a run that completed, resume after one that was interrupted. Both witnesses to
 * "it completed" are tested — foundry's own marker, and BookForge's provenance,
 * which is the ONLY evidence a bank written before markers existed leaves.
 *
 * THE ARGV, because a flag that does not reach foundry is a run that silently
 * replayed a cache — which is the bug itself, back again.
 *
 * THE LEGACY JOB, because `queue.json` outlives the build that wrote it: a row
 * enqueued before the question existed was expecting the bank, and giving it the
 * fresh-on-completed default would answer a question it was never asked.
 *
 * THE VERSION GATE, because dropping the flag against an old foundry is the one
 * failure mode that looks exactly like success.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'vlm', 'readings-bank.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  FOUNDRY_VERSION_FOR_READINGS_FLAGS,
  bankIsFromCompletedRun,
  defaultReadingsChoice,
  describeReadingsBank,
  describeReadingsChoices,
  describeReadingsDecision,
  foundryTooOldForReadingsFlags,
  foundryVersionAtLeast,
  readingsChoiceButtons,
  readingsChoiceOfJob,
  vlmReadingsArgs,
} = require(MODULE);

const results = [];
let failures = 0;
function check(name, fn) {
  try {
    fn();
    results.push(['ok', name, '']);
  } catch (err) {
    failures += 1;
    results.push(['FAIL', name, err && err.message ? err.message : String(err)]);
  }
}

const PATH = '/home/u/Documents/BookForge/foundry-runs/vlm-abc123/readings.jsonl';

/** A bank in one of the four states, spelled out so a test reads as a scenario. */
const empty = { path: PATH, pages: 0, completedAt: null, recordedConversionAt: null, totalPages: null };
const interrupted = { path: PATH, pages: 180, completedAt: null, recordedConversionAt: null, totalPages: null };
const completedByMarker = {
  path: PATH, pages: 317, completedAt: '2026-08-01T12:00:00.000Z',
  recordedConversionAt: null, totalPages: 317,
};
/** The legacy shape: foundry wrote no marker, and only BookForge's record knows. */
const completedByProvenance = {
  path: PATH, pages: 317, completedAt: null,
  recordedConversionAt: '2026-07-04T09:15:00.000Z', totalPages: 317,
};

// ── which run banked these ──────────────────────────────────────────────────

check('either witness means the conversion completed', () => {
  assert.strictEqual(bankIsFromCompletedRun(completedByMarker), true);
  assert.strictEqual(bankIsFromCompletedRun(completedByProvenance), true);
  assert.strictEqual(bankIsFromCompletedRun(interrupted), false);
  assert.strictEqual(bankIsFromCompletedRun(empty), false);
});

check('a completed run defaults to reading the book again', () => {
  assert.strictEqual(defaultReadingsChoice(completedByMarker), 'fresh');
  // The legacy bank reaches the same default off BookForge's own record, which
  // is the entire reason the app passes an explicit flag.
  assert.strictEqual(defaultReadingsChoice(completedByProvenance), 'fresh');
});

check('an interrupted run defaults to picking up where it stopped', () => {
  assert.strictEqual(defaultReadingsChoice(interrupted), 'reuse');
});

// ── what the dialog says ────────────────────────────────────────────────────

check('the dialog names the finish and the counts', () => {
  const said = describeReadingsBank(completedByMarker);
  assert.match(said, /already finished on 2026-08-01T12:00:00\.000Z/);
  assert.match(said, /317 of 317 page\(s\)/);
});

check('a bank nothing recorded a total for is not given an invented denominator', () => {
  assert.match(describeReadingsBank(interrupted), /180 page\(s\)/);
  assert.doesNotMatch(describeReadingsBank(interrupted), /\d+ of \d+/);
  assert.match(describeReadingsBank(interrupted), /was interrupted/);
});

check('the choices say what each one costs, in the terms that decide it', () => {
  const finished = describeReadingsChoices(completedByMarker);
  assert.match(finished, /moved into a timestamped folder beside them, never deleted/);
  assert.match(finished, /No page is read and no GPU is used/);
  const stopped = describeReadingsChoices(interrupted);
  assert.match(stopped, /picks up where it stopped/);
});

check('the default is the primary button, in both states', () => {
  const finished = readingsChoiceButtons(completedByMarker);
  assert.strictEqual(finished.primaryChoice, 'fresh');
  assert.strictEqual(finished.primaryLabel, 'Read all pages fresh');
  assert.strictEqual(finished.alternateChoice, 'reuse');
  assert.strictEqual(finished.alternateLabel, 'Use the banked readings');

  const stopped = readingsChoiceButtons(interrupted);
  assert.strictEqual(stopped.primaryChoice, 'reuse');
  // The word is RESUME where a run was interrupted: "use the banked readings"
  // describes a replay, and this is not one.
  assert.strictEqual(stopped.primaryLabel, 'Resume from the banked readings');
  assert.strictEqual(stopped.alternateChoice, 'fresh');
});

// ── the argv, which is where the bug lived ──────────────────────────────────

check('a bank always produces an explicit flag — never left to foundry', () => {
  assert.deepStrictEqual(vlmReadingsArgs('fresh', 317), ['--fresh-readings']);
  assert.deepStrictEqual(vlmReadingsArgs('reuse', 317), ['--reuse-readings']);
  assert.deepStrictEqual(vlmReadingsArgs('fresh', 1), ['--fresh-readings']);
});

check('no bank produces no flag: there is nothing to act on', () => {
  // --reuse-readings against an empty bank is a refusal in foundry by design,
  // so it is never sent into one.
  assert.deepStrictEqual(vlmReadingsArgs('reuse', 0), []);
  assert.deepStrictEqual(vlmReadingsArgs('fresh', 0), []);
});

// ── what a job's recorded answer means ──────────────────────────────────────

check('a recorded choice is obeyed exactly, on the first start and on a retry', () => {
  assert.strictEqual(readingsChoiceOfJob('fresh'), 'fresh');
  assert.strictEqual(readingsChoiceOfJob('reuse'), 'reuse');
});

check('a job with no recorded choice was expecting the bank, and relies on it', () => {
  // Owen: "if its already in the queue and i hit start, it means it was
  // expecting the cache to be there and should rely on it." A legacy row must
  // NOT silently acquire the fresh-on-completed default.
  assert.strictEqual(readingsChoiceOfJob(undefined), 'reuse');
});

// ── the one line the job log gets ───────────────────────────────────────────

check('every path prints a sentence, including the ones where nothing happens', () => {
  assert.match(
    describeReadingsDecision('fresh', empty, false),
    /No page answers are banked at .*readings\.jsonl, so every page is read/);
  assert.match(
    describeReadingsDecision('fresh', completedByMarker, false),
    /Reading all pages fresh, as chosen when this job was added to the queue/);
  assert.match(
    describeReadingsDecision('fresh', completedByMarker, false),
    /archived beside it and the vision model reads the whole book again/);
  assert.match(
    describeReadingsDecision('reuse', interrupted, false),
    /Using the 180 banked page answer\(s\)/);
});

check('a legacy job says WHY it used the bank', () => {
  const said = describeReadingsDecision('reuse', completedByMarker, true);
  assert.match(said, /this job was added to the queue before BookForge asked about banked readings/);
});

check('reusing a FINISHED run says no page is read', () => {
  assert.match(
    describeReadingsDecision('reuse', completedByMarker, false),
    /the book is rebuilt from them and no page is read/);
  // An interrupted run is not a replay, so it does not claim to be one.
  assert.doesNotMatch(
    describeReadingsDecision('reuse', interrupted, false),
    /no page is read/);
});

// ── the version gate ────────────────────────────────────────────────────────

check('versions compare numerically, not as strings', () => {
  assert.strictEqual(foundryVersionAtLeast('0.9.0', '0.9.0'), true);
  assert.strictEqual(foundryVersionAtLeast('0.10.0', '0.9.0'), true);
  assert.strictEqual(foundryVersionAtLeast('1.0.0', '0.9.0'), true);
  assert.strictEqual(foundryVersionAtLeast('0.8.0', '0.9.0'), false);
  assert.strictEqual(foundryVersionAtLeast('0.8.99', '0.9.0'), false);
});

check('a version this build cannot read is NOT treated as new enough', () => {
  // The safe direction: refusing names a fix, while a wrong "new enough" ships
  // the run without the flag and replays the cache.
  assert.strictEqual(foundryVersionAtLeast('', '0.9.0'), false);
  assert.strictEqual(foundryVersionAtLeast('unknown', '0.9.0'), false);
});

check('a prerelease is compared on its numbers', () => {
  assert.strictEqual(foundryVersionAtLeast('0.9.0-rc1', '0.9.0'), true);
  assert.strictEqual(foundryVersionAtLeast('0.8.0-rc1', '0.9.0'), false);
});

check('the refusal names the flag, the installed version and the one needed', () => {
  const said = foundryTooOldForReadingsFlags('0.8.0', '--fresh-readings');
  assert.match(said, /--fresh-readings/);
  assert.match(said, /installed foundry is 0\.8\.0/);
  assert.ok(said.includes(FOUNDRY_VERSION_FOR_READINGS_FLAGS),
    'the refusal must name the version that has the flag');
  assert.match(said, /Nothing was converted/);
});

// ── report ─────────────────────────────────────────────────────────────────
for (const [status, name, message] of results) {
  console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
