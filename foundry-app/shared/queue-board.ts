/**
 * THE BOARD — which resource each kind of job needs, and how many of each the
 * machine has.
 *
 * Compiled by BOTH programs, like the wire shapes beside it: the scheduler
 * (electron/job-queue.ts) reads this to decide when a row may start, and the
 * chrome (core/queue-view.service.ts) reads it to decide which lane a row is drawn
 * in. ONE TABLE, because the lane a row waits in and the lane it eventually
 * runs in are the same question, and two answers to it would be a board that
 * draws a reading under CPU while the pump holds it against the card.
 *
 * Owen ruled the shape (docs/QUEUE-BOARD.md, verbatim): *"the queue shelf
 * should probably look a bit more like the bookforge queue, where it has two
 * cpu slots and one gpu slot, and i can see details about the step thats taking
 * place."*
 *
 * ── Why this is a table over the union and not a lookup with a default ──────
 *
 * A default resource is a fallback, and fallbacks are bugs with a delay on
 * them: the day somebody adds a kind, the default would quietly file it in
 * whichever lane the fallback happened to name — and the first symptom would be
 * two models resident on one card at four in the morning. `Record<JobKind, …>`
 * makes the compiler name the missing row at the moment the kind is added,
 * which is the same reason `NEVER_ROUTED` one file over is a table and not a
 * literal. That one WAS a literal once, and it aged exactly this way.
 *
 * ── AND THE GPU LANE IS NOT ONE LANE ANY MORE (Wave 61, Package G) ──────────
 *
 * It was `SLOTS = {gpu: 1, cpu: 2}` — two numbers, both constants — and the
 * first of them stopped being true the moment a second machine could be
 * registered. Owen (docs/SLOTS.md §1): *"if there are more than one servers
 * connected, there will be more than one GPU slot listed in the queue that can
 * be filled… an emergent property of having multiple servers configured is the
 * distributed load."* A constant 1 made that impossible: a translation on the
 * Mac and a cleanup on this desk are two different cards, and a board that
 * counted them into one lane held the second behind the first for hours.
 *
 * So the GPU side of the board is DERIVED — one lane per compute slot
 * ({@link computeLanes}), each holding one run, in the one place both programs
 * read it from. The CPU side is still a count, because it still is one: the CPU
 * lane is about this machine's disk and this machine's cores, and nothing in the
 * slot list changes how many of those there are.
 *
 * ── AND THE GPU SIDE HAS NO LANE OF ITS OWN ANY MORE (Wave 66, the slot half) ─
 *
 * Owen: *"everything goes through a crucible server now, including local… there
 * should be no local gpu listed in the queue"*, and then precisely: *"cpu slots
 * are always local. we dont outsource simple cpu work to crucible. one gpu slot
 * in the queue per connected crucible server. including the local crucible, which
 * is indistinguishable from the remote crucible server."*
 *
 * Both halves of that land here. The GPU side is one lane per REGISTERED SERVER
 * and nothing else — a machine with no server registered has no GPU lane at all,
 * where it used to have one called "This computer" — and the CPU side is
 * untouched, because the ruling protects it in as many words.
 */
import { isLoopbackUrl, type ComputeSlot, type ComputeSlotKind } from './slots';
import type { JobKind } from './types';

