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
 * OCR correction, detection and footnote removal do not touch an EPUB at all —
 * they operate on a foundry RUN DIRECTORY (machine-local, hundreds of MB) and
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
// `BrowserWindow` is a VALUE here as well as a type: a document stage run from
// the queue has to reach every window that is looking at the book, not only the
// one that happens to be handed in for progress rows.
import { BrowserWindow } from 'electron';

import * as manifestService from './manifest-service';
import type { AppliedPassKind } from './manifest-types';
import {
  ensureFoundryPath,
  readEpubFootnotesReport,
  readRunDirectory,
  runFoundry,
  type FoundryEpubFootnoteApplied,
  type FoundryEpubFootnotesReport,
} from './foundry-bridge';
import { readDocumentBinding } from './document-binding';
import { beginStage } from './document-stage-registry';
import { noteDocumentStageFinished } from './document-open-when-finished';
import { reflowOutputPath, resolveDocumentProject } from './document-project';
import {
  bindingAbsPath,
  documentScratchDir,
  foundryLlamaServerArgs,
  parseProgress,
  readDocumentPipelineState,
  runBlocksStage,
  runFootnotesPdfStage,
  runGetTextStage,
  runReflowStage,
  type DocumentProject,
  type DocumentStageOptions,
} from './document-stages';
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
// Document passes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The documents a job's passes are about.
 *
 * Resolved through `document-project.ts`, the same way the planner resolved
 * them, so the job reads the PDF the plan named. The plan records `sourcePath`
 * precisely so this cannot drift: a project that has gained a second PDF since
 * the run was queued must not silently switch books halfway through a chain.
 */
async function documentProjectOf(config: PassJobConfig): Promise<DocumentProject> {
  return resolveDocumentProject({
    projectDir: config.projectDir,
    ...(config.variantId ? { variantId: config.variantId } : {}),
    ...(config.sourcePath ? { sourcePath: config.sourcePath } : {}),
  });
}

/**
 * The bars a document stage draws, in execution order.
 *
 * `render` is not one of foundry's stages — it is BookForge rasterizing the
 * pages for foundry to scan — but it takes minutes on a full book and has its
 * own unit, so it gets its own bar rather than being folded into Tesseract's.
 *
 * Weights are equal and deliberately so. The stages cost wildly different
 * amounts, but this app has no measurement of the ratio, and a guessed weight is
 * a number the ETA would treat as measured.
 */
const DOCUMENT_STAGE_BARS: Record<string, string> = {
  render: 'Render pages',
  'get-text': 'Read the pages',
  blocks: 'Detect blocks',
  footnotes: 'Footnote removal',
  reflow: 'Build the book',
};

/**
 * The foundry SUBPROCESS an EPUB-mode pass is driving. It has no document stage
 * and no boundary — it is one process from start to finish — so stopping it is
 * an abort signal on the spawn.
 */
const activeFoundrySubprocesses = new Map<string, AbortController>();

/**
 * The stages a document pass is cancelled through.
 *
 * A document stage is one foundry subprocess at a time, driven by an
 * AbortSignal that `runFoundry` already honours — so stopping a queue row is an
 * abort on the signal, not a message to a run manager. There is no run manager.
 */
const activeDocumentPasses = new Map<string, AbortController>();

export async function cancelProcessingPass(jobId: string): Promise<boolean> {
  const subprocess = activeFoundrySubprocesses.get(jobId);
  if (subprocess) {
    subprocess.abort();
    return true;
  }
  const document = activeDocumentPasses.get(jobId);
  if (document) {
    document.abort();
    return true;
  }
  return false;
}

/**
 * Tell every window a document stage happened, on the channels that exist for it.
 *
 * A stage is about a PROJECT, and a project's documents change whoever ran the
 * stage — so a window looking at that book has to hear about it whether the user
 * pressed the button in the picker or dropped the run into the queue. The
 * picker-initiated path (`document-ipc.ts::withStage`) has always broadcast
 * these three; the queue path did not, which meant a book cast from the queue
 * left every open picker showing the documents as they were before it, and the
 * OCR dialog — which SUBMITS to the queue and then watches these channels —
 * watching a run it could never see.
 */
