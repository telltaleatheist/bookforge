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
}

export type WaitForVerdict =
  /** Send it to this server. */
  | { readonly kind: 'run'; readonly server: string }
  /** Nobody has asked this server yet. Ask, then decide again. */
  | { readonly kind: 'ask'; readonly server: string; readonly sentence: string }
  /** Not now, and here is exactly why, naming the machine. */
  | { readonly kind: 'hold'; readonly sentence: string };

const SETTINGS_ROW = 'Settings → Crucible Servers';

/** "…, or set this book to Any." — the one-click way out of every named hold. */
const OR_ANY = 'or set this book to Any.';

function holdDisabled(server: string): string {
  return `Waiting for ${server}: disabled. A named server is an instruction, so this book is not `
    + `sent anywhere else — enable it in ${SETTINGS_ROW}, ${OR_ANY}`;
}

function holdUnreachable(server: string, detail: string): string {
  return `Waiting for ${server}: unreachable — ${detail} Start it, ${OR_ANY}`;
}

function holdUnknownServer(server: string, ranked: readonly WaitForServer[]): string {
  return `Waiting for ${server}: it is not one of this machine's Crucible servers `
    + `(${ranked.length === 0 ? 'there are none' : ranked.map((r) => r.name).join(', ')}). `
    + `Add it in ${SETTINGS_ROW}, ${OR_ANY}`;
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
 *  3. **The row says `any`.** The first enabled server, in rank order, that will
 *     take it. Disabled, unreachable and busy servers are simply not candidates;
 *     when none is left the hold NAMES that, rather than sitting silent.
 */
export function decideWaitFor(facts: WaitForFacts): WaitForVerdict {
  const { resolved } = facts;
  if (resolved !== undefined) {
    if (resolved === RETIRED_LOCAL_NARRATOR_VENUE) {
      return { kind: 'hold', sentence: holdRetiredVenue() };
    }
    return forOneServer(resolved, facts);
  }

  const waitFor = facts.waitFor;
  if (waitFor === undefined || waitFor === '') return { kind: 'hold', sentence: holdNoAnswer() };
  if (waitFor !== WAIT_FOR_ANY) return forOneServer(waitFor, facts);

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

function forOneServer(server: string, facts: WaitForFacts): WaitForVerdict {
  const row = facts.ranked.find((entry) => entry.name === server);
  if (row === undefined) {
    return { kind: 'hold', sentence: holdUnknownServer(server, facts.ranked) };
  }
  if (!row.enabled) return { kind: 'hold', sentence: holdDisabled(server) };
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
    case 'unreachable': return { kind: 'hold', sentence: holdUnreachable(server, state.detail) };
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