/**
 * What a job needs from the machine while it runs.
 *
 * ── `gpu` and `cpu` are the two SIDES of the board, and they are all of it ──
 *
 * `gpu` is the work that needs a card, and a card belongs to a MACHINE: one lane
 * per compute slot, one run in each (Wave 16's *"one machine's GPU needs one
 * owner"*, now said once per machine rather than once). `cpu` is two runs
 * because Owen said two, and because two engine processes compiling two
 * different books are disjoint by construction — every book file write is
 * already serialised per target path (`oneWriterOf`, electron/engine.ts), every
 * catalogue edit is serialised per project (`withManifest`,
 * electron/projects.ts), and two live rows writing one output are refused
 * outright at the door (`enqueueHere`'s dedupe).
 *
 * ── `exclusive` IS NOT A LANE AND IS NOT "no resource" ──────────────────────
 *
 * An environment install takes no card and is not a conversion, and the
 * contract first spelled it as neither — *"it keeps its own path outside the
 * slots exactly as Wave 16e ruled"*. THAT READING OF 16e WAS WRONG and the
 * build corrected the contract rather than the code: 16e ruled that an install
 * never ROUTES to a host queue, which is a fact about whose scheduler decides
 * it. It says nothing about slots, and in this app's own queue an install has
 * always taken the pump's one serial slot — deliberately, because the whole
 * argument for an install living in this queue at all is that *"a conversion
 * that needs the environment must wait BEHIND it"*. A downloader running beside
 * the lanes would let a reading start against the Python it is halfway through
 * replacing, which is the one failure the shared queue exists to prevent.
 *
 * So an install holds the WHOLE BOARD: it starts only when every slot is free,
 * nothing starts beside it, and nothing queued behind it starts before it does.
 * That is exactly what one serial slot bought, spelled as a rule instead of as
 * a side effect of there being only one slot.
 *
 * ── `unscheduled` IS THE ROW THE PUMP NEVER SEES ────────────────────────────
 *
 * A mint is minutes of work with progress and a cancel, and it belongs on the
 * shelf — but the rasterising happens in the RENDERER under somebody's hands
 * and main only assembles what arrives. It is born `running` (`beginMint`), so
 * it is invisible to a scheduler that only ever claims a `queued` row. It
 * competes with nothing, it holds no slot, and it does not hold the drain.
 * Naming that here rather than leaving it implied is what lets the shelf draw
 * such a row somewhere honest instead of inventing a lane for it.
 */
export type JobResource = 'gpu' | 'cpu' | 'exclusive' | 'unscheduled';

/**
 * THE TABLE. Every kind, one resource, no default — see the module note.
 *
 * ── SIMPLIFY IS IN HERE NOW, AND THE SENTENCE THAT SAID IT MUST NOT BE ──────
 *
 * It read: *"SIMPLIFY IS NOT IN HERE AND MUST NOT BE. It is a rewrite prompt on
 * the translate command, the Simplify dialog calls `enqueueTranslate`, and the row
 * it produces is `kind: 'translate'` wearing a title of its own."* Every clause of
 * that was true of the queue and false of the row a person reads, which is what
 * Owen overturned on 2026-09-05: *"it isnt a translate job. naming it translate is
 * deceptive."* A simplify and a cleanup are kinds of their own now, and what the
 * old paragraph was really defending — that all three hold the same lane — is
 * stated below as three entries instead of one entry and an argument.
 */
export const JOB_RESOURCE: Readonly<Record<JobKind, JobResource>> = {
  /** The VLM holds the card for hours. */
  read: 'gpu',
  /** Ollama holds the card (`keep_alive: 0` on exit, Wave 4c). */
  translate: 'gpu',
  /**
   * TRANSLATE'S OWN ENTRY, TWICE. A rewrite is `foundry translate --rewrite` and a
   * cleanup is `foundry clean-text`; both are one Ollama call per block over a
   * whole book, which is a model resident on the card for hours. Two of these
   * beside each other is exactly what the single GPU slot exists to prevent, and
   * nothing about them being separate kinds changes the machine.
   */
  simplify: 'gpu',
  clean: 'gpu',
  /** Engine compile or cast — disk and CPU, and no model anywhere near it. */
  epub: 'cpu',
  txt: 'cpu',
  /**
   * A facsimile or a real-text reprint: `--reuse-readings` over a finished
   * bank, which loads no model and opens no socket (`executeJob`'s server rule).
   */
  pdf: 'cpu',
  /** Rectify and assemble, in the renderer's hands. See `unscheduled` above. */
  mint: 'unscheduled',
  /** The precondition of the engine running at all. See `exclusive` above. */
  'env-install': 'exclusive',
  /*
   * TRANSLATE'S REASON, WORD FOR WORD: a model holds the card. An analysis is
   * one schema-constrained call per ranked (passage, category)
   * (docs/ANALYSIS.md §5), which is a model resident on the GPU for as long as
   * the verify stage runs — an hour on a hot book.
   */
  analysis: 'gpu',
  /**
   * THE CLEANUP'S TRIAGE HOLDS A CARD TOO — a small `decide` model, leased on a
   * Crucible for the length of the book, answering one yes/no per block. Smaller
   * than the cleaner is not the same as free: it is a model resident on somebody's
   * GPU, and the cleanup chained behind it wants that card next.
   */
  'clean-triage': 'gpu',
  /** The analysis's ranking, on the triage's clause: a decide model leased for the length of the book. */
  'analysis-rank': 'gpu',
};

