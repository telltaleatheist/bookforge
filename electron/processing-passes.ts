/**
 * processing-passes — one pass over the project's book, run as a queue job.
 *
 * The model is in docs/PROCESSING_PIPELINE_V2.md, and this module is where it
 * becomes code. There is ONE book per project — `manifest.outputs.epub` — and a
 * pass reads it, transforms it, and writes it back to THE SAME PATH. Nothing
 * here produces a `cleaned.epub` or a `translated.epub` for a later step to hunt
 * for: the stage directories hold a pass's working files and its diff, never the
 * book.
 *
 * ── WHY IN PLACE ─────────────────────────────────────────────────────────────
 *
 * The stage copies were a per-stage snapshot of a pipeline with a fixed shape.
 * Passes have no fixed shape — translate → OCR-correct → simplify → translate
 * back is legal, and the user orders them — so "which file is the book now?"
 * stops having a static answer and every consumer that guessed one was wrong for
 * some ordering. One path, one book, and `appliedPasses` says what happened to
 * it.
 *
 * ── WHY EACH PASS STILL LEAVES A DIFF ────────────────────────────────────────
 *
 * Writing in place is what makes the diffs necessary rather than optional: after
 * the third pass, the text the second pass ended at exists nowhere. So a pass
 * diff carries its own after-text (see writePassDiff) and is readable forever,
 * long after the book has moved on.
 *
 * ── THE FOUNDRY PASSES ARE DIFFERENT, AND HOW ────────────────────────────────
 *
 * OCR correction and footnote removal do not touch an EPUB at all — they operate
 * on a foundry RUN DIRECTORY (machine-local, hundreds of MB) and
 * the book is exported from it. So a chain of foundry passes ends in one
 * `foundry export`, and only then does the project have a book for those passes
 * to be recorded against. Their diffs come from foundry's own artifacts, keyed
 * by page, because there is no before-EPUB and after-EPUB to compare.
 *
 * ── EXCEPT FOOTNOTE REMOVAL, WHICH IS BOTH ───────────────────────────────────
 *
 * `foundry footnotes` reads either a run directory or a finished EPUB, and the
 * plan says which (`PassJobConfig.footnotesMode`). In `epub` mode it is an
 * ordinary EPUB pass in every way that matters here: it reads
 * `manifest.outputs.epub`, writes a new archive, and that archive is renamed
 * onto the book. The markers it removes there were never OCR debris — they are
 * `<sup><a href="#fn3">3</a></sup>` in a publisher's markup, which a narrator
 * reads out loud as a number.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserWindow } from 'electron';

import * as manifestService from './manifest-service';
import type { AppliedPassKind } from './manifest-types';
import {
  ensureFoundryPath,
  readEpubFootnotesReport,
  readRunDirectory,
  runFoundry,
  type FoundryBlock,
  type FoundryEpubFootnoteApplied,
  type FoundryEpubFootnotesReport,
  type FoundryScanLine,
} from './foundry-bridge';
import {
  attachFoundryRun,
  awaitFoundryRun,
  foundryExport,
  foundryLlamaServerArgs,
  foundryStagesDone,
  parseProgress,
  readFoundryRun,
  startFoundryRun,
  onFoundryRunProgress,
  type FoundryRunStageName,
  type FoundryWorkStage,
} from './foundry-run';
import {
  isFoundryBlockId,
  type FoundryDeletedLines,
} from '../shared/foundry/block-exclusions';
import { StageTracker, type JobStageProgress } from './job-stages';
import { writePassDiff, type DiffChange, type PassDiffUnit } from './diff-cache';
import { loadEpubForComparison } from './epub-processor';
import type {
  PassJobConfig,
  PassJobResult,
} from '../shared/processing/pass-types';

// ─────────────────────────────────────────────────────────────────────────────
// The job's shape
// ─────────────────────────────────────────────────────────────────────────────

export type {
  PassJobConfig,
  PassJobResult,
  SimplifyPassParams,
  TranslatePassParams,
} from '../shared/processing/pass-types';

// ─────────────────────────────────────────────────────────────────────────────
// The book
// ─────────────────────────────────────────────────────────────────────────────

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * The project's book EPUB, or a refusal naming the project.
 *
 * `outputs.epub` is the only answer. A project with no record has no book — not
 * "look in source/ and hope", which is the guessing this record exists to end.
 */
export async function requireBookEpub(projectDir: string): Promise<string> {
  const record = await manifestService.readExportEpub(projectDir);
  if (!record) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB recorded (manifest outputs.epub), so a pass has `
      + 'nothing to read. Export the book from the editor, or put a foundry pass ahead of this one.'
    );
  }
  if (!fs.existsSync(record.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s manifest records its book as ${record.relPath}, but that file is `
      + 'not there. Re-export it before running passes over it.'
    );
  }
  return record.absPath;
}

/**
 * Put a pass's output in the book's place, atomically.
 *
 * The produced file is renamed ONTO the recorded path — one filesystem
 * operation, so a reader (or Syncthing) sees the old book or the new one and
 * never a half-written one. The rename also deletes the working copy, which is
 * what keeps a stage directory from becoming a second place a book lives.
 */
async function replaceBookEpub(projectDir: string, producedAbsPath: string): Promise<string> {
  const bookPath = await requireBookEpub(projectDir);
  if (!fs.existsSync(producedAbsPath)) {
    throw new Error(`The pass reported success but wrote no file at ${producedAbsPath}.`);
  }
  await moveIntoPlace(producedAbsPath, bookPath);
  return bookPath;
}

/**
 * Move a finished file to where it belongs, atomically at the destination.
 *
 * The last step is always a rename WITHIN the destination's filesystem, which is
 * the only step Syncthing (and any reader) is guaranteed to see as all-or-nothing.
 * A plain rename does that already when both paths share a filesystem; when they
 * do not — a pass working in /tmp, a library on another volume — the copy lands
 * beside the destination first and the rename happens there.
 */
