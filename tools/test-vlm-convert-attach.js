#!/usr/bin/env node
/**
 * Tests for ATTACHING — a queue row that follows a conversion already running
 * instead of ordering a second one.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-vlm-convert-attach.js
 *
 * ── What is being defended, and why it needs defending ──────────────────────
 *
 * Owen, 2026-08-10, having pressed Send to queue while a conversion was loading
 * its model: "i hit send to queue while i was waiting for it to load. it went to
 * the queue but it wasnt started, even though memory pressure went up. i hit
 * start. if i send it to the queue, it needs to continue what it was doing in
 * the queue instead of restarting. when i hit start in the queue it correctly
 * noticed it was already running somewhere else."
 *
 * That last sentence is the diagnosis. "Already running somewhere else" is
 * `beginStage`'s refusal, and ONLY a row that called `convertPdfToEpub` can
 * provoke it — so the row carried no `attachToRunning`, even though the service
 * that made it sets that flag correctly. The flag was set by the caller and
 * dropped by `buildConversionConfig`, which rebuilt the config field by field on
 * the way into the queue and listed every field except that one.
 *
 * Two different kinds of test follow, because that was two different failures:
 *
 *  1. THE DECISION — `conversionInFlightFor`. Written once in shared/ so the
 *     enqueue path and the runner's belt cannot answer it differently, and so
 *     the answer covers a conversion that has been ORDERED and has not claimed
 *     its project yet. That unclaimed minute is exactly when the button gets
 *     pressed, and it used to read as "nothing is running".
 *
 *  2. THE CARRY — that every optional field of `VlmConvertJobConfig` is named in
 *     `buildConversionConfig`. This is asserted against the SOURCE TEXT rather
 *     than by round-tripping a value, deliberately: the bug was not a wrong
 *     value but an ABSENT LINE, and a round-trip test can only ever check the
 *     fields whoever wrote it remembered — which is the same memory that dropped
 *     the field in the first place. Reading the interface and demanding the
 *     builder mention each of its fields catches the NEXT one too.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'shared', 'vlm', 'conversion.js');
if (!fs.existsSync(DIST)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { conversionInFlightFor } = require(DIST);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

const PROJECT = 'C:\\Users\\tellt\\Library\\Dune';
const OTHER = 'C:\\Users\\tellt\\Library\\Emma';

// ── 1. The decision ────────────────────────────────────────────────────────

test('no stages at all: nothing is in flight, so a row would START one', () => {
  assert.strictEqual(conversionInFlightFor(PROJECT, []), false);
});

test('a CLAIMED stage on this project is in flight', () => {
  assert.strictEqual(
    conversionInFlightFor(PROJECT, [{ projectDir: PROJECT, claimed: true }]), true);
});

test('an UNCLAIMED order on this project is in flight — the model-load window', () => {
  // The whole of Owen's report happens here. `runVlmConversion` waits on the GPU
  // arbiter and ~44 s of model load before `withProjectStage` claims anything,
  // and a row enqueued during that minute must still attach.
  assert.strictEqual(
    conversionInFlightFor(PROJECT, [{ projectDir: PROJECT, claimed: false }]), true);
});

test('a stage on a DIFFERENT project is not this book being converted', () => {
  assert.strictEqual(
    conversionInFlightFor(PROJECT, [{ projectDir: OTHER, claimed: true }]), false);
});

test('this project is found among several others', () => {
  const stages = [
    { projectDir: OTHER, claimed: true },
    { projectDir: PROJECT, claimed: false },
  ];
  assert.strictEqual(conversionInFlightFor(PROJECT, stages), true);
});

test('the path is matched by samePath, not by string equality', () => {
  // The project directory reaches this question from main, from a manifest and
  // from a component input, and those spell a Windows path differently. A
  // string compare here would make the same book look like two.
  const asMain = 'C:\\Users\\tellt\\Library\\Dune';
  const asComponent = 'C:/Users/tellt/Library/Dune';
  assert.strictEqual(
    conversionInFlightFor(asComponent, [{ projectDir: asMain, claimed: true }]), true);
  assert.strictEqual(
    conversionInFlightFor(asMain, [{ projectDir: asComponent, claimed: true }]), true);
});

test('a trailing separator is the same directory', () => {
  assert.strictEqual(
    conversionInFlightFor(PROJECT, [{ projectDir: `${PROJECT}\\`, claimed: true }]), true);
});

test('`claimed` may be absent — the question is about the book, not the lock', () => {
  assert.strictEqual(conversionInFlightFor(PROJECT, [{ projectDir: PROJECT }]), true);
});

// ── 2. The carry ───────────────────────────────────────────────────────────

const JOB_SOURCE = fs.readFileSync(
  path.join(REPO, 'src', 'app', 'features', 'queue', 'jobs', 'vlm-convert-job.ts'), 'utf-8');

/**
 * The CODE of `buildConversionConfig`, with its comments stripped.
 *
 * Stripped because this file's own explanation of the bug names the dropped
 * field repeatedly, and a test that a comment can satisfy defends a comment. The
 * assertions below look for `raw.<field>` — the read that actually carries a
 * value onto the row — for the same reason.
 */