/** The two resources that are actually counted in slots. */
export type Lane = 'gpu' | 'cpu';

/** Drawn in this order, and scheduled in it too: the expensive lane first. */
export const LANES: readonly Lane[] = ['gpu', 'cpu'];

/**
 * HOW MANY CPU RUNS AT ONCE — Owen's number, and the one number left in here.
 *
 * Two, because he said two: a machine that can compile two books while it reads
 * a third is a machine doing three things in the time it used to do one, and the
 * three do not contend for anything the app cannot already serialise (see
 * `JobResource`). It is NOT derived from the slot list and must not be: a
 * compile is this machine's disk whichever machine's card the reading is on, so
 * registering a Crucible in another room does not buy a third compile here.
 *
 * ── AND OWEN'S RULING PROTECTS IT BY NAME (Wave 66) ────────────────────────
 *
 * *"cpu slots are always local. we dont outsource simple cpu work to crucible."*
 * The same ruling deleted the local GPU slot, so it is worth saying which half of
 * the board it applies to: this one stays exactly as it was. A compile, a
 * rasterise and an EPUB assembly are work on the disk in front of the person, and
 * sending them to a server would be a network round trip in place of a file copy.
 */
export const CPU_LANE_SLOTS = 2;

/**
 * HOW MANY RUNS ONE COMPUTE SLOT WILL TAKE AT ONCE — one, whatever it is.
 *
 * A table over the KIND rather than a constant, for `JOB_RESOURCE`'s reason one
 * union along: the day a fourth kind of slot exists, the compiler asks what it
 * holds rather than a fallback answering for it.
 *
 * ── `cloud` IS ONE TOO, AND IT IS NOW A MEASURED-ENOUGH NUMBER RATHER THAN ──
 * ── A PLACEHOLDER ───────────────────────────────────────────────────────────
 *
 * The row was written before anything constructed a cloud slot, so that the day
 * one existed it already had a lane and a number instead of falling through a
 * walk that had never heard of it. Package F constructs them (docs/SLOTS.md §3),
 * and the one STAYS — for a reason that is a fact about providers rather than
 * about cards.
 *
 * A CRUCIBLE'S LANE IS ONE BECAUSE THE GPU IS ONE. A provider has no card to
 * contend for; what it has is a RATE LIMIT, per key and per tier, counted in
 * requests and tokens a minute. That limit is already honoured one layer down
 * and better than a lane could: a single run keeps `DEFAULT_CLOUD_CONCURRENCY`
 * requests in flight (four, src/translate/model-server.ts) and the engine WAITS
 * OUT a 429 rather than failing — `retry-after` honoured, else 2 s doubling to
 * 30 s, six attempts (docs/VLLM.md §2a). Two runs on one key would not go
 * faster; they would share one limit, trip it more often, and spend the
 * difference asleep while still paying for every retry that landed. So one at a
 * time per provider is the honest starting number, and a person who wants two
 * cloud jobs at once configures a second provider entry — which is a second key,
 * a second limit and a second slot, said out loud.
 *
 * Raising it is a deliberate edit to THIS LINE with a measurement beside it, not
 * something a walk wandered into and billed somebody for.
 */
