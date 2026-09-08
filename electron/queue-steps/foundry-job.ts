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
/*
 * THE ARBITER, and the ONE reader of the machine's language-model settings.
 *
 * `cleanTextEngineSettings` is BookForge's mirror of Foundry's `readAppSettings`
 * (electron/narration-clean-text.ts explains why it is MIRRORED and not
 * imported: `foundry-app/` is built output of a separate program with its own
 * tsconfig, and importing into it is the subtree merge the seal exists to
 * prevent). Reading it here rather than writing a second reader is what keeps
 * this step and the bare-EPUB door from ever disagreeing about which server this
 * machine speaks to.
 */
import { cleanTextEngineSettings } from '../narration-clean-text';
import {
  ensureTextServer,
  noteTextQueueBusy,
  noteTextQueueIdle,
  profileForKind,
  servedModelForRequest,
  textServerRoute,
} from '../text-server';

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
     * ── THE TEXT SERVER, STARTED BEFORE THE ACT AND STOPPED AFTER IT ──────────
     *
     * Owen, 2026-09-08: *"build that piece. the arbiter that starts/stops it."*
     * Foundry speaks `--server vllm` and starts nothing (their VENDORED.md's last
     * paragraph); this is the moment BookForge owns.
     *
     * Under `llmServer: 'ollama'` NOTHING BELOW HAPPENS and the row is exactly
     * what it was. Under vLLM, and only when the endpoint is the server this
     * machine manages, the profile for this act is brought up first — staged if
     * its weights are absent, swapped if the wrong model is serving — and
     * released in the `finally`, success or failure alike, so a refused row never
     * leaves twenty gigabytes reserved against nothing.
     *
     * AND THE MODEL IS ASSERTED ONTO THE REQUEST. Owen, same day: *"verify that
     * when i run translate/simplify in foundry, they will correctly use the 27b
     * model in vllm and not the 9b."* Foundry's own guard is its `/v1/models`
     * proof, but that runs INSIDE the engine, after the spawn, and only when the
     * request named a model at all — `vllmModel` is EMPTY by default and means
     * "whatever it is serving", which is precisely the case where a translation
     * against a 9B server would run and be recorded as a translation. So the host
     * names the profile's served id first (`servedModelForRequest`, which refuses
     * by name when the request asks for a different one), and Foundry's proof is
     * the second belt.
     *
     * The request is COPIED rather than mutated: `FoundryJobRequest` is stored
     * "VERBATIM and never normalised on the way in" (foundry-host-queue.ts), and
     * writing a run-time decision back into the saved row would make the board
     * claim Foundry composed something it did not.
     */
    const kind = config.request.kind;
    /*
     * THE THREE THAT ASK A LANGUAGE MODEL, as a narrowed value rather than a
     * boolean: `read` is the VISION model and has its own server
     * (electron/vlm-page-server.ts), and a rendering asks nothing at all. Written
     * this way so `profileForKind` is handed a kind the type system has already
     * agreed is a language act — the day a fourth arrives, this line is the
     * compile error.
     */
    const act: 'clean' | 'translate' | 'simplify' | null =
      kind === 'clean' || kind === 'translate' || kind === 'simplify' ? kind : null;
    // Read only for the rows it can possibly govern: a read and a rendering have
    // no business opening the language-model settings.
    const settings = act === null ? null : await cleanTextEngineSettings();
    let request = config.request;
    let bracketed = false;
    let keepWarmMinutes = 0;
    if (act !== null && settings !== null && settings.server === 'vllm') {
      const route = textServerRoute(settings.endpoint);
      if (route.manage) {
        noteTextQueueBusy();
        bracketed = true;
        keepWarmMinutes = settings.keepWarmMinutes;
        const profile = profileForKind(act);
        request = {
          ...config.request,
          model: servedModelForRequest(config.request['model'], profile, act),
        };
        const up = await ensureTextServer(profile.id, (line) => {
          ctx.report({ message: line, detail: line });
        });
        console.log(`[foundry-job] ${act} runs against ${up.servedName} at ${up.url}`);
      } else {
        // Not ours to start. Said on the row, because "the endpoint is somebody
        // else's" is the difference between a slow start and a wrong model.
        ctx.report({ message: route.note, detail: route.note });
      }
    }

    /*
     * SAID, NOT SUBSTITUTED. `runJob` arrives with the Foundry seam; a subtree
     * that predates it cannot execute this row, and the honest outcome is a
     * failed row naming the reason — not a silent skip, and certainly not a quiet
     * fall back to Foundry's own queue, which is the exact thing the ruling
     * removed. `foundryRunner()` throws that sentence.
     */
    let row;
    try {
      row = await foundryRunner()(request, {
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
    } finally {
      /*
       * SUCCESS OR FAILURE ALIKE. A row that threw must hand the card back
       * exactly as a finished one does; `noteTextQueueIdle(0)` — the default —
       * stops the server now, and a keep-warm window always has an end.
       */
      if (bracketed) noteTextQueueIdle(keepWarmMinutes);
    }

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
