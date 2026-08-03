/**
 * foundry-run — the OCR pipeline, owned by MAIN so a reload cannot kill it.
 *
 * This is the third module in this codebase built to the same shape, for the
 * same reason (see `rubric-run.ts` and `corpus-ocr-run.ts`): the renderer is the
 * part of the app that gets thrown away routinely — `ng serve` reloads it on
 * every edit under `src/`, a window closes, a tab changes — and a run that lives
 * in it dies with it. foundry's `ocr` stage costs roughly 0.8 seconds a line,
 * which is about thirty minutes for a 350-page book. That is not work a UI event
 * is allowed to discard.
 *
 * So a run lives here:
 *
 *   start    render the pages, then walk the stages; returns immediately
 *   attach   "is there a run for this book?" -> full state, replayed
 *   cancel   stop it; every artifact already written stays on disk
 *   read     the run directory, mapped into the picker's block model
 *   export   the exclusion list -> `foundry export` -> source/<Book Title>.epub
 *            (wherever manifestService.exportEpubTarget says; the record in
 *            manifest.outputs.epub is the only authority on the name)
 *
 * ── THE STAGE ORDER IS A CONTRACT, NOT A PREFERENCE ──────────────────────────
 *
 *   render → scan → ocr → blocks → [footnotes]
 *
 * `ocr` runs BEFORE `footnotes`. foundry's footnotes stage judges the text that
 * will ship, and its export stage REFUSES a footnotes artifact derived from a
 * different text base (foundry commit 18fff9b). Run footnotes first and every
 * block dagger touched ships its RAW text minus markers — silently discarding
 * that block's OCR corrections, "Miiller" back in the EPUB while ocr/lines.json
 * holds "Müller". The order below is the fix; do not reorder it for symmetry.
 *
 * `footnotes` runs only when a caller names it in `stages`. It is the
 * `foundry-footnotes` pass and nothing else asks for it: removing markers is a
 * judgement about the book rather than a repair to it, so it belongs in the
 * user's pass list, not as an option bolted onto an OCR run.
 *
 * ── RESUME ───────────────────────────────────────────────────────────────────
 *
 * foundry records per-stage status in `run.json`, and every stage reads the
 * previous stage's artifact off disk. So resumption is not something this module
 * invents: it asks the run record which stages are `done` and skips them. That
 * makes a cancelled run cheap to continue and a crashed one cheap to finish.
 *
 * ── WHERE THE RUN DIRECTORY LIVES ────────────────────────────────────────────
 *
 * `~/Documents/BookForge/foundry-runs/<bookKey>/…` — MACHINE-LOCAL, exactly like
 * the page render cache and for the same reason: the library folder is
 * Syncthing-synced, and a run directory is hundreds of megabytes of page rasters
 * and intermediate JSON that mean nothing on another machine. Only the finished
 * EPUB goes into the project.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureFoundryPath,
  foundryBlockText,
  readRunDirectory,
  runFoundry,
  type FoundryBlock,
  type FoundryCalibration,
  type FoundryRunFile,
  type FoundryScanLine,
  type FoundryScanPage,
} from './foundry-bridge';
import { requireFoundryModel, type FoundryModelStage } from './foundry-interim-config';
import { blockCategoryDef, isFoundryCategory } from '../shared/ocr/block-categories';

// `llama-bridge` and `pdf-worker-proxy` are required LAZILY, inside the two
// functions that need them. Both reach `electron`'s `app` through their own
// imports, and keeping them off this module's top level is what lets the reader
// and the exporter — the halves that only touch files — run in a plain node
// process: a test harness, a CLI, a verification script driving a real book
// without opening a window. Same reasoning as foundry-bridge's lazy require of
// component-manager.

/**
 * The dpi foundry's Tesseract is pinned at.
 *
 * Not configurable, and not read from anywhere else in this app: the three
 * models were trained against this Tesseract's segmentation at this resolution,
 * and a different number changes how lines and paragraphs come out without
 * erroring anywhere. foundry records the dpi it was given in `run.json`, so a
 * mismatch is at least *provable* after the fact — but it is not preventable
 * from over there, which is why it is a constant over here.
 */
export const FOUNDRY_DPI = 200;

export type FoundryRunStageName = 'render' | 'scan' | 'ocr' | 'blocks' | 'footnotes';
export type FoundryRunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** The stages a caller may ask for. `render` is not one: it is scan's input. */
export type FoundryWorkStage = 'scan' | 'ocr' | 'blocks' | 'footnotes';

/**
 * What each stage needs to have happened first, either earlier in the same run
 * or already on disk. `ocr` before `footnotes` is the contract in the header,
 * not a preference — foundry's export refuses a footnotes artifact derived from
 * a different text base.
 */
const STAGE_PREREQUISITE: Record<FoundryWorkStage, FoundryWorkStage | null> = {
  scan: null,
  ocr: 'scan',
  blocks: 'scan',
  footnotes: 'ocr',
};

/** Execution order. A caller's list is run in THIS order, never its own. */
const STAGE_ORDER: FoundryWorkStage[] = ['scan', 'ocr', 'blocks', 'footnotes'];

