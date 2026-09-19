#!/usr/bin/env node
/**
 * THE WHOLE-BOOK RENDER'S TIMELINE, ITS LIFECYCLE FLAGS AND ITS STATE FILE.
 *
 *   npm run build:electron && node tools/test-book-render-timeline.js
 *
 * `test-book-render-wav.js` next door pins what one sentence FILE is. This pins
 * the facts the service keeps ABOUT those files — and the plan they answer to —
 * each of which was wrong in a way nothing threw on (B4, 2026-09-18):
 *
 *   §1  A cue time is a valid WebVTT timestamp. `ms` was rounded out of the
 *       fraction alone, so any time at or past x.9995 produced a FOUR-digit
 *       millisecond field — `00:00:12.1000` — and the second it should have
 *       carried never arrived. Two timestamps per sentence, ~1 in 1000.
 *   §2  A sentence reconciled from disk after a crash brings its DURATION with
 *       it. `loadOrBuild` set `coverage[i]` for any file it found and left
 *       `durations[i]` at 0, which the VTT and the chapter marks read as 0.3 s —
 *       so every cue after the first reconciled sentence slid, cumulatively.
 *   §3  `done` is written after the book is REGISTERED, and an assembly failure
 *       says so. It used to be written (and persisted) before the register call,
 *       so a manifest write that threw left an m4b that no page listed and no
 *       run could produce again; and an ffmpeg failure set no `job.error` at
 *       all, which the poller reads as 100% and nothing to say.
 *   §4  Stop-then-Start inside one sentence's render time does not stall the
 *       book. `running` was one boolean shared by every generation of the loop,
 *       so the OLD loop's `finally` cleared the flag the NEW loop was running on.
 *   §5  The failure guard counts a THROW, quotes what failed, and does not add
 *       two bad sentences together into "the engine is failing repeatedly".
 *   §6  A re-finalize that changes the text takes the old audio with it, and one
 *       that changes nothing keeps it.
 *   §7  `state.json` is written through the library's ONE atomic writer, one
 *       write at a time.
 *   §8  Every block the plan DISPLAYS has a sentence that speaks it. The
 *       segmenter dropped any fragment of ≤3 characters not starting with an
 *       ASCII capital, while `saveRenderPlan` had already pushed the block — so
 *       `iv.` was shown, counted, and pointed at by nothing.
 *   §9  A cue is as long as the SAMPLES. The duration was read off the engine's
 *       stated `duration` first and the bytes only when that was 0 — two owners
 *       of one fact, and the m4b is built from the bytes. And with the silence
 *       pad gone, a covered sentence with no duration is a sentence nothing
 *       measured: `|| 0.3` timed it at a number nobody had, and slid every cue
 *       and chapter mark after it for the rest of the book.
 *   §10 The two failures the render can only meet at the engine say what they
 *       are. `renderFirst`'s catch was empty, so a torn-down session first
 *       showed itself as a first sentence that took the long way round; and a
 *       fast-start engine's `{success:true, streamed:true}` with no audio — a
 *       sentence delivered in sub-sentence chunks this service cannot file —
 *       was recorded as "the engine gave no reason".
 *   §11 The status the reader polls has ONE declared shape
 *       (`shared/audio/render-status.ts`). It was an inline return type in the
 *       service, `res.json(...)` on the route and `any` in the browser.
 *
 * Nothing here starts an engine, spawns ffmpeg or touches a GPU: the engine
 * module's three entry points and `spawn` are replaced with recorders, and
 * everything else — the service, the plan, the state file, the atomic write — is
 * the real code against real files in a temp library.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-render-timeline-'));
process.env.BOOKFORGE_USER_DATA = path.join(ROOT, 'userdata');
// The service reaches the engine registry and the library, both of which
// statically require 'electron'; the CLI's own shim answers it.
require('../cli/electron-stub.js');

/* ── The seams, patched on the REAL modules ────────────────────────────────
 *
 * Each of these is a property read at call time in the compiled service
 * (`(0, streaming_engine_1.getActiveEngine)()`), so replacing it on the loaded
 * module object substitutes exactly one function and leaves every other module
 * — manifest-service, pcm16-wav, metadata-tools — real.
 */
