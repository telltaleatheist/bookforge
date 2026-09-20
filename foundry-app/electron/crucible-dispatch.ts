/**
 * DISPATCH — which slot this job goes to, and what has to be true before the
 * engine is spawned against it.
 *
 * docs/SLOTS.md §5 states the rule this whole module exists to honour: **THE
 * OPERATOR LOADS, THE ENGINE NEVER DOES.** The engine speaks an OpenAI dialect
 * to whatever is at `--endpoint` and refuses by name when the model it was told
 * to use is not the one that server is holding; it has no verb for "make it
 * resident" and must not grow one, because a machine's residency is a fact about
 * a shared card and the thing spending an hour on it is not the thing that gets
 * to decide. So this app — the operator, the thing with a person in front of it
 * — reads what the server can serve, makes the model resident if it is not, and
 * only then spawns.
 *
 * ── The shape of every answer here is three-way, and that is the design ────
 *
 * A placement can be `go`, `wait` or `refuse`, and the difference between the
 * last two is the whole reason this module is not a boolean:
 *
 *   `wait`   — this is about the SERVER's state and will be different later, or
 *              on another machine. Somebody is narrating on it; the lane is
 *              taken; it is switched off; it is unreachable. The row goes back
 *              to the queue wearing the sentence, and is tried again with a
 *              backoff. Crucible does not queue — a second submission is refused
 *              rather than admitted — so the waiting is ours to own, and the SDK
 *              says so explicitly rather than hiding a retry loop nobody chose.
 *   `refuse`  — this is about the REQUEST and will be refused identically
 *              everywhere. The model is not one this server has ever heard of;
 *              the class is off. The row fails with the reason, once, rather
 *              than four times over four machines.
 *
 * `isServerSpecificRefusal` (the SDK) is what decides which, because the fact
 * has exactly one honest owner: the server that emitted the code.
 *
 * ── AND A WAIT NOW SAYS WHETHER TIME WILL EVER END IT ──────────────────────
 *
 * A `wait` carries `standing` ({@link PlacementWait}). Transient is everything
 * above and parks for ever, exactly as it always has; STANDING is "that server's
 * record says this class cannot run there", which no backoff will change. The
 * walk steps past both alike — the next machine is a different question — but a
 * PINNED row whose one slot answers standing, and an `any` row where every slot
 * did, now FAIL by name instead of parking. BookForge found the row that neither
 * failed nor finished and Owen ruled it a defect.
 *
 * ── Never a tight poll ────────────────────────────────────────────────────
 *
 * Nothing in here loops. One pass is one answer, and the BACKOFF lives on the
 * queue side (`job-queue.ts`) where the row is, because that is where the row
 * can be drawn while it waits and where a person can take it away.
 */
import {
  CrucibleBusy,
  CrucibleCapabilityUndecided,
  CrucibleLeased,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleUnreachable,
  isServerSpecificRefusal,
  type CrucibleClient,
} from '@crucible/client';

import { cloudEndpointOf, cloudHeaderMapFor, cloudProviderNamed } from './cloud-providers';
import {
  CrucibleOrchestratorError,
  clientFor,
  crucibleServerNamed,
  engineClientFor,
  engineSharedWith,
  enginelessServers,
  resolveEngine,
  slotAvailability,
} from './crucible-registry';
import { readAppSettings, type CrucibleServerEntry } from './app-settings';
import type { CapabilityRecord, CapabilityRow } from '../shared/engine-settings';
import { upstreamLaneName } from '../shared/queue-board';
import {
  ANY_SLOT,
  GPU_DIAL_ANY,
  slotNamed,
  type ComputeSlot,
  type SlotRefusal,
  type VenueSource,
} from '../shared/slots';
import type { LlmServerKind } from '../shared/pipeline';
import type { JobKind, ModelClass } from '../shared/types';

/**
 * THE CAPABILITY CLASSES, FROZEN, spelled exactly as Crucible's `capability.py`
 * spells them. The five this app can ask for; the other four (`echo`, `asr`,
 * `rvc`, `align`) belong to somebody else's pipeline.
 *
 * `simplify` and `analysis` are separate classes from `translate` even though
 * they select the same 27B on every card anyone has, and Crucible made them
 * separate on Owen's ruling of 2026-09-13: *"they can't lie to the user and say
 * a translate job is running when it's actually a simplify job."* Folding them
 * would make a client ask about `translate` in order to learn whether it may
 * simplify — which is the old lie, one layer down.
 *
 * ── AND IT IS `ModelClass` UNDER ANOTHER NAME, DELIBERATELY ─────────────────
 *
 * The five words were written out twice — here, and as `ModelClass` in
 * shared/types.ts, which is what the vendored lineup files a model's row under.
 * They were identical, and two spellings of one vocabulary is the defect this
 * repo keeps meeting: the acronym list that was fifteen here and seventeen
 * there, and the translate floor that one catalog declared and another quietly
 * lowered. So this is an ALIAS, and the catalog owns the words.
 *
 * The name stays because it says which question is being asked — `ModelClass`
 * is "what may serve this act", `CapabilityClass` is "what a server says it can
 * do" — and because the day Foundry needs a class Crucible has and no model of
 * ours does (`tts`, `asr`), this is the one that widens, on purpose, with a
 * reason written here rather than by drifting.
 */
export type CapabilityClass = ModelClass;

/**
 * THE ACT A JOB IS, as the server names it — and the value of `X-Crucible-Act`.
 *
 * The header is required on our side by Owen's naming ruling and is exactly one
 * of these five words. It is what makes a server's log say which act held the
 * card, rather than "an llm job", which is the same lie the act-prefixed log
 * lines in the engine were built to end.
 *
 * NULL FOR EVERY OTHER KIND. An export, a mint and an environment install put
 * nothing in front of a model; there is no class for them, no slot to place them
 * on, and they take the path they always took.
 */
export function capabilityClassOf(kind: JobKind): CapabilityClass | null {
  switch (kind) {
    case 'clean': return 'clean';
    case 'translate': return 'translate';
    case 'simplify': return 'simplify';
    case 'analysis': return 'analysis';
    case 'read': return 'pages';
    default: return null;
  }
}

/**
 * ── READS GO TO A CRUCIBLE NOW — RULED 2026-09-14 ──────────────────────────
 *
 * This was `false` while the local page reader was Package B's and the open
 * question was whether a REMOTE reader may be chosen at all when the local dots
 * server is the thing that works while the Mac is asleep. Owen answered it with
 * the whole phase (crucible docs/PHASE15-HOST.md §0): *"if it uses the GPU (as
 * dots does), it should probably be crucible-side … crucible can decide if the
 * user's system is even capable of running it … it should be a pass-through thin
 * client UI for the crucible engine."* A page reading is model INFERENCE, and
 * inference is Crucible's — on any card, on a CPU, in host mode or in WSL.
 *
 * So a `read` places like every other act: any registered server whose `pages`
 * row is enabled, in rank order, the loopback one first (`computeSlots`).
 *
 * ── THE THREE THINGS THAT HAD TO MOVE WITH IT, ALL IN THIS COMMIT ──────────
 *
 *   1. The reading server is started AFTER the placement and only when the
 *      placement is this machine's (`runInSlot`, electron/job-queue.ts). It used
 *      to be started first, unconditionally, which would have loaded four
 *      gigabytes onto this card for a reading that was about to be sent to
 *      another machine.
 *   2. A Crucible-placed reading gets `--vlm-endpoint` and `--vlm-endpoint-model`
 *      off the placement (`argsFor`). Without it the engine would read
 *      `backend.endpointUrl` out of settings.json and post the pages to whatever
 *      that names, which is the local reader — a placement nothing honoured.
 *   3. §5b's AUTOMATIC removal of Foundry's own dots files arms with this
 *      constant (`applyPageReaderRemoval` and `pageReaderRemovalOffer`,
 *      electron/machine-models.ts; `pageReaderSuperseded`, electron/page-reader.ts).
 *      All three already read it and all three say so. Flipping it without (1)
 *      and (2) would have deleted the thing still doing the work.
 */
export const CRUCIBLE_READS = true;

/**
 * DOES THIS KIND OF JOB GET PLACED AT ALL — the two early returns of
 * {@link placeJob}, asked before the walk instead of discovered inside it.
 *
 * ── Why it is exported, and what was wrong with it being implied ────────────
 *
 * Three callers need the same answer and each of them used to spell it out:
 * `placeJob` (which returns {@link UNPLACED} and never looks at a slot),
 * `placedBy` (which puts no `waitFor` on the row, so no picker is drawn), and —
 * since Package G — the PUMP, which has to know which lane a row will hold
 * before it picks it. A run that is never placed still runs on this machine: an
 * export is this disk, and a reading with `CRUCIBLE_READS` off would be this
 * card. Three copies of one predicate is how a reading ends up holding no lane at
 * all and two of them start on one card, so there is one copy and it is here,
 * beside the switch (`CRUCIBLE_READS`) that decides half of it.
 *
 * FALSE IS NOT "CHEAP" AND IS NOT "NO GPU". An export is false because it never
 * meets a model; a reading would be false because its model is on a path this
 * module does not route — which it now does, so that clause is live only if the
 * constant is ever turned back off. What they share is only that the answer to
 * *whose machine* is already decided — it is this one.
 */
export function placesOnASlot(kind: JobKind): boolean {
  if (capabilityClassOf(kind) === null) return false;
  if (kind === 'read' && !CRUCIBLE_READS) return false;
  return true;
}

/**
 * WHERE THIS JOB'S ENGINE WILL POINT — everything the spawn needs, and nothing
 * about the queue.
 *
 * `endpoint` and `model` are NULLABLE and null means "the request's own", which
 * is {@link UNPLACED}'s whole answer: the URL and the model tag the person chose
 * in the dialog are on the request already, and a placement that copied them here
 * would be a second owner of a per-run choice. Every PLACED run fills both in,
 * because a slot's endpoint and a server's selected model are nobody's preference
 * (docs/SLOTS.md §5).
 */
