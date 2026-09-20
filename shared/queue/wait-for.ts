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

/*
 * THERE WAS A QUEUE-WIDE GPU DIAL HERE, AND IT IS GONE (Owen, 2026-09-19:
 * *"that works for me"*).
 *
 * It was a second routing input — `any`, or one named server — read on every
 * admission pass and able to park a book that named a machine. What killed it
 * is that the control it belonged to was REPLACED by the per-slot enable
 * switches on the bench (Owen, 2026-09-15: *"lets have a big checkbox above
 * each gpu slot"*), and nothing on the queue page turned it any more. A dial
 * file left by an older build steered every `any` book at one server and parked
 * every named book with a sentence telling the operator to turn a control that
 * was not on screen: a scheduler input with no owner on screen
 * (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A4).
 *
 * The two controls that survive are the per-server ENABLE switch (availability)
 * and the per-book PICKER (the instruction). {@link decideWaitFor} keeps rungs
 * 1, 2 and 5; rungs 3 and 4 were the dial's and went with it.
 */

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
   * THIS BOOK IS ALREADY HOLDING {@link resolved}'S CARD — Owen's ruling of
   * 2026-09-20, *"i want books to be atomic actions … they shouldnt lose their
   * GPU slot because theyre doing a quick step."*
   *
   * ── What it changes, and only what it changes ──────────────────────────────
   *
   * ONE rung, the resolved one, and TWO states on it: `busy` and `unknown`.
   *
   *  - `busy` is the server's activity line, polled or refused. It answers
   *    *"somebody holds that card"* — and when this book holds it, that somebody
   *    is this book. Owen watched *Mistborn* park on exactly that:
   *    *"Waiting for crucible@<the Mac>: busy: bookforge
   *    crucible-client/1.0.6, tts mistborn, 99% done"*, its own render's tail
   *    read back to it as a stranger's.
   *  - `unknown` means nobody has a current answer about reachability, and the
   *    honest thing for a row with nothing on that machine is to ask before it
   *    commits. A book whose own act just ran there has the answer already: the
   *    machine answered, for minutes. Waiting a round trip for the sweep to say
   *    so again is the same lost slot by a different door.
   *
   * `disabled`, `unreachable` and an unregistered name are NOT affected, and
   * that is deliberate: those are facts about the MACHINE, not about this
   * book's tail, and a row that goes on regardless would launch into a machine
   * the operator switched off or that has stopped answering, instead of parking
   * with the sentence that names it.
   *
   * FALSE FOR EVERY OTHER ROW. A book that does not hold the card is told about
   * a busy server exactly as it always was — the rung is not weakened, it is
   * told who is asking. The engine derives it with `gpuHoldOf`
   * (`shared/queue/slot-sets.ts`), off the run's own steps.
   */
  readonly holdsThisCard: boolean;
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
 * WHICH CONTROL PUT THIS BOOK ON THIS MACHINE — and therefore which one the
 * operator has to work to get it off again.
 *
 * `row` — the book itself names the server, and the book is still editable.
 *   The way out is one press on its own picker.
 * `resolved` — the book has been ASSIGNED (`waitForResolved`), which is the
 *   moment §4.3 makes the choice final. Its picker is read-only from then on:
 *   `setWaitFor` refuses every edit to a resolved row by name
 *   (`venue_fixed_at_admission`). So "set this book to Any" is a sentence that
 *   names a control which will refuse — the wrong-cause failure this module
 *   exists to avoid — and the way out is the one act that works: send it back
 *   to Pending, where the choice is a question again
 *   (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A6).
 *
 * There was a third, `dial`, for the queue-wide GPU dial. The dial is gone
 * (Owen, 2026-09-19) and so is its sentence.
 */
type VenueSource = 'row' | 'resolved';

/**
 * HOW THIS OPERATOR GETS THIS BOOK OFF THIS MACHINE — the tail of every named
 * hold, and it must name a control that will actually answer.
 *
 * Returned WITH its leading punctuation, because the two ways out are different
 * shapes: an editable row's is a clause on the end of the repair sentence, and a
 * resolved row's is a sentence of its own.
 */
function wayOut(source: VenueSource): string {
  return source === 'resolved'
    ? '. Cancel this book to send it back to Pending, and choose again there.'
    : ', or set this book to Any.';
}