const manifest = require(path.join(DIST, 'manifest-service.js'));
const streaming = require(path.join(DIST, 'streaming-engine.js'));
const metadata = require(path.join(DIST, 'metadata-tools.js'));
const childProcess = require('child_process');

const LIBRARY = path.join(ROOT, 'library');
manifest.setLibraryBasePath(LIBRARY);

/** Every state.json write, and how many were in flight at once. */
const persists = { paths: [], inFlight: 0, maxInFlight: 0 };
const realAtomicWriteFile = manifest.atomicWriteFile;
manifest.atomicWriteFile = async (target, content) => {
  persists.paths.push(target);
  persists.inFlight++;
  persists.maxInFlight = Math.max(persists.maxInFlight, persists.inFlight);
  try { return await realAtomicWriteFile(target, content); }
  finally { persists.inFlight--; }
};

/** What `registerAudiobookOutput` did, and whether it was allowed to succeed. */
const registry = { calls: [], throws: null };
manifest.registerAudiobookOutput = async (m4bPath) => {
  registry.calls.push(m4bPath);
  if (registry.throws) throw new Error(registry.throws);
};

/** The transcript as it was handed to the embedder, before it is discarded. */
const embeds = { vtts: [] };
metadata.embedAndVerifyVtt = async (_m4b, vttPath) => {
  embeds.vtts.push(fs.readFileSync(vttPath, 'utf-8'));
  return true;
};

/** ffmpeg: no encode, a controllable exit code and stderr. */
const ffmpeg = { runs: [], exitCode: 0, stderr: '' };
childProcess.spawn = (command, args) => {
  ffmpeg.runs.push({ command, args });
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (ffmpeg.stderr) proc.stderr.emit('data', Buffer.from(ffmpeg.stderr));
    proc.emit('close', ffmpeg.exitCode);
  });
  return proc;
};

/* ── The engine ────────────────────────────────────────────────────────────── */

const SAMPLE_RATE = 22050;
/** `seconds` of silence as the engine hands it over: base64 PCM16, no header. */
function enginePcm(seconds) {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2).toString('base64');
}

const engine = {
  /** index → seconds, or 'fail' / 'throw' / a held promise. */
  script: new Map(),
  calls: [],
  defaultSeconds: 1,
  isSessionActive: () => true,
  startSession: async () => ({ success: true }),
  loadVoice: async () => ({ success: true }),
  getWorkerCount: () => 1,
  getMaxConcurrentSentences: () => 1,
  getAvailableVoices: () => ['test-voice'],
  getDefaultVoice: () => 'test-voice',
  inFlight: 0,
  maxInFlight: 0,
  async generateSentence(_text, index) {
    engine.calls.push(index);
    engine.inFlight++;
    engine.maxInFlight = Math.max(engine.maxInFlight, engine.inFlight);
    try { return await engine.generate(index); } finally { engine.inFlight--; }
  },
  async generate(index) {
    const scripted = engine.script.get(index);
    if (scripted && scripted.hold) await scripted.hold;
    if (scripted && scripted.throw) throw new Error(scripted.throw);
    if (scripted && scripted.fail) return { success: false, error: scripted.fail };
    const seconds = scripted && typeof scripted.seconds === 'number' ? scripted.seconds : engine.defaultSeconds;
    return { success: true, audio: { data: enginePcm(seconds), duration: 0, sampleRate: SAMPLE_RATE } };
  },
};
streaming.getActiveEngine = () => engine;
streaming.getDefaultStreamVoice = () => 'test-voice';
streaming.getSelectedEngineName = () => 'higgs';

/** The scripted generator, kept so a check that replaces it can put it back. */
const scriptedGenerateSentence = engine.generateSentence;

const service = require(path.join(DIST, 'book-render-service.js'));
const { bookRenderService, saveRenderPlan, vttTimestamp } = service;
const { pcm16Wav } = require(path.join(DIST, 'pcm16-wav.js'));

/* ── Harness ───────────────────────────────────────────────────────────────── */

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