export interface Placement {
  /**
   * WHOSE MACHINE THIS RUN WENT TO — or NULL for a run that was never placed on
   * one at all.
   *
   * Null is not "undecided" and it is not a failure: it is the whole answer for a
   * job that puts nothing in front of a model (an export, a compile, a mint, an
   * environment install). Those run on this machine's disk and this machine's
   * cores, which Owen's ruling keeps here — *"cpu slots are always local. we dont
   * outsource simple cpu work to crucible"* — and there is no slot for that work
   * to name, because the CPU side of the board is a count rather than a list.
   *
   * IT USED TO BE THE LOCAL SLOT, and the field was never nullable: a job like
   * that was placed on a slot called "This computer" and recorded as having run
   * there. That slot is gone (Wave 66), and inventing a name for a machine the
   * list no longer carries would put a string in front of a person that nothing
   * else in the app says. {@link UNPLACED} is the one value that carries it.
   */
  slot: ComputeSlot | null;
  /**
   * Which engine dialect. `openai` is the engine's default and goes unspelled on
   * the command line; `ollama` and `anthropic` are both written out (`doorArgs`,
   * electron/job-queue.ts), because the engine refuses an unknown value by name
   * and a door left unsaid would be the default answering for it.
   */
  door: LlmServerKind;
  /** `--endpoint`, or null to use the request's own. */
  endpoint: string | null;
  /** `--model`, or null to use the request's own. */
  model: string | null;
  /**
   * WHAT THIS SPAWN'S ENVIRONMENT GETS ON TOP OF THE PROCESS'S — the header map,
   * and the only place a token is ever attached to a job.
   *
   * `FOUNDRY_ENDPOINT_HEADERS` is a JSON object of header name to value, and it
   * is an ENVIRONMENT VARIABLE rather than a flag deliberately and permanently
   * (docs/BOOKFORGE-HANDOFF.md): a command line is spelled into the terminal by
   * the queue, pasted into bug reports, and listed by the process table. There
   * is no flag for this and there should never be one.
   *
   * EMPTY FOR THE LOCAL SLOT, which authenticates nothing.
   */
  env: Record<string, string>;
  /**
   * THE CLAIM ON THE RESIDENT MODEL, held for the length of this run.
   *
   * Null on every placement that never touched a Crucible, AND on a Crucible
   * placement whose route is upstream — PHASE15 §3.4: *"no lease, no lane, the
   * settlement untouched (nothing was on the card)"*, and §3.4 again on the lease
   * route itself, which refuses one by name (`lease_not_needed`). Non-null
   * placements MUST be released — see {@link Lease}, which says what happens if
   * they are not. `settled` (electron/job-queue.ts) already reads an absent lease as
   * nothing to release, which is why this needed no change there.
   */
  lease: Lease | null;
  /**
   * THE UPSTREAM THIS RUN IS FORWARDED TO, or null for work on a card.
   *
   * The name alone — `anthropic`, `openai`, `ollama` — and not the model id,
   * because this field answers a question about the LANE and about the sentence
   * a person reads. The model id is `model`, one line up, and is on the command
   * line where it belongs.
   *
   * It is what makes the run take the server's `[cloud]` lane rather than its
   * card (`upstreamLaneName`, shared/queue-board.ts) and what the shelf says
   * after "on <server>".
   */
  via: string | null;
  /**
   * `--concurrency`: HOW MANY BLOCKS THE ENGINE MAY HAVE IN FLIGHT AT ONCE, stated
   * by the PLACEMENT because it is a property of the server that answered.
   *
   * ── The night this closes (BookForge's hunt, F3a) ──────────────────────────
   *
   * Nothing set it. The request's field was optional and no door on either side
   * filled it, so every text act took the ENGINE's own default —
   * `DEFAULT_TEXT_CONCURRENCY = 12` (src/translate/model-server.ts), whose own
   * docblock states the assumption that makes twelve safe: *"the server admits
   * what fits in its KV cache and QUEUES the rest"*. That is false against a
   * Crucible chat proxy fronting a serial `mlx_lm`: the twelfth request's
   * 300-second clock is armed at SEND and covers the eleven ahead of it, so any
   * per-block time over ~27 s times the tail out. The failure was the queueing,
   * never the model.
   *
   * ── Why the placement and not the request ─────────────────────────────────
   *
   * `crucible-dispatch.ts` is the only module that knows WHICH server answered,
   * and depth is a fact about that machine — the page reader has always taken its
   * number from the server that serves the pages. A number on the request would be
   * a person's preference about somebody else's backend.
   *
   * ── THE SERVER'S NUMBER, AND FOUR ONLY WHEN IT STATES NONE ────────────────
   *
   * Owen's ruling 4 of 2026-09-20, off the Mac's 2026-09-08 measurement, was 4 on
   * a Crucible chat door *until the server states a number of its own*. Crucible
   * 1.0.10 states one the same day: `chat.max_in_flight` on `/v1/activity` — 2 on
   * the Mac's serial `mlx-lm`, nothing at all from a vLLM, which batches. It is
   * an ADMISSION limit and not a throughput opinion: past it a request is refused
   * `503 chat_queue_full` rather than queued, which is how four went out against
   * an admission of two and killed a clean pass. So the placement asks
   * (`chatDepthFor`) and {@link CRUCIBLE_CHAT_CONCURRENCY} is now the UNSTATED
   * fallback.
   *
   * THE ENGINE CLAMPS TO IT AS WELL, and that is not a second copy of this rule —
   * it is the same rule applied to a number that may be STALE. This app's dist
   * outlives the server it places against: a build already running keeps sending
   * the depth it was compiled to send, and cannot be corrected without a restart.
   * So `resolveConcurrency` (src/translate/model-server.ts) reads the same field
   * and refuses to keep a pool above it whatever `--concurrency` said, honouring
   * anything BELOW it untouched. Two readers, one authority: the server's.
   *
   * NULL IS "THE REQUEST'S OWN", exactly as `endpoint` and `model` are null on
   * {@link UNPLACED}: a job that never meets a model states no depth, and a dry run
   * prints the request's own number or no flag at all.
   */
  concurrency: number | null;
}

/**
 * THE PLACEMENT NOTHING PICKED — what a job takes when it never meets a model.
 *
 * ── What it means NOW, which is narrower than what it used to mean ──────────
 *
 * It was "there is no slot list, so run the way this app ran before slots
 * existed": a person with no Crucible, and a hosted window whose host registers
 * no slot provider, both landed here and both ran against this machine's Ollama.
 * Owen's ruling ended that — *"there should be no local gpu listed in the queue"*
 * — so an empty slot list is now a REFUSAL for anything that needs a card
 * ({@link placeJob}), and this value is left to the jobs it was always honest
 * for: the ones with no capability class at all. An export, a compile, a
 * rasterise, an environment install. They take `slot: null` because the CPU side
 * of the board is not a list of machines, and `door: 'ollama'` with a null
 * endpoint and a null model because that is what "the request's own" means on the
 * one command line they still spell (`argsFor`, electron/job-queue.ts, whose
 * `--dry-run` caller has no server to ask).
 */
export const UNPLACED: Placement = {
  slot: null,
  door: 'ollama',
  endpoint: null,
  model: null,
  env: {},
  lease: null,
  via: null,
  // NOTHING TO SAY: this job meets no model, so there is no server whose depth
  // this could be. `doorArgs` then falls back to the request's own number, which
  // is what a dry run prints.
  concurrency: null,
};

/**
 * HOW MANY BLOCKS IN FLIGHT ON A CRUCIBLE CHAT DOOR — Owen's ruling 4, 2026-09-20.
 *
 * *"4 in flight on the Crucible chat door until the server states a number (Sep 8
 * measurement: knee at 4)."* It is a ceiling on OUR side of a proxy that serves
 * one request at a time on the card behind it; the engine's own twelve was
 * measured against a vLLM that batches, and a number measured on one backend is
 * not a number about another.
 *
 * THE ONE PLACE. When a capability row starts stating a depth, it is read here and
 * nowhere else — see `Placement.concurrency`.
 */
export const CRUCIBLE_CHAT_CONCURRENCY = 4;

/**
 * HOW LONG THE DEPTH READ MAY TAKE. A status read in front of a placement that
 * has already made three round trips; a server too slow to answer this in ten
 * seconds will be named by the placement itself a moment later, with a better
 * sentence. A cut-off is `null`, which is the same answer as "it did not say".
 */
const CHAT_DEPTH_TIMEOUT_MS = 10_000;

/**
 * WHAT THIS SERVER WILL ADMIT AT ONCE ON ITS CHAT DOOR — `chat.max_in_flight`.
 *
 * ── The fact, and why it outranks the knee ────────────────────────────────
 *
 * Crucible 1.0.10 bounds chat completions per engine and publishes the bound on
 * `/v1/activity`. On the Mac's serial `mlx-lm` it is 2 (engine concurrency 1,
 * plus one); a vLLM batches, states nothing, and is not bounded. Past the bound
 * a request is not queued — it is refused `503 chat_queue_full`. So this is not
 * a second opinion about throughput to be weighed against {@link
 * CRUCIBLE_CHAT_CONCURRENCY}'s measured knee: it is what the other end will
 * ACCEPT, and a placement that asks for more spends the run retrying. That is
 * the defect of 2026-09-20 (BUG-HUNT §A): four out, two admitted, two refused,
 * and the clean pass died on the refusals.
 *
 * ── Null is "it did not say", never a zero ────────────────────────────────
 *
 * No engine resident, an engine that does not bound chats, a Crucible older
 * than 1.0.10, an unreachable server, a cut-off — all one answer to a caller,
 * and that answer is `CRUCIBLE_CHAT_CONCURRENCY`. Nothing here throws: the
 * placement's own calls decide whether this server can be used, with sentences
 * built for that, and a courtesy read must not be the thing that fails a row.
 *
 * ── AND IT IS THE ONE CRUCIBLE ROUTE IN THIS FILE NOT SPOKEN THROUGH THE SDK ─
 *
 * `@crucible/client` 1.0.10's `Activity.chat` carries `inFlight` and `rows` and
 * DROPS `max_in_flight` — the client is one release behind the server on this
 * field, and `client.activity()` cannot hand back a number it never parsed. So
 * this reads the document itself, with the entry's own token, exactly as
 * {@link headerMapFor} composes it. The moment the SDK carries the field this
 * function becomes one line of `client.activity()` and the fetch goes; it is
 * written small and in one place so that is a small edit. Foundry does not
 * re-implement an SDK rule here — there is no rule to re-implement, only a field
 * to read.
 */
