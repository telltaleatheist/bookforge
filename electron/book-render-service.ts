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
 *     already-covered sentences.
 *   - Completion: concat the sentence WAVs → AAC m4b with chapter marks + a synced
 *     VTT (from per-sentence durations) → registerAudiobookOutput() so it appears on
 *     the audiobook page.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { spawn } from 'child_process';
import { getActiveEngine, getDefaultStreamVoice, getSelectedEngineName } from './streaming-engine';
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
   *  only honest answer before then — see the silence pad in `worker`. */
  sampleRate?: number;
  updatedAt: number;
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
   *  silence placeholder, so one flaky generation doesn't punch a hole in the
   *  book. */
  retries: Map<number, number>;
  /** Consecutive SENTENCES that used up every attempt, with no sentence
   *  rendering in between. A run of those means the ENGINE is broken (model not
   *  loaded, worker died), not the text — abort instead of "rendering" the rest
   *  of the book as silence.
   *
   *  It counts exhausted sentences and not failed attempts, which is the half
   *  that was missing: until 2026-09-18 every attempt bumped it and the branch
   *  that concluded "this one sentence is bad" never cleared it, so three
   *  attempts on one bad sentence plus two on the next added up to five and a
   *  book with two bad sentences was reported as a broken engine. */
  consecFail: number;
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
 * the real path and read the header back off disk; the service's own two
 * callers are the render loops below.
 */
export async function writeSentenceWav(file: string, audio: AudioChunk): Promise<Buffer> {
  const wav = pcm16Wav(Buffer.from(audio.data, 'base64'), audio.sampleRate);
  await fs.writeFile(file, wav);
  return wav;
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

  /** Public status for the reader's poll. */
  status(projectId: string): {
    exists: boolean; total: number; rendered: number; done: boolean;
    coverage?: boolean[]; playhead?: number; assembling?: boolean; m4b?: boolean; error?: string;
  } {
    const job = this.jobs.get(projectId);
    if (!job) {
      // Could still have on-disk state from a previous run.
      const persisted = this.loadState(projectId);
      if (persisted && persisted.plan) {
        const rendered = persisted.state.coverage.filter(Boolean).length;
        return { exists: true, total: persisted.plan.sentences.length, rendered, done: persisted.state.done,
          coverage: persisted.state.coverage, playhead: persisted.state.playhead, m4b: !!persisted.state.m4bPath };
      }
      return { exists: false, total: 0, rendered: 0, done: false };
    }
    const rendered = job.state.coverage.filter(Boolean).length;
    return {
      exists: true, total: job.plan.sentences.length, rendered, done: job.state.done,
      coverage: job.state.coverage, playhead: job.state.playhead, assembling: job.assembling,
      m4b: !!job.state.m4bPath, error: job.error,
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
        updatedAt: Date.now(),
      };
    }
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
      lastPersist: 0, persisting: Promise.resolve(), retries: new Map(), consecFail: 0,
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
      if (!job.state.coverage[i] && !job.inFlight.has(i)) return i;
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
        if (this.allCovered(job) && !job.state.done && !job.assembling) {
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
      if (result.success && result.audio) {
        const wav = await writeSentenceWav(sentenceFile(job.projectId, i), result.audio);
        job.state.sampleRate = result.audio.sampleRate;
        job.state.coverage[i] = true;
        job.state.durations[i] = result.audio.duration || pcm16WavSeconds(wav);
      }
    } catch { /* retried by the wide loop */ } finally {
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
        if (result.success && result.audio) {
          const wav = await writeSentenceWav(sentenceFile(job.projectId, i), result.audio);
          job.state.sampleRate = result.audio.sampleRate;
          job.state.coverage[i] = true;
          job.state.durations[i] = result.audio.duration || pcm16WavSeconds(wav);
          job.consecFail = 0;
        } else {
          // THE ENGINE'S OWN REASON, CARRIED. `result.error` was read only as a
          // last-ditch substitute for the abort message; a failure that had one
          // and a failure that had none were otherwise the same event here.
          abort = await this.noteFailedAttempt(job, i,
            result.error === undefined ? 'the engine gave no reason' : result.error);
        }
      } catch (err) {
        // A THROW IS A FAILED ATTEMPT LIKE ANY OTHER, and until 2026-09-18 it
        // was the one shape the guard below could not see: this catch logged,
        // slept and went round again without touching consecFail or retries, so
        // an engine that threw on every sentence — a torn-down session, a
        // dropped transport — was retried forever and reported nothing.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[book-render] sentence ${i} threw: ${reason}`);
        abort = await this.noteFailedAttempt(job, i, reason);
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
  private async noteFailedAttempt(job: Job, i: number, reason: string): Promise<string | null> {
    const attempts = (job.retries.get(i) || 0) + 1;
    job.retries.set(i, attempts);
    if (attempts < ATTEMPTS_PER_SENTENCE) {
      await new Promise((r) => setTimeout(r, 300)); // leave uncovered — retried later
      return null;
    }

    job.consecFail++;
    if (job.consecFail >= EXHAUSTED_SENTENCES_MEANING_A_BROKEN_ENGINE) {
      return `the TTS engine is failing repeatedly — ${job.consecFail} sentences in a row used up all `
        + `${ATTEMPTS_PER_SENTENCE} attempts with none rendering in between. The last said: ${reason}`;
    }

    // AWAITING A RULING — the placeholder policy below is unchanged on purpose.
    // What a thrice-failed sentence should BECOME is the operator's call and he
    // has not made it: a 0.3 s pad marked `covered` keeps the timeline aligned
    // and finishes the book, at the cost of a sentence the listener never hears
    // and nothing in the finished m4b records. Only the counting around it was
    // wrong, and only that was fixed (B4 / fix-15, 2026-09-18).
    //
    // The pad is concatenated with the rendered sentences, and ffmpeg's concat
    // demuxer joins STREAMS: a pad at a different sample rate is a format
    // change mid-list, so it is written at the rate the engine reported for
    // this book. Before any sentence has rendered there is no such rate, and
    // the job says so rather than inventing one.
    const rate = job.state.sampleRate;
    if (rate === undefined) {
      return `sentence ${i} failed ${attempts} times before any sentence of this book rendered, so `
        + `there is no engine sample rate for its silence pad to match. The last failure said: ${reason}`;
    }
    await fs.writeFile(sentenceFile(job.projectId, i), this.silentWav(0.3, rate));
    job.state.coverage[i] = true;
    job.state.durations[i] = 0.3;
    console.warn(`[book-render] sentence ${i} gave up after ${attempts} attempts (${reason}) — `
      + '0.3 s of silence stands in for it');
    return null;
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

  // ─── WAV helpers ─────────────────────────────────────────────────────────────

  /** A pad of silence at the book's own rate. The duration maths that used to
   *  live beside this assumed 24 kHz and a header the sentence files did not
   *  have; both facts are read off the file now (pcm16WavSeconds). */
  private silentWav(seconds: number, sampleRate: number): Buffer {
    const bytes = Math.floor(seconds * sampleRate * 2) & ~1;
    return pcm16Wav(Buffer.alloc(bytes), sampleRate);
  }

  // ─── Assembly (Phase G) ──────────────────────────────────────────────────────

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

  private buildVtt(job: Job): string {
    let t = 0;
    const cues: string[] = ['WEBVTT', ''];
    for (let i = 0; i < job.plan.sentences.length; i++) {
      const dur = job.state.durations[i] || 0.3;
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
      t += job.state.durations[i] || 0.3;
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
