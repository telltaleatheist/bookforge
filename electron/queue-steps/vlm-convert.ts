/**
 * vlm-convert — make the book, scheduled.
 *
 * Scheduling ONLY. The conversion is a document stage main already owns
 * (`runVlmConversion` → `withProjectStage`): cancellable, surviving a renderer
 * reload, refusing a second run on the same project by name. This step decides
 * WHEN, follows the stage's own three broadcasts, and never touches a book.
 *
 * ── Attaching ───────────────────────────────────────────────────────────────
 *
 * A row can be created FROM a conversion that is already running — the user
 * pressed Send to queue on a book main is ninety minutes into. Such a row is
 * stamped `attachToRunning`, and attaching means: subscribe, wait for the
 * finish, start nothing. Starting would provoke `beginStage`'s by-name refusal
 * and fail the row while the run it represents carried on unwatched.
 *
 * `document:stage-finished` is a broadcast, so it is only heard by a listener
 * that already exists — a stage that ended between the decision to attach and the
 * subscription would never be heard from again. Asking `activeStages()` once,
 * AFTER subscribing, closes that window. "Running" there INCLUDES a conversion
 * that has been ordered and has not claimed its project yet (the arbiter wait
 * plus ~44s of model load), which is exactly when someone presses Send to queue.
 */
import { activeStages, unclaimedStageIntents, abortStageFor } from '../document-stage-registry';
import { onBridgeEvent } from '../bridge-events';
import { samePath } from '../../shared/document/same-path';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef, JobStageProgress, QueueStep } from '../../shared/queue/engine-types';

interface StageProgressEvent {
  projectDir: string;
  message?: string;
  done: number;
  total: number;
  render?: { done: number; total: number };
}

interface StageFinishedEvent { projectDir: string; stage: string }

interface VlmConvertStepConfig {
  projectDir: string;
  sourceLabel: string;
  variantId?: string;
  sourcePath?: string;
  skipDeletedPages?: boolean;
  attachToRunning?: boolean;
  readings?: unknown;
  destination?: unknown;
}

/** The two bars a two-phase run has, and none at all on the one-phase route. */
function stagesOf(
  render: { done: number; total: number } | undefined,
  readDone: number,
  readTotal: number,
): JobStageProgress[] {
  if (!render || render.total <= 0) return [];
  const renderPct = Math.min(100, Math.round((render.done / render.total) * 100));
  const readPct = readTotal > 0 ? Math.min(100, Math.round((readDone / readTotal) * 100)) : 0;
  return [
    {
      name: 'render',
      label: 'Rasterising pages',
      pct: renderPct,
      status: renderPct >= 100 ? 'complete' : 'running',
    },
    {
      name: 'read',
      label: 'Reading pages',
      pct: readPct,
      status: readPct >= 100 ? 'complete' : (renderPct >= 100 ? 'running' : 'pending'),
    },
  ];
}

function conversionInFlightFor(projectDir: string): boolean {
  return activeStages().some((s) => samePath(s.projectDir, projectDir))
    || unclaimedStageIntents().some((s) => samePath(s.projectDir, projectDir));
}

export const vlmConvertStep: StepModule = {
  type: 'vlm-convert',
  // It converts a PDF the PROJECT holds; nothing upstream hands it a file.
  consumes: null,
  produces: 'epub',
  resource: () => 'gpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as VlmConvertStepConfig;
    if (!config?.projectDir) {
      throw new Error('This conversion row has no project, so there is nothing to convert.');
    }

    let lastStages: JobStageProgress[] = [];
    const unsubscribe = onBridgeEvent<StageProgressEvent>('document:stage-progress', (event) => {
      if (!samePath(event.projectDir, config.projectDir)) return;
      lastStages = stagesOf(event.render, event.done, event.total);
      ctx.report({
        percent: event.total > 0 ? Math.min(100, Math.round((event.done / event.total) * 100)) : 0,
        message: event.message,
        stages: lastStages,
      });
    });

    const follow = (): Promise<void> => new Promise<void>((resolve) => {
      const stop = onBridgeEvent<StageFinishedEvent>('document:stage-finished', (event) => {
        if (!samePath(event.projectDir, config.projectDir)) return;
        stop();
        resolve();
      });
      ctx.signal.addEventListener('abort', () => { stop(); resolve(); }, { once: true });
      // Asked AFTER subscribing — see the header.
      if (!conversionInFlightFor(config.projectDir)) { stop(); resolve(); }
    });

    try {
      // The enqueue-time stamp is the real mechanism. The registry question below
      // is a belt, and it exists because that stamp was silently dropped once and
      // the cost was a row that ordered a SECOND conversion of a book main was
      // already an hour into.
      if (config.attachToRunning || conversionInFlightFor(config.projectDir)) {
        if (!config.attachToRunning) {
          console.warn(
            `[QUEUE-STEP vlm-convert] Row for ${config.sourceLabel} was queued WITHOUT `
            + `attachToRunning, but ${config.projectDir} is already converting. Attaching to that `
            + 'run instead of starting a second one. The enqueue-time flag was missed — that is '
            + 'the bug to fix, not this.',
          );
        }
        await follow();
        ctx.report({
          percent: 100,
          message: `Converted ${config.sourceLabel}`,
          // The bars this run actually had, finished. Reported rather than
          // cleared: a breakdown that vanishes at the end reads as work undone.
          stages: lastStages.map((s) => ({ ...s, pct: 100, status: 'complete' as const })),
        });
        // The path is main's to report and this row never learned it; the book is
        // on the versions page either way. An invented path would be worse.
        return { kind: 'epub' };
      }

      const { runVlmConversion } = await import('../vlm-convert.js');
      const result = await runVlmConversion({
        projectDir: config.projectDir,
        ...(config.variantId ? { variantId: config.variantId } : {}),
        ...(config.sourcePath ? { sourcePath: config.sourcePath } : {}),
        ...(config.skipDeletedPages ? { skipDeletedPages: true } : {}),
        // The answers given when this row was queued, unchanged on every retry.
        // A retry that re-decided would be the queue overruling the user between
        // two attempts at one job.
        ...(config.readings ? { readings: config.readings } : {}),
        ...(config.destination ? { destination: config.destination } : {}),
      } as never);

      const epubPath = (result as { epubPath?: string })?.epubPath;
      if (!epubPath) {
        throw new Error(`Converting ${config.sourceLabel} produced no book, and said no reason.`);
      }
      return { kind: 'epub', path: epubPath };
    } finally {
      unsubscribe();
    }
  },

  cancel(_stepId: string, step: QueueStep): void {
    // Cancellation goes to MAIN, which owns the process — and it is addressed by
    // PROJECT, because that is how the stage registry is keyed.
    const config = step.config as unknown as VlmConvertStepConfig;
    if (config?.projectDir) abortStageFor(config.projectDir);
  },
};
