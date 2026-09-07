#!/usr/bin/env node
/**
 * THE ASSEMBLY SEALS THIS RUN'S TRANSCRIPT, AND IT NEVER HANGS THE ROW.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-assembly-transcript-seal.js
 *
 * ── The defect this keeps out ───────────────────────────────────────────────
 *
 * 2026-09-07, Mutineer's Moon (10.16 h, 25 chapters). The chain's reassembly
 * `step_mtrdtous_ce0c6133` encoded the audiobook, renamed it, and then showed
 * "Renaming to … 70%" forever with no process alive. Two things had to be true:
 *
 *  1. The session held TWO `.sentences.vtt` files — one written under the book's
 *     old title by a standalone assembly at 13:52, one written by the align at
 *     14:10 under the current title. The finalize refused ANY count above one,
 *     by `throw`.
 *  2. The finalize is called as `proc.on('close', (code) => { void finalizeOnce(code); })`,
 *     so the rejection was discarded, `resolve` never ran, and the step stayed
 *     `running` for good.
 *
 * Both halves are asserted here: the choice is made by THIS RUN'S STEM (the
 * pure half, `shared/queue/sentence-transcript.ts`), and the finalize resolves
 * whatever the body does (the structural half, on the bridge's own source).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'sentence-transcript.js');
if (!fs.existsSync(MODULE)) {
  console.error('Build first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { chooseSentenceTranscript, SENTENCE_VTT_SUFFIX } = require(MODULE);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

// The real names, verbatim from the hung run.
const OLD = "Mutineers'_Moon._David_Weber._1991_";
const NEW = "Mutineer's_Moon._David_Weber._1991_";
const staging = (stem) => [`${stem}.m4b`, `${stem}.vtt`];

console.log('\nchooseSentenceTranscript');

check('this run\'s own stem wins, and the other title is a stray, not a refusal', () => {
  const choice = chooseSentenceTranscript(
    staging(NEW),
    [`${OLD}${SENTENCE_VTT_SUFFIX}`, `${NEW}${SENTENCE_VTT_SUFFIX}`, 'session-state.json'],
  );
  assert.strictEqual(choice.kind, 'seal', choice.reason);
  assert.strictEqual(choice.source, 'own-stem');
  assert.strictEqual(choice.file, `${NEW}${SENTENCE_VTT_SUFFIX}`);
  assert.strictEqual(choice.inStaging, false);
  assert.deepStrictEqual(choice.strays, [`${OLD}${SENTENCE_VTT_SUFFIX}`]);
});

check('THE HUNG RUN: the same two files, assembled under the OLD stem, still seals', () => {
  const choice = chooseSentenceTranscript(
    staging(OLD),
    [`${OLD}${SENTENCE_VTT_SUFFIX}`, `${NEW}${SENTENCE_VTT_SUFFIX}`],
  );
  assert.strictEqual(choice.kind, 'seal', choice.reason);
  assert.strictEqual(choice.source, 'own-stem');
  assert.strictEqual(choice.file, `${OLD}${SENTENCE_VTT_SUFFIX}`);
});

check('one under ANOTHER stem is used — same session, same audio', () => {
  const choice = chooseSentenceTranscript(staging(NEW), [`${OLD}${SENTENCE_VTT_SUFFIX}`]);
  assert.strictEqual(choice.kind, 'seal', choice.reason);
  assert.strictEqual(choice.source, 'other-stem');
  assert.strictEqual(choice.file, `${OLD}${SENTENCE_VTT_SUFFIX}`);
  assert.strictEqual(choice.inStaging, false);
});

check('no sentence transcript at all falls back to the chunk VTT, in staging', () => {
  const choice = chooseSentenceTranscript(staging(NEW), ['session-state.json', 'chapters']);
  assert.strictEqual(choice.kind, 'seal', choice.reason);
  assert.strictEqual(choice.source, 'chunk');
  assert.strictEqual(choice.file, `${NEW}.vtt`);
  assert.strictEqual(choice.inStaging, true);
});

check('several sentence transcripts and NONE this run\'s is refused, by name', () => {
  const choice = chooseSentenceTranscript(
    staging('Something_Else'),
    [`${OLD}${SENTENCE_VTT_SUFFIX}`, `${NEW}${SENTENCE_VTT_SUFFIX}`],
  );
  assert.strictEqual(choice.kind, 'refuse');
  assert.ok(choice.reason.includes(OLD) && choice.reason.includes(NEW), choice.reason);
  assert.ok(choice.reason.includes(`Something_Else${SENTENCE_VTT_SUFFIX}`), choice.reason);
});

check('a staging dir with no chunk VTT is refused — there is no stem to key on', () => {
  const choice = chooseSentenceTranscript([`${NEW}.m4b`], [`${NEW}${SENTENCE_VTT_SUFFIX}`]);
  assert.strictEqual(choice.kind, 'refuse');
  assert.ok(choice.reason.includes('0 chunk transcripts'), choice.reason);
});

check('two chunk VTTs in staging is refused', () => {
  const choice = chooseSentenceTranscript(
    [`${NEW}.m4b`, `${NEW}.vtt`, `${OLD}.vtt`], [],
  );
  assert.strictEqual(choice.kind, 'refuse');
  assert.ok(choice.reason.includes('2 chunk transcripts'), choice.reason);
});

check('macOS resource forks and the sentence suffix are not chunk transcripts', () => {
  const choice = chooseSentenceTranscript(
    [`${NEW}.m4b`, `${NEW}.vtt`, `._${NEW}.vtt`, `${NEW}${SENTENCE_VTT_SUFFIX}`],
    [`._${NEW}${SENTENCE_VTT_SUFFIX}`],
  );
  assert.strictEqual(choice.kind, 'seal', choice.reason);
  // The `._` fork beside the session is not a transcript either, so this run has
  // no sentence file and falls back to its own chunk VTT.
  assert.strictEqual(choice.source, 'chunk');
});

console.log('\nthe finalize resolves whatever its body does');

const BRIDGE = fs.readFileSync(path.join(REPO, 'electron', 'reassembly-bridge.ts'), 'utf-8');

check('finalizeBody is called inside a try whose catch resolves success:false', () => {
  const at = BRIDGE.indexOf('const finalizeOnce = async (code: number | null)');
  assert.ok(at > 0, 'finalizeOnce is gone — this keeper names code that no longer exists');
  const wrapper = BRIDGE.slice(at, at + 2000);
  const body = wrapper.indexOf('await finalizeBody(code);');
  assert.ok(body > 0, 'finalizeOnce no longer delegates to finalizeBody');
  const tryAt = wrapper.lastIndexOf('try {', body);
  assert.ok(tryAt > 0 && tryAt < body, 'the call to finalizeBody is not inside a try');
  const catchAt = wrapper.indexOf('} catch (err) {', body);
  assert.ok(catchAt > body, 'the try around finalizeBody has no catch');
  const handler = wrapper.slice(catchAt, catchAt + 1200);
  assert.ok(
    handler.includes('resolve({ success: false'),
    'the catch does not resolve the promise — a throw would hang the queue row again',
  );
  assert.ok(
    !handler.includes('cleanupStagingDir(jobId)'),
    'the catch deletes the staging dir, which holds the only copy of the m4b',
  );
});

check('the sentence-transcript scan refuses by resolving, never by throwing', () => {
  const at = BRIDGE.indexOf('const choice = chooseSentenceTranscript(');
  assert.ok(at > 0, 'the bridge no longer uses the shared chooser');
  const block = BRIDGE.slice(at, at + 1200);
  assert.ok(block.includes("choice.kind === 'refuse'"), 'the refusal is not handled');
  assert.ok(block.includes('resolve({ success: false'), 'the refusal does not resolve');
  assert.ok(!block.includes('throw new Error'), 'the refusal still throws');
});

console.log('\nthe embed verifies from the MOOV, not by reading the book back');

// The compiled module imports `electron`; the stub the CLI adapters use makes
// that resolvable outside an Electron process.
require(path.join(REPO, 'cli', 'electron-stub.js'));
const { countNonEmptyVttCues } = require(path.join(REPO, 'dist', 'electron', 'metadata-tools.js'));

check('cues with text are counted; WEBVTT, NOTE and empty cues are not', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'Into the field of fire.',
    '',
    'NOTE estimated chunk 12',
    '',
    '00:00:02.000 --> 00:00:04.000',
    'The tunnel seemed endless.',
    '',
    // mov_text cannot represent this one and drops it — the off-by-one that
    // shipped a 133-cue book as 132.
    '00:00:04.000 --> 00:00:05.000',
    '',
    '00:00:05.000 --> 00:00:07.000',
    'He burst into the open.',
    '',
  ].join('\n');
  assert.strictEqual(countNonEmptyVttCues(vtt), 3);
});

check('a cue identifier line before the timing does not become a cue of its own', () => {
  const vtt = 'WEBVTT\n\ncue-1\n00:00:00.000 --> 00:00:01.000\nOne.\n\ncue-2\n00:00:01.000 --> 00:00:02.000\nTwo.\n';
  assert.strictEqual(countNonEmptyVttCues(vtt), 2);
});

check('a transcript with no cues counts zero rather than throwing', () => {
  assert.strictEqual(countNonEmptyVttCues('WEBVTT\n\n'), 0);
});

check('the embed checks the track with ffprobe and keeps the full read for the inconclusive case', () => {
  const tools = fs.readFileSync(path.join(REPO, 'electron', 'metadata-tools.ts'), 'utf-8');
  const at = tools.indexOf('async function subtitleTrackCarries(');
  assert.ok(at > 0, 'the moov-only verification is gone');
  const fn = tools.slice(at, at + 1600);
  assert.ok(fn.includes('probeSubtitleTrack('), 'it no longer probes');
  assert.ok(fn.includes('extractVttFromM4b('), 'an inconclusive probe must still read the file back');
  assert.ok(fn.includes('BOOKFORGE_VERIFY_VTT_FULL'), 'the diagnostic escape hatch is gone');
  assert.ok(
    !/embedAndVerifyVtt[\s\S]{0,400}extractVttFromM4b\(m4bPath\)/.test(tools),
    'embedAndVerifyVtt still reads the whole audiobook back to verify the track',
  );
});

console.log(failures === 0 ? '\nAll green.\n' : `\n${failures} failure(s).\n`);
process.exitCode = failures === 0 ? 0 : 1;
