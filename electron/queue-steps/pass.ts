/**
 * The processing passes — simplify, translate, footnote references.
 *
 * ONE module, registered under three job types, because they ARE one act: every
 * pass runs through `runProcessingPass` with the plan the chain already resolved.
 * The config is passed through untouched — a config re-derived here could
 * disagree with the plan the user was shown, and re-planning at run time is what
 * the planner exists to prevent.
 *
 * A pass rewrites the project's BOOK in place. That is why `consumes` is null:
 * what it reads is the project's book, which the project owns, not something the
 * step before it handed over. A chain of passes is still a chain — each must wait
 * for the one before it, because each rewrites the text the next one reads — and
 * lineage is what expresses that.
 */
import { cancelCleanupJob } from '../ai-bridge';
import { passResultNotes } from '../../shared/processing/pass-notes';
import { broadcastToAllWindows } from '../document-stage-run';
import { onBridgeEvent } from '../bridge-events';
import { runProcessingPass } from '../processing-passes';
import type { PassJobConfig } from '../../shared/processing/pass-types';
import type { JobType } from '../../shared/queue/engine-types';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef, StepResource } from '../../shared/queue/engine-types';
import { queueMainWindow, resourceForProvider, stepFailure } from './runtime';
import { machinesForAiStep, type AiJobConfig } from './ai-provider';

/**
 * THE AI BLOCK OF A PASS ROW, or null where the pass asks no provider.
 *
 * A pass config does not carry `aiProvider` at the top level: it carries a
 * `simplify` or a `translate` sub-object that does. Everything that reads a
 * step's provider — the pool it contends for, whether it travels, which model
 * it leases — was therefore reading `undefined` off a pass row and answering
 * the conservative thing (the GPU pool, `local`, no lease). That is not a
 * safety default on a pass; it is the wrong answer to a question the config
 * can answer.
 *
 * `narration-text` and `footnote-refs` genuinely have none:
 *
 *  · `footnote-refs` is a string replace over a zip. No model, ever.
 *  · `narration-text` IS a model pass, but nobody chooses its provider on the
 *    row — it is `foundry clean-text`, and where that runs is the routing
 *    record's answer for the `clean` act (electron/crucible/text-venue.ts).
 *    Its model comes from the act, below, and not from here.
 */
function aiBlockOfPass(config: PassJobConfig | undefined): AiJobConfig | null {
  if (config?.kind === 'simplify') return config.simplify ?? null;
  if (config?.kind === 'translate') return config.translate ?? null;
  return null;
}

interface PassProgressEvent {
  jobId: string;
  phase?: string;
  progress?: number;
  message?: string;
  stages?: unknown;
  currentChunk?: number;
  totalChunks?: number;
  currentChapter?: number;
  totalChapters?: number;
  chunksCompletedInJob?: number;
  totalChunksInJob?: number;
  completedInSession?: number;
  outputPath?: string;
}

