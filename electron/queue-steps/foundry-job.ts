/**
 * foundry-job — work ordered inside the hosted Foundry window, scheduled HERE.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-18, after pressing Read on two books in the hosted window and
 * finding BookForge's queue empty: *"we need to centralize the queue in
 * bookforge. foundry has their own queue but things shouldnt be queued in
 * foundry's queue from within bookforge. we need to centralize the queue."*
 *
 * His queue WAS empty, correctly — the work was in Foundry's. One of the two
 * books then sat held in a queue he was not looking at, and evaporated on the
 * next app restart, because that queue is in memory and has no store.
 *
 * ── Scheduling only. Foundry still does the work ────────────────────────────
 *
 * `vlm-convert`'s posture exactly, and for the same reason: the run belongs to
 * something that owns state this engine does not. Foundry's job runner writes the
 * ledger, fills the bank, rotates the working tree and announces export landings;
 * a second implementation of any of that over here is two copies waiting to
 * disagree. So this module decides WHEN, calls `runJob`, follows its progress,
 * and never touches a book.
 *
 * ── Why one step type for read, render and translate ────────────────────────
 *
 * What differs between them is what the engine is ASKED, which is the request on
 * the config. What differs to THIS engine is the resource, and that is
 * `resource()` below. Three step types would be three copies of one runner
 * separated by a string.
 *
 * ── THE GPU, WHICH IS THE POINT OF CENTRALIZING AT ALL ──────────────────────
 *
 * Foundry's queue is a second scheduler that cannot see ours. Today a reading and
 * a narration can both hold the card, because each queue believes it is the only
 * one. Declaring the resource here is what ends that: one card, one arbiter.
 */
import { noteStepStopped } from '../queue-engine';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef, StepResource } from '../../shared/queue/engine-types';
import {
  FOUNDRY_VERSION_FOR_CLEAN_TEXT, foundryRunner, foundryTooOldForCleanText,
  parseFoundryProgressLine,
} from '../foundry-host-queue';
import type { FoundryJobStepConfig } from '../foundry-host-queue';
import { foundryVersion } from '../foundry-bridge';
/*
 * `foundryVersionAtLeast` lives beside the readings-bank flags because that is
 * where the first version gate was written. It is the ONE comparator — numeric
 * dot-separated, and a version that is not that shape is never quietly treated as
 * new enough — and a second copy here would be a second answer to "is this
 * engine new enough", which is exactly the question a gate exists to have one
 * answer to.
 */
import { foundryVersionAtLeast } from '../../shared/vlm/readings-bank';

/**
 * Which pool a Foundry job contends for.
 *
 * READ IS THE GPU. It hands every page to a vision model; it is the expensive
 * thing the hold exists for and the reason this centralization matters.
 *
 * EVERY TEXT PASS IS ALSO THE GPU, because its model is Ollama's and Ollama is on
 * the same card. This engine already says exactly that about its own translate
 * pass ("the same pass against Ollama is the GPU", engine-types StepResource),
 * and Foundry files all three on the `gpu` lane in `JOB_RESOURCE`.
 *
 * A CLEANUP IS NOT THE CHEAP ONE OF THE THREE, which is worth saying because its
 * name sounds like it might be: it asks the model about EVERY block of the book,
 * one call each, temperature 0 — Owen's ruling of 2026-09-04, *"send every single
 * block through to be sure"* — so it holds a 17 GB model for as long as a
 * translation does. Filing it on `cpu` would let it run beside a narration and
 * put two models on one card, which on this hardware is an out-of-memory failure
 * hours in.
 *
 * A RENDERING IS NOT. Foundry's own words for it: arithmetic over a bank already
 * on disk — no model, no socket, seconds — and that is as true of a TRANSLATED
 * rendering as any other, because a translation's words come out of a file by the
 * time it is rendered. Putting one in the gpu pool would make a two-second job
 * wait behind a nine-hour narration for a card it never wanted.
 */
function resourceFor(config: Record<string, unknown>): StepResource {
  const request = (config as unknown as FoundryJobStepConfig).request;
  const kind = request?.kind;
  return kind === 'read' || kind === 'translate' || kind === 'simplify' || kind === 'clean'
    ? 'gpu'
    : 'cpu';
}

