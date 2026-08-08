/**
 * The conversion job: a book turned into an EPUB by a document vision model,
 * queued like any other work.
 *
 * `foundry vlm-convert` is a document STAGE owned by main — one per project,
 * announced on `document:stage-*`, cancellable, and surviving a renderer reload.
 * That has not changed and must not: this module does not reimplement a
 * conversion, it schedules one. The queue decides WHEN a book is converted; main
 * still decides HOW, and is the only thing that touches the file.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * `queue.service.ts` both decides what runs next and knows how to run each of a
 * dozen job types, which is why adding one has meant editing five thousand lines
 * in two distant places. The shape below is the one that fits: a job type
 * contributes `buildConfig` / `describe` / `run`, and the service only sequences.
 * Nothing here reaches into the service's state — `run` is handed a context it
 * patches through, so this file can be tested and read on its own, and the other
 * twelve job types can move to this shape one at a time without a rewrite.
 *
 * ── Overnight is the point ──────────────────────────────────────────────────
 *
 * Owen, 2026-08-08: "that way i can queue a ton of books to process overnight."
 * A conversion is ninety minutes of one GPU, so these run ONE at a time, in the
 * order they were added, and the queue's own sequencing is what provides that —
 * there is deliberately no concurrency knob here. Two conversions at once on one
 * card is two runs each taking longer than one would have taken alone.
 */

import {
  sampleConversionRate,
  conversionEtaSeconds,
  formatEta,
  formatPageRate,
  type ConversionRateSample,
} from '@shared/vlm/eta';
import { VLM_CONVERT_STAGE } from '@shared/vlm/conversion';
import { samePath } from '@shared/document/same-path';

/**
 * What a queued conversion needs to know, and nothing more.
 *
 * It names the PROJECT and the source document, never a resolved page count or a
 * route: both are properties of the machine at the moment the job runs, and a
 * job that sat in the queue overnight would be carrying yesterday's answer.
 * `queue.json` outlives the code that wrote it, so every field here has to still
 * mean the same thing to a build that has not been written yet.
 */
export interface VlmConvertJobConfig {
  type: 'vlm-convert';
  /** Absolute project directory — the identity main resolves everything from. */
  projectDir: string;
  /** For the queue row's title, so the list reads as books rather than paths. */
  sourceLabel: string;
  /** The PDF variant, when the project holds more than one. */
  variantId?: string;
  /** An absolute PDF inside the project, when the caller already chose one. */
  sourcePath?: string;
  /**
   * Convert the book as CURATED — the archive PDF minus the pages the working
   * copy marks deleted. Carried as the boolean the request takes rather than as
   * a page list, because the record of which pages are gone lives in the working
   * document and main reads it at run time. A list captured at enqueue would be
   * a second copy, able to be a night out of date by the time the job runs.
   */
  skipDeletedPages?: boolean;
}

/** What the runner may do to the row it is running. Deliberately narrow. */
export interface ConversionJobContext {
  jobId: string;
  /** Percentage 0-100, the line under it, and the ETA. */
  report(update: { progress: number; message: string; etaSeconds: number | null }): void;
  /** Fires when the user cancels. Main is asked to stop the stage. */
  signal: AbortSignal;
}

/** The electron surface this job needs, named so it can be substituted in a test. */
export interface ConversionJobElectron {
  convertPdfToEpub(request: {
    projectDir: string; variantId?: string; sourcePath?: string; skipDeletedPages?: boolean;
  }): Promise<{ success: boolean; result?: { epubPath: string }; error?: string }>;
  onDocumentStageProgress(
    cb: (e: { projectDir: string; stage: string; message: string; done: number; total: number }) => void
  ): () => void;
  cancelDocumentStage(projectDir: string): Promise<unknown>;
}

/**
 * The queue row's title. A book, not a path — this is a list somebody scans at
 * 2 a.m. to see whether the overnight batch got through.
 */
export function describeConversion(config: VlmConvertJobConfig): string {
  return `Convert to EPUB — ${config.sourceLabel}`;
}

