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
 *       the machine that will speak (`electron/crucible/voice-band.ts`), and an
 *       engine that states none — one with no `statedChunkCaps` at all — leaves
 *       takes that survive three attempts refused by name with their durations
 *       listed rather than picked for an unmeasured reason.
 *   §4  `failures.jsonl` beside `state.json`: one line per failed ATTEMPT and
 *       one per settlement, every line valid JSON however many workers wrote it.
 *   §5  The five-consecutive-exhausted-sentences engine abort is unchanged, and
 *       best-of does not mask it.
 *   §6  A `success` carrying no samples is an attempt that produced nothing, not
 *       a rendered sentence.
 *   §7  THE PACE REACHES THE SERVICE. `statedChunkCaps` carries the three rates
 *       the venue's `GET /v1/voices` row states, so a stated pace makes
 *       `chars ÷ pace` and a thrice-failed sentence with takes CHOOSES: the
 *       log-space-closest take is filed, the sentence is covered, and
 *       `failures.jsonl` holds its three attempts and one `best-of` settlement.
 *       AND IT IS ASKED ONCE FOR THE RUN. Every settlement asked the engine
 *       again, and behind that member is the venue decision and a
 *       `GET /v1/voices`; the answer is kept per (run, voice) instead.
 *   §8  A VOICE THAT STATES NO PACE IS STILL REFUSED. Nothing on this side
 *       invents narrator's default band centre: Crucible publishes it on no
 *       route (`/v1/voices` carries each voice's own measured rates and nothing
 *       else; `/v1/info` carries no band at all), so the one honest answer is a
 *       refusal that says so.
 *   §9  THE CRUCIBLE ENGINE CARRIES THE ROW'S RATES VERBATIM, all three or none,
 *       and refuses a partial triple by name.
 *
 * Nothing here starts an engine, spawns ffmpeg or touches a GPU: the engine
 * module's entry points and `spawn` are replaced with recorders, and everything
 * else — the service, the plan, the state file, the append log — is the real
 * code against real files in a temp library. `tools/test-book-render-timeline.js`
 * next door pins the timeline, the lifecycle flags and state.json.
 */
