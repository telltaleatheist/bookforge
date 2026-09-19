/**
 * book-render-service.ts — the persistent whole-book renderer behind "TTS entire
 * book". Unlike the streaming scheduler (forward-only, in-memory, ephemeral), this
 * renders a project's sentences to disk one at a time and survives restarts, so the
 * reader can play from the growing on-disk cache and, at 100%, we assemble an m4b.
 *
 * Design (see projects/bookshelf/IMPORT_LISTEN_PLAN.md):
 *   - Render order is forward-from-playhead then wrap: sentences the listener is
 *     about to reach are produced first. Jumping updates the playhead → the queue
 *     reprioritises. This is why we drive the engine's per-sentence
 *     generateSentence() directly instead of the scheduler (which only goes forward).
 *   - Low memory: a small fixed concurrency, one WAV held at a time per worker,
 *     released after it's written to render/sentences/<i>.wav.
 *   - Resumable: render/state.json records coverage + durations; a restart skips
 *     already-covered sentences. Beside it, render/failures.jsonl records every
 *     failed attempt and every settlement, because a sentence the engine could
 *     not render is the one thing a finished book cannot say for itself.
 *   - Completion: concat the sentence WAVs → AAC m4b with chapter marks + a synced
 *     VTT (from per-sentence durations) → registerAudiobookOutput() so it appears on
 *     the audiobook page.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { spawn } from 'child_process';
import { getActiveEngine, getDefaultStreamVoice, getSelectedEngineName } from './streaming-engine';
import type { StreamingEngine } from './streaming-engine';
import { atomicWriteFile, getProjectPath, registerAudiobookOutput } from './manifest-service';
import { embedAndVerifyVtt } from './metadata-tools';
import { splitForTts } from '../shared/listen-text/segment';
// PUNCTUATION ONLY, the streaming path's share of the narration text pass.
// This is the whole-book render the same bookshelf reader plays from, so its
// text has to reach the voice with the same canonical ellipsis and the same
// quotes the live stream and the audiobook do -- the third door, and the one the
// first cut of this work missed (the adversarial review, 2026-09-04). The other
// two stages are minutes of model time and are a PASS the user runs on the book.
import { speakableListenText } from '../shared/listen-text/normalize';
import { getFfmpegPath } from './tool-paths';
import { pcm16Wav, pcm16WavSeconds } from './pcm16-wav';
// Relative, never `@shared/*`: the alias does not exist at RUNTIME in the main process.
import type { RenderStatus } from '../shared/audio/render-status';
import type { AudioChunk } from './streaming-contract';

// ─── Plan + state on disk ─────────────────────────────────────────────────────

/** Ordered sentences + chapter map. Written by the import finalize step; if
 *  missing we derive a single-chapter plan from the project's epub. */
export interface RenderPlan {
  title: string;
  author?: string;
  language: string;
  /** Display units (paragraphs/headings) for the Read&Listen view. */
  blocks: Array<{ id: string; text: string; chapterStart: boolean }>;
  sentences: string[];       // flat, for rendering + full-book playback
  sentenceBlock: number[];   // sentence index → block index (for highlight mapping)
  chapterOf: number[];       // sentence index → chapter index
  chapterTitles: string[];
}

interface RenderState {
  coverage: boolean[];      // sentence rendered to disk?
  durations: number[];      // seconds per sentence (0 until rendered)
  playhead: number;         // last reported reading position
  done: boolean;            // m4b assembled
  m4bPath?: string;
  voice: string;
  engine: string;
  /** The sample rate the engine reported for THIS book's sentences, recorded as
   *  each one is written. Absent until the first sentence renders, which is the
   *  only honest answer before then. */
  sampleRate?: number;
  /** Failed ATTEMPTS and settlements recorded in `failures.jsonl` so far. The
   *  file is the record; this is its count, written by the same append, so the
   *  reader's poll can say "3 failures, here is where they are" without reading
   *  a growing file on every tick. */
  failures: number;
  updatedAt: number;
}

/**
 * One attempt's audio, kept until the sentence settles.
 *
 * An attempt that PRODUCED audio is a candidate even when the engine called it
 * a failure; an attempt that produced nothing — an error, a throw, or a chunk
 * with no samples in it — is not, because there is nothing to file. `wav` is
 * the finished file, built once here so filing the winner is a write and
 * nothing else, and `seconds` is what that file measures.
 */
interface SentenceTake {
  attempt: number;
  wav: Buffer;
  seconds: number;
  sampleRate: number;
}

interface Job {
  projectId: string;
  plan: RenderPlan;
  state: RenderState;
  running: boolean;
  /** Which generation of the render loop is the live one.
   *
   *  `running` alone is a flag every loop this job has ever had can write, and a
   *  Stop followed by a Start inside one sentence's render time gives the job
   *  two of them: the stopped loop's workers are still awaiting a generation
   *  when the new loop launches. Whichever way that raced, the old loop won —
   *  either its `finally` cleared the flag the NEW loop was running on (the
   *  render stopped with partial coverage, no error and nothing assembling), or
   *  its workers carried on beside the new ones and put `2 × width` sentences
   *  into an engine that was told `width`. A generation number lets each loop
   *  ask whether it is still the job's, which is the question `running` cannot
   *  answer. */
  runId: number;
  inFlight: Set<number>;
  assembling: boolean;
  lastPersist: number;
  /** The state.json write in flight, so the next one queues behind it rather
   *  than racing it — see `maybePersist`. */
  persisting: Promise<void>;
  /** Per-sentence attempt counts — a sentence gets a few attempts before the
   *  job settles it, so one flaky generation doesn't punch a hole in the book. */
  retries: Map<number, number>;
  /** Sentence index → the takes its failed attempts produced, held until the
   *  sentence settles (Owen, 2026-09-18: "let's just use the best version of it
   *  if it fails 3 times"). Bounded by ATTEMPTS_PER_SENTENCE per sentence and
   *  dropped the moment one is filed, so the "one WAV at a time per worker"
   *  budget in this file's header still holds. */
  candidates: Map<number, SentenceTake[]>;
  /** Sentences that used up every attempt with nothing filed, and why. THE BOOK
   *  IS NOT DONE WHILE THIS IS NON-EMPTY: a sentence with no audio is a hole,
   *  and until 2026-09-18 it was filled with 0.3 s of silence and reported as
   *  rendered. `nextIndex` skips these so the loop finishes the rest of the
   *  book rather than retrying them forever. */
  unrenderable: Map<number, string>;
  /** The failures.jsonl append in flight, so the next one queues behind it —
   *  `width` workers share one file. See `recordFailure`. */
  recording: Promise<void>;
  /** Consecutive SENTENCES that used up every attempt, with no sentence
   *  rendering in between. A run of those means the ENGINE is broken (model not
   *  loaded, worker died), not the text — abort instead of walking the whole
   *  book to collect the same failure once per sentence.
   *
   *  It counts exhausted sentences and not failed attempts, which is the half
   *  that was missing: until 2026-09-18 every attempt bumped it and the branch
   *  that concluded "this one sentence is bad" never cleared it, so three
   *  attempts on one bad sentence plus two on the next added up to five and a
   *  book with two bad sentences was reported as a broken engine. */
  consecFail: number;
  /** The pace this run was told for the voice it is rendering in, kept for the
   *  run. See `statedPace`: it was asked of the engine once per SETTLEMENT, and
   *  behind that member sit the venue decision and a `GET /v1/voices`. Keyed by
   *  voice, because a mid-render switch applies to later sentences and the pace
   *  has to be the speaking voice's. Only a NUMBER is kept — a refusal is a
   *  failure to reach the venue, and the next settlement asks again. */
  statedPace: { voice: string; paceCharsPerSec: number } | null;
  error?: string;
}