function broadcastDocumentStage(channel: string, payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Run one document stage as a queue job: bars, cancellation, and foundry's own
 * words on the row.
 *
 * `bars` is the stage list this pass will move through. More than one draws a
 * breakdown; exactly one draws none, because a single bar under an identical
 * overall bar is noise rather than a breakdown.
 */
async function withDocumentStage<T>(
  jobId: string,
  config: PassJobConfig,
  bars: string[],
  mainWindow: BrowserWindow | null | undefined,
  run: (opts: DocumentStageOptions) => Promise<T>
): Promise<T> {
  const project = await documentProjectOf(config);
  const tracker = new StageTracker(
    bars.map((name) => ({ name, label: DOCUMENT_STAGE_BARS[name] ?? name, weight: 1 }))
  );
  const barsOf = (): JobStageProgress[] | undefined =>
    (bars.length > 1 ? tracker.snapshot() : undefined);

  const abort = new AbortController();
  activeDocumentPasses.set(jobId, abort);
  // Claimed in the shared registry too, so a reset submitted from another window
  // sees this stage and refuses rather than being silently undone by it when the
  // staged temp lands.
  const stageName = DOCUMENT_STAGE_BARS[config.kind] ?? config.kind;
  const release = beginStage(project.projectDir, stageName, abort);
  broadcastDocumentStage('document:stage-started', {
    projectDir: project.projectDir, stage: stageName,
  });
  try {
    sendProgress(mainWindow, jobId, config.kind, tracker.master(), 'Preparing…', barsOf());
    await ensureFoundryForJob(jobId, config.kind, mainWindow);
    const result = await run({
      project,
      signal: abort.signal,
      onProgress: (progress) => {
        // The stage names foundry reports ARE the bar names, so nothing
        // translates between them; a stage this pass did not declare moves no
        // bar, by StageTracker's own rule.
        if (progress.total > 0) {
          tracker.set(progress.stage, (progress.done / progress.total) * 100);
        }
        sendProgress(mainWindow, jobId, config.kind, tracker.master(), progress.message, barsOf());
        broadcastDocumentStage('document:stage-progress', {
          projectDir: project.projectDir, ...progress,
        });
      },
    });
    tracker.completeAll();
    return result;
  } finally {
    release();
    activeDocumentPasses.delete(jobId);
    // In `finally` for the same reason the picker-initiated path has it there: a
    // stage that FAILED still stopped, and a window waiting for it to stop has
    // to stop waiting. What it changed on disk is measured afterwards, not
    // inferred from the fact that it ended.
    broadcastDocumentStage('document:stage-finished', {
      projectDir: project.projectDir, stage: stageName,
    });
    // The queue's half of "open when finished". A run submitted from the picker
    // and then backgrounded lands HERE, not in document-ipc — which is exactly
    // the case the old picker-only listener could never honour.
    noteDocumentStageFinished(project.projectDir, stageName);
  }
}

/**
 * Which weights a document stage ran, for its provenance record.
 *
 * Read out of the run.json foundry itself writes in the scratch directory, which
 * is the only honest answer: BookForge chooses none of these weights — foundry
 * resolves base and adapter from its own catalog — so naming a model from this
 * side would be guessing at a catalog this app does not own. A stage that
 * recorded nothing gets no params rather than an invented one.
 */
function documentStageParams(
  project: DocumentProject,
  stage: 'blocks' | 'footnotes'
): Record<string, unknown> | undefined {
  const binding = readDocumentBinding(bindingAbsPath(project));
  if (!binding) return undefined;
  let models: { base?: string; blocks?: string; footnotes?: string } | undefined;
  try {
    models = readRunDirectory(documentScratchDir(binding.primary.sha256)).run.models;
  } catch {
    // The scratch directory is machine-local and is deleted freely; a pass whose
    // record cannot be read simply records no model. It is not a reason to fail
    // a stage that has already done its work to the document.
    return undefined;
  }
  const named = models?.[stage];
  if (!named) return undefined;
  return { model: named, ...(models?.base ? { base: models.base } : {}) };
}

/**
 * Get Text — the cast. `archive/<Original>.pdf` → `<Original>.working.pdf`.
 *
 * Every page, always: the working document IS the book, so a page subset would
 * make it a different book. For a scan that is a render of every page plus
 * Tesseract; for a PDF that already carries text it is one pass over the
 * publisher's own layer, and no model is pointed at anybody's prose either way.
 *
 * No diff. This is the FIRST reading of the pages — there is no before-text for
 * an after-text to be compared against.
 */
async function runGetTextPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const { documentClass } = await withDocumentStage(
    jobId, config, ['render', 'get-text'], mainWindow, (opts) => runGetTextStage(opts)
  );
  console.log(`[processing-pass] get-text: cast a ${documentClass} working document`);
  // Recorded against the BOOK only once there is one. A working document is not
  // the book, so `appendAppliedPass` — which describes `outputs.epub` — would
  // have nothing to attach to until Reflow has run. The pass that writes the
  // book records the chain that produced it.
  return { success: true };
}

