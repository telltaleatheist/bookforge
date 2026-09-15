/**
 * WHICH CRUCIBLE SERVER SHOULD THIS BOOK WAIT FOR — the whole per-row model.
 *
 * ── One question, one field ─────────────────────────────────────────────────
 *
 * Owen, 2026-09-13 (crucible `docs/PHASE7-LANES.md` §4.2): *"which registered
 * crucible server should this job wait for? any can be an option."* That is one
 * question, so it takes one answer, and the answer lives on the ROW:
 *
 *   waitFor: string | 'any'      // a registered server's name, or 'any'
 *
 * There is no `overflow` modifier, no `null`, and no chosen-versus-inherited
 * distinction — each was a real thing in an earlier draft of that section and
 * each is now impossible rather than merely discouraged (§4.2.1, §4.2.3). The
 * value the row carries is the value the row displays, and the operator can see
 * it and change it.
 *
 * There is also no per-STEP version of it. §4.4, Owen again: *"one book = one
 * gpu."* A dependency chain gets ONE machine choice, so the field is on the JOB
 * and every step of that job follows it.
 *
 * ── What is written at enqueue, and by whom ─────────────────────────────────
 *
 * §4.2.1a: the default is a SETTING (`newJobsWaitFor` in the routing record),
 * because *"a default must not manufacture instructions"*. `top-ranked` writes
 * the top-ranked server's NAME — visibly, on the row — and `any` writes `any`.
 * Nothing here reads the record; the engine is handed the answer by its host
 * (see `CrucibleRoutingHost` in electron/queue-engine.ts) so that this module
 * and the scheduler stay pure and keeper-drivable.
 *
 * ── What this module is ─────────────────────────────────────────────────────
 *
 * The vocabulary and the DECISION, as one pure function over facts the caller
 * has already gathered: the record's ranked list, what each row was already
 * assigned, and what each server last said. It performs no I/O, so the engine
 * can ask it inside a synchronous pump and a keeper can drive every branch with
 * no network.
 *
 * Every "no" it can answer is a SENTENCE THAT NAMES THE SERVER. A row that sits
 * at `queued` with no explanation is the thing `/v1/activity` and every named
 * refusal in the contract exist to avoid (§4.2.2's "Two consequences confirmed
 * as deliberate").
 */

/** The row's answer when it does not mind which machine, and would rather start. */
export const WAIT_FOR_ANY = 'any';

/**
 * THE QUEUE'S GPU DIAL, and the one rule that makes it safe: IT DEFERS.
 *
 * Owen, 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`): the live queue carries
 * a dial — `any`, or one named server — and it is *"a dial, not a router. A named
 * machine is an instruction; the answer to 'I cannot honour that right now' is to
 * WAIT, never to quietly use a different card."*
 *
 * The whole table, which {@link decideWaitFor} enforces and nothing else may:
 *
 *   | item          | dial            | result                                  |
 *   |---------------|-----------------|-----------------------------------------|
 *   | names S       | `any`           | S. An instruction is never second-guessed|
 *   | `any`         | names D         | D. The dial chooses for a row that won't |
 *   | names S       | names S         | S                                        |
 *   | names S       | names D (≠ S)   | HOLD — {@link holdDialElsewhere}         |
 *   | `any`         | `any`           | the first enabled server that answers    |
 *
 * The dial is spelled in the SAME vocabulary as a row's answer — `any` or a
 * registered server's name — deliberately: they are compared to each other on
 * every pass, and two spellings of one word is the shape this project spent
 * 2026-09-15 removing. {@link WAIT_FOR_ANY} is therefore the dial's `any` too,
 * and there is no second constant.
 *
 * WHERE THE VALUE LIVES is not here. This module performs no I/O; the dial is
 * passed IN as {@link WaitForFacts.dial}, exactly as the ranked list and the
 * server states are, so a keeper drives every row of that table with no engine,
 * no registry and no network. The record is `electron/crucible/gpu-dial.ts`.
 */