function holdDisabled(server: string, source: VenueSource): string {
  return `Waiting for ${server}: disabled. A named server is an instruction, so this book is not `
    + `sent anywhere else — enable it in ${SETTINGS_ROW}${wayOut(source)}`;
}

function holdUnreachable(server: string, detail: string, source: VenueSource): string {
  return `Waiting for ${server}: unreachable — ${detail} Start it${wayOut(source)}`;
}

function holdUnknownServer(
  server: string, ranked: readonly WaitForServer[], source: VenueSource,
): string {
  return `Waiting for ${server}: it is not one of this machine's Crucible servers `
    + `(${ranked.length === 0 ? 'there are none' : ranked.map((r) => r.name).join(', ')}). `
    + `Add it in ${SETTINGS_ROW}${wayOut(source)}`;
}

/*
 * "THE SERVER IS OCCUPIED" IS NOT HERE, and that is deliberate.
 *
 * Every parked row must name its OWN cause, and this module owns two of them:
 * the server being disabled and the server being unreachable
 * ({@link holdDisabled}, {@link holdUnreachable}). The third is about a SLOT,
 * and the slot already has an owner: `stillReason`'s `no-slot` branch in
 * `shared/queue/bench.ts`, which reads the venue the pump pencilled onto the
 * step and names what is on the card. Owen's wording lives there.
 *
 * Writing it here as well would be two sentences for one fact, and the bench's
 * would win — it is tested before the recorded admission hold — so this one
 * would sit on the row unread. crucible `docs/ARCHITECTURE.md` R1.
 *
 * (A fourth used to live here, `holdDialElsewhere`: "the queue is set to M1
 * Ultra". The queue-wide GPU dial it described is gone, Owen 2026-09-19, and a
 * sentence about a control nobody can turn is worse than no sentence.)
 *
 * {@link holdBusy} below is a DIFFERENT fact that reads similarly: the SERVER
 * refused a submit `409 server_busy`, which is somebody else holding that
 * machine, and it carries the holder's own line.
 */

/**
 * WHAT IS ON A SERVER'S CARD, as the one line a person reads.
 *
 * ── Why this exists beside the SDK's own (2026-09-19) ──────────────────────
 *
 * `CrucibleBusy.busyLine` in `@crucible/client` composes exactly this sentence
 * — *"busy: foundry, tts qwen3, 62% done"* — and it is the spelling the queue
 * has always shown, because until today the ONLY way this app learnt a card was
 * held was a `409 server_busy` carrying that error. Admission now learns it
 * BEFORE it submits anything, by reading `GET /v1/activity` on the reach sweep
 * (Owen, 2026-09-19: *"poll the server to see if it's available"*) — and an
 * activity read is not an error, so the getter cannot be called on it.
 *
 * Two composers for one sentence would drift, and the drift would be invisible:
 * the same wait would read one way when it was polled and another way when it
 * was refused, and nobody would be able to tell the two moments apart. So the
 * SPELLING lives here, pure, and `tools/test-queue-admission.js` holds it
 * against a real `CrucibleBusy` — if the SDK ever rewords its line, that keeper
 * fails rather than the row quietly saying two things.
 *
 * `progress` is `null` for a holder with no denominator — a streaming session
 * says so by contract (`ActivityStreaming.progress`), and a percentage of work
 * that happens to have arrived is a number that goes DOWN. The clause is then
 * left out rather than printed as `0% done`, which would be a measurement
 * nobody made.
 */
export interface CrucibleBusyFacts {
  /** The holder's User-Agent. `null` = it did not say; never a guessed name. */
  readonly holder: string | null;
  /** What is on the card — "tts qwen3", "a streaming session". */
  readonly what: string;
  /** 0..1, or null when the holder has no denominator. */
  readonly progress: number | null;
  /** The holder's latest progress line, or null. */
  readonly message: string | null;
}

