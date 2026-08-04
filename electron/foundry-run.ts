/**
 * foundry-run — the OCR pipeline, owned by MAIN so a reload cannot kill it.
 *
 * This is the second module in this codebase built to the same shape, for the
 * same reason (see `corpus-ocr-run.ts`): the renderer is the
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
 * block the footnotes stage touched ships its RAW text minus markers — silently discarding
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
import { blockCategoryDef, isFoundryCategory } from '../shared/ocr/block-categories';
import {
  resolveExcludedBlockIds,
  type FoundryDeletedLines,
} from '../shared/foundry/block-exclusions';
import { boundedRunKey } from './path-utils';

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
 * or already on disk.
 *
 * `footnotes` needs `blocks`, not `ocr`: foundry's footnotes stage reads
 * `blocks/blocks.json` and judges BLOCK text (`runFootnotesRun` in foundry's
 * commands.ts), and it takes the corrected line text only when an ocr artifact
 * happens to be there — a book with no ocr stage is judged on the raw scan, and
 * the export builds its text base the same way, so the two agree. `ocr` is still
 * ORDERED before `footnotes` (STAGE_ORDER, and the header explains why); that is
 * a different statement from requiring it, and requiring it is what stopped a
 * born-digital book — which needs no repair — from having its markers removed.
 */
