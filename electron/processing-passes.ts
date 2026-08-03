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
 * Tesseract / OCR correction / footnote removal do not touch an EPUB at all —
 * they operate on a foundry RUN DIRECTORY (machine-local, hundreds of MB) and
 * the book is exported from it. So a chain of foundry passes ends in one
 * `foundry export`, and only then does the project have a book for those passes
 * to be recorded against. Their diffs come from foundry's own artifacts, keyed
 * by page, because there is no before-EPUB and after-EPUB to compare.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserWindow } from 'electron';

import * as manifestService from './manifest-service';
import type { AppliedPassKind } from './manifest-types';
import { readRunDirectory, type FoundryBlock, type FoundryScanLine } from './foundry-bridge';
import { requireFoundryModel } from './foundry-interim-config';
import {
  attachFoundryRun,
  awaitFoundryRun,
  foundryExport,
  foundryStagesDone,
  startFoundryRun,
  onFoundryRunProgress,
  type FoundryWorkStage,
} from './foundry-run';
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
  try {
    await fs.promises.rename(producedAbsPath, bookPath);
  } catch {
    // Same-filesystem rename is the normal case (both live in the project), but
    // a pass free to work in a temp dir may not be. Copy to a sibling of the
    // destination, then rename WITHIN that filesystem — that last step is the
    // atomic one Syncthing needs to see.
    const sibling = `${bookPath}.bookforge-tmp`;
    await fs.promises.copyFile(producedAbsPath, sibling);
    await fs.promises.rename(sibling, bookPath);
    await fs.promises.unlink(producedAbsPath);
  }
  return bookPath;
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
  message: string
): void {
  mainWindow?.webContents.send('queue:progress', {
    jobId,
    type: kind,
    phase: 'processing',
    progress: Math.max(0, Math.min(100, Math.round(percentage))),
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Foundry passes
// ─────────────────────────────────────────────────────────────────────────────

/** The stages each foundry pass owns. `ocr-correction` is two of them, always. */
const FOUNDRY_STAGES: Record<'tesseract' | 'ocr-correction' | 'footnotes', FoundryWorkStage[]> = {
  tesseract: ['scan'],
  // blocks follows ocr in the same job because a corrected line set that nothing
  // has laid out is not a state a user can do anything with — and because the
  // pair is what "OCR correction" means in the wizard.
  'ocr-correction': ['ocr', 'blocks'],
  footnotes: ['footnotes'],
};

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

export async function cancelProcessingPass(jobId: string): Promise<boolean> {
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
  const kind = config.kind as 'tesseract' | 'ocr-correction' | 'footnotes';
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
      + 'from. Run the Tesseract pass first.'
    );
  }

  const unsubscribe = onFoundryRunProgress((state) => {
    if (state.bookKey !== bookKey) return;
    const within = state.total > 0 ? state.done / state.total : 0;
    const overall = state.stageCount > 0
      ? ((Math.max(state.stageIndex, 1) - 1) + within) / state.stageCount
      : within;
    sendProgress(mainWindow, jobId, kind, overall * 100, state.message);
  });

  activeFoundryPasses.set(jobId, bookKey);
  try {
    await startFoundryRun({
      bookKey,
      pdfPath: config.pdfPath,
      pages,
      runFootnotes: stages.includes('footnotes'),
      stages,
      redo: config.redo,
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

    const diff = diffPaths(config);
    if (kind === 'ocr-correction') await writeOcrCorrectionDiff(bookKey, diff.abs);
    if (kind === 'footnotes') await writeFootnoteDiff(bookKey, diff.abs);

    if (!config.exportAfter) {
      // The book is still unbuilt: this pass's record is written by whichever
      // pass carries the export (see below), because until then the project has
      // no `outputs.epub` for a record to describe.
      return { success: true };
    }

    sendProgress(mainWindow, jobId, kind, 97, 'Building the EPUB…');
    const epubPath = await exportBookFromRun(config, bookKey);

    // Record every foundry pass this export materialized, in execution order.
    // registerEpubExport starts the book's provenance over — correctly: a freshly
    // exported book has had nothing else done to it — so these are appended after.
    const at = new Date().toISOString();
    for (const pass of config.exportPasses ?? [{ kind }]) {
      const params = pass.params ?? foundryPassParams(pass.kind);
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
 * the answer changes when the model does, and a book cleaned by galley-v11 is a
 * different artifact from one cleaned by its successor. Read from the resolver
 * rather than remembered, so it cannot drift from what actually ran.
 */
function foundryPassParams(kind: AppliedPassKind): Record<string, unknown> | undefined {
  if (kind === 'ocr-correction') {
    return {
      ocrModel: path.basename(requireFoundryModel('ocr')),
      blocksModel: path.basename(requireFoundryModel('blocks')),
    };
  }
  if (kind === 'footnotes') {
    return { model: path.basename(requireFoundryModel('footnotes')) };
  }
  // Tesseract has no model and no options: it is the segmenter, pinned at 200 dpi.
  return undefined;
}

/**
 * `foundry export` into the project's canonical book path, recorded.
 *
 * The exclusion list is the editor's `deletedBlockIds` — foundry's own block ids,
 * verbatim, which is what makes the picker's deletions and the exporter's
 * `--exclude-ids` the same fact rather than two that have to be kept in step.
 */
async function exportBookFromRun(config: PassJobConfig, bookKey: string): Promise<string> {
  const target = await manifestService.exportEpubTarget(config.projectDir);
  const cover = await manifestService.resolveProjectCover(config.projectDir);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(config.projectDir, 'manifest.json'), 'utf-8')
  ) as { source?: { deletedBlockIds?: string[] } };

  const result = await foundryExport({
    bookKey,
    excludeBlockIds: manifest.source?.deletedBlockIds ?? [],
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
// EPUB passes
// ─────────────────────────────────────────────────────────────────────────────

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
      case 'ocr-correction':
      case 'footnotes':
        return await runFoundryPass(jobId, config, mainWindow);
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
