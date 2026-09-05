#!/usr/bin/env node
/**
 * DID THE WATCHDOG ACTUALLY FIRE? — the bridge's own matchers, run over a REAL
 * worker's captured stdout.
 *
 *   node tools/smoke-narrator-watchdog-live.js <render.log> [--worker N]
 *
 * NOT a keeper: it needs a log from a GPU render. `tools/test-narrator-log-strings.js`
 * is the keeper, and what it can prove is that the strings on the two sides agree —
 * narrator's SOURCE still contains each fragment, and the bridge's regexes match a
 * hand-written copy of each line. That is a proof about two files, not about a run.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `docs/NARRATOR_CUTOVER.md` recorded it as owed, in those words: "the matchers are
 * pinned against narrator's SOURCE strings, not against a live worker's stderr. A
 * live render is what turns that from 'the strings agree' into 'the watchdog fires'."
 *
 * Three things can be true with every string in place and the watchdog still dark:
 *
 *   1. the line goes to STDERR (the bridge runs these five parsers on stdout only —
 *      see `python/narrator/engine/log.py`, and the keeper's stream check);
 *   2. the line is never REACHED on this engine/backend (the vLLM batch path is
 *      much quieter than the MLX one — the keeper already asserts a healthy vLLM
 *      batch emits nothing that GENERATION_ACTIVITY_RE matches);
 *   3. it arrives wrapped — a conda-run prefix, a progress-bar carriage return —
 *      so the regex sees a line the fragment test never modelled.
 *
 * Only a real render answers those, and only for the paths that render exercised.
 * So this tool REPORTS rather than asserts a fixed set: it prints, per matcher, how
 * many live stdout lines matched and the first few of them, and fails only on the
 * matchers a completed render MUST have produced (the progress line and the two
 * model-load lines). A repair matcher firing zero times on a clean book is a clean
 * book, not a broken watchdog, and the tool says so instead of pretending.
 *
 * ── Reading the log ─────────────────────────────────────────────────────────
 *
 * `parallel-tts-bridge.ts` tags worker output as it arrives: `[WORKER n] <line>` for
 * stdout and `[WORKER n STDERR] <line>` for stderr. Those tags are how this tool
 * recovers WHICH STREAM each line came from, which is the whole point — a matcher
 * that only ever fires on a `[... STDERR]` line does not fire in production.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const BRIDGE = path.join(REPO, 'electron', 'parallel-tts-bridge.ts');

const argv = process.argv.slice(2);
const logPath = argv.find((a) => !a.startsWith('--'));
const workerIdx = argv.includes('--worker') ? argv[argv.indexOf('--worker') + 1] : null;

if (!logPath || !fs.existsSync(logPath)) {
  console.error('usage: node tools/smoke-narrator-watchdog-live.js <render.log> [--worker N]');
  process.exitCode = 2;
  return;
}

// The matchers, read out of the bridge's source — same technique, and same reason,
// as tools/test-narrator-log-strings.js: importing the bridge drags in Electron.
const bridgeSrc = fs.readFileSync(BRIDGE, 'utf-8');
function regexConst(name) {
  const m = bridgeSrc.match(new RegExp(`^const ${name} = (/.*/[a-z]*);$`, 'm'));
  assert.ok(m, `${name} is not a single-line regex constant in parallel-tts-bridge.ts`);
  const body = m[1].slice(1, m[1].lastIndexOf('/'));
  const flags = m[1].slice(m[1].lastIndexOf('/') + 1);
  return new RegExp(body, flags);
}

const MATCHERS = [
  { name: 'PROGRESS_LINE_RE', re: regexConst('PROGRESS_LINE_RE'), required: true,
    note: 'the render progress bar' },
  { name: 'MODEL_LOAD_START_RE', re: regexConst('MODEL_LOAD_START_RE'), required: true,
    note: 'starts the model-load stage' },
  { name: 'MODEL_LOAD_DONE_RE', re: regexConst('MODEL_LOAD_DONE_RE'), required: true,
    note: 'ends it — without this the load bar never completes' },
  { name: 'GENERATION_ACTIVITY_RE', re: regexConst('GENERATION_ACTIVITY_RE'), required: false,
    note: 'keeps the stall watchdog alive during a repair; a clean vLLM batch emits none' },
  { name: 'REPAIR_START_RE', re: regexConst('REPAIR_START_RE'), required: false,
    note: 'the re-split ladder; zero on a book that needed no repair' },
];

const STDOUT_RE = workerIdx == null ? /^\[WORKER (\d+)\] (.*)$/ : new RegExp(`^\\[WORKER ${workerIdx}\\] (.*)$`);
const STDERR_RE = workerIdx == null ? /^\[WORKER (\d+) STDERR\] (.*)$/ : new RegExp(`^\\[WORKER ${workerIdx} STDERR\\] (.*)$`);

const outLines = [];
const errLines = [];
for (const raw of fs.readFileSync(logPath, 'utf-8').split(/\r?\n/)) {
  let m = raw.match(STDERR_RE);
  if (m) { errLines.push(m[m.length - 1]); continue; }
  m = raw.match(STDOUT_RE);
  if (m) outLines.push(m[m.length - 1]);
}

console.log(`worker stdout lines: ${outLines.length}`);
console.log(`worker stderr lines: ${errLines.length}`);
if (!outLines.length) {
  console.error('No [WORKER n] stdout lines in that log — nothing to match against.');
  process.exitCode = 2;
  return;
}

let bad = 0;
console.log('');
for (const m of MATCHERS) {
  const hitsOut = outLines.filter((l) => m.re.test(l));
  const hitsErr = errLines.filter((l) => m.re.test(l));
  const ok = m.required ? hitsOut.length > 0 : true;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${m.name}: ${hitsOut.length} on stdout, ${hitsErr.length} on stderr`);
  console.log(`        ${m.note}`);
  for (const l of hitsOut.slice(0, 2)) console.log(`        > ${l.slice(0, 150)}`);
  if (hitsOut.length > 2) console.log(`        > ... and ${hitsOut.length - 2} more`);
  if (!hitsOut.length && hitsErr.length) {
    console.log('        !! matched ONLY on stderr. The bridge runs this matcher on the');
    console.log('           STDOUT handler, so in production it did not fire at all.');
    bad++;
  }
  if (!m.required && !hitsOut.length && !hitsErr.length) {
    console.log('        (zero is a legitimate answer here — see the header)');
  }
}

// The capture-group contract, on real text rather than a hand-written sample: the
// bridge reads (index, total, percent) off PROGRESS_LINE_RE and drives the book's
// progress bar with them. A regrouped regex parses without erroring and reports a
// book that is 3954% done.
const progressRe = regexConst('PROGRESS_LINE_RE');
const sample = outLines.find((l) => progressRe.test(l));
if (sample) {
  const g = sample.match(progressRe);
  const [, idx, total, pct] = g;
  const consistent = Number(idx) <= Number(total) && Math.abs((Number(idx) / Number(total)) * 100 - Number(pct)) < 1.5;
  console.log('');
  console.log(`${consistent ? 'ok  ' : 'FAIL'}  the live progress line's groups are (index, total, percent)`);
  console.log(`        ${JSON.stringify(sample)} -> index=${idx} total=${total} percent=${pct}`);
  if (!consistent) bad++;
}

console.log('');
console.log(bad ? `${bad} matcher problem(s).` : 'Every required matcher fired on the live worker stdout.');
process.exitCode = bad ? 1 : 0;