export const SLOT_CAPACITY: Readonly<Record<ComputeSlotKind, number>> = {
  crucible: 1,
  cloud: 1,
};

/**
 * ── THE SECOND LANE EVERY CRUCIBLE HAS, AND WHY IT IS NOT A CARD (Wave 62) ──
 *
 * crucible docs/PHASE15-HOST.md §3.3/§3.4: a text class on a server has a ROUTE,
 * and an UPSTREAM route (`anthropic/…`, `openai/…`, `ollama/…`) is forwarded by
 * the server on the operator's account. Owen, 2026-09-14: *"one contract, one
 * SDK, one API, one communication method"* — the app sends the same chat to the
 * same door and the engine's config decides where it lands.
 *
 * NOTHING OF OURS IS ON THE CARD ON THAT PATH. §3.4 spells it out: *"no lease,
 * no lane, the settlement untouched (nothing was on the card)"*. So a job routed
 * upstream that sat in the machine's one card lane would be holding a GPU it
 * never touches — a translation waiting behind a cleanup that is being answered
 * in somebody else's datacentre. Hence a SECOND lane per Crucible slot, named for
 * the slot with this suffix, exactly as BookForge names its own (§5.3: *"a row
 * whose class routes `upstream` on its server takes that server's `[cloud]` lane
 * (one per server, width 2)"*). Two apps, one vocabulary.
 *
 * TWO WIDE, AND THE NUMBER IS BookForge'S. It is not a card being shared; it is
 * an account's rate limit, which §3.4 hands to the CALLER to wait out (`429`
 * passed through with `Retry-After` — *"the server never retries a billed
 * request"*), and which the engine already waits out for us (docs/VLLM.md §2a).
 * Two is what the other app rations by, and one board that two apps read has to
 * count the same way or a person watching both sees two different machines.
 */
export const UPSTREAM_LANE_SUFFIX = ':cloud';

/** How many upstream-routed runs one server will forward at once. See above. */
export const UPSTREAM_LANE_CAPACITY = 2;

/**
 * The name of a slot's upstream lane. Composed in ONE place, because it is an
 * identity three readers compare by string: the scheduler's occupancy map, the
 * walk's claim, and the bench's card.
 */
export function upstreamLaneName(slot: string): string {
  return `${slot}${UPSTREAM_LANE_SUFFIX}`;
}

/**
 * THE MACHINE A LANE BELONGS TO — its own name, or the slot an upstream lane is
 * named for.
 *
 * For the one place a lane's name is shown to a PERSON: the bench card's heading.
 * "mac-studio:cloud" is an identity three programs compare by string and is not a
 * sentence anybody should have to read, so the card says the machine and the word
 * for what the lane is separately.
 *
 * IT READS `route` RATHER THAN THE SUFFIX. The producer already knew which lane
 * this is; re-deriving it from the spelling of a name would be a parser standing
 * in for a fact, and would mangle a server somebody actually called `foo:cloud`.
 */
export function slotOfLane(lane: ComputeLane): string {
  return lane.route === 'upstream'
    ? lane.name.slice(0, -UPSTREAM_LANE_SUFFIX.length)
    : lane.name;
}

/**
 * ONE LANE OF THE GPU SIDE — a compute slot, and how many runs may be in it.
 *
 * It is `ComputeSlot` plus a capacity rather than a reference to one, because
 * the two programs that read this are drawing and rationing, and both want the
 * name, the kind and the number in one object. The name is the IDENTITY: it is
 * what a row's `waitFor` names, what `ranOn` records, what the bench card is
 * headed with, and what the scheduler keys its occupancy by — four readers of
 * one string, which is why the registry refuses a duplicate name.
 */