// Fallback in-flight width when the engine doesn't report one. At runtime we ask
// the engine (engine.getMaxConcurrentSentences — Orpheus's fixed batch width, or
// XTTS's worker count) so a batching engine gets FULL batches: an MLX batch costs
// the same wall clock however full it is, so a half-empty one halves throughput.
const FALLBACK_CONCURRENCY = 2;
const PERSIST_INTERVAL_MS = 1500;

/** Attempts one sentence gets before the job gives up on it. */
const ATTEMPTS_PER_SENTENCE = 3;
/** Sentences that may use up every attempt, back to back, before the job stops
 *  believing the text is what is wrong. */
const EXHAUSTED_SENTENCES_MEANING_A_BROKEN_ENGINE = 5;
/** How much of a failing ffmpeg's stderr is kept. An m4b encode runs for hours
 *  and writes progress lines the whole time; all of it used to be concatenated
 *  into one string so that the last 800 characters could be quoted. */
const FFMPEG_STDERR_KEPT = 4000;

function renderDir(projectId: string): string { return path.join(getProjectPath(projectId), 'render'); }
function sentencesDir(projectId: string): string { return path.join(renderDir(projectId), 'sentences'); }
function planPath(projectId: string): string { return path.join(renderDir(projectId), 'plan.json'); }
function statePath(projectId: string): string { return path.join(renderDir(projectId), 'state.json'); }
/** Every failed attempt and every settlement, one JSON object per line, beside
 *  state.json. Owen, 2026-09-18: "record what failed and when so we can review
 *  later" — before this the only trace of a sentence the engine could not
 *  render was a console line in a window nobody had open. */
function failuresPath(projectId: string): string { return path.join(renderDir(projectId), 'failures.jsonl'); }
function sentenceFile(projectId: string, i: number): string { return path.join(sentencesDir(projectId), `${i}.wav`); }

/**
 * Write one rendered sentence to disk AS A WAV, and return the bytes written.
 *
 * The engine returns base64 PCM16 and the rate it produced it at; it does not
 * encode, deliberately (electron/crucible/stream.ts leaves that "to whoever is
 * listening"). This is that listener, and until 2026-09-18 it listened badly:
 * the raw samples went into a file named `.wav` with no RIFF header, so the
 * reader's route served bytes no decoder could read and ffmpeg's concat
 * demuxer had no container to probe. The header states the rate the ENGINE
 * reported — an audio chunk without one is refused by name inside pcm16Wav,
 * because a guessed rate is inaudible as an error and audible as pitch.
 *
 * Exported so `tools/test-book-render-wav.js` can put a known payload through
 * this path and read the header back off disk. IT HAS NO OTHER CALLER SINCE
 * 2026-09-18: `renderFirst` used to write its sentence here and derive the
 * duration separately, which was a second copy of what `fileTake` does, and it
 * files a `takeFrom` take through `fileTake` now like the wide loop. The bytes
 * are the same either way — both build them with `sentenceWav` below, because a
 * take that might be KEPT has to exist as bytes before anyone knows whether it
 * will be filed.
 */
export async function writeSentenceWav(file: string, audio: AudioChunk): Promise<Buffer> {
  const wav = sentenceWav(audio);
  await fs.writeFile(file, wav);
  return wav;
}

/** The finished file an engine chunk makes, WITHOUT writing it — the half of
 *  `writeSentenceWav` a held candidate needs, so a take that is kept and a take
 *  that is filed are the same bytes built by the same builder. */
function sentenceWav(audio: AudioChunk): Buffer {
  return pcm16Wav(Buffer.from(audio.data, 'base64'), audio.sampleRate);
}

/**
 * The TAKE an engine result carries, or null when it carried no sound.
 *
 * "No sound" is three shapes and they are all one answer here: no chunk at all,
 * a chunk with no sample rate (`pcm16Wav` refuses one by name and there is no
 * rate to guess — a wrong one is audible as pitch), and a chunk whose payload
 * holds less than one 16-bit sample. The third is why this exists: until
 * 2026-09-18 `result.success && result.audio` filed an empty payload as a
 * rendered sentence, which is a 44-byte header, a covered coverage bit and a
 * hole in the book that nothing measures.
 */
function takeFrom(audio: AudioChunk | undefined, attempt: number): SentenceTake | null {
  if (audio === undefined || audio === null) return null;
  if (typeof audio.sampleRate !== 'number' || !(audio.sampleRate > 0)) return null;
  if (typeof audio.data !== 'string' || audio.data.length === 0) return null;
  const pcm = Buffer.from(audio.data, 'base64');
  if (pcm.length < 2) return null;
  const wav = pcm16Wav(pcm, audio.sampleRate);
  // THE TAKE IS AS LONG AS ITS SAMPLES. `audio.duration` used to be read first
  // and these bytes only when it was 0 — two owners of one fact, and the one
  // that was asked first does not own it: the m4b is built by concatenating
  // exactly this buffer, so its own header is what the book will play. An
  // engine's stated seconds is a claim about a file it never sees (crucible
  // sends `outcome.seconds ?? 0`, so "0" there means unstated, not silent), and
  // where the two disagreed the cue and the chapter mark went somewhere the
  // audio does not. A buffer with no measurable duration is refused by name
  // inside `pcm16WavSeconds` rather than papered over with a stated number.
  return { attempt, wav, seconds: pcm16WavSeconds(wav), sampleRate: audio.sampleRate };
}

/**
 * WHY AN ENGINE RESULT CARRIES NO SENTENCE THIS SERVICE CAN FILE, in words.
 *
 * FAST START IS REFUSED AT THIS DOOR, BY NAME. `{ success: true, streamed: true }`
 * with no `audio` is the fast-start contract (`StreamingEngine.generateSentence`
 * in ./streaming-engine.ts): the engine has already handed the sentence over in
 * sub-sentence chunks through the `onChunk` callback. This service passes no
 * `onChunk` and has nowhere to put those chunks — it files ONE wav per sentence
 * and times the whole book from it — so such a result is not a rendered
 * sentence. It used to arrive here as a success carrying nothing and be recorded
 * as "the engine gave no reason", which is the one thing it was not.
 */
function noSentenceReason(result: { success: boolean; streamed?: boolean; error?: string }): string {
  if (result.streamed === true) {
    return 'the engine answered with fast start (streamed, with no audio): it delivered this sentence in '
      + 'sub-sentence chunks through an onChunk the whole-book render does not pass and cannot file, '
      + 'because a book is assembled and timed from one wav per sentence';
  }
  return result.error === undefined ? 'the engine gave no reason' : result.error;
}

/**
 * HOW LONG THIS TEXT SHOULD TAKE TO READ, in seconds — `chars ÷ pace`, which is
 * narrator's own arithmetic read backwards.
 *
 * narrator judges a take by its characters per second against the pace the
 * guard is centred on (`python/narrator/engine/higgs/truncation.py`, `check()`
 * and `PaceTracker`); `chars / pace` is the duration that lands exactly on that
 * centre. There is no default pace here: an unmeasured voice is refused by the
 * caller, by name, because a guessed reading rate picks a take for reasons
 * nobody measured.
 */
export function expectedSentenceSeconds(chars: number, paceCharsPerSec: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    throw new Error(`expectedSentenceSeconds: ${chars} is not a number of characters`);
  }
  if (!Number.isFinite(paceCharsPerSec) || paceCharsPerSec <= 0) {
    throw new Error(`expectedSentenceSeconds: ${paceCharsPerSec} is not a pace in characters per second`);
  }
  return chars / paceCharsPerSec;
}