function passModule(type: JobType): StepModule {
  return {
    type,
    consumes: null,
    produces: 'epub',
    /**
     * The pool this pass contends for, asked of the pass's OWN provider.
     *
     * `resourceForProvider` is still the one rule — a hosted API is network
     * latency and an on-machine model is the card — it was simply being handed
     * a config with no `aiProvider` on it, so every pass filed on `gpu`
     * including a translate against Claude. A pass with no provider block
     * (`narration-text`, `footnote-refs`) keeps `gpu`, which is that rule's
     * answer for an empty block and the right one for both: the cleanup holds
     * a 17 GB model, and footnote-refs is over before the pool matters.
     */
    resource: (config: Record<string, unknown>): StepResource =>
      resourceForProvider((aiBlockOfPass(config as unknown as PassJobConfig)
        ?? config) as unknown as Record<string, unknown>),
    /**
     * WHICH MACHINES A PASS CAN RUN ON (crucible `docs/PHASE7-LANES.md` §4.4).
     *
     * `simplify` and `translate-pass` travel exactly when their provider is a
     * Crucible, through the SAME `machinesForAiStep` the translation and
     * analysis steps use — one owner, so a provider taught to one is not
     * forgotten by the other.
     *
     * `narration-text` travels unconditionally, and that is not an exception
     * to the rule but the same rule with a different owner: nobody picks its
     * provider on the row. It is the `clean` act, one of Crucible's four
     * capability classes, and where it runs is the routing record's answer
     * (`decideWhereTextActRuns`). Declaring `local` here would mean the
     * opposite: a book admitted to the Mac cleaning itself on this machine's
     * card, silently, which is the §4.4 defect.
     *
     * `footnote-refs` is `local` because it is a string replace over a zip.
     * There is no model and no card; a remote slot would be occupied by
     * nothing.
     */
    machines: (config: Record<string, unknown>): 'local' | 'any' => {
      const pass = config as unknown as PassJobConfig;
      if (pass?.kind === 'narration-text') return 'any';
      const ai = aiBlockOfPass(pass);
      return ai === null ? 'local' : machinesForAiStep(ai as unknown as Record<string, unknown>);
    },
    /**
     * THE CAPABILITY CLASS EACH PASS KIND IS (crucible PHASE15 §5.3).
     *
     * Read by the pump at the one moment both facts exist — the class, which
     * is this step's, and the engine, which is the row's — to ask whether that
     * engine ROUTES this class to an upstream. If it does, the run holds no
     * card and takes the engine's `[cloud]` lane instead of its GPU slot.
     *
     * `narration-text` is the `clean` act, which is the whole reason it
     * travels unconditionally: it is one of Crucible's four classes and not a
     * provider somebody picked on the row. `footnote-refs` is a string
     * replace over a zip — no model, no class, and `null` says exactly that
     * rather than naming a class it would never ask for.
     */
    crucibleClass: (config: Record<string, unknown>): string | null => {
      const pass = config as unknown as PassJobConfig;
      switch (pass?.kind) {
        case 'narration-text': return 'clean';
        case 'simplify': return 'simplify';
        case 'translate': return 'translate';
        default: return null;
      }
    },
    /**
     * IT LEASES ITS MODEL when its act reaches a Crucible as a run of chat
     * completions — which every one of these is: a simplify asks the model
     * about every block group, a translation about every paragraph batch, and
     * a cleanup about every block of the book.
     *
     * Read by the scheduler for ONE decision: may the run's lease stay open
     * for this step when the step in front of it finishes. THIS FLAG IS NOT
     * SUFFICIENT ON ITS OWN — a lease is per MODEL ID and a server holds one,
     * so `crucibleClass` above has to name the class the open lease was taken
     * under, on the same machine, or the lease is given back at the seam
     * (`nextActWouldUseHeldCard`, queue-engine.ts).
     *
     * `footnote-refs` declares nothing and so answers false: an hour is not
     * what it takes, but neither is a model.
     */
    leasesModel: (config: Record<string, unknown>): boolean => {
      const pass = config as unknown as PassJobConfig;
      if (pass?.kind === 'narration-text') return true;
      const ai = aiBlockOfPass(pass);
      return ai !== null && ai.aiProvider === 'crucible';
    },
    /*
     * NO `leasedModel` HOOK, AND ITS ABSENCE IS THE 2026-09-19 RULING.
     *
     * ── What it was for (Foundry, 2026-09-14) ───────────────────────────────
     *
     * A lease is taken on a MODEL (`POST /v1/models/{id}/lease`) and Crucible
     * holds ONE per server. The row scope built for A5 kept the lease open for
     * any next step that declared `leasesModel`, whatever model that step
     * wanted — and clean resolves to the 9B while simplify and translate
     * resolve to the 27B. So the archetypal row, clean then simplify, carried
     * the 9B's lease into a step that has to put the 27B on the card, and the
     * load is refused `leased` — naming `bookforge`, which is us.
     *
     * ── Why naming the id here became impossible ────────────────────────────
     *
     * `narration-text` lost the answer first: the `clean` act's model is
     * `GET /v1/capability`'s `selected` on the chosen server, because
     * `crucible install` probed that machine's card to make that record
     * (docs/CRUCIBLE_ROLLOUT_PLAN.md §3). Phase 15 made the same true of
     * `simplify` and `translate-pass` — a text door sends the capability's
     * `selected` for its class and nothing else (PHASE15 §5.3), so the row's
     * `aiModel` is not the id either. A lookup table in this file saying
     * "clean is the 9B" would be a second owner of a per-host fact (crucible
     * ARCHITECTURE.md R1).
     *
     * So every pass answered `null`, `null` never equalled an open lease's
     * subject, and the comparison matched NOTHING — which is how `pause()`
     * came to close the lease of a step that was still running (bug hunt
     * 2026-09-19, §H). The scheduler compares `crucibleClass` on the row's
     * server now (`nextActWouldUseHeldCard`, queue-engine.ts), which is what
     * both sides can state, and the hook is gone.
     */

    async run(ctx: StepRunContext): Promise<ArtifactRef> {
      const config = ctx.step.config as unknown as PassJobConfig;
      if (!config?.kind || !config.projectDir || !config.stageRelDir) {
        throw new Error(
          `This ${type} row was queued without a planned config. Pass rows come from the `
          + 'Process tab; nothing else may build one. Remove it and plan the run again.',
        );
      }

      const unsubscribe = onBridgeEvent<PassProgressEvent>('queue:progress', (event) => {
        if (event.jobId !== ctx.stepId) return;
        ctx.report({
          percent: event.progress,
          message: event.message,
          ...(event.stages !== undefined ? { stages: event.stages as never } : {}),
          metrics: {
            currentChunk: event.currentChunk,
            totalChunks: event.totalChunks,
            currentChapter: event.currentChapter,
            totalChapters: event.totalChapters,
            chunksCompletedInJob: event.chunksCompletedInJob ?? event.currentChunk,
            totalChunksInJob: event.totalChunksInJob ?? event.totalChunks,
            chunksDoneInSession: event.completedInSession
              ?? event.chunksCompletedInJob ?? event.currentChunk,
            cleanupPhase: event.phase as never,
          },
        });
      });

      try {
        // THE RUN'S VENUE, NOT A NEW DECISION — the machine the queue assigned
        // this book, handed down verbatim. Only a `crucible` provider and the
        // `clean` act read it, and each REFUSES BY NAME rather than guessing
        // when the row was never assigned one.
        const result = await runProcessingPass(
          ctx.stepId, config, queueMainWindow(), ctx.job.waitForResolved);
        if (!result.success) {
          /*
           * A CRUCIBLE REFUSED THIS PASS BECAUSE SOMEBODY IS MID-RUN ON THAT
           * CARD — `409 leased`. Nothing about this book is wrong and none of
           * its work is lost, because it never started, so the row goes back
           * to `queued` carrying the holder's own line and the admission tick
           * tries again. The same road `server_busy` travels — with a longer
           * clock, a lane frees in minutes and a lease may hold for an hour.
           *
           * Failing instead is what BookForge did until 2026-09-18: a red row
           * nobody did anything wrong on, and `retry()` — which resets
           * failures — as the only way back. Foundry, on the identical
           * refusal, parked and came back.
           *
           * `stepFailure` is the whole of it since 2026-09-19 (A5): a park
           * when the bridge named a holder, an ordinary failure when it did
           * not. The side call into the engine this module used to make is
           * gone, and with it the thing four modules remembered and five
           * forgot.
           */
          throw stepFailure(
            result.error || `${ctx.step.label} failed and gave no reason.`, result.busyLine);
        }
        // What the pass has to SAY carries onto the row, not just whether it
        // worked. A pass that could record no ledger row succeeded and still
        // owes the user that sentence; dropping it is what made a correct
        // refusal look like a missing button.
        const notes = passResultNotes(result);
        if (notes.length > 0) ctx.step.completionNotes = notes;
        broadcastToAllWindows('project:files-changed', config.projectDir);
        // WHAT A CHAINED STEP READS. A pass that named a narration input meant
        // it: the queue resolves a chained step's input from its parent's
        // artifact and from nothing else, so this is the only place the file a
        // follow-on narration reads can be chosen (the adversarial review,
        // 2026-09-04). Everything else reads the book the pass wrote.
        const produced = result.narrationInputPath ?? result.outputPath;
        if (produced === undefined) {
          throw new Error(
            `${ctx.step.label} finished without saying which file it wrote, so anything queued `
            + 'behind it would have nothing to read.');
        }
        return { kind: 'epub', path: produced };
      } finally {
        unsubscribe();
      }
    },

    cancel(stepId: string): void {
      // A simplify or translate pass is `cleanupEpub` underneath, and ai-bridge
      // keeps its abort controller keyed by the job id it was handed — which is
      // this step id. footnote-refs is a string replace over a zip that finishes
      // in seconds and registers nothing; `cancelCleanupJob` answers false for
      // it, which is the truthful answer rather than a failure.
      cancelCleanupJob(stepId);
    },
  };
}

export const simplifyStep = passModule('simplify');
export const translatePassStep = passModule('translate-pass');
export const footnoteRefsStep = passModule('footnote-refs');
/**
 * The narration text cleanup, on the same module for the same reason.
 *
 * It is not a string replace like footnote-refs — it loads a model and reads the
 * residue — but nothing about the ROW differs: it takes the planned
 * `PassJobConfig`, ends in `runProcessingPass`, reports through the same bridge
 * events, and `resourceForProvider` puts it on the same pool a simplify uses so
 * it cannot run beside a render that wants the card.
 */
export const narrationTextStep = passModule('narration-text');