export const GPU_DIAL_ANY = WAIT_FOR_ANY;

/**
 * THE VENUE THAT NO LONGER EXISTS — recognised, never honoured.
 *
 * A row admitted before 2026-09-15 while the legacy local-render switch was on
 * had this written into `waitForResolved`: not a server, but
 * `parallel-tts-bridge`'s own narrator spawn. That layer is DELETED
 * (docs/LEGACY-REMOVAL.md), so the string survives for exactly one purpose — a
 * queue file on disk can still carry it, and such a row must HOLD with a
 * sentence naming the retirement rather than be re-decided.
 *
 * Re-deciding would be the worse answer: §4.3 says a job that started on a
 * machine finishes on that machine, and a half-rendered book silently continued
 * on a different card is the failure that rule exists to prevent. The operator
 * re-queues it; nothing here does that for them.
 */
export const RETIRED_LOCAL_NARRATOR_VENUE = 'legacy-local-narrator';

/** One server's place in the queue's order. Mirrors `RankedServerRow`. */
export interface WaitForServer {
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * What one server last said, as the scheduler knows it.
 *
 * `unknown` is a real state and not an error: nothing has asked yet, and the
 * honest thing to do about it is ask rather than guess in either direction.
 */
export type ServerState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** A 409 `server_busy`. A WAIT, never a failure — crucible ARCHITECTURE.md §3. */
  | { readonly kind: 'busy'; readonly line: string };

export interface WaitForFacts {
  /** The row's answer: a server name, `any`, or absent (see `holdNoAnswer`). */
  readonly waitFor: string | undefined;
  /**
   * The venue this book was already assigned — a server's name. Once set it
   * WINS over `waitFor`: §4.3, a job is atomic, so a book that started on a
   * machine finishes on that machine. An old row's
   * {@link RETIRED_LOCAL_NARRATOR_VENUE} is the one value that is not a server,
   * and it holds rather than running anywhere.
   */
  readonly resolved: string | undefined;
  /** Every server, in rank order, disabled ones included. */
  readonly ranked: readonly WaitForServer[];
  /** What each server last said. */
  readonly state: (server: string) => ServerState;
  /**
   * WHAT BOOKFORGE ALREADY HAS ON THIS SERVER'S GPU SLOT — a phrase naming it
   * ("narrating Mistborn"), or `null` when the slot is free.
   *
   * READ ONLY FOR `any`, where it is a CHOICE — §2.4: *"a book set to `any`
   * takes the first server whose GPU slot is free, in rank order"*. A NAMED
   * server is an instruction with nothing to choose, so its slot is the
   * scheduler's to enforce and the bench's to phrase; see `forOneServer`.
   *
   * Counted from this client's own outstanding work
   * (`shared/queue/slot-sets.ts`), NEVER polled and never a model of the
   * server's capacity: crucible `docs/PHASE7-LANES.md` §2.4. A free slot
   * licenses an ATTEMPT — the server's `409 server_busy` is still the only
   * authority on admission, and it arrives through {@link ServerState}'s `busy`.
   *
   * It is what makes two books render on two machines at once while two books
   * bound for ONE machine take turns without ever being refused: the second one
   * waits on the slot here rather than being submitted and 409'd there.
   */
  readonly gpuSlotTaken: (server: string) => string | null;
  /**
   * THE QUEUE'S GPU DIAL — `any`, or one registered server's name. See
   * {@link GPU_DIAL_ANY} for the whole precedence table and why it defers.
   *
   * Passed IN rather than read, like every other fact here: this module performs
   * no I/O, which is what lets a keeper drive every row of that table with no
   * engine. `electron/crucible/gpu-dial.ts` is the record it comes from and
   * `queue-ipc.ts` is what hands it over (`CrucibleRoutingHost.dial`).
   *
   * There is no `undefined`. A caller that has not got a dial has not read one,
   * and both guesses available here are routing decisions nobody made — so it is
   * refused by name in {@link decideWaitFor} rather than defaulted to `any`.
   */
  readonly dial: string;
}

export type WaitForVerdict =
  /** Send it to this server. */
  | { readonly kind: 'run'; readonly server: string }
  /** Nobody has asked this server yet. Ask, then decide again. */
  | { readonly kind: 'ask'; readonly server: string; readonly sentence: string }
  /** Not now, and here is exactly why, naming the machine. */
  | { readonly kind: 'hold'; readonly sentence: string };

const SETTINGS_ROW = 'Settings → Crucible Servers';

/**
 * WHICH OF THE TWO CONTROLS PUT THIS BOOK ON THIS MACHINE — and therefore which
 * one the operator has to turn to get it off again.
 *
 * `row` — the book itself names the server. The way out is to re-point the book.
 * `dial` — the book said `any` and the QUEUE'S DIAL chose. Telling that operator
 * to "set this book to Any" would be telling them to do what they have already
 * done, which is the wrong-cause failure this whole feature exists to avoid
 * (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`, "three different sentences").
 */
type VenueSource = 'row' | 'dial';

/** "…, or set this book to Any." — the one-click way out of every named hold. */
function orAny(source: VenueSource): string {
  return source === 'dial'
    ? "or turn the queue's GPU dial to Any."
    : 'or set this book to Any.';
}

function holdDisabled(server: string, source: VenueSource): string {
  return `Waiting for ${server}: disabled. A named server is an instruction, so this book is not `
    + `sent anywhere else — enable it in ${SETTINGS_ROW}, ${orAny(source)}`;
}

function holdUnreachable(server: string, detail: string, source: VenueSource): string {
  return `Waiting for ${server}: unreachable — ${detail} Start it, ${orAny(source)}`;
}

function holdUnknownServer(
  server: string, ranked: readonly WaitForServer[], source: VenueSource,
): string {
  return `Waiting for ${server}: it is not one of this machine's Crucible servers `
    + `(${ranked.length === 0 ? 'there are none' : ranked.map((r) => r.name).join(', ')}). `
    + `Add it in ${SETTINGS_ROW}, ${orAny(source)}`;
}

/**
 * THE FIRST OF THE THREE PARKED SENTENCES: the dial points somewhere else.
 *
 * Owen's exemplar, verbatim as the first clause: *"Waiting for 3090 Ti — the
 * queue is set to M1 Ultra."* The card named may be COMPLETELY IDLE, which is
 * exactly why this may not be collapsed into "waiting for the 3090 Ti to become
 * free": that sentence would send a person to look at a machine that is doing
 * nothing, and naming the wrong cause is the failure shape that cost this project
 * 2026-09-15.
 *
 * The row is NOT failed and NOT re-routed. It sits in the live queue until one of
 * the two controls moves (the book to Any or to the dial's server, or the dial to
 * Any or to this book's server), and the sentence names both ways out because
 * either is legitimate and only the operator knows which they meant.
 */
export function holdDialElsewhere(server: string, dial: string): string {
  return `Waiting for ${server} — the queue is set to ${dial}. The card may be completely idle: a `
    + 'named server is an instruction, so nothing sends this book somewhere else. Turn the '
    + `queue's GPU dial to ${server} or to Any, or set this book to Any.`;
}

/*
 * THE SECOND PARKED SENTENCE — "the server is occupied" — IS NOT HERE, and that
 * is deliberate.
 *
 * `docs/PENDING-QUEUE-AND-GPU-DIAL.md` asks for three sentences that name three
 * different causes, and this module owns two of them: the dial pointing
 * elsewhere ({@link holdDialElsewhere}) and the server being disabled or
 * unreachable ({@link holdDisabled}, {@link holdUnreachable}). The third is
 * about a SLOT, and the slot already has an owner: `stillReason`'s `no-slot`
 * branch in `shared/queue/bench.ts`, which reads the venue the pump pencilled
 * onto the step and names what is on the card. Owen's wording lives there.
 *
 * Writing it here as well would be two sentences for one fact, and the bench's
 * would win — it is tested before the recorded admission hold — so this one
 * would sit on the row unread. crucible `docs/ARCHITECTURE.md` R1.
 *
 * {@link holdBusy} below is a DIFFERENT fact that reads similarly: the SERVER
 * refused a submit `409 server_busy`, which is somebody else holding that
 * machine, and it carries the holder's own line.
 */

/**
 * The 409 sentence, exported because it is said in TWO moments about one fact:
 * when a submit comes back refused, and on every admission pass while the
 * cool-off stands. One owner, so the row does not change its wording halfway
 * through the wait.
 */
export function holdBusy(server: string, line: string): string {
  return `Waiting for ${server}: ${line} It takes one job at a time; this book goes on as soon `
    + 'as that one is done.';
}

/**
 * The row says nothing about where to render.
 *
 * TWO causes, ONE sentence, deliberately — because the sentence is about what
 * the row says now and the fix is the same either way:
 *
 *  - a queue file written before this field existed (the migration; the engine
 *    reports those ONCE, by name, at load — see `waitForMigrationReport`);
 *  - a run queued while this machine had no server to name at all (nothing
 *    registered, or everything disabled). Writing a name there would have been
 *    the manufactured instruction §4.2.1a exists to prevent, and writing `any`
 *    would have been a silent default. So the field stays absent and says so.
 */
export function holdRetiredVenue(): string {
  return `Waiting: ${retiredVenueReason()}`;
}

/**
 * WHY A ROW ASSIGNED TO THE DELETED NARRATOR GOES NOWHERE — one sentence, said
 * by every door that reads a RAW `waitForResolved`.
 *
 * Three read one: admission ({@link decideWaitFor}), the venue conversion
 * (`crucible/step-venue.ts`'s `runVenueOfRow`) and the AI provider block, plus
 * the align door. Each would otherwise invent its own wording for one fact, and
 * two of them would have read the string as a SERVER'S NAME and gone looking for
 * a machine called "legacy-local-narrator" (crucible `docs/ARCHITECTURE.md` R1).
 */
export function retiredVenueReason(): string {
  return 'this book was assigned to the local narrator, which no longer exists. BookForge renders '
    + 'on a Crucible server now and the local spawn layer has been removed '
    + '(docs/LEGACY-REMOVAL.md). Choose a server for it, or Any, and queue it again — nothing '
    + 'here moves a half-rendered book onto a different card on its own.';
}

export function holdNoAnswer(): string {
  return 'Waiting: this book does not say which Crucible server to render on. Choose one for it, '
    + 'or Any.';
}

function holdAnyNoneEnabled(ranked: readonly WaitForServer[]): string {
  return ranked.length === 0
    ? 'Waiting for any server; this machine has no Crucible server and none is registered. '
      + `Add one in ${SETTINGS_ROW}.`
    : `Waiting for any server; none of the ${ranked.length} you have is enabled `
      + `(${ranked.map((r) => r.name).join(', ')}). Enable one in ${SETTINGS_ROW}.`;
}

function holdAnyNoneReachable(tried: readonly string[]): string {
  return `Waiting for any server; none of the ${tried.length} enabled `
    + `${tried.length === 1 ? 'is' : 'are'} reachable (${tried.join('; ')}).`;
}

function asking(server: string): string {
  return `Checking whether ${server} is reachable…`;
}

/**
 * WHERE THIS BOOK'S GPU WORK GOES, or why it is not going yet.
 *
 * The order the questions are asked in is the contract's, and each rung is a
 * different fact:
 *
 *  1. **This book is already assigned.** §4.3 — a job that started on a machine
 *     finishes on that machine. That outranks the record, because the record can
 *     change under a book that is half rendered. The one assignment that is not
 *     a machine is {@link RETIRED_LOCAL_NARRATOR_VENUE}, which HOLDS.
 *  2. **The row names a server.** It runs there if it is enabled and reachable,
 *     and otherwise HOLDS AND SAYS WHICH. It is never re-routed: a named server
 *     is an instruction, and the queue-level enable switch is about availability
 *     rather than about overriding what a person asked for (§4.2.2).
 *  3. **The row names a server and the DIAL names a DIFFERENT one.** It HOLDS,
 *     in the live queue, saying both names ({@link holdDialElsewhere}). Not
 *     failed, not re-routed: the dial defers to an instruction, and either
 *     control unblocks it. Asked BEFORE the server's own state, because the dial
 *     is the reason and "3090 Ti is unreachable" would be a true sentence about
 *     a machine this book is not going to be sent to anyway.
 *  4. **The row says `any` and the dial names a server.** It takes the DIAL's
 *     server, and holds on that one's own state if it must — never falling
 *     through to another machine, because the dial chose and a choice that
 *     silently moves is not a choice.
 *  5. **Both say `any`.** The first enabled server, in rank order, that will
 *     take it. Disabled, unreachable and busy servers are simply not candidates;
 *     when none is left the hold NAMES that, rather than sitting silent.
 *
 * A RESOLVED ROW NEVER CONSULTS THE DIAL, which is rung 1 doing its job rather
 * than a special case: *"a running job ignores the dial"* (Owen, 2026-09-15).
 * The venue was settled when a GPU took the row, and turning a knob afterwards
 * governs the ADMISSION of new runs only.
 */
export function decideWaitFor(facts: WaitForFacts): WaitForVerdict {
  /*
   * A CALLER THAT SAID NOTHING ABOUT THE DIAL IS REFUSED, not defaulted. The
   * type says the field is required, which settles it for every TypeScript
   * caller; this is for the ones the compiler does not see — the keepers, the
   * CLI, anything driving the pure module from plain JS. The two guesses
   * available are "assume `any`", which silently ignores a dial the operator
   * turned, and "assume the row's own answer", which makes the dial do nothing
   * at all. Neither is a thing to decide on somebody's behalf.
   */
  if (typeof facts.dial !== 'string' || facts.dial === '') {
    throw new Error(
      'decideWaitFor: `dial` was not supplied. The queue\'s GPU dial is `any` or a registered '
        + "server's name, and it decides where a book that says `any` goes and whether a book "
        + 'that names a machine may start — so neither guess is a thing to make on a caller\'s '
        + 'behalf. Read it from `electron/crucible/gpu-dial.ts`.',
    );
  }
  const dial = facts.dial;

  const { resolved } = facts;
  if (resolved !== undefined) {
    if (resolved === RETIRED_LOCAL_NARRATOR_VENUE) {
      return { kind: 'hold', sentence: holdRetiredVenue() };
    }
    // A book that a GPU has taken finishes where it started (§4.3), so the dial
    // is not asked. `row` is the honest source: the way out of a hold here is
    // to cancel and re-add, which is about the book and not about the dial.
    return forOneServer(resolved, facts, 'row');
  }

  const waitFor = facts.waitFor;
  if (waitFor === undefined || waitFor === '') return { kind: 'hold', sentence: holdNoAnswer() };
  if (waitFor !== WAIT_FOR_ANY) {
    /*
     * THE DIAL DEFERS — and this is the whole of that rule, in one branch.
     *
     * The book names a machine and the dial names a different one. It SITS in
     * the live queue until one of the two moves. It is not failed (nothing is
     * wrong), not re-routed (the name is an instruction) and not silently
     * started on the dial's machine (which is the one outcome Owen ruled out by
     * name).
     */
    if (dial !== WAIT_FOR_ANY && dial !== waitFor) {
      return { kind: 'hold', sentence: holdDialElsewhere(waitFor, dial) };
    }
    return forOneServer(waitFor, facts, 'row');
  }

  /*
   * THE BOOK DOES NOT MIND. THE DIAL DOES — so the dial's server is where it
   * goes, and it waits on THAT machine rather than shopping down the rank list.
   * "Use this card, right now" is the sentence the dial exists to say
   * (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`), and a dial whose choice quietly
   * slid onto the next machine would not be saying it.
   */
  if (dial !== WAIT_FOR_ANY) return forOneServer(dial, facts, 'dial');

  const enabled = facts.ranked.filter((row) => row.enabled);
  if (enabled.length === 0) return { kind: 'hold', sentence: holdAnyNoneEnabled(facts.ranked) };

  const tried: string[] = [];
  for (const row of enabled) {
    // §2.4: "a book set to `any` takes the first server whose GPU slot is free,
    // in rank order". Ours is the slot we can be certain about, so it is asked
    // before the network is.
    const ours = facts.gpuSlotTaken(row.name);
    if (ours !== null) {
      tried.push(`${row.name}: BookForge is already ${ours} there`);
      continue;
    }
    const state = facts.state(row.name);
    if (state.kind === 'unknown') {
      return { kind: 'ask', server: row.name, sentence: asking(row.name) };
    }
    if (state.kind === 'ready') return { kind: 'run', server: row.name };
    tried.push(state.kind === 'busy'
      ? `${row.name}: ${state.line}`
      : `${row.name}: ${state.detail}`);
  }
  return { kind: 'hold', sentence: holdAnyNoneReachable(tried) };
}

function forOneServer(
  server: string, facts: WaitForFacts, source: VenueSource,
): WaitForVerdict {
  const row = facts.ranked.find((entry) => entry.name === server);
  if (row === undefined) {
    return { kind: 'hold', sentence: holdUnknownServer(server, facts.ranked, source) };
  }
  if (!row.enabled) return { kind: 'hold', sentence: holdDisabled(server, source) };
  /*
   * OUR OWN SLOT IS NOT ASKED ABOUT HERE, deliberately.
   *
   * A NAMED server is an instruction, so there is nothing to choose: the
   * verdict is `run` either way, and whether BookForge already has a job there
   * is a question about the SLOT, which the scheduler enforces and the bench
   * phrases (`stillReason`'s `no-slot`, `shared/queue/slot-sets.ts`). Saying it
   * a second time here would be two sentences for one fact — the bench's would
   * win, because a full pool outranks a recorded hold, and this one would sit
   * on the row unread (crucible `docs/ARCHITECTURE.md` R1).
   *
   * `gpuSlotTaken` is used below for `any`, where it is not a sentence but a
   * CHOICE: which of the enabled servers to try.
   */
  const state = facts.state(server);
  switch (state.kind) {
    case 'unknown': return { kind: 'ask', server, sentence: asking(server) };
    case 'ready': return { kind: 'run', server };
    case 'busy': return { kind: 'hold', sentence: holdBusy(server, state.line) };
    case 'unreachable':
      return { kind: 'hold', sentence: holdUnreachable(server, state.detail, source) };
  }
}

/**
 * How a `waitFor` value reads in a list — the picker's own words.
 *
 * `any` is not "the machines are equal" (§4.2.1); it is *"I do not mind which,
 * and I would rather start than wait"*, and the label says the second thing.
 */
export function waitForLabel(value: string | undefined): string {
  if (value === undefined || value === '') return 'No server chosen';
  if (value === WAIT_FOR_ANY) return 'Any — the first that will take it';
  if (value === RETIRED_LOCAL_NARRATOR_VENUE) return 'The local narrator (retired)';
  return value;
}

/**
 * How the DIAL reads in its own control — a different sentence from
 * {@link waitForLabel}'s, because it is a different question.
 *
 * A row's `any` means *"I do not mind which, and I would rather start than
 * wait"*. The dial's `any` means *"I am not steering — let each book's own
 * answer decide"*, which is a statement about the QUEUE and not about one book.
 * One label for both would make the queue-wide control read as a per-book one.
 */
export function gpuDialLabel(value: string): string {
  return value === GPU_DIAL_ANY ? 'Any — let each book decide' : value;
}
