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
import { getProjectPath, registerAudiobookOutput } from './manifest-service';
import { splitForTts } from './bilingual-processor';
import { getFfmpegPath } from './tool-paths';

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
  updatedAt: number;
}

interface Job {
  projectId: string;
  plan: RenderPlan;
  state: RenderState;
  running: boolean;
  inFlight: Set<number>;
  assembling: boolean;
  lastPersist: number;
  /** Per-sentence failure counts — a sentence gets a few attempts before the
   *  silence fallback, so one flaky generation doesn't punch a hole in the book. */
  retries: Map<number, number>;
  /** Consecutive failures across the whole job. A run of these means the ENGINE
   *  is broken (model not loaded, worker died), not the text — abort instead of
   *  "rendering" the rest of the book as silence. */
  consecFail: number;
  error?: string;
}

// Fallback in-flight width when the engine doesn't report one. At runtime we ask
// the engine (engine.getMaxConcurrentSentences — Orpheus's fixed batch width, or
// XTTS's worker count) so a batching engine gets FULL batches: with only 2 in
// flight, Orpheus's batch-4 graph ran half-empty and throughput halved.
const FALLBACK_CONCURRENCY = 2;
const PERSIST_INTERVAL_MS = 1500;

function renderDir(projectId: string): string { return path.join(getProjectPath(projectId), 'render'); }
function sentencesDir(projectId: string): string { return path.join(renderDir(projectId), 'sentences'); }
function planPath(projectId: string): string { return path.join(renderDir(projectId), 'plan.json'); }
function statePath(projectId: string): string { return path.join(renderDir(projectId), 'state.json'); }
function sentenceFile(projectId: string, i: number): string { return path.join(sentencesDir(projectId), `${i}.wav`); }

