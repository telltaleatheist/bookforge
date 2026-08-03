/**
 * blocks-run — a classification run that outlives the window that started it.
 *
 * Detect used to be a `for` loop inside pdf-picker.component.ts. That made the
 * renderer the run's owner, and the renderer is the one part of the app that
 * gets thrown away routinely: `ng serve` reloads it on every edit under src/,
 * and a reload wipes the loop, the accumulated predictions and the progress
 * counter. Ollama, meanwhile, noticed nothing — it finished the request in
 * flight, kept the model resident, and answered into a void. Half an hour of a
 * long book went with the reload.
 *
 * So the run lives here, in main, which a renderer reload does not touch. The
 * renderer hands over the prompts once, then only watches:
 *
 *   run-start    hand over the encoded pages; main works the queue
 *   run-attach   "is there a run for this book?" -> full state, replayed
 *   run-cancel   stop it
 *
 * After a reload the fresh renderer attaches, gets every answer collected so
 * far, paints them, and follows the rest live. Nothing is re-asked.
 *
 * WHAT THIS DOES NOT DO is understand the answers. Main still moves opaque
 * strings — the prompt format and its parser are owned by
 * src/app/features/pdf-picker/services/blocks-encoder.ts and exist exactly
 * once, because a fine-tune only performs on the format it was trained on. So a
 * run accumulates ANSWER TEXT keyed by page, and the renderer parses it on
 * arrival and again on attach. Storing parsed predictions here would have put a
 * second parser in the codebase, which is the failure this architecture is
 * shaped to prevent.
 *
 * Tests: `node tools/test-blocks-run.js` after building. They stub the bridge,
 * so they cost no GPU time, and they cover the things watching a real run cannot
 * show you — that a resumed run does not re-ask, and that answers never land on
 * pages they were not about.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  blocksClassify,
  BlocksBackend,
} from './blocks-bridge';
import { boundedRunKey } from './path-utils';

/** One page's prompt, plus enough identity to key its answer. */
export interface BlocksRunPage {
  /** Page index, for the renderer's own bookkeeping. */
  page: number;
  system: string;
  user: string;
  /** The fully-templated prompt. Required — see classifyViaOllama. */
  raw: string;
}

export interface BlocksRunStart {
  /**
   * Book identity. The renderer passes the file hash, and this is how a fresh
   * renderer finds the run again — so it must be the same string across a
   * reload, which rules out anything minted per session.
   */
  bookKey: string;
  endpoint: string;
  backend: BlocksBackend;
  model: string;
  /** What the service reported it had loaded, recorded for the run log. */
  adapter: string;
  stop?: string;
  numCtx?: number;
  /** Pages per request. Progress moves at this granularity. */
  chunk?: number;
  pages: BlocksRunPage[];
}

export type BlocksRunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** What a watcher sees. Carries no prompts — those are large and write-only. */
export interface BlocksRunState {
  bookKey: string;
  status: BlocksRunStatus;
  /**
   * Whether a worker is actually behind this state right now.
   *
   * The distinction the renderer acts on. `live` means main is still
   * classifying and the renderer only has to watch — the reload case. Not
   * `live` with `status: 'running'` means the app died mid-run and this is what
   * reached disk: real answers worth painting, but NOTHING is working on them,
   * and resuming would load several GB of model. That has to be the user's
   * decision, not a side effect of opening a book.
   */
  live: boolean;
  model: string;
  adapter: string;
  total: number;
  /** Pages answered. Also the resume point. */
  done: number;
  /**
   * Answer text by page index, `null` where not yet answered. The renderer
   * parses these; see the file header for why main does not.
   */
  answers: (string | null)[];
  error?: string;
  startedAt: number;
  updatedAt: number;
}

/** Emitted after each chunk, so a watcher paints without polling. */
export interface BlocksRunProgress {
  bookKey: string;
  status: BlocksRunStatus;
  done: number;
  total: number;
  error?: string;
  /** Only the answers this chunk produced, so the message stays small. */
  answered: Array<{ index: number; answer: string }>;
}

interface Run {
  /**
   * Everything but `live` — that is derived in `snapshot`, so there is no stored
   * copy of it to fall out of step with whether the worker is actually running.
   */
  state: Omit<BlocksRunState, 'live'>;
  pages: BlocksRunPage[];
  /** Prompt shape, so a resumed run cannot graft answers onto other pages. */
  fingerprint: string;
  endpoint: string;
  backend: BlocksBackend;
  stop?: string;
  numCtx?: number;
  chunk: number;
  cancelled: boolean;
  /** The worker, so `runningCount` is honest and quit can await it. */
  loop?: Promise<void>;
}

