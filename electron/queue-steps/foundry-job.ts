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
  FOUNDRY_VERSION_FOR_CLEAN_TEXT, foundryRowFailure, foundryRunner, foundryTooOldForCleanText,
  parseFoundryProgressLine,
} from '../foundry-host-queue';
import type { FoundryJobStepConfig, FoundryRunOutcome } from '../foundry-host-queue';
/*
 * ── THE LEASE THIS RUN TAKES IS WRITTEN DOWN WHERE A SWEEP CAN FIND IT ──────
 *
 * The same ledger `crucible/job.ts` and `crucible/render.ts` write to, and the
 * same one the startup sweep reads. Foundry's lease was the one claim on a card
 * this app could make and not record (P8), and a ledger with two writers is
 * better than a second file: one sweep, one rule, one place a person looks after
 * a hard kill. See `onPlaced` below for what a `foundry-lease` row means.
 */
import { recordInFlight, settleInFlight } from '../crucible/in-flight-ledger';
import { FOUNDRY_LEASE_JOB_TYPE } from '../crucible/in-flight-sweep';
import { stepFailure } from './runtime';
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
 * NOTHING IS IMPORTED FROM `text-server.ts` OR `narration-clean-text.ts` HERE
 * ANY MORE, and the absence is the statement.
 *
 * This step used to read the machine's language-model settings
 * (`cleanTextEngineSettings`), pick a local vLLM profile (`profileForKind`),
 * assert its served name onto the request (`servedModelForRequest`) and start
 * and stop that server around the act (`ensureTextServer` /
 * `noteTextQueueBusy` / `noteTextQueueIdle`). Every one of those is a decision
 * about the ENGINE, and after Owen's ruling of 2026-09-14 the engine is
 * Crucible's: the server answers `GET /v1/capability` with the model it will
 * serve a class with, and the vendored window asks it. A profile chosen here
 * would be a second opinion about which weights clean a book — and worse, the
 * local arm behind it would start a model on THIS card for an act routed to
 * another machine.
 *
 * The local text engines themselves are deleted (docs/LEGACY-REMOVAL.md). They
 * are not a fallback for this path and must not be reintroduced as one.
 */

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
  /**
   * A GPU ACT TRAVELS. A CPU ACT DOES NOT. `resourceFor` IS THE ONE ANSWER.
   *
   * Asked of the same function that answers `resource`, on purpose: a step that
   * contends for a card and CANNOT travel is, by construction, charged to this
   * machine's card — `slotSetForStep` files a non-travelling step on
   * `LONGFORM_ALIGN_SET` — so the two facts cannot disagree without the bench
   * drawing work on a machine that is not doing it. Deriving one from the other
   * is what makes that unsayable rather than merely untrue today.
   *
   * ── WHY THIS CHANGED, 2026-09-19 ────────────────────────────────────────
   *
   * A READ USED TO BE `local` here, on this reasoning: *"a read is the VLM door
   * and still spawns a WSL python env here (electron/vlm-page-server.ts);
   * crucible docs/PHASE7-LANES.md §8.1 says making it travel is a Foundry-side
   * change."* That Foundry-side change has SHIPPED and is in the vendored
   * subtree: `foundry-app/electron/crucible-dispatch.ts` maps
   * `capabilityClassOf('read') → 'pages'`, so a hosted read goes through
   * `placeJob` → `placeOnCrucible`, which walks the slots, claims the model
   * lease and loads dots-ocr on a server. The comment outlived the fact.
   *
   * WHAT THE STALE ANSWER COST, live on 2026-09-18: Owen queued a read, the
   * bench drew it in the GPU slot of a local engine he had SWITCHED OFF — while
   * that same card's progress line read "Loading dots-ocr on" the OTHER
   * registered engine. Both were true. Because the step said `local`, this
   * side named no machine, sent `waitFor: null`, and the mount translated that
   * into an absent key — at which point Foundry answered with its OWN
   * `newJobsWaitFor` (default `'top'`, `foundry-app/electron/app-settings.ts`).
   * A machine chosen on nobody's screen, which is the precise hole
   * `FoundryRunJobOptions.waitFor` was added to close, reopened for every kind
   * this side called local.
   *
   * A RENDERING STILL DOES NOT TRAVEL, and now it says so for a reason the code
   * can check rather than a sentence in a comment: `resourceFor` calls it `cpu`,
   * because it asks no model at all — arithmetic over a bank already on disk.
   *
   * RULING OWED (crucible `docs/PHASE7-LANES.md` §4.4, one book = one GPU): a
   * book whose narration and whose text pass are separate queue RUNS can name
   * two different machines, because `waitFor` is per run and not per book. §4.4
   * is about one dependency chain, and these are two — so nothing here is
   * violated, and nothing here enforces it either. Whether a book's text pass
   * must land on the machine its render did is Owen's to rule; this build does
   * not invent the rule, and the venue each run used is on its own row.
   */
  machines: (config: Record<string, unknown>): 'local' | 'any' =>
    (resourceFor(config) === 'gpu' ? 'any' : 'local'),
  /**
   * WHICH CAPABILITY CLASS A TRAVELLING FOUNDRY ACT ASKS A CRUCIBLE FOR — the
   * mirror of the vendored dispatcher's `capabilityClassOf`
   * (`foundry-app/electron/crucible-dispatch.ts`), so the scheduler names the
   * class BEFORE it places the book instead of learning it after the engine
   * refuses one it cannot serve (Owen's pages-refused report, 2026-09-21: a
   * `read` routed to the Mac, whose mlx-darwin backend publishes `pages`
   * `enabled: false`).
   *
   * A READ IS `pages`. A cleanup/translate/simplify carries its own text class.
   * A RENDERING (epub/txt/pdf) names NONE and answers `null` — it travels
   * nowhere (`cpu`, `resourceFor`), asks no model, and has no class to be
   * matched against a server's capability. `analysis` is not a Foundry request
   * kind here — that class belongs to the `book-analysis` step.
   */
  crucibleClass: (config: Record<string, unknown>): string | null => {
    const kind = (config as unknown as FoundryJobStepConfig).request?.kind;
    switch (kind) {
      case 'read': return 'pages';
      case 'clean': return 'clean';
      case 'translate': return 'translate';
      case 'simplify': return 'simplify';
      default: return null;
    }
  },
  /*
   * NO `leasesModel` HERE, AND ITS ABSENCE IS THE STATEMENT.
   *
   * `StepModule.leasesModel` says *this step's work holds a Crucible lease, so
   * the row's lease may stay open for it*. A hosted text act's lease is not
   * ours: the vendored dispatcher takes one between making the model resident
   * and spawning the engine, and releases it in its own settle
   * (`crucible-dispatch.ts placeOnCrucible`). Crucible allows ONE lease per
   * server, so declaring `true` here would describe a lease that does not
   * exist, and keeping the row's open across this step would refuse THEIRS —
   * by name, to ourselves.
   *
   * It was offered as a one-line addition on 2026-09-14 (the scheduler agent's
   * note, `C:\tmp\bookforge-scheduler-to-foundry-seam.md`) and declined for
   * this reason by Foundry the same day. It does NOT become right at the
   * re-vendor: a row-keyed lease on the hosted path would be Foundry's design
   * to make, in their dispatcher, if Owen asks for one. See the full argument
   * on the Crucible venue in `run` below ("NO LEASE HERE, AND IT IS NOT AN
   * OMISSION — TWICE OVER").
   *
   * The scheduler's default for an undeclared step is false, which is the
   * truth here: a hosted act ends the run of acts the row's own lease was for,
   * and the card is given back before somebody else's client takes it.
   */
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
    const kind = config.request.kind;
    /*
     * THE THREE THAT ASK A LANGUAGE MODEL, as a narrowed value rather than a
     * boolean: `read` is the VISION model and has its own server
     * (electron/vlm-page-server.ts), and a rendering asks nothing at all. Written
     * this way so the venue block below is handed a kind the type system has
     * already agreed is a language act — the day a fourth arrives, this line is
     * the compile error.
     *
     * THREE AND NOT FOUR: `analysis` is a text act everywhere else in this seam
     * (it is one of crucible's four capability classes and has its own
     * capability row on every server), but no press
     * in the hosted window routes one across the host queue today — `analysis`
     * is deliberately absent from `FoundryJobKind`. RULING OWED: when Foundry
     * starts sending `kind: 'analysis'` here, this line, `FoundryJobKind`,
     * `isTextPass`, `resourceFor` and `labelFor` move together.
     */
    const act: 'clean' | 'translate' | 'simplify' | null =
      kind === 'clean' || kind === 'translate' || kind === 'simplify' ? kind : null;
    /*
     * ── WHERE THIS TEXT ACT RUNS, AND WHO COMPOSES IT ─────────────────────────
     *
     * Owen, 2026-09-15: *"text acts from foundry through crucible should work
     * … vendored or host, and it uses the same logic bookforge did before we
     * built crucible"* — i.e. vLLM, which is what Crucible's `llm` lane serves.
     *
     * TWO HALVES, AND THIS ENGINE OWNS EXACTLY ONE OF THEM. The client knows
     * the ORDER and the SERVER; Crucible knows the ENGINE (crucible
     * `docs/ARCHITECTURE.md`). So this step decides WHICH MACHINE, out of the
     * SAME routing record the render reads — the row's resolved venue first
     * (one book, one GPU: `docs/PHASE7-LANES.md` §4.3/§4.4, and `machines()`
     * above is what makes the engine resolve one at all), then the ranked list
     * — and hands the NAME across. Everything else about the act is the
     * vendored window's: `crucible-dispatch.ts placeOnCrucible` asks
     * `GET /v1/capability` for the model, `GET /v1/models` (and a `load-model`
     * job) for residency, takes the model LEASE, composes the header map with
     * `X-Crucible-Act` and the OpenAI base, and spawns the engine with that map
     * as `extraEnv`.
     *
     * **NOTHING IS COMPOSED HERE AND NOTHING IS WRITTEN ONTO THE REQUEST.** The
     * request crosses VERBATIM (`FoundryJobRequest` is stored "never normalised
     * on the way in"), because its `model`/`ollama` fields are Foundry's own
     * composition and the placement overrides both anyway
     * (`doorArgs`: `placement.model ?? request.model`). This side used to
     * overwrite them with a Crucible endpoint; that would now be the second
     * composer of one address, which is the defect this whole seam is about.
     *
     * NO LEASE HERE EITHER, AND IT IS NOT AN OMISSION. Crucible allows ONE
     * lease per server and refuses a second by name (`409 leased`,
     * crucible `c5eb431`); the vendored dispatcher takes its own between making
     * the model resident and spawning, and releases it in the queue's settle.
     * A lease taken here would be refused, or would refuse theirs — either way
     * the row parks for ever on a claim this app made against itself. BookForge
     * leases where BookForge spawns (`narration-clean-text.ts`, the CLI clean
     * routes), and that is the whole rule.
     *
     * ── "THE SAME LOGIC BOOKFORGE DID BEFORE WE BUILT CRUCIBLE" ──────────────
     *
     * Read literally, that is a shorter list than it sounds, and the reason is
     * worth writing down once so nobody looks for the rest of it on this side.
     * For a FOUNDRY-ROUTED act, BookForge's pre-Crucible logic was only ever
     * four things: which endpoint, which model, which local vLLM profile, and
     * the lifetime of that server. Everything a person would call "the
     * processing" was already inside the foundry binary and still is:
     *
     *   · THE PROMPTS — embedded in the binary (`src/clean/prompt.ts` imports
     *     them with `{ type: 'text' }`). `electron/prompts/tts-narration-text.txt`
     *     is byte-identical to their copy, and theirs is the one that runs.
     *   · THE PAYLOAD — one prose block per request, never batched with an
     *     unrelated one (one dropped marker would refuse a whole batch and the
     *     retry would re-do paragraphs that were already right). A CONTAINER is
     *     the exception and always was: consecutive items of a list, quotation
     *     or table pack under their `CHUNK_CHARS = 2000` into one request, and a
     *     block is never split.
     *   · THE POOL — `concurrency` workers in flight for vLLM to batch, 12 on
     *     the OpenAI door (Owen, 2026-09-08: *"lets build in vllm batching.
     *     ollama batching doesnt work"*). It is deliberately deeper than the ~7
     *     a server admits; the rest queue in the server. This step sends no
     *     `concurrency`, so that default stands — see the keeper.
     *   · THE BUDGETS — `answerBudget` (4x chars at 2.5 chars/token, floor 128)
     *     for a translation; temperature 0 and a fixed 2048 for a clean, which
     *     is the think-OFF number and NOT this app's 6144 (see the note on
     *     `EDITLIST_NUM_PREDICT` in `ai-bridge.ts`).
     *   · THE WINDOW — the OpenAI door is told nothing about the served context
     *     and instead refuses before request one (`fitsWindow`), which is why a
     *     too-small window is a fast 400 rather than a slow answer.
     *   · THE THINKING SWITCH — `/^qwen3(\.|:|-|$)/i`, sent as
     *     `chat_template_kwargs: {enable_thinking: false}` on this door, and
     *     CHECKED in the answer rather than trusted, because the switch is
     *     advisory.
     *
     * None of that is mirrored here, and mirroring any of it would be a second
     * copy of a number that lives in a program this app does not compile.
     *
     * ── THE LOCAL TEXT SERVER IS GONE FROM THIS PATH, DELIBERATELY ───────────
     *
     * There used to be an arm below this one that started BookForge's own
     * vLLM (`ensureTextServer`) when the act's endpoint was this machine's text
     * server. It is deleted with the rest of the legacy local layer
     * (docs/LEGACY-REMOVAL.md) and is NOT a fallback for a Crucible that cannot
     * be reached: quietly cleaning a book with a model nobody chose, and
     * reporting success, is the failure the whole campaign removed. A text act
     * that cannot be placed is REFUSED, by name.
     */
    /*
     * ── AND A READ IS PLACED HERE TOO, BY THE PAGES DECIDER ──────────────────
     *
     * `act` is the three LANGUAGE acts and stays that way; a read asks the
     * VISION model, which is a different capability class over there
     * (`capabilityClassOf('read') → 'pages'`) and a different decider here.
     * `placed` is the union — every act this side names a machine for — so the
     * offered/enabled check, the refusal and the log line below are written
     * ONCE for all four rather than copied into a second arm that would drift.
     *
     * WHY THE PAGES DECIDER AND NOT THE TEXT ONE: they read the same routing
     * record but they are not the same question. `decideWherePagesRun` is what
     * BookForge's OWN conversion door already asks (`queue-steps/vlm-convert.ts`,
     * which has declared `machines(): 'any'` all along), and a hosted read and a
     * local one must not be able to land on different machines for the same
     * book. One record, one decision, two doors into it.
     */
    let venueServer: string | null = null;
    const placed: 'clean' | 'translate' | 'simplify' | 'read' | null =
      act ?? (kind === 'read' ? 'read' : null);
    if (placed !== null) {
      const { decideWhereTextActRuns, processTextVenueHost } =
        await import('../crucible/text-venue.js');
      const { decideWherePagesRun, processPagesVenueHost } =
        await import('../crucible/pages.js');
      const { runVenueOfRow } = await import('../crucible/step-venue.js');
      /*
       * `runVenueOfRow` IS THE ONE READER of `waitForResolved`'s three shapes,
       * and reading it raw here was a latent defect: the string `any` means
       * *the row was never assigned*, and passing it straight on made
       * `decideWhereTextActRuns` treat it as the NAME of a server called "any".
       * It also refuses a row admitted under the retired local narrator by
       * name, instead of silently re-deciding where a half-done book runs.
       */
      const assigned = runVenueOfRow(ctx.job.waitForResolved);
      /*
       * THE RUN'S VENUE IS PASSED TO BOTH, which is what keeps §4.3's "one
       * book, one GPU" true across a chain that reads and then cleans: the
       * second act follows the machine the first was assigned, and only a run
       * with no assignment decides from the ranked record.
       */
      const venue = placed === 'read'
        ? await decideWherePagesRun(processPagesVenueHost(), undefined, assigned)
        : await decideWhereTextActRuns(assigned?.server, processTextVenueHost());
      /*
       * ── AND THE PRE-CHECK IS GONE (PK6) ─────────────────────────────────────
       *
       * What stood here read this machine's registry snapshot and REFUSED, by
       * name, when the venue was not on it — because a name that window could not
       * match was a `wait` over there, and a detached `runJob` had no pump slot to
       * give up, so `placeRun`'s `for (;;)` retried it with a backoff FOR EVER and
       * the promise never settled. *"A row that never fails and never finishes is
       * worse than either."*
       *
       * THAT SPIN IS DELETED. A wait now comes back the moment the placement says
       * it, typed and carrying `standing` — and a slot missing from the window's
       * list is exactly the case their own doc calls transient, so it arrives here
       * as a `wait` this engine PARKS and the reach sweep re-asks. The check is
       * therefore no longer the difference between a park and a hang; it is a
       * second registry with a second opinion, refusing a row for a reason the
       * seam can now state for itself.
       *
       * The NAME still crosses verbatim, and it is still the row's own spelling
       * out of the one registry (Owen, 2026-09-14) — see `venue` above.
       */
      venueServer = venue.server;
      const line = `[foundry-job] ${placed} goes to crucible "${venueServer}" (${venue.because}); the `
        + 'hosted Foundry window composes the endpoint, model, credential and lease';
      console.log(line);
      ctx.report({ message: line, detail: line });
    }

    /*
     * SAID, NOT SUBSTITUTED. `runJob` arrives with the Foundry seam; a subtree
     * that predates it cannot execute this row, and the honest outcome is a
     * failed row naming the reason — not a silent skip, and certainly not a quiet
     * fall back to Foundry's own queue, which is the exact thing the ruling
     * removed. `foundryRunner()` throws that sentence.
     */

    /*
     * NO CREDENTIAL TRAVELS FROM HERE, AND THAT IS STILL TRUE AFTER THE
     * RE-VENDOR — it is true for a better reason now. What crosses is a NAME,
     * and the window looks the token up in the registry this app already handed
     * it (`FoundryHost.servers()`), so the map with the bearer in it is
     * composed inside the process that spawns the engine and never passes
     * through this module, this call, or this process's environment.
     * `runFoundry`'s own strip keeps `$FOUNDRY_ENDPOINT_HEADERS` off BookForge's
     * OTHER children regardless.
     *
     * `request` is the row's, UNTOUCHED: see the venue block above.
     */
    /*
     * THE LEASE THIS RUN TOOK, remembered so the settle can clear it from the
     * ledger — whichever way the run ends, and whether or not the row survives.
     *
     * A LIST OF AT MOST ONE, because `onPlaced` fires once and a list is what the
     * compiler can read honestly: a `let` written only inside a callback keeps
     * its initializer's narrowing, so a nullable would be `never` by the time the
     * `finally` asks. The shape says the truth either way — nothing recorded, or
     * the one placement this run was given.
     */
    const recorded: { server: string; jobId: string }[] = [];
    const run = async (): Promise<FoundryRunOutcome> => foundryRunner()(config.request, {
      parentStep: config.parentStep,
      signal: ctx.signal,
      /*
       * THE MACHINE, AND THE ONLY THING THIS SIDE DECIDES ABOUT THE ACT.
       *
       * `null` ONLY for a RENDERING — and it is STATED rather than omitted,
       * because "this kind does not travel" is a fact about the kind
       * (`machines()`, via `resourceFor`: a rendering is `cpu`) and not an
       * absence. The mount turns it into an absent key, which lets the window's
       * own default decide for a run that places on no slot over there.
       *
       * ── AND THAT FALLBACK IS WHY A READ MAY NEVER SEND `null` AGAIN ────────
       *
       * Their `placedBy` argues this side's case against itself. When the host
       * DID name a machine its docblock says: *"Hosted, the person picked a
       * machine on the HOST's row, and this app's default is not an answer to
       * that question — it is an answer to a question nobody asked."* Four lines
       * on, with nothing named, it called `waitForOfNewJob()` and did exactly
       * that. On 2026-09-18 that put a read on one registered engine while this
       * queue drew it on another — one the operator had switched off.
       *
       * ── AND SINCE PK6 IT IS A VENUE RATHER THAN A PREFERENCE ──────────────
       *
       * The field was `waitFor`, which the placement was free to re-decide. This
       * engine polled the server, reserved the row's lease and charged the slot
       * before this call (§G rulings 7 and 9), so what crosses is a DECISION: the
       * runner places there and nowhere else, with no `ANY_SLOT` walk left to
       * disagree with the bench.
       */
      venue: venueServer === null ? null : { server: venueServer },
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
      /*
       * THE LOG'S COPY — filled by `foundryRunner()`, which is the one door every
       * hosted run goes through and therefore the one place the tee belongs. It
       * is declared here because the seam requires it; nothing in this step reads
       * a line twice.
       */
      onLine: () => undefined,
      /*
       * ── WHERE IT WENT, INTO THE IN-FLIGHT LEDGER, BEFORE IT RUNS ───────────
       *
       * P8's hosted half. The startup sweep reads
       * `<userData>/crucible-in-flight.json` and cancels or releases what a hard
       * kill left behind — and it covered only what THIS app submits, because
       * Foundry takes its own Crucible lease inside the vendored dispatcher and
       * recorded it nowhere. So a ctrl-C during a hosted clean left a lease held
       * by a process that no longer existed, with nothing on disk naming it.
       *
       * `jobId` IS THE LEASE ID, and `jobType` says so by name: the sweep reads
       * `foundry-lease` and sends `DELETE /v1/leases/{id}` rather than
       * `DELETE /v1/jobs/{id}`, because a lease is not a job (see
       * `in-flight-sweep.ts`). A placement that took no lease — an act that meets
       * no model — records nothing, because there is nothing for a sweep to do.
       *
       * `owns` IS EMPTY AND THAT IS DELIBERATE: the scratch a hosted run makes is
       * Foundry's `derived/` book, which its own settle sweeps and which the
       * scratch sweep has never owned. Naming it here would invite this app to
       * delete a file inside somebody else's project.
       */
      onPlaced: (placement) => {
        if (placement.leaseId === null || placement.server.length === 0) return;
        recorded.push({ server: placement.server, jobId: placement.leaseId });
        recordInFlight({
          server: placement.server,
          jobId: placement.leaseId,
          jobType: FOUNDRY_LEASE_JOB_TYPE,
          model: placement.model.length > 0 ? placement.model : null,
          localId: ctx.stepId,
          owns: [],
          submittedAt: new Date().toISOString(),
        });
      },
    });
    /*
     * NOTHING TO BRACKET ANY MORE, AND THAT IS THE POINT. This used to sit
     * inside a `try/finally` that stopped BookForge's own vLLM afterwards
     * (`noteTextQueueIdle`), because this side had started it. It does not start
     * anything now: the model on the far card is made resident and leased by the
     * vendored dispatcher, and released in the queue's own settle over there, so
     * a row that throws hands the card back through THEIR release rather than
     * ours. A `finally` here would be this app disposing of somebody else's
     * claim.
     */
    let outcome: FoundryRunOutcome;
    try {
      outcome = await run();
    } finally {
      /*
       * AND THE LEDGER IS CLEARED ON EVERY WAY OUT, including a throw. The
       * record exists to survive a KILL; a row left in it after the run is over
       * would send the next startup sweep at a lease Foundry has already given
       * back, which is a DELETE against a stranger's claim.
       */
      for (const held of recorded) settleInFlight(held.server, held.jobId);
    }

    /*
     * ── A BUSY CARD PARKS, IT DOES NOT REDDEN (Q4, Contract 2) ──────────────
     *
     * Foundry takes its own Crucible lease, so a `409 leased` / `409 server_busy`
     * used to arrive as a `failed` row carrying prose and turned RED in *Needs
     * you* for something nobody did wrong. It is typed now: `stepFailure(line,
     * line)` is a `StepParked`, which PK1's engine re-queues on the holder's line
     * with the admission cool-off, and the reach sweep asks again.
     *
     * A `standing` WAIT PARKS TOO, and that is the change PK6 made deliberately.
     * A server switched off or a class that card cannot serve is a wait only a
     * person can clear — so it waits for the person, on a row that says whose
     * card it is waiting for, instead of being refused here by a second reading
     * of this machine's registry. The sentence is the server's own.
     */
    if (outcome.outcome === 'wait') {
      throw stepFailure(outcome.busyLine, outcome.busyLine);
    }
    const row = outcome.row;

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
    if (outcome.outcome === 'cancelled') {
      noteStepStopped(ctx.stepId);
      throw new Error(`${config.label} was stopped.`);
    }
    if (outcome.outcome === 'failed') {
      /*
       * Foundry's own sentence, verbatim — this side knows less about why the
       * engine stopped than the engine's words do — AND its `busyLine` when the
       * row was refused by a holder rather than broken. That second half is
       * Contract 2 (Q4, 2026-09-20): Foundry takes its own Crucible lease, so a
       * `409 leased` came across this seam as prose and reddened a row over a
       * card that was merely held. `foundryRowFailure` is where the rule lives.
       */
      throw foundryRowFailure(outcome, config.label);
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