export const foundryJobStep: StepModule = {
  type: 'foundry-job',
  /*
   * It reads what its request names — a file inside Foundry's workspace, put
   * there by Foundry. Nothing upstream in one of our chains hands it anything, so
   * declaring a consumed kind would be a type this engine cannot enforce and does
   * not own. `vlm-convert` says null for the same reason.
   */
  consumes: null,
  /*
   * NOTHING ANOTHER STEP OF OURS READS, which is a statement rather than a gap.
   * A read's product is the bank, which lives in Foundry's project and is reached
   * through Foundry; a rendering's product is announced by the export landing
   * (`onExport` -> registerFoundryExportLanding) and becomes a VERSION, not a
   * chain input. If a Foundry job ever does feed one of our steps, it will feed
   * it through a landing that named a file, and that is where the kind belongs.
   */
  produces: 'none',
  resource: resourceFor,
  /*
   * A stopped read is resumable and this is not a guess: Foundry banks each page
   * as it lands, and a re-run reads only what is missing (foundry README
   * §vlm-convert; BookForge's own vlm-convert module says the same). So a stop
   * leaves the row HELD and interrupted rather than cancelled, and pressing it
   * again costs the pages already answered nothing.
   */
  stopIsResumable: true,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as FoundryJobStepConfig;
    if (!config?.request) {
      throw new Error(
        'This Foundry row carries no request, so there is nothing to run. The row was composed '
        + 'wrongly rather than the work failing.',
      );
    }
    /*
     * A CLEAN TEXT ROW NEEDS AN ENGINE THAT HAS THE COMMAND, and this is the last
     * moment anything on this side can say so.
     *
     * The check is HERE and not at `enqueue`, which is where a refusal would
     * ideally live: that door is SYNCHRONOUS by contract — "pressing Add cannot
     * leave a moment where nothing has appeared" — and asking the binary its
     * version is a spawn. So the row is minted, and it refuses the instant its
     * turn comes, before Foundry is asked to spawn anything and before a model is
     * loaded. Nothing is substituted and no other command is tried.
     */
    if (config.request.kind === 'clean') {
      const installed = await foundryVersion();
      if (!foundryVersionAtLeast(installed.version, FOUNDRY_VERSION_FOR_CLEAN_TEXT)) {
        throw new Error(foundryTooOldForCleanText(installed.version));
      }
    }
    /*
     * SAID, NOT SUBSTITUTED. `runJob` arrives with the Foundry seam; a subtree
     * that predates it cannot execute this row, and the honest outcome is a
     * failed row naming the reason — not a silent skip, and certainly not a quiet
     * fall back to Foundry's own queue, which is the exact thing the ruling
     * removed. `foundryRunner()` throws that sentence.
     */
    const row = await foundryRunner()(config.request, {
      parentStep: config.parentStep,
      signal: ctx.signal,
      /*
       * ONE RAW LINE OF THE ENGINE'S STDERR, and the parse is ours to do.
       *
       * This callback used to be declared as taking a parsed `{done, total}`
       * object, which Foundry has never sent — so `progress.done ?? 0` read a
       * property off a string, every count was 0, `total > 0` never became
       * true, and no hosted read reported anything at all between the seam
       * landing and 2026-08-21. Their `Job` has always been built by parsing
       * these same strings; there is no parsed-progress door for a host.
       */
      onProgress: (line) => {
        const counted = parseFoundryProgressLine(line);
        if (counted === null) {
          /*
           * NOT A COUNT, so it BECOMES the note — the line the shelf shows when
           * the fraction cannot move: a block the model is arguing with, a page
           * refused for a cap, a retry. It is what a person watching decides
           * whether to kill a run on, and a frozen bar with nothing beside it is
           * indistinguishable from a wedge.
           *
           * `message` takes it too, because their `Job.message` is the job log
           * one line deep — every line, counted or not.
           */
          ctx.report({ message: line, detail: line });
          return;
        }
        ctx.report({
          percent: counted.total > 0
            ? Math.min(100, Math.round((counted.page / counted.total) * 100))
            : 0,
          message: line,
          /*
           * A COUNT CLEARS THE NOTE, and that is what makes the note mean
           * "since". Their rule, kept exactly: a note that lingered would still
           * be on screen ten pages later, which is the same lie in the other
           * direction. Null erases; omitting the field would leave it standing.
           */
          detail: null,
          foundryPhase: counted.phase,
          /*
           * THE COUNTS ARE KEPT, not just divided into a percentage. Their shelf
           * renders them back as "Reading 41 / 317 pages", and a percentage
           * cannot be un-divided, so the round trip has to carry the originals.
           */
          metrics: { chunksCompletedInJob: counted.page, totalChunksInJob: counted.total },
        });
      },
    });

    /*
     * A STOP IS NOT A FAILURE, and the row is what lets this side tell them
     * apart. Foundry's JobState spells three outcomes; this engine derives its
     * own from `stopRequested`, which only its `cancel()` writes — complete for a
     * stop that came through our door (their shelf forwards to `hostQueue.cancel`)
     * and blind to one taken inside Foundry.
     *
     * So a cancelled row is REPORTED as a stop before it is thrown. `stopIsResumable`
     * is true here, so it lands HELD and interrupted — the pages already banked
     * are kept and pressing Start resumes — which is exactly where our own Stop
     * button puts it. Without the note it would land `failed`, wearing an error
     * for something nobody did wrong, and be eligible for `retry()`.
     */
    if (row.state === 'cancelled') {
      noteStepStopped(ctx.stepId);
      throw new Error(`${config.label} was stopped.`);
    }
    if (row.state === 'failed') {
      // Foundry's own sentence, verbatim. This side knows less about why the
      // engine stopped than the engine's words do.
      throw new Error(row.error ?? `${config.label} failed, and Foundry did not say why.`);
    }

    /*
     * `none` carries no path, and that is right for both kinds: a read wrote a
     * bank inside Foundry's project, and a rendering's file is announced as a
     * landing on its own channel. A path invented here would be a second claim
     * about where the work went.
     */
    return { kind: 'none' };
  },

  /*
   * THE SIGNAL IS THE CANCEL. `runJob` is handed `ctx.signal` and the engine
   * unwinds on it; there is no per-job handle on this side to revoke, and
   * inventing a registry to hold one would be this module keeping a second
   * opinion about what is running.
   */
  cancel(): void {
    /* the AbortSignal passed to runJob is what stops it */
  },
};
