#!/usr/bin/env node
/**
 * THE PREPARE BAR CROSSES A REPO BOUNDARY IN THE MIDDLE. This keeps it whole.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-assembly-prepare-progress.js
 *
 * ── What broke, and why a comment would not have held it ────────────────────
 *
 * Owen pressed Assemble on Mutineer's Moon (847 chunks, 25 chapters, library on
 * an SMB share) and the card showed NO movement for four minutes. narrator was
 * reading every sentence FLAC over the wire and writing ~1,700 faded copies and
 * silences back; nothing it printed in that window was a line the bridge maps to
 * a stage, because "[ASSEMBLE] Chapter N: sentences X-Y" is not printed until
 * every chapter has already been planned.
 *
 * The cure is two printed lines and a stage that reads them:
 *
 *     [ASSEMBLE] Preparing sentences 412/847
 *     [ASSEMBLE] Prepared 847 sentences in 63.4s
 *
 * Printed by python/narrator/assemble/{chapters,run}.py; understood by
 * shared/queue/assembly-prepare.ts; displayed by electron/reassembly-bridge.ts.
 * Every one of those three can be edited without the other two failing to
 * compile, and the failure mode is SILENT AND EXACTLY THE BUG WE STARTED WITH:
 * a bar that never moves. So this file asserts all three ends —
 *
 *   1. narrator still prints those two lines (read out of its own source),
 *   2. the pure mapper reads them into the position the card is drawn from,
 *   3. the bridge declares the `prepare` stage, routes both lines to it, and
 *      lets them through the stdout byte-prefilter that drops high-frequency
 *      output during a throttle window.
 *
 * (3) is not decoration. "[ASSEMBLE] Preparing sentences 412/847" contains none
 * of the markers that prefilter allows through, so before this change it was
 * dropped for the whole of every throttle window.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'assembly-prepare.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { parseAssemblyPrepare } = require(MODULE);

const CHAPTERS_PY = fs.readFileSync(
  path.join(REPO, 'python', 'narrator', 'assemble', 'chapters.py'), 'utf-8');
const RUN_PY = fs.readFileSync(
  path.join(REPO, 'python', 'narrator', 'assemble', 'run.py'), 'utf-8');
const BRIDGE = fs.readFileSync(
  path.join(REPO, 'electron', 'reassembly-bridge.ts'), 'utf-8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── 1. narrator's end: the lines are still printed ──────────────────────────

test('narrator prints the progress line this bar is drawn from', () => {
  assert.ok(
    CHAPTERS_PY.includes('f"[ASSEMBLE] Preparing sentences {done}/{self._total}"'),
    'assemble/chapters.py no longer prints "[ASSEMBLE] Preparing sentences <done>/<total>"',
  );
  assert.ok(
    CHAPTERS_PY.includes('f"[ASSEMBLE] Preparing sentences 0/{self._total}"'),
    'assemble/chapters.py no longer opens the bar at 0/<total>',
  );
});

test('narrator prints the closing line, with the wall time', () => {
  assert.ok(
    RUN_PY.includes('f"[ASSEMBLE] Prepared {chunk_total(manifest)} sentences in "'),
    'assemble/run.py no longer prints "[ASSEMBLE] Prepared <total> sentences in <s>s"',
  );
  assert.ok(
    /time\.monotonic\(\) - prepare_started/.test(RUN_PY),
    'assemble/run.py no longer times the prepare step',
  );
});

test('narrator names the work dir it leaves behind on a failure', () => {
  // Not the bar, but the same contract: the work dir moved to local temp, so
  // this log line is the ONLY statement of where the evidence went.
  assert.ok(
    RUN_PY.includes('f"[assembly] Working directory: {work_dir}"'),
    'assemble/run.py no longer says where its working directory is',
  );
});

// ── 2. the pure mapper ──────────────────────────────────────────────────────

test('a progress line becomes a position, a percentage and a message', () => {
  const at = parseAssemblyPrepare('[ASSEMBLE] Preparing sentences 412/847\n');
  assert.ok(at, 'the progress line was not recognized at all');
  assert.strictEqual(at.done, 412);
  assert.strictEqual(at.total, 847);
  assert.strictEqual(at.finished, false);
  assert.ok(Math.abs(at.pct - (412 / 847) * 100) < 1e-9, `pct was ${at.pct}`);
  assert.strictEqual(at.message, 'Preparing 412 of 847 sentences...');
});

test('the opening 0/N is a real position, not a no-op', () => {
  const at = parseAssemblyPrepare('[ASSEMBLE] Preparing sentences 0/847');
  assert.ok(at);
  assert.strictEqual(at.pct, 0);
  assert.strictEqual(at.message, 'Preparing 0 of 847 sentences...');
});

test('the closing line fills the stage and carries the wall time', () => {
  const done = parseAssemblyPrepare('[ASSEMBLE] Prepared 847 sentences in 63.4s');
  assert.ok(done, 'the closing line was not recognized');
  assert.strictEqual(done.finished, true);
  assert.strictEqual(done.pct, 100);
  assert.strictEqual(done.done, 847);
  assert.strictEqual(done.seconds, 63.4);
  assert.strictEqual(done.message, 'Prepared 847 sentences in 63.4s');
});

test('a chunk of several lines reports the LAST position in it', () => {
  // proc.stdout hands the bridge whatever the pipe held. Reporting the oldest
  // number in a burst is a bar that lags for no reason.
  const at = parseAssemblyPrepare(
    '[ASSEMBLE] Preparing sentences 100/847\n' +
    '[ASSEMBLE] Preparing sentences 260/847\n' +
    '[ASSEMBLE] Preparing sentences 400/847\n');
  assert.strictEqual(at.done, 400);
});

test('the closing line wins over a progress line in the same chunk', () => {
  const at = parseAssemblyPrepare(
    '[ASSEMBLE] Preparing sentences 800/847\n' +
    '[ASSEMBLE] Prepared 847 sentences in 63.4s\n');
  assert.strictEqual(at.finished, true);
  assert.strictEqual(at.pct, 100);
});

test('a chunk that carries neither line is not a position', () => {
  for (const line of [
    '[ASSEMBLE] Assembling all 25 chapters...',
    '[ASSEMBLE] Chapter 3: sentences 88-140',
    'Preparing reassembly...',
    'Export - 41.0%',
    '',
  ]) {
    assert.strictEqual(parseAssemblyPrepare(line), null, `matched: ${line}`);
  }
});

test('the real emitted lines round-trip, not just hand-written ones', () => {
  // Built the way narrator builds them, so a format change on that side lands
  // here rather than on the card.
  const total = 847;
  for (const done of [0, 1, 423, total]) {
    const at = parseAssemblyPrepare(`[ASSEMBLE] Preparing sentences ${done}/${total}`);
    assert.ok(at, `narrator's own line at ${done}/${total} was not recognized`);
    assert.strictEqual(at.done, done);
  }
  const closing = parseAssemblyPrepare(
    `[ASSEMBLE] Prepared ${total} sentences in ${(63.42).toFixed(1)}s`);
  assert.strictEqual(closing.total, total);
});

test('a book with nothing to prepare gets no bar rather than a 0/0 one', () => {
  assert.strictEqual(parseAssemblyPrepare('[ASSEMBLE] Preparing sentences 0/0'), null);
  assert.strictEqual(parseAssemblyPrepare('[ASSEMBLE] Prepared 0 sentences in 0.0s'), null);
});

// ── 3. the bridge's end ─────────────────────────────────────────────────────

test('the bridge declares a prepare stage, ahead of combine', () => {
  const prepareAt = BRIDGE.indexOf("{ name: 'prepare', label: 'Preparing sentences'");
  const combineAt = BRIDGE.indexOf("{ name: 'combine', label: 'Combining chapters'");
  assert.ok(prepareAt > 0, 'STAGE_ALWAYS no longer declares a `prepare` stage');
  assert.ok(combineAt > 0, 'STAGE_ALWAYS no longer declares a `combine` stage');
  // StageTracker completes every EARLIER stage when a later one advances, so a
  // prepare stage declared after combine would be filled and retired by the
  // first thing combine does.
  assert.ok(prepareAt < combineAt, '`prepare` must be declared before `combine`');
});

test('the prepare stage maps onto a coarse phase', () => {
  // STAGE_PHASE is what the queue service watches; a stage missing from it
  // reports `phase: undefined`.
  assert.ok(/prepare:\s*'preparing'/.test(BRIDGE),
    'STAGE_PHASE has no entry for the prepare stage');
});

test('the bridge routes both prepare lines to the prepare stage', () => {
  assert.ok(BRIDGE.includes("import { parseAssemblyPrepare } from '../shared/queue/assembly-prepare'"),
    'the bridge no longer uses the shared prepare mapper');
  assert.ok(/const preparing = parseAssemblyPrepare\(line\);/.test(BRIDGE),
    'the bridge no longer parses prepare lines out of stdout');
  assert.ok(/emitStage\('prepare', preparing\.pct, preparing\.message/.test(BRIDGE),
    'the parsed prepare position is no longer emitted on the prepare stage');
});

test('the first message before any output still lands on the prepare stage', () => {
  assert.ok(BRIDGE.includes("emitStage('prepare', null, 'Preparing reassembly...')"),
    'the opening "Preparing reassembly..." message moved off the prepare stage');
});

test('"Assembling all N chapters" does not start combine ahead of prepare', () => {
  // narrator prints it BEFORE preparing anything. Starting `combine` there
  // completes the prepare bar at the moment the minutes it measures begin.
  assert.ok(
    /emitStage\('prepare', null, `Preparing sentences for \$\{totalChapters\} chapters/.test(BRIDGE),
    '"Assembling all N chapters" no longer reports under the prepare stage',
  );
  assert.ok(
    !/emitStage\('combine', null, `Combining sentences into/.test(BRIDGE),
    '"Assembling all N chapters" starts the combine stage again, which retires the prepare bar',
  );
});

test('the stdout prefilter can never drop a prepare line', () => {
  // Two guards run before data.toString(). A prepare line carries none of the
  // high-frequency markers and none of the "known pattern" markers, so it must
  // be named in BOTH or it is dropped for the whole of every throttle window.
  const guards = BRIDGE.split('const line = data.toString();')[0];
  const hits = guards.split("data.includes('Prepar')").length - 1;
  assert.strictEqual(hits, 2,
    `expected 'Prepar' in both stdout prefilter guards, found it ${hits} time(s)`);
});

// ── run ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`assembly-prepare-progress: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
