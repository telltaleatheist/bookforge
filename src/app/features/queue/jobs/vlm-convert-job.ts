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
import {
  VLM_CONVERT_STAGE, conversionInFlightFor, type VlmConvertDestination,
} from '@shared/vlm/conversion';
import type { VlmReadingsChoice } from '@shared/vlm/readings-bank';
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
  /**
   * This row joined a conversion that is ALREADY RUNNING — "Send to queue"
   * pressed on a book being read right now.
   *
   * It exists because the stage belongs to main and broadcasts to every window,
   * so handing a running conversion to the queue does not have to interrupt it:
   * the row attaches to the progress already being emitted and waits for the
   * finish. Starting one would be worse than useless — main refuses a second
   * stage on the same project BY NAME, so the row would fail instantly while the
   * conversion it was supposed to represent carried on unwatched.
   *
   * NOT persisted usefully across a restart, and that is deliberate: a run this
   * flag refers to died with the app, so `reviveAttachedRow` fails the row by
   * name rather than leaving it waiting for progress that will never come.
   */
  attachToRunning?: boolean;
  /**
   * What the user said to do with the page answers already banked for this PDF,
   * answered when the row was ADDED to the queue.
   *
   * Recorded here, on the row, because the whole point is that nothing
   * re-decides it: pressing Start on a queued row honours what the row was
   * enqueued expecting, and a retry of a failed row inherits the same answer
   * rather than flipping. Owen, 2026-08-09: "if its already in the queue and i
   * hit start, it means it was expecting the cache to be there and should rely
   * on it."
   *
   * ABSENT means the row was enqueued before BookForge asked the question, and
   * `readingsChoiceOfJob` turns that into "rely on the bank" — deliberately NOT
   * the fresh-on-completed default, which belongs to a question this row was
   * never asked. `queue.json` outlives the build that wrote it, so that case is
   * permanent rather than transitional.
   */
  readings?: VlmReadingsChoice;
  /**
   * Where this run's book LANDS — replace the project's book, or be added beside
   * it as another archive file.
   *
   * Answered on the versions page before the row was added, and recorded here
   * for exactly the reason `readings` is: a row that waits overnight and a retry
   * of a failed row must both do what the user chose, not what a later build
   * thinks is sensible. ABSENT means 'replace', which is the only thing a
   * conversion did before this field existed — every row already in a
   * `queue.json` written by an older build meant that, permanently.
   */
  destination?: VlmConvertDestination;
}

/** One sub-bar under the row's own, in the shape the queue's stage list takes. */
export interface ConversionStage {
  name: string;
  label: string;
  pct: number;
  status: 'pending' | 'running' | 'complete';
}

/** What the runner may do to the row it is running. Deliberately narrow. */
export interface ConversionJobContext {
  jobId: string;
  /**
   * Percentage 0-100, the line under it, the ETA, and the phase breakdown.
   *
   * `stages` is empty on a run with one phase — the MLX route reads each page as
   * it draws it — and a caller must render nothing rather than one bar labelled
   * as if there were two.
   */
  report(update: {
    progress: number;
    message: string;
    etaSeconds: number | null;
    stages: ConversionStage[];
  }): void;
  /** Fires when the user cancels. Main is asked to stop the stage. */
  signal: AbortSignal;
}