export interface ComputeLane {
  name: string;
  kind: ComputeSlotKind;
  /** A Crucible slot's base URL, as `ComputeSlot` carries it. See `localLane`. */
  url?: string;
  capacity: number;
  /**
   * WHICH OF THE SLOT'S TWO LANES THIS IS, in the contract's own word
   * (PHASE15 §1: a class's route is `local` or an upstream).
   *
   *   `local`    — the machine's card. One run, and the lease is on it.
   *   `upstream` — the server FORWARDING the chat on the operator's account
   *                ({@link upstreamLaneName}). Nothing of ours is resident, so
   *                nothing here contends with the card lane beside it.
   *
   * Spelled rather than derived from the name's suffix: a lane is drawn, counted
   * and rationed by three readers, and a suffix test is a parser standing in for
   * a fact the producer already knew.
   */
  route: 'local' | 'upstream';
}

/**
 * THE GPU SIDE OF THE BOARD, DERIVED FROM THE SLOT LIST — one lane per slot.
 *
 * This is the whole of Package G: `SLOTS.gpu` was 1, so two Crucible servers
 * could not run two text jobs at once however correct the dispatch was. One lane
 * per slot is Owen's sentence as arithmetic — *"an emergent property of having
 * multiple servers configured is the distributed load"* — and it is a pure
 * function of the list so that the SCHEDULER (electron/job-queue.ts, which reads
 * `computeSlots()`) and the BENCH (core/queue-view.service.ts, which reads
 * `slots:list`) cannot disagree about how many lanes there are.
 *
 * ── AN EMPTY LIST IS NO LANES, AND THAT IS THE RULING (Wave 66) ────────────
 *
 * It used to be ONE lane, named for the local slot: a machine with no Crucible —
 * and a hosted window whose host offers no registry — kept a GPU lane of its own
 * so that every job took the path it took before slots existed. Owen deleted the
 * thing that lane stood for: *"there should be no local gpu listed in the queue."*
 *
 * So an empty slot list is an empty board on the GPU side, and a GPU job on it
 * has nowhere to go. That is NOT a row that sits queued for ever: the scheduler
 * lets such a row through (`canStart`, electron/job-queue.ts) precisely so the
 * placement can refuse it by name — *"no GPU engine is connected"* — which is the
 * honest answer and the one a person can act on. The CPU side is untouched and
 * every export, compile and rasterise still runs exactly as it did.
 *
 * ── AND A CRUCIBLE SLOT IS TWO LANES NOW (Wave 62, Package K) ──────────────
 *
 * The card and the upstream one beside it — see {@link UPSTREAM_LANE_SUFFIX} for
 * the argument. It is a pure function of the list still: the second lane exists
 * on every Crucible slot whether or not anything is routed upstream today,
 * because a lane list that appeared and vanished as an operator edited a REMOTE
 * server's settings would be a board whose size depends on a fact this app
 * re-measures on a fifteen-second clock. What is conditional is the DRAWING (the
 * bench skips an empty upstream lane, core/queue-view.service.ts), not the
 * rationing.
 *
 * A CLOUD SLOT GETS ONE LANE. It has no route: a `cloud` slot is an app-held key
 * that PHASE15 §5.3 deletes outright (Package L), and giving it a second lane
 * would be inventing a machine.
 */
export function computeLanes(slots: readonly ComputeSlot[]): ComputeLane[] {
  return slots.flatMap((slot): ComputeLane[] => {
    const url = slot.url === undefined ? {} : { url: slot.url };
    const card: ComputeLane = {
      name: slot.name,
      kind: slot.kind,
      ...url,
      capacity: SLOT_CAPACITY[slot.kind],
      route: 'local',
    };
    if (slot.kind !== 'crucible') return [card];
    return [card, {
      name: upstreamLaneName(slot.name),
      kind: slot.kind,
      ...url,
      capacity: UPSTREAM_LANE_CAPACITY,
      route: 'upstream',
    }];
  });
}

