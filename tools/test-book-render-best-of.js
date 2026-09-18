#!/usr/bin/env node
/**
 * A SENTENCE THAT FAILS THREE TIMES KEEPS ITS BEST TAKE, AND THE FAILURE IS
 * RECORDED.
 *
 *   npm run build:electron && node tools/test-book-render-best-of.js
 *
 * Owen, 2026-09-18: *"Let's just use the best version of it if it fails 3
 * times. But that's never happened as far as I can remember. Record what failed
 * and when so we can review later."*
 *
 * Until that ruling the whole-book render answered a thrice-failed sentence with
 * 0.3 s of `silentWav`, set `coverage[i]`, recorded nowhere which sentence it
 * was, and assembled the book as finished — a hole in the audio under a cue that
 * displays the text, in an m4b that says nothing about it. This pins what
 * replaced it:
 *
 *   §1  THE CRITERION, and there is one: the take whose DURATION is closest to
 *       `chars ÷ the voice's pace`, measured in LOG space exactly as narrator
 *       measures it (`python/narrator/engine/higgs/truncation.py`,
 *       `_LadderTask._accept`). A plain difference in seconds is a different
 *       order and picks a different take.
 *   §2  NO SILENCE IS EVER FILED AS A SENTENCE. A sentence with no audio is not
 *       covered, the book is not `done`, and the job fails BY NAME listing it.
 *   §3  THE SERVICE DOES NOT CHOOSE WITHOUT THE MEASUREMENT. The pace belongs to
 *       the machine that will speak (`electron/crucible/voice-band.ts`) and does
 *       not reach this service today — `StreamingEngine.statedChunkCaps` states
 *       maxChars/safeMinChars/safeMaxChars and no rates — so takes that survive
 *       three attempts are refused by name with their durations listed rather
 *       than picked for an unmeasured reason.
 *   §4  `failures.jsonl` beside `state.json`: one line per failed ATTEMPT and
 *       one per settlement, every line valid JSON however many workers wrote it.
 *   §5  The five-consecutive-exhausted-sentences engine abort is unchanged, and
 *       best-of does not mask it.
 *   §6  A `success` carrying no samples is an attempt that produced nothing, not
 *       a rendered sentence.
 *
 * Nothing here starts an engine, spawns ffmpeg or touches a GPU: the engine
 * module's entry points and `spawn` are replaced with recorders, and everything
 * else — the service, the plan, the state file, the append log — is the real
 * code against real files in a temp library. `tools/test-book-render-timeline.js`
 * next door pins the timeline, the lifecycle flags and state.json.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'book-render-service.js'))) {
  console.log('SKIP: dist/electron is not built — run `npm run build:electron`');
  return;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-render-bestof-'));
process.env.BOOKFORGE_USER_DATA = path.join(ROOT, 'userdata');
require('../cli/electron-stub.js');

const manifest = require(path.join(DIST, 'manifest-service.js'));
const streaming = require(path.join(DIST, 'streaming-engine.js'));
const metadata = require(path.join(DIST, 'metadata-tools.js'));
const childProcess = require('child_process');

const LIBRARY = path.join(ROOT, 'library');
manifest.setLibraryBasePath(LIBRARY);

/** The assembly seams: nothing encodes, nothing registers for real. */
const registry = { calls: [] };
manifest.registerAudiobookOutput = async (m4bPath) => { registry.calls.push(m4bPath); };
const embeds = { vtts: [] };
metadata.embedAndVerifyVtt = async (_m4b, vttPath) => {
  embeds.vtts.push(fs.readFileSync(vttPath, 'utf-8'));
  return true;
};
childProcess.spawn = () => {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit('close', 0));
  return proc;
};

/* ── The engine ────────────────────────────────────────────────────────────── */

const SAMPLE_RATE = 22050;
/** `seconds` of audio as the engine hands it over: base64 PCM16, no header. */
function enginePcm(seconds) {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2).toString('base64');
}
/** A chunk the service can file. `duration: 0` is what the Crucible arm sends,
 *  so the service has to measure the bytes — the same path a real render takes. */
function chunk(seconds) {
  return { data: enginePcm(seconds), duration: 0, sampleRate: SAMPLE_RATE };
}

