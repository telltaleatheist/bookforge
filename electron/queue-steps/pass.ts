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
import { queueMainWindow, resourceForProvider } from './runtime';
import { crucibleModelForAiStep, machinesForAiStep, type AiJobConfig } from './ai-provider';

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
     * (`decideWhereTextActRuns`) — with the legacy switch on, the queue
     * resolves this row to the legacy venue and the act goes local anyway.
     * Declaring `local` here would have meant the opposite: a book admitted to
     * the Mac cleaning itself on this machine's card, silently, which is the
     * §4.4 defect.
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
     * IT LEASES ITS MODEL when its act reaches a Crucible as a run of chat
     * completions — which every one of these is: a simplify asks the model
     * about every block group, a translation about every paragraph batch, and
     * a cleanup about every block of the book.
     *
     * Read by the scheduler for ONE decision: may the run's lease stay open
     * for this step when the step in front of it finishes. THIS FLAG IS NOT
     * SUFFICIENT ON ITS OWN — a lease is per MODEL ID and a server holds one,
     * so `leasedModel` below has to name the same id or the lease is given
     * back at the seam (see the note there).
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
    /**
     * WHICH Crucible model this pass will lease — the id, or null.
     *
     * ── The defect this closes (Foundry, 2026-09-14) ─────────────────────────
     *
     * A lease is taken on a MODEL (`POST /v1/models/{id}/lease`) and Crucible
     * holds ONE per server. The row scope built for A5 kept the lease open for
     * any next step that declared `leasesModel`, whatever model that step
     * wanted — and clean resolves to the 9B while simplify and translate
     * resolve to the 27B. So the archetypal row, clean then simplify, carried
     * the 9B's lease into a step that has to put the 27B on the card, and the
     * load is refused `leased` — naming `bookforge`, which is us. The row then
     * parks on a claim this app made against itself until the ttl lapses.
     *
     * ── Where the id comes from, and why not from a table here ───────────────
     *
     * From the same owner the act itself reads at run time, every time:
     *
     *  · `simplify` / `translate-pass` run through BookForge's own bridges with
     *    the provider block on the row, so the id is `aiModel`
     *    (`crucibleModelForAiStep`, beside `providerConfigOf`).
     *  · `narration-text` is the `clean` act through the engine, and its model
     *    IS NOT KNOWABLE HERE ANY MORE (2026-09-14). It used to be
     *    `textModelFor('clean')`, out of `<userData>/crucible-models.json`;
     *    that record is deleted and `GET /v1/capability` on the chosen server
     *    owns the act-to-model mapping, because `crucible install` probed that
     *    machine's card to make it (Owen's ruling with Foundry,
     *    docs/CRUCIBLE_ROLLOUT_PLAN.md section 3). Asking it needs a server
     *    name and a round trip, and this function has neither — it is
     *    synchronous and runs before the step is placed. So it answers `null`,
     *    which the paragraph below already describes as a real answer.
     *
     * A lookup table in this file saying "clean is the 9B" would be a second
     * owner of that fact and would be wrong the first time somebody re-pointed
     * an act in Settings (crucible `docs/ARCHITECTURE.md` R1).
     *
     * ── Null is an ANSWER ────────────────────────────────────────────────────
     *
     * No model chosen for the act, or a provider that leases nothing. The
     * scheduler compares ids: null never equals an open lease's subject, so
     * the lease is given back at the seam — which is exactly the behaviour
     * before one lease per row existed. The refusal itself is NOT swallowed,
     * only deferred: the act raises `crucible_text_model_not_set` by name when
     * the step actually runs, which is where an operator can act on it. This
     * is a question about a lease, asked before the step starts, and it must
     * not be the thing that fails the row.
     */
    leasedModel: (config: Record<string, unknown>): string | null => {
      const pass = config as unknown as PassJobConfig;
      if (pass?.kind === 'narration-text') {
        // NULL BY CONSTRUCTION since the capability record took ownership of
        // the per-act model: the id is the SERVER's answer, asked at run time
        // by `resolveCrucibleTextEngine`, and nothing synchronous here can
        // know it. Null never equals an open lease's subject, so the lease is
        // given back at the seam — which is exactly the behaviour before one
        // lease per row existed. OWED: a `clean` row could keep its lease
        // across a chain if `leasedModel` were allowed to be async and given
        // the run's venue.
        return null;
      }
      const ai = aiBlockOfPass(pass);
      return ai === null
        ? null
        : crucibleModelForAiStep(ai as unknown as Record<string, unknown>);
    },

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
          throw new Error(result.error || `${ctx.step.label} failed and gave no reason.`);
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
