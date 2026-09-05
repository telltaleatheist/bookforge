/**
 * The jobs one narration run is made of, in the shape THIS window's queue
 * service speaks.
 *
 * ── The description moved; this is the door onto it ─────────────────────────
 *
 * What a narration run consists of — which steps, in which order, carrying which
 * fields — now lives in `shared/queue/narration-run.ts`, because a third caller
 * arrived that is not a renderer at all: Foundry's window can order a narration,
 * and the run is composed in BookForge's MAIN process with no renderer in the
 * conversation (`bookforge.narrate`, electron/main.ts). Composing it again over
 * there would be exactly the drift the description was written to prevent —
 * "they drift the day one of them gains a field, which is precisely how a run
 * ends up rendering at a default voice nobody chose."
 *
 * So this file is now a MAPPING and nothing else: it takes the shared step plans
 * and wraps each one in the `CreateJobRequest` `QueueService.addJob` takes. The
 * wrapper is a fact about this window's door — main's door takes a `JobSpec` and
 * wraps the same plans differently — which is precisely why it stayed behind
 * while the description left.
 *
 * ONE CALLER NOW. The Process page went on 2026-08-27 and the narration modal
 * is the only door in this window, so what is left here is the whole-run
 * builder and the types — same description, same refusals, thrown from the same
 * place before anything is queued.
 */
import type { CreateJobRequest } from '../models/queue.types';
import {
  buildNarrationSteps,
  type NarrationRunBook,
  type NarrationRunSettings,
  type NarrationRunStages,
  type NarrationStepPlan,
} from '@shared/queue/narration-run';

/*
 * Re-exported rather than redeclared: a caller that types a book or a settings
 * object is typing the SHARED description, and a local copy of either would be a
 * second answer to what a narration run is described by.
 */
export type {
  NarrationEnhancementOrder,
  NarrationEnhancementPass,
  NarrationRunBook,
  NarrationRunSettings,
  NarrationRunStages,
  NarrationRvcSettings,
  NarrationTextCleanupChoice,
} from '@shared/queue/narration-run';

/**
 * One shared step plan, as this window's queue takes it.
 *
 * The `config` cast is the one place the two vocabularies meet. The plan's
 * config types are declared as the exact set of fields the description sets
 * (shared/queue/narration-run.ts), and `Partial<JobConfig>` is the union of
 * every job's whole config — TypeScript will not narrow a union member from a
 * structural subset, so the assignment is stated rather than inferred. It is
 * checked on the other side: the shared config interfaces name the same fields
 * with the same types as `TtsConversionConfig`, `RvcEnhancementJobConfig` and
 * `ReassemblyJobConfig`, so a drift in either is a compile error there.
 */
function asJobRequest(plan: NarrationStepPlan): CreateJobRequest {
  return {
    type: plan.type,
    ...(plan.epubPath === undefined ? {} : { epubPath: plan.epubPath }),
    variantId: plan.variantId,
    ...(plan.bfpPath === undefined ? {} : { bfpPath: plan.bfpPath }),
    ...(plan.projectDir === undefined ? {} : { projectDir: plan.projectDir }),
    // What this step reads when nothing precedes it. Carried only when the
    // description said so — `QueueService.addJob` reads its absence as "this run
    // starts by reading the document it names", which is what every other kind
    // of job in this app queues.
    ...(plan.sourceRef === undefined ? {} : { sourceRef: plan.sourceRef }),
    metadata: { ...plan.metadata },
    config: plan.config as CreateJobRequest['config'],
  };
}

/*
 * THE THREE PER-STEP WRAPPERS ARE GONE (2026-08-27).
 *
 * `narrationTtsRequest`, `narrationRvcRequest` and `narrationReassemblyRequest`
 * existed for ONE caller: the Process wizard, which composed a run a step at a
 * time because it could interleave those steps with a pass chain. That page was
 * erased in favour of the narration modal, which asks for a whole run — so the
 * only door left is `buildNarrationJobs`, and three exported ways to build half
 * of a run is three chances to build a different half.
 *
 * The STEP builders they wrapped are untouched in shared/queue/narration-run.ts:
 * main's own door still assembles the run from them for Foundry's press.
 */

/**
 * The whole run, in the order it must execute: narration, enhancement, assembly.
 *
 * They carry no workflow or parent: whoever queues them stamps that, because
 * where they land is the submitting caller's decision, not this file's.
 */
export function buildNarrationJobs(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  stages: NarrationRunStages,
): CreateJobRequest[] {
  return buildNarrationSteps(book, settings, stages).map(asJobRequest);
}