/** The electron surface this job needs, named so it can be substituted in a test. */
export interface ConversionJobElectron {
  convertPdfToEpub(request: {
    projectDir: string; variantId?: string; sourcePath?: string; skipDeletedPages?: boolean;
    readings?: VlmReadingsChoice;
  }): Promise<{ success: boolean; result?: { epubPath: string }; error?: string }>;
  onDocumentStageProgress(
    cb: (e: {
      projectDir: string; stage: string; message: string; done: number; total: number;
      render?: { done: number; total: number };
    }) => void
  ): () => void;
  onDocumentStageFinished(cb: (e: { projectDir: string; stage: string }) => void): () => void;
  cancelDocumentStage(projectDir: string): Promise<unknown>;
  /** Stages running right now — how an attaching row checks it has not already missed the end. */
  listActiveStages(): Promise<Array<{ projectDir: string }>>;
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
    // ── THE FLAG THAT DECIDES WHETHER THIS ROW STARTS A SECOND CONVERSION ────
    //
    // Carried, and its absence here was the whole of the bug Owen reported on
    // 2026-08-10: "if i send it to the queue, it needs to continue what it was
    // doing in the queue instead of restarting. when i hit start in the queue it
    // correctly noticed it was already running somewhere else."
    //
    // `sendToQueue` sets it correctly — it reads the live run's phase and stamps
    // `attachToRunning: true` on a conversion already in flight. This function
    // then rebuilt the config field by field on the way into the queue and
    // listed every field EXCEPT this one, so the flag was dropped between the
    // caller that set it and the row that needed it. The row landed looking
    // exactly like a fresh conversion, called `convertPdfToEpub`, and met
    // `beginStage`'s by-name refusal ("Convert to EPUB is already working on
    // this book") — which is precisely the refusal only a NON-attaching row can
    // provoke, and so is the proof of where the flag went.
    //
    // `reattachDocumentStages` never showed the fault because it writes the flag
    // straight onto an existing row's config (`{ ...config, attachToRunning:
    // true }`) and never passes through this builder. Attach worked on reload
    // and only on reload; that asymmetry was the symptom.
    ...(raw.attachToRunning ? { attachToRunning: true } : {}),
    // Carried through EXACTLY as given, including absent. A row rebuilt from
    // `queue.json` by a build that added this field must not acquire a choice
    // its user never made — absent is a state with a defined meaning
    // (`readingsChoiceOfJob`), not a hole to fill in.
    ...(raw.readings ? { readings: raw.readings } : {}),
    // Same rule, same reason: absent means 'replace', which is what every row
    // enqueued before this field existed meant.
    ...(raw.destination ? { destination: raw.destination } : {}),
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

/**
 * The two bars a conversion shows, or none.
 *
 * A run through an endpoint is two passes over the book — every page drawn with
 * PyMuPDF, then every picture posted to the model — and they run at rates an
 * order of magnitude apart. The first pass used to report nothing at all, so the
 * bar sat at zero through it and a long book looked like it had never started.
 *
 * NONE on the MLX route, which draws and reads each page in the same breath and
 * so has one phase to report. An empty list means the row shows its single
 * overall bar, which is the honest rendering of a run with one phase — bars
 * invented to fill a shape would be worse than the thing they replaced.
 *
 * Rendering is reported COMPLETE the moment the first page is read: foundry
 * finishes the whole book before it posts anything, so reading having begun is
 * proof drawing has ended. Waiting for the render count to reach its own total
 * would leave the bar short on any book with pages excluded, which never reaches
 * its page count by design.
 */
export function stagesOf(
  render: { done: number; total: number } | undefined,
  readDone: number,
  readTotal: number
): ConversionStage[] {
  if (!render) return [];
  const pct = (done: number, total: number): number =>
    total > 0 ? Math.min(Math.round((done / total) * 100), 100) : 0;

  const reading = readTotal > 0;
  const renderPct = reading ? 100 : pct(render.done, render.total);
  const readPct = pct(readDone, readTotal);
  return [
    {
      name: 'render',
      label: 'Rendering pages',
      pct: renderPct,
      status: renderPct >= 100 ? 'complete' : 'running',
    },
    {
      name: 'read',
      label: 'Reading pages',
      pct: readPct,
      // Not `pct > 0`: the first page of a long book takes seconds to come back,
      // and a bar sitting at 'pending' through it says the model has not started
      // when it has. Reading is running from the moment a total exists.
      status: readPct >= 100 ? 'complete' : reading ? 'running' : 'pending',
    },
  ];
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
  // The breakdown as last reported, so the finish can complete the bars this run
  // ACTUALLY had rather than assert a shape. A one-phase run ends with none.
  let lastStages: ConversionStage[] = [];

  const unsubscribe = electron.onDocumentStageProgress((event) => {
    if (!samePath(event.projectDir, config.projectDir)) return;
    const at = now();
    // The rate is measured on READING only, and `event.done/total` is that
    // count throughout — main keeps the rasteriser's tally in `render`. Feeding
    // a 15x-faster phase into the same series would make the estimate wrong
    // while it ran and wrong again in the other direction once it stopped.
    sample = sampleConversionRate(sample, event.done, event.total, at);
    lastStages = stagesOf(event.render, event.done, event.total);
    ctx.report({
      progress: percentOf(event.done, event.total),
      message: line(event.message, sample, at),
      etaSeconds: conversionEtaSeconds(sample, at),
      stages: lastStages,
    });
  });

  // Cancellation goes to MAIN, which owns the process. Nothing here kills
  // anything: the stage is main's, and a renderer that thought it had stopped a
  // run still holding the GPU would be the worst of both.
  const onAbort = () => { void electron.cancelDocumentStage(config.projectDir); };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  /**
   * Follow the conversion main is ALREADY running, to its finish. ONE
   * implementation, reached from the two places a row can learn it is attaching.
   *
   * The conversion is already happening, so nothing is started here: the
   * progress subscription above is already reporting it, and calling
   * `convertPdfToEpub` would be refused by name and would fail this row while
   * the run it represents carried on unwatched.
   */
  const followRunningConversion = async (): Promise<{ epubPath: string }> => {
      await new Promise<void>((resolve) => {
        const stop = electron.onDocumentStageFinished((event) => {
          if (!samePath(event.projectDir, config.projectDir)) return;
          stop();
          resolve();
        });
        ctx.signal.addEventListener('abort', () => { stop(); resolve(); }, { once: true });

        // `document:stage-finished` is a broadcast, so it is only heard by a
        // listener that already exists. A stage that ended between the decision
        // to attach and the line above would never be heard from again and this
        // row would wait for it forever. Asking once, AFTER subscribing, closes
        // that: either the stage is still there (and the subscription will hear
        // its finish) or it is gone (and there is nothing left to wait for).
        //
        // "Still there" INCLUDES a conversion that has been ordered and has not
        // claimed its project yet. `runVlmConversion` waits on the GPU arbiter
        // and then ~44 s of model load BEFORE `withProjectStage` claims the
        // stage, and that window is exactly when someone watching a book fail to
        // appear presses Send to queue. Against a registry that only knew about
        // CLAIMED stages this question answered "nothing is running" and the row
        // declared a ninety-minute conversion complete on the spot, seconds after
        // it was enqueued. `markStageIntent` (electron/document-stage-registry.ts)
        // is what makes the ordered-but-unclaimed run visible here.
        void electron.listActiveStages().then((stages) => {
          if (stages.some(s => samePath(s.projectDir, config.projectDir))) return;
          stop();
          resolve();
        }).catch(() => {
          // Unanswerable — keep waiting on the subscription, which is the normal
          // path. Resolving here would report a conversion finished on the
          // strength of a failed question.
        });
      });
      ctx.report({
        progress: 100,
        message: `Converted ${config.sourceLabel}`,
        etaSeconds: 0,
        // The bars this run actually had, finished. Reported rather than
        // cleared: a breakdown that vanishes at the end reads as work undone.
        stages: lastStages.map(s => ({ ...s, pct: 100, status: 'complete' as const })),
      });
      // The path is main's to report and this row never learned it; the book is
      // on the versions page either way. An invented path would be worse.
      return { epubPath: '' };
  };

  try {
    if (config.attachToRunning) return await followRunningConversion();

    // ── The belt, and it is ONLY a belt ──────────────────────────────────────
    //
    // The enqueue-time flag above is the real mechanism: a row that was created
    // from a conversion already in flight is stamped `attachToRunning` by
    // `sendToQueue`, and `buildConversionConfig` carries that stamp onto the
    // row. This check exists because that stamp was silently dropped once
    // already — the builder listed every field except that one — and the cost
    // was not a wrong flag but a row that ordered a SECOND conversion of a book
    // main was already ninety minutes into.
    //
    // So before starting anything, ask main whether this project already has a
    // conversion. If it does, this row attaches instead of provoking
    // `beginStage`'s by-name refusal — and says on the console that it got here
    // the wrong way, because a belt that worked silently would let the next hole
    // in the enqueue path go unnoticed for another release.
    //
    // It is not a substitute for the flag and cannot be: main is asked once,
    // here, and a conversion ordered a moment after this question is not in the
    // answer. The flag is what a row KNOWS about its own origin.
    let alreadyRunning = false;
    try {
      alreadyRunning = conversionInFlightFor(config.projectDir, await electron.listActiveStages());
    } catch (err) {
      // Unanswerable. The row proceeds exactly as it would have, and main's own
      // refusal is still there to catch a genuine double-start — inventing an
      // answer here would decide a conversion on the strength of a failed
      // question.
      console.warn(
        `[vlm-convert] Could not ask main which stages are running before starting `
        + `${config.sourceLabel}; starting as this row was enqueued to. ${(err as Error).message}`);
    }
    if (alreadyRunning) {
      console.warn(
        `[vlm-convert] Row for ${config.sourceLabel} was enqueued WITHOUT attachToRunning, but main `
        + `is already converting ${config.projectDir}. Attaching to that run instead of starting a `
        + `second one. The enqueue-time flag was missed — that is the bug to fix, not this.`);
      return await followRunningConversion();
    }

    const result = await electron.convertPdfToEpub({
      projectDir: config.projectDir,
      ...(config.variantId ? { variantId: config.variantId } : {}),
      ...(config.sourcePath ? { sourcePath: config.sourcePath } : {}),
      ...(config.skipDeletedPages ? { skipDeletedPages: true } : {}),
      // The answer given when this row was added to the queue, unchanged — on
      // the first start and on every retry alike. A retry that re-decided would
      // be the queue overruling the user between two attempts at one job.
      ...(config.readings ? { readings: config.readings } : {}),
      // Where the finished book lands, as recorded on the row. Unchanged across
      // retries for the same reason the readings answer is.
      ...(config.destination ? { destination: config.destination } : {}),
    });
    if (!result.success || !result.result) {
      // Main's own sentence — it names the missing Python, the model it could
      // not load, the page it choked on. Never paraphrased into "conversion
      // failed", which is the one thing the user already knows.
      throw new Error(result.error || 'The conversion failed and gave no reason.');
    }
    ctx.report({
        progress: 100,
        message: `Converted ${config.sourceLabel}`,
        etaSeconds: 0,
        // The bars this run actually had, finished. Reported rather than
        // cleared: a breakdown that vanishes at the end reads as work undone.
        stages: lastStages.map(s => ({ ...s, pct: 100, status: 'complete' as const })),
      });
    return { epubPath: result.result.epubPath };
  } finally {
    unsubscribe();
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** The stage label main announces this work under, for a row that wants to match. */
export const CONVERSION_STAGE_LABEL = VLM_CONVERT_STAGE;