const STAGE_PREREQUISITE: Record<FoundryWorkStage, FoundryWorkStage | null> = {
  scan: null,
  ocr: 'scan',
  blocks: 'scan',
  footnotes: 'blocks',
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
   * caller's — the processing wizard's passes (OCR correction, which owns scan +
   * ocr; Detection, which owns blocks and sometimes scan; Footnote removal) are
   * separate queue jobs against ONE run directory, so each job asks for the
   * stages it owns.
   *
   * EVERY STAGE NAMED HERE RUNS. One that `run.json` already reports as done has
   * its artifacts and its done marker cleared first, so it starts from nothing.
   * A caller is here because a person asked for this work, and handing them back
   * this morning's artifacts would answer a different question than the one they
   * asked — silently, and instantly, which reads as success.
   *
   * A prerequisite NOT named here is read off disk, and that is INPUT, not cache:
   * a footnotes-only pass stands on the ocr artifact exactly as an EPUB pass
   * stands on the book EPUB. One whose prerequisite is neither listed here nor
   * already done on disk is refused by name rather than run against artifacts
   * that do not exist.
   */
  stages: FoundryWorkStage[];
  /**
   * Wipe the whole run directory before anything runs.
   *
   * For the caller that re-reads the pages, which is the OCR-correction pass.
   * The scan is the text base every other artifact in the directory stands on —
   * line ids, blocks, the footnote deletion list — so re-scanning invalidates all
   * of them, and foundry's export refuses a footnotes artifact derived from a
   * text base that no longer exists. Clearing only the stages that pass names
   * would leave those behind.
   *
   * Not a user option and not a resume switch: a submitted pass always re-runs
   * its own stages, and the whole-directory wipe is what "its own stages" means
   * for the one that owns the scan.
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

/**
 * A book key is the path of the document the run reads; it arrives from the
 * renderer, so sanitize, bound and de-collide it — see `boundedRunKey`, which is
 * the ONE implementation the Detect run store shares. Byte-identical to what
 * this file did inline, so existing run directories are still found.
 */
function safeKey(bookKey: string): string {
  return boundedRunKey(bookKey);
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
 * VRAM needed to run foundry's model stages fully on the GPU, in MB.
 *
 * foundry's `-ngl` policy is all-or-none (its own words: a partial offload of a
 * 4B spends PCIe traffic per token to save little), and it leaves the number to
 * the caller "because only the caller knows what probing was done". This is
 * that probing. The working set is knowable here because the weights are
 * foundry's own catalog, not user-chosen: base f16 ≈ 7.7 GB, adapter ≤ 130 MB,
 * KV cache at foundry's 16K context ≈ 2.4 GB, plus compute buffers and whatever
 * the desktop is holding. Under-budgeting does not error — NVIDIA's sysmem
 * fallback silently spills over PCIe and generation crawls (see `computeNgl` in
 * llama-bridge.ts, which learned this on the cleanup models) — so the number
 * errs high, and a machine under it runs on CPU exactly as if it had no GPU.
 */
const FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB = 12000;

/**
 * The arguments EVERY model stage carries: the llama-server this app ships,
 * and — when this machine's GPU holds foundry's whole working set — the
 * `--gpu-layers` that says to use it.
 *
 * The offload flag is BookForge's to send. foundry defaults `-ngl` to 99 on
 * Apple Silicon (unified memory) and 0 everywhere else, deferring to the
 * caller's probing; a caller that sends nothing has therefore chosen CPU
 * inference. That is exactly what this function used to do, and a 4B f16 on CPU
 * turned one book's OCR stage into a 23-hour ETA on a machine with a 24 GB GPU
 * sitting idle. On darwin nothing is sent, because foundry's own default is
 * already the right call there.
 *
 * BookForge used to also add `--base-model <gguf>` for ocr and blocks, pointing
 * foundry at unpublished checkpoints on the owner's machine; those families
 * were retrained and published as foundry's own adapters, so the override is
 * gone and foundry resolves base + adapter from its catalog for all three
 * stages.
 *
 * Exported because a foundry stage is not always a stage of a RUN — `foundry
 * footnotes --epub` is the same binary and the same server pointed at a finished
 * book, driven from `processing-passes.ts`.
 */
export async function foundryLlamaServerArgs(): Promise<string[]> {
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
  const args = ['--llama-server', llamaServer];

  if (process.platform !== 'darwin') {
    // Lazy require, like llama-bridge above, so the test harness can stub it.
    const { systemProbe } =
      require('./components/system-probe') as typeof import('./components/system-probe');
    const prof = await systemProbe.profile();
    const vramMB = prof.cuda.available ? prof.cuda.vramMB : undefined;
    if (vramMB !== undefined && vramMB >= FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB) {
      args.push('--gpu-layers', '99');
      console.log(
        `[foundry] llama-server offload: full (${vramMB} MB VRAM holds the `
        + `~${FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB} MB working set)`
      );
    } else if (prof.cuda.available) {
      // A GPU is present but cannot hold the working set (or would not report
      // its VRAM, which for a budgeting decision is the same thing). Said out
      // loud, because "foundry is slow" on this machine is THIS line.
      console.log(
        `[foundry] llama-server offload: none — CPU inference `
        + `(VRAM ${vramMB === undefined ? 'unreadable' : `${vramMB} MB`}, `
        + `working set needs ~${FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB} MB)`
      );
    } else {
      console.log('[foundry] llama-server offload: none — CPU inference (no CUDA GPU)');
    }
  }
  return args;
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
      + `Run the OCR correction pass over this book — it starts a fresh run directory.`
    );
  }

  return new Set(
    Object.entries(run.stages)
      .filter(([, state]) => state.status === 'done')
      .map(([name]) => name)
  );
}

/**
 * Where a stage's artifacts live, relative to the run directory. foundry writes
 * `scan/…`, `ocr/lines.json`, `blocks/blocks.json`, `footnotes/deletions.json` —
 * the stage name IS the directory name, and this states that rather than
 * assuming it in four places.
 */
const STAGE_DIR: Record<FoundryWorkStage, string> = {
  scan: 'scan',
  ocr: 'ocr',
  blocks: 'blocks',
  footnotes: 'footnotes',
};

/**
 * Throw away what these stages produced, so they run again from nothing.
 *
 * This is what makes "every stage named in a run runs" true rather than
 * aspirational: without it, `foundry footnotes --run` over a directory that
 * already holds a deletion list would be handed a done marker and a stale
 * artifact, and the pass the user re-submitted to test a new model would return
 * the old model's answer in under a second.
 *
 * The done MARKER is cleared as well as the artifact, not because anything here
 * reads it — the stage list decides what runs now — but because a crash between
 * this and foundry's own `running` mark would otherwise leave `run.json` calling
 * a stage done whose output is gone, which `export` reads as "no footnotes were
 * removed". A record that cannot be read is warned about and left: the artifacts
 * are already gone, and foundry rewrites the record itself when the stage runs.
 */