async function statedChatDepth(engine: CrucibleServerEntry): Promise<number | null> {
  const url = `${engine.url.replace(/\/+$/, '')}/v1/activity`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${engine.token}`, 'X-Crucible-Api': '1' },
      signal: AbortSignal.timeout(CHAT_DEPTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const document = await response.json() as { chat?: { max_in_flight?: unknown } } | null;
    const stated = document?.chat?.max_in_flight;
    if (typeof stated !== 'number' || !Number.isFinite(stated) || stated < 1) return null;
    return Math.floor(stated);
  } catch {
    /*
     * NOTHING IS LOGGED FROM THE CATCH, and that is not silence about a failure:
     * the caller says which number it settled on and why, in one line, on every
     * path (`chatDepthFor`). A second line here would report the same decision
     * twice and would put a network message in front of a person whose placement
     * is about to succeed.
     */
    return null;
  }
}

/**
 * THE NUMBER THAT GOES ON THE PLACEMENT, and the line that says where it is from.
 *
 * The server's own admission limit when it states one, {@link
 * CRUCIBLE_CHAT_CONCURRENCY} when it does not — and it SAYS WHICH, because a run
 * at four against a server admitting two looks exactly like a run that asked and
 * was told four. `pages` states none at all: `--vlm-concurrency` is the page
 * reader's own flag, taken from the server that serves the pages, so a chat
 * depth on a reading placement would be a number about the wrong door.
 */
async function chatDepthFor(
  engine: CrucibleServerEntry,
  capability: CapabilityClass,
  say: PlacementProgress,
): Promise<number | null> {
  if (capability === 'pages') return null;
  const stated = await statedChatDepth(engine);
  if (stated === null) {
    say(
      `${engine.name} states no chat depth, so ${capability} runs with `
      + `${CRUCIBLE_CHAT_CONCURRENCY} requests in flight.`,
    );
    return CRUCIBLE_CHAT_CONCURRENCY;
  }
  say(`${engine.name} admits ${stated} chat${stated === 1 ? '' : 's'} at once.`);
  return stated;
}

export type PlacementOutcome =
  | { verdict: 'go'; placement: Placement }
  /** Try again later — the server's state, not the request. See the module note. */
  | PlacementWait
  /** This will be refused the same way everywhere. Fail the row and say so once. */
  | { verdict: 'refuse'; reason: string };

/**
 * A WAIT, AND WHETHER TIME ALONE WILL EVER FIX IT.
 *
 * ── The defect this field closes, in BookForge's words ─────────────────────
 *
 * *"A row that neither fails nor finishes is worse than either."* `placeRun`
 * (electron/job-queue.ts) parks a `wait` and retries with a backoff capped at
 * thirty seconds, FOR EVER — which is exactly right for a busy card and exactly
 * wrong for a capability record that says this machine cannot do this act. A row
 * pinned to such a server, or an `any` row where no slot can, used to sit in the
 * queue until somebody noticed.
 *
 * ── The distinction, and it is about WHO can change the answer ─────────────
 *
 *   `standing: false` — TRANSIENT. `server_busy`, `engine_in_use`, a load in
 *     flight, a machine that is unreachable right now, a slot that is switched
 *     off, a card nobody has measured yet. **Time alone fixes these**, so the row
 *     parks exactly as it always has and `parkDelay`/`forgetPark` are untouched.
 *   `standing: true` — STANDING. The server's own record says this class cannot
 *     run there. Nothing the queue does on a timer will change it; only a PERSON
 *     can — route the class upstream in that engine's settings, put a bigger card
 *     in the machine, or send the job somewhere else.
 *
 * ── IT IS STILL A WAIT FOR THE WALK, AND THAT HALF DOES NOT CHANGE ─────────
 *
 * A standing refusal is a fact about ONE machine: the same job on the next one
 * in the ranking is a different question, so `any` steps past it exactly as
 * before. What changes is the ENDING — {@link placeJob} answers `refuse` when
 * the PINNED slot gave a standing wait, or when every slot in the walk did,
 * because at that point there is nothing left for time to do.
 */
export interface PlacementWait {
  verdict: 'wait';
  reason: string;
  standing: boolean;
}

/**
 * A wait that time may fix. The default shape, and the one the queue parks.
 *
 * Spelled as a constructor rather than an object literal at each of the fifteen
 * sites so that `standing` is REQUIRED and every one of them says which kind it
 * is out loud. An optional field would have made "nobody thought about it" and
 * "this is transient" the same value, which is the distinction this type exists
 * to draw.
 */
function transientWait(reason: string): PlacementWait {
  return { verdict: 'wait', reason, standing: false };
}

/** A wait only a person can end. See {@link PlacementWait}. */
function standingWait(reason: string): PlacementWait {
  return { verdict: 'wait', reason, standing: true };
}

/** What a placement pass may say while it is working — one line, onto the row. */
export type PlacementProgress = (line: string) => void;

/**
 * MAY THIS RUN HAVE THAT SLOT — the scheduler's lane, asked from INSIDE the walk.
 *
 * ── Why the walk claims rather than the pump reserving ─────────────────────
 *
 * Package G gives every compute slot its own lane, so two `any` rows may now be
 * walking at the same moment — and a walk takes minutes when it has to load a
 * model. If the pump handed each of them a lane up front it would be making the
 * placement decision (which this module owns, and which depends on facts only a
 * server can answer); if it handed them nothing, both would find the same slot
 * idle and start two runs on one card. So the walk asks, at the one instant it
 * commits to a slot, and the answer is authoritative because the scheduler's
 * occupancy map is main-process state that changes under no await.
 *
 * TRUE MEANS THE LANE IS NOW THIS RUN'S. There is no matching release: a run
 * holds exactly one lane, so claiming the next candidate gives the last one back,
 * and the whole claim goes when the row settles. A caller with no lanes to ration
 * — a host's scheduler through `runJob`, the Export dialog through `runNow` —
 * passes a claim that always says yes, because the deciding already happened
 * somewhere this queue cannot see (electron/job-queue.ts, `detachedRuns`).
 *
 * ── IT IS A LANE'S NAME, NOT A SLOT'S, AND THE TWO STOPPED BEING ONE ───────
 *
 * Wave 62: a Crucible slot has TWO lanes — its card, and the `[cloud]` one an
 * upstream-routed act takes (`upstreamLaneName`, shared/queue-board.ts). The
 * argument was `slot` when every slot was one lane; it is the LANE now, and the
 * card lane still bears the slot's own name so nothing about the local path
 * changed. The capacity is the caller's to know: an upstream lane takes two.
 */
export type LaneClaim = (lane: string) => boolean;

/**
 * PLACE THIS JOB.
 *
 * `waitFor` is the row's own — a slot name, {@link ANY_SLOT}, or undefined for a
 * row minted before the picker existed (or by a host that has not re-vendored),
 * which means "wherever this app would have sent it anyway".
 *
 * ── The `any` walk, and the one thing it is careful about ──────────────────
 *
 * It takes the first slot that will START the job, in rank order. A server that
 * is busy, unreachable, switched off or cannot do this act is stepped past; a
 * refusal that is about the REQUEST stops the walk immediately, because trying
 * three more machines would produce three more identical refusals and report the
 * third machine's. Nothing reachable at all is a `wait` naming every one of
 * them, because a person looking at a held row needs to know it is not one
 * server that is in the way.
 *
 * A CLOUD SLOT IS NEVER WHAT `any` FALLS THROUGH TO (docs/SLOTS.md §3). It is
 * STEPPED PAST WITH A SENTENCE rather than skipped in silence, which is the one
 * change Package F made to this walk: a machine whose only slot is a provider
 * would otherwise park every `any` row reading "no slot is available", and the
 * true statement is that there IS one and this walk will not spend somebody's
 * money to reach it. The sentence says so, and the picker on the row is where
 * the choice is made.
 *
 * ── AND THE WALK NOW TAKES THE LANE AS IT GOES (Package G) ─────────────────
 *
 * `claim` is the scheduler's occupancy, asked per candidate — see
 * {@link LaneClaim}. A slot this app is ALREADY running something on is stepped
 * past exactly like a busy one, with a sentence saying so, because that is what
 * it is: the difference between somebody else's job holding the card and our own
 * matters to the wording and to nothing else.
 *
 * ── WHERE THE CLAIM HAPPENS MOVED, AND WHY (Wave 62, Package K) ────────────
 *
 * It used to be RIGHT HERE, one line above `placeOn`: the walk claimed
 * `slot.name` and only then asked the server anything. That was correct while a
 * slot was one lane. It stopped being correct the moment a class could route
 * UPSTREAM (PHASE15 §3.3), because which of the slot's two lanes a run belongs in
 * is a fact only `GET /v1/capability` knows — so claiming first meant holding a
 * machine's CARD for the length of a network read that was going to end in a
 * placement that never touches it, and, worse, KEEPING it: a run forwarded to
 * Anthropic would have sat in the GPU lane for an hour while the card idled and
 * the next translation waited for it.
 *
 * So the claim is taken INSIDE `placeOnCrucible`, after the capability row is
 * read and the route is known, on the lane the route names. `placeOn` claims for
 * the one slot kind that needs no read (a cloud provider, which Package L
 * deletes; the local slot was the other, and Wave 66 deleted it).
 *
 * TWO CONSEQUENCES, BOTH DELIBERATE. The walk now costs one capability read per
 * candidate even when our own job holds that machine's card — the read is what
 * tells it whether the card is the lane it wanted. And the PINNED path claims
 * too, which it did not before: the pump used to reserve a pinned row's lane at
 * the pick, and it cannot any more, for the same reason (`laneAtPick`,
 * electron/job-queue.ts, which now reserves only where there is nothing to
 * choose between).
 */
export async function placeJob(
  kind: JobKind,
  waitFor: string | undefined,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
): Promise<PlacementOutcome> {
  const available = slotAvailability();
  const slots = available.slots;
  const capability = capabilityClassOf(kind);
  /*
   * NOTHING TO DECIDE, and it is now ONE way rather than three: this job never
   * meets a model (an export, a mint, an install). It claims no lane, and the
   * pump is why — such a row is a run on THIS machine and `laneAtPick` settles it
   * before the pick (`placesOnASlot` is the shared half of this test), so
   * claiming here as well would be a second owner of one reservation.
   *
   * `capability === null` IS `placesOnASlot`'s FIRST CLAUSE, repeated for the
   * compiler rather than for the reader: the walk below needs the class narrowed
   * to a non-null one, and a predicate in another function cannot narrow a local.
   */
  if (capability === null || !placesOnASlot(kind)) {
    return { verdict: 'go', placement: UNPLACED };
  }
  /*
   * ── AND AN EMPTY SLOT LIST IS A REFUSAL NOW, NOT A LOCAL RUN (Wave 66) ────
   *
   * It used to fall through to {@link UNPLACED} and run against this machine's
   * Ollama, because there was always a local slot behind it. Owen deleted it:
   * *"everything goes through a crucible server now, including local… there
   * should be no local gpu listed in the queue."* With nothing registered there
   * is nowhere for this act to go, and the honest answer is to say so ONCE, by
   * name, with the thing a person can do about it — not to park the row for ever
   * on the hope that a server appears, and not to run somewhere nobody chose.
   */
  if (slots.length === 0) {
    return { verdict: 'refuse', reason: noEngineReason(available.refusal) };
  }

  /*
   * ── THE LIVE QUEUE'S DIAL, AND THE ONE PLACE THE TWO CONTROLS MEET ───────
   *
   * Owen, 2026-09-15: *"a queue item is in pending, then the crucible server is
   * chosen (even if thats 'any'), and it's sent to the live queue. the live
   * queue distributes it to the correct crucible server depending on what the
   * live queue is set to — any, or a specific crucible server."* And the gate:
   * *"if the queue has 'm1 ultra' set as the crucible server, but the job item
   * is set to 3090 ti … the queue doesnt process it until the global queue
   * unlocks the 3090 ti."*
   *
   * THE DIAL RESTRICTS; IT DOES NOT REDIRECT. A row that named a machine and
   * disagrees with the dial WAITS. Sending it to the dial's machine instead
   * would be this app overruling a choice somebody made on purpose, silently,
   * and the row would finish on a card they did not pick.
   *
   * HERE AND NOT IN THE PUMP, because this is the function that already owns
   * "which machine does this row want" and every sentence about not getting
   * one. A second gate in `canStart` would be a second answer to that question,
   * and `canStart` has no sentence to say — it returns a boolean, so a row it
   * refused would sit queued with nothing on it (`docs/SLOTS.md`: *"a row that
   * neither fails nor finishes is worse than either"*).
   *
   * THE SOURCE TRAVELS WITH THE CHOICE from this line onwards. `row` when the
   * book named the machine, `dial` when the book said Any and the dial chose —
   * see {@link VenueSource}, and `orAnyWords`, which is the only reason the
   * distinction is carried at all.
   *
   * ── AND IT IS ONE VALUE, NOT TWO, SO A SOURCE CANNOT OUTLIVE ITS VENUE ────
   *
   * This was `let pinned` beside `let source: VenueSource = 'row'`, which was
   * correct only by an argument: `source` is read where `pinned` is non-null,
   * and in the both-open case (the book says Any and so does the dial) `pinned`
   * is null, so the `'row'` initialiser — the WRONG tail for that case, since
   * the book already says Any — was never reached. Safe, and safe by reasoning
   * about a path rather than by construction.
   *
   * BookForge's module has no such initialiser and said plainly why: their
   * `source` is a REQUIRED parameter, so *"if I had written a default it would
   * have been 'row' and it would have had exactly your bug. The thing that saved
   * it was making the parameter required."* The same shape here is one nullable
   * object: there is no source without the machine it describes, so the default
   * that could be wrong has nowhere to live.
   */
  // The registry can collapse an orchestrator and its engine onto one lane.
  // Existing queue selections remain valid aliases for that same engine.
  const canonical = (name: string): string => engineSharedWith(name) ?? name;
  const dial = canonical(readAppSettings().queueGpuDial);
  const asked = waitFor !== undefined && waitFor !== ANY_SLOT ? canonical(waitFor) : null;
  if (dial !== GPU_DIAL_ANY && asked !== null && asked.toLowerCase() !== dial.toLowerCase()) {
    /*
     * THE DISAGREEMENT, and it is a TRANSIENT wait rather than a refusal: the
     * dial is one control away from agreeing, and failing the row would throw
     * its queue position away for a gesture somebody is about to make. It is
     * `dial`-sourced, so the tail says to turn the dial — telling somebody to
     * set this book to Any would be telling them to abandon the machine they
     * deliberately chose.
     */
    return transientWait(
      `waiting for "${asked}", and the queue's GPU dial is set to "${dial}"`
      + `${orAnyWords('dial')}`,
    );
  }
  /*
   * Past the disagreement there are exactly three shapes, and each carries its
   * own source: the dial chose (the book asked for nothing), the book chose
   * (with the dial open, or agreeing), or nobody chose and the walk decides.
   */
  const venue: { name: string; source: VenueSource } | null = dial !== GPU_DIAL_ANY
    ? { name: dial, source: asked === null ? 'dial' : 'row' }
    : asked === null ? null : { name: asked, source: 'row' };

  if (venue !== null) {
    const pinned = venue.name;
    const slot = slotNamed(slots, pinned);
    if (slot === null) {
      /*
       * THE ONE REASON A NAMED SERVER IS NOT A SLOT WHILE STILL BEING REGISTERED
       * AND SWITCHED ON: it resolved to an orchestrator with no engine behind it
       * (`engineAbsence`, crucible-registry.ts, and PHASE17 §6). That is not
       * something a backoff fixes — somebody installs an engine on that machine
       * or re-points the row — so the row FAILS with the resolver's own sentence,
       * which names both. Parking it under "switched off or no longer registered"
       * would be a wrong sentence about a row that would then never finish.
       */
      const absent = enginelessServers().find(
        (server) => server.name.toLowerCase() === pinned.toLowerCase(),
      );
      if (absent !== undefined) return { verdict: 'refuse', reason: absent.sentence };
      /*
       * A row waiting for a slot that is not in the list — switched off, renamed
       * or removed while the row sat in the queue. It WAITS rather than fails,
       * because switching a server back on is a gesture somebody is about to
       * make and a failed row would have thrown the queue position away for a
       * toggle. The Servers card offers the other fix (reassign these rows to
       * "any") at the moment the switch is flipped, so nobody has to find this
       * sentence to learn what happened.
       */
      /*
       * THE SOURCE IS WHY THIS SENTENCE IS NOT A CONSTANT. The machine that is
       * switched off may be the one the BOOK named or the one the DIAL named,
       * the cause reads identically either way, and the two want opposite
       * gestures. Before the dial existed there was only one source and the
       * tail could be assumed; it cannot be now.
       */
      return transientWait(
        `waiting for "${pinned}", which is switched off or no longer registered`
        + `${orAnyWords(venue.source)}`,
      );
    }
    /*
     * A PINNED ROW HAS NO WALK LEFT, so a standing refusal from its one slot is
     * the end of the line: there is no next machine to be a different question,
     * and parking would be this queue asking the same server the same thing
     * twice a minute until somebody noticed the row. It FAILS, with the server's
     * own reason and the two things a person can do about it.
     */
    const outcome = await placeOn(slot, capability, say, claim, signal);
    return outcome.verdict === 'wait' && outcome.standing
      ? { verdict: 'refuse', reason: `${outcome.reason}. ${whatToDoAbout(capability)}` }
      : outcome;
  }

  const reasons: string[] = [];
  /*
   * DID EVERY CANDIDATE ANSWER WITH SOMETHING ONLY A PERSON CAN CHANGE? Starts
   * true and is falsified by the first transient wait, so a walk that found
   * nothing at all (no candidates) stays true and is still reported as the
   * `no slot is available` wait below — `reasons.length === 0` is tested first.
   */
  let allStanding = true;
  for (const slot of slots) {
    if (slot.kind === 'cloud') {
      /*
       * STEPPED PAST, AND IT IS A STANDING ANSWER. docs/SLOTS.md §3's ruling —
       * a cloud slot is *"a deliberate per-job choice, never something `any`
       * falls through to"* — is permanent, so this walk will answer identically
       * on every pass until a PERSON puts the provider's name on the row. That
       * is the definition one type up, and it is why a board whose only slot is
       * a provider now fails its `any` rows with a sentence naming the picker
       * instead of parking them for ever.
       */
      reasons.push(`"${slot.name}" is a cloud provider, and cloud slots are chosen on purpose`);
      continue;
    }
    const outcome = await placeOn(slot, capability, say, claim, signal);
    if (outcome.verdict === 'go') return outcome;
    if (outcome.verdict === 'refuse') return outcome;
    if (!outcome.standing) allStanding = false;
    reasons.push(outcome.reason);
  }
  if (reasons.length === 0) return transientWait('no slot is available');
  return allStanding
    ? {
      verdict: 'refuse',
      reason: `no slot can ${capability} — ${reasons.join('; ')}. ${whatToDoAbout(capability)}`,
    }
    : transientWait(`no slot is free — ${reasons.join('; ')}`);
}