/**
 * Write render/plan.json from the editor's flat blocks. Chapter-start blocks head
 * a new chapter AND are spoken as its first sentence, so nothing is dropped and the
 * plan matches exactly what the reader shows. Called by the import finalize step.
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
    const text = (raw.text || '').replace(/\s+/g, ' ').trim();
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
  await fs.writeFile(planPath(projectId), JSON.stringify(plan));
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
      void this.runLoops(job);
    }
    return { ok: true, total: job.plan.sentences.length };
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
    for (let i = 0; i < plan.sentences.length; i++) {
      if (!state.coverage[i] && fsSync.existsSync(sentenceFile(projectId, i))) state.coverage[i] = true;
    }

    return { projectId, plan, state, running: false, inFlight: new Set(), assembling: false, lastPersist: 0, retries: new Map(), consecFail: 0 };
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
        const text = (block || '').replace(/\s+/g, ' ').trim();
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

  private async runLoops(job: Job): Promise<void> {
    try {
      const engine = getActiveEngine();
      if (!engine.isSessionActive()) {
        const started = await engine.startSession();
        if (!started.success) { job.error = started.error || 'TTS engine failed to start'; job.running = false; return; }
      }
      // startSession only brings the worker PROCESS up — the model itself loads
      // on loadVoice(), and generateSentence before that fails "Model not loaded".
      const loaded = await engine.loadVoice(job.state.voice || getDefaultStreamVoice());
      if (!loaded.success) { job.error = loaded.error || 'voice failed to load'; job.running = false; return; }
      job.error = undefined;
      // Fastest first audio: render the playhead sentence ALONE at priority before
      // going wide. A batch-of-1 lands in a few seconds; the first full batch-of-4
      // would make the listener wait for all four sentences before hearing anything.
      await this.renderFirst(job);
      // In-flight width from the engine: Orpheus reports its fixed batch width (a
      // partial batch wastes the warmed MLX graph), XTTS its worker count.
      const width = Math.max(1, engine.getMaxConcurrentSentences?.() ?? engine.getWorkerCount() ?? FALLBACK_CONCURRENCY);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < width; w++) workers.push(this.worker(job));
      await Promise.all(workers);
    } catch (err) {
      console.error('[book-render] loop error:', err);
    } finally {
      job.running = false;
      if (this.allCovered(job) && !job.state.done && !job.assembling) {
        await this.assemble(job);
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
        const buf = Buffer.from(result.audio.data, 'base64');
        await fs.writeFile(sentenceFile(job.projectId, i), buf);
        job.state.coverage[i] = true;
        job.state.durations[i] = result.audio.duration || this.wavSeconds(buf);
      }
    } catch { /* retried by the wide loop */ } finally {
      job.inFlight.delete(i);
      await this.maybePersist(job, true);
    }
  }

  private async worker(job: Job): Promise<void> {
    const engine = getActiveEngine();
    while (job.running && this.active === job.projectId) {
      const i = this.nextIndex(job);
      if (i < 0) break; // nothing left to render
      // Read per-iteration so a mid-render voice switch applies to later sentences.
      const voice = job.state.voice || getDefaultStreamVoice();
      job.inFlight.add(i);
      try {
        const result = await engine.generateSentence(job.plan.sentences[i], i, { voice, speed: 1.0 }, false);
        if (result.success && result.audio) {
          const buf = Buffer.from(result.audio.data, 'base64');
          await fs.writeFile(sentenceFile(job.projectId, i), buf);
          job.state.coverage[i] = true;
          job.state.durations[i] = result.audio.duration || this.wavSeconds(buf);
          job.consecFail = 0;
        } else {
          console.warn(`[book-render] sentence ${i} failed: ${result.error || 'unknown'}`);
          job.consecFail++;
          if (job.consecFail >= 5) {
            // A run of failures means the ENGINE is broken, not the text. Abort
            // and surface the error instead of rendering the book as silence.
            job.error = result.error || 'TTS engine is failing repeatedly';
            job.running = false;
            break;
          }
          const attempts = (job.retries.get(i) || 0) + 1;
          job.retries.set(i, attempts);
          if (attempts >= 3) {
            // This one sentence is genuinely bad — a short silence keeps the
            // assembly timeline aligned without wedging the whole book.
            await fs.writeFile(sentenceFile(job.projectId, i), this.silentWav(0.3));
            job.state.coverage[i] = true;
            job.state.durations[i] = 0.3;
          } else {
            await new Promise((r) => setTimeout(r, 300)); // leave uncovered — retried later
          }
        }
      } catch (err) {
        console.error(`[book-render] sentence ${i} threw:`, err);
        await new Promise((r) => setTimeout(r, 500)); // transient — retry this index later
      } finally {
        job.inFlight.delete(i);
        await this.maybePersist(job);
      }
    }
  }

  private async maybePersist(job: Job, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - job.lastPersist < PERSIST_INTERVAL_MS) return;
    job.lastPersist = now;
    job.state.updatedAt = now;
    try { await fs.writeFile(statePath(job.projectId), JSON.stringify(job.state)); } catch { /* best effort */ }
  }

  // ─── WAV helpers ─────────────────────────────────────────────────────────────

  private wavSeconds(buf: Buffer): number {
    // 24kHz mono 16-bit → 48000 bytes/sec after the 44-byte header.
    return Math.max(0, (buf.length - 44) / 48000);
  }

  private silentWav(seconds: number): Buffer {
    const bytes = Math.floor(seconds * 48000) & ~1;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4);
    header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(bytes, 40);
    return Buffer.concat([header, Buffer.alloc(bytes)]);
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
      const vttPath = path.join(outputDir, 'subtitles.vtt');

      // Cumulative timeline from per-sentence durations → chapters + VTT.
      await fs.writeFile(vttPath, this.buildVtt(job));
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

      job.state.m4bPath = m4bPath;
      job.state.done = true;
      await this.maybePersist(job, true);
      await registerAudiobookOutput(m4bPath);

      // Reclaim the raw sentence WAVs — the m4b is the durable artifact now.
      await fs.rm(sentencesDir(job.projectId), { recursive: true, force: true }).catch(() => { /* ignore */ });
      console.log(`[book-render] assembled ${m4bPath}`);
    } catch (err) {
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
    const fmt = (sec: number): string => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    };
    let t = 0;
    const cues: string[] = ['WEBVTT', ''];
    for (let i = 0; i < job.plan.sentences.length; i++) {
      const dur = job.state.durations[i] || 0.3;
      cues.push(`${fmt(t)} --> ${fmt(t + dur)}`, job.plan.sentences[i], '');
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
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)));
    });
  }
}

export const bookRenderService = new BookRenderService();