function clearStages(runDir: string, stages: readonly FoundryWorkStage[]): void {
  if (stages.length === 0) return;
  for (const stage of stages) {
    fs.rmSync(path.join(runDir, STAGE_DIR[stage]), { recursive: true, force: true });
  }

  const runFile = path.join(runDir, 'run.json');
  if (!fs.existsSync(runFile)) return;
  try {
    const run = JSON.parse(fs.readFileSync(runFile, 'utf-8')) as { stages?: Record<string, unknown> };
    if (!run.stages) return;
    for (const stage of stages) {
      if (run.stages[stage] !== undefined) run.stages[stage] = { status: 'pending' };
    }
    // Atomic: a run directory can sit in a synced folder, and a half-written
    // run.json is a directory nothing can read.
    const tmp = `${runFile}.bookforge.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, runFile);
  } catch (err) {
    console.warn(
      `[foundry-run] cleared ${stages.join('+')} in ${runDir} but could not update run.json:`,
      err
    );
  }
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

  // Resolve the binary BEFORE anything is rendered, so a machine that has no
  // foundry does not rasterize 350 pages first.
  //
  // The WEIGHTS are deliberately not pre-checked. Every model stage now resolves
  // its own from foundry's catalog, and re-deriving that catalog's filenames and
  // data directory over here would be a second copy of it, drifting the day a
  // model is superseded. foundry's own failure names the model id, the path and
  // `foundry models pull`, which is the fix — the only thing lost is a few
  // minutes of rendering on a run that also asked for a scan.
  //
  // `ensureFoundryPath` rather than `requireFoundryPath`: a machine with no
  // foundry gets one here instead of being told to go and find one. A queued
  // pass has already awaited this (processing-passes does it where the job's own
  // progress bar can show the download), so for the queue this is the cheap
  // stat; for a run the picker started directly, this IS the download.
  await ensureFoundryPath();

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
          + `${wanted.join('+')} pass was given ${opts.pages.length}. Run the OCR correction pass `
          + 'over the new page set first — it reads the pages again; a later stage cannot re-cut '
          + 'the pages under it.'
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
      + `book (${runDir}). Run the ${needs === 'blocks' ? 'Detection' : 'OCR correction'} pass `
      + `first — ${needs === 'blocks'
        ? 'it is what labels every block of the scanned pages'
        : 'it is what reads the pages and repairs what was misread'}.`
    );
  }

  // Everything this run is about to produce, thrown away first. The prerequisites
  // it merely READS are not in `wanted` and are not touched — a footnotes pass
  // stands on the ocr artifact, it does not rebuild it. AFTER the prerequisite
  // check, so a refused run has deleted nothing, and after the wipe, where it is
  // a no-op on an empty directory.
  clearStages(runDir, wanted);

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
      // Position within THIS run's stage list, so a two-stage pass reads "2/2"
      // rather than "3/5" of a pipeline it is not running.
      //
      // No stage is skipped for having been done before: `clearStages` above
      // already threw its artifacts away, and a caller naming a stage is asking
      // for that stage to happen.
      let stageIndex = 0;
      const nextIndex = () => ++stageIndex;

      // ── render + scan ──────────────────────────────────────────────────────
      if (wanted.includes('scan')) {
        // A partial pages dir is re-rendered whole rather than topped up: the
        // input hash foundry records covers the SET, and reasoning about which
        // of 350 files is stale is a worse bet than three minutes of mupdf.
        //
        // A COMPLETE one is reused, and that is not a cached stage: a page render
        // is mupdf rasterizing the PDF at a pinned 200 dpi, the same bytes every
        // time, with no model and no version of ours in it. The caller that
        // re-reads the pages (the OCR-correction pass) wipes the whole directory
        // anyway, so it never meets this branch.
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
      if (wanted.includes('ocr')) {
        await runStage(run, 'ocr', nextIndex(), stageCount, [
          'ocr', '--run', runDir, ...await foundryLlamaServerArgs(),
        ]);
      }

      // ── blocks ────────────────────────────────────────────────────────────
      if (wanted.includes('blocks')) {
        await runStage(run, 'blocks', nextIndex(), stageCount, [
          'blocks', '--run', runDir, ...await foundryLlamaServerArgs(),
        ]);
      }

      // ── footnotes (optional) ──────────────────────────────────────────────
      if (wanted.includes('footnotes')) {
        await runStage(run, 'footnotes', nextIndex(), stageCount, [
          'footnotes', '--run', runDir, ...await foundryLlamaServerArgs(),
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

/** Why an attach came back empty, when it came back empty because it swept. */
export interface FoundryRunCleared {
  /** The stage that failed, or null when it failed before one started. */
  stage: FoundryRunStageName | null;
  /** foundry's own words for the failure. */
  message: string;
}

/**
 * Attach, except that a FAILED run is swept instead of handed over.
 *
 * A run that ended in error produced nothing usable, but the record of it stayed
 * on disk and kept answering "there is a run here" — enough to trip the export
 * gate and to make the picker act as though foundry output existed. Treating it
 * as nothing, and saying once what went wrong, is the whole recovery model: the
 * user re-runs the stage.
 *
 * Deliberately narrow:
 * - Only `error`. A `cancelled` run's artifacts are real and back the OCR
 *   modal's Resume affordance; resuming costs GB of model load and is the
 *   user's decision (see `FoundryRunState.live`), so cancelling must not also
 *   destroy. That includes a `running` run demoted to `cancelled` here because
 *   the app died mid-run — the demotion speaks first, and a demoted run is kept.
 * - The directory removed is `foundryRunDir(bookKey)`, DERIVED. Never the
 *   persisted `state.runDir`: a recursive delete target must not come off disk,
 *   where a hand-edited or collided record could aim it anywhere.
 * - `runs.delete` is not optional. Leaving the in-memory entry means the next
 *   attach re-finds the same failure and reports it again, so "cleared" would
 *   fire on every book open instead of once.
 *
 * `attachFoundryRun` stays a pure read for everyone else — the passes read a
 * previous run's `pages` through it and one caller is a guard.
 */
export function attachOrClearFoundryRun(
  bookKey: string
): { state: FoundryRunState | null; cleared?: FoundryRunCleared } {
  const state = attachFoundryRun(bookKey);
  if (!state || state.status !== 'error') return { state, cleared: undefined };

  const cleared: FoundryRunCleared = {
    stage: state.stage,
    message: state.error || state.message || 'The foundry run failed without a message.',
  };
  runs.delete(bookKey);
  const dir = foundryRunDir(bookKey);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // The reason still has to reach the user, and the in-memory entry is already
    // gone, so a directory that refuses to go is a warning, not a failed attach.
    console.warn(`[foundry-run] could not delete the failed run at ${dir}:`, err);
  }
  console.log(`[foundry-run] cleared the failed run for ${bookKey}: ${cleared.stage ?? 'no stage'} — ${cleared.message}`);
  return { state: null, cleared };
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
 * The id is foundry's OWN block id, unchanged, so a block on screen and a block
 * in `blocks/blocks.json` are the same thing while the run is painted. It is NOT
 * an identity that outlives the run: the blocks stage re-mints ids by position
 * on every re-run, so what the user DELETED is persisted as `line_ids` — see
 * `shared/foundry/block-exclusions.ts`.
 */
export interface FoundryPickerBlock {
  id: string;
  /**
   * The scan lines this block is made of, foundry's ids, in reading order.
   *
   * The stable identity of the block's content: line ids are minted once by the
   * scan stage and survive every ocr and blocks re-run. Deletions are recorded
   * as these and resolved back to block ids at export.
   */
  line_ids: string[];
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
  /**
   * `run.json`'s `runId` — the identity of the SCAN the line ids below belong
   * to. Stamped onto persisted deletions so a re-scan (an OCR-correction pass,
   * or a changed page set: both recreate the run directory) is caught rather
   * than silently renumbering what the user deleted.
   */
  scanId: string;
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
      line_ids: [...block.lineIds],
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
    scanId: dir.run.runId,
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
  /**
   * What the user deleted, as SCAN LINE ids plus the scan they belong to.
   *
   * Not block ids: those are re-minted by position every time the blocks stage
   * runs, so a list of them written before an ocr/blocks re-run names different
   * blocks afterwards. The block ids `foundry export` takes are derived from
   * these here, against the blocks that are on disk at this moment
   * (`shared/foundry/block-exclusions.ts`).
   */
  excludeLines: FoundryDeletedLines;
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
 * Deleted lines → the block ids `foundry export` takes, against THIS run.
 *
 * The scan stamp is checked first and refuses rather than resolving: line ids
 * are indices into one scan, so a record written against a different one would
 * resolve to real blocks holding text nobody deleted. The two things that
 * replace a scan — an OCR-correction pass, which always re-reads the pages, and
 * a changed page set — both recreate the run directory, and with it `run.json`'s
 * `runId`.
 */
export function resolveExportExclusions(
  bookKey: string,
  lines: FoundryDeletedLines,
): string[] {
  if (lines.lineIds.length === 0) return [];
  const run = readFoundryRun(bookKey);
  if (lines.scanId !== run.scanId) {
    throw new Error(
      `The ${lines.lineIds.length} deleted block(s) recorded for this book belong to scan `
      + `${lines.scanId || '(unstamped)'}, but the run at ${run.runDir} is scan ${run.scanId}. `
      + 'The book has been re-scanned since those deletions were made, so the lines they name '
      + 'are not these lines. Open the book in the PDF editor: the deletions re-attach to the '
      + 'boxes on screen and are re-recorded against this scan, and you can check them before '
      + 'exporting again. Refusing to export — applying them as they are would drop different '
      + 'blocks.'
    );
  }
  return resolveExcludedBlockIds(
    run.blocks.map((b) => ({ id: b.id, page: b.page, lineIds: b.line_ids })),
    lines.lineIds,
  );
}

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
 *
 * ── Why the block ids are derived HERE ───────────────────────────────────────
 *
 * The request carries scan LINE ids (`excludeLines`), and the block ids the CLI
 * takes are worked out from them against the blocks on disk at this moment. The
 * blocks stage re-mints its ids by position on every run, so a caller that held
 * block ids from before an ocr/blocks re-run would be naming other blocks —
 * which is the bug that took the Kershaw export down (Aug 3 2026). One place
 * does the derivation, so the picker's export and the queue's cannot drift.
 */
export async function foundryExport(req: FoundryExportRequest): Promise<{ epubPath: string }> {
  const saved = readPersisted(req.bookKey);
  if (!saved) {
    throw new Error(`No foundry run for this book; there is nothing to export. Run OCR first.`);
  }
  await ensureFoundryPath();

  const ids = resolveExportExclusions(req.bookKey, req.excludeLines);

  const exportDir = path.join(saved.runDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const idsFile = path.join(exportDir, 'bookforge-exclude-ids.txt');
  fs.writeFileSync(
    idsFile,
    [
      '# Block ids deleted in pdf-picker. Written by BookForge; read by `foundry export`.',
      '# DERIVED, not the record: the record is the scan line ids in',
      '# bookforge-deleted-lines.json, which survive a blocks re-run. These ids do not.',
      `# ${new Date().toISOString()} — ${ids.length} block(s) from `
      + `${req.excludeLines.lineIds.length} deleted line(s)`,
      ...ids,
      '',
    ].join('\n')
  );

  // The RECORD, next to the list derived from it. A run directory that holds
  // both can be re-exported after any number of ocr/blocks re-runs; one holding
  // only block ids can be re-exported until the next re-run and no further.
  fs.writeFileSync(
    path.join(exportDir, 'bookforge-deleted-lines.json'),
    `${JSON.stringify(
      {
        _comment:
          'Scan lines deleted in pdf-picker, and the scan (run.json runId) they are numbered '
          + 'against. The block ids in bookforge-exclude-ids.txt are derived from these.',
        _written: new Date().toISOString(),
        scanId: req.excludeLines.scanId,
        lineIds: [...new Set(req.excludeLines.lineIds)].sort(),
      },
      null,
      2
    )}\n`
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