/**
 * WHICH LANE IS THIS MACHINE'S OWN CARD — where a run that was never placed goes.
 *
 * ── The case that makes this a function and not a name comparison ───────────
 *
 * It used to have two answers: the slot called "This computer", or — when an
 * enabled LOOPBACK Crucible had hidden that slot — the loopback Crucible's own
 * lane. There is no local slot now (Owen: *"there should be no local gpu listed
 * in the queue"*), so the second answer is the only one left: this machine's card
 * is the lane of the Crucible registered at a loopback address, if there is one.
 *
 * The question is still worth asking, because the things that run on this card
 * regardless of the registry have not gone anywhere. A page reading takes the
 * local dots server while `CRUCIBLE_READS` is false, whatever the list says, and
 * a reading holding a lane of its own beside the loopback Crucible's would let
 * the board start a translation on the very card the reading is using. One card,
 * one lane, whichever name the list gives it.
 *
 * NULL WHEN NOTHING IN THE LIST IS THIS MACHINE — every slot a remote Crucible,
 * or no slots at all. Null means "the local card is not one of the places work
 * may go", which is now the ordinary state of a desk with no Crucible on it as
 * well as of a fully remote setup.
 *
 * AN UPSTREAM LANE IS NEVER THIS MACHINE'S CARD, and the guard is not belt and
 * braces: a loopback Crucible's upstream lane carries the same loopback URL as
 * its card lane, so the second clause below would match it. A reading that had
 * been handed that lane would be reading on this GPU while the board believed the
 * card was free.
 */
export function localLane(lanes: readonly ComputeLane[]): ComputeLane | null {
  return lanes.find(
    (lane) => lane.route === 'local' && lane.url !== undefined && isLoopbackUrl(lane.url),
  ) ?? null;
}

/**
 * THE LANE A RUNNING ROW IS IN, read from where it actually went.
 *
 * `Job.ranOn` is the placement's own answer and is the truth about the run; this
 * maps it onto the board as it stands NOW, which is the question the bench asks
 * and the one place the two can differ. Two mappings, both deliberate:
 *
 *   * ABSENT resolves through {@link localLane} — so a run that was never placed
 *     draws on the card that is actually doing the work, when one of the lanes IS
 *     this machine's card, and on none when it is not. (It used to accept the
 *     local slot's name here as well; that name is gone with the slot.)
 *   * A NAME NOTHING IN THE LIST CARRIES answers NULL, and null is not a shrug:
 *     it is a run on a server somebody switched off or removed WHILE IT WAS
 *     RUNNING. docs/SLOTS.md §3 — *"jobs never start on one slot and finish on
 *     another. its atomic"* — so the run stays where it is, and the caller draws
 *     it as the lane that is going away rather than pretending it moved home.
 *
 * ── AND `ranVia` PICKS THE SLOT'S OTHER LANE (Wave 62) ─────────────────────
 *
 * `Job.ranOn` is the MACHINE and stays the machine — it is what the shelf says
 * ("Running on the Mac") and folding a lane suffix into it would put a colon in
 * front of a person. `Job.ranVia` is the upstream this run was forwarded to
 * (`anthropic`), set only on that path, and it is what says which of the
 * server's two lanes the run is in. Absent is the card, which is every run this
 * app has ever recorded.
 */
export function laneOfRun(
  ranOn: string | undefined,
  lanes: readonly ComputeLane[],
  ranVia?: string,
): ComputeLane | null {
  if (ranVia !== undefined && ranOn !== undefined) {
    return lanes.find((lane) => lane.name === upstreamLaneName(ranOn)) ?? null;
  }
  if (ranOn === undefined) return localLane(lanes);
  return lanes.find((lane) => lane.name === ranOn) ?? null;
}

/** Is this resource one of the counted lanes? A type guard, so callers narrow. */
export function isLane(resource: JobResource): resource is Lane {
  return resource === 'gpu' || resource === 'cpu';
}

/**
 * The lane this kind of job runs in, or null when it runs in neither.
 *
 * Null is two different facts — an install that holds every lane, and a mint
 * that holds none — and a caller that needs to tell them apart asks
 * `JOB_RESOURCE` directly. This is for the callers that only want a lane.
 */
export function laneOf(kind: JobKind): Lane | null {
  const resource = JOB_RESOURCE[kind];
  return isLane(resource) ? resource : null;
}
