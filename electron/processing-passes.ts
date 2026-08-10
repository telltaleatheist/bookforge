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
import type { AppliedPass } from './manifest-types';
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

/**
 * Record the pass in the book's LEDGER, so the user can take it back on its own.
 *
 * One act with the rewrite, and it runs immediately after the `appliedPasses`
 * record is appended: the snapshot it takes is the book this pass produced, and
 * a moment later that book is one the user has been editing again.
 *
 * A refusal is SAID and not thrown. The pass succeeded — the book is rewritten,
 * its provenance records it, its diff is on disk — and what could not be
 * promised is only that it is undoable in isolation. Failing the job here would
 * report an hour of model time as wasted when it was not. See
 * electron/book-ledger.ts for the cases (a structural rewrite, an unreadable
 * result, a project with no archive-grade base).
 */
async function recordInLedger(
  config: PassJobConfig,
  label: string,
  pass: AppliedPass
): Promise<{ ledgerEntryId?: string; note?: string }> {
  const { registerLedgerPass } = await import('./book-ledger.js');
  const recorded = await registerLedgerPass(config.projectDir, { kind: pass.kind, label, pass });
  if (recorded.refusal !== null) {
    console.warn(`[processing-pass] ${recorded.refusal}`);
    return { note: recorded.refusal };
  }
  return { ledgerEntryId: recorded.entry.id };
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
  const applied: AppliedPass = {
    kind: 'simplify',
    at: new Date().toISOString(),
    params: { mode: params.mode, provider: params.aiProvider, model: params.aiModel },
    diff: diff.rel,
  };
  await manifestService.appendAppliedPass(config.projectDir, applied);
  const ledger = await recordInLedger(config, 'Simplify', applied);
  return {
    success: true,
    outputPath: bookAfter,
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
  };
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
  const applied: AppliedPass = {
    kind: 'translate',
    at: new Date().toISOString(),
    params: {
      from: params.sourceLang,
      to: params.targetLang,
      provider: params.aiProvider,
      model: params.aiModel,
    },
  };
  await manifestService.appendAppliedPass(config.projectDir, applied);
  // No diff to freeze — a translation shares no words with what it replaced, so
  // the entry's receipt is null and the row says so rather than offering a review
  // of a wall of red and green.
  const ledger = await recordInLedger(config, `Translate to ${params.targetLang}`, applied);
  return {
    success: true,
    outputPath: bookAfter,
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
  };
}

/**
 * Remove footnote REFERENCE NUMBERS from the book itself.
 *
 * ── The question this answers ───────────────────────────────────────────────
 *
 * Owen: "if the user opens the working file and footnote reference numbers were
 * removed, will it show the change in the epub? will it show that the numbers
 * are actually gone? i.e. does it actually edit the text? we need a way to edit
 * the text directly." Until now the strip happened only on the write of the
 * narration copy, so the numbers left the file the NARRATOR read and stayed in
 * the file the USER read. This pass edits the book, and the numbers are gone
 * from the page the moment it opens.
 *
 * It is the reference NUMBERS and nothing else. The footnote blocks themselves —
 * the notes at the end of a chapter — are struck out by the user like any other
 * text and are ordinary working changes; this pass never removes an element.
 *
 * ── Not an AI pass, and not the retired one ─────────────────────────────────
 *
 * The transform is `stripFootnoteMarkerSups`, the same digits-only rule the
 * narration copy has always been cut by, applied to the same content documents.
 * There is no model, no GPU and no network: it is a string replace over a zip
 * and it finishes in seconds. The `footnotes` kind it superficially resembles
 * was an AI pass that decided for itself what a footnote was, and it is retired.
 *
 * ── Nothing to do is a REFUSAL, not a vacuous entry ─────────────────────────
 *
 * A book with no markers left — because it never had any, or because this pass
 * has already run over it — gets a sentence saying so and NOTHING is recorded.
 * The alternative is a ledger row whose snapshot is byte-identical to the one
 * before it and whose diff shows no change: a row the user can delete to undo
 * nothing, sitting in the history of their book forever. The strip is idempotent
 * by construction (shared/text/sup-markers.ts), so a second run genuinely has
 * nothing to do, and saying that is the whole of the right answer.
 */
async function runFootnoteRefsPass(config: PassJobConfig): Promise<PassJobResult> {
  const bookPath = await requireBookEpub(config.projectDir);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  // The before-text, read now: the pass is about to overwrite the file it came
  // from, and the diff is computed against this.
  //
  // WITH THE MARKERS LEFT IN, on both sides. The text extractor strips exactly
  // the markers this pass removes, so reading either side the ordinary way hands
  // the diff two identical strings and the frozen receipt records a book against
  // itself — which is what made Review changes on this pass's line show nothing
  // (Owen, 2026-08-10). This is the one pass whose diff is about the markers, so
  // it is the one caller that asks to see them.
  const before = await loadEpubForComparison(bookPath, true);

  const { stripFootnoteReferencesFromBook } = await import('./epub-processor.js');
  const produced = path.join(stageDir, 'footnote-refs.epub');
  const strip = await stripFootnoteReferencesFromBook(bookPath, produced);

  if (strip.removed === 0) {
    // The staged book is a byte-for-byte re-zip of one that is already correct.
    // It is removed rather than moved into place: rewriting the book with its
    // own contents would move its timestamp and invalidate every analysis cache
    // keyed on it, for a pass that changed nothing.
    await fs.promises.rm(produced, { force: true });
    return {
      success: false,
      error: 'No footnote reference markers remain in this book, so nothing was changed and nothing '
        + 'was recorded. Either it never had digits-only superscript references, or this pass has '
        + 'already been run over it — check the book\'s ledger.',
    };
  }

  const after = await loadEpubForComparison(produced, true);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pairChapters(before.chapters, after.chapters));

  const bookAfter = await replaceBookEpub(config.projectDir, produced);
  const applied: AppliedPass = {
    kind: 'footnote-refs',
    at: new Date().toISOString(),
    params: { removed: strip.removed, files: strip.files.length, breaks: strip.breaks },
    diff: diff.rel,
  };
  await manifestService.appendAppliedPass(config.projectDir, applied);
  const ledger = await recordInLedger(config, 'Remove footnote references', applied);
  return {
    success: true,
    outputPath: bookAfter,
    summary: `${strip.removed} footnote reference number(s) removed from ${strip.files.length} `
      + 'document(s).'
      + (strip.breaks > 0
        ? ` ${strip.breaks} paragraph(s) held nothing but a marker and now say [break] — a pause, `
          + 'which is what they always were.'
        : ''),
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
  };
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
      // No jobId and no window: it reports no progress because it has none to
      // report — the whole pass is a string replace over a zip and is done
      // before a progress row could be drawn.
      case 'footnote-refs':
        return await runFootnoteRefsPass(config);
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
