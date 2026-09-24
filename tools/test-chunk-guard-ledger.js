#!/usr/bin/env node
/**
 * UNKNOWN IS NOT CLEAN, AND THE VERDICT'S VOCABULARY IS NARRATOR'S.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chunk-guard-ledger.js
 *
 * ── What this keeps out ─────────────────────────────────────────────────────
 *
 * Owen ruled on 2026-09-13 that the model and its inference own the guard AND the
 * retake decision (crucible/docs/PHASE6-REMOTE-RENDER.md). narrator reaches a
 * verdict about every chunk — `clean`, `short`, `long`, `hole`, `rerolled`,
 * `resplit`, `accepted-off-length` — and BookForge's only job is to record it.
 *
 * Two ways to get that wrong, and both of them are silent:
 *
 * 1. **Reading "we were not told" as "it was fine."** A chunk whose verdict never
 *    reached us is a chunk we know NOTHING about. The Crucible SDK already states
 *    the same rule one level down, about `capped`: "a client that read that null
 *    as `false` would report every runaway as a long sentence, silently". Folded
 *    into `clean`, a whole book rendered through a pin that cannot speak the
 *    field reports as a flawless render.
 *
 * 2. **Knowing the words.** The ladder's vocabulary is free to grow — `hole` was
 *    found missing from the written list on 2026-09-13, while the Crucible half
 *    was being wired, and it was the SECOND field-name correction that document
 *    needed. A reader here that enumerated the verdicts would be a second owner
 *    of them, which crucible/docs/ARCHITECTURE.md section 1 says is the shape
 *    every defect in this system turned out to be (R1).
 *
 * And a third, which is the reason the ledger exists at all: until 2026-09-13 the
 * ONLY thing that happened to a guard fire was a WARN line in
 * `<library>/logs/audiobook-<date>.log`, a per-day per-library text file that
 * nothing counted (R4 — a log line is never load-bearing).
 *
 * Every assertion below is one of those three, pinned.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const LEDGER = path.join(REPO, 'dist', 'electron', 'chunk-guard-ledger.js');

if (!fs.existsSync(LEDGER)) {
  console.log(skipLine('dist/electron/chunk-guard-ledger.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const ledger = require(LEDGER);

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

/** A real `GuardPlan.verdict()` object, shaped from PHASE6-REMOTE-RENDER.md §3. */
function verdictObject(word, extra) {
  return Object.assign({
    verdict: word,
    clean: word === 'clean',
    parts: 1,
    band: { max_chars_per_sec: 20.0, min_chars_per_sec: 14.5, reference: 17.03, observed: 4, warm: false },
    takes: [],
  }, extra || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unknown is not clean
// ─────────────────────────────────────────────────────────────────────────────

check('guard:null is UNKNOWN, named narrator-did-not-say, and is not counted clean', () => {
  const id = 'render-null-guard';
  ledger.forgetChunkGuards(id);
  ledger.recordCrucibleChunkGuard(id, { index: 0, guard: null });
  const [record] = ledger.chunkGuards(id);
  assert.strictEqual(record.verdict, null, 'a null guard must not become a verdict word');
  assert.strictEqual(record.unknownReason, 'narrator-did-not-say');
  assert.strictEqual(record.clean, null, '`clean` is unknown too, not false and not true');
  const summary = ledger.takeChunkGuards(id);
  assert.strictEqual(summary.unknown, 1);
  assert.strictEqual(summary.byVerdict.clean, undefined,
    'an unknown chunk must never appear under a verdict word');
  assert.deepStrictEqual(summary.unknownBy, { 'narrator-did-not-say': 1 });
});

check('an ABSENT guard key is a DIFFERENT unknown from a null one', () => {
  const id = 'render-absent-guard';
  ledger.forgetChunkGuards(id);
  // What the pinned @crucible/client v0.4.0 actually hands over: readChunk()
  // builds ChunkData from a fixed field list with no `guard` in it, so the
  // server's field is discarded inside the SDK. "Nobody between us and the
  // server speaks this field" is not "the server looked and narrator did not
  // say", and merging them would hide a pin problem inside a render report.
  ledger.recordCrucibleChunkGuard(id, { index: 7, seconds: 4.1, chars: 70, take: 0 });
  const [record] = ledger.chunkGuards(id);
  assert.strictEqual(record.verdict, null);
  assert.strictEqual(record.unknownReason, 'sdk-drops-the-field');
  const summary = ledger.takeChunkGuards(id);
  assert.deepStrictEqual(summary.unknownBy, { 'sdk-drops-the-field': 1 });
  assert.strictEqual(summary.unknown, 1);
});

check('a whole remote render the SDK cannot speak for reports 0 clean, not N clean', () => {
  const id = 'render-whole-book-blind';
  ledger.forgetChunkGuards(id);
  for (let i = 0; i < 50; i += 1) ledger.recordCrucibleChunkGuard(id, { index: i, take: 0 });
  const summary = ledger.takeChunkGuards(id);
  assert.strictEqual(summary.unknown, 50);
  assert.deepStrictEqual(summary.byVerdict, {},
    '50 chunks nobody could speak for must not read as 50 clean chunks');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The vocabulary is narrator's, not this side's
// ─────────────────────────────────────────────────────────────────────────────

check("every word the ladder emits today survives verbatim, and so does one it doesn't", () => {
  const id = 'render-vocabulary';
  ledger.forgetChunkGuards(id);
  // The six the ladder emits as of 2026-09-13 …
  const words = ['clean', 'short', 'long', 'hole', 'rerolled', 'resplit', 'accepted-off-length'];
  words.forEach((word, i) => {
    ledger.recordCrucibleChunkGuard(id, { index: i, guard: verdictObject(word) });
  });
  // … and one this side has never heard of. `hole` was exactly this case on
  // 2026-09-13: a word the ladder already emitted that no written list had. A
  // ledger that rejected it, or mapped it to "other", would have lost it.
  ledger.recordCrucibleChunkGuard(id, { index: 99, guard: verdictObject('a-rung-invented-next-year') });
  const summary = ledger.takeChunkGuards(id);
  for (const word of words) {
    assert.strictEqual(summary.byVerdict[word], 1, `"${word}" must be counted under its own name`);
  }
  assert.strictEqual(summary.byVerdict['a-rung-invented-next-year'], 1);
  assert.strictEqual(summary.unknown, 0, 'a word this side does not know is still a verdict');
});

check('the evidence is carried verbatim and unread', () => {
  const id = 'render-evidence';
  ledger.forgetChunkGuards(id);
  const takes = [
    { index: 3, depth: 0, side: 'short', rung: 'reroll', action: 'rerolled', chars_per_second: 28.4 },
    { index: 3, depth: 1, side: 'long', rung: 'accept', action: 'accepted-off-length' },
  ];
  const band = { max_chars_per_sec: 22.1, min_chars_per_sec: 13.9, reference: 18.0, observed: 41, warm: true };
  ledger.recordCrucibleChunkGuard(id, {
    index: 3,
    guard: { verdict: 'accepted-off-length', clean: false, parts: 2, band, takes },
  });
  const [record] = ledger.chunkGuards(id);
  assert.deepStrictEqual(record.takes, takes, 'takes must survive byte for byte');
  assert.deepStrictEqual(record.band, band, 'the band must survive byte for byte');
  assert.strictEqual(record.parts, 2, 'a split chunk says how many parts it came back as');
  assert.strictEqual(record.clean, false);
  ledger.forgetChunkGuards(id);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The stdout channel carries evidence, NEVER a conclusion
// ─────────────────────────────────────────────────────────────────────────────

check('a stdout guard event never manufactures a verdict', () => {
  const id = 'render-stdout';
  ledger.forgetChunkGuards(id);
  // It would be one line to write `records[-1].action` and call it the verdict,
  // and it would usually be right — and it would put truncation.py's derivation
  // in two languages. R1: one fact, one owner.
  ledger.recordGuardEvent(id, { index: 12, action: 'rerolled', rung: 'reroll', depth: 0 });
  ledger.recordGuardEvent(id, { index: 12, action: 'accepted-off-length', rung: 'accept', depth: 2 });
  const [record] = ledger.chunkGuards(id);
  assert.strictEqual(record.verdict, null,
    'the audiobook driver reaches a verdict and spends it on writing a FLAC; it never '
    + 'reaches a wire, and this side must not invent it from the take records');
  assert.strictEqual(record.unknownReason, 'events-only');
  assert.strictEqual(record.takes.length, 2, 'both take records are kept as evidence');
  assert.strictEqual(record.source, 'narrator-stdout');
  const summary = ledger.takeChunkGuards(id);
  assert.deepStrictEqual(summary.byVerdict, {});
  assert.deepStrictEqual(summary.unknownBy, { 'events-only': 1 });
});

check("Orpheus's sentence_index and Higgs's index both file under the same chunk", () => {
  const id = 'render-index-keys';
  ledger.forgetChunkGuards(id);
  // guards.py names it `sentence_index`; truncation.py names it `index`. Both
  // are load-bearing and neither is preferred — the bridge parses ONE prefix set
  // covering both engines, so one reader sees both spellings.
  ledger.recordGuardEvent(id, { sentence_index: 5, reason: 'truncation' });
  ledger.recordGuardEvent(id, { index: 5, action: 'short' });
  const records = ledger.chunkGuards(id);
  assert.strictEqual(records.length, 1, 'both spellings name chunk 5, not two chunks');
  assert.strictEqual(records[0].takes.length, 2);
  ledger.forgetChunkGuards(id);
});

check('evidence never overwrites a conclusion', () => {
  const id = 'render-mixed';
  ledger.forgetChunkGuards(id);
  ledger.recordCrucibleChunkGuard(id, { index: 4, guard: verdictObject('resplit') });
  ledger.recordGuardEvent(id, { index: 4, action: 'rerolled' });
  const [record] = ledger.chunkGuards(id);
  assert.strictEqual(record.verdict, 'resplit',
    'a take record arriving after the verdict is more evidence, not a new decision');
  assert.strictEqual(record.takes.length, 1, 'and the evidence is still kept');
  ledger.forgetChunkGuards(id);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A shape we do not recognise is a REFUSAL, not a default
// ─────────────────────────────────────────────────────────────────────────────

check('every field of the verdict object is required by name', () => {
  const id = 'render-malformed';
  const cases = [
    ['verdict', { clean: true, parts: 1, band: {}, takes: [] }],
    ['clean', { verdict: 'clean', parts: 1, band: {}, takes: [] }],
    ['parts', { verdict: 'clean', clean: true, band: {}, takes: [] }],
    ['band', { verdict: 'clean', clean: true, parts: 1, takes: [] }],
    ['takes', { verdict: 'clean', clean: true, parts: 1, band: {} }],
  ];
  for (const [missing, guard] of cases) {
    ledger.forgetChunkGuards(id);
    assert.throws(
      () => ledger.recordCrucibleChunkGuard(id, { index: 0, guard }),
      (err) => err.name === 'ChunkGuardShapeError' && err.message.includes(missing),
      `a guard object missing "${missing}" must be refused BY NAME. An earlier draft of `
      + 'PHASE6-REMOTE-RENDER.md invented five plausible field names and every one was '
      + 'wrong; a reader that defaulted a missing field would have reported a clean book.');
  }
  assert.throws(() => ledger.recordCrucibleChunkGuard(id, { index: 0, guard: 'clean' }),
    /neither an object nor null/, 'a bare word is not the verdict object');
  assert.throws(() => ledger.recordCrucibleChunkGuard(id, { index: -1, guard: null }),
    /not a chunk index/);
  assert.throws(() => ledger.recordGuardEvent(id, { action: 'short' }),
    /not a chunk index/, 'a take record addressed to no chunk has nowhere true to be filed');
  ledger.forgetChunkGuards(id);
});

check('a record needs the render it belongs to', () => {
  assert.throws(() => ledger.recordCrucibleChunkGuard('', { index: 0, guard: null }),
    /needs the render it belongs to/,
    'an empty renderId would pool every book\'s chunks into one ledger');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The ledger is per render, and it pops
// ─────────────────────────────────────────────────────────────────────────────

check('two renders do not pool, and takeChunkGuards pops', () => {
  ledger.forgetChunkGuards('book-a');
  ledger.forgetChunkGuards('book-b');
  ledger.recordCrucibleChunkGuard('book-a', { index: 0, guard: verdictObject('clean') });
  ledger.recordCrucibleChunkGuard('book-b', { index: 0, guard: verdictObject('hole') });
  assert.deepStrictEqual(ledger.summarizeChunkGuards('book-a').byVerdict, { clean: 1 });
  assert.deepStrictEqual(ledger.summarizeChunkGuards('book-b').byVerdict, { hole: 1 });
  const popped = ledger.takeChunkGuards('book-a');
  assert.strictEqual(popped.chunks, 1);
  assert.deepStrictEqual(ledger.chunkGuards('book-a'), [],
    'a 1,400-entry map of take records must not outlive the render that made it');
  assert.deepStrictEqual(ledger.summarizeChunkGuards('book-b').byVerdict, { hole: 1 },
    'popping one render must not touch another');
  ledger.forgetChunkGuards('book-b');
});

check('a half-local half-remote render is ONE summary that says so', () => {
  const id = 'render-resumed';
  ledger.forgetChunkGuards(id);
  ledger.recordGuardEvent(id, { index: 0, action: 'short' });
  ledger.recordCrucibleChunkGuard(id, { index: 1, guard: verdictObject('clean') });
  const summary = ledger.takeChunkGuards(id);
  assert.deepStrictEqual([...summary.sources].sort(), ['crucible-chunk', 'narrator-stdout'],
    'a book rendered half on each machine must not be summarised as though one channel '
    + 'spoke for all of it');
  assert.strictEqual(summary.chunks, 2);
  assert.strictEqual(summary.unknown, 1);
  assert.deepStrictEqual(summary.byVerdict, { clean: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The sink is wired to BOTH paths, and the log line is not the only copy
// ─────────────────────────────────────────────────────────────────────────────

check('the ONE render path feeds the ONE sink', () => {
  /*
   * THERE IS ONE RENDER PATH NOW. This check used to pin that the LOCAL path's
   * parsed stdout guard event reached the ledger rather than only the daily log
   * file — a real defect at the time, and a dead letter since: the local worker
   * is deleted (docs/LEGACY-REMOVAL.md) and there is no stdout to parse. A
   * render's guard verdicts arrive as the SERVER's chunk events.
   *
   * What still matters, and is kept: the ledger is still POPPED on both terminal
   * paths, and the remote path still feeds the same sink. A cancelled render
   * that does not pop leaks its take records for the life of the process
   * whatever produced them.
   */
  const bridge = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
  assert.ok(/from '\.\/chunk-guard-ledger'/.test(bridge),
    'the render path must import the ledger');
  assert.ok(!/recordGuardEvent\(/.test(bridge),
    'the bridge records a guard event from parsed WORKER STDOUT again — there is no local '
    + 'worker, so this would be parsing a stream nothing writes');
  assert.ok(/guard: takeChunkGuards\(session\.jobId\)/.test(bridge),
    'the roll-up must reach job-analytics.json, which is the app\'s durable per-render '
    + 'report');
  assert.strictEqual((bridge.match(/takeChunkGuards\(session\.jobId\)/g) || []).length, 2,
    'BOTH terminal paths — completion and cancel — must pop the ledger, or a cancelled '
    + 'render leaks its take records for the life of the process');

  const remote = fs.readFileSync(
    path.join(REPO, 'electron', 'crucible', 'render-artifacts.ts'), 'utf8');
  assert.ok(/recordCrucibleChunkGuard\(renderId, data\)/.test(remote),
    'the remote render path must feed the SAME sink off the chunk event');
  assert.ok(/chaptersDirSentences/.test(remote),
    'the remote downloader must name the app\'s own destination for rendered audio');
  assert.ok(!/\.mkdir(Sync)?\s*\(/.test(remote),
    'it must not create the sentences directory: mkdir on a typo produces an empty '
    + 'directory that reads as a render which produced nothing');
  assert.ok(/does not exist/.test(remote),
    'a missing sentences directory must be refused by name instead');
});

check('the pinned SDK is measured, not assumed, about the guard field', () => {
  // This is the one place the KNOWN GAP is checked against reality rather than
  // taken on trust. `@crucible/client`'s readChunk() builds ChunkData from a
  // fixed field list; if `guard` is not in it the field is discarded inside the
  // SDK and the ledger's `sdk-drops-the-field` is the truthful record. When a
  // release finally carries crucible commit b232e3a this assertion flips, and
  // the flip is the signal that the pin can now speak the verdict — which is
  // exactly when someone should come back and check the remote path reports
  // verdicts instead of unknowns.
  const sdk = require.resolve('@crucible/client');
  const client = fs.readFileSync(path.join(path.dirname(sdk), 'client.js'), 'utf8');
  // 2000, not 600: 1.0.25's readChunk carries more optional fields and outgrew the old window.
  const readChunk = /function readChunk\([\s\S]{0,2000}?\n\}/.exec(client);
  assert.ok(readChunk, 'the SDK must still have a readChunk() to measure');
  const carriesGuard = /guard:/.test(readChunk[0]);
  const ledgerSrc = fs.readFileSync(
    path.join(REPO, 'electron', 'chunk-guard-ledger.ts'), 'utf8');
  assert.ok(/'sdk-drops-the-field'/.test(ledgerSrc),
    'the ledger must be able to name an SDK that cannot see the field');
  console.log(carriesGuard
    ? '        note: the pinned SDK NOW carries `guard` — the remote path can report '
      + 'real verdicts; re-check electron/crucible/render-artifacts.ts'
    : '        note: the pinned SDK drops `guard` in readChunk() (measured) — remote '
      + 'chunks record as sdk-drops-the-field, which is unknown and is not clean');
});

console.log(`\nchunk-guard-ledger: ${passed} check(s) passed`);