/**
 * THE TAIL OF EVERY PARKED SENTENCE — and the ONE thing it has to get right is
 * which control the person should reach for.
 *
 * BookForge's `orAny(source)`, adopted on their advice that it is the single
 * most important thing to copy from their queue. The failure it prevents is
 * silent: every cause a row can park for arises under BOTH sources, the cause
 * does not say which, and telling somebody whose book already says Any to *"set
 * this book to Any"* is telling them to do the thing they have already done. A
 * person who follows that instruction, finds it changes nothing, and reads the
 * same sentence again has been told to fix the wrong control by an app that
 * sounded certain.
 *
 * See {@link VenueSource}. It is a space-prefixed clause rather than a sentence
 * so the caller composes one sentence and not two.
 */
function orAnyWords(source: VenueSource): string {
  return source === 'dial'
    ? ". Turn the queue's GPU dial to Any to let it run anywhere"
    : '. Set this job to Any to let it run anywhere';
}

/**
 * THE OTHER HALF OF A STANDING REFUSAL: what a person does about it.
 *
 * The server's own `reason` already travels on the wait (the shortfall it
 * measured, the sentence a host-mode engine gives for a class that needs WSL),
 * and that half names the FACT. This names the ROUTES out of it, and there are
 * exactly two: send the class to an upstream from that engine's own settings —
 * the same card `UPSTREAM_SETTINGS` names for a missing credential, because it
 * is the same card — or put the job on a different server with the picker on the
 * row. A third, "buy a bigger card", is real and is not something an app says.
 */
function whatToDoAbout(capability: CapabilityClass): string {
  return `Nothing here will change that on its own: ${UPSTREAM_SETTINGS} to route ${capability} `
    + 'work to an upstream, or choose a different server for this job.';
}

/**
 * THE SENTENCE FOR A BOARD WITH NO GPU SLOT ON IT — the one refusal that is
 * about the app's configuration rather than about any server.
 *
 * THREE SILENCES, TOLD APART, because they want three different things done. A
 * host that offered no registry (or could not be asked) already carries its own
 * sentence on {@link SlotRefusal}, and it is used verbatim rather than reworded —
 * a hosted window's person cannot open this app's Settings. Every enabled server
 * that resolved to an orchestrator with nothing behind it says so in the
 * resolver's own words, which name the machine and what to install on it.
 * Otherwise the list is genuinely empty and the fix is one screen away.
 */
function noEngineReason(refusal: SlotRefusal | null): string {
  if (refusal !== null) return refusal.sentence;
  const absent = enginelessServers();
  if (absent.length > 0) {
    return `${absent.map((server) => server.sentence).join(' ')} There is no other GPU engine `
      + 'connected — add one in Settings › Servers.';
  }
  return 'No GPU engine is connected — add one in Settings › Servers. Translation, '
    + 'simplification, cleanup, analysis and page reading all run on a Crucible now, including '
    + 'a Crucible on this machine.';
}

/**
 * One slot, asked whether it will start this act now.
 *
 * THE ONE KIND THAT NEEDS NO SERVER CLAIMS HERE. A cloud provider is one key: no
 * second lane and no route to read, so its lane is knowable without a request and
 * is taken before the placement is built. The Crucible path claims inside
 * `placeOnCrucible`, after the route is known — see `placeJob`'s note on where
 * the claim moved. (The local slot used to be the other such kind, and there is
 * no local slot.)
 */
async function placeOn(
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
): Promise<PlacementOutcome> {
  if (signal?.aborted) return transientWait('The request was cancelled.');
  if (slot.kind === 'cloud') {
    if (!claim(slot.name)) return transientWait(busyWithOurs(slot.name));
    return placeOnCloud(slot, capability);
  }
  const entry = crucibleServerNamed(slot.name);
  if (entry === null) {
    // TRANSIENT, on the same argument as a pinned slot that is switched off: the
    // registry moved under this walk, and re-registering is a gesture somebody
    // is about to make.
    return transientWait(`"${slot.name}" is no longer registered`);
  }
  try {
    return await placeOnCrucible(entry, slot, capability, say, claim, signal);
  } catch (err) {
    return interpretFailure(err, slot.name, capability);
  }
}

/**
 * OUR OWN RUN IS AS GOOD A REASON TO STEP PAST AS SOMEBODY ELSE'S, and it is the
 * one this app is authoritative about: a Crucible serving a passthrough chat does
 * not report itself busy, so the lane is the only thing standing between two of
 * our books and one card. The sentence names the app rather than the job, because
 * a person reading a parked row is looking at the bench, where the job that is in
 * the way already names itself.
 */
function busyWithOurs(lane: string): string {
  return `"${lane}" is already running a job of yours`;
}

/**
 * A WARMING LINE WITH THE ENGINE'S LOG TAIL TAKEN OFF, and the whole thing logged.
 *
 * ── What he was reading in a row four inches wide ───────────────────────────
 *
 * Owen, 2026-09-18: *"its putting logs in the gpu slot. they dont belong there,
 * they belong in the console, which is where they are. we can put human readable
 * logs where the logs are in the slot currently but they shouldnt be showing the
 * user the underlying technical stuff."* What the slot held was
 *
 *     Loading qwen3.5-9b on crucible@example-pc-wsl: vllm loading; 16s elapsed,
 *     886s before give-up — (APIServer pid=233320) INFO 09-18 01:29:35
 *     [kernel.py:369] Final IR op priority after setting platform defaults:
 *     IrOpPriorityConfig(rms_norm=['native'], fused_add_rms_norm=['native'])
 *
 * and early in a vLLM load the tail is not even a log line — it is the log
 * file's own header, which is the entire spawn command including the model path
 * and `--gpu-memory-utilization`.
 *
 * ── THE TAIL IS THE ENGINE'S AND IT IS NOT WRONG TO SEND ────────────────────
 *
 * Crucible's `warming_message` (crucible/engines/base.py) appends `log_tail(1)`
 * after an em dash, and that is genuinely what an operator wants when a load is
 * STUCK: the last thing the engine said before it stopped saying anything. So
 * nothing here is a defect in the engine, and nothing asks it to send less. WHERE
 * IT GOES is a display decision, and a display decision belongs on this side.
 *
 * The slot gets the sentence; the console gets the whole line, once per frame,
 * where a developer can read it and a person watching their queue cannot.
 *
 * ── SPLIT ON THE ENGINE'S OWN SEPARATOR, AND ONLY EVER ON THAT ──────────────
 *
 * ` — ` is the delimiter `warming_message` composes with, so it is the one
 * character sequence that reliably means "the sentence ended and the tail began".
 * A message WITHOUT one is passed through whole rather than trimmed at some
 * guessed length: no em dash means no tail, which means the sentence is all there
 * is, and shortening it would be this file inventing a truncation the engine
 * never asked for.
 *
 * ── IT IS BOOKFORGE'S FUNCTION, COPIED RATHER THAN APPROXIMATED ─────────────
 *
 * `warmingHeadline`, BookForgeApp electron/crucible/job.ts, committed there as
 * bdacf45a the same day and after the same complaint about ITS slots. The two
 * apps read the same frames off the same server, so the two answers have to be
 * the same answer — and the way that goes wrong is one of them growing a second
 * rule about where to cut. Copied whole, including the pass-through, on
 * `shared/records.ts`' grow-together rule: if Crucible's separator ever moves,
 * both move, in one commit.
 *
 * WARMING ONLY, which is BookForge's scope and not a narrowing of it. A
 * `progress` frame carries the SERVER's own fraction and message and has no
 * documented tail; splitting one on an em dash it was allowed to contain as
 * ordinary punctuation would cut a human sentence in half to solve a problem it
 * does not have.
 */
export function warmingHeadline(message: string): string {
  const cut = message.indexOf(' — ');
  if (cut < 0) return message;
  console.log(`[slots] warming: ${message}`);
  return message.slice(0, cut);
}

/**
 * A CLOUD PROVIDER — and it is the shortest placement in this module, because
 * almost everything the Crucible path does has no counterpart here.
 *
 * ── What is deliberately absent, each for its own reason ───────────────────
 *
 *   * NO CAPABILITY READ. A provider has no card to measure and no class rows;
 *     which models a key may use is `Test`'s question, asked once on a settings
 *     card rather than before every run.
 *   * NO RESIDENCY AND NO LEASE. Nothing is loaded and nothing can be evicted,
 *     so there is nothing to claim — `lease: null`, and the settle has nothing
 *     to release.
 *   * NO BUSY, AND THEREFORE NO `wait` ARM AT ALL. A provider's queue is
 *     somebody else's and its way of saying "later" is a 429, which the ENGINE
 *     waits out (docs/VLLM.md §2a: `retry-after` honoured, else 2 s doubling to
 *     30 s, six attempts, each wait logged). Parking the row here for a fact
 *     this app cannot observe would be a second waiter over one queue.
 *   * NO NETWORK CALL OF ANY KIND. This function does not check that the
 *     provider is reachable, on `interpretFailure`'s posture one door along: a
 *     reachability probe before every spawn would put a round trip in front of
 *     every row and still tell the run nothing it will not learn in its first
 *     request, with a better sentence.
 *
 * ── And the one refusal it does make ───────────────────────────────────────
 *
 * TEXT ACTS ONLY (docs/SLOTS.md §3). A `pages` job pinned to a provider is
 * refused BY NAME and not waited on, because it will be refused identically
 * every time: page reading is a VLM pass over rendered images through this app's
 * own reader or a Crucible, and no cloud text door in this build serves it.
 */