'use strict';
const assert = require('assert');
const { skipLine } = require('./keeper-skip.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'book-render-service.js'))) {
  console.log(skipLine('dist/electron is not built — run `npm run build:electron`'));
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
/**
 * A fresh engine — and one that states NOTHING about a voice's numbers.
 *
 * `statedChunkCaps` is DELETED rather than set to a stub that answers null,
 * because "the engine has no such member" and "the engine has one and it
 * answered" are two different facts about the service and it must refuse for
 * both. A test that wants a stated band assigns the member itself.
 */
function resetEngine() {
  engine.calls = []; engine.script = new Map(); engine.attempts = new Map();
  delete engine.statedChunkCaps;
}

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

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§7 a voice that STATES a pace makes the service choose');

  /** The band a Crucible states, as `statedChunkCaps` hands it over. */
  function statedBand(paceCharsPerSec) {
    return {
      maxChars: 600, safeMinChars: 200, safeMaxChars: 500,
      paceCharsPerSec, maxCharsPerSec: 20.0, minCharsPerSec: 14.5,
    };
  }

  await check('three failed attempts with two takes: the log-space-closest take is filed',
    async () => {
      resetEngine();
      // 40 characters at 16 chars/s is 2.5 s expected. The takes are 1.0 s and
      // 5.0 s: in LOG space the 5.0 s one is closer (0.693 against 0.916), and
      // in plain seconds apart the 1.0 s one would be (1.5 against 2.5). So the
      // take that is filed says which arithmetic ran — narrator's, or a guess.
      const text = 'Forty characters exactly, this sentence.';
      assert.strictEqual(text.length, 40, 'the fixture sentence is no longer 40 characters');
      assert.strictEqual(expectedSentenceSeconds(text.length, 16), 2.5);

      const asked = [];
      engine.statedChunkCaps = async (voice) => { asked.push(voice); return statedBand(16); };
      const { id } = newProject(['One.', text, 'Three.', 'Four.']);
      const takes = [chunk(1.0), chunk(5.0), null];
      engine.script.set(1, (n) => ({
        success: false, error: `take ${n} was rejected`, audio: takes[n - 1] || undefined,
      }));

      await bookRenderService.start(id, 0);
      await waitFor('the book to finish with its best take in it',
        () => bookRenderService.status(id).done || bookRenderService.status(id).error !== undefined);

      const status = bookRenderService.status(id);
      assert.strictEqual(status.error, undefined,
        `the sentence was refused although the voice states a pace: ${status.error}`);
      assert.strictEqual(status.coverage[1], true,
        'the best take was not filed — the sentence is still a hole');
      // Read off state.json rather than the sentence file: the book assembled,
      // and assembly reclaims the raw WAVs (`the m4b is the durable artifact
      // now`). This is the service's own record of the length it filed.
      const filed = JSON.parse(fs.readFileSync(path.join(renderDirOf(id), 'state.json'), 'utf-8'))
        .durations[1];
      assert.ok(Math.abs(filed - 5.0) < 0.01,
        `attempt 2's 5.000 s take is the one nearest 2.5 s in log space; the sentence was filed at `
        + `${filed} s — that is the seconds-apart order, not narrator's`);
      assert.ok(registry.calls.some((p) => p.includes(id)),
        'the book did not ship although every sentence has audio');
      assert.deepStrictEqual([...new Set(asked)], ['test-voice'],
        `the service asked the engine about ${JSON.stringify(asked)}, not the voice it is rendering in`);

      const lines = failureLines(id);
      const attempts = lines.filter((l) => l.sentence === 1 && l.attempt !== undefined);
      assert.deepStrictEqual(attempts.map((l) => l.attempt), [1, 2, 3],
        'the three attempts are not all recorded — best-of does not excuse the record');
      const settled = lines.filter((l) => l.sentence === 1 && l.settled !== undefined);
      assert.deepStrictEqual(settled.map((l) => l.settled), ['best-of'],
        `the settlement was recorded as ${JSON.stringify(settled.map((l) => l.settled))}`);
      assert.strictEqual(settled[0].chosenAttempt, 2,
        'the record does not name the attempt that was chosen');
      assert.strictEqual(settled[0].candidates, 2);
      assert.ok(/2\.500 s/.test(settled[0].reason),
        `the record does not say what length it measured against: ${settled[0].reason}`);
    });

  await check('the voice\'s pace is asked ONCE for a run, however many sentences settle', async () => {
    resetEngine();
    // A settlement is the only caller, and it asked the engine again for every
    // one of them. Behind `statedChunkCaps` sits the venue decision — a cold
    // backend re-takes it, pings and all — and behind that a `GET /v1/voices`;
    // the pace of a voice does not change while it is being rendered in, so the
    // run holds the one it was told. It is keyed BY VOICE, because a mid-render
    // switch applies to later sentences and the pace has to be the speaking
    // voice's (`worker` re-reads the voice per iteration).
    const asked = [];
    engine.statedChunkCaps = async (voice) => { asked.push(voice); return statedBand(16); };
    const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.']);
    for (const i of [1, 2]) {
      engine.script.set(i, (n) => ({ success: false, error: `take ${n} was rejected`, audio: chunk(n) }));
    }

    await bookRenderService.start(id, 0);
    await waitFor('both sentences to settle',
      () => bookRenderService.status(id).done || bookRenderService.status(id).error !== undefined);

    const status = bookRenderService.status(id);
    assert.strictEqual(status.error, undefined, `the run failed: ${status.error}`);
    assert.strictEqual(status.coverage[1] && status.coverage[2], true,
      'both settled sentences should have a take filed');
    assert.deepStrictEqual(asked, ['test-voice'],
      `the pace was asked ${asked.length} time(s) — once per settlement, not once per run`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§8 a voice that states NO pace is refused, and nothing is invented');

  await check('an engine whose band states no rates refuses by name and files nothing', async () => {
    resetEngine();
    // All three rates null — narrator's own "reads all three or none"
    // (`truncation.py`, `_pace_tracker_for`). narrator answers that case from
    // `HiggsV3Defaults`; nothing on the wire carries those numbers, so this side
    // refuses instead of copying them.
    engine.statedChunkCaps = async () => ({
      maxChars: 600, safeMinChars: null, safeMaxChars: 600,
      paceCharsPerSec: null, maxCharsPerSec: null, minCharsPerSec: null,
    });
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    engine.script.set(1, (n) => ({ success: false, error: `take ${n} was rejected`, audio: chunk(n) }));

    await bookRenderService.start(id, 0);
    await waitFor('the job to refuse to choose',
      () => bookRenderService.status(id).error !== undefined);

    const status = bookRenderService.status(id);
    assert.strictEqual(status.coverage[1], false, 'a take was filed for a voice with no stated pace');
    assert.ok(/states no pace/.test(status.error),
      `the refusal does not say the voice states no pace: ${status.error}`);
    assert.ok(/HiggsV3Defaults/.test(status.error),
      `the refusal does not say whose the missing centre is: ${status.error}`);
    const settled = failureLines(id).filter((l) => l.sentence === 1 && l.settled !== undefined);
    assert.deepStrictEqual(settled.map((l) => l.settled), ['no-expected-length']);
  });

  await check('the service copies no pace constant of its own', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'book-render-service.ts'), 'utf-8');
    // narrator's default edges are 20.0 and 14.5 and their geometric mean is
    // 17.03. A literal here would be a second owner of a number measured in
    // `python/narrator/engine/higgs/v3_engine.py` — the exact shape
    // `electron/crucible/voice-band.ts` exists to end.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.ok(!/\b(17\.0\d|20\.0|14\.5)\b/.test(code),
      'the render service has grown a pace constant of its own; the pace belongs to the machine '
      + 'that will speak and arrives through statedChunkCaps');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§9 the Crucible engine carries the row\'s rates verbatim');

  /** A `GET /v1/voices` row as the SDK parses one, captured from a real server. */
  function voiceRow(pace) {
    return {
      id: 'deathstalker', display: 'Deathstalker', kind: 'checkpoint', language: 'en',
      loadable: true, needsReference: false, backendSupported: true, maxChars: 600,
      pace,
    };
  }
  /** The engine with a venue already bound — `startSession`'s two fields, set
   *  directly because opening a session needs a server and this needs a row. */
  function boundEngine(rows) {
    const streamMod = require(path.join(DIST, 'crucible', 'stream.js'));
    const engineUnderTest = new streamMod.CrucibleStreamingEngine({
      selectedEngine: () => 'higgs',
      clientFor: () => { throw new Error('the keeper binds the client itself'); },
    });
    engineUnderTest.server = 'fake1';
    engineUnderTest.client = { voices: async () => rows };
    return engineUnderTest;
  }

  await check('the three rates arrive exactly as the row stated them', async () => {
    const stated = await boundEngine([voiceRow({
      paceCharsPerSec: 17.2, maxCharsPerSec: 20.0, minCharsPerSec: 14.5,
      targetChars: null, safeMinChars: 200, safeMaxChars: 500,
    })]).statedChunkCaps('deathstalker');
    assert.strictEqual(stated.maxChars, 600);
    assert.strictEqual(stated.safeMinChars, 200);
    assert.strictEqual(stated.safeMaxChars, 500);
    assert.strictEqual(stated.paceCharsPerSec, 17.2,
      'the pace the server stated did not come out of statedChunkCaps — this is the gap that made '
      + 'a thrice-failed sentence refuse instead of choose');
    assert.strictEqual(stated.maxCharsPerSec, 20.0);
    assert.strictEqual(stated.minCharsPerSec, 14.5);
  });

  await check('a PARTIAL triple is refused by name, never carried as two rates and a null',
    async () => {
      const engineUnderTest = boundEngine([voiceRow({
        paceCharsPerSec: 17.2, maxCharsPerSec: 20.0, minCharsPerSec: undefined,
        targetChars: null, safeMinChars: 200, safeMaxChars: 500,
      })]);
      await assert.rejects(
        () => engineUnderTest.statedChunkCaps('deathstalker'),
        (err) => {
          assert.ok(/min_chars_per_sec|minCharsPerSec/.test(err.message),
            `the refusal does not name the rate that is missing: ${err.message}`);
          assert.ok(/deathstalker/.test(err.message),
            `the refusal does not name the voice: ${err.message}`);
          return true;
        },
        'a row stating two of the three rates was accepted; a band is all three or none '
        + '(narrator reads them that way too — truncation.py, _pace_tracker_for)');
    });

  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nA thrice-failed sentence keeps its best take, or the book does not ship.');
}

void main();