/**
 * THE BEST OF A SENTENCE'S TAKES, and there is one criterion.
 *
 * Owen, 2026-09-18: *"Let's just use the best version of it if it fails 3
 * times."* Best is the take whose DURATION is closest to what the text should
 * take to read — the same question narrator answers at the bottom of its length
 * ladder (`truncation.py`, `_LadderTask._accept`: "the take closest to the
 * expected length ships"), and the same arithmetic. narrator measures the
 * distance in LOG space, on chars per second; with `chars` fixed for one
 * sentence `|log(chars/seconds) − log(chars/expected)|` is
 * `|log(expected) − log(seconds)|`, so comparing durations that way orders the
 * takes exactly as narrator orders them. It is not the same order a plain
 * difference in seconds gives: against a 4 s expectation a 2 s take and an 8 s
 * take are both half-or-double wrong, and seconds alone would call the short
 * one twice as good.
 *
 * A tie goes to the EARLIEST attempt: two takes the same distance from
 * expectation are equally good by the only criterion there is, and the first is
 * the one the engine produced under its own seed rule.
 *
 * Exported so `tools/test-book-render-best-of.js` can put takes of known
 * duration against a known expectation through it; the service's only caller is
 * `settleExhaustedSentence` below.
 */
export function bestOfTakes<T extends { attempt: number; seconds: number }>(
  takes: readonly T[],
  expectedSeconds: number,
): T {
  if (takes.length === 0) throw new Error('bestOfTakes: there are no takes to choose between');
  if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0) {
    throw new Error(`bestOfTakes: ${expectedSeconds} is not an expected duration in seconds`);
  }
  const distance = (take: T): number => {
    if (!Number.isFinite(take.seconds) || take.seconds <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(Math.log(take.seconds) - Math.log(expectedSeconds));
  };
  let best = takes[0] as T;
  let bestDistance = distance(best);
  for (const take of takes.slice(1)) {
    const d = distance(take);
    // Strictly less: a tie leaves the earlier attempt standing.
    if (d < bestDistance) { best = take; bestDistance = d; }
  }
  return best;
}

/**
 * What the plan on disk says this book's sentences are, for the comparison
 * saveRenderPlan makes below.
 *
 * The three answers are kept apart because only one of them means "the audio on
 * disk still belongs to this text". A plan that is PRESENT and unreadable is not
 * evidence of sameness — it is the absence of evidence either way, and reading
 * it as "unchanged" would keep audio nothing can vouch for.
 */
type PriorPlan =
  | { kind: 'none' }
  | { kind: 'sentences'; sentences: string[] }
  | { kind: 'unreadable'; reason: string };