function placeOnCloud(slot: ComputeSlot, capability: CapabilityClass): PlacementOutcome {
  const entry = cloudProviderNamed(slot.name);
  if (entry === null) {
    return transientWait(`"${slot.name}" is no longer configured`);
  }
  if (capability === 'pages') {
    return {
      verdict: 'refuse',
      reason: `${entry.name} cannot read pages; page reading stays on this machine or a Crucible.`,
    };
  }
  return {
    verdict: 'go',
    placement: {
      slot,
      /*
       * OpenAI'S OWN API IS AN OpenAI-COMPATIBLE SERVER, so a provider of that
       * kind takes the door that already existed and Anthropic takes the dialect
       * of its own. The engine refuses an unknown `--server` value by name, so
       * this mapping is total by construction rather than by a default.
       */
      door: entry.kind === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: cloudEndpointOf(entry),
      /*
       * `--model` IS REQUIRED ON BOTH CLOUD DOORS and there is no default to
       * fall back on — a provider holds a catalog. The id is the one the person
       * typed on the card and `Test` proved against the provider's own listing;
       * nothing here second-guesses it, on `clampCloudModel`'s argument that a
       * table of hosted model names compiled into a build is wrong by the next
       * release.
       */
      model: entry.model,
      env: { FOUNDRY_ENDPOINT_HEADERS: cloudHeaderMapFor(entry) },
      lease: null,
      /*
       * A PROVIDER RATIONS BY AN ACCOUNT'S RATE LIMIT, not by a card, and nobody
       * has measured a number for one — so this states the same four the Crucible
       * chat door states (ruling 4) rather than letting the engine's twelve, which
       * was measured against a batching vLLM, decide for somebody's billing.
       */
      concurrency: CRUCIBLE_CHAT_CONCURRENCY,
      /*
       * NULL, AND THAT IS NOT THE SAME SHAPE AS AN UPSTREAM ROUTE. `via` says
       * "a Crucible forwarded this on the operator's account" and puts the run
       * in that server's `[cloud]` lane. This slot IS the provider — it has a
       * lane of its own and an app-held key, which is exactly what PHASE15 §5.3
       * deletes (Package L).
       */
      via: null,
    },
  };
}

async function placeOnCrucible(
  entry: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
): Promise<PlacementOutcome> {
  /*
   * ── THE ADDRESS IN THE REGISTRY MAY NOT BE THE ENGINE'S ───────────────────
   *
   * crucible docs/PHASE17-ORCHESTRATOR.md §6. A registered address can be an
   * ORCHESTRATOR — the Windows tray on `:7101`, which manages the WSL engine on
   * `:7100` and serves no job types of its own — and everything below this line
   * is engine work: the residency listing, the load, the lease, and the
   * `<url>/openai` door the spawn is pointed at. So the hop is followed ONCE,
   * here, and `engine` is what the rest of this function uses. It carries the
   * SAME TOKEN, which is the contract's own rule and the reason nothing else
   * about the entry changes.
   *
   * IT IS RESOLVED ONCE AND THE ADDRESS IS TAKEN FROM THE RESOLUTION, rather
   * than a client being fetched here and a url composed from `entry` further
   * down — that pairing is how a request goes to one process and a spawn is
   * pointed at another. `resolveEngine` caches, so `readCapability` below costs
   * no second round trip.
   */
  const engine = (await resolveEngine(entry)).entry;
  const client = clientFor(engine);

  /*
   * ── WHICH MODEL, WHICH IS THE SERVER'S ANSWER AND NOT A SETTING ───────────
   *
   * `GET /v1/capability` is a per-HOST fact: `crucible install` probes the card
   * and picks the largest candidate that fits, so a 24 GB box serves `translate`
   * with a 4-bit 27B, a bigger one serves it with something else, and a 12 GB
   * box does not serve it at all. A model id this app was configured with would
   * be a model that server may have refused — which is why there is no model
   * field on a registry entry and no picker showing one.
   */
  const record = await readCapability(entry);
  const row = record.classes.find((entry_) => entry_.capability === capability);
  if (row === undefined) {
    return {
      verdict: 'refuse',
      reason: `"${slot.name}" has no record for ${capability} work — its Crucible is older than this class.`,
    };
  }
  if (!row.enabled || row.selected.length === 0) {
    /*
     * `enabled: false` IS AN ANSWER AND NOT A FAULT — a server saying "this
     * machine cannot do that", with the number that decided it. So it is a WAIT
     * rather than a refusal: the same job on the next machine in the ranking is
     * a different question, and `any` steps past it. A pinned row holds with the
     * server's own reason on it, which is what SLOTS.md §6 asks for — *"disabled
     * → the row holds/skips with the reason"*.
     *
     * ── AND IT IS A **STANDING** WAIT, WHICH IS THE HALF THAT WAS WRONG ──────
     *
     * The walk above is right and is unchanged. What was wrong is what happened
     * afterwards: `placeRun` parked this for ever, so a row pinned to a machine
     * whose record says it cannot do this act never finished and never failed.
     * BookForge found it and named it — *"a row that neither fails nor finishes
     * is worse than either."* Nothing the queue does on a timer moves a card's
     * measurement; a person does, from that engine's own settings. See
     * {@link PlacementWait}.
     */
    const shortfall = row.shortfallBytes > 0
      ? ` (${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GiB short)`
      : '';
    return standingWait(
      `"${slot.name}" cannot ${capability}: ${row.reason || 'no model fits its card'}${shortfall}`,
    );
  }

  /*
   * ── AN UPSTREAM ROUTE: THE SAME DOOR, AND NOTHING ON THE CARD ─────────────
   *
   * PHASE15 §3.3 — the row says `route`, and `selected` is the model id an app
   * sends whether it is resident or not. §3.4 — a `model` with a slash is
   * FORWARDED by the server on the operator's account, *"no lease, no lane, the
   * settlement untouched (nothing was on the card)"*, and a lease or a
   * `load-model` naming one is refused `lease_not_needed`. Owen, the same day:
   * *"one contract, one SDK, one API, one communication method."*
   *
   * So the three things the local path does BELOW are all skipped, each because
   * it would be a request about a model that is not on anybody's card:
   *
   *   * NO `models()` — `GET /v1/openai/models` lists a routed upstream model,
   *     but `client.models()` is the RESIDENCY listing and an upstream model is
   *     never in it. Checking would refuse a working server by name.
   *   * NO `loadModel` — refused `lease_not_needed`'s sibling, and there is
   *     nothing to warm.
   *   * NO `takeLease` — refused by name, and there is nothing to protect: a
   *     load on that server cannot evict a model it never loaded.
   *
   * WHAT IS IDENTICAL IS THE SEAM. The same `/openai` endpoint, the same header
   * map with `X-Crucible-Act` still naming the act (so `/v1/activity` says
   * "translating on anthropic", §3.4), the same door. That is the whole point of
   * the phase: the app does not know or care where the answer came from.
   *
   * AND THE LANE IS THE SERVER'S `[cloud]` ONE, claimed here — the first moment
   * anything in this process knows which of the slot's two lanes this run wants.
   */
  const via = upstreamOf(row);
  if (via !== null) {
    const lane = upstreamLaneName(slot.name);
    if (!claim(lane)) {
      return transientWait(
        `"${slot.name}" is already forwarding as many jobs of yours to ${via} as it will at once`,
      );
    }
    say(`Sending ${capability} to ${slot.name} via ${via} (${row.selected})`);
    return {
      verdict: 'go',
      placement: {
        slot,
        lease: null,
        via,
        door: 'openai',
        /*
         * The depth this app keeps against a door it does not own. The SERVER's
         * own admission limit when it states one, four when it does not — an
         * upstream rations by an account's rate limit rather than by a card, so
         * a forwarding Crucible usually states nothing and four stands (ruling
         * 4). `chatDepthFor` carries the argument and says which happened.
         */
        concurrency: await chatDepthFor(engine, capability, say),
        // THE ENGINE'S ADDRESS, not the registered one — see the hop at the top
        // of this function. A `<orchestrator>/openai` would be a spawn pointed
        // at a process with no route to serve it.
        endpoint: `${engine.url}/openai`,
        model: row.selected,
        env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(engine, capability) },
      },
    };
  }

  /*
   * THE CARD LANE, TAKEN BEFORE A MODEL IS LOADED ONTO IT. Below this line
   * everything is about a machine's GPU — the residency, the eviction, the lease
   * — and none of it may be done on a card another run of ours is holding.
   */
  if (!claim(slot.name)) {
    return transientWait(busyWithOurs(slot.name));
  }

  /*
   * ── RESIDENCY: WE LOAD, AND WE NEVER UNLOAD — WITH ONE EXCEPTION ──────────
   *
   * One model is resident at a time and a load EVICTS whatever was there. That
   * is the server's design and it is the reason nothing here ever calls
   * `unloadModel` on a model it did not put there: the card belongs to whoever
   * is next, and a client that tidied up after itself would be taking a model
   * away from the run that evicted ours a minute after it started.
   *
   * THE EXCEPTION IS A LOAD OF OUR OWN THAT NOBODY WILL USE — see
   * {@link releaseAbandonedLoad}. Loading for a run that has been cancelled is
   * not somebody else's model; it is ours, resident because this placement asked
   * for it, and leaving it there is the 21 GB nobody is holding.
   */
  const models = await client.models();
  signal?.throwIfAborted();
  const resident = models.find((model) => model.id === row.selected);
  if (resident === undefined) {
    return {
      verdict: 'refuse',
      reason: `"${slot.name}" selected ${row.selected} for ${capability} work and then did not list it. `
        + 'That is its own record disagreeing with itself; nothing here can fix it.',
    };
  }

  /*
   * WHAT THIS PLACEMENT PUT ON THE CARD, if anything. Null until `load-model`
   * has been submitted, because before that there is nothing this run is
   * answerable for; non-null from the moment the server answers with a job id,
   * because from that moment a model may land whether we are still here or not.
   */
  let ourLoad: SubmittedLoad | null = null;
  try {
    if (!resident.resident) {
      say(`Loading ${row.selected} on ${slot.name}…`);
      const jobId = await client.loadModel(row.selected);
      const load: SubmittedLoad = { jobId, cancelled: null };
      ourLoad = load;
      /*
       * THE CANCEL IS KEPT, NOT DROPPED. It used to be `void client.cancel(…)`
       * — a DELETE fired into the dark, whose answer (`cancelled` or
       * `cancelling`) is the very fact the cleanup below has to know. Recording
       * the promise costs nothing and is the difference between "we asked" and
       * "we know". `??=` because a re-entry would be a second DELETE for one
       * gesture.
       */
      const cancelLoad = (): void => {
        load.cancelled ??= client.cancel(jobId).then(() => undefined).catch((err: unknown) => {
          console.error(`[slots] cancelling the load on ${entry.name} failed: ${String(err)}`);
        });
      };
      signal?.addEventListener('abort', cancelLoad, { once: true });
      if (signal?.aborted) cancelLoad();
      try {
        for await (const event of client.events(jobId)) {
          if (event.event === 'warming') say(`Loading ${row.selected} on ${slot.name}: ${warmingHeadline(event.data.message)}`);
          else if (event.event === 'progress') say(`Loading ${row.selected} on ${slot.name}: ${event.data.message}`);
          else if (event.event === 'failed') {
            const code = event.data.error.code;
            /*
             * A LOAD THAT FAILED AFTER IT WAS ADMITTED. The codes that mean "this
             * machine, right now" travel to the next server; anything else is about
             * the model and would fail the same way everywhere.
             *
             * NOTHING TO RELEASE: a `load-model` that ends `failed` did not make
             * the model resident, and the engine process it was starting is the
             * load job's own to take down. The cleanup below is for the one
             * terminal state that leaves something behind, which is `done`.
             */
            return isServerSpecificRefusal(code)
              ? transientWait(`"${slot.name}" could not load ${row.selected}: ${event.data.error.message}`)
              : { verdict: 'refuse', reason: `"${slot.name}" could not load ${row.selected}: ${event.data.error.message}` };
          } else if (event.event === 'cancelled') {
            return transientWait(`the load of ${row.selected} on "${slot.name}" was cancelled`);
          }
        }
      } finally {
        signal?.removeEventListener('abort', cancelLoad);
      }
    }

    /*
     * ── AND THE LEASE, WHICH IS THE LAST THING BEFORE THE SPAWN ───────────────
     *
     * It is taken HERE — after the model is resident, before the engine exists —
     * because those are the two things that make a lease meaningful: there is
     * something on the card to claim, and nothing has started depending on it yet.
     * A lease taken before the load would be a claim on a model that is not there
     * (the server says so by name: `model_not_resident`), and one taken after the
     * spawn would leave a window in which another client's load evicts the model
     * this run is three blocks into using.
     */
    signal?.throwIfAborted();
    const lease = await takeLease(engine, row.selected, capability);

    return {
      verdict: 'go',
      placement: {
        slot,
        lease,
        /*
         * HOW DEEP TO GO ON THIS CARD — the server's number when it states one, and
         * four when it does not. See `Placement.concurrency`, which carries the whole
         * argument and the night it is about, and `chatDepthFor`, which asks.
         *
         * A READING STATES NONE HERE: `--vlm-concurrency` is the page reader's own
         * flag and the engine takes it from the server that serves the pages, so a
         * chat depth on a `pages` placement would be a number about the wrong door.
         */
        concurrency: await chatDepthFor(engine, capability, say),
        /*
         * `openai` IS THE ENGINE'S DEFAULT AND IS LEFT UNSPELLED on the command
         * line — see `doorArgs` in job-queue.ts. It is named here anyway, because a
         * placement that said nothing about the dialect would be a placement whose
         * reader had to know the default.
         */
        door: 'openai',
        /*
         * THE OPENAI DOOR IS MOUNTED AT `<url>/openai`, and the engine appends
         * `/v1` itself. Composed here rather than stored on the entry: the entry's
         * URL is the address a person pasted, which after PHASE17 may be the
         * ORCHESTRATOR's, and a stored `/openai` would be this app's routing
         * decision written into somebody's settings file. `engine.url` is the
         * resolved one — see the hop at the top of this function.
         */
        endpoint: `${engine.url}/openai`,
        model: row.selected,
        env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(engine, capability) },
        /** A resident model on that machine's card. Nothing was forwarded. */
        via: null,
      },
    };
  } catch (err) {
    /*
     * ── A CANCELLED PLACEMENT OWNS WHAT ITS OWN LOAD LEFT ON THE CARD ───────
     *
     * Every throw out of the block above lands here, and exactly one shape of
     * throw has a card to answer for: the run was STOPPED while this function
     * was waiting on a `load-model` of its own. `releaseAbandonedLoad` says what
     * is done about it and why; everything else — an unreachable server, a
     * refused lease, a protocol error — rethrows untouched into
     * `interpretFailure`, which is the one place that turns a throw on this path
     * into a verdict.
     *
     * THE RETHROW IS UNCONDITIONAL. The cleanup is tidying, not an outcome: a
     * placement that was cancelled is cancelled whether the card came back or
     * not, and swallowing the abort here would hand the queue a placement for a
     * row that has already settled.
     */
    if (ourLoad !== null && signal?.aborted === true) {
      await releaseAbandonedLoad(engine, client, ourLoad, row.selected, capability, slot.name);
    }
    throw err;
  }
}