export interface FoundryRunStart {
  /**
   * Book identity — the picker's file hash. It must survive a renderer reload,
   * which rules out anything minted per session, and it must change when the
   * document changes, which rules out the file path.
   */
  bookKey: string;
  /** The PDF to rasterize. foundry does not open PDFs; BookForge feeds it pages. */
  pdfPath: string;
  /** Document page numbers, zero-based, in reading order. */
  pages: number[];
  /**
   * The stages this run executes, run in the pipeline's order rather than the
   * caller's — the processing wizard's passes (Tesseract, OCR correction,
   * Footnote removal) are separate queue jobs against ONE run directory, so each
   * job asks for the stages it owns.
   *
   * A stage whose prerequisite is neither listed here nor already done on disk is
   * refused by name rather than run against artifacts that do not exist.
   */
  stages: FoundryWorkStage[];
  /**
   * Start over: wipe the run directory first.
   *
   * Without it a run resumes, which is what you want after a cancel. With it you
   * get a clean directory, which is what you want after changing a model.
   */
  redo?: boolean;
}

/** What a watcher sees. Small enough to send on every progress line. */
export interface FoundryRunState {
  bookKey: string;
  runDir: string;
  pdfPath: string;
  /** Document page numbers in run order — foundry indexes these from 0. */
  pages: number[];
  status: FoundryRunStatus;
  /**
   * Whether a worker is actually behind this state right now.
   *
   * `running` and not `live` means the app died mid-run: the artifacts on disk
   * are real and worth reading, but nothing is working on them. Resuming costs
   * several GB of model load, so it is the user's decision, not a side effect of
   * opening a book.
   */
  live: boolean;
  stage: FoundryRunStageName | null;
  stageIndex: number;
  stageCount: number;
  /** foundry's own most recent progress line, verbatim. */
  message: string;
  /** Units within the current stage — pages, lines or blocks depending on it. */
  done: number;
  total: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

type Emit = (state: FoundryRunState) => void;

interface ActiveRun {
  state: Omit<FoundryRunState, 'live'>;
  abort: AbortController;
  /** Resolves when the run has stopped, however it stopped. */
  finished: Promise<void>;
}

const runs = new Map<string, ActiveRun>();
const listeners = new Set<Emit>();

export function onFoundryRunProgress(listener: Emit): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(state: FoundryRunState): void {
  for (const listener of listeners) {
    try {
      listener({ ...state });
    } catch (err) {
      console.error('[foundry-run] progress listener threw:', err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Where things live
// ─────────────────────────────────────────────────────────────────────────────

export function foundryRunsRoot(): string {
  return path.join(os.homedir(), 'Documents', 'BookForge', 'foundry-runs');
}

/** A book key is a hash, but it arrives from the renderer — sanitize anyway. */
function safeKey(bookKey: string): string {
  const cleaned = bookKey.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned) throw new Error('A foundry run needs a book key; none was given.');
  if (cleaned.length <= 96) return cleaned;
  // Truncation alone COLLIDES: a project's archive PDF and its
  // source/exported.epub sanitize to the same first 96 characters (the shared
  // project-dir prefix), and the collision handed the review EPUB the PDF's run
  // — 50 pages of foundry blocks painted over the exported book (Aug 1 2026).
  // The digest of the FULL key keeps the name readable and unique.
  const digest = crypto.createHash('sha256').update(bookKey).digest('hex').slice(0, 12);
  return `${cleaned.slice(0, 83)}-${digest}`;
}

export function foundryRunDir(bookKey: string): string {
  return path.join(foundryRunsRoot(), safeKey(bookKey));
}

function pagesDir(runDir: string): string {
  return path.join(runDir, 'pages');
}

function statePath(runDir: string): string {
  return path.join(runDir, 'bookforge-run.json');
}

/**
 * Persist the state BookForge owns and foundry does not know about: which
 * document these pages came from, and which document page each run index is.
 *
 * foundry's `run.json` records an input hash and a page COUNT — it deliberately
 * knows nothing about PDFs. Without this file a run directory found after a
 * restart could be read but not placed: its blocks would land on pages 0..n
 * instead of on the pages the user actually OCR'd.
 */
function persist(state: Omit<FoundryRunState, 'live'>): void {
  try {
    fs.mkdirSync(state.runDir, { recursive: true });
    fs.writeFileSync(statePath(state.runDir), JSON.stringify(state, null, 2));
  } catch (err) {
    // Losing resume-across-restart must not take down the run that is working.
    console.warn('[foundry-run] could not persist run state:', err);
  }
}

function readPersisted(bookKey: string): Omit<FoundryRunState, 'live'> | null {
  const file = statePath(foundryRunDir(bookKey));
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof raw?.bookKey !== 'string' || !Array.isArray(raw?.pages)) return null;
    if (raw.bookKey !== bookKey) {
      // The directory name is derived from the key, so this means a name
      // collision (or a hand-moved directory). Another book's run is not "no
      // run with a bonus" — it is the wrong book, and painting it would put
      // its blocks on this one's pages.
      console.warn(
        `[foundry-run] ${file} belongs to ${raw.bookKey}, not ${bookKey}; ignoring it`
      );
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function snapshot(run: ActiveRun): FoundryRunState {
  return { ...run.state, live: run.state.status === 'running' };
}

function publish(run: ActiveRun): void {
  run.state.updatedAt = Date.now();
  persist(run.state);
  emit(snapshot(run));
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull an `n/total` out of a foundry progress line.
 *
 * foundry writes progress to stderr in one shape across stages — `page 3/50`,
 * `ocr: 100/2120 lines`, `footnotes: 12/40 units` — so one regex serves them
 * all. The LAST pair on the line wins, because `page 1/2: 20/20 blocks labelled`
 * carries the page counter first and the interesting number second.
 *
 * A line with no pair (a heading, a calibration verdict, a warning) still
 * becomes the message: those are the lines that explain a run, and dropping them
 * for lack of a number would hide the one that says a book's paragraph
 * convention is DEGRADED.
 */
export function parseProgress(line: string): { done: number; total: number } | null {
  const matches = [...line.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const done = Number(last[1]);
  const total = Number(last[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running the stages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one argument EVERY model stage carries: the llama-server this app ships.
 *
 * Exported because a foundry stage is not always a stage of a RUN — `foundry
 * footnotes --epub` is the same binary and the same server pointed at a finished
 * book, driven from `processing-passes.ts` — and because it is now the WHOLE
 * argument list for the footnotes stage, which resolves its own weights.
 */
export function foundryLlamaServerArgs(): string[] {
  const { resolveLlamaServerBinary } =
    require('./llama-bridge') as typeof import('./llama-bridge');
  const llamaServer = resolveLlamaServerBinary();
  if (!llamaServer) {
    throw new Error(
      'foundry needs a llama-server binary to run its model stages, and BookForge could not '
      + 'find the one it ships (resources/bin/llama-server*). Reinstall the app, or run '
      + '`npm run download:llama` in a dev checkout.'
    );
  }
  return ['--llama-server', llamaServer];
}

/**
 * A stage whose checkpoint is unpublished: our llama-server, plus the GGUF this
 * machine holds. See foundry-interim-config for which stages those are and why.
 */
function modelArgs(stage: FoundryModelStage): string[] {
  // A merged fine-tune: --base-model with NO --adapter. foundry then reads the
  // prompt-format version out of the base filename, which is the same rule it
  // always applies — the version lives in the name of whatever weights answer.
  return [...foundryLlamaServerArgs(), '--base-model', requireFoundryModel(stage)];
}

/** Which foundry stages `run.json` already reports as done. */
function completedStages(runDir: string): Set<string> {
  let run: FoundryRunFile;
  try {
    run = readRunDirectory(runDir).run;
  } catch {
    // No run record yet (nothing has scanned), or one this build cannot read —
    // readRunDirectory says which, loudly, when it is actually asked for data.
    return new Set();
  }

  /*
   * foundry renamed its `boxes` stage to `blocks` (foundry 21be907), and the
   * artifact moved with it: `boxes/blocks.json` is now `blocks/blocks.json`.
   * Neither side carries a compatibility arm. A run directory from before the
   * rename would otherwise resume QUIETLY WRONG right here — `blocks` is simply
   * absent from the done set, so the stage looks un-run and is spawned, and the
   * failure lands minutes later inside foundry with the rename two hops away
   * from the message. Name it now, before anything is spawned.
   */
  const stages = run.stages as unknown as Record<string, unknown>;
  if (stages['boxes'] !== undefined && stages['blocks'] === undefined) {
    throw new Error(
      `The foundry run at ${runDir} predates the rename of foundry's \`boxes\` stage to `
      + `\`blocks\`: its run.json records \`stages.boxes\`, and its labelled blocks are in `
      + `boxes/blocks.json rather than blocks/blocks.json. Nothing reads the old names. `
      + `Re-run OCR with "Redo" to start a fresh run directory.`
    );
  }

  return new Set(
    Object.entries(run.stages)
      .filter(([, state]) => state.status === 'done')
      .map(([name]) => name)
  );
}

async function runStage(
  run: ActiveRun,
  stage: FoundryRunStageName,
  stageIndex: number,
  stageCount: number,
  args: string[]
): Promise<void> {
  run.state.stage = stage;
  run.state.stageIndex = stageIndex;
  run.state.stageCount = stageCount;
  run.state.done = 0;
  run.state.total = 0;
  run.state.message = `${stage}: starting…`;
  publish(run);

  const started = Date.now();
  const result = await runFoundry(args, {
    signal: run.abort.signal,
    onProgress: (line) => {
      const progress = parseProgress(line);
      if (progress) {
        run.state.done = progress.done;
        run.state.total = progress.total;
      }
      run.state.message = line.trim();
      publish(run);
    },
  });

  if (result.code !== 0) {
    // foundry's stderr IS the message a user needs — every throw in that program
    // is written to name the missing thing. Never summarize it.
    throw new Error(
      `foundry ${stage} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`
    );
  }
  console.log(`[foundry-run] ${stage} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Start (or resume) a run. Returns as soon as it is registered; progress arrives
 * through `onFoundryRunProgress`.
 */
export async function startFoundryRun(opts: FoundryRunStart): Promise<FoundryRunState> {
  if (!opts.pages?.length) throw new Error('A foundry run needs at least one page.');
  if (!fs.existsSync(opts.pdfPath)) {
    throw new Error(`Cannot OCR ${opts.pdfPath}: the file is not there.`);
  }

  const existing = runs.get(opts.bookKey);
  if (existing && existing.state.status === 'running') {
    // Two windows watching one run is the normal case during a reload race.
    // Starting a second would put two llama-servers on the same GPU.
    return snapshot(existing);
  }

  const wanted: FoundryWorkStage[] = STAGE_ORDER.filter((s) => opts.stages?.includes(s));
  if (wanted.length === 0) {
    throw new Error('A foundry run was asked for no stages; there is nothing to do.');
  }

  // Resolve the binary and the weights BEFORE anything is rendered. A run that
  // rasterizes 350 pages and then reports that a GGUF is missing has spent five
  // minutes to deliver a message it could have delivered immediately. Only the
  // stages this run will actually execute are checked: a Tesseract-only pass must
  // not be blocked by a model it never loads.
  //
  // `footnotes` is deliberately absent: it resolves from foundry's own catalog,
  // and re-deriving that catalog's filenames and data directory over here to
  // pre-check it would be a second copy of foundry's catalog, drifting the day
  // a model is superseded. foundry's own failure names the model id, the path
  // and `foundry models pull`, which is the fix — the only thing lost is a few
  // minutes of rendering on a run that also asked for a scan.
  //
  // `ensureFoundryPath` rather than `requireFoundryPath`: a machine with no
  // foundry gets one here instead of being told to go and find one. A queued
  // pass has already awaited this (processing-passes does it where the job's own
  // progress bar can show the download), so for the queue this is the cheap
  // stat; for a run the picker started directly, this IS the download.
  await ensureFoundryPath();
  if (wanted.includes('ocr')) requireFoundryModel('ocr');
  if (wanted.includes('blocks')) requireFoundryModel('blocks');

  const runDir = foundryRunDir(opts.bookKey);
  if (opts.redo) {
    fs.rmSync(runDir, { recursive: true, force: true });
  } else {
    // A run directory belongs to ONE set of pages: every artifact is keyed to
    // positions in it, so re-scanning a different set into the same directory
    // would put text under labels that were about other pages. foundry refuses
    // it by input hash; this catches it first and says the useful thing.
    const previous = readPersisted(opts.bookKey);
    if (previous && !samePages(previous.pages, opts.pages)) {
      if (!wanted.includes('scan')) {
        // Wiping here would delete the scan this run was queued to build on —
        // half an hour of OCR thrown away by a page list that arrived wrong.
        throw new Error(
          `The foundry run at ${runDir} covers ${previous.pages.length} pages, but this `
          + `${wanted.join('+')} pass was given ${opts.pages.length}. Re-run the Tesseract pass to `
          + 'scan the new page set; a later stage cannot re-cut the pages under it.'
        );
      }
      console.warn(
        `[foundry-run] ${opts.bookKey}: the page set changed `
        + `(${previous.pages.length} → ${opts.pages.length} pages); starting a fresh run directory.`
      );
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(pagesDir(runDir), { recursive: true });

  // A stage stands on the previous one's artifact. Refuse before spawning
  // anything, naming the pass that has to run first — foundry's own failure for
  // this is a missing file several minutes in.
  const doneOnDisk = completedStages(runDir);
  for (const stage of wanted) {
    const needs = STAGE_PREREQUISITE[stage];
    if (!needs || wanted.includes(needs) || doneOnDisk.has(needs)) continue;
    throw new Error(
      `foundry's ${stage} stage reads what ${needs} produced, and ${needs} has not run for this `
      + `book (${runDir}). Run the ${needs === 'scan' ? 'Tesseract' : 'OCR correction'} pass first.`
    );
  }

  const stageCount = wanted.length + (wanted.includes('scan') ? 1 : 0);
  const state: Omit<FoundryRunState, 'live'> = {
    bookKey: opts.bookKey,
    runDir,
    pdfPath: opts.pdfPath,
    pages: [...opts.pages],
    status: 'running',
    stage: wanted.includes('scan') ? 'render' : wanted[0],
    stageIndex: 0,
    stageCount,
    message: wanted.includes('scan') ? 'Rendering pages…' : `${wanted[0]}: starting…`,
    done: 0,
    total: opts.pages.length,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  const run: ActiveRun = { state, abort: new AbortController(), finished: Promise.resolve() };
  runs.set(opts.bookKey, run);
  publish(run);

  run.finished = (async () => {
    try {
      const alreadyDone = completedStages(runDir);
      // Position within THIS run's stage list, so a two-stage pass reads "2/2"
      // rather than "3/5" of a pipeline it is not running.
      let stageIndex = 0;
      const nextIndex = () => ++stageIndex;

      // ── render + scan ──────────────────────────────────────────────────────
      // The page renders exist only to be scanned, and a completed run DELETES
      // them (see cleanupPageRenders) — so render is gated on the scan being
      // pending, not on the files being present, or every resume of a finished
      // run would re-rasterize a book nothing is going to read.
      if (wanted.includes('scan') && !alreadyDone.has('scan')) {
        // A partial pages dir is re-rendered whole rather than topped up: the
        // input hash foundry records covers the SET, and reasoning about which
        // of 350 files is stale is a worse bet than three minutes of mupdf.
        const expected = opts.pages.map(
          (p) => path.join(pagesDir(runDir), `page-${String(p).padStart(6, '0')}.pgm`)
        );
        if (!expected.every((f) => fs.existsSync(f))) {
          const { callRenderPagesToPgm } =
            require('./pdf-worker-proxy') as typeof import('./pdf-worker-proxy');
          await callRenderPagesToPgm(
            opts.pdfPath,
            opts.pages,
            pagesDir(runDir),
            FOUNDRY_DPI,
            (done, total) => {
              run.state.done = done;
              run.state.total = total;
              run.state.message = `render: ${done}/${total} pages at ${FOUNDRY_DPI} dpi`;
              publish(run);
            }
          );
        } else {
          console.log(`[foundry-run] ${opts.pages.length} page renders already present; skipping render`);
        }
        if (run.abort.signal.aborted) throw new CancelledError();
        nextIndex();

        await runStage(run, 'scan', nextIndex(), stageCount, [
          'scan', '--pages', pagesDir(runDir), '--run', runDir,
        ]);
      }

      // ── ocr ───────────────────────────────────────────────────────────────
      // BEFORE footnotes. See the header: export refuses a footnotes artifact
      // derived from a different text base.
      if (wanted.includes('ocr') && !alreadyDone.has('ocr')) {
        await runStage(run, 'ocr', nextIndex(), stageCount, [
          'ocr', '--run', runDir, ...modelArgs('ocr'),
        ]);
      }

      // ── blocks ────────────────────────────────────────────────────────────
      if (wanted.includes('blocks') && !alreadyDone.has('blocks')) {
        await runStage(run, 'blocks', nextIndex(), stageCount, [
          'blocks', '--run', runDir, ...modelArgs('blocks'),
        ]);
      }

      // ── footnotes (optional) ──────────────────────────────────────────────
      if (wanted.includes('footnotes') && !alreadyDone.has('footnotes')) {
        // No --base-model: foundry resolves `foundry-footnotes-v1-4b` on
        // `foundry:4b` from its catalog and serves the adapter with
        // --lora-scaled, which is how it was trained and measured.
        await runStage(run, 'footnotes', nextIndex(), stageCount, [
          'footnotes', '--run', runDir, ...foundryLlamaServerArgs(),
        ]);
      }

      run.state.status = 'done';
      run.state.stage = null;
      run.state.message = 'OCR complete.';
      cleanupPageRenders(runDir);
    } catch (err) {
      if (err instanceof CancelledError || run.abort.signal.aborted) {
        run.state.status = 'cancelled';
        run.state.message = 'Cancelled. Everything finished so far is on disk.';
      } else {
        run.state.status = 'error';
        run.state.error = err instanceof Error ? err.message : String(err);
        run.state.message = run.state.error;
        console.error(`[foundry-run] ${opts.bookKey} failed:`, err);
      }
    } finally {
      publish(run);
    }
  })();

  return snapshot(run);
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * A COMPLETED run deletes its page renders. They exist only to be scanned —
 * ~3.6 MB per page, ~1.4 GB for a full book — while everything downstream
 * (re-export, exclusions, the viewer's blocks) reads the ~1 MB of artifacts,
 * which stay. A run that failed or was cancelled keeps its pages so resume can
 * pick up without re-rasterizing.
 */
function cleanupPageRenders(runDir: string): void {
  const dir = pagesDir(runDir);
  if (!fs.existsSync(dir)) return;
  try {
    let bytes = 0;
    for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[foundry-run] run complete; deleted ${(bytes / 1e6).toFixed(0)} MB of page renders from ${dir}`);
  } catch (err) {
    console.warn(`[foundry-run] could not delete page renders in ${dir}:`, err);
  }
}

function samePages(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/**
 * The state of the run for a book, if there is one — including a finished or
 * failed one, so a renderer that reloaded after the end still learns the result.
 *
 * Falls back to what was persisted, which is how a completed run survives a full
 * app restart. Such a state comes back `live: false`.
 */
export function attachFoundryRun(bookKey: string): FoundryRunState | null {
  const live = runs.get(bookKey);
  if (live) return snapshot(live);
  const saved = readPersisted(bookKey);
  if (!saved) return null;
  return { ...saved, live: false, status: saved.status === 'running' ? 'cancelled' : saved.status };
}

/**
 * Wait for the run this process started to stop, and hand back its final state.
 *
 * `startFoundryRun` returns as soon as the run is registered — right for the
 * picker, which watches progress events, and wrong for a queue job, which IS the
 * run and must not report success while foundry is still working. A run that
 * ended in error throws here with foundry's own message; a cancelled one throws
 * too, because a cancelled pass has not applied itself to the book.
 */
export async function awaitFoundryRun(bookKey: string): Promise<FoundryRunState> {
  const run = runs.get(bookKey);
  if (!run) throw new Error(`No foundry run is registered for ${bookKey}; nothing to wait for.`);
  await run.finished;
  const state = snapshot(run);
  if (state.status === 'error') throw new Error(state.error || 'The foundry run failed without a message.');
  if (state.status === 'cancelled') throw new Error('The foundry run was cancelled.');
  return state;
}

/** Which foundry stages this book's run directory reports as done. */
export function foundryStagesDone(bookKey: string): Set<string> {
  return completedStages(foundryRunDir(bookKey));
}

export async function cancelFoundryRun(bookKey: string): Promise<void> {
  const run = runs.get(bookKey);
  if (!run || run.state.status !== 'running') return;
  run.abort.abort();
  await run.finished;
}

/** Cancel everything and wait for the in-flight stage. Used on quit. */
export async function cancelAllFoundryRuns(): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const run of runs.values()) {
    if (run.state.status !== 'running') continue;
    run.abort.abort();
    waits.push(run.finished);
  }
  await Promise.all(waits);
}

export function foundryRunActive(): boolean {
  for (const run of runs.values()) if (run.state.status === 'running') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the result into the picker's block model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A foundry block, in the shape pdf-picker paints and edits.
 *
 * The id is foundry's OWN block id, unchanged, and that is the load-bearing
 * decision in this whole integration: the picker's `deletedBlockIds` is then
 * literally the `--exclude-ids` file, with no mapping table in between to drift.
 * A user deleting a box in the viewer and `foundry export` dropping that block
 * are the same fact written twice, not two facts kept in sync.
 */
export interface FoundryPickerBlock {
  id: string;
  /** DOCUMENT page number, translated back out of foundry's run index. */
  page: number;
  /** Page points, top-left origin — the picker's coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  char_count: number;
  region: string;
  category_id: string;
  line_count: number;
  is_ocr: true;
  ocr_confidence: number;
  line_boxes: Array<[number, number, number, number]>;
}

export interface FoundryRunResult {
  bookKey: string;
  runDir: string;
  pages: number[];
  blocks: FoundryPickerBlock[];
  calibration?: FoundryCalibration;
  /** True when the text below came from the ocr stage rather than raw scan. */
  corrected: boolean;
  /** Lines the OCR model changed, for a "what did it fix" count in the UI. */
  correctedLines: number;
  /** Model outputs the guards refused — reported, never hidden. */
  refusedLines: number;
  /** Footnote markers removed, when that stage ran. */
  markersRemoved: number;
  /**
   * Deskew applied per DOCUMENT page, in degrees.
   *
   * foundry measures its boxes on a STRAIGHTENED raster. The picker overlays
   * them on the unrotated page render, so a page with real skew paints its boxes
   * at the wrong angle. Reported rather than corrected: silently un-rotating
   * boxes would hide that the source is crooked, and the honest fix is upstream.
   */
  deskewByPage: Record<number, number>;
  epubPath?: string;
}

/** px at the pinned dpi → PDF points. One conversion, stated once. */
function pxToPt(px: number): number {
  return (px * 72) / FOUNDRY_DPI;
}

/**
 * Read a run directory and translate it into the picker's world.
 *
 * Two translations happen here and nowhere else:
 *
 *  - **Page index → document page.** foundry numbers the pages it was handed
 *    from 0. Which document page each of those was is BookForge's fact, carried
 *    in `bookforge-run.json`; it is not recoverable from foundry's artifacts,
 *    and getting it wrong puts a whole book's labels one page out.
 *  - **200-dpi pixels → PDF points.** The picker places everything in points.
 *
 * The TEXT is the ocr stage's when it has run, and the raw scan's when it has
 * not — `foundryBlockText` joins whichever it is given. There is no third
 * option and no mixing: a block whose lines came half from each would have no
 * way to say which words are the corrected ones.
 */
export function readFoundryRun(bookKey: string): FoundryRunResult {
  const saved = readPersisted(bookKey);
  if (!saved) {
    throw new Error(
      `No foundry run for this book (looked for ${statePath(foundryRunDir(bookKey))}). `
      + 'Run OCR first.'
    );
  }
  const dir = readRunDirectory(saved.runDir);
  if (!dir.blocks || !dir.lines || !dir.pages) {
    throw new Error(
      `The foundry run at ${saved.runDir} has no labelled blocks yet — `
      + `scan and blocks must both finish before the picker can paint anything.`
    );
  }

  const corrected = new Map((dir.ocrLines ?? []).map((l) => [l.id, l.text]));
  const lines: FoundryScanLine[] = corrected.size
    ? dir.lines.map((l) => ({ ...l, text: corrected.get(l.id) ?? l.text }))
    : dir.lines;
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const pageByIndex = (index: number): number => {
    const page = saved.pages[index];
    if (page === undefined) {
      throw new Error(
        `The run at ${saved.runDir} holds a block on page index ${index}, but only `
        + `${saved.pages.length} pages were submitted. The run directory and its BookForge `
        + `record are out of step — re-run OCR.`
      );
    }
    return page;
  };

  const blocks: FoundryPickerBlock[] = dir.blocks.map((block: FoundryBlock) => {
    const text = foundryBlockText(block, lines);
    const blockLines = block.lineIds.map((id) => linesById.get(id)!);
    const confs = blockLines.map((l) => l.conf).filter((c): c is number => c !== null);
    const heights = blockLines.map((l) => l.bbox[3] - l.bbox[1]).sort((a, b) => a - b);
    return {
      id: block.id,
      page: pageByIndex(block.page),
      x: pxToPt(block.bbox[0]),
      y: pxToPt(block.bbox[1]),
      width: pxToPt(block.bbox[2] - block.bbox[0]),
      height: pxToPt(block.bbox[3] - block.bbox[1]),
      text,
      font_size: pxToPt(heights[Math.floor(heights.length / 2)] ?? 0),
      font_name: 'ocr',
      char_count: text.length,
      // From the ONE colour table, not invented here: `region` drives the
      // picker's header/body/footer filters, and a block that arrives with an
      // empty one silently disappears out of every filtered view. foundry's
      // categories ARE the thirteen in that table, so the lookup always hits;
      // an id it does not know is a contract mismatch and reads as blank.
      region: blockCategoryDef(block.category)?.region ?? '',
      category_id: block.category,
      line_count: block.lineIds.length,
      is_ocr: true,
      // Tesseract reports 0-100; the picker's model is 0-1.
      ocr_confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length / 100 : 1,
      line_boxes: blockLines.map((l) => [
        pxToPt(l.bbox[0]),
        pxToPt(l.bbox[1]),
        pxToPt(l.bbox[2] - l.bbox[0]),
        pxToPt(l.bbox[3] - l.bbox[1]),
      ] as [number, number, number, number]),
    };
  });

  const deskewByPage: Record<number, number> = {};
  for (const page of dir.pages as FoundryScanPage[]) {
    if (page.deskewDeg) deskewByPage[pageByIndex(page.page)] = page.deskewDeg;
  }

  return {
    bookKey,
    runDir: saved.runDir,
    pages: saved.pages,
    blocks,
    calibration: dir.calibration,
    corrected: corrected.size > 0,
    correctedLines: (dir.ocrLines ?? []).filter((l) => l.edits.length > 0).length,
    refusedLines: (dir.ocrLines ?? []).reduce((n, l) => n + l.rejected.length, 0),
    markersRemoved: (dir.footnoteDeletions ?? []).reduce((n, d) => n + d.applied.length, 0),
    deskewByPage,
    epubPath: dir.epubPath,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One block the user changed in the picker, on its way to `foundry export
 * --overrides`.
 *
 * `text` is the block's WHOLE text as one line — a retyped chapter heading, or
 * the joined text of adjacent `chapter` blocks the picker merged into a single
 * marker. `category` is a relabel.
 */
export interface FoundryBlockOverride {
  /** Foundry's own block id, verbatim. */
  id: string;
  text?: string;
  category?: string;
}

export interface FoundryExportRequest {
  bookKey: string;
  /** Block ids the user deleted in the picker. Foundry's own ids, verbatim. */
  excludeBlockIds: string[];
  /** Whole categories to drop, e.g. `footnote`. Composes with the ids above. */
  excludeCategories: string[];
  /**
   * Per-block text and category edits. Optional; an empty list writes no file
   * and passes no flag, so a book nobody edited exports exactly as before.
   */
  overrides?: FoundryBlockOverride[];
  /** Absolute destination — normally the project's canonical `source/<Title>.epub`. */
  outputPath: string;
  /**
   * Absolute path to the book's cover (JPEG/PNG). foundry embeds it as the EPUB
   * cover and a first-spine cover page. Absent means the book has no cover,
   * which is ordinary — never a placeholder.
   */
  coverPath?: string;
}

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * Write the exclusion list, run `foundry export`, and land the EPUB atomically.
 *
 * ── Why the exclusions go to a FILE ──────────────────────────────────────────
 *
 * foundry takes `--exclude-ids <file>`, one id per line, and writes what it
 * actually excluded to `export/exclusions.json`. So the run directory ends up
 * holding the reproduction recipe: the same run directory plus the same file
 * produces the same book, months later, without re-running a single model. That
 * is worth more than a shorter command line.
 *
 * ── Why the EPUB is staged ───────────────────────────────────────────────────
 *
 * The library folder is Syncthing-synced. A file written in place is visible to
 * Syncthing while it is still half-written, and a half-EPUB propagated to
 * another machine is a corrupt book that looks like a real one. So foundry
 * writes into a staging directory on the local disk and the finished file is
 * moved into the project in one operation.
 *
 * ── Why the OVERRIDES go to a file too ───────────────────────────────────────
 *
 * Same reason, and it matters more: an override is the user's own sentence
 * ("this chapter is called The Lost Empire"), and `bookforge-overrides.json`
 * next to the exclusion list is the record of it. The run directory then holds
 * everything needed to rebuild that exact book — foundry's artifacts, what was
 * dropped, and what a person retyped — with no model re-run and nothing living
 * only in a window that has since closed.
 */
export async function foundryExport(req: FoundryExportRequest): Promise<{ epubPath: string }> {
  const saved = readPersisted(req.bookKey);
  if (!saved) {
    throw new Error(`No foundry run for this book; there is nothing to export. Run OCR first.`);
  }
  await ensureFoundryPath();

  const exportDir = path.join(saved.runDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const idsFile = path.join(exportDir, 'bookforge-exclude-ids.txt');
  const ids = [...new Set(req.excludeBlockIds)].sort();
  fs.writeFileSync(
    idsFile,
    [
      '# Block ids deleted in pdf-picker. Written by BookForge; read by `foundry export`.',
      `# ${new Date().toISOString()} — ${ids.length} block(s)`,
      ...ids,
      '',
    ].join('\n')
  );

  // The user's own edits: retyped chapter markers and relabelled blocks.
  //
  // Checked HERE as well as in the renderer, because this is the boundary the
  // CLI is on the other side of. An override with neither field is a caller bug
  // that would otherwise reach foundry as an instruction to do nothing, and a
  // category foundry cannot render (`table`, which only BookForge has) would
  // come back as an exit code with no block id in it.
  const overrides = (req.overrides ?? []).filter((o) => o.text !== undefined || o.category !== undefined);
  if (overrides.length !== (req.overrides ?? []).length) {
    const empty = (req.overrides ?? []).filter((o) => o.text === undefined && o.category === undefined);
    throw new Error(
      `${empty.length} block override(s) set neither text nor category `
      + `(first: ${empty[0]?.id}). An override that asks for nothing is a bug in the caller, `
      + 'not an instruction; refusing to export a book that silently ignores it.'
    );
  }
  const illegal = overrides.filter((o) => o.category !== undefined && !isFoundryCategory(o.category));
  if (illegal.length > 0) {
    throw new Error(
      `foundry has no "${illegal[0].category}" category, so ${illegal.length} relabelled block(s) `
      + `cannot be exported (first: ${illegal[0].id}). Relabel them to a class foundry renders `
      + '(list, discard, caption, …) or delete them, then export again.'
    );
  }

  let overridesFile: string | null = null;
  if (overrides.length > 0) {
    overridesFile = path.join(exportDir, 'bookforge-overrides.json');
    fs.writeFileSync(
      overridesFile,
      `${JSON.stringify(
        {
          _comment:
            'Per-block text and category edits made in pdf-picker. Written by BookForge; '
            + 'read by `foundry export --overrides`.',
          _written: new Date().toISOString(),
          blocks: [...overrides].sort((a, b) => a.id.localeCompare(b.id)),
        },
        null,
        2
      )}\n`
    );
  }

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const staged = path.join(
    STAGING_DIR,
    `foundry-${safeKey(req.bookKey)}-${crypto.randomUUID()}.epub`
  );

  const args = ['export', '--run', saved.runDir, '-o', staged, '--exclude-ids', idsFile];
  if (overridesFile) args.push('--overrides', overridesFile);
  // Passed straight through. An installed foundry too old to know --cover fails
  // the export with its own message; retrying without the flag would ship a
  // coverless book that looks like a success.
  if (req.coverPath) args.push('--cover', req.coverPath);
  for (const category of [...new Set(req.excludeCategories)]) {
    args.push('--exclude', category);
  }

  const result = await runFoundry(args, {
    onProgress: (line) => console.log(`[foundry export] ${line}`),
  });
  if (result.code !== 0) {
    try { fs.unlinkSync(staged); } catch { /* nothing staged */ }
    throw new Error(
      `foundry export failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`
    );
  }
  if (!fs.existsSync(staged)) {
    throw new Error(`foundry export reported success but wrote no file at ${staged}.`);
  }

  fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
  try {
    fs.renameSync(staged, req.outputPath);
  } catch {
    // /tmp and the library are routinely different filesystems, and rename does
    // not cross one. Copy to a sibling of the destination, then rename WITHIN
    // that filesystem — which is the atomic step Syncthing needs to see.
    const sibling = `${req.outputPath}.bookforge-tmp`;
    fs.copyFileSync(staged, sibling);
    fs.renameSync(sibling, req.outputPath);
    fs.unlinkSync(staged);
  }

  console.log(
    `[foundry-run] exported ${req.outputPath} (${ids.length} block(s) excluded, `
    + `${overrides.length} override(s))`
  );
  return { epubPath: req.outputPath };
}

/** Present so a test can start from a known state. */
export function __resetFoundryRunsForTest(): void {
  runs.clear();
}