const runs = new Map<string, Run>();

type Emit = (progress: BlocksRunProgress) => void;
let emit: Emit = () => {};
let stateDir: string | null = null;

/**
 * Wire the manager to the app: where to persist, and how to reach watchers.
 * Called once from main, so this module needs no `electron` import and stays
 * usable from a plain node process.
 */
export function blocksRunInit(options: { stateDir: string; emit: Emit }): void {
  stateDir = options.stateDir;
  emit = options.emit;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    // Persistence is a bonus (it buys resume across a full app restart); a run
    // works entirely from memory without it, so this must not be fatal.
    stateDir = null;
  }
}

/**
 * One file per book. The key is the PATH of the document the run reads, so it is
 * sanitized, length-bounded and de-collided by `boundedRunKey` — the same naming
 * the foundry run directories use. Sanitizing alone is not enough: a path inside
 * a synced library runs past the 255-byte limit on one filesystem component, and
 * truncating it makes a project's PDF and its exported EPUB the same file.
 */
function statePath(bookKey: string): string | null {
  if (!stateDir) return null;
  return path.join(stateDir, `${boundedRunKey(bookKey)}.json`);
}

/**
 * Identity of the QUESTION, not of the answers: the page count and the per-page
 * prompt text. A saved run is only resumable by a re-encode that asks the model
 * exactly the same thing — edit a block, re-run OCR, or switch encoder version
 * and the fingerprint moves, so the stale answers are discarded instead of being
 * pinned onto pages they were never about.
 */
function fingerprintOf(pages: BlocksRunPage[]): string {
  const h = crypto.createHash('sha1');
  h.update(String(pages.length));
  for (const p of pages) { h.update('\0'); h.update(p.raw); }
  return h.digest('hex');
}

function persist(run: Run): void {
  const file = statePath(run.state.bookKey);
  if (!file) return;
  try {
    // Prompts are deliberately absent: they are ~25 KB a page and the renderer
    // can always re-encode them from the blocks. Only the answers are
    // irreplaceable, because reproducing one costs a GPU-second.
    fs.writeFileSync(file, JSON.stringify({
      fingerprint: run.fingerprint,
      model: run.state.model,
      adapter: run.state.adapter,
      status: run.state.status,
      total: run.state.total,
      done: run.state.done,
      answers: run.state.answers,
      error: run.state.error,
      startedAt: run.state.startedAt,
      updatedAt: run.state.updatedAt,
    }));
  } catch {
    // Same reasoning as in init: losing the ability to resume across a restart
    // must not take down the run that is currently working.
  }
}

function readPersisted(bookKey: string): {
  fingerprint: string; model: string; adapter: string; total: number; done: number;
  answers: (string | null)[]; startedAt: number;
} | null {
  const file = statePath(bookKey);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw.answers) || typeof raw.fingerprint !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Start a run, or pick up where an interrupted one left off.
 *
 * Resumption is by FINGERPRINT, never by book key alone. Three cases:
 *   - a run for this book is already working and asking the same question:
 *     joined, not restarted. Two windows watching one run is the normal case
 *     during a reload race.
 *   - the same question was answered partway before the app died: the saved
 *     answers are adopted and work continues from `done`.
 *   - anything else: a fresh run, and the old answers are dropped.
 */
export function blocksRunStart(req: BlocksRunStart): BlocksRunState {
  if (!req.pages?.length) throw new Error('no pages to classify');
  for (const p of req.pages) {
    if (!p.raw) throw new Error(`page ${p.page} has no templated prompt`);
  }
  const fingerprint = fingerprintOf(req.pages);

  const live = runs.get(req.bookKey);
  if (live && live.state.status === 'running' && live.fingerprint === fingerprint) {
    return snapshot(live);
  }
  if (live && live.state.status === 'running') {
    // A different question for the same book — the old run's answers are about
    // pages that no longer exist as asked, so it is stopped rather than raced.
    live.cancelled = true;
  }

  const saved = readPersisted(req.bookKey);
  const resumable = saved
    && saved.fingerprint === fingerprint
    && saved.model === req.model
    && saved.total === req.pages.length
    && saved.answers.length === req.pages.length
    && saved.done < req.pages.length;

  const run: Run = {
    state: {
      bookKey: req.bookKey,
      status: 'running',
      model: req.model,
      adapter: req.adapter,
      total: req.pages.length,
      done: resumable ? saved!.done : 0,
      answers: resumable ? saved!.answers.slice() : new Array(req.pages.length).fill(null),
      startedAt: resumable ? saved!.startedAt : Date.now(),
      updatedAt: Date.now(),
    },
    pages: req.pages,
    fingerprint,
    endpoint: req.endpoint,
    backend: req.backend,
    stop: req.stop,
    numCtx: req.numCtx,
    chunk: Math.max(1, req.chunk ?? 8),
    cancelled: false,
  };
  runs.set(req.bookKey, run);
  run.loop = work(run);
  return snapshot(run);
}