/**
 * A `load-model` THIS PLACEMENT SUBMITTED, and the cancel it has already sent.
 *
 * `cancelled` is the DELETE's own promise rather than a boolean, because the
 * only useful thing about the cancel is its ANSWER — `cancelled` (the job never
 * ran) or `cancelling` (it is running and will stop at a checkpoint) — and a
 * fire-and-forget DELETE cannot tell the two apart. Null means no cancel has
 * been sent yet.
 */
interface SubmittedLoad {
  readonly jobId: string;
  cancelled: Promise<void> | null;
}

/**
 * HOW LONG THE TIDYING MAY TAKE, in milliseconds.
 *
 * A Stop must be a Stop. This cleanup is three round trips to a machine that may
 * be mid-eviction, and a person who pressed the button is watching the row; so
 * the whole of it runs under one deadline and a deadline that fires is a LOG
 * LINE naming the model and the server, not a hang and not a failure. Thirty
 * seconds is generous for three HTTP calls and short enough that nobody wonders
 * whether the button worked.
 */
const ABANDONED_LOAD_CLEANUP_MS = 30_000;

/**
 * GIVE BACK WHAT A CANCELLED PLACEMENT LEFT ON THE CARD.
 *
 * ── The night this is about (2026-09-20) ──────────────────────────────────
 *
 * A reading was placed on a Crucible, `load-model qwen3.5-9b` went out, and the
 * load read *"vllm loading; 50s elapsed"* while Owen pressed Stop. The load
 * COMPLETED in the same second the abort fired. What this function replaced did
 * three things and all three were right-looking: it fired `DELETE /v1/jobs/{id}`
 * without waiting for the answer, it never asked how the load had actually
 * ended, and it threw out of the placement before `takeLease`. The DELETE landed
 * on a job that was already `done` — a no-op — and the placement walked away
 * from a 21 GB model that was now resident with `claim: None, lease: None,
 * chat.in_flight: 0, running: []`. Nothing was holding it and nothing ever
 * would: Crucible's settlement is triggered by a HOLDER LETTING GO, and a load's
 * own completion is deliberately not one (`crucible/settle.py`: *"a load is not
 * a holder letting go"*). It sat there until it was unloaded by hand.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * **A placement that is cancelled after it submitted a load is responsible for
 * what that load put on the card.** Not the server — it did exactly what it was
 * asked — and not the next run, which may be on another machine or may never
 * come. So:
 *
 *   1. **Await the cancel's answer.** `cancelling` and `cancelled` are different
 *      news and a DELETE nobody reads is a question nobody asked.
 *   2. **Read the load's terminal state** (`GET /v1/jobs/{id}`). `cancelled` or
 *      `failed` means nothing landed and there is nothing to give back; `done`
 *      means the model is resident because we asked for it.
 *   3. **Release it, by being a holder that lets go.** A lease taken and
 *      released immediately is the settlement's own trigger, it is the two verbs
 *      this file already owns, and it is correct even if somebody else's run
 *      arrived in between — the lease would be refused and the card is theirs.
 *      `unload-model` is the FALLBACK, for a server that refuses the lease for a
 *      reason that is not another client (`model_not_resident`: it has already
 *      gone, and the unload says so by name and costs nothing).
 *
 * ── And it never hangs and never fails ────────────────────────────────────
 *
 * The whole of it is under {@link ABANDONED_LOAD_CLEANUP_MS} and it returns
 * normally whatever happens. A Stop that waited on a tidy-up would be a Stop
 * that did not stop, and a throw here would replace the row's real ending
 * (cancelled) with a story about housekeeping. What a failure gets is a log line
 * that NAMES THE MODEL AND THE SERVER, so the startup sweep — or a person with
 * `crucible unload-model` — has something to act on.
 *
 * `boundMs` IS A PARAMETER WITH THE CONSTANT AS ITS DEFAULT for exactly one
 * reason: the keeper that proves the deadline drives a server which never
 * answers, and a thirty-second test is a thirty-second test on every run of the
 * suite. Nothing in the app passes it.
 *
 * `entry` IS THE ENGINE-ADDRESSED ENTRY and `client` is the client
 * `placeOnCrucible` already built from it — the same process that took the load
 * must be the one that gives it back, and resolving again is a second chance for
 * them to differ (the same argument {@link takeLease} makes).
 */