async function priorPlan(projectId: string): Promise<PriorPlan> {
  let raw: string;
  try {
    raw = await fs.readFile(planPath(projectId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', reason: (err as Error).message };
  }
  try {
    const plan = JSON.parse(raw) as RenderPlan;
    if (!Array.isArray(plan.sentences)) return { kind: 'unreadable', reason: 'it plans no sentences array' };
    return { kind: 'sentences', sentences: plan.sentences };
  } catch (err) {
    return { kind: 'unreadable', reason: (err as Error).message };
  }
}

/**
 * Write render/plan.json from the editor's flat blocks. Chapter-start blocks head
 * a new chapter AND are spoken as its first sentence, so nothing is dropped and the
 * plan matches exactly what the reader shows. Called by the import finalize step.
 *
 * A PLAN IS THE TEXT IT PLANS, AND A RENDER BELONGS TO ONE PLAN.
 *
 * Until 2026-09-18 this wrote plan.json and stopped there: state.json, the
 * sentence WAVs and any live Job in the service all survived, and the only
 * identity check on the next load was `coverage.length === sentences.length`.
 * So a one-word edit in the editor — which changes no sentence count — came
 * back with every coverage bit intact, the edited sentence already "covered",
 * and its OLD audio reused: the m4b spoke the old wording under the new cue and
 * the new displayed text. The comparison is made here, against the plan already
 * on disk, because this function is the only thing that can change the text.
 */
export async function saveRenderPlan(
  projectId: string,
  doc: { title: string; author?: string; language?: string; blocks: Array<{ text: string; chapterStart?: boolean }> },
): Promise<void> {
  const language = doc.language || 'en';
  const blocks: RenderPlan['blocks'] = [];
  const sentences: string[] = [];
  const sentenceBlock: number[] = [];
  const chapterOf: number[] = [];
  const chapterTitles: string[] = [];
  let ci = -1;
  for (const raw of doc.blocks) {
    const text = speakableListenText(raw.text || '');
    if (!text) continue;
    if (raw.chapterStart || ci < 0) {
      ci++;
      chapterTitles.push(raw.chapterStart ? text.slice(0, 120) : (doc.title || `Chapter ${ci + 1}`));
    }
    const bi = blocks.length;
    blocks.push({ id: `b${bi}`, text, chapterStart: !!raw.chapterStart });
    for (const s of splitForTts(text, language)) { sentences.push(s); sentenceBlock.push(bi); chapterOf.push(ci); }
  }
  if (chapterTitles.length === 0) chapterTitles.push(doc.title || 'Book');
  const plan: RenderPlan = { title: doc.title, author: doc.author, language, blocks, sentences, sentenceBlock, chapterOf, chapterTitles };
  await fs.mkdir(renderDir(projectId), { recursive: true });

  const previous = await priorPlan(projectId);
  // A first finalize has no audio to be wrong about. A plan that is there and
  // unreadable is not a match — it is an unanswerable question, and the answer
  // that keeps the old WAVs is the one that cannot be checked.
  const keeps = previous.kind === 'sentences'
    && previous.sentences.length === sentences.length
    && previous.sentences.every((s, i) => s === sentences[i]);
  const discard = previous.kind !== 'none' && !keeps;

  await fs.writeFile(planPath(projectId), JSON.stringify(plan));

  if (discard) {
    // The audio on disk was made from sentences this plan no longer contains,
    // and nothing else records which text a WAV was rendered from. Discarding
    // it costs the render; keeping it costs the book, silently.
    bookRenderService.forgetJob(projectId);
    await fs.rm(statePath(projectId), { force: true });
    await fs.rm(sentencesDir(projectId), { recursive: true, force: true });
    console.log(`[book-render] ${projectId}: ${previous.kind === 'unreadable'
      ? `the previous plan could not be read (${previous.reason}), so the text it was rendered from cannot be`
        + ' vouched for and'
      : 'the text changed, so'} its part-rendered audio was discarded`);
  }
}

/**
 * `sec` as a WebVTT timestamp, `hh:mm:ss.mmm`.
 *
 * Rounded ONCE, to whole milliseconds, with the hours/minutes/seconds derived
 * from the rounded total. Rounding the fraction on its own — which is what this
 * did until 2026-09-18 — gives `Math.round(0.9996 * 1000) === 1000`, and
 * `String(1000).padStart(3, '0')` is `"1000"`: `fmt(12.9996)` returned
 * `00:00:12.1000`, a millisecond field WebVTT has no place for, on a cue that
 * had also lost the second it should have carried. One timestamp in a thousand,
 * two timestamps per sentence, thousands of sentences — every book, several
 * times, and `embedAndVerifyVtt` rejects the file or a lenient player drops the
 * cues.
 *
 * Exported so `tools/test-book-render-timeline.js` can measure the boundary
 * directly; buildVtt below is its only other caller.
 */
export function vttTimestamp(sec: number): string {
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    + `.${String(ms).padStart(3, '0')}`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class BookRenderService {
  private jobs = new Map<string, Job>();
  private active: string | null = null; // one project renders at a time (shared GPU)

  /** Public status for the reader's poll, in the shape both ends of the poll
   *  read (`shared/audio/render-status.ts`). It was written out inline here and
   *  nowhere else: the route handed it to `res.json()` and the reader parsed it
   *  as `any`, so a renamed field reached the listener as a progress bar that
   *  stopped moving. */
  status(projectId: string): RenderStatus {
    const job = this.jobs.get(projectId);
    if (!job) {
      // Could still have on-disk state from a previous run.
      const persisted = this.loadState(projectId);
      if (persisted && persisted.plan) {
        const rendered = persisted.state.coverage.filter(Boolean).length;
        return { exists: true, total: persisted.plan.sentences.length, rendered, done: persisted.state.done,
          coverage: persisted.state.coverage, playhead: persisted.state.playhead, m4b: !!persisted.state.m4bPath,
          failures: persisted.state.failures || 0, failuresPath: failuresPath(projectId) };
      }
      return { exists: false, total: 0, rendered: 0, done: false };
    }
    const rendered = job.state.coverage.filter(Boolean).length;
    return {
      exists: true, total: job.plan.sentences.length, rendered, done: job.state.done,
      coverage: job.state.coverage, playhead: job.state.playhead, assembling: job.assembling,
      m4b: !!job.state.m4bPath, error: job.error,
      // WHAT FAILED IS ONE CLICK AWAY, which is the whole of Owen's "record what
      // failed and when so we can review later": the count says whether there is
      // anything to read and the path says where it is.
      failures: job.state.failures || 0, failuresPath: failuresPath(projectId),
    };
  }

  /** The render plan (blocks + sentences + chapter map) for the reader view.
   *  Loads plan.json, else derives one from the project's epub. */
  async getPlan(projectId: string): Promise<RenderPlan | null> {
    const job = this.jobs.get(projectId);
    if (job) return job.plan;
    try { return JSON.parse(await fs.readFile(planPath(projectId), 'utf-8')) as RenderPlan; } catch { /* build */ }
    return this.buildPlanFromEpub(projectId);
  }

  /** Absolute path of a rendered sentence, or null if not on disk yet. */
  sentencePath(projectId: string, index: number): string | null {
    const p = sentenceFile(projectId, index);
    return fsSync.existsSync(p) ? p : null;
  }

  /** Start (or resume) the full-book render for a project from `startIndex`.
   *  `voice` (optional) picks the TTS voice: it persists on the job state, and a
   *  mid-render switch warms the new voice live (cheap on Orpheus — the voice is
   *  just the warm prompt prefix). Sentences already on disk keep the old voice. */
  async start(projectId: string, startIndex = 0, voice?: string): Promise<{ ok: boolean; total: number; error?: string }> {
    let job = this.jobs.get(projectId);
    if (!job) {
      const loaded = await this.loadOrBuild(projectId);
      if (!loaded) return { ok: false, total: 0, error: 'no readable text for this project' };
      job = loaded;
      this.jobs.set(projectId, job);
    }
    job.state.playhead = Math.max(0, Math.min(startIndex, job.plan.sentences.length - 1));
    if (voice && voice !== job.state.voice) {
      job.state.voice = voice;
      if (job.running) {
        // Live switch: the running loop reads job.state.voice each sentence, but
        // the engine renders with whatever voice is warm — warm the new one now.
        try { await getActiveEngine().loadVoice(voice); } catch { /* next runLoops warms it */ }
      }
    }

    // One render at a time. Pause any other project's loop (its state persists).
    if (this.active && this.active !== projectId) {
      const other = this.jobs.get(this.active);
      if (other) other.running = false;
    }
    this.active = projectId;

    if (!job.running && !job.state.done) {
      job.running = true;
      // This loop is a new GENERATION of the job's render, and says so — see
      // `Job.runId`. Without it the loop a Stop left draining could clear this
      // one's `running` flag on its way out.
      void this.runLoops(job, ++job.runId);
    }
    return { ok: true, total: job.plan.sentences.length };
  }

  /** Drop the in-memory job for a project so the next start() re-reads the plan
   *  and the state from disk. Called by saveRenderPlan when the text changed:
   *  a Job holds the OLD plan and would go on writing state for it. */
  forgetJob(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    job.running = false;
    this.jobs.delete(projectId);
    if (this.active === projectId) this.active = null;
  }

  reportPlayhead(projectId: string, index: number): void {
    const job = this.jobs.get(projectId);
    if (job) job.state.playhead = Math.max(0, Math.min(index, job.plan.sentences.length - 1));
  }

  stop(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (job) job.running = false;
    if (this.active === projectId) this.active = null;
  }

  // ─── Plan / state loading ────────────────────────────────────────────────────

  private loadState(projectId: string): { plan: RenderPlan; state: RenderState } | null {
    try {
      const plan = JSON.parse(fsSync.readFileSync(planPath(projectId), 'utf-8')) as RenderPlan;
      const state = JSON.parse(fsSync.readFileSync(statePath(projectId), 'utf-8')) as RenderState;
      if (!Array.isArray(plan.sentences) || !Array.isArray(state.coverage)) return null;
      return { plan, state };
    } catch { return null; }
  }

  private async loadOrBuild(projectId: string): Promise<Job | null> {
    await fs.mkdir(sentencesDir(projectId), { recursive: true });

    let plan: RenderPlan | null = null;
    try { plan = JSON.parse(await fs.readFile(planPath(projectId), 'utf-8')) as RenderPlan; } catch { /* build below */ }
    if (!plan || !Array.isArray(plan.sentences) || plan.sentences.length === 0) {
      plan = await this.buildPlanFromEpub(projectId);
    }
    if (!plan || plan.sentences.length === 0) return null;

    // Rehydrate or initialise state; reconcile coverage with what's actually on disk.
    let state: RenderState | null = null;
    try { state = JSON.parse(await fs.readFile(statePath(projectId), 'utf-8')) as RenderState; } catch { /* fresh */ }
    if (!state || !Array.isArray(state.coverage) || state.coverage.length !== plan.sentences.length) {
      state = {
        coverage: plan.sentences.map(() => false),
        durations: plan.sentences.map(() => 0),
        playhead: 0, done: false, voice: getDefaultStreamVoice(), engine: getSelectedEngineName(),
        failures: 0, updatedAt: Date.now(),
      };
    }
    // A state.json written before failures.jsonl existed has no count; the file
    // beside it is still the record, and this is the number that summarises it.
    if (typeof state.failures !== 'number') state.failures = 0;
    // COVERAGE AND DURATION ARE ONE FACT, SO THEY ARE RECONCILED TOGETHER.
    //
    // maybePersist only writes every 1500 ms, so a crash leaves the last few
    // seconds of sentences on disk and absent from state.json. This loop
    // adopted them — and set coverage WITHOUT setting durations[i], which stays
    // 0, which buildVtt and buildFfmeta read as 0.3 s. The timeline is
    // cumulative, so every cue and every chapter mark after the first adopted
    // sentence slid, by ~3.7 s each and growing. The duration was recoverable
    // the whole time: it is in the file's own header.
    for (let i = 0; i < plan.sentences.length; i++) {
      const file = sentenceFile(projectId, i);
      if (state.coverage[i] && state.durations[i] > 0) continue;
      if (!fsSync.existsSync(file)) continue;
      let seconds: number;
      try {
        seconds = pcm16WavSeconds(fsSync.readFileSync(file));
      } catch (err) {
        // The crash that left this file unrecorded can equally have caught it
        // mid-write. A truncated WAV has no duration to read, so it is not a
        // rendered sentence: it is left uncovered for the loop to make again,
        // and said out loud, because a sentence that quietly re-renders is the
        // only other way anyone would learn this happened.
        console.warn(`[book-render] ${projectId}: sentence ${i} is on disk but cannot be measured, `
          + `so it will be rendered again: ${(err as Error).message}`);
        continue;
      }
      state.coverage[i] = true;
      state.durations[i] = seconds;
    }

    return {
      projectId, plan, state, running: false, runId: 0, inFlight: new Set(), assembling: false,
      lastPersist: 0, persisting: Promise.resolve(), retries: new Map(), candidates: new Map(),
      unrenderable: new Map(), recording: Promise.resolve(), consecFail: 0, statedPace: null,
    };
  }

  /** Fallback when no plan.json exists: extract the epub into flat sentences. */
  private async buildPlanFromEpub(projectId: string): Promise<RenderPlan | null> {
    try {
      const { ingestFromFile } = await import('./reader-ingest.js');
      const archiveDir = path.join(getProjectPath(projectId), 'archive');
      const files = await fs.readdir(archiveDir);
      const epub = files.find((f) => f.toLowerCase().endsWith('.epub'))
        || files.find((f) => /\.(pdf|txt|html?)$/i.test(f));
      if (!epub) return null;
      const abs = path.join(archiveDir, epub);
      const res = await ingestFromFile(abs, epub);
      const blocks: RenderPlan['blocks'] = [];
      const sentences: string[] = [];
      const sentenceBlock: number[] = [];
      const chapterOf: number[] = [];
      for (const block of res.blocks) {
        const text = speakableListenText(block || '');
        if (!text) continue;
        const bi = blocks.length;
        blocks.push({ id: `b${bi}`, text, chapterStart: false });
        for (const s of splitForTts(text, 'en')) { sentences.push(s); sentenceBlock.push(bi); chapterOf.push(0); }
      }
      if (sentences.length === 0) return null;
      return { title: res.title || projectId, language: 'en', blocks, sentences, sentenceBlock, chapterOf, chapterTitles: [res.title || 'Book'] };
    } catch (err) {
      console.error('[book-render] buildPlanFromEpub failed:', err);
      return null;
    }
  }

  // ─── Render loop ─────────────────────────────────────────────────────────────

  private nextIndex(job: Job): number {
    const N = job.plan.sentences.length;
    const p = job.state.playhead;
    for (let k = 0; k < N; k++) {
      const i = (p + k) % N; // forward from playhead, then wrap to the front
      // A sentence that used up every attempt is not "still to do": it has been
      // settled, badly, and the job will fail by name for it. Handing it back
      // here would be an endless retry of a sentence whose retries are spent.
      if (!job.state.coverage[i] && !job.inFlight.has(i) && !job.unrenderable.has(i)) return i;
    }
    return -1;
  }

  private async runLoops(job: Job, runId: number): Promise<void> {
    try {
      const engine = getActiveEngine();
      if (!engine.isSessionActive()) {
        const started = await engine.startSession();
        if (!started.success) { if (job.runId === runId) job.error = started.error || 'TTS engine failed to start'; return; }
      }
      // startSession only brings the worker PROCESS up — the model itself loads
      // on loadVoice(), and generateSentence before that fails "Model not loaded".
      const loaded = await engine.loadVoice(job.state.voice || getDefaultStreamVoice());
      if (!loaded.success) { if (job.runId === runId) job.error = loaded.error || 'voice failed to load'; return; }
      // Everything above is an await, so a Stop-and-Start may have replaced this
      // generation while it warmed up. Nothing below is this loop's to write.
      if (job.runId !== runId) return;
      job.error = undefined;
      // Fastest first audio: render the playhead sentence ALONE at priority before
      // going wide. A batch-of-1 lands in a few seconds; a first FULL batch (16 on
      // Orpheus) would make the listener wait for the whole group before hearing
      // anything. This is a file render with a progress bar, not the seamless-start
      // listening path, so first-audio latency is still worth one narrow batch here.
      await this.renderFirst(job);
      // In-flight width from the engine: Orpheus reports its fixed batch width (a
      // partial batch wastes the warmed MLX graph), XTTS its worker count.
      const width = Math.max(1, engine.getMaxConcurrentSentences?.() ?? engine.getWorkerCount() ?? FALLBACK_CONCURRENCY);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < width; w++) workers.push(this.worker(job, runId));
      await Promise.all(workers);
    } catch (err) {
      console.error('[book-render] loop error:', err);
    } finally {
      // ONLY THIS GENERATION'S OWN EXIT ENDS IT. A loop the user stopped
      // finishes draining after the loop that replaced it has started, and
      // clearing `running` there stopped the NEW render dead: partial coverage,
      // no error, nothing assembling, and nothing anywhere saying so.
      if (job.runId === runId) {
        job.running = false;
        // A BOOK WITH A HOLE IN IT IS NOT A FINISHED BOOK. Until 2026-09-18 a
        // sentence the engine could never render became 0.3 s of silence,
        // `coverage[i]` was set, and the m4b assembled with a gap where a
        // sentence should be and nothing anywhere recording which one. Owen's
        // ruling of that day keeps the best TAKE when there is one; when there
        // is no audio at all the job says so by name instead of shipping the
        // hole. The abort is written here, after the workers have drained, so
        // the rest of the book is still attempted and the five-in-a-row engine
        // guard still gets its five.
        // `job.error` already set is the engine-is-broken abort, which is a
        // verdict about the WHOLE run and outranks a list of sentences.
        if (job.unrenderable.size > 0 && job.error === undefined) {
          job.error = this.describeUnrenderable(job);
          console.error(`[book-render] ${job.projectId}: ${job.error}`);
          await this.maybePersist(job, true);
        } else if (this.allCovered(job) && !job.state.done && !job.assembling) {
          await this.assemble(job);
        }
      }
    }
  }

  private allCovered(job: Job): boolean {
    return job.state.coverage.every(Boolean);
  }

  /** Render the playhead sentence solo at engine priority (it jumps the batch
   *  queue and goes out as a batch-of-1). On failure it's left uncovered — the
   *  wide loop retries it with the normal failure policy. */
  private async renderFirst(job: Job): Promise<void> {
    const i = job.state.playhead;
    if (i < 0 || i >= job.plan.sentences.length) return;
    if (job.state.coverage[i] || job.inFlight.has(i)) return;
    job.inFlight.add(i);
    try {
      const result = await getActiveEngine().generateSentence(
        job.plan.sentences[i], i,
        { voice: job.state.voice || getDefaultStreamVoice(), speed: 1.0 },
        true,
      );
      // ONE TAKE, BUILT AND FILED BY THE TWO FUNCTIONS THE WIDE LOOP USES.
      // `takeFrom` and not `result.audio` alone: a chunk with an empty payload
      // is a 44-byte header and no sound, and filing it covers the sentence with
      // a hole. It is a failed attempt, and the wide loop counts and records it
      // as one — this path counts nothing, by design (see the header above).
      // The take it builds is now also the take that is FILED: this path called
      // `takeFrom` only to ask whether it was null, then wrote the wav again and
      // derived the duration a second way, which is one decision written twice
      // and the copy here read the engine's stated seconds first.
      const take = takeFrom(result.audio, 1);
      if (result.success && take !== null) await this.fileTake(job, i, take);
      else {
        console.warn(`[book-render] sentence ${i} at priority produced nothing: ${noSentenceReason(result)}`
          + ' — left uncovered for the wide loop, which counts and records its attempts');
      }
    } catch (err) {
      // SAID, AND STILL RETRIED BY THE WIDE LOOP. The retry is the design — this
      // path counts nothing, see the header — but the silence was not: an empty
      // catch here is where a torn-down session throws FIRST, and all anyone saw
      // of it was a first sentence that took the long way round.
      console.error(`[book-render] sentence ${i} at priority threw: `
        + `${err instanceof Error ? err.message : String(err)} — retried by the wide loop`);
    } finally {
      job.inFlight.delete(i);
      await this.maybePersist(job, true);
    }
  }

  private async worker(job: Job, runId: number): Promise<void> {
    const engine = getActiveEngine();
    while (job.running && job.runId === runId && this.active === job.projectId) {
      const i = this.nextIndex(job);
      if (i < 0) break; // nothing left to render
      // Read per-iteration so a mid-render voice switch applies to later sentences.
      const voice = job.state.voice || getDefaultStreamVoice();
      job.inFlight.add(i);
      let abort: string | null = null;
      try {
        const result = await engine.generateSentence(job.plan.sentences[i], i, { voice, speed: 1.0 }, false);
        const take = takeFrom(result.audio, (job.retries.get(i) || 0) + 1);
        if (result.success && take !== null) {
          await this.fileTake(job, i, take);
          // A RENDERED SENTENCE IS THE ONLY THING THAT CLEARS THE GUARD, and a
          // take filed by best-of is not one: the sentence still used up every
          // attempt, so an engine failing every sentence still reaches five.
          job.consecFail = 0;
        } else {
          // THE ENGINE'S OWN REASON, CARRIED. `result.error` was read only as a
          // last-ditch substitute for the abort message; a failure that had one
          // and a failure that had none were otherwise the same event here.
          //
          // AND THE AUDIO, IF THERE WAS ANY. An attempt the engine called a
          // failure may still have handed over a chunk, and that chunk is a
          // CANDIDATE for the sentence — the only thing Owen's best-of ruling
          // can be made of. A success with nothing in it is not a rendered
          // sentence either; it is an attempt that produced nothing, and it is
          // counted and recorded as one rather than filed as a 44-byte file.
          if (take !== null) this.keepTake(job, i, take);
          abort = await this.noteFailedAttempt(job, i, result.success ? 'empty' : 'error',
            noSentenceReason(result));
        }
      } catch (err) {
        // A THROW IS A FAILED ATTEMPT LIKE ANY OTHER, and until 2026-09-18 it
        // was the one shape the guard below could not see: this catch logged,
        // slept and went round again without touching consecFail or retries, so
        // an engine that threw on every sentence — a torn-down session, a
        // dropped transport — was retried forever and reported nothing.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[book-render] sentence ${i} threw: ${reason}`);
        abort = await this.noteFailedAttempt(job, i, 'threw', reason);
      } finally {
        job.inFlight.delete(i);
        await this.maybePersist(job);
      }
      if (abort !== null) {
        // The verdict is the job's, but only this generation may stop it.
        if (job.runId === runId) { job.error = abort; job.running = false; }
        break;
      }
    }
  }

  /**
   * One failed attempt at sentence `i`, whichever way it failed. Returns the
   * message the job should abort with, or null to carry on.
   *
   * The two questions this answers used to be one: "has this sentence had its
   * chances?" and "is the engine broken?" were both read off a counter that
   * every attempt bumped and nothing cleared. They are separate facts —
   * `retries` is per sentence, `consecFail` counts whole sentences that used up
   * every attempt with none rendering in between — and only the second is
   * evidence about the engine.
   */
  private async noteFailedAttempt(
    job: Job, i: number, kind: 'error' | 'threw' | 'empty', reason: string,
  ): Promise<string | null> {
    const attempts = (job.retries.get(i) || 0) + 1;
    job.retries.set(i, attempts);
    // EVERY failed attempt, not only the last one: Owen, 2026-09-18, "record
    // what failed and when so we can review later". The console line the moment
    // it happened stays — this is the copy that is still there tomorrow.
    await this.recordFailure(job, {
      sentence: i, attempt: attempts, at: new Date().toISOString(), kind, error: reason,
    });
    if (attempts < ATTEMPTS_PER_SENTENCE) {
      await new Promise((r) => setTimeout(r, 300)); // leave uncovered — retried later
      return null;
    }

    job.consecFail++;
    // THE SENTENCE IS SETTLED BEFORE THE ENGINE IS JUDGED. The two are separate
    // questions and the settlement is the cheaper one: a take that was going to
    // be filed is filed whichever way the guard then votes, so the abort can
    // never quietly throw away audio the render already had.
    await this.settleExhaustedSentence(job, i, attempts, reason);
    if (job.consecFail >= EXHAUSTED_SENTENCES_MEANING_A_BROKEN_ENGINE) {
      return `the TTS engine is failing repeatedly — ${job.consecFail} sentences in a row used up all `
        + `${ATTEMPTS_PER_SENTENCE} attempts with none rendering in between. The last said: ${reason}`;
    }
    return null;
  }

  /**
   * A sentence that has used up every attempt: file its BEST take, or record
   * that it has none.
   *
   * THE RULING (Owen, 2026-09-18): *"Let's just use the best version of it if it
   * fails 3 times. But that's never happened as far as I can remember. Record
   * what failed and when so we can review later."*
   *
   * Until that day this wrote 0.3 s of silence, set `coverage[i]`, and let the
   * book assemble as finished — a sentence the listener never hears, in an m4b
   * that records nothing about it, under a cue that displays its text. There is
   * no silence pad here now and none anywhere else: a sentence is either audio
   * the engine produced or a hole the job refuses to ship.
   */
  private async settleExhaustedSentence(
    job: Job, i: number, attempts: number, reason: string,
  ): Promise<void> {
    const takes = job.candidates.get(i) || [];
    job.candidates.delete(i);

    if (takes.length === 0) {
      const why = `${attempts} attempts produced no audio at all; the last said: ${reason}`;
      job.unrenderable.set(i, why);
      console.warn(`[book-render] sentence ${i} gave up after ${why}`);
      await this.recordFailure(job, {
        sentence: i, at: new Date().toISOString(), settled: 'no-audio',
        candidates: 0, reason: why,
      });
      return;
    }

    const expected = await this.expectedSeconds(job, i);
    if (typeof expected !== 'number') {
      // IT DOES NOT CHOOSE WITHOUT THE MEASUREMENT. Picking the longest, the
      // first, or the one nearest the others would each be a different book, and
      // none of them is the criterion the ruling names.
      const why = `${takes.length} take(s) survived ${attempts} attempts and there is no expected `
        + `length to choose between them: ${expected.refused}. The takes measured `
        + `${takes.map((t) => `${t.seconds.toFixed(3)} s (attempt ${t.attempt})`).join(', ')}.`;
      job.unrenderable.set(i, why);
      console.error(`[book-render] sentence ${i}: ${why}`);
      await this.recordFailure(job, {
        sentence: i, at: new Date().toISOString(), settled: 'no-expected-length',
        candidates: takes.length, reason: why,
      });
      return;
    }

    const best = bestOfTakes(takes, expected);
    await this.fileTake(job, i, best);
    const why = `closest of ${takes.length} take(s) to the ${expected.toFixed(3)} s this sentence's `
      + `${job.plan.sentences[i].length} characters should take at the voice's pace`;
    console.warn(`[book-render] sentence ${i} gave up after ${attempts} attempts (${reason}) — `
      + `attempt ${best.attempt}'s ${best.seconds.toFixed(3)} s take is filed: ${why}`);
    await this.recordFailure(job, {
      sentence: i, at: new Date().toISOString(), settled: 'best-of',
      candidates: takes.length, chosenAttempt: best.attempt, reason: why,
    });
  }

  /**
   * HOW LONG SENTENCE `i` SHOULD BE, in seconds — or the reason there is no
   * such number, which is a refusal and never a default.
   *
   * The expectation is `chars ÷ the voice's pace`, narrator's own arithmetic
   * (`python/narrator/engine/higgs/truncation.py`). THE PACE HAS ONE OWNER AND
   * IT IS THE MACHINE THAT WILL SPEAK: a Crucible states `pace_chars_per_sec`
   * with the two band edges on its `GET /v1/voices` row, which is the ruling
   * `electron/crucible/voice-band.ts` is ("the numbers it packs to belong to the
   * server that will speak them"). It reaches here through the one member of
   * `StreamingEngine` that states a voice's numbers — `statedChunkCaps`, which
   * carries the three rates beside the three lengths since 2026-09-18, because
   * `electron/crucible/stream.ts` had them in the `bandFromVoiceRow` result all
   * along and dropped them on the way out.
   *
   * THE VOICE THAT STATES NO PACE IS STILL REFUSED, and that is a fact about the
   * wire rather than a policy. narrator centres such a band on the geometric
   * mean of its OWN default edges (`truncation.expected_chars_per_sec` over
   * `HiggsV3Defaults.MAX_CHARS_PER_SEC` / `MIN_CHARS_PER_SEC`,
   * `python/narrator/engine/higgs/v3_engine.py`) — and a Crucible publishes
   * those two numbers on no route at all: `GET /v1/voices` carries each voice's
   * own measured rates (required of every manifest, `crucible/voices.py`
   * `_check_pace`) and `GET /v1/info` carries no band. So there is nothing to
   * READ, and writing the mean here would make this file a second owner of a
   * number measured in narrator — the exact shape `voice-band.ts` was written to
   * end. The consequence is stated rather than hidden: such a sentence is
   * refused by name with its takes listed, and the job fails.
   */
  private async expectedSeconds(job: Job, i: number): Promise<number | { refused: string }> {
    const pace = await this.statedPace(job);
    if (typeof pace !== 'number') return pace;
    return expectedSentenceSeconds(job.plan.sentences[i].length, pace);
  }

  /**
   * The voice's pace in characters per second, or the reason there is none.
   * THE ONE PLACE that fact is asked for — see `expectedSeconds` above for whose
   * it is and why a voice that states none is refused rather than averaged.
   *
   * ASKED AT THE SETTLEMENT, of the voice this job is rendering in, because a
   * mid-render voice switch applies to later sentences (`worker` re-reads it per
   * iteration) and the pace has to be the speaking voice's.
   *
   * ASKED ONCE PER (RUN, VOICE), NOT ONCE PER SETTLEMENT. A voice's pace is a
   * measured fact about weights a server is holding and does not move while a
   * book is being rendered in it — but the ask does not stop at the engine's
   * cached `serverRows`: the venue-routed facade takes the cold-start venue
   * decision (`decideWhereGenerationRuns`, which pings) on the way through, and
   * a cleared `serverRows` re-fetches `GET /v1/voices`. A run that settles forty
   * sentences did all of that forty times for one number. The refusals are NOT
   * kept: they are failures to reach the venue, and the next settlement asks
   * again.
   *
   * A REFUSAL FROM THE ENGINE BECOMES THIS REFUSAL, quoted, rather than a throw.
   * The caller is `settleExhaustedSentence`, which runs inside `noteFailedAttempt`
   * — itself called from `worker`'s own catch — so a throw here would re-enter
   * that catch, and an escape past it rejects the `Promise.all` in `runLoops`,
   * killing every worker and losing the settlement this call exists to make. The
   * engine's own words are carried into the record instead, which is where a
   * reviewer reads them.
   */
  private async statedPace(job: Job): Promise<number | { refused: string }> {
    const voice = job.state.voice || getDefaultStreamVoice();
    const known = job.statedPace;
    if (known !== null && known.voice === voice) return known.paceCharsPerSec;
    const engine = getActiveEngine();
    const whose = 'The pace is the rendering machine\'s (electron/crucible/voice-band.ts) and travels '
      + 'on its `GET /v1/voices` row as `pace_chars_per_sec`. narrator\'s own no-pace centre is the '
      + 'geometric mean of HiggsV3Defaults\' default band edges, which a Crucible publishes on no '
      + 'route, so there is nothing to read here instead and nothing is copied. The sentence is '
      + 'therefore not settled on a guess';
    if (typeof engine.statedChunkCaps !== 'function') {
      return {
        refused: `the streaming engine states no numbers at all for voice "${voice}" — it has no `
          + `statedChunkCaps. ${whose}`,
      };
    }
    let stated: Awaited<ReturnType<NonNullable<StreamingEngine['statedChunkCaps']>>>;
    try {
      stated = await engine.statedChunkCaps(voice);
    } catch (err) {
      return {
        refused: `asking the streaming engine what it states for voice "${voice}" was refused: `
          + `${err instanceof Error ? err.message : String(err)}. ${whose}`,
      };
    }
    if (stated === null) {
      return {
        refused: `the streaming engine has no venue bound, so nothing states a pace for voice `
          + `"${voice}" yet (statedChunkCaps resolved null). ${whose}`,
      };
    }
    if (stated.paceCharsPerSec === null) {
      return {
        refused: `the engine states a band for voice "${voice}" but states no pace in it `
          + '(all three rates are null, which is how an unmeasured voice states them — narrator '
          + `reads all three or none too). ${whose}`,
      };
    }
    job.statedPace = { voice, paceCharsPerSec: stated.paceCharsPerSec };
    return stated.paceCharsPerSec;
  }

  /** File a take as sentence `i`: its bytes, its duration, its rate, and the
   *  end of its sentence's candidacy. The one place a rendered sentence becomes
   *  a covered one. */
  private async fileTake(job: Job, i: number, take: SentenceTake): Promise<void> {
    await fs.writeFile(sentenceFile(job.projectId, i), take.wav);
    job.state.sampleRate = take.sampleRate;
    job.state.coverage[i] = true;
    job.state.durations[i] = take.seconds;
    job.candidates.delete(i);
  }

  /** Keep one failed attempt's audio until its sentence settles. */
  private keepTake(job: Job, i: number, take: SentenceTake): void {
    const takes = job.candidates.get(i);
    if (takes === undefined) job.candidates.set(i, [take]);
    else takes.push(take);
  }

  /** The sentences that have no audio and why, as the job's error. */
  private describeUnrenderable(job: Job): string {
    const named = [...job.unrenderable.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, why]) => `sentence ${i} (${why})`);
    return `the render did not finish: ${named.length} sentence(s) have no audio, so the book is not `
      + `assembled — ${named.join('; ')}. Every attempt is recorded in ${failuresPath(job.projectId)}.`;
  }

  /**
   * One line of `failures.jsonl`, appended.
   *
   * ONE APPEND AT A TIME, for `maybePersist`'s reason: `width` workers write
   * this file and two interleaved writes to one path make a line that is not
   * JSON. Chaining each append onto the last serialises them, and an append is
   * the whole record in ONE `appendFile` call, so a crash can lose the tail of
   * the file but never split a record down the middle — which is the property
   * `atomicWriteFile` gives state.json, in the shape an append-only log can have
   * it (rewriting the whole log to replace it atomically would grow with the
   * book and is not what "atomic" buys here).
   *
   * A failed append is NOT a failed render — the sentences and the state are on
   * disk either way — but it is never silent, because a review log nobody can
   * read is the defect this file exists to end.
   */
  private async recordFailure(job: Job, record: Record<string, unknown>): Promise<void> {
    job.state.failures = (job.state.failures || 0) + 1;
    const line = JSON.stringify(record) + '\n';
    const append = job.recording
      .catch(() => { /* already reported by the call that made it */ })
      .then(() => fs.appendFile(failuresPath(job.projectId), line, 'utf-8'));
    job.recording = append;
    await append.catch((err) => {
      console.error(`[book-render] could not record a failure in ${failuresPath(job.projectId)}:`, err);
    });
  }

  /**
   * Persist state.json, at most every PERSIST_INTERVAL_MS unless forced.
   *
   * ONE WRITE AT A TIME, AND EACH ONE ALL OR NOTHING.
   *
   * `width` workers call this from their own `finally`, and the interval gate
   * is a check-then-set with an await after it: on a slow or contended disk a
   * second worker passes the gate while the first write is still in flight, and
   * two in-place writes to one path can interleave. Chaining each write onto
   * the last serialises them, and `atomicWriteFile` — the library's, so there
   * is one owner of the temp-then-rename — means a crash mid-write leaves the
   * PREVIOUS state.json rather than a truncated one, which `loadState` reads as
   * null and the whole book re-renders from zero.
   */
  private async maybePersist(job: Job, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - job.lastPersist < PERSIST_INTERVAL_MS) return;
    job.lastPersist = now;
    job.state.updatedAt = now;
    const write = job.persisting
      .catch(() => { /* already reported by the call that made it */ })
      .then(() => atomicWriteFile(statePath(job.projectId), JSON.stringify(job.state)));
    job.persisting = write;
    // A failed persist is not a failed render — the sentences are on disk and
    // the next persist writes the whole state again — but it is never silent.
    await write.catch((err) => {
      console.error(`[book-render] could not persist ${statePath(job.projectId)}:`, err);
    });
  }

  // ─── Assembly (Phase G) ──────────────────────────────────────────────────────
  //
  // `silentWav` used to live here — a pad written in place of a sentence the
  // engine could not render. Owen ruled on 2026-09-18 that a thrice-failed
  // sentence keeps its best TAKE and, having none, fails the job by name, so
  // nothing in this service needs a pad any more and the function is gone (it
  // had no other caller: grep `silentWav`).

  private async assemble(job: Job): Promise<void> {
    job.assembling = true;
    await this.maybePersist(job, true);
    try {
      const outputDir = path.join(getProjectPath(job.projectId), 'output');
      await fs.mkdir(outputDir, { recursive: true });
      const base = this.safeBase(job.plan.title);
      const m4bPath = path.join(outputDir, `${base}.m4b`);
      // Embed-only: build the VTT to a TEMP file (render dir, cleaned up), embed it
      // INTO the m4b below — no sidecar is ever written to output/.
      const tmpVtt = path.join(renderDir(job.projectId), 'transcript.vtt');

      // Cumulative timeline from per-sentence durations → chapters + VTT.
      await fs.writeFile(tmpVtt, this.buildVtt(job));
      const metaPath = path.join(renderDir(job.projectId), 'chapters.ffmeta');
      await fs.writeFile(metaPath, this.buildFfmeta(job));
      const listPath = path.join(renderDir(job.projectId), 'concat.txt');
      await fs.writeFile(listPath, this.buildConcatList(job));

      await this.runFfmpeg([
        '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-i', metaPath, '-map_metadata', '1', '-map_chapters', '1',
        '-c:a', 'aac', '-b:a', '128k',
        m4bPath,
      ]);

      // Seal the transcript INTO the m4b (embed-only). On embed failure we finish the
      // audio WITHOUT a transcript (loud error) rather than leaving an untrusted
      // sidecar. The temp VTT is always discarded so nothing leaks to output/.
      try {
        const embedded = await embedAndVerifyVtt(m4bPath, tmpVtt, { language: job.plan.language });
        if (!embedded) console.error('[book-render] embed verify failed — audiobook has no transcript:', m4bPath);
      } catch (embedErr) {
        console.error('[book-render] embed transcript failed — audiobook has no transcript:', embedErr);
      } finally {
        await fs.rm(tmpVtt, { force: true }).catch(() => { /* ignore */ });
      }
      await registerAudiobookOutput(m4bPath, { professionallyRead: false });

      // DONE IS THE LAST THING WRITTEN, because `done` is what refuses to run
      // the job again: both start() and runLoops require `!done`. It used to be
      // set and PERSISTED before the register call, so a manifest write that
      // threw — the known concurrent-library hazard — left an m4b on disk that
      // no page listed and no run could produce again without hand-editing
      // state.json.
      job.state.m4bPath = m4bPath;
      job.state.done = true;
      await this.maybePersist(job, true);

      // Reclaim the raw sentence WAVs — the m4b is the durable artifact now.
      await fs.rm(sentencesDir(job.projectId), { recursive: true, force: true }).catch(() => { /* ignore */ });
      console.log(`[book-render] assembled ${m4bPath}`);
    } catch (err) {
      // The poller reads job.error and nothing else here reaches it: without
      // this, status() reported rendered === total, done false, assembling
      // false and no error — a progress bar stopped at 100% with nothing to say.
      job.error = `assembly failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[book-render] assembly failed:', err);
    } finally {
      job.assembling = false;
      if (this.active === job.projectId) this.active = null;
    }
  }

  private safeBase(title: string): string {
    return (title || 'audiobook').replace(/[^\w.-]+/g, '_').slice(0, 100) || 'audiobook';
  }

  private buildConcatList(job: Job): string {
    // ffmpeg concat demuxer: one `file '<abs>'` per sentence, in reading order.
    const lines: string[] = [];
    for (let i = 0; i < job.plan.sentences.length; i++) {
      const p = sentenceFile(job.projectId, i).replace(/\\/g, '/').replace(/'/g, "'\\''");
      lines.push(`file '${p}'`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * How long sentence `i` plays, from what the render recorded when it filed the
   * audio — or a refusal naming the sentence.
   *
   * THERE IS NO STAND-IN DURATION. Both timelines below are CUMULATIVE, so the
   * 0.3 s that used to stand in for an unmeasured sentence did not mistime that
   * one cue: it slid every cue and every chapter mark after it, by the
   * difference, to the end of the book, and said so nowhere. With the silence
   * pad gone (Owen's ruling of 2026-09-18 — a thrice-failed sentence keeps its
   * best take or the book does not ship) a 0 here no longer means "a pad went in
   * for this one": it means a sentence is marked covered whose audio nothing
   * measured — its file was not on disk for `loadOrBuild` to read back — and a
   * book in that state is not one to assemble.
   */
  private sentenceSeconds(job: Job, i: number): number {
    const seconds = job.state.durations[i];
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(
        `sentence ${i} of ${job.plan.sentences.length} is covered but has no duration `
        + `(durations[${i}] is ${String(seconds)}), so the timeline cannot be built: nothing measured `
        + `${sentenceFile(job.projectId, i)}.`);
    }
    return seconds;
  }

  private buildVtt(job: Job): string {
    let t = 0;
    const cues: string[] = ['WEBVTT', ''];
    for (let i = 0; i < job.plan.sentences.length; i++) {
      const dur = this.sentenceSeconds(job, i);
      cues.push(`${vttTimestamp(t)} --> ${vttTimestamp(t + dur)}`, job.plan.sentences[i], '');
      t += dur;
    }
    return cues.join('\n');
  }

  private buildFfmeta(job: Job): string {
    // Chapter marks at chapter boundaries, timebase in milliseconds.
    const lines: string[] = [';FFMETADATA1'];
    let t = 0;                         // running seconds
    let chapStart = 0;                 // ms
    let curChap = job.plan.chapterOf[0] ?? 0;
    const endChapter = (endSec: number, chapterIdx: number) => {
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000',
        `START=${Math.round(chapStart)}`, `END=${Math.round(endSec * 1000)}`,
        `title=${(job.plan.chapterTitles[chapterIdx] || `Chapter ${chapterIdx + 1}`).replace(/\n/g, ' ')}`);
    };
    for (let i = 0; i < job.plan.sentences.length; i++) {
      const chap = job.plan.chapterOf[i] ?? curChap;
      if (chap !== curChap) { endChapter(t, curChap); chapStart = t * 1000; curChap = chap; }
      t += this.sentenceSeconds(job, i);
    }
    endChapter(t, curChap);
    return lines.join('\n') + '\n';
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      // Only the tail is ever quoted, so only the tail is kept: an m4b encode
      // runs for hours and writes a progress line a second, and all of it used
      // to be concatenated into one string to read 800 characters off the end.
      let err = '';
      proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-FFMPEG_STDERR_KEPT); });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)));
    });
  }
}

export const bookRenderService = new BookRenderService();