/**
 * The state of the run for a book, if there is one — including a finished or
 * failed one, so a renderer that reloaded after the end still learns the result
 * instead of showing an empty panel.
 *
 * Falls back to what was persisted, which is how the ANSWERS survive a full app
 * restart even though the worker does not. Such a state comes back with
 * `live: false`, which is the renderer's cue to paint the partial result and
 * wait — a run-start with the same pages then resumes from `done` rather than
 * re-asking, whenever the user asks for it.
 */
export function blocksRunAttach(bookKey: string): BlocksRunState | null {
  const live = runs.get(bookKey);
  if (live) return snapshot(live);
  const saved = readPersisted(bookKey);
  if (!saved) return null;
  return {
    bookKey,
    status: saved.done >= saved.total ? 'done' : 'running',
    // Nothing is working on it — the worker died with the process that wrote
    // this. See `live`.
    live: false,
    model: saved.model,
    adapter: saved.adapter,
    total: saved.total,
    done: saved.done,
    answers: saved.answers,
    startedAt: saved.startedAt,
    updatedAt: Date.now(),
  };
}

export function blocksRunCancel(bookKey: string): { cancelled: boolean } {
  const run = runs.get(bookKey);
  if (!run || run.state.status !== 'running') return { cancelled: false };
  run.cancelled = true;
  return { cancelled: true };
}

/** Cancel everything and wait for the in-flight chunks. Used on quit. */
export async function blocksRunCancelAll(): Promise<void> {
  const loops: Promise<void>[] = [];
  for (const run of runs.values()) {
    if (run.state.status !== 'running') continue;
    run.cancelled = true;
    if (run.loop) loops.push(run.loop);
  }
  await Promise.all(loops);
}

/** True while any run is working — so quit knows there is something to stop. */
export function blocksRunActive(): boolean {
  for (const run of runs.values()) {
    if (run.state.status === 'running') return true;
  }
  return false;
}

function snapshot(run: Run): BlocksRunState {
  return {
    ...run.state,
    live: run.state.status === 'running',
    answers: run.state.answers.slice(),
  };
}

function publish(run: Run, answered: Array<{ index: number; answer: string }>): void {
  run.state.updatedAt = Date.now();
  persist(run);
  emit({
    bookKey: run.state.bookKey,
    status: run.state.status,
    done: run.state.done,
    total: run.state.total,
    error: run.state.error,
    answered,
  });
}

/**
 * Work the queue one chunk at a time, from `done` forward.
 *
 * Chunked rather than one request per page because progress and persistence
 * happen between chunks, and chunked rather than one request for the book
 * because a failure on page 300 must not discard 299 pages of answers. On a
 * cancel the chunk in flight is allowed to finish and be recorded — the GPU
 * already paid for it.
 */
async function work(run: Run): Promise<void> {
  try {
    while (run.state.done < run.state.total) {
      if (run.cancelled) {
        run.state.status = 'cancelled';
        publish(run, []);
        return;
      }
      const from = run.state.done;
      const slice = run.pages.slice(from, from + run.chunk);
      const res = await blocksClassify({
        endpoint: run.endpoint,
        backend: run.backend,
        model: run.state.model,
        stop: run.stop,
        numCtx: run.numCtx,
        pages: slice.map(p => ({ system: p.system, user: p.user, raw: p.raw })),
      });
      if (!res.success || !res.answers) {
        run.state.status = 'error';
        run.state.error = res.error ?? 'unknown error';
        publish(run, []);
        return;
      }
      const answered: Array<{ index: number; answer: string }> = [];
      res.answers.forEach((answer, k) => {
        run.state.answers[from + k] = answer;
        answered.push({ index: from + k, answer });
      });
      run.state.done = from + slice.length;
      publish(run, answered);
    }
    run.state.status = 'done';
    publish(run, []);
  } catch (err) {
    run.state.status = 'error';
    run.state.error = err instanceof Error ? err.message : String(err);
    publish(run, []);
  }
}