/**
 * Detect — label every block and write the answer into the document.
 *
 * No diff: it labels blocks, it does not change a word of the text, so there is
 * no before and after to show.
 */
async function runBlocksPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  await withDocumentStage(jobId, config, ['blocks'], mainWindow, (opts) => runBlocksStage(opts));
  return { success: true };
}

/**
 * Footnote removal over the working document — `foundry footnotes --pdf`.
 *
 * Scanned class only, and foundry says so: a text document's layer is the
 * publisher's page description, and rewriting that from a parse of it would
 * re-lay-out the book. The EPUB reading of this pass, after Reflow, is the
 * default for a scanned book anyway — the adapter measures 97.0% applied /
 * 0.5% false-fire on clean text against 90.5% / 2.1% on raw OCR text.
 */
async function runPdfFootnotesPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });
  const reportPath = path.join(stageDir, 'report.json');

  await withDocumentStage(jobId, config, ['footnotes'], mainWindow, (opts) =>
    runFootnotesPdfStage({ ...opts, reportPath }));

  sendProgress(mainWindow, jobId, config.kind, 95, 'Working out what changed…');
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pdfFootnoteDiffUnits(reportPath));
  return { success: true };
}

/**
 * Which markers `footnotes --pdf` removed, block by block.
 *
 * The changes come from foundry's own report rather than from a word diff, and
 * that is the whole point: a marker is routinely removed at the exact spot a
 * quote is straightened, and a word diff emits ONE edit that reads as a quote
 * change with the marker removal invisible inside it.
 */
function pdfFootnoteDiffUnits(reportPath: string): PassDiffUnit[] {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
    applied?: Array<{ blockId: string; page: number; before: string; after: string }>;
  };
  const units: PassDiffUnit[] = [];
  for (const row of report.applied ?? []) {
    if (row.before === row.after) continue;
    units.push({
      id: row.blockId,
      title: `Page ${row.page + 1}`,
      before: row.before,
      after: row.after,
    });
  }
  return units;
}

/**
 * Reflow — the working document in, `<Original>.epub` out. The ONE exporter.
 *
 * In one pass foundry drops deleted blocks, pages and excluded categories;
 * OCR-corrects the KEPT lines (scanned class only, so blocks the user culled
 * cost zero GPU); reflows lines into paragraphs, dehyphenating under the
 * corpus-attestation rules; and takes each chapter's title from its chapter
 * block's own annotation text.
 *
 * There is no second exporter and no gate choosing between them. Nothing here
 * consults run state: the deletions are IN the document, as `/FoundryDeleted`
 * flags the picker wrote, so there is no exclusion list to re-derive against a
 * scan that may have moved underneath it — which is what used to refuse an
 * export an hour into a run.
 */