function builderBody() {
  const start = JOB_SOURCE.indexOf('export function buildConversionConfig');
  assert.notStrictEqual(start, -1, 'buildConversionConfig has been renamed or removed');
  const end = JOB_SOURCE.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'buildConversionConfig has no closing brace');
  return JOB_SOURCE.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** Every optional field declared on `VlmConvertJobConfig`. */
function optionalConfigFields() {
  const start = JOB_SOURCE.indexOf('export interface VlmConvertJobConfig');
  assert.notStrictEqual(start, -1, 'VlmConvertJobConfig has been renamed or removed');
  const end = JOB_SOURCE.indexOf('\n}', start);
  const body = JOB_SOURCE.slice(start, end);
  const fields = [];
  for (const match of body.matchAll(/^ {2}(\w+)\?:/gm)) fields.push(match[1]);
  return fields;
}

test('the config interface still declares optional fields to check', () => {
  // A guard on the guard: if the shape of the interface changes so that the
  // scan above finds nothing, the two tests below would pass vacuously and this
  // whole file would defend nothing.
  assert.ok(optionalConfigFields().length >= 5,
    `expected several optional fields on VlmConvertJobConfig, found `
    + `${optionalConfigFields().length}`);
});

test('attachToRunning is carried by buildConversionConfig — THE bug', () => {
  assert.ok(builderBody().includes('raw.attachToRunning'),
    'buildConversionConfig does not mention attachToRunning, so a row enqueued from a running '
    + 'conversion loses its flag on the way into the queue and orders a second conversion of a '
    + 'book already on the GPU. This is the exact defect Owen reported on 2026-08-10.');
});

test('EVERY optional field of the config survives buildConversionConfig', () => {
  const body = builderBody();
  const dropped = optionalConfigFields().filter((f) => !body.includes(`raw.${f}`));
  assert.deepStrictEqual(dropped, [],
    `buildConversionConfig silently drops ${dropped.join(', ')}. Every field on the config is a `
    + 'decision the user made at enqueue time; a builder that omits one rebuilds the row as if '
    + 'that decision had never been taken.');
});

test('the runner has ONE implementation of following a running conversion', () => {
  // Two copies of the attach wait is how the enqueue path and the reload path
  // came to behave differently for a whole release.
  const follows = [...JOB_SOURCE.matchAll(/followRunningConversion/g)].length;
  assert.ok(follows >= 3,
    'runConversionJob should define followRunningConversion once and reach it from both the '
    + `flagged arm and the belt; found ${follows} mentions`);
  // The CALL, not the interface declaration a few hundred lines above it.
  assert.strictEqual(
    [...JOB_SOURCE.matchAll(/electron\.onDocumentStageFinished\(/g)].length, 1,
    'the wait for main to say the conversion finished is written more than once');
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