export async function releaseAbandonedLoad(
  entry: CrucibleServerEntry,
  client: CrucibleClient,
  load: SubmittedLoad,
  model: string,
  capability: CapabilityClass,
  slotName: string,
  boundMs: number = ABANDONED_LOAD_CLEANUP_MS,
): Promise<void> {
  const where = `${model} on "${slotName}"`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`the cleanup did not finish within ${boundMs}ms`)); }, boundMs);
    timer.unref?.();
  });
  try {
    await Promise.race([tidy(), deadline]);
  } catch (err) {
    /*
     * THE ONE SENTENCE A PERSON OR A SWEEP CAN ACT ON. It names the model and
     * the machine because the next question after "did the Stop work" is "what
     * is on that card", and an apology with neither in it answers nothing.
     */
    console.error(
      `[slots] cancelled placement: the load of ${where} may still be resident and this app `
      + `could not give it back — ${err instanceof Error ? err.message : String(err)}. `
      + `Unload it there (\`crucible unload-model ${model}\`) if the card is still held.`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  async function tidy(): Promise<void> {
    /*
     * The cancel may not have been sent at all: the abort can fire between the
     * load's `done` frame and `throwIfAborted`, which is the exact second Owen's
     * Stop landed in. Sending one now costs a DELETE on a finished job and buys
     * the same answer the abort path gets.
     */
    load.cancelled ??= client.cancel(load.jobId).then(() => undefined).catch((err: unknown) => {
      console.error(`[slots] cancelling the load on ${entry.name} failed: ${String(err)}`);
    });
    await load.cancelled;

    const status = await client.job(load.jobId);
    if (status.status !== 'done') {
      console.log(
        `[slots] cancelled placement: the load of ${where} ended ${status.status}; nothing is resident.`,
      );
      return;
    }

    try {
      const lease = await takeLease(entry, model, capability);
      await lease.release();
      console.log(`[slots] cancelled placement: the load of ${where} had landed; released it.`);
      return;
    } catch (err) {
      /*
       * A REFUSED LEASE IS NOT A FAILED CLEANUP. `leased` means another client
       * got there first and the card is honestly theirs — but the unload below
       * will be refused by the same server for the same reason, which is the
       * right answer arriving from the machine that owns the fact rather than
       * from a guess here.
       */
      console.error(
        `[slots] cancelled placement: the load of ${where} had landed and a lease to release it was `
        + `refused (${err instanceof Error ? err.message : String(err)}); unloading it instead.`,
      );
    }

    const unloadId = await client.unloadModel(model);
    for await (const event of client.events(unloadId)) {
      if (event.event === 'failed') {
        console.error(
          `[slots] cancelled placement: unloading ${where} failed: ${event.data.error.message}`,
        );
        return;
      }
      if (event.event === 'cancelled') {
        console.error(`[slots] cancelled placement: the unload of ${where} was itself cancelled.`);
        return;
      }
    }
    console.log(`[slots] cancelled placement: the load of ${where} had landed; unloaded it.`);
  }
}

/**
 * THE UPSTREAM A ROW IS ROUTED TO, or null for a model on the server's own card.
 *
 * TWO FACTS AGREE AND EITHER WOULD DO, which is why this is one function rather
 * than a test written at each of the three places that asks. PHASE15 §1: an
 * upstream model id is `<upstream>/<model>` and *"a local model id never contains
 * `/`"* (checked at manifest load, `manifest_model_id_slash`). §3.3: the row also
 * says `route` outright.
 *
 * THE SLASH IS WHAT IS READ, and `route` is the guard. A pre-PHASE15 server — the
 * one on Owen's desk today — sends no `route` at all and `readCapability` reads
 * that absence as `local`, so a row from it can never take this path however its
 * `selected` is spelled. A PHASE15 server that said `upstream` and then selected
 * something with no slash has contradicted itself, and the honest answer to that
 * is the LOCAL path, which will refuse by name against the residency listing
 * rather than composing an upstream name out of half a string.
 */
function upstreamOf(row: CapabilityRow): string | null {
  if (row.route !== 'upstream') return null;
  const cut = row.selected.indexOf('/');
  return cut > 0 ? row.selected.slice(0, cut) : null;
}

/**
 * The header map for one spawn, as the JSON the engine reads.
 *
 * `X-Crucible-Act` is required on OUR side by Owen's naming ruling and is one of
 * the five class words. The engine neither writes it nor knows about it: to the
 * engine this is an opaque map of headers to send, and the word for anybody's
 * product does not appear anywhere in `src/`.
 *
 * NEVER LOGGED, and the return value is the reason this function is small and
 * has one caller: the string it produces is a credential, and the only thing
 * that is ever done with it is putting it in a child's environment.
 */
function headerMapFor(entry: CrucibleServerEntry, capability: CapabilityClass): string {
  return JSON.stringify({
    Authorization: `Bearer ${entry.token}`,
    'X-Crucible-Api': '1',
    'X-Crucible-Act': capability,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The lease — RULED 2026-09-14, and the thing that keeps a book's model on the
// card for the length of the book
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CLAIM ON THE RESIDENT MODEL, held while this run is alive.
 *
 * ── The hazard it closes, stated once ─────────────────────────────────────
 *
 * docs/SLOTS.md §5: one model is resident at a time and a load EVICTS. A chat
 * holds no lane — a second client can load its own model while our engine is
 * mid-book, and the next block comes back `model_not_resident` from a server
 * that is doing exactly what it was asked. Nothing about that is anybody's bug,
 * and nothing short of an explicit claim prevents it. BookForge proposed the
 * lease and Owen ruled it in: while one is open, `load-model`, `unload-model`
 * and `load-voice` refuse `409 leased` naming the client, the act and since
 * when. (The code was `model_leased` when the ruling was written; Crucible
 * renamed it on 2026-09-14 because the leased thing is a voice or an aligner as
 * often as a model — see `interpretFailure`'s branch, which read the old word
 * for a month and therefore read nothing.)
 *
 * ── Liveness only, which is why the TTL is short and the heartbeat exists ──
 *
 * The TTL is not how long the job will take; it is how long the server should
 * keep believing in a client it cannot see. This app crashes, a laptop sleeps, a
 * network goes — and a lease with no expiry would leave a card claimed by a
 * process that no longer exists, unbreakable except by restarting somebody
 * else's server. So the TTL is two minutes, the heartbeat is every forty
 * seconds, and a run this app loses track of frees the card within two minutes
 * without anybody doing anything.
 *
 * ── Releasing is not optional and is not best-effort ──────────────────────
 *
 * `release()` is called from the queue's SETTLE — the one place in
 * electron/job-queue.ts that every ending passes through, success, failure and
 * cancel alike. It is idempotent, it stops the heartbeat first, and it swallows
 * its own failure after logging: a lease that cannot be released expires, and
 * failing a finished job because the tidying failed would be reporting a loss
 * that did not happen.
 */
export interface Lease {
  /** The server's id for it, for the log line and for the two routes. */
  readonly id: string;
  /** Stop the heartbeat and give the card back. Idempotent; never throws. */
  release(): Promise<void>;
}

/**
 * How long the server keeps believing in us without hearing from us. Liveness,
 * not duration — see {@link Lease}.
 */
const LEASE_TTL_SECONDS = 120;

/**
 * The heartbeat interval: a third of the TTL, so two may be lost in a row before
 * the lease expires. A half would mean one dropped packet and a lost card.
 */
const LEASE_HEARTBEAT_MS = (LEASE_TTL_SECONDS / 3) * 1000;

/**
 * Take the lease, and arm the heartbeat that keeps it.
 *
 * THE THREE ROUTES ARE THE SDK'S. They were hand-rolled here while the lease
 * was landing in Crucible and `@crucible/client` had no verb for it, under a
 * standing note to switch the moment the tarball carried them; 0.6.0 (packed
 * from crucible `762484f`) carries `lease()`, `heartbeat()` and `release()`,
 * and this is them. What went with the switch is the `lease_id` read and its
 * `lease_unreadable` guard — a receipt without an id is a
 * `CrucibleProtocolError` from the SDK now, which is the same refusal under the
 * name the contract owns.
 *
 * A REFUSAL HERE PROPAGATES AS A THROW and is read by `interpretFailure` like
 * every other one on this path — which is what makes `leased` a WAIT (the
 * card is somebody else's for now, and another server's may be free) rather than
 * a failure. The load above has already made the model resident, so
 * `model_not_resident` from this route is the narrow race where somebody evicted
 * it between the two calls; it is server-specific, so it waits, and the next
 * pass loads again.
 */
/*
 * `entry` HERE IS THE ENGINE-ADDRESSED ONE, resolved by `placeOnCrucible` — a
 * lease is a claim on a CARD and an orchestrator has none (PHASE17 §1). Taking
 * one from the resolver rather than resolving again is deliberate: the lease and
 * the load must be on the same process, and two resolutions is two chances for
 * them not to be.
 */
export async function takeLease(
  entry: CrucibleServerEntry,
  model: string,
  capability: CapabilityClass,
): Promise<Lease> {
  const client = clientFor(entry);
  const acquire = async (): Promise<string> => (
    await client.lease(model, { act: capability, ttlSeconds: LEASE_TTL_SECONDS })
  ).leaseId;
  let id = await acquire();
  let stopped = false;
  let beating = false;
  const releaseId = async (leaseId: string): Promise<void> => {
    try {
      await client.release(leaseId);
    } catch (err) {
      if (err instanceof CrucibleRefused && err.code === 'unknown_lease') return;
      console.error(
        `[slots] the lease on ${model} at ${entry.name} could not be released `
        + `(it expires in ${LEASE_TTL_SECONDS}s): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const timer = setInterval(() => {
    // A slow heartbeat must not start multiple concurrent replacement leases.
    if (stopped || beating) return;
    beating = true;
    void client.heartbeat(id)
      .catch(async (err: unknown) => {
        /*
         * THE SERVER FORGOT THE LEASE, which is what a restart does: leases are
         * in memory there, so `unknown_lease` on a heartbeat means the card is
         * unprotected NOW while the engine is mid-book. The right answer is not
         * a log line but a new lease on the same model — the model is still
         * resident (a restart that lost it would be answering the engine
         * `model_not_resident` already, which the engine refuses by name) and
         * this run still intends every request it has left.
         *
         * ── AND A RE-LEASE THAT IS REFUSED IS THE END OF THE BEAT ───────────
         *
         * It used to fall through to the log below and keep beating, which is
         * what the "a lost heartbeat is not a lost run" paragraph says to do with
         * a BLIP. This is not a blip, and the difference is the whole of the fix:
         * once the server has answered `unknown_lease`, `id` names nothing on
         * that machine. Every further beat can only 404, and the re-lease behind
         * it can only be refused for the same reason it was refused the first
         * time. Measured 2026-09-18: 264 × (404 heartbeat → 409 `not_resident`
         * re-lease) at a flat 40.0 s cadence for ten hours, on a run whose lease
         * this app had itself released hours earlier. No backoff, no give-up, and
         * nothing in the log file to find it by.
         *
         * THE RESTART THIS BRANCH ASSUMES IS DISTINGUISHABLE, which is why the
         * re-lease is the test rather than the diagnosis: a server that really
         * did restart with the model still resident ACCEPTS the new lease, and
         * that is the one outcome the timer survives. Anything else — the model
         * is gone (`not_resident`), somebody else took it (`leased`), the machine
         * is unreachable — means the claim is not coming back, and a timer that
         * goes on asking for it is a loop with no exit.
         *
         * ONCE, NEVER A RETRY. The acquire is attempted once per `unknown_lease`
         * and its refusal ends the lease object rather than arming the next
         * identical attempt. A SECOND `unknown_lease` after a re-lease that
         * SUCCEEDED may acquire again, and that is not the loop: each success is
         * protection genuinely regained, and refusing to take it back would be
         * this app declining a card that is free.
         *
         * `stopped` IS SET, NOT JUST THE TIMER CLEARED. This lease object holds
         * nothing now — the server forgot the old id and refused a new one — so
         * there is no card to give back and `release()` from the queue's settle
         * is honestly a no-op. Setting it is also what stops a beat already in
         * flight from arming another.
         */
        if (err instanceof CrucibleRefused && err.code === 'unknown_lease' && !stopped) {
          try {
            const replacement = await acquire();
            // Cancellation may have released the old id while acquire awaited.
            // The new receipt belongs to this run too, even after it has ended.
            if (stopped) {
              await releaseId(replacement);
              return;
            }
            id = replacement;
            console.error(
              `[slots] ${entry.name} had forgotten the lease on ${model} (restarted?); took a new one`,
            );
            return;
          } catch (again) {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            /*
             * ONE LINE, AND IT SAYS WHAT THE RUN HAS LOST. The comment above has
             * promised "unprotected and said so" since the lease landed; what was
             * actually printed was a heartbeat-failed line that reads like a blip
             * and repeated every forty seconds. This says the claim is gone, that
             * nothing will take it back, and what the server's own refusal was —
             * so an eviction later in the book has a cause somebody can find.
             */
            console.error(
              `[slots] ${entry.name} had forgotten the lease on ${model} and refused a new one, `
              + 'so this run is now UNPROTECTED — another client may load over it at any point. '
              + 'The heartbeat has stopped; a lease that cannot be re-taken is not coming back. '
              + `The server said: ${again instanceof Error ? again.message : String(again)}`,
            );
            return;
          }
        }
        /*
         * A LOST HEARTBEAT IS NOT A LOST RUN AND MUST NOT STOP ONE. The engine is
         * talking to the same server over its own socket and is the thing that
         * would actually notice a problem; a heartbeat that fails while the run
         * is fine is a blip, and two more will be sent before the TTL is up. What
         * it is not is silent: the console names it so that an eviction later in
         * the book has a visible cause rather than looking like the server
         * misbehaving.
         */
        console.error(
          `[slots] the lease heartbeat for ${model} on ${entry.name} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => { beating = false; });
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    get id(): string { return id; },
    async release(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await releaseId(id);
    },
  };
}

/**
 * ONE THROW, READ AS ONE OF THE THREE VERDICTS.
 *
 * Every branch keeps the server's or the SDK's own words. They name what to fix
 * — "busy: bookforge, tts qwen3.5-9b 62% done", "crucible at http://… is
 * unreachable" — and a word of ours in place of one of those is how a fixable
 * problem becomes an unfixable one.
 */
/**
 * WHERE AN UPSTREAM IS CONFIGURED, spelled once so this file and act-gates.ts
 * send a person to the same place. The keys live in the ENGINE now (PHASE15 §0:
 * *"settings live in the engine and nowhere else"*), and Foundry's card is a
 * window onto that server's settings document (§5.2).
 */
const UPSTREAM_SETTINGS = 'Open Settings › Servers and its "Where the text work runs" card';

function interpretFailure(err: unknown, slotName: string, capability: CapabilityClass): PlacementOutcome {
  if (err instanceof CrucibleOrchestratorError) {
    /*
     * PHASE17 §6's two, and both are STANDING. An orchestrator with no engine
     * has nothing to install its way out of on a timer, and a chained pair is a
     * misconfiguration nobody's queue can unpick; each is a thing a PERSON fixes
     * on that machine, and the SDK-adjacent sentence already says which. Still a
     * WAIT for the walk, because the next machine in the ranking is a different
     * question — see {@link PlacementWait}.
     */
    return standingWait(`"${slotName}": ${err.message}`);
  }
  if (err instanceof CrucibleUnreachable) {
    return transientWait(`"${slotName}" is unreachable`);
  }
  if (err instanceof CrucibleBusy) {
    /*
     * 409 `server_busy`. The SDK renders the one sentence a person reads, and it
     * says WHO — `holder` is the busy job's recorded User-Agent, and null means
     * the client did not say, which the SDK renders as "an unnamed client"
     * rather than a guess. That is the rule the server itself keeps: a bench
     * must never be confidently wrong about whose render is on the card.
     */
    return transientWait(`"${slotName}" is ${err.busyLine}`);
  }
  if (err instanceof CrucibleRefused) {
    if (err.code === 'engine_in_use') {
      /*
       * 409 `engine_in_use`: a STREAMING session holds the resident engine
       * without occupying the lane at all, which is the state a bench used to
       * read as an idle machine while the browser extension was reading from it.
       * On a load it means, in plain words, that somebody is narrating there.
       */
      return transientWait(`someone is narrating on "${slotName}"`);
    }
    if (err instanceof CrucibleLeased) {
      /*
       * 409 `leased`: another client has claimed the resident thing for the
       * length of its own run, which is the protection this app takes for itself
       * three functions up.
       *
       * ── IT USED TO KEY ON `model_leased`, WHICH NOTHING EMITS ──────────────
       *
       * Crucible renamed the code on 2026-09-14 and said why in the function that
       * raises it (`leased_error`, crucible/leases.py): *"the leased thing is a
       * voice or an aligner as often as a model, and a client branching on
       * `model_leased` while narrator holds the card would be branching on a word
       * that is not true of what it was refused for."* `model_leased` survives in
       * Crucible only inside that sentence. So this branch had been dead since the
       * day it was written, and a real refusal fell through to the generic arm at
       * the bottom — which waited, but by luck: `leased` happens to be in the
       * SDK's server-specific set, and nothing here was reading the body at all.
       *
       * THE SDK OWNS THE PARSE AND THE SENTENCE, which is the other half of the
       * repair. The hand-rolled read of `err.details` was three `typeof` checks
       * over a `Record<string, unknown>` that quietly rendered "another client"
       * for a malformed body; `CrucibleLeased` refuses such a body as a protocol
       * error instead, and `leasedLine` is the one line a bench puts in front of
       * a person — exactly as `CrucibleBusy.busyLine` is, one branch up. Who,
       * for what, and until when, in the server's own words.
       *
       * THE KIND IS SAID BESIDE IT because it is the fact the rename was about
       * and the one `leasedLine` does not carry: a refusal arrives with no
       * `resident` beside it, and "the resident llm is held" and "the resident
       * tts is held" are different news to somebody reading the queue.
       */
      return transientWait(`the resident ${err.kind} on "${slotName}" is ${err.leasedLine}`);
    }
    /*
     * ── THE THREE PHASE15 REFUSALS, BY NAME (crucible §3.4) ─────────────────
     *
     * They arrive on the PLACEMENT path only through a capability read or a
     * lease; the CHAT itself is the engine's socket, and an upstream refusal
     * mid-book is the engine's own sentence on the row. Named here anyway,
     * because the day a settings write or a probe raises one, "refused translate
     * work: …" would be this app shrugging at a fact it has a word for.
     */
    if (err.code === 'upstream_unconfigured') {
      /*
       * 409. The route names an upstream the server has no key or url for —
       * §3.2 promises that cannot be STORED, so reaching it means the operator
       * removed the key after the route was set, or the config was hand-edited.
       *
       * A **STANDING** WAIT, AND IT USED TO BE A FLAT REFUSAL. The refusal had
       * the right ending and the wrong scope: every attempt on THAT server says
       * the same thing until somebody opens its settings, which is exactly what
       * standing means — but a flat `refuse` stopped the WALK, so an `any` row
       * failed on the first machine with a missing key while the second machine
       * sat there able to do the work. Standing keeps the ending for a pinned
       * row (and for a walk where every machine says this) and gives `any` the
       * step-past it should always have had.
       */
      return standingWait(
        `"${slotName}" routes ${capability} to an upstream it has no credential for: `
        + err.serverMessage,
      );
    }
    if (err.code === 'upstream_rejected' || err.code === 'upstream_unreachable') {
      /*
       * 502 either way. The upstream refused the operator's key, or could not be
       * reached from that machine — both are facts about THAT SERVER'S network
       * and account, so the same job on the next machine in the ranking is a
       * different question and `any` steps past it. The upstream's own words are
       * kept verbatim: they name what to fix, and a word of ours in their place
       * is how a fixable problem becomes an unfixable one.
       */
      // TRANSIENT, exactly as built: a network and an account both come back.
      return transientWait(`"${slotName}" could not reach its upstream: ${err.serverMessage}`);
    }
    if (err.code === 'lease_not_needed') {
      /*
       * §3.4: *"an upstream model is never resident; send the chat."* Nothing
       * should ever reach this — `placeOnCrucible` reads the route first and the
       * upstream path takes no lease at all. So it is OUR BUG, said out loud on
       * the row rather than dressed as a server problem, and refused rather than
       * retried because retrying a dispatcher defect would hide it behind a
       * backoff.
       */
      return {
        verdict: 'refuse',
        reason: `Foundry tried to lease an upstream model on "${slotName}", which is never resident `
          + `— that is a defect in this app's dispatcher, not a fault on that server. ${err.serverMessage}`,
      };
    }
    if (err.code === 'model_not_resident') {
      /*
       * On the CHAT door this is the end of a run — the engine refuses by name
       * and never spins. Reaching it HERE, from a load, is the other half of
       * SLOTS.md §5's pair: the model is not resident and the engine will not be
       * given up, because a stream is holding it. Waited on, not failed.
       */
      return transientWait(`"${slotName}" is holding a different model for someone else`);
    }
    /*
     * `isServerSpecificRefusal` IS THE SDK'S AND STAYS THE ARBITER, and every
     * code it calls server-specific is about a machine's state RIGHT NOW — which
     * is the transient half by definition. The standing ones are named above,
     * one branch each, because "only a person can change this" is a judgement
     * about a code and not something a list of server-specific names encodes.
     */
    return isServerSpecificRefusal(err.code)
      ? transientWait(`"${slotName}" refused ${capability} work: ${err.serverMessage}`)
      : { verdict: 'refuse', reason: `"${slotName}" refused ${capability} work: ${err.serverMessage}` };
  }
  if (err instanceof CrucibleCapabilityUndecided) {
    /*
     * 503 `capability_undecided` — nothing has probed that card yet. ABSENT AND
     * "NOTHING FIT" ARE OPPOSITE NEWS and are rendered as opposites: this one
     * names the command that decides it, where a disabled class names the
     * shortfall. It waits, because running `crucible capability --write` there is
     * a thing somebody can go and do.
     *
     * TRANSIENT, and deliberately so even though a person is involved: a server
     * that has not measured its card YET is one that will — `crucible install`
     * and the operator console both write the record, and the machine is
     * otherwise working. Reading it as standing would fail a row on a server
     * that is minutes from being able to run it.
     */
    return transientWait(
      `"${slotName}" has not measured its card yet — run \`crucible capability --write\` there`,
    );
  }
  if (err instanceof CrucibleProtocolError) {
    /*
     * THE SERVER ANSWERED AND THE DOCUMENT IS WRONG — which, on this path, is
     * `capability_route_missing` or `capability_route_unknown` out of the SDK's
     * own reader (crucible PHASE15-HOST.md §3.3; the two codes are in the
     * detail, which is why the sentence carries it verbatim).
     *
     * REFUSED BY NAME, not waited on, and that is the behaviour this app had
     * when it raised the two codes itself as `CrucibleRefused`: a half-routed
     * capability document says nothing trustworthy about where a class runs, it
     * will say the same thing on the next pass, and a `local` guessed into the
     * gap is this app deciding — silently — whether an hour of somebody's book
     * runs on a card they own or an account they are billed for. It names the
     * server rather than the class for the same reason `any` steps past a
     * server-specific refusal and stops at this one: the defect is THAT
     * machine's document, and every class on it is equally unreadable.
     */
    return {
      verdict: 'refuse',
      reason: `"${slotName}" answered about ${capability} work with a document this build cannot `
        + `read: ${err.detail}`,
    };
  }
  /*
   * A THROW THIS FUNCTION HAS NOT ANTICIPATED. Transient, which is the safe
   * direction: an unrecognised failure that turns out to be permanent costs a
   * parked row somebody can cancel, and one read as permanent would fail a run
   * over a blip nobody named.
   */
  return transientWait(
    `"${slotName}" could not be asked about ${capability} work: `
    + `${err instanceof Error ? err.message : String(err)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/capability — the last route on this wire to become the SDK's
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CAPABILITY RECORD'S SHAPE MOVED TO shared/, AND IS RE-EXPORTED HERE.
 *
 * Wave 62 package I: the setup wizard's routes step draws a capability row's
 * `reason` (crucible docs/PHASE15-HOST.md §5.2 — *"for each llm class that is
 * `enabled: false` locally it says the class's reason"*), and a RENDERER cannot
 * import from `electron/`. The two interfaces are unchanged in every field;
 * they live in shared/engine-settings.ts now, and these re-exports mean every
 * importer that reaches for `CapabilityRow` here still finds it. ONE
 * declaration, two doors onto it — the alternative was a second spelling of the
 * same record in shared/, which is the exact defect this repo keeps meeting.
 */
export type { CapabilityRecord, CapabilityRow } from '../shared/engine-settings';

/*
 * 503 `capability_undecided` USED TO BE A CLASS OF THIS APP'S. It is the SDK's
 * `CrucibleCapabilityUndecided` now (0.6.0, crucible `e342fee`), raised by
 * `capability()` itself, and the local declaration is gone rather than kept
 * beside it: two types for one 503 is two things to catch, and the one that was
 * never thrown is the one a later edit forgets.
 */

/**
 * `GET /v1/capability` THROUGH THE SDK — and the two reasons it could not be,
 * until this pack.
 *
 * This route was the last one on this wire still called by hand. A private
 * `crucibleRequest` fetch served it, under a standing note to switch the moment
 * the tarball could answer both of these, and `@crucible/client` 0.6.0 re-packed
 * from crucible `e342fee` answers both:
 *
 *   1. **It had no clock.** `CrucibleClientOptions` was url/token/clientName, so
 *      `readCapability(entry, timeoutMs)` could not be expressed through it.
 *      `timeoutMs` is now a CONSTRUCTION option, which is why {@link clientFor}
 *      takes one and this function passes its own straight through — the gate
 *      probe (`crucible-provider.ts`) still asks with `PROBE_TIMEOUT_MS` on it,
 *      and a Mac that is asleep still must not put a network timeout behind a
 *      tooltip.
 *   2. **It refused a pre-PHASE-15 document outright.** The old reader took
 *      `route` through `str()`, so a row without one was a
 *      `CrucibleProtocolError` and the whole record was unreadable — measured
 *      against the WSL Crucible at 127.0.0.1:7100, which sends eleven rows and
 *      no `route` on any of them. 0.6.0 reads the VINTAGE ONCE FOR THE WHOLE
 *      DOCUMENT, exactly as §3.3's last bullet states it: no row carries
 *      `route` → the server predates phase 15 and every class on it IS local;
 *      some rows carry it and one does not → `capability_route_missing`, naming
 *      the row; a value that is neither word → `capability_route_unknown`. The
 *      document-level rule this app used to keep is now the SDK's entire, so
 *      Foundry's copy of it is GONE rather than kept beside it (R1).
 *
 * WHAT IS LEFT HERE IS THE MIRROR, and it stays on purpose. `CapabilityRow` and
 * `CapabilityRecord` live in shared/engine-settings.ts because the setup
 * wizard's routes step draws a row's `reason` and a RENDERER cannot import from
 * `electron/` — nor should a renderer bundle pull a main-process SDK in to read
 * two numbers and a word. So this is the one place the SDK's record is copied
 * into the app's, field for field, and the copy is a rename of nothing: every
 * field means what the SDK's means. `desktopAllowanceBytes` is deliberately not
 * carried, because nothing in this app draws it.
 *
 * EXPORTED FOR THE SETTINGS SIDE (`crucible-provider.ts`, Wave 61 package E) and
 * for coordination (`crucible-coordinate.ts`, which resolves the module's
 * CLASSES through it — crucible PHASE15-HOST.md §5.3a). ONE READER OF THIS
 * ROUTE, because the shape of a capability record is exactly the kind of thing
 * that is written twice and then only fixed once.
 */
export async function readCapability(
  entry: CrucibleServerEntry,
  timeoutMs?: number,
): Promise<CapabilityRecord> {
  /*
   * THROUGH THE ENGINE, NEVER THE ORCHESTRATOR. An orchestrator READS its
   * engine's capability block through onto its own `/v1/info` (PHASE17 §3.2) but
   * has no `/v1/capability` of its own, and this is the route every gate, every
   * tile and every placement in this app decides on. `engineClientFor` follows
   * §6's one hop; the clock travels with it, so the gate probe's
   * `PROBE_TIMEOUT_MS` still bounds BOTH reads rather than only the second.
   */
  const record = await (await engineClientFor(entry, { timeoutMs })).capability();
  return {
    backendKind: record.backendKind,
    totalBytes: record.totalBytes,
    classes: record.classes.map((row): CapabilityRow => ({
      capability: row.capability,
      enabled: row.enabled,
      selected: row.selected,
      reason: row.reason,
      shortfallBytes: row.shortfallBytes,
      route: row.route,
    })),
  };
}