async function runReflowPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const cover = await manifestService.resolveProjectCover(config.projectDir);
  const outputPath = await reflowOutputPath(config.projectDir);
  const excludeCategories = config.reflow?.excludeCategories ?? [];

  const { epubPath } = await withDocumentStage(
    jobId, config, ['reflow'], mainWindow, (opts) => runReflowStage({
      ...opts,
      outputPath,
      ...(excludeCategories.length > 0 ? { excludeCategories } : {}),
      ...(cover ? { coverPath: cover } : {}),
    })
  );

  sendProgress(mainWindow, jobId, config.kind, 98, 'Recording the book…');
  await manifestService.registerEpubExport(config.projectDir, epubPath);

  // `registerEpubExport` starts the book's provenance over — correctly: a freshly
  // written book has had nothing else done to it — so the passes that produced it
  // are appended after, in execution order. The stages are read off the DOCUMENT
  // rather than off a plan, because the plan is not the only way they can have
  // happened: a user who ran Get Text and Detect in the picker on Tuesday and
  // pressed Build on Thursday produced exactly the same book.
  const project = await documentProjectOf(config);
  const state = await readDocumentPipelineState(project);
  const at = new Date().toISOString();
  const produced: Array<{ kind: AppliedPassKind; params?: Record<string, unknown> }> = [];
  if (state.stages.getText) produced.push({ kind: 'get-text' });
  if (state.stages.blocks) {
    const params = documentStageParams(project, 'blocks');
    produced.push({ kind: 'blocks', ...(params ? { params } : {}) });
  }
  if (state.stages.footnotes) produced.push({ kind: 'footnotes' });
  produced.push({ kind: 'reflow' });

  for (const pass of produced) {
    await manifestService.appendAppliedPass(config.projectDir, {
      kind: pass.kind,
      at,
      ...(pass.params ? { params: pass.params } : {}),
    });
  }
  return { success: true, outputPath: epubPath };
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
    // queue.json outlives the code that wrote it, so a row naming a pass this
    // build no longer has cannot be reasoned about — nothing knows what it would
    // do — and is refused with the sentence that explains the change. Checked
    // before the switch so the exhaustiveness `never` below stays a real check on
    // the LIVE kinds rather than a catch-all for retired ones.
    const retired: Record<string, string> = {
      tesseract:
        'Tesseract is no longer a pass of its own — reading the pages is what the Get Text pass '
        + 'IS.',
      'ocr-correction':
        'OCR correction is no longer a pass — repairing what Tesseract misread happens inside '
        + 'Build the book, on the blocks you kept, so the ones you deleted cost no GPU at all.',
      detection:
        'Detection is now Detect blocks, and it writes its answer into the working PDF as '
        + 'annotations rather than into a run directory.',
    };
    const gone = retired[config.kind as string];
    if (gone) {
      throw new Error(
        `${gone} This job was queued by an older build: remove it and plan the run again from the `
        + 'Process tab.'
      );
    }

    switch (config.kind) {
      case 'get-text':
        return await runGetTextPass(jobId, config, mainWindow);
      case 'blocks':
        return await runBlocksPass(jobId, config, mainWindow);
      case 'reflow':
        return await runReflowPass(jobId, config, mainWindow);
      case 'footnotes':
        // Two implementations, one name. The plan decided which; a job that does
        // not say is a planner that did not, and guessing from the other fields
        // is how a pass silently reads the wrong book.
        if (config.footnotesMode === 'epub') {
          return await runEpubFootnotesPass(jobId, config, mainWindow);
        }
        if (config.footnotesMode === 'pdf') {
          return await runPdfFootnotesPass(jobId, config, mainWindow);
        }
        throw new Error(
          'This footnote-removal job does not say which document it reads (footnotesMode). It was '
          + 'queued before the document pipeline; remove it and add the pass again from the '
          + 'Process tab.'
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