let projectSeq = 0;
/** A project with a written plan.json, and nothing else. */
function newProject(sentences, chapterOf) {
  const id = `book${++projectSeq}`;
  const dir = path.join(LIBRARY, 'projects', id, 'render');
  fs.mkdirSync(path.join(dir, 'sentences'), { recursive: true });
  const plan = {
    title: `Book ${id}`, language: 'en',
    blocks: sentences.map((text, i) => ({ id: `b${i}`, text, chapterStart: i === 0 })),
    sentences,
    sentenceBlock: sentences.map((_s, i) => i),
    chapterOf: chapterOf || sentences.map(() => 0),
    chapterTitles: ['One'],
  };
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  return { id, dir };
}
const renderDirOf = (id) => path.join(LIBRARY, 'projects', id, 'render');
const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(renderDirOf(id), 'state.json'), 'utf-8'));

function resetEngine() {
  engine.script = new Map();
  engine.calls = [];
  engine.defaultSeconds = 1;
  engine.inFlight = 0;
  engine.maxInFlight = 0;
}
function resetSeams() {
  registry.calls = []; registry.throws = null;
  embeds.vtts = [];
  ffmpeg.runs = []; ffmpeg.exitCode = 0; ffmpeg.stderr = '';
  persists.paths = []; persists.maxInFlight = 0;
}

