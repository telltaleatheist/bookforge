/**
 * processing-passes — one pass over the project's book, run as a queue job.
 *
 * There is ONE book per project — `manifest.outputs.epub` — and a pass reads it,
 * transforms it, and writes it back to THE SAME PATH. Nothing here produces a
 * `cleaned.epub` or a `translated.epub` for a later step to hunt for: the stage
 * directories hold a pass's working files and its diff, never the book.
 *
 * ── WHY IN PLACE ─────────────────────────────────────────────────────────────
 *
 * The stage copies were a per-stage snapshot of a pipeline with a fixed shape.
 * Passes have no fixed shape — translate → simplify → translate back is legal,
 * and the user orders them — so "which file is the book now?" stops having a
 * static answer and every consumer that guessed one was wrong for some ordering.
 * One path, one book, and `appliedPasses` says what happened to it.
 *
 * ── WHY EACH PASS STILL LEAVES A DIFF ────────────────────────────────────────
 *
 * Writing in place is what makes the diffs necessary rather than optional: after
 * the third pass, the text the second pass ended at exists nowhere. So a pass
 * diff carries its own after-text (see writePassDiff) and is readable forever,
 * long after the book has moved on.
 *
 * ── WHERE THE BOOK COMES FROM ────────────────────────────────────────────────
 *
 * Not from here. `foundry vlm-convert` (electron/vlm-convert.ts) reads the pages
 * and assembles them, which is a document STAGE rather than a pass — a book's
 * origin is not a transformation of a book. A run over a project with no
 * `outputs.epub` is refused by the planner, by name.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// A type here, and only a type: this module holds the one window the queue's
// progress rows go to, and it must not reach for `electron` at load.
import type { BrowserWindow } from 'electron';

import * as manifestService from './manifest-service';
import { writePassDiff, type PassDiffUnit } from './diff-cache';
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
 * `manifestService.ensureBookEpub` is the one answer, and it is the SAME call
 * the narration strikes make: a project imported as an EPUB has no book until
 * something needs one, at which point the archive original is copied to
 * `source/<Book Title>.epub` and recorded. A pass therefore never writes to an
 * archive original — the file the user handed us stays exactly as it arrived —
 * and never refuses an EPUB-born project for a reason the user cannot act on.
 *
 * A PDF project with no book is still refused, by name: converting the pages is
 * what makes a book, and no amount of copying gets you one.
 */
export async function requireBookEpub(projectDir: string): Promise<string> {
  const record = await manifestService.ensureBookEpub(projectDir);
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
export async function moveIntoPlace(fromAbsPath: string, toAbsPath: string): Promise<void> {
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
// The passes
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
 * A pass kind this build no longer runs, and the sentence that explains it.
 *
 * queue.json outlives the code that wrote it, so a row naming one of these
 * cannot be reasoned about — nothing knows what it would do — and it is refused
 * rather than mapped onto "the nearest live pass", which would spend hours
 * producing something the user did not ask for.
 *
 * Checked before the switch so the exhaustiveness `never` below stays a real
 * check on the LIVE kinds rather than a catch-all for retired ones.
 */
const RETIRED_PASS_KINDS: Record<string, string> = {
  'get-text':
    'Get Text is gone: BookForge no longer casts a working PDF with Tesseract. Converting a PDF '
    + 'to a book is one act now — Convert to EPUB.',
  blocks:
    'Detect blocks is gone: the block model and the layout pipeline it labelled for were retired '
    + 'when Convert to EPUB became the only PDF→EPUB conversion.',
  reflow:
    'Build the book is gone: Convert to EPUB writes the book directly from the pages, so there is '
    + 'no working document to reflow.',
  footnotes:
    'The AI footnote pass is gone. Digits-only footnote references are now removed '
    + 'deterministically as the narration copy is written, so no book is edited and nothing needs '
    + 'to be queued.',
  tesseract:
    'Tesseract is no longer part of this app: the pages are read by the document vision model '
    + 'Convert to EPUB runs.',
  'ocr-correction':
    'OCR correction is gone with the Tesseract pipeline it repaired.',
  detection:
    'Detection is gone with the Tesseract pipeline it labelled.',
};

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

    const gone = RETIRED_PASS_KINDS[config.kind as string];
    if (gone) {
      throw new Error(
        `${gone} This job was queued by an older build: remove it and plan the run again from the `
        + 'Process tab.'
      );
    }

    switch (config.kind) {
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