const engine = {
  calls: [],
  /** index → (attemptNumberForThatIndex) => result. */
  script: new Map(),
  attempts: new Map(),
  isSessionActive: () => true,
  startSession: async () => ({ success: true }),
  loadVoice: async () => ({ success: true }),
  getWorkerCount: () => 1,
  getMaxConcurrentSentences: () => 1,
  getAvailableVoices: () => ['test-voice'],
  getDefaultVoice: () => 'test-voice',
  getCurrentVoice: () => 'test-voice',
  async generateSentence(_text, index) {
    engine.calls.push(index);
    const n = (engine.attempts.get(index) || 0) + 1;
    engine.attempts.set(index, n);
    const scripted = engine.script.get(index);
    if (scripted) return scripted(n);
    return { success: true, audio: chunk(1) };
  },
};
streaming.getActiveEngine = () => engine;
streaming.getDefaultStreamVoice = () => 'test-voice';
streaming.getSelectedEngineName = () => 'higgs';

const service = require(path.join(DIST, 'book-render-service.js'));
const { bookRenderService, bestOfTakes, expectedSentenceSeconds } = service;

/* ── Harness ───────────────────────────────────────────────────────────────── */

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

let projectSeq = 0;
function newProject(sentences) {
  const id = `bestof${++projectSeq}`;
  const dir = path.join(LIBRARY, 'projects', id, 'render');
  fs.mkdirSync(path.join(dir, 'sentences'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({
    title: `Book ${id}`, language: 'en',
    blocks: sentences.map((text, i) => ({ id: `b${i}`, text, chapterStart: i === 0 })),
    sentences,
    sentenceBlock: sentences.map((_s, i) => i),
    chapterOf: sentences.map(() => 0),
    chapterTitles: ['One'],
  }));
  return { id, dir };
}
const renderDirOf = (id) => path.join(LIBRARY, 'projects', id, 'render');
const sentenceFileOf = (id, i) => path.join(renderDirOf(id), 'sentences', `${i}.wav`);
/** Every record in failures.jsonl, parsed — and it must all parse. */
function failureLines(id) {
  const file = path.join(renderDirOf(id), 'failures.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((line, n) => {
    try { return JSON.parse(line); }
    catch (err) { throw new Error(`failures.jsonl line ${n + 1} is not JSON (${err.message}): ${line}`); }
  });
}
function resetEngine() { engine.calls = []; engine.script = new Map(); engine.attempts = new Map(); }

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§1 the criterion is one measured thing, and it is narrator\'s');

  await check('the expected length of a sentence is chars ÷ the voice\'s pace', () => {
    assert.strictEqual(typeof expectedSentenceSeconds, 'function',
      'book-render-service exports no expectedSentenceSeconds — the criterion cannot be measured');
    assert.strictEqual(expectedSentenceSeconds(60, 15), 4);
    assert.strictEqual(expectedSentenceSeconds(86, 17.2), 5);
    // No default pace: an unmeasured voice is refused, never averaged.
    assert.throws(() => expectedSentenceSeconds(60, 0), /not a pace/);
    assert.throws(() => expectedSentenceSeconds(60, NaN), /not a pace/);
    assert.throws(() => expectedSentenceSeconds(0, 15), /not a number of characters/);
  });

  await check('the best take is the one closest to the expectation IN LOG SPACE', () => {
    assert.strictEqual(typeof bestOfTakes, 'function',
      'book-render-service exports no bestOfTakes — best-of cannot be measured');
    // Three takes of a sentence whose text should take 4 s.
    const takes = [
      { attempt: 1, seconds: 2.0 },
      { attempt: 2, seconds: 3.8 },
      { attempt: 3, seconds: 8.0 },
    ];
    assert.strictEqual(bestOfTakes(takes, 4).attempt, 2,
      'the take nearest the expected length was not the one filed');

    // THE ORDER IS NOT THE SECONDS-APART ORDER. Against a 4 s expectation a 1 s
    // take is 3 s away and a 9 s take is 5 s away, so a plain difference picks
    // the 1 s one — while narrator (log distance on chars/s) picks the 9 s one,
    // which is 2.25x long where the other is 4x short.
    const lopsided = [{ attempt: 1, seconds: 1.0 }, { attempt: 2, seconds: 9.0 }];
    assert.strictEqual(bestOfTakes(lopsided, 4).attempt, 2,
      'the takes were ordered by seconds apart, not by ratio — that is not narrator\'s accept rule');

    // A tie leaves the earlier attempt standing. Measured on takes of EQUAL
    // length rather than on a half/double pair: `Math.log(8) - Math.log(4)` and
    // `Math.log(4) - Math.log(2)` differ in the last bit, so that pair pins
    // floating point and not the rule.
    assert.strictEqual(bestOfTakes([{ attempt: 1, seconds: 3 }, { attempt: 2, seconds: 3 }], 4).attempt, 1,
      'a tie did not go to the earliest attempt');
    // And the order the takes arrive in does not decide it.
    assert.strictEqual(bestOfTakes([...takes].reverse(), 4).attempt, 2);

    assert.throws(() => bestOfTakes([], 4), /no takes/);
    assert.throws(() => bestOfTakes(takes, 0), /not an expected duration/);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§2 a sentence with no audio is a hole, and the job says so');

  await check('three attempts with no audio: nothing is filed, the book is not done, the job names the sentence',
    async () => {
      resetEngine();
      const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.']);
      engine.script.set(1, () => ({ success: false, error: 'the model is not loaded' }));

      await bookRenderService.start(id, 0);
      await waitFor('the job to give up on sentence 1',
        () => bookRenderService.status(id).error !== undefined);

      const status = bookRenderService.status(id);
      assert.strictEqual(status.done, false, 'the book is done with a sentence missing from it');
      assert.strictEqual(status.coverage[1], false,
        'the sentence the engine could never render is marked covered — that used to be 0.3 s of silence');
      assert.strictEqual(fs.existsSync(sentenceFileOf(id, 1)), false,
        'a file was written for a sentence that produced no audio');
      assert.ok(/sentence 1\b/.test(status.error),
        `the job does not name the sentence with no audio: ${status.error}`);
      assert.ok(status.error.includes('the model is not loaded'),
        `the job does not quote what the engine said: ${status.error}`);
      assert.strictEqual(registry.calls.some((p) => p.includes(id)), false,
        'a book with a hole in it was registered as an audiobook');

      const lines = failureLines(id);
      const attempts = lines.filter((l) => l.sentence === 1 && l.attempt !== undefined);
      assert.strictEqual(attempts.length, 3,
        `failures.jsonl records ${attempts.length} attempts at sentence 1, not 3: ${JSON.stringify(lines)}`);
      assert.deepStrictEqual(attempts.map((l) => l.attempt), [1, 2, 3]);
      for (const line of attempts) {
        assert.strictEqual(line.kind, 'error', `an engine refusal was recorded as ${line.kind}`);
        assert.strictEqual(line.error, 'the model is not loaded',
          'the engine\'s own message is not in the record');
        assert.ok(/^\d{4}-\d\d-\d\dT/.test(line.at), `"${line.at}" is not an ISO instant`);
      }
      const settled = lines.filter((l) => l.sentence === 1 && l.settled !== undefined);
      assert.deepStrictEqual(settled.map((l) => l.settled), ['no-audio'],
        'the settlement of a sentence with no audio was not recorded');
      assert.strictEqual(settled[0].candidates, 0);
    });

  await check('the render report points at the record', async () => {
    resetEngine();
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    engine.script.set(2, () => ({ success: false, error: 'nope' }));
    await bookRenderService.start(id, 0);
    await waitFor('the job to give up', () => bookRenderService.status(id).error !== undefined);

    const status = bookRenderService.status(id);
    assert.strictEqual(status.failuresPath, path.join(renderDirOf(id), 'failures.jsonl'),
      'the render report does not say where the failures are recorded');
    assert.strictEqual(status.failures, failureLines(id).length,
      `the report counts ${status.failures} failures and the file holds ${failureLines(id).length}`);
    assert.ok(status.error.includes(status.failuresPath),
      'the job\'s error does not point at the record a reviewer needs');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§3 takes with no expected length are refused, not guessed at');

  await check('three failed attempts that DID produce audio are refused by name, with their durations',
    async () => {
      resetEngine();
      const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.']);
      // A failure that still handed over a chunk — the contract permits it
      // (`{success, audio}` are independent), and it is the only thing best-of
      // can be made of. Two takes of known, different lengths.
      const takes = [chunk(0.5), chunk(2.5), null];
      engine.script.set(1, (n) => ({
        success: false, error: `take ${n} was rejected`, audio: takes[n - 1] || undefined,
      }));

      await bookRenderService.start(id, 0);
      await waitFor('the job to refuse to choose',
        () => bookRenderService.status(id).error !== undefined);

      const status = bookRenderService.status(id);
      assert.strictEqual(status.coverage[1], false, 'a take was filed with nothing to judge it by');
      assert.strictEqual(fs.existsSync(sentenceFileOf(id, 1)), false,
        'a take was written for a sentence the service could not measure');
      assert.ok(/sentence 1\b/.test(status.error),
        `the refusal does not name the sentence: ${status.error}`);
      assert.ok(/pace/.test(status.error),
        `the refusal does not name the fact that is missing: ${status.error}`);
      assert.ok(/statedChunkCaps/.test(status.error),
        `the refusal does not name where the pace would have to come from: ${status.error}`);
      assert.ok(/0\.500 s/.test(status.error) && /2\.500 s/.test(status.error),
        `the refusal does not list the takes it would not choose between: ${status.error}`);

      const lines = failureLines(id);
      assert.strictEqual(lines.filter((l) => l.sentence === 1 && l.attempt !== undefined).length, 3,
        'the three attempts were not all recorded');
      const settled = lines.filter((l) => l.sentence === 1 && l.settled !== undefined);
      assert.deepStrictEqual(settled.map((l) => l.settled), ['no-expected-length']);
      assert.strictEqual(settled[0].candidates, 2,
        'the record does not say how many takes were on the table');
      // The attempt that produced nothing is recorded as producing nothing.
      const kinds = lines.filter((l) => l.sentence === 1 && l.attempt !== undefined).map((l) => l.kind);
      assert.deepStrictEqual(kinds, ['error', 'error', 'error']);
    });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§4 a success with no samples in it is not a rendered sentence');

  await check('an empty chunk is a failed attempt, not a 44-byte file', async () => {
    resetEngine();
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    engine.script.set(1, () => ({ success: true, audio: { data: '', duration: 0, sampleRate: SAMPLE_RATE } }));

    await bookRenderService.start(id, 0);
    await waitFor('the job to give up on the empty sentence',
      () => bookRenderService.status(id).error !== undefined);

    assert.strictEqual(bookRenderService.status(id).coverage[1], false,
      'a chunk with no samples in it was filed as a rendered sentence');
    assert.strictEqual(fs.existsSync(sentenceFileOf(id, 1)), false,
      'a header with no audio behind it was written as a sentence');
    const kinds = failureLines(id).filter((l) => l.sentence === 1 && l.attempt !== undefined).map((l) => l.kind);
    assert.deepStrictEqual(kinds, ['empty', 'empty', 'empty'],
      'a success carrying nothing was recorded as something else');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§5 the broken-engine abort is unchanged');

  await check('five sentences in a row that use up every attempt are a broken ENGINE', async () => {
    resetEngine();
    const { id } = newProject(['0.', '1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.']);
    // Sentence 0 renders; everything after it throws, so the guard counts whole
    // exhausted sentences and reaches five without best-of hiding any of them.
    for (let i = 1; i < 10; i++) {
      engine.script.set(i, () => { throw new Error('the crucible session is gone'); });
    }

    await bookRenderService.start(id, 0);
    try {
      await waitFor('the job to conclude the engine is broken',
        () => bookRenderService.status(id).error !== undefined, 30000);
    } finally { bookRenderService.stop(id); }

    const status = bookRenderService.status(id);
    assert.ok(status.error.includes('failing repeatedly'),
      `the engine guard did not fire — the job stopped for another reason: ${status.error}`);
    assert.ok(status.error.includes('5 sentences in a row'),
      `the abort does not say how many sentences it counted: ${status.error}`);
    assert.ok(status.error.includes('the crucible session is gone'),
      `the abort does not quote what failed: ${status.error}`);
    const threw = failureLines(id).filter((l) => l.kind === 'threw');
    assert.strictEqual(threw.length, 15,
      `a throw is a failed attempt like any other: 5 sentences x 3 attempts should be recorded, got ${threw.length}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§6 no silence pad exists to be written');

  await check('the service has no silence placeholder left in it', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'book-render-service.ts'), 'utf-8');
    assert.ok(!/private silentWav\(/.test(src),
      'the silence pad is still here — a sentence the engine could not render still becomes a hole '
      + 'the book is assembled around');
    assert.ok(!/AWAITING A RULING/.test(src),
      'the placeholder policy still calls itself unruled; Owen ruled on 2026-09-18');
    assert.ok(/appendFile\(failuresPath/.test(src),
      'failures.jsonl is not appended through one place');
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nA thrice-failed sentence keeps its best take, or the book does not ship.');
}

void main();