/**
 * Validate a queued request into a config, or refuse it.
 *
 * Returns undefined rather than a half-built config: the queue drops a request
 * it cannot build, and a config missing its project directory would be a row
 * that fails at 3 a.m. with a message about an undefined path.
 */
export function buildConversionConfig(
  raw: Partial<VlmConvertJobConfig> | undefined
): VlmConvertJobConfig | undefined {
  if (!raw?.projectDir || !raw.sourceLabel) return undefined;
  return {
    type: 'vlm-convert',
    projectDir: raw.projectDir,
    sourceLabel: raw.sourceLabel,
    ...(raw.variantId ? { variantId: raw.variantId } : {}),
    ...(raw.sourcePath ? { sourcePath: raw.sourcePath } : {}),
    ...(raw.skipDeletedPages ? { skipDeletedPages: true } : {}),
  };
}

/**
 * Read a percentage out of foundry's page counts.
 *
 * `total` is 0 until foundry states the page count on its first progress line,
 * and until then there is no percentage — 0 is shown rather than a number
 * derived from a denominator nobody has.
 */
function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.round((done / total) * 100), 100);
}

/** `Reading page 41 of 317 · 4.8s/page · 22m 10s left` */
function line(message: string, sample: ConversionRateSample | null, now: number): string {
  const rate = formatPageRate(sample);
  const eta = formatEta(conversionEtaSeconds(sample, now));
  // The parts that exist, joined — never "· null left", and never a fabricated
  // "calculating…" standing where a real number will be a second later.
  return [message, rate, eta ? `${eta} left` : null].filter(Boolean).join(' · ');
}

/**
 * Run one queued conversion to completion, or throw with main's own reason.
 *
 * The progress subscription is filtered on the PROJECT and nothing else:
 * `document:stage-progress` carries the pipeline stage id while `-started` and
 * `-finished` carry the user-facing label, so a filter matching the wrong one of
 * those drops every line in silence. A project holds one stage at a time — main
 * refuses a second by name — so the project IS the whole filter.
 */
export async function runConversionJob(
  config: VlmConvertJobConfig,
  ctx: ConversionJobContext,
  electron: ConversionJobElectron,
  now: () => number = () => Date.now()
): Promise<{ epubPath: string }> {
  let sample: ConversionRateSample | null = null;

  const unsubscribe = electron.onDocumentStageProgress((event) => {
    if (!samePath(event.projectDir, config.projectDir)) return;
    const at = now();
    sample = sampleConversionRate(sample, event.done, event.total, at);
    ctx.report({
      progress: percentOf(event.done, event.total),
      message: line(event.message, sample, at),
      etaSeconds: conversionEtaSeconds(sample, at),
    });
  });

  // Cancellation goes to MAIN, which owns the process. Nothing here kills
  // anything: the stage is main's, and a renderer that thought it had stopped a
  // run still holding the GPU would be the worst of both.
  const onAbort = () => { void electron.cancelDocumentStage(config.projectDir); };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await electron.convertPdfToEpub({
      projectDir: config.projectDir,
      ...(config.variantId ? { variantId: config.variantId } : {}),
      ...(config.sourcePath ? { sourcePath: config.sourcePath } : {}),
      ...(config.skipDeletedPages ? { skipDeletedPages: true } : {}),
    });
    if (!result.success || !result.result) {
      // Main's own sentence — it names the missing Python, the model it could
      // not load, the page it choked on. Never paraphrased into "conversion
      // failed", which is the one thing the user already knows.
      throw new Error(result.error || 'The conversion failed and gave no reason.');
    }
    ctx.report({ progress: 100, message: `Converted ${config.sourceLabel}`, etaSeconds: 0 });
    return { epubPath: result.result.epubPath };
  } finally {
    unsubscribe();
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** The stage label main announces this work under, for a row that wants to match. */
export const CONVERSION_STAGE_LABEL = VLM_CONVERT_STAGE;