export function busyLineFor(facts: CrucibleBusyFacts): string {
  const who = facts.holder === null ? 'an unnamed client' : facts.holder;
  const head = facts.progress === null
    ? `busy: ${who}, ${facts.what}`
    : `busy: ${who}, ${facts.what}, ${Math.round(facts.progress * 100)}% done`;
  return facts.message === null ? head : `${head} — ${facts.message}`;
}

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
 * THREE RUNGS, and the numbering is the contract's own (crucible
 * `docs/PHASE7-LANES.md` §4.2–§4.3). Rungs 3 and 4 were the queue-wide GPU
 * dial's; the dial is gone (Owen, 2026-09-19) and the gap in the numbers is
 * left standing so that a reader of the contract and a reader of this file are
 * talking about the same rungs.
 *
 *  1. **This book is already assigned.** §4.3 — a job that started on a machine
 *     finishes on that machine. That outranks the record, because the record can
 *     change under a book that is half rendered. The one assignment that is not
 *     a machine is {@link RETIRED_LOCAL_NARRATOR_VENUE}, which HOLDS. A run
 *     that is HOLDING that machine's card between its GPU steps reads the
 *     machine's `busy` and `unknown` differently — see
 *     {@link WaitForFacts.holdsThisCard}; every other answer on this rung is
 *     unchanged.
 *  2. **The row names a server.** It runs there if it is enabled and reachable,
 *     and otherwise HOLDS AND SAYS WHICH. It is never re-routed: a named server
 *     is an instruction, and the queue-level enable switch is about availability
 *     rather than about overriding what a person asked for (§4.2.2).
 *  5. **The row says `any`.** The first enabled server, in rank order, that will
 *     take it. Disabled, unreachable and busy servers are simply not candidates;
 *     when none is left the hold NAMES that, rather than sitting silent.
 */
export function decideWaitFor(facts: WaitForFacts): WaitForVerdict {
  const { resolved } = facts;
  if (resolved !== undefined) {
    if (resolved === RETIRED_LOCAL_NARRATOR_VENUE) {
      return { kind: 'hold', sentence: holdRetiredVenue() };
    }
    /*
     * `resolved` IS THE SOURCE, not `row`. A book a GPU has taken finishes
     * where it started (§4.3) and its picker is read-only from that instant —
     * `setWaitFor` refuses by name — so a hold here that told the operator to
     * "set this book to Any" would name a control that will refuse them
     * (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A6). See {@link VenueSource}.
     */
    return forOneServer(resolved, facts, 'resolved');
  }

  const waitFor = facts.waitFor;
  if (waitFor === undefined || waitFor === '') return { kind: 'hold', sentence: holdNoAnswer() };
  if (waitFor !== WAIT_FOR_ANY) return forOneServer(waitFor, facts, 'row');

  const enabled = facts.ranked.filter((row) => row.enabled);
  if (enabled.length === 0) return { kind: 'hold', sentence: holdAnyNoneEnabled(facts.ranked) };

  const tried: string[] = [];
  /*
   * AN `unknown` SERVER DOES NOT STOP THE LOOP — it is remembered and the loop
   * goes on (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A7).
   *
   * Returning `ask` at the first `unknown` made an `any` row wait a round trip
   * — or one connect timeout, if that machine is asleep — while a `ready`
   * server sat further down the list doing nothing. And `unknown` is not a rare
   * state: every answer ages out on `reachTtlMs` (15 s), so the top server is
   * `unknown` again on a cadence and every `any` row arriving in that window
   * paid for it.
   *
   * A `ready` server is an ANSWER and `unknown` is the absence of one, so the
   * answer wins. Rank order still decides among answers — the first `ready` in
   * rank order runs — and among non-answers: if nothing is ready, the FIRST
   * server nobody has asked is the one asked now.
   */
  let firstUnknown: string | null = null;
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
    if (state.kind === 'ready') return { kind: 'run', server: row.name };
    if (state.kind === 'unknown') {
      if (firstUnknown === null) firstUnknown = row.name;
      continue;
    }
    tried.push(state.kind === 'busy'
      ? `${row.name}: ${state.line}`
      : `${row.name}: ${state.detail}`);
  }
  if (firstUnknown !== null) {
    return { kind: 'ask', server: firstUnknown, sentence: asking(firstUnknown) };
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
  /*
   * THE BOOK ON THE CARD DOES NOT QUEUE FOR IT — {@link WaitForFacts.holdsThisCard}.
   *
   * Asked here, before the state is read, because the two states it overrides
   * (`busy`, `unknown`) are both statements about whether SOMEBODY ELSE can be
   * said to have the machine, and this book is not somebody else. `resolved` is
   * required with it: a hold is a fact about an ASSIGNED run, and the row-named
   * rung has no card yet by definition.
   */
  if (source === 'resolved' && facts.holdsThisCard
    && (state.kind === 'busy' || state.kind === 'unknown')) {
    return { kind: 'run', server };
  }
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