async function moveIntoPlace(fromAbsPath: string, toAbsPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(toAbsPath), { recursive: true });
  try {
    await fs.promises.rename(fromAbsPath, toAbsPath);
  } catch {
    const sibling = `${toAbsPath}.bookforge-tmp`;
    await fs.promises.copyFile(fromAbsPath, sibling);
    await fs.promises.rename(sibling, toAbsPath);
    await fs.promises.unlink(fromAbsPath);
  }
}

function absStage(config: PassJobConfig): string {
  return path.join(config.projectDir, config.stageRelDir.split('/').join(path.sep));
}

function diffPaths(config: PassJobConfig): { rel: string; abs: string } {
  return {
    rel: `${config.stageRelDir}/diff.json`,
    abs: path.join(absStage(config), 'diff.json'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

function sendProgress(
  mainWindow: BrowserWindow | null | undefined,
  jobId: string,
  kind: AppliedPassKind,
  percentage: number,
  message: string,
  stages?: JobStageProgress[]
): void {
  mainWindow?.webContents.send('queue:progress', {
    jobId,
    type: kind,
    phase: 'processing',
    progress: Math.max(0, Math.min(100, Math.round(percentage))),
    message,
    // Only ever sent when the pass HAS a breakdown to report. A job type whose
    // bridge reports no stages renders its single overall bar, which is the
    // honest answer rather than a fabricated one — see queue/models/job-stages.ts.
    ...(stages ? { stages } : {}),
  });
}

/**
 * The foundry binary, downloaded into THIS job if the machine has none.
 *
 * The download belongs to the job for the same reason the speech-to-text engine
 * install belongs to its job (generate-sentences-bridge): a queue is where a
 * multi-second fetch is legible — it has a progress bar, a log and a failure
 * state — whereas the alternative is a pass that refuses to start and asks the
 * user to go and find a binary.
 *
 * The bar stays at 0 with foundry's download percentage in the message, so the
 * pass itself still owns the whole 0–100 range. Two passes queued together share
 * ONE download (ensureFoundryPath serializes) and both draw it.
 */
async function ensureFoundryForJob(
  jobId: string,
  kind: AppliedPassKind,
  mainWindow: BrowserWindow | null | undefined
): Promise<void> {
  await ensureFoundryPath((p) => {
    if (p.message) sendProgress(mainWindow, jobId, kind, 0, p.message);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Foundry passes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stages each foundry pass owns. `ocr-correction` is THREE of them, always.
 *
 * Reading the pages, repairing what was read and labelling the blocks are one
 * pass: none is separately useful (repair has nothing to read without the scan;
 * a scan with no layout is not a book), so they are one queue job with one row —
 * and, because they are genuinely three different pieces of work with three
 * different units, three progress bars. See FOUNDRY_STAGE_BARS.
 */
const FOUNDRY_STAGES: Record<'ocr-correction' | 'footnotes', FoundryWorkStage[]> = {
  'ocr-correction': ['scan', 'ocr', 'blocks'],
  footnotes: ['footnotes'],
};

/**
 * The bars a foundry pass draws, in execution order.
 *
 * `render` is not one of foundry's stages — it is BookForge rasterizing the pages
 * for foundry to scan — but it is a stage of the RUN (`foundry-run` counts it in
 * `stageCount`), it takes minutes on a full book, and it has its own unit. So it
 * gets its own bar rather than being folded into Tesseract's, which would need an
 * invented split of that bar between two kinds of work.
 *
 * Weights are equal and deliberately so. The stages cost wildly different amounts
 * (the ocr stage is ~0.8 s a line and dominates a book), but this app has no
 * measurement of that ratio, and a guessed weight is a number the ETA would treat
 * as measured. Equal weight is the neutral statement, and it reproduces exactly
 * the overall percentage this pass reported before the bars existed.
 */
const FOUNDRY_STAGE_BARS: Record<FoundryRunStageName, { label: string }> = {
  render: { label: 'Render pages' },
  scan: { label: 'Tesseract' },
  ocr: { label: 'OCR correction' },
  blocks: { label: 'Detection' },
  footnotes: { label: 'Footnote removal' },
};

/**
 * The bars for one pass's stage list: `render` sits in front of `scan`, because
 * the pages have to exist before Tesseract can read them.
 */
function stageBarNames(stages: readonly FoundryWorkStage[]): FoundryRunStageName[] {
  return stages.flatMap((s): FoundryRunStageName[] => (s === 'scan' ? ['render', 'scan'] : [s]));
}

/**
 * The run identity for a project's PDF.
 *
 * The picker keys a run by the document's file hash when it has one and by its
 * path when it does not — and inside a project (embedded mode) it never has one,
 * so the path IS the key there. A chain uses the same key so a run the user
 * started by hand and a run the queue continues are one run, not two.
 */
function resolveBookKey(config: PassJobConfig): string {
  const key = config.bookKey || config.pdfPath;
  if (!key) {
    throw new Error(`A ${config.kind} pass needs the PDF it reads; none was given.`);
  }
  return key;
}

/**
 * The foundry run each pass job is currently driving, so a Stop on the queue row
 * reaches the run that is spending the GPU. Only foundry passes are here: a
 * simplify pass is cancelled through ai-bridge's own per-job abort controller,
 * which `queue:cancel-job` already calls.
 */
const activeFoundryPasses = new Map<string, string>();

/**
 * The foundry SUBPROCESS an EPUB-mode pass is driving. It has no run directory
 * and no run record — it is one process from start to finish — so stopping it is
 * an abort signal on the spawn rather than a message to `foundry-run`.
 */
const activeFoundrySubprocesses = new Map<string, AbortController>();

export async function cancelProcessingPass(jobId: string): Promise<boolean> {
  const subprocess = activeFoundrySubprocesses.get(jobId);
  if (subprocess) {
    subprocess.abort();
    return true;
  }
  const bookKey = activeFoundryPasses.get(jobId);
  if (!bookKey) return false;
  const { cancelFoundryRun } = await import('./foundry-run.js');
  await cancelFoundryRun(bookKey);
  return true;
}

async function runFoundryPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const kind = config.kind as 'ocr-correction' | 'footnotes';
  const stages = FOUNDRY_STAGES[kind];
  const bookKey = resolveBookKey(config);
  if (!config.pdfPath) {
    throw new Error(
      `The ${kind} pass reads a PDF through foundry, and this run was given none. `
      + 'Pick the project\'s PDF variant, or drop this pass from the run.'
    );
  }
  const pages = config.pages?.length
    ? config.pages
    : attachFoundryRun(bookKey)?.pages;
  if (!pages?.length) {
    throw new Error(
      `The ${kind} pass was given no pages and there is no earlier run for this book to take them `
      + 'from. Run the OCR correction pass first.'
    );
  }

  // ── The bars ────────────────────────────────────────────────────────────────
  //
  // One bar per stage this job runs, each reporting its OWN unit — pages, then
  // lines, then blocks. EVERY BAR STARTS EMPTY, because every stage is about to
  // run: a submitted pass re-runs its own stages, and `startFoundryRun` clears
  // what they produced before it starts them. Bars used to be seeded from
  // `run.json` for stages the book had already had, which was honest while a
  // finished stage was skipped and is a lie now — it would report this morning's
  // work as this run's, at 100%, before this run had done anything.
  const barNames = stageBarNames(stages);
  const tracker = new StageTracker(
    barNames.map((name) => ({ name, label: FOUNDRY_STAGE_BARS[name].label, weight: 1 }))
  );
  // More than one bar, or none: a single bar under an identical overall bar is
  // noise, not a breakdown.
  const barsOf = (): JobStageProgress[] | undefined =>
    (barNames.length > 1 ? tracker.snapshot() : undefined);

  const unsubscribe = onFoundryRunProgress((state) => {
    if (state.bookKey !== bookKey) return;
    // The run's own stage names ARE the bar names, so nothing translates between
    // them; a stage this job did not declare (another window running footnotes
    // over the same book) moves no bar, by StageTracker's own rule.
    if (state.stage) {
      tracker.set(state.stage, state.total > 0 ? (state.done / state.total) * 100 : 0);
    }
    sendProgress(mainWindow, jobId, kind, tracker.master(), state.message, barsOf());
  });

  activeFoundryPasses.set(jobId, bookKey);
  try {
    // The bars before anything runs — which for a machine with no foundry is the
    // whole of a 38 MB download.
    sendProgress(mainWindow, jobId, kind, tracker.master(), 'Preparing…', barsOf());
    await ensureFoundryForJob(jobId, kind, mainWindow);
    await startFoundryRun({
      bookKey,
      pdfPath: config.pdfPath,
      pages,
      stages,
      // The OCR unit re-reads the pages, and every other artifact in the run
      // directory is derived from that read — the footnote deletion list names
      // scan line ids that are about to stop existing, and foundry's export
      // refuses it. So this pass starts the directory over rather than clearing
      // only the three stages it names. The pass that does NOT re-read the pages
      // (footnotes) clears its own stage and leaves the scan alone.
      //
      // Unconditional, because it is not a preference: a job in the queue is
      // someone asking for this work to happen.
      redo: kind === 'ocr-correction',
    });
    await awaitFoundryRun(bookKey);

    // The run may have been one already in flight (two windows, a picker run the
    // user started) — in which case it finished whatever IT was doing, not what
    // this pass asked for. Check the post-condition rather than trusting that a
    // finished run is a finished pass.
    const done = foundryStagesDone(bookKey);
    const missing = stages.filter((s) => !done.has(s));
    if (missing.length > 0) {
      throw new Error(
        `The foundry run for this book finished without its ${missing.join(' and ')} stage(s). `
        + 'Another run for the same book was probably already in flight; start this pass again.'
      );
    }

    // Every stage this job owns has just been verified as done, so every bar it
    // draws is full — including any the run skipped without a progress line.
    tracker.completeAll();

    const diff = diffPaths(config);
    if (kind === 'ocr-correction') await writeOcrCorrectionDiff(bookKey, diff.abs);
    if (kind === 'footnotes') await writeFootnoteDiff(bookKey, diff.abs);

    if (!config.exportAfter) {
      // The book is still unbuilt: this pass's record is written by whichever
      // pass carries the export (see below), because until then the project has
      // no `outputs.epub` for a record to describe.
      return { success: true };
    }

    sendProgress(mainWindow, jobId, kind, 97, 'Building the EPUB…', barsOf());
    const epubPath = await exportBookFromRun(config, bookKey);

    // Record every foundry pass this export materialized, in execution order.
    // registerEpubExport starts the book's provenance over — correctly: a freshly
    // exported book has had nothing else done to it — so these are appended after.
    const at = new Date().toISOString();
    for (const pass of config.exportPasses ?? [{ kind }]) {
      const params = pass.params ?? foundryPassParams(pass.kind, bookKey);
      await manifestService.appendAppliedPass(config.projectDir, {
        kind: pass.kind,
        at,
        ...(params ? { params } : {}),
        ...(pass.diff ? { diff: pass.diff } : {}),
      });
    }
    return { success: true, outputPath: epubPath };
  } finally {
    activeFoundryPasses.delete(jobId);
    unsubscribe();
  }
}

/**
 * Which weights a foundry pass ran, for its provenance record.
 *
 * The model id is the useful half of "what did OCR correction do to this book" —
 * the answer changes when the model does, and a book cleaned by one checkpoint is
 * a different artifact from one cleaned by its successor.
 *
 * Every stage is asked the SAME way: read what foundry recorded in `run.json`.
 * BookForge no longer chooses any of these weights — foundry resolves base and
 * adapter from its own catalog — so its record is the only honest answer, and
 * naming a model from this side would be guessing at a catalog this app does not
 * own. A stage that recorded nothing gets no params rather than an invented one.
 */
function foundryPassParams(kind: AppliedPassKind, bookKey: string): Record<string, unknown> | undefined {
  if (kind !== 'ocr-correction' && kind !== 'footnotes') {
    // Tesseract has no model and no options: it is the segmenter, pinned at 200 dpi.
    return undefined;
  }

  const state = attachFoundryRun(bookKey);
  const models = state ? readRunDirectory(state.runDir).run.models : undefined;
  const base = models?.base ? { base: models.base } : {};

  if (kind === 'ocr-correction') {
    // Two stages, two adapters — the OCR-correction pass runs `ocr` and `blocks`.
    if (!models?.ocr && !models?.blocks) {
      console.warn(
        `[processing-passes] the run for ${bookKey} finished its ocr/blocks stages without recording `
        + 'which models answered (run.json models.ocr / models.blocks), so the pass record cannot name them.'
      );
      return undefined;
    }
    return {
      ...(models.ocr ? { ocrModel: models.ocr } : {}),
      ...(models.blocks ? { blocksModel: models.blocks } : {}),
      ...base,
    };
  }

  if (!models?.footnotes) {
    console.warn(
      `[processing-passes] the run for ${bookKey} finished its footnotes stage without recording `
      + 'which model answered (run.json models.footnotes), so the pass record cannot name one.'
    );
    return undefined;
  }
  return { model: models.footnotes, ...base };
}

/**
 * `foundry export` into the project's canonical book path, recorded.
 *
 * The exclusion list is the editor's deletions read out of the manifest as SCAN
 * LINE ids (`source.deletedBlockLines`), which is the only identity that
 * survives this chain: the ocr and blocks stages have just re-run, and the
 * blocks stage re-mints block ids by position, so the block ids the editor
 * deleted under name other blocks now. `foundryExport` derives the current ones.
 *
 * A project whose deletions predate that record — block ids and nothing else —
 * is REFUSED here rather than exported with them. They cannot be resolved
 * (nothing on disk says which lines they were), and shipping them as-is is what
 * dropped the wrong blocks / failed the Kershaw export on Aug 3 2026.
 *
 * A deleted PAGE is a deletion too: `source.deletedPages` holds source page
 * indices, and every line on one of them is excluded. The run's blocks are the
 * universe for this (readFoundryRun maps block pages back to source indices) —
 * the deletions alone would ship every block of a page the user removed whole.
 */
async function exportBookFromRun(config: PassJobConfig, bookKey: string): Promise<string> {
  const target = await manifestService.exportEpubTarget(config.projectDir);
  const cover = await manifestService.resolveProjectCover(config.projectDir);
  const manifestPath = path.join(config.projectDir, 'manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as {
    source?: {
      deletedBlockIds?: string[];
      deletedBlockLines?: FoundryDeletedLines;
      deletedPages?: number[];
    };
  };

  const record = manifest.source?.deletedBlockLines;
  const unrecorded = (manifest.source?.deletedBlockIds ?? []).filter(isFoundryBlockId);
  if (!record && unrecorded.length > 0) {
    throw new Error(
      `${unrecorded.length} block deletion(s) in ${manifestPath} were saved before BookForge `
      + 'recorded which scan lines a deleted block held, and this run has re-segmented the book, '
      + 'so those ids no longer name the blocks that were deleted. Open the book in the PDF '
      + 'editor — the deletions re-attach to the boxes on screen and are re-recorded by line — '
      + 'then run the pass again. Refusing to export: using them as they are would drop the '
      + 'wrong blocks.'
    );
  }

  const run = readFoundryRun(bookKey);
  if (record && record.scanId !== run.scanId) {
    throw new Error(
      `The deletions in ${manifestPath} belong to scan ${record.scanId || '(unstamped)'}, but the `
      + `run at ${run.runDir} is scan ${run.scanId} — the book has been re-scanned since they were `
      + 'made, so the lines they name are not these lines. Open the book in the PDF editor — the '
      + 'deletions re-attach to the boxes on screen and are re-recorded against this scan — check '
      + 'them, then run the pass again. Refusing to export: using them as they are would drop the '
      + 'wrong blocks.'
    );
  }

  const lineIds = new Set(record?.lineIds ?? []);
  const deletedPages = new Set(manifest.source?.deletedPages ?? []);
  if (deletedPages.size > 0) {
    for (const block of run.blocks) {
      if (deletedPages.has(block.page)) for (const id of block.line_ids) lineIds.add(id);
    }
  }

  const result = await foundryExport({
    bookKey,
    excludeLines: { scanId: run.scanId, lineIds: [...lineIds] },
    excludeCategories: [],
    outputPath: target.absPath,
    ...(cover ? { coverPath: cover } : {}),
  });
  await manifestService.registerEpubExport(config.projectDir, result.epubPath);
  return result.epubPath;
}

/**
 * What the OCR-repair stage changed, page by page.
 *
 * Not an EPUB-to-EPUB diff, because there is no before-EPUB: `blocks` runs in the
 * same pass, so the state before this pass cannot be exported at all. foundry's
 * own artifacts are the honest source — `scan/lines.json` is what Tesseract read
 * and `ocr/lines.json` is what will ship, line for line, same ids.
 */
async function writeOcrCorrectionDiff(bookKey: string, diffAbsPath: string): Promise<void> {
  const state = attachFoundryRun(bookKey);
  if (!state) throw new Error(`No foundry run for ${bookKey}; its OCR diff cannot be written.`);
  const dir = readRunDirectory(state.runDir);
  if (!dir.lines || !dir.ocrLines) {
    throw new Error(
      `The run at ${state.runDir} has no OCR stage output, so the OCR-correction pass has nothing `
      + 'to report. This is a foundry run that reported success without writing ocr/lines.json.'
    );
  }

  const corrected = new Map(dir.ocrLines.map((l) => [l.id, l.text]));
  const byPage = new Map<number, FoundryScanLine[]>();
  for (const line of dir.lines) {
    const list = byPage.get(line.page);
    if (list) list.push(line);
    else byPage.set(line.page, [line]);
  }

  const units: PassDiffUnit[] = [];
  for (const [pageIndex, lines] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const before = lines.map((l) => l.text).join('\n');
    const after = lines.map((l) => corrected.get(l.id) ?? l.text).join('\n');
    if (before === after) continue;
    const docPage = state.pages[pageIndex];
    units.push({
      id: `page-${pageIndex}`,
      title: docPage === undefined ? `Page ${pageIndex + 1}` : `Page ${docPage + 1}`,
      before,
      after,
    });
  }
  await writePassDiff(diffAbsPath, units);
}

/**
 * Which footnote reference markers were removed, block by block.
 *
 * The changes are taken from foundry's deletion list rather than derived from a
 * word diff, and that is the whole point: a marker is routinely removed at the
 * exact spot a quote is straightened, and a word diff emits ONE edit that reads
 * as a quote change with the marker removal invisible inside it.
 */
async function writeFootnoteDiff(bookKey: string, diffAbsPath: string): Promise<void> {
  const state = attachFoundryRun(bookKey);
  if (!state) throw new Error(`No foundry run for ${bookKey}; its footnote diff cannot be written.`);
  const dir = readRunDirectory(state.runDir);
  if (!dir.footnoteDeletions) {
    throw new Error(
      `The run at ${state.runDir} has no footnotes stage output, so the footnote pass has nothing `
      + 'to report.'
    );
  }
  const pageOfBlock = new Map((dir.blocks ?? []).map((b: FoundryBlock) => [b.id, b.page]));

  const units: PassDiffUnit[] = [];
  for (const deletion of dir.footnoteDeletions) {
    if (deletion.applied.length === 0) continue;
    const after = deletion.text;
    const changes: DiffChange[] = [];
    let cursor = 0;
    let before = after;
    for (const edit of deletion.applied) {
      const pos = after.indexOf(edit.after, cursor);
      if (pos < 0) {
        // foundry recorded a deletion whose anchor is not in the text it also
        // recorded. Say which block; do not throw away the rest of the report.
        console.warn(
          `[processing-passes] ${deletion.blockId}: the anchor "${edit.after}" is not in the block's `
          + 'text, so that marker removal is missing from the diff.'
        );
        continue;
      }
      changes.push({ pos, len: edit.after.length, add: edit.after, rem: edit.before, fn: 'inferred' });
      cursor = pos + edit.after.length;
      before = before.replace(edit.after, edit.before);
    }
    if (changes.length === 0) continue;
    const page = pageOfBlock.get(deletion.blockId);
    const docPage = page === undefined ? undefined : state.pages[page];
    units.push({
      id: deletion.blockId,
      title: docPage === undefined ? deletion.blockId : `Page ${docPage + 1}`,
      before,
      after,
      changes,
    });
  }
  await writePassDiff(diffAbsPath, units);
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor's export takes the same route
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The foundry passes a run has FINISHED, in execution order.
 *
 * Read from the run directory rather than from a plan, because the editor's
 * export has no plan: the user ran OCR correction on Tuesday, footnote removal
 * on Wednesday, and pressed Export on Thursday. The book that comes out is
 * everything the run directory holds, so everything the run directory holds is
 * what the export must record.
 *
 * `ocr-correction` needs BOTH its stages: it is one pass with two halves (repair
 * the lines, then lay them out), and a run with only one of them has not had it.
 */
function completedFoundryPasses(bookKey: string): Array<'tesseract' | 'ocr-correction' | 'footnotes'> {
  const done = foundryStagesDone(bookKey);
  const passes: Array<'tesseract' | 'ocr-correction' | 'footnotes'> = [];
  if (done.has('scan')) passes.push('tesseract');
  if (done.has('ocr') && done.has('blocks')) passes.push('ocr-correction');
  if (done.has('footnotes')) passes.push('footnotes');
  return passes;
}

/**
 * Give the EDITOR's export the same artifacts the queue's export leaves behind.
 *
 * The editor exports through `foundry:export` — the picker's Finalize button —
 * which for a long time wrote the book and recorded `outputs.epub` and nothing
 * else. So a book OCR-corrected and de-footnoted from the editor arrived in
 * Studio with no "What's been done" badges and no Review Changes, while the
 * identical run submitted from the wizard arrived with both. Same passes, same
 * run directory, two different books as far as the app was concerned.
 *
 * ── Two phases, and why ──────────────────────────────────────────────────────
 *
 * `plan()` writes the DIFFS. They come out of the run directory, so they can be
 * written before the book exists — and they MUST be, because a diff that cannot
 * be written has to stop the export rather than produce a book whose changes are
 * unreviewable. That is the failure this whole path exists to prevent.
 *
 * `commit()` writes the PROVENANCE, and cannot run earlier: `appendAppliedPass`
 * refuses a project with no `outputs.epub`, correctly — a pass record describes
 * a specific file, and until the export lands there is no file to describe. The
 * export also RESETS provenance (a rebuilt book has had nothing else done to it),
 * so these records are appended after it and number from 01.
 *
 * The diffs and the records are written by exactly the same functions the queue
 * path uses; only the source of the pass LIST differs, because only the source
 * of the pass list can differ.
 */
export async function prepareFoundryExportRecord(
  projectDir: string,
  bookKey: string
): Promise<{ commit: () => Promise<void> }> {
  const kinds = completedFoundryPasses(bookKey);
  const planned = kinds.map((kind, i) => {
    const stageRelDir = manifestService.passStageRelDir(i + 1, kind);
    return {
      kind,
      stageRelDir,
      diffRel: `${stageRelDir}/diff.json`,
      diffAbs: path.join(projectDir, stageRelDir.split('/').join(path.sep), 'diff.json'),
    };
  });

  for (const pass of planned) {
    // Tesseract has nothing to diff against — it IS the first reading of the page.
    if (pass.kind === 'ocr-correction') await writeOcrCorrectionDiff(bookKey, pass.diffAbs);
    if (pass.kind === 'footnotes') await writeFootnoteDiff(bookKey, pass.diffAbs);
  }

  return {
    commit: async () => {
      const at = new Date().toISOString();
      for (const pass of planned) {
        const params = foundryPassParams(pass.kind, bookKey);
        await manifestService.appendAppliedPass(projectDir, {
          kind: pass.kind,
          at,
          ...(params ? { params } : {}),
          ...(pass.kind === 'tesseract' ? {} : { diff: pass.diffRel }),
        });
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB passes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Footnote removal over the book EPUB — `foundry footnotes --epub`.
 *
 * The same binary, the same weights and the same applier as the run-mode pass;
 * what differs is that the markers live in a publisher's markup rather than in
 * OCR output, and that the result is a book rather than a deletion list. So this
 * is an EPUB pass end to end: read `outputs.epub`, produce a new archive, rename
 * it onto the book, record the pass.
 *
 * foundry never writes to its input, and it writes the output to a temporary
 * file and renames — but BOTH its outputs land in the machine-local staging
 * directory anyway, and are moved into the library only when they are complete.
 * The library is Syncthing-synced: a half-written EPUB there is a corrupt book
 * on another machine that looks like a real one.
 *
 * NO FALLBACKS. A missing binary, a missing GGUF, a nonzero exit or a missing
 * report each fail the job with the message that names the thing.
 */
async function runEpubFootnotesPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  // The book check first: a project with no book EPUB fails on the cheap stat,
  // not after a 38 MB download it was never going to use.
  const bookPath = await requireBookEpub(config.projectDir);
  await ensureFoundryForJob(jobId, 'footnotes', mainWindow);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });

  const askEverything = config.footnotes?.askEverything === true;
  const run = crypto.randomUUID();
  const stagedEpub = path.join(STAGING_DIR, `footnotes-${run}.epub`);
  const stagedReport = path.join(STAGING_DIR, `footnotes-${run}.report.json`);

  const args = [
    'footnotes',
    '--epub', bookPath,
    '-o', stagedEpub,
    '--report', stagedReport,
    // No --base-model: foundry resolves base and adapter from its own catalog
    // and serves the adapter with --lora-scaled, which is how it was trained and
    // how it was measured. What answered comes back in the report, so the
    // provenance record is foundry's own word for it.
    ...await foundryLlamaServerArgs(),
    // The two content skips (note bodies, index entries) are foundry's default.
    // The flag is only ever passed when the user asked for it.
    ...(askEverything ? ['--ask-everything'] : []),
  ];

  const abort = new AbortController();
  activeFoundrySubprocesses.set(jobId, abort);
  let result;
  try {
    sendProgress(mainWindow, jobId, 'footnotes', 0, 'Reading the book…');
    result = await runFoundry(args, {
      signal: abort.signal,
      onProgress: (line) => {
        const progress = parseProgress(line);
        // 0-90 %: the last tenth is the diff and the swap, which are this
        // module's work rather than foundry's.
        const within = progress && progress.total > 0 ? progress.done / progress.total : 0;
        sendProgress(mainWindow, jobId, 'footnotes', within * 90, line.trim());
      },
    });
  } finally {
    activeFoundrySubprocesses.delete(jobId);
  }

  if (result.code !== 0) {
    // foundry's stderr IS the message: every throw in that program names the
    // thing that is missing or wrong. Never summarized.
    throw new Error(
      `foundry footnotes failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`
    );
  }
  if (!fs.existsSync(stagedReport)) {
    throw new Error(
      `foundry footnotes exited 0 but wrote no report at ${stagedReport}, so there is no record `
      + 'of what it did to the book. The pass is refused rather than applied unreviewably.'
    );
  }
  if (!fs.existsSync(stagedEpub)) {
    throw new Error(`foundry footnotes exited 0 but wrote no book at ${stagedEpub}.`);
  }

  const report = readEpubFootnotesReport(stagedReport);
  console.log(
    `[processing-pass] footnotes --epub: ${report.totals.deletionsApplied} markers removed across `
    + `${report.totals.documentsEdited}/${report.totals.documents} documents `
    + `(${report.totals.deletionsRejected} refused by the guards)`
  );

  sendProgress(mainWindow, jobId, 'footnotes', 92, 'Working out what changed…');
  const before = await loadEpubForComparison(bookPath);
  const after = await loadEpubForComparison(stagedEpub);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, epubFootnoteDiffUnits(before.chapters, after.chapters, report));

  // The raw report stays beside the diff. The diff says what changed; the report
  // says what was ASKED — every refusal verbatim, every skip counted by reason —
  // and that is the number that decides whether this model may be pointed at a
  // library at all.
  await moveIntoPlace(stagedReport, path.join(stageDir, 'report.json'));

  sendProgress(mainWindow, jobId, 'footnotes', 97, 'Putting the book back…');
  const bookAfter = await replaceBookEpub(config.projectDir, stagedEpub);
  await manifestService.appendAppliedPass(config.projectDir, {
    kind: 'footnotes',
    at: new Date().toISOString(),
    params: {
      // foundry's own description of what answered — "adapter
      // foundry-footnotes-v1-4b on base foundry:4b" — rather than a path this
      // app chose, because it no longer chooses one.
      model: report.model,
      markersRemoved: report.totals.deletionsApplied,
      ...(askEverything ? { askEverything: true } : {}),
    },
    diff: diff.rel,
  });
  return { success: true, outputPath: bookAfter };
}

/**
 * The diff for an EPUB footnotes pass: the documents that changed, with the
 * marker removals located exactly.
 *
 * The texts come from the two books — the one that went in and the one that came
 * out — because those are the reader's units, and foundry copies an untouched
 * document through byte for byte, so "the text changed" is precisely "foundry
 * edited this document".
 *
 * The CHANGES come from the report rather than from a word diff, matching the
 * run-mode pass: foundry hands over the deletions themselves, so the change
 * count is the marker count and not a count of whatever a word differ decided
 * the edits were.
 */
function epubFootnoteDiffUnits(
  before: Array<{ id: string; title: string; text: string; path: string }>,
  after: Array<{ id: string; title: string; text: string; path: string }>,
  report: FoundryEpubFootnotesReport
): PassDiffUnit[] {
  const rowsByDocument = new Map<string, FoundryEpubFootnoteApplied[]>();
  for (const row of report.applied) {
    const list = rowsByDocument.get(row.document);
    if (list) list.push(row);
    else rowsByDocument.set(row.document, [row]);
  }

  const beforeById = new Map(before.map((c) => [c.id, c]));
  const units: PassDiffUnit[] = [];
  for (const chapter of after) {
    const previous = beforeById.get(chapter.id);
    const beforeText = previous?.text ?? '';
    if (beforeText === chapter.text) continue;

    const changes = locateFootnoteDeletions(chapter, rowsByDocument.get(chapter.path) ?? []);
    if (changes.length === 0) {
      // The document moved but nothing in the report accounts for it. Say so and
      // let writePassDiff compute a word diff for this unit — the change is real
      // and hiding it would be worse — but the mismatch is a fact about foundry's
      // report and this app's spine reading, and it is not swallowed.
      console.warn(
        `[processing-passes] ${chapter.path} changed, but the footnotes report attributes no `
        + 'applied deletion to that path. Its diff is computed from the texts instead.'
      );
    }
    units.push({
      id: chapter.id,
      title: chapter.title,
      before: beforeText,
      after: chapter.text,
      ...(changes.length > 0 ? { changes } : {}),
    });
  }
  return units;
}

/** Where each reported deletion sits in the document's text, after the edit. */
function locateFootnoteDeletions(
  chapter: { path: string; text: string },
  rows: readonly FoundryEpubFootnoteApplied[]
): DiffChange[] {
  const changes: DiffChange[] = [];
  let cursor = 0;
  for (const row of rows) {
    // The anchors are reported in reading order, so the search carries on from
    // the last one: a marker text like `1` recurs, and restarting from zero would
    // pin every one of them to the first paragraph.
    const at = chapter.text.indexOf(row.after, cursor);
    if (at < 0) {
      // foundry edited the XHTML; this text came from BookForge's own reader,
      // which normalizes whitespace its own way. A anchor that will not line up
      // is one change missing from the count, not a reason to lose the rest.
      console.warn(
        `[processing-passes] ${chapter.path}: the anchor "${row.after}" is not in the document's `
        + 'text as this app reads it, so that marker removal is missing from the diff.'
      );
      continue;
    }
    for (const span of deletionSpans(row.before, row.after)) {
      changes.push({ pos: at + span.at, len: 0, rem: span.removed, fn: 'inferred' });
    }
    cursor = at + 1;
  }
  return changes;
}

/**
 * The runs of characters `after` is missing, and where each one sits in `after`.
 *
 * `after` is `before` with characters deleted and nothing else — foundry's
 * applier proves that before it applies anything (the subsequence guard) — so
 * two pointers are enough, and the answer is exact: `12` welded to a word gives
 * ONE span, `.”12 Why` giving up its marker in two places gives two.
 */
function deletionSpans(before: string, after: string): Array<{ at: number; removed: string }> {
  const spans: Array<{ at: number; removed: string }> = [];
  let i = 0;
  let j = 0;
  while (i < before.length) {
    if (j < after.length && before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    let removed = '';
    while (i < before.length && (j >= after.length || before[i] !== after[j])) {
      removed += before[i];
      i++;
    }
    spans.push({ at: j, removed });
  }
  return spans;
}

/**
 * Simplify — the one AI rewrite left in the pipeline.
 *
 * Runs the SAME `cleanupEpub` the old AI-cleanup job ran; there is no second
 * implementation. What changed is where the result goes: cleanupEpub writes into
 * the pass's stage directory (which keeps its checkpoint, its cover embedding and
 * its resume behaviour intact, all of which key off that directory), and the
 * finished file is then moved onto the book.
 */
async function runSimplifyPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const params = config.simplify;
  if (!params) throw new Error('A simplify pass was queued without its settings (mode, provider, model).');

  const bookPath = await requireBookEpub(config.projectDir);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  // The before-text, read now: the pass is about to overwrite the file it came
  // from, and the diff is computed against this.
  const before = await loadEpubForComparison(bookPath);

  const { aiBridge } = await import('./ai-bridge.js');
  const result = await aiBridge.cleanupEpub(
    bookPath,
    jobId,
    mainWindow,
    undefined,
    {
      provider: params.aiProvider,
      ollama: params.aiProvider === 'ollama'
        ? { baseUrl: params.ollamaBaseUrl || 'http://localhost:11434', model: params.aiModel }
        : undefined,
      claude: params.aiProvider === 'claude'
        ? { apiKey: params.claudeApiKey || '', model: params.aiModel }
        : undefined,
      openai: params.aiProvider === 'openai'
        ? { apiKey: params.openaiApiKey || '', model: params.aiModel }
        : undefined,
    },
    {
      simplifyForChildren: true,
      simplifyMode: params.mode,
      customInstructions: params.customInstructions,
      testMode: params.testMode,
      testModeChunks: params.testModeChunks,
      outputDir: stageDir,
    }
  );
  if (!result.success || !result.outputPath) {
    return { success: false, error: result.error || 'Simplify produced no EPUB and gave no reason.' };
  }

  const produced = result.outputPath;
  const after = await loadEpubForComparison(produced);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pairChapters(before.chapters, after.chapters));

  const bookAfter = await replaceBookEpub(config.projectDir, produced);
  await manifestService.appendAppliedPass(config.projectDir, {
    kind: 'simplify',
    at: new Date().toISOString(),
    params: { mode: params.mode, provider: params.aiProvider, model: params.aiModel },
    diff: diff.rel,
  });
  return { success: true, outputPath: bookAfter };
}

/**
 * Translate the whole book, in place.
 *
 * No diff: a translation shares no words with what it replaced, so a word diff of
 * it is a wall of red and green that tells a reader nothing they did not already
 * know. The provenance record names the languages, which is the useful fact.
 */
async function runTranslatePass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const params = config.translate;
  if (!params) throw new Error('A translate pass was queued without its languages and model.');

  const bookPath = await requireBookEpub(config.projectDir);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  const { runMonoTranslation } = await import('./ll-jobs.js');
  const result = await runMonoTranslation(
    jobId,
    {
      cleanedEpubPath: bookPath,
      sourceLang: params.sourceLang,
      targetLang: params.targetLang,
      aiProvider: params.aiProvider,
      aiModel: params.aiModel,
      ollamaBaseUrl: params.ollamaBaseUrl,
      claudeApiKey: params.claudeApiKey,
      openaiApiKey: params.openaiApiKey,
      translationPrompt: params.translationPrompt,
      customInstructions: params.customInstructions,
      outputEpubPath: path.join(stageDir, 'translated.epub'),
    },
    mainWindow ?? null
  );
  if (!result.success || !result.outputPath) {
    return { success: false, error: result.error || 'Translation produced no EPUB and gave no reason.' };
  }

  const bookAfter = await replaceBookEpub(config.projectDir, result.outputPath);
  await manifestService.appendAppliedPass(config.projectDir, {
    kind: 'translate',
    at: new Date().toISOString(),
    params: {
      from: params.sourceLang,
      to: params.targetLang,
      provider: params.aiProvider,
      model: params.aiModel,
    },
  });
  return { success: true, outputPath: bookAfter };
}

/**
 * Pair two chapter lists by id for diffing.
 *
 * A pass rewrites a chapter's text and leaves the spine alone, so ids match. One
 * that does not match is reported as wholly new rather than silently dropped —
 * an unpaired chapter means the pass restructured the book, which the diff should
 * show rather than hide.
 */
function pairChapters(
  before: Array<{ id: string; title: string; text: string }>,
  after: Array<{ id: string; title: string; text: string }>
): PassDiffUnit[] {
  const beforeById = new Map(before.map((c) => [c.id, c]));
  return after.map((c) => ({
    id: c.id,
    title: c.title,
    before: beforeById.get(c.id)?.text ?? '',
    after: c.text,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one pass. The queue job IS this call: it returns when the pass has
 * finished, and a failure is returned rather than thrown so the caller can put
 * the message on the job row.
 */
export async function runProcessingPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  console.log(`[processing-pass] ${config.kind} on ${config.projectDir} (${config.stageRelDir})`);
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    switch (config.kind) {
      case 'tesseract':
        // The scan is a STAGE of OCR correction, not a job. A config that says
        // otherwise was planned by a build from before that change and is sitting
        // in queue.json; running it would scan the pages and then stop, leaving a
        // run directory nothing exports and a row that claims to have done
        // something to the book.
        throw new Error(
          'Tesseract is no longer a pass of its own — reading the pages is the first stage of the '
          + 'OCR correction pass, which now runs scan, repair and detection as one job. This job '
          + 'was queued by an older build: remove it and add OCR correction from the Process tab.'
        );
      case 'ocr-correction':
        return await runFoundryPass(jobId, config, mainWindow);
      case 'footnotes':
        // Two implementations, one name. The plan decided which; a job that does
        // not say is a planner that did not, and guessing from the other fields
        // is how a pass silently reads the wrong book.
        if (config.footnotesMode === 'epub') {
          return await runEpubFootnotesPass(jobId, config, mainWindow);
        }
        if (config.footnotesMode === 'foundry-run') {
          return await runFoundryPass(jobId, config, mainWindow);
        }
        throw new Error(
          'This footnote-removal job does not say which of its two modes it is '
          + '(footnotesMode). It was queued by something older than the EPUB mode; '
          + 'remove it and add the pass again from the Process tab.'
        );
      case 'simplify':
        return await runSimplifyPass(jobId, config, mainWindow);
      case 'translate':
        return await runTranslatePass(jobId, config, mainWindow);
      default: {
        const unknown: never = config.kind;
        throw new Error(`There is no ${unknown} pass.`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[processing-pass] ${config.kind} failed:`, err);
    return { success: false, error };
  }
}