/** Every `hh:mm:ss.mmm` in a VTT body. */
function timestampsIn(vtt) {
  return vtt.split('\n').filter((l) => l.includes('-->')).flatMap((l) => l.split('-->').map((s) => s.trim()));
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§1 a cue time is a WebVTT timestamp');

  await check('a fraction at or past .9995 carries into the second, never into a 4th digit', () => {
    assert.strictEqual(typeof vttTimestamp, 'function',
      'book-render-service exports no vttTimestamp — the cue formatter cannot be measured');
    // The three B4 measured: each produced 00:00:SS.1000, an invalid field AND
    // the wrong second.
    assert.strictEqual(vttTimestamp(12.9996), '00:00:13.000');
    assert.strictEqual(vttTimestamp(5.9999), '00:00:06.000');
    assert.strictEqual(vttTimestamp(59.9997), '00:01:00.000');
    assert.strictEqual(vttTimestamp(3599.9999), '01:00:00.000');
    // And the ordinary cases are unchanged.
    assert.strictEqual(vttTimestamp(0), '00:00:00.000');
    assert.strictEqual(vttTimestamp(1.5), '00:00:01.500');
    assert.strictEqual(vttTimestamp(3661.25), '01:01:01.250');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§2 a sentence reconciled from disk brings its duration with it');

  await check('a crash-resumed render times its cues from the FILES, not from 0.3 s', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    // The crash: all three sentences are on disk (4 s, 2 s, 3 s) but state.json
    // was last persisted when only the first had been recorded.
    for (const [i, seconds] of [[0, 4], [1, 2], [2, 3]]) {
      fs.writeFileSync(path.join(renderDirOf(id), 'sentences', `${i}.wav`),
        pcm16Wav(Buffer.alloc(seconds * SAMPLE_RATE * 2), SAMPLE_RATE));
    }
    fs.writeFileSync(path.join(renderDirOf(id), 'state.json'), JSON.stringify({
      coverage: [true, false, false], durations: [4, 0, 0], playhead: 0,
      done: false, voice: 'test-voice', engine: 'higgs', sampleRate: SAMPLE_RATE, updatedAt: Date.now(),
    }));

    await bookRenderService.start(id, 0);
    await waitFor('the resumed book to assemble', () => embeds.vtts.length === 1);
    assert.strictEqual(engine.calls.length, 0, 'a sentence already on disk was rendered again');

    const cues = timestampsIn(embeds.vtts[0]);
    // 0-4 s, 4-6 s, 6-9 s. With the durations unrestored the second and third
    // cues were 0.3 s long and every later one slid by 1.7 s and then 2.7 s.
    assert.deepStrictEqual(cues, [
      '00:00:00.000', '00:00:04.000',
      '00:00:04.000', '00:00:06.000',
      '00:00:06.000', '00:00:09.000',
    ], 'the transcript slid: the reconciled sentences were timed as 0.3 s');
    for (const stamp of cues) {
      assert.ok(/^\d\d:\d\d:\d\d\.\d{3}$/.test(stamp), `${stamp} is not a WebVTT timestamp`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§3 done is the LAST thing written, and a failure says so');

  await check('a manifest write that throws leaves the book NOT done, and re-runnable', async () => {
    resetEngine(); resetSeams();
    registry.throws = 'the manifest is locked by another window';
    const { id } = newProject(['One.', 'Two.']);

    await bookRenderService.start(id, 0);
    await waitFor('the assembly to be attempted', () => registry.calls.length === 1);
    await waitFor('the job to settle', () => bookRenderService.status(id).assembling === false);

    const status = bookRenderService.status(id);
    assert.strictEqual(status.done, false,
      'the book is marked done although it was never registered — nothing lists the m4b and no run can make it again');
    assert.ok(status.error && status.error.includes('the manifest is locked'),
      `the poller was told nothing about the failure (error: ${String(status.error)})`);
    assert.strictEqual(stateOf(id).done, false, 'state.json on disk says done');
    assert.ok(fs.existsSync(path.join(renderDirOf(id), 'sentences', '0.wav')),
      'the sentence WAVs were reclaimed even though the book was never registered');
  });

  await check('an ffmpeg failure sets an error the poller can read', async () => {
    resetEngine(); resetSeams();
    ffmpeg.exitCode = 1;
    ffmpeg.stderr = 'Invalid data found when processing input';
    const { id } = newProject(['One.', 'Two.']);

    await bookRenderService.start(id, 0);
    await waitFor('the job to settle', () => {
      const s = bookRenderService.status(id);
      return s.rendered === 2 && s.assembling === false;
    });
    const status = bookRenderService.status(id);
    assert.ok(status.error,
      'rendered === total, done false, assembling false and no error: a progress bar stopped at 100% with nothing to say');
    assert.ok(status.error.includes('Invalid data found'),
      `the error does not quote what ffmpeg said: ${status.error}`);
    assert.strictEqual(status.done, false);
  });

  await check('a clean assembly registers the book and only then marks it done', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    await bookRenderService.start(id, 0);
    await waitFor('the book to finish', () => bookRenderService.status(id).done === true);
    assert.strictEqual(registry.calls.length, 1, 'the book was not registered');
    assert.strictEqual(stateOf(id).done, true);
    assert.ok(stateOf(id).m4bPath.endsWith('.m4b'));
    assert.strictEqual(fs.existsSync(path.join(renderDirOf(id), 'sentences')), false,
      'the sentence WAVs were not reclaimed after a successful register');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§4 Stop-then-Start inside one sentence does not stall the book');

  await check('the old loop\'s exit cannot clear the new loop\'s running flag', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
    // Sentence 1 holds the OLD loop's worker; sentence 2 holds the NEW one, so
    // the order the defect needs is forced rather than raced for.
    let releaseOld; let releaseNew;
    engine.script.set(1, { hold: new Promise((r) => { releaseOld = r; }) });
    engine.script.set(2, { hold: new Promise((r) => { releaseNew = r; }) });

    await bookRenderService.start(id, 0);
    await waitFor('the first loop\'s worker to be inside a generation', () => engine.calls.includes(1));

    // The window: Stop leaves that worker awaiting, Start launches a second loop.
    bookRenderService.stop(id);
    await bookRenderService.start(id, 0);
    await waitFor('the second loop\'s worker to be inside a generation', () => engine.calls.includes(2));

    // Now the FIRST loop's worker comes back, with the second loop still live.
    // A generation that has been replaced may finish the sentence it is holding
    // — nothing can un-await that — but it may not take another one.
    releaseOld();
    await waitFor('the first loop\'s sentence to land', () => bookRenderService.status(id).coverage[1] === true);
    await sleep(250); // long enough for a worker that is still alive to take another sentence

    assert.deepStrictEqual([...new Set(engine.calls)].sort(), [0, 1, 2],
      'the loop the user stopped went on taking sentences beside the one that replaced it — '
      + `2 × width in flight against an engine told 1 (started: ${[...new Set(engine.calls)].join(', ')})`);
    assert.strictEqual(engine.inFlight, 1,
      `${engine.inFlight} sentences are in flight while only the new loop's worker should be`);

    releaseNew();
    await waitFor('the restarted render to finish the book',
      () => bookRenderService.status(id).rendered === 6);
    assert.strictEqual(bookRenderService.status(id).error, undefined,
      'the restarted render reported an error');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§5 the failure guard');

  await check('two bad sentences are two bad sentences, not a broken engine', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
    // Sentence 1 fails all three of its attempts and has no audio to keep;
    // sentence 2 then fails twice and succeeds. The counter used to carry the
    // first sentence's three attempts into the second's two, reach five, and
    // abort the book as a broken engine — two bad sentences and an engine that
    // rendered four. The job still fails, because a sentence with no audio is a
    // hole (Owen's ruling of 2026-09-18, pinned in test-book-render-best-of.js),
    // but it fails FOR THE SENTENCE and not for the engine, which is the fact
    // this check has always been about.
    let oneFails = 3;
    let twoFails = 2;
    engine.generateSentence = async (_text, index) => {
      engine.calls.push(index);
      if (index === 1 && oneFails-- > 0) return { success: false, error: 'sentence 1 is bad' };
      if (index === 2 && twoFails-- > 0) return { success: false, error: 'sentence 2 is bad' };
      return { success: true, audio: { data: enginePcm(1), duration: 0, sampleRate: SAMPLE_RATE } };
    };

    await bookRenderService.start(id, 0);
    await waitFor('the job to settle', () => bookRenderService.status(id).error !== undefined, 15000);
    const status = bookRenderService.status(id);
    assert.ok(!/failing repeatedly/.test(status.error),
      `two individually-bad sentences aborted the whole book as a broken engine: ${status.error}`);
    assert.ok(/sentence 1\b/.test(status.error),
      `the job does not name the sentence it could not render: ${status.error}`);
    assert.strictEqual(status.rendered, 5,
      'the rest of the book was abandoned along with the one sentence that could not be rendered');
    engine.generateSentence = scriptedGenerateSentence;
  });

  await check('a generation that THROWS is counted, and the abort quotes it', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.',
      'Seven.', 'Eight.', 'Nine.', 'Ten.']);
    // Sentence 0 renders (so the book HAS a sample rate and the pad branch is
    // reachable); everything after it throws. A throw was never counted, so the
    // loop slept 500 ms and tried the next sentence, forever, and the guard that
    // exists for exactly this could not see it.
    engine.generateSentence = async (_text, index) => {
      engine.calls.push(index);
      if (index === 0) return { success: true, audio: { data: enginePcm(1), duration: 0, sampleRate: SAMPLE_RATE } };
      throw new Error('the crucible session is gone');
    };

    await bookRenderService.start(id, 0);
    try {
      await waitFor('the job to conclude the engine is broken',
        () => bookRenderService.status(id).error !== undefined, 25000);
    } finally {
      bookRenderService.stop(id);
      engine.generateSentence = scriptedGenerateSentence;
    }
    const status = bookRenderService.status(id);
    assert.ok(status.error.includes('the crucible session is gone'),
      `the abort does not say what failed: ${status.error}`);
  });

  // The check that stood here pinned the 0.3 s silence placeholder as UNCHANGED
  // and labelled `AWAITING A RULING`, because what a thrice-failed sentence
  // should become was the operator's call and he had not made it. He made it on
  // 2026-09-18 — best take, or the book does not ship — so the placeholder is
  // gone and what replaced it is pinned next door, in
  // `tools/test-book-render-best-of.js`.

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§6 a re-finalize takes the old audio with it');

  await check('an edited plan discards the render made from the old text', async () => {
    resetEngine(); resetSeams();
    const id = `edited${++projectSeq}`;
    const doc = { title: 'Edited', language: 'en', blocks: [
      { text: 'The cat sat on the mat.', chapterStart: true },
      { text: 'Then it left the room.' },
    ] };
    await saveRenderPlan(id, doc);
    await bookRenderService.start(id, 0);
    await waitFor('the first render to finish', () => bookRenderService.status(id).done === true);
    // Reopen so a live Job is in the map when the finalize step runs again.
    await bookRenderService.start(id, 0);

    const edited = { title: 'Edited', language: 'en', blocks: [
      { text: 'The dog sat on the mat.', chapterStart: true },
      { text: 'Then it left the room.' },
    ] };
    await saveRenderPlan(id, edited);

    assert.strictEqual(fs.existsSync(path.join(renderDirOf(id), 'state.json')), false,
      'the coverage from the OLD text survived the edit — the m4b speaks the old wording under the new cue');
    const status = bookRenderService.status(id);
    assert.strictEqual(status.done, false, 'the service still holds the finished job for the old text');
    assert.strictEqual(status.rendered, 0, 'the edited plan kept the old sentences covered');
  });

  await check('a finalize that changes nothing keeps the render', async () => {
    resetEngine(); resetSeams();
    const id = `same${++projectSeq}`;
    const doc = { title: 'Same', language: 'en', blocks: [
      { text: 'The cat sat on the mat.', chapterStart: true },
      { text: 'Then it left the room.' },
    ] };
    await saveRenderPlan(id, doc);
    await bookRenderService.start(id, 0);
    await waitFor('the render to finish', () => bookRenderService.status(id).done === true);
    const before = stateOf(id);
    await saveRenderPlan(id, doc);
    assert.deepStrictEqual(stateOf(id).coverage, before.coverage,
      're-running the finalize step on unchanged text threw the render away');
  });

  await check('a plan that is there and unreadable is not read as "unchanged"', async () => {
    resetEngine(); resetSeams();
    const id = `corrupt${++projectSeq}`;
    const doc = { title: 'Corrupt', language: 'en', blocks: [
      { text: 'The cat sat on the mat.', chapterStart: true },
      { text: 'Then it left the room.' },
    ] };
    await saveRenderPlan(id, doc);
    await bookRenderService.start(id, 0);
    await waitFor('the render to finish', () => bookRenderService.status(id).done === true);
    // The only thing that says which text the WAVs were made from is now junk.
    fs.writeFileSync(path.join(renderDirOf(id), 'plan.json'), '{ this is not json');

    await saveRenderPlan(id, doc);
    assert.strictEqual(fs.existsSync(path.join(renderDirOf(id), 'state.json')), false,
      'audio was kept on the strength of a plan nothing could read — an unanswerable question '
      + 'answered with the reply that happens to cost nothing');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§7 state.json is written atomically, one write at a time');

  await check('every state.json write goes through the library\'s atomic writer', async () => {
    resetEngine(); resetSeams();
    const { id } = newProject(['One.', 'Two.', 'Three.', 'Four.']);
    await bookRenderService.start(id, 0);
    await waitFor('the book to finish', () => bookRenderService.status(id).done === true);
    const stateWrites = persists.paths.filter((p) => p.endsWith('state.json'));
    assert.ok(stateWrites.length > 0,
      'state.json was written with a plain in-place fs.writeFile — a crash mid-write truncates it and the whole book re-renders');
    assert.strictEqual(persists.maxInFlight, 1,
      `${persists.maxInFlight} state.json writes were in flight at once — two in-place writes to one path interleave`);
  });

  await check('the source states the one owner, and bounds ffmpeg\'s stderr', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'book-render-service.ts'), 'utf-8');
    assert.ok(/atomicWriteFile/.test(src) && /from '\.\/manifest-service'/.test(src),
      'the service does not import the library\'s atomicWriteFile');
    assert.ok(!/fs\.writeFile\(statePath/.test(src),
      'state.json is still written in place next to the atomic writer');
    assert.ok(!/err \+= d\.toString\(\)/.test(src),
      'runFfmpeg still accumulates the whole of a multi-hour encode\'s stderr to use 800 chars of it');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§8 every block the reader shows has a sentence to speak');

  await check('a block that is a short fragment is planned, not silently displayed only', async () => {
    resetEngine(); resetSeams();
    const id = `frag${++projectSeq}`;
    // `iv.` is three characters and does not start with an ASCII capital, so
    // the segmenter's old fragment filter deleted it — while saveRenderPlan had
    // ALREADY pushed the block. The reader showed it, it counted, and nothing
    // in plan.sentences pointed at it: never highlighted, never spoken, never
    // in the VTT.
    await saveRenderPlan(id, { title: 'Fragments', language: 'en', blocks: [
      { text: 'The road went on.', chapterStart: true },
      { text: 'iv.' },
      { text: 'It ended.' },
    ] });
    const plan = JSON.parse(fs.readFileSync(path.join(renderDirOf(id), 'plan.json'), 'utf-8'));
    const spokenBlocks = new Set(plan.sentenceBlock);
    const mute = plan.blocks
      .map((b, i) => (spokenBlocks.has(i) ? null : `${i}: ${JSON.stringify(b.text)}`))
      .filter((x) => x !== null);
    assert.deepStrictEqual(mute, [],
      `the plan displays ${mute.length} block(s) that no sentence speaks — ${mute.join('; ')}`);
    assert.ok(plan.sentences.includes('iv.'),
      `the fragment block is absent from the sentence plan: ${JSON.stringify(plan.sentences)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§9 a cue is timed by the AUDIO, and an untimed sentence stops the book');

  await check('the timeline is the samples on disk, not the duration the engine claims', async () => {
    resetEngine(); resetSeams();
    // The engine states nine seconds and hands over one second of samples. The
    // m4b is built by concatenating those samples, so nine is not a second
    // opinion about the sentence — it is a claim about a file it does not own,
    // and reading it first put the cue and the chapter mark somewhere the audio
    // never goes. Sentence 0 goes through the priority path (`renderFirst`) and
    // 1 and 2 through the wide loop, and those derived this duration their own
    // way apiece; both are pinned here.
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    engine.generateSentence = async (_text, index) => {
      engine.calls.push(index);
      return { success: true, audio: { data: enginePcm(1), duration: 9, sampleRate: SAMPLE_RATE } };
    };
    try {
      await bookRenderService.start(id, 0);
      await waitFor('the book to assemble', () => embeds.vtts.length === 1);
    } finally { engine.generateSentence = scriptedGenerateSentence; }

    assert.deepStrictEqual(timestampsIn(embeds.vtts[0]), [
      '00:00:00.000', '00:00:01.000',
      '00:00:01.000', '00:00:02.000',
      '00:00:02.000', '00:00:03.000',
    ], 'the transcript was timed by what the engine SAID rather than by the audio it sent');
    assert.deepStrictEqual(stateOf(id).durations, [1, 1, 1],
      `state.json recorded the engine's claim: ${JSON.stringify(stateOf(id).durations)}`);
  });

  await check('a covered sentence with no duration fails the assembly BY NAME', async () => {
    resetEngine(); resetSeams();
    // state.json says all three are covered; sentence 1's file is not on disk,
    // so `loadOrBuild` cannot measure it back and its duration stays 0. A
    // cumulative timeline built from that 0 used to emit a 0.3 s cue — a number
    // nothing measured, standing in for a sentence nothing rendered — and
    // shipped the book with every later cue and chapter mark slid by the
    // difference. There is no duration to write, so there is no book to ship.
    const { id } = newProject(['One.', 'Two.', 'Three.']);
    for (const [i, seconds] of [[0, 1], [2, 3]]) {
      fs.writeFileSync(path.join(renderDirOf(id), 'sentences', `${i}.wav`),
        pcm16Wav(Buffer.alloc(seconds * SAMPLE_RATE * 2), SAMPLE_RATE));
    }
    fs.writeFileSync(path.join(renderDirOf(id), 'state.json'), JSON.stringify({
      coverage: [true, true, true], durations: [1, 0, 3], playhead: 0,
      done: false, voice: 'test-voice', engine: 'higgs', sampleRate: SAMPLE_RATE,
      failures: 0, updatedAt: Date.now(),
    }));

    await bookRenderService.start(id, 0);
    await waitFor('the job to settle', () => bookRenderService.status(id).error !== undefined, 15000);
    const status = bookRenderService.status(id);
    assert.ok(/sentence 1\b/.test(status.error),
      `the failure does not name the sentence it could not time: ${status.error}`);
    assert.strictEqual(status.done, false, 'a book with an untimed sentence was marked done');
    assert.strictEqual(embeds.vtts.length, 0, 'a transcript was built out of a duration nobody measured');
    assert.strictEqual(ffmpeg.runs.length, 0, 'the m4b was encoded from a timeline with a hole in it');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§10 the failures the render can only meet at the engine are named');

  await check('a priority render that throws says so, and the wide loop still gets the sentence', async () => {
    resetEngine(); resetSeams();
    // `renderFirst` jumps the queue with the playhead sentence and left its
    // catch empty — "retried by the wide loop", which is true and was the whole
    // of what anyone was ever told. A crucible session that has gone away fails
    // here first, and this was the one place it made no sound at all.
    const { id } = newProject(['One.', 'Two.']);
    let priorityThrows = 1;
    engine.generateSentence = async (_text, index, _settings, priority) => {
      engine.calls.push(index);
      if (priority === true && priorityThrows-- > 0) throw new Error('the crucible session is gone');
      return { success: true, audio: { data: enginePcm(1), duration: 0, sampleRate: SAMPLE_RATE } };
    };
    const said = [];
    const realError = console.error;
    console.error = (...args) => { said.push(args.map(String).join(' ')); };
    try {
      await bookRenderService.start(id, 0);
      await waitFor('the book to finish', () => bookRenderService.status(id).done === true);
    } finally {
      console.error = realError;
      engine.generateSentence = scriptedGenerateSentence;
    }
    const named = said.filter((line) => /sentence 0\b/.test(line) && line.includes('the crucible session is gone'));
    assert.ok(named.length > 0,
      `the priority render failed silently — nothing said which sentence or why: ${JSON.stringify(said)}`);
  });

  await check('an engine that fast-start streams is refused BY NAME, not "no reason"', async () => {
    resetEngine(); resetSeams();
    // `{success:true, streamed:true}` and no `audio` is the fast-start contract
    // (electron/streaming-engine.ts): everything the engine had to say it
    // already said through `onChunk`. The whole-book render files one WAV per
    // sentence and passes no `onChunk`, so it has nowhere to put sub-sentence
    // chunks — and it read this as a success carrying nothing, which it
    // recorded as "the engine gave no reason". There is a reason and it is this.
    const { id } = newProject(['One.', 'Two.']);
    engine.generateSentence = async (_text, index) => {
      engine.calls.push(index);
      if (index === 1) return { success: true, streamed: true, duration: 1 };
      return { success: true, audio: { data: enginePcm(1), duration: 0, sampleRate: SAMPLE_RATE } };
    };
    try {
      await bookRenderService.start(id, 0);
      await waitFor('the job to settle', () => bookRenderService.status(id).error !== undefined, 20000);
    } finally { engine.generateSentence = scriptedGenerateSentence; }

    const recorded = fs.readFileSync(path.join(renderDirOf(id), 'failures.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((row) => row.sentence === 1 && typeof row.error === 'string');
    assert.ok(recorded.length > 0, 'the streamed attempt was not recorded at all');
    assert.ok(recorded.every((row) => !/gave no reason/.test(row.error)),
      `a stated fast-start stream was recorded as a reasonless failure: ${JSON.stringify(recorded.map((r) => r.error))}`);
    assert.ok(recorded.some((row) => /fast start/i.test(row.error)),
      `the refusal does not name fast start: ${JSON.stringify(recorded.map((r) => r.error))}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§11 the status the reader polls has one declared shape');

  await check('every field status() answers with is declared in the shared shape', async () => {
    resetEngine(); resetSeams();
    // The shape was written out inline as the service's return type and nowhere
    // else: `res.json()` took whatever it was handed and the reader parsed it as
    // `any`, so the two ends of a poll that runs two to three times a second
    // agreed by coincidence. It lives in shared/ now, which is what lets tsc
    // check the route and the browser against it — and this is the half tsc
    // cannot see: the object the service actually builds.
    const shapeSrc = fs.readFileSync(path.join(REPO, 'shared', 'audio', 'render-status.ts'), 'utf-8');
    const body = shapeSrc.slice(shapeSrc.indexOf('export interface RenderStatus'));
    const declared = new Set((body.match(/^\s{2}(\w+)\??:/gm) || [])
      .map((line) => line.trim().replace(/\??:$/, '')));
    assert.ok(declared.has('rendered') && declared.has('coverage') && declared.has('error'),
      `the shape file declares no usable fields: ${JSON.stringify([...declared])}`);

    // All three branches status() has: nothing, on-disk state only, and a live job.
    const { id } = newProject(['One.', 'Two.']);
    const seen = new Set(Object.keys(bookRenderService.status('no-such-project')));
    await bookRenderService.start(id, 0);
    await waitFor('the book to finish', () => bookRenderService.status(id).done === true);
    for (const key of Object.keys(bookRenderService.status(id))) seen.add(key);
    bookRenderService.forgetJob(id);
    for (const key of Object.keys(bookRenderService.status(id))) seen.add(key);

    const undeclared = [...seen].filter((key) => !declared.has(key));
    assert.deepStrictEqual(undeclared, [],
      `status() answers with field(s) the reader's shape does not declare: ${undeclared.join(', ')}`);
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nThe render service\'s timeline, flags and state file all say one thing.');
}

void main();
