/**
 * ONE SLOT SET PER MACHINE — the scheduler's whole capacity model.
 *
 * ── Why this replaced one global number ─────────────────────────────────────
 *
 * `RESOURCE_SLOTS.gpu` was 1, for the whole application. A book rendering on the
 * Mac held THIS machine's only GPU slot, so two books could never render on two
 * machines at once — which is the entire reason a second server is registered.
 * Owen, 2026-09-13 (crucible `docs/PHASE7-LANES.md` §2.4): *"if it's set to any,
 * bookforge will send the queue items to any open gpu. which means bookforge
 * will need one set of slots for each server. one gpu and two cpu slots for mac,
 * one gpu and two cpu for pc, etc."*
 *
 * So capacity is per MACHINE, and the sets are:
 *
 *     3090 Ti      [ gpu ] [ cpu ] [ cpu ]     ← a registered Crucible
 *     3090 Ti:cloud        [ cpu ] [ cpu ]     ← only if it HAS an upstream
 *     mac          [ gpu ] [ cpu ] [ cpu ]     ← another one
 *     mac:cloud            [ cpu ] [ cpu ]     ← only if IT has an upstream
 *     local-longform-align  [ gpu ]            ← ONLY while a step charges it
 *     local-work           [ cpu ] [ cpu ]     ← what BookForge does ITSELF
 *
 * ── THE CLOUD LANE, AND WHY IT HANGS OFF A SERVER ──────────────────────────
 *
 * Phase 15 (crucible `docs/PHASE15-HOST.md` §5.3): an engine can be configured
 * to forward one of the four llm classes to Anthropic, OpenAI or a remote
 * Ollama on the operator's account — a ROUTE, set before any request, never a
 * fallback. Such a run holds no card anywhere: it costs the engine a socket.
 *
 * A lane is drawn for an engine that HAS AN UPSTREAM CONFIGURED, and that is
 * {@link SlotSetFacts.upstreams}. See its own note for why that fact and not
 * the per-class route.
 *
 * Making it wait behind a nine-hour narration would be the queue punishing a
 * job for the company it keeps — the same argument that used to give a
 * `claude` pass a CPU pool, back when the provider was on the row. The fact
 * moved: it is the SERVER's route now, so the lane hangs off the server
 * ({@link cloudLaneOf}) rather than being one global cloud pool. Two books on
 * two engines can route the same class differently, and one pool would let a
 * Mac-routed translation block a PC-routed one for no reason.
 *
 * Its width is in the `cpu` counter and its `gpu` is 0, and both are literal:
 * the work occupies no card and what it does occupy is this queue's own
 * willingness to have two upstream requests outstanding per engine.
 *
 * ── WHERE THIS ENDS UP (Owen, 2026-09-14) ─────────────────────────────────
 *
 * *"there will never, ever be a local gpu configured. there simply wont be an
 * outlet for it."* The end state is exactly:
 *
 *     <server>     [ gpu ] [ cpu ] [ cpu ]     one per REGISTERED Crucible ENGINE
 *     <server>:cloud       [ cpu ] [ cpu ]     ONLY if it has an upstream
 *     local-work           [ cpu ] [ cpu ]     CPU slots stay local
 *
 * — ENGINE, because a registered address can also be an ORCHESTRATOR, which
 * serves no job types and has no card ({@link EngineRole}). It draws no row at
 * all; the engine it fronts draws one. Owen, 2026-09-15: *"crucible on windows
 * is a passthrough orchestrator so it shouldnt show up."*
 *
 * — and no more. Owen again, 2026-09-15: *"without a crucible server, there is
 * no gpu slot, because bookforge shouldnt know how to drive gpu work in-app …
 * even if that server is just a local windows install with no wsl engine."*
 *
 * {@link LONGFORM_ALIGN_SET} below is the one row that is not that, and it is
 * drawn ONLY WHEN SOMETHING IN THE QUEUE WOULD CHARGE IT
 * ({@link SlotSetFacts.alignerCharged}). With nothing charging it the bench is
 * exactly Owen's sentence: one GPU slot per registered server, plus
 * `local-work`'s two CPU slots, and no more.
 *
 * WHY IT IS CONDITIONAL RATHER THAN DELETED. This file used to push the row
 * unconditionally, and the argument for that was sound as far as it went: a GPU
 * step whose module has not been taught to travel spawns HERE, and with no set
 * to charge it {@link slotsOf} answers 0, so the scheduler finds nought slots
 * and never launches it. But that argument is about a step that EXISTS. So the
 * row exists exactly then, and the fact is computed by running
 * {@link slotSetForStep} — the function the scheduler itself allocates with —
 * over the snapshot's own steps, so the bench and the pump cannot come to
 * disagree about whether the row is there (crucible `docs/ARCHITECTURE.md` R1:
 * one fact, one owner).
 *
 * ONE thing sends GPU work there, as of 2026-09-15: **`generate-sentences` with
 * `method: 'epub-align'`** — the whole-audiobook forced alignment
 * (`electron/whisperx-align-bridge.ts`, `electron/scripts/align_audiobook.py`).
 * It is not a Crucible job because Crucible has no job of that SHAPE, not
 * because nobody wired it: the `align` job takes `chunks:[{index,text}]` and one
 * audio input PER chunk, which is a caller that ALREADY KNOWS which audio goes
 * with which text — and discovering that (a rough transcript of the whole m4b,
 * then a coarse DTW of the ebook's sentences onto it) is this act's middle stage
 * and most of its cost. `align-longform` is a Crucible job type that does not
 * exist; it is written up as a ruling in `docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7.
 *
 * A SECOND tenant was here until 2026-09-15 and is gone: **any render at all
 * while `legacyLocalRender` was on**. That switch and the whole local spawn
 * layer behind it are DELETED (docs/LEGACY-REMOVAL.md), which is why this row is
 * no longer named after the narrator.
 *
 * A third was listed until the same day: **`video-assembly`**
 * declared `resource: 'gpu'` with no comment and nobody had measured it. Read
 * end to end (`electron/video-assembly-bridge.ts`), it draws PNG frames in an
 * offscreen BrowserWindow and muxes them with `ffmpeg -c:v libx264` — a SOFTWARE
 * x264 encode, no NVENC, no hwaccel, no model. Owen's boundary is MODEL
 * INFERENCE vs DETERMINISTIC work, not GPU vs CPU, so it is `cpu` and charges
 * `local-work` like every other thing BookForge does itself.
 *
 * `tools/test-queue-slot-sets.js` pins the SHAPE: with nothing queued there is
 * no in-app GPU row at all, with an `epub-align` queued there is exactly one, and
 * every GPU row drawn is a registered server's bar that one named exception — so
 * a new in-app GPU venue has to come past that check.
 *
 * ── The correction, and it is the whole of what makes this safe ─────────────
 *
 * §2.4, quoted because the two readings look identical in a UI:
 *
 * > **A server's slots count what BOOKFORGE has in flight there. They are not a
 * > model of the server's capacity, and they are never read to decide whether
 * > the server is free.**
 *
 * "The Mac's GPU slot is occupied" means *I have a GPU step running on the Mac*.
 * It does NOT mean the Mac's card is free when the slot is empty — Foundry may
 * have it. **The server's `409 server_busy` remains the only authority on
 * admission** (crucible `docs/ARCHITECTURE.md` R5), and it arrives as a WAIT
 * through `shared/queue/wait-for.ts`. A free slot licenses an ATTEMPT, never an
 * assumption. Nothing here is cached and nothing here is polled: the count is of
 * BookForge's own outstanding work, which it cannot be wrong about.
 *
 * ── Why it is a pure module ─────────────────────────────────────────────────
 *
 * Same reason `wait-for.ts` is: the scheduler asks it inside a synchronous pump,
 * the bench draws from it in the renderer, and a keeper drives every branch with
 * no engine and no network. No I/O, no clock, no Electron.
 */

import { RETIRED_LOCAL_NARRATOR_VENUE } from './wait-for';
import { TERMINAL_STEP_STATUSES } from './engine-types';
import type { QueueJob, QueueStep, StepResource } from './engine-types';

/**
 * THE ONE GPU SET THAT IS NOT A REGISTERED SERVER — and what is left in it.
 *
 * It used to be called `legacy-local-narrator`, because the legacy render spawn
 * was its loudest tenant. That layer is DELETED (docs/LEGACY-REMOVAL.md), and
 * exactly ONE tenant remains: `generate-sentences` with `method: 'epub-align'`,
 * the whole-audiobook forced alignment (`electron/whisperx-align-bridge.ts`,
 * `electron/scripts/align_audiobook.py`).
 *
 * So the row is NAMED FOR IT. Keeping the old spelling would have left the bench
 * telling an operator their book is waiting for "the local narrator (legacy)"
 * when what it is waiting for is an aligner — a row that lies about its tenant
 * is exactly the duplicated-fact failure this layer is built to avoid.
 *
 * **The row is not deleted with the layer, and must not be.** `epub-align` is
 * UNMIGRATED rather than legacy: Crucible has no `align-longform` job type
 * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7, UNRULED — its `align` job takes one
 * audio input per chunk from a caller that already knows which seconds hold
 * which sentences, which is precisely what this act must DISCOVER). Delete the
 * row and that step charges a set with no slots, {@link slotsOf} answers 0, and
 * the scheduler never launches it with nothing to explain why. When §B7 is ruled
 * and built, the row empties on its own and this constant goes with it.
 */
export const LONGFORM_ALIGN_SET = 'local-longform-align';

/**
 * The set holding work BOOKFORGE DOES ITSELF and never sends anywhere —
 * assembly, muxing, an export landing, a hosted-API pass.
 *
 * §2.4 calls this row `local`. It is spelled `local-work` here, and it stays
 * spelled that way now that the reserved Crucible name `local` is gone (Owen's
 * ruling, 2026-09-15): this row is not a server and never was, and a bare
 * `local` beside a bench of machine names would read as one. It is also the
 * only meaning of the word left in the queue — `electron/crucible/servers.ts`
 * refuses a server called `local-work` for the same reason, from this constant.
 */
export const LOCAL_WORK_SET = 'local-work';

/** How many GPU steps BookForge may have in flight on ONE server. */
export const SERVER_GPU_SLOTS = 1;

/**
 * How many CPU steps BookForge may have in flight on one server: ZERO.
 *
 * §2.4's table gives a server `[cpu][cpu]` and says why in the same row:
 * *"**Zero today** — no CPU work is sent to a server yet, and the slots exist so
 * the bench and the model do not change when it is."* The design is two; the
 * realised number is nought, because no step module declares travelling CPU
 * work — `slotSetForStep` sends every `cpu` step to {@link LOCAL_WORK_SET}.
 *
 * It is nought rather than two so the bench cannot draw a lane the scheduler
 * will never fill (crucible `docs/ARCHITECTURE.md` R3: nothing is told "maybe").
 * When Crucible's ancillary lane exists (PHASE7-LANES §3), this one constant
 * becomes 2 and nothing else moves. Recorded as a ruling in
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md` §3.
 */
export const SERVER_CPU_SLOTS = 0;

/** How many CPU steps BookForge runs at once on its own machine. */
export const LOCAL_WORK_CPU_SLOTS = 2;

/**
 * How many upstream-routed runs BookForge keeps outstanding on ONE engine.
 *
 * Two, which is the same number `local-work` gets and for the same reason: it
 * is a latency lane, not a capacity model of somebody's API, and the queue's
 * own appetite is the only thing it can honestly bound. The engine's `409
 * server_busy` and the upstream's own `429` (passed through with `Retry-After`
 * — crucible PHASE15 §3.4, the CALLER waits) remain the only authorities.
 */
export const CLOUD_LANE_SLOTS = 2;

/**
 * The separator between an engine's name and its cloud lane.
 *
 * A registry name cannot contain it: `servers.ts`'s `validateServerName`
 * refuses a colon BY NAME and says this is why, and {@link LOCAL_WORK_SET} and
 * {@link LONGFORM_ALIGN_SET} carry none either. That is what makes
 * {@link serverOfCloudLane} the exact INVERSE of {@link cloudLaneOf} rather
 * than a guess at where to split.
 */
const CLOUD_LANE_SUFFIX = ':cloud';

/** One engine's cloud lane, by name. The one composer of that id. */
export function cloudLaneOf(server: string): string {
  return `${server}${CLOUD_LANE_SUFFIX}`;
}

/** Is this set id a cloud lane? */
export function isCloudLane(id: string): boolean {
  return id.endsWith(CLOUD_LANE_SUFFIX);
}

/** The engine a cloud lane belongs to, or `null` when the id is not one. */
export function serverOfCloudLane(id: string): string | null {
  return isCloudLane(id) ? id.slice(0, -CLOUD_LANE_SUFFIX.length) : null;
}

/**
 * A CAP RATHER THAN NO LIMIT, and it belongs to no machine.
 *
 * A `wait` step is not on any bench — its whole job is to sit until something
 * outside this queue happens (`StepResource`) — so it occupies no slot set. The
 * cap exists only so a runaway chain cannot admit thousands of steps at once.
 */
export const WAIT_STEP_CAP = 32;

/** One machine's worth of slots. */
export interface SlotSet {
  /**
   * A registered server's NAME, {@link LONGFORM_ALIGN_SET}, or
   * {@link LOCAL_WORK_SET}. It is what `slotSetForStep` returns, so the two
   * cannot drift.
   */
  readonly id: string;
  /** The set's heading on the bench — "mac", "BookForge itself". */
  readonly label: string;
  readonly gpu: number;
  readonly cpu: number;
  /**
   * This set takes no NEW work: its server was disabled or removed while
   * something of ours was still running there. §4.3 — a job that started on a machine finishes on that machine — so
   * the set stays on the bench until its occupant lands, and then it is gone.
   */
  readonly retiring: boolean;
  /**
   * DOES THIS SET'S WORK RUN ON THE CARD IN THIS BOX.
   *
   * True for {@link LONGFORM_ALIGN_SET} and for a registered server that answers
   * on loopback (the WSL engine on this PC is one); false for the Mac across the
   * tailnet, and for {@link LOCAL_WORK_SET}, which is CPU and has no card.
   *
   * On the SET rather than re-derived by each reader, because the fact is the
   * registry's and `shared/` cannot reach it. `bench.ts` drew the nvidia-smi
   * thermal reading on the aligner row ALONE until 2026-09-15 — its
   * `isThisMachine` tested only the aligner id and ignored its own snapshot
   * argument — so the temperature was missing from the row that actually renders
   * books on this card, and present on a row that is usually empty.
   *
   * The same fact decides the cross-set GPU hold (`gpuHeldElsewhere` below), so
   * carrying it once is what stops the bench and the scheduler disagreeing about
   * which machine a row is on.
   */
  readonly onThisMachine: boolean;
}

/**
 * How a set's id reads as a heading.
 *
 * {@link LONGFORM_ALIGN_SET}'s heading names the WORK, deliberately: it would be
 * useful to say WHY it is there — "the local long-form aligner — aligning
 * Mistborn against its EPUB" — but a {@link SlotSet} has a
 * heading and nothing else, and `BenchLane.hold` is already the sentence for a
 * different fact (admission refusing a FREE lane). Inventing a second sentence
 * field for one row is a change to what a bench row IS, which is not this. The
 * row's reason is instead readable where it already lives: the occupant, or
 * `stillReason`'s sentence on the row waiting for it.
 */
function labelFor(id: string): string {
  if (id === LOCAL_WORK_SET) return 'BookForge itself';
  if (id === LONGFORM_ALIGN_SET) return 'the local long-form aligner';
  const cloud = serverOfCloudLane(id);
  if (cloud !== null) return `${cloud} — routed elsewhere`;
  return id;
}

/**
 * WHICH SET A STEP COUNTS AGAINST, or `null` when nothing can say yet.
 *
 * Every line is a different fact, and the order is the order of certainty:
 *
 *  1. A `wait` step is on no bench at all, so it belongs to no set.
 *  2. A `cpu` step is work BookForge does itself. No step module declares
 *     travelling CPU work (see {@link SERVER_CPU_SLOTS}), so this is not a
 *     default — it is the complete answer.
 *  3. A GPU step that has been ADMITTED carries the venue it was admitted to
 *     ({@link QueueStep.venue}, written once by the pump). That is the record,
 *     and it outranks everything below it: a step already running on the Mac
 *     counts against the Mac even if the row has since been re-pointed.
 *
 *     THE STEP IS INDIVISIBLE, and this line is where that is enforced. Owen,
 *     2026-09-15: *"The entire tts step goes to the other system. That includes
 *     anything the step needs to do even if it's cpu."* A render prepares its
 *     text, packs its chunks and writes its session as part of the one step, and
 *     none of that is charged anywhere but the venue: the step holds ONE slot,
 *     the venue's, for its whole duration. Asking `resource` before `venue`
 *     would be the door through which a venued step's CPU half could land in
 *     {@link LOCAL_WORK_SET} — this machine, which is not where it ran — so the
 *     order is load-bearing twice over (the cloud lane is the other reason,
 *     below).
 *  4. A GPU step whose module has NOT been taught to travel spawns on this
 *     machine, always — {@link LONGFORM_ALIGN_SET}, whatever its run says.
 *  5. A GPU step of a run already assigned follows the run (§4.4, one book one
 *     GPU), which is what lets the bench say why a queued row is waiting before
 *     the pump has admitted it.
 *  6. Otherwise nothing can say. `null` is a real answer and not an error: the
 *     row has not been routed yet, and admission will say so in its own words
 *     rather than this guessing at a machine.
 */
export function slotSetForStep(job: QueueJob, step: QueueStep): string | null {
  if (step.resource === 'wait') return null;
  /*
   * THE RECORD OUTRANKS THE KIND OF WORK, and that reordering is what lets a
   * cloud lane exist at all.
   *
   * A step admitted to an engine that ROUTES its class upstream is written
   * with that engine's cloud lane as its venue and `cpu` as its resource, both
   * at the one moment both facts are known (the pump, `crucibleAdmission`) —
   * the route belongs to the SERVER, so it is unknowable at enqueue, when the
   * server has not been chosen. Asking `resource` first would have sent it to
   * `local-work`, which is this machine, which is not where it ran.
   *
   * Nothing else moves: a plain `cpu` step is never given a venue, so it still
   * falls to `local-work` on the very next line.
   */
  if (step.venue !== undefined) {
    /*
     * ONE SPELLING MIGRATION, and it is about a FILE rather than a decision: a
     * queue written before 2026-09-15 stamped this machine's non-travelling GPU
     * set `legacy-local-narrator`. The set is the same set under a truthful
     * name, so an old step is read into it rather than being stranded on an id
     * the bench no longer draws.
     */
    return step.venue === RETIRED_LOCAL_NARRATOR_VENUE ? LONGFORM_ALIGN_SET : step.venue;
  }
  if (step.resource === 'cpu') return LOCAL_WORK_SET;
  if (step.travels !== true) return LONGFORM_ALIGN_SET;
  return job.waitForResolved ?? null;
}

/** What BookForge has in flight, per set. Counted, never polled. */
export interface SetOccupancy {
  gpu: number;
  cpu: number;
}

/**
 * BookForge's own outstanding work, counted off the snapshot.
 *
 * Off the JOBS rather than off the engine's `runningSteps` map so the bench and
 * the scheduler read ONE fact (crucible `docs/ARCHITECTURE.md` R1). The
 * argument is the jobs alone, not a whole snapshot, so the engine can ask
 * inside its pump without deep-copying itself first.
 */
export function slotSetOccupancy(
  snapshot: { readonly jobs: readonly QueueJob[] },
): Map<string, SetOccupancy> {
  const counts = new Map<string, SetOccupancy>();
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'running') continue;
      const id = slotSetForStep(job, step);
      if (id === null) continue;
      const entry = counts.get(id) ?? { gpu: 0, cpu: 0 };
      if (step.resource === 'gpu') entry.gpu += 1;
      else if (step.resource === 'cpu') entry.cpu += 1;
      counts.set(id, entry);
    }
  }
  return counts;
}

/**
 * IS THERE ANYTHING IN THIS QUEUE THAT CAN ONLY RUN ON THIS MACHINE'S CARD?
 *
 * The one owner of the question that row's existence turns on, and it is
 * answered with {@link slotSetForStep} — the very function the scheduler
 * allocates with — rather than by listing the step kinds that charge it. A list
 * would be a second opinion about a decision `slotSetForStep` already makes, and
 * the two would drift the first time a module's `machines()` changed (crucible
 * `docs/ARCHITECTURE.md` R1).
 *
 * EVERY STEP THAT IS NOT TERMINAL COUNTS, held ones included. The row means
 * *this queue holds work that can only run here*, and a held step is such work:
 * deciding it on `queued` alone would make the lane appear at the instant the
 * user pressed Start, which is a bench that changes because it was looked at.
 * A step that has finished, failed or been cancelled charges nothing, and that
 * is what empties the row.
 *
 * Off the JOBS, like {@link slotSetOccupancy} and for the same reason: the pump
 * asks it inside a synchronous pass without deep-copying itself first, and the
 * bench draws the answer it gave.
 */
export function longformAlignCharged(
  snapshot: { readonly jobs: readonly QueueJob[] },
): boolean {
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
      if (slotSetForStep(job, step) === LONGFORM_ALIGN_SET) return true;
    }
  }
  return false;
}

/**
 * WHETHER ONE ENGINE CAN SEND WORK ELSEWHERE AT ALL — three values, and the
 * third is not a shrug.
 *
 * `configured` — at least one of its three upstreams has a key or a url on it
 * (`GET /v1/settings`'s `upstreams[*].configured`, crucible
 * `docs/PHASE15-HOST.md` §3.1). The engine CAN forward a class, whether or not
 * any class is routed today.
 *
 * `none` — the document was read and all three are unconfigured. There is
 * nowhere for that engine to forward anything, so a lane on the bench would be
 * a row the scheduler can never fill (crucible `docs/ARCHITECTURE.md` R3:
 * nothing is told "maybe").
 *
 * `unknown` — nobody has read that engine's settings yet, it did not answer, or
 * it predates the settings door. **Absence of knowledge is not absence of an
 * upstream**, so an unknown engine keeps the lane it has always had.
 */
export type EngineUpstreams = 'configured' | 'none' | 'unknown';

/**
 * WHICH HALF OF THE ORCHESTRATOR/ENGINE RELATION A REGISTERED NAME IS — and
 * therefore whether it has a card at all.
 *
 * crucible `docs/PHASE17-ORCHESTRATOR.md` §1: a Crucible process declares a
 * `role`. An `engine` serves job types on a backend. An `orchestrator` has
 * backend kind `orchestrator`, **zero job types**, manages exactly one engine,
 * and reads capability THROUGH to it. Owen, 2026-09-15: *"crucible on windows
 * is a passthrough orchestrator so it shouldnt show up."*
 *
 * `engine` — it runs the work itself. One GPU row, which is the row this bench
 * has always drawn.
 *
 * `orchestrator` — it runs NOTHING. A GPU row for it is a lane the scheduler
 * could place work into that nothing can serve, and the refusal would come from
 * the engine's own door (`job_type_not_served`) rather than from the bench. So
 * it draws no row and no lane. The row belongs to the ENGINE it fronts, which
 * this app reaches under its own registered name — on Windows the connect code
 * the host leaves names the WSL engine and not the tray process in front of it.
 * An orchestrator registered ALONGSIDE its engine therefore adds nothing and
 * removes nothing: the card is counted once, by the half that has it.
 *
 * `unknown` — nobody has read that server's `/v1/info` yet, or it did not
 * answer. **Absence of knowledge is not absence of an engine**, and every
 * pre-Phase-17 Crucible reads as `engine` the moment it is asked, so an unknown
 * server keeps the row it has always had rather than vanishing off the bench
 * for the one tick before the read lands.
 */
export type EngineRole = 'engine' | 'orchestrator' | 'unknown';

export interface SlotSetFacts {
  /**
   * Every ENABLED registered server, in rank order — and since 2026-09-15 that
   * is every server there is, wherever it answers. A disabled one contributes no
   * set: §4.2.2's enable switch is a capacity switch, so turning it off takes its
   * slots away and new claims stop going there.
   */
  readonly enabledServers: readonly string[];
  /**
   * PER ENGINE: can it send work elsewhere at all. One entry for every name in
   * {@link enabledServers} — a name missing from here is REFUSED BY NAME rather
   * than assumed either way, because the two guesses are a lane that never
   * fills and a lane that vanishes under a running row.
   *
   * ── WHY THIS FACT AND NOT THE PER-CLASS ROUTE ─────────────────────────────
   *
   * The lane used to be drawn unconditionally, and the argument for that was
   * sound as far as it went: whether a particular class is routed upstream is
   * the ENGINE's setting, it can change between two pumps from the engine's own
   * page or from the other app, and a lane that appeared and vanished with it
   * would make the bench flicker and make a row's placement depend on when the
   * scheduler last happened to read. The capability record's `route` field
   * (`electron/crucible/routes.ts`) is the fact that argument is about, and it
   * is the one already in hand — coordination reads `GET /v1/capability` on
   * every connect, so deriving "some class is routed" from it costs nothing.
   *
   * It is still the wrong fact, and Owen ruled on the level rather than the
   * mechanism (2026-09-15): *"local shouldnt be an option because it's driven
   * fully and completely through crucible"* — a bench row must correspond to
   * something real. "Some class happens to be routed right now" is a setting an
   * operator flips while reading a book; "this engine has an upstream" is a
   * deliberate, rare act (a key pasted into a field, tested, saved). So the
   * same anti-flicker argument is kept and raised one level: the lane exists
   * exactly when the engine CAN forward work, which is stable across the
   * route changes that used to be the worry, and which is true of every engine
   * on which a route could be set at all — `route_upstream_unconfigured` (§3.2)
   * is the server refusing to route a class to an upstream it has not got, so
   * `configured` is implied by any route and never the other way round. A lane
   * cannot be stranded under a running row by this: both facts are read at the
   * same two moments (coordination, and a settings write's own answer), so they
   * cannot come to disagree about one engine.
   *
   * The cost is one extra read of a document the app already speaks, at a
   * moment it is already talking to that machine. That is what buys a bench
   * with no rows on it that nothing can ever use.
   */
  readonly upstreams: Readonly<Record<string, EngineUpstreams>>;
  /**
   * WHICH OF THEM IS AN ORCHESTRATOR AND THEREFORE HAS NO CARD —
   * {@link EngineRole}, one entry per enabled server, and the reason a row is
   * not drawn for a process that serves no job types.
   *
   * Read at the one moment it can be known — `GET /v1/info`, which coordination
   * already makes on every connect — and held in `electron/crucible/routes.ts`
   * beside the other two facts this bench is composed from, because the
   * scheduler answers it inside a synchronous pump.
   *
   * It is a fact about the PROCESS and not about the install: on a Windows
   * machine one Crucible install runs an orchestrator and an engine as two
   * processes on two ports, and only one of them answers any given `/v1/info`.
   * So the question is asked of the ADDRESS this app has registered, never of
   * the machine.
   */
  readonly roles: Readonly<Record<string, EngineRole>>;
  /**
   * Set ids that currently hold something of ours. A set named here survives
   * even when its server was disabled or removed, marked `retiring` — §4.3.
   */
  readonly occupied: readonly string[];
  /**
   * DOES ANYTHING IN THE SNAPSHOT CHARGE {@link LONGFORM_ALIGN_SET} —
   * {@link longformAlignCharged}.
   *
   * Owen, 2026-09-15: *"we would have as many gpu slots as we have connected
   * crucible serves … without a crucible server, there is no gpu slot, because
   * bookforge shouldnt know how to drive gpu work in-app."* So the one GPU row
   * that is not a server's is drawn only while a step exists that can be run
   * nowhere else, and is absent otherwise.
   *
   * Passed IN rather than derived here because this module never sees the
   * snapshot: `slotSets` takes facts, not jobs, which is what lets a keeper drive
   * every branch with no engine. The caller computes it with
   * {@link longformAlignCharged} so there is still exactly one owner of the
   * question — a caller that answered it its own way would be the bench and the
   * pump disagreeing about a row.
   *
   * It covers RUNNING steps as well as queued ones, which is why that set is
   * never reached by the `occupied` pass below: a row that is drawn because
   * something of ours is on it must not be marked `retiring`, because the local
   * aligner is not retiring — it takes new work until §B7 is built.
   *
   * Decided ONCE per snapshot by the caller, so a row cannot appear and vanish
   * between two steps of one pump.
   */
  readonly alignerCharged: boolean;
  /**
   * The registered servers that answer on THIS machine (loopback), as
   * `electron/crucible/servers.ts`'s `serversOnThisMachine()` reports them.
   * Required, like `upstreams` and `roles`: the two guesses are "no row shows a
   * temperature" and "the Mac's row shows this PC's fan speed", and neither is
   * a thing to decide on a caller's behalf.
   */
  readonly serversOnThisMachine: readonly string[];
}

/**
 * EVERY SLOT SET THAT EXISTS RIGHT NOW, in a stable order: the servers in rank
 * order, then the local long-form aligner, then BookForge's own work last.
 *
 * `local-work` is always present and is never retiring: a machine with no
 * Crucible server at all still assembles and muxes, and a bench with no row on
 * it would say the queue can do nothing.
 */
export function slotSets(facts: SlotSetFacts): SlotSet[] {
  const sets: SlotSet[] = [];
  const seen = new Set<string>();

  /*
   * A CALLER THAT SAID NOTHING ABOUT UPSTREAMS IS REFUSED, not defaulted. The
   * type says the field is required, which settles it for every TypeScript
   * caller; this is for the ones the compiler does not see — the keepers, the
   * CLI, anything driving the pure module from plain JS — because the two
   * guesses available here are "draw a lane nothing can fill" and "hide a lane
   * a running row is on", and neither is a thing to decide on somebody's behalf.
   */
  if (facts.upstreams === undefined || facts.upstreams === null) {
    throw new Error(
      'slotSets: `upstreams` was not supplied. Every enabled server needs one of '
        + "'configured' | 'none' | 'unknown', because a cloud lane is drawn for an engine that "
        + 'CAN forward work and for one nobody has asked yet, and for no other.',
    );
  }

  /*
   * AND A CALLER THAT SAID NOTHING ABOUT WHICH SERVERS ARE HERE IS REFUSED TOO.
   * The two guesses are "no row shows a temperature" and "the Mac's row shows
   * this PC's fan speed", and the second is worse than the first: a reading
   * labelled as somebody else's hardware is a number a person will act on.
   */
  if (facts.serversOnThisMachine === undefined || facts.serversOnThisMachine === null) {
    throw new Error(
      'slotSets: `serversOnThisMachine` was not supplied. A set has to know whether its '
        + "work runs on the card in this box — the thermal reading is nvidia-smi's, taken "
        + "here, and drawing it on a remote engine's row would be this PC's fan speed "
        + "labelled as the Mac's.",
    );
  }

  /*
   * AND A CALLER THAT SAID NOTHING ABOUT ROLES IS REFUSED THE SAME WAY. The two
   * guesses here are "draw a GPU row for a process that serves no job types" —
   * a lane nothing can fill, which is the defect the fact exists to close — and
   * "hide the row of every engine nobody has asked yet", which empties the bench
   * at every launch. Neither is a thing to decide on a caller's behalf.
   */
  if (facts.roles === undefined || facts.roles === null) {
    throw new Error(
      'slotSets: `roles` was not supplied. Every enabled server needs one of '
        + "'engine' | 'orchestrator' | 'unknown', because an orchestrator serves no job types "
        + 'and must not be drawn a card, while an engine — and a server nobody has asked yet — '
        + 'gets exactly one.',
    );
  }

  /*
   * AND A CALLER THAT SAID NOTHING ABOUT THAT ROW IS REFUSED TOO, for
   * the same reason and with the same two bad guesses: `true` draws a GPU row
   * Owen has ruled must not exist without a Crucible server behind it, and
   * `false` strands a step that can run nowhere else on a set with nought slots,
   * which the scheduler would never launch and nothing would explain.
   */
  if (typeof facts.alignerCharged !== 'boolean') {
    throw new Error(
      'slotSets: `alignerCharged` was not supplied. Compute it with '
        + '`longformAlignCharged(snapshot)` — the in-app GPU row exists exactly while something '
        + 'in the queue charges it, and neither guess is a thing to make on a caller\'s behalf.',
    );
  }
  /*
   * AND THE TWO FACTS MUST AGREE ABOUT THIS ROW. `longformAlignCharged` counts
   * running steps as well as queued ones, so a caller holding something on the
   * local aligner cannot honestly answer `false` — and if one did, the occupied
   * pass below would draw the row `retiring`, which says "this set takes no new
   * work" about the one set that always does while the layer exists. Refused by
   * name rather than reconciled.
   */
  if (!facts.alignerCharged && facts.occupied.includes(LONGFORM_ALIGN_SET)) {
    throw new Error(
      'slotSets: `occupied` says the local long-form aligner is holding something of ours while '
        + '`alignerCharged` says nothing charges it. Both are read off the same steps — compute '
        + 'the second with `longformAlignCharged(snapshot)` rather than by hand.',
    );
  }

  for (const name of facts.enabledServers) {
    if (seen.has(name)) continue;

    /*
     * AN ORCHESTRATOR DRAWS NOTHING — not a card, and not a cloud lane either.
     * PHASE17 §1: it serves zero job types and manages one engine, so every row
     * it could be given is a row the scheduler could claim into and nothing
     * could serve. The engine it fronts draws the row, under the name this app
     * has registered for the engine itself.
     *
     * NOT marked `seen`, for the reason the absent cloud lane is not: if that
     * address is somehow holding something of ours, the occupied pass below
     * still draws it `retiring`, so the occupant keeps its slot and nothing new
     * is placed there. A row is never yanked out from under a running step.
     */
    const role = facts.roles[name];
    if (role === undefined) {
      throw new Error(
        `slotSets: nothing was said about whether "${name}" is an engine or an orchestrator. `
          + 'Every enabled server needs an entry in `roles` — a name with no entry is a caller '
          + 'that forgot, not a server with no role.',
      );
    }
    if (role === 'orchestrator') continue;

    seen.add(name);
    sets.push({
      id: name,
      label: labelFor(name),
      gpu: SERVER_GPU_SLOTS,
      cpu: SERVER_CPU_SLOTS,
      retiring: false,
      onThisMachine: facts.serversOnThisMachine.includes(name),
    });
    /*
     * ITS CLOUD LANE — WHEN THE ENGINE HAS SOMEWHERE TO SEND WORK, and still
     * not conditional on a particular class being routed there today. The whole
     * argument, and why this is one level up from the route, is on
     * {@link SlotSetFacts.upstreams}.
     */
    const upstreams = facts.upstreams[name];
    if (upstreams === undefined) {
      throw new Error(
        `slotSets: nothing was said about whether "${name}" has an upstream configured. `
          + 'Every enabled server needs an entry in `upstreams` — a name with no entry is a '
          + 'caller that forgot, not an engine with no upstream.',
      );
    }
    /*
     * `none` DRAWS NOTHING, and the lane is not marked `seen` either: should
     * that engine somehow be holding a routed row of ours, the occupied pass
     * below still draws its lane, `retiring`, so the occupant keeps its slot
     * and nothing new is placed there.
     */
    if (upstreams !== 'none') {
      const lane = cloudLaneOf(name);
      seen.add(lane);
      sets.push({
        id: lane,
        label: labelFor(lane),
        // No card. Not "a card we are not counting" — there is none: the engine
        // forwards the request and settles nothing.
        gpu: 0,
        cpu: CLOUD_LANE_SLOTS,
        retiring: false,
        // A CLOUD LANE IS NEVER THIS MACHINE'S CARD, even for an engine that is
        // on it: the work runs on somebody's API and the engine forwarding it
        // holds nothing. Same rule `gpuHeldElsewhere` states one screen down.
        onThisMachine: false,
      });
    }
  }

  /*
   * THE IN-APP GPU ROW IS HERE WHEN SOMETHING CHARGES IT, and never otherwise.
   *
   * What decides it is whether the QUEUE holds such a step at all — the caller's
   * {@link longformAlignCharged}, computed with `slotSetForStep`, so the row is
   * present for exactly the steps the scheduler would send here and for no
   * others.
   *
   * With the row absent, `slotsOf` answers 0 for it — which is the correct
   * answer, because in that state nothing is asking: a step that would charge it
   * makes the row appear in the same snapshot it appears in.
   *
   * Its gpu slot is ONE, which is what keeps it behaving exactly as it did under
   * the old global number. What removes the row for good is §B7 — a Crucible
   * `align-longform` job type, Owen's ruling.
   */
  if (facts.alignerCharged && !seen.has(LONGFORM_ALIGN_SET)) {
    seen.add(LONGFORM_ALIGN_SET);
    sets.push({
      id: LONGFORM_ALIGN_SET,
      label: labelFor(LONGFORM_ALIGN_SET),
      onThisMachine: true,
      gpu: SERVER_GPU_SLOTS,
      // This row is a GPU venue and nothing else: CPU work has never gone
      // through it, and giving it a CPU lane would invent a second home for
      // work `local-work` already owns.
      cpu: 0,
      retiring: false,
    });
  }

  /*
   * A set nobody may claim into, kept alive by its occupant alone. Only a
   * SERVER's set or a cloud lane can reach here: {@link LONGFORM_ALIGN_SET} is
   * drawn above whenever anything of ours is on it (that is what charges it), and the two
   * facts are checked against each other at the top rather than papered over
   * with a third branch in this expression.
   */
  for (const id of facts.occupied) {
    if (id === LOCAL_WORK_SET || seen.has(id)) continue;
    seen.add(id);
    const cloud = isCloudLane(id);
    sets.push({
      id,
      label: labelFor(id),
      gpu: cloud ? 0 : SERVER_GPU_SLOTS,
      cpu: cloud ? CLOUD_LANE_SLOTS : SERVER_CPU_SLOTS,
      retiring: true,
      // A retiring set's server may have been REMOVED from the registry, so it
      // is not in `serversOnThisMachine` any more. Its running occupant is still
      // wherever it started (§4.3), and a cloud lane is never here.
      onThisMachine: !cloud && facts.serversOnThisMachine.includes(id),
    });
  }

  sets.push({
    id: LOCAL_WORK_SET,
    label: labelFor(LOCAL_WORK_SET),
    gpu: 0,
    cpu: LOCAL_WORK_CPU_SLOTS,
    // BookForge itself: CPU work, and no card to report a temperature for.
    onThisMachine: false,
    retiring: false,
  });

  return sets;
}

/**
 * THIS MACHINE HAS ONE CARD, and more than one slot set can point at it.
 *
 * BookForge still has a GPU tenant of its own — the long-form aligner
 * ({@link LONGFORM_ALIGN_SET}) — and a Crucible server that answers on this
 * machine's loopback is the SAME 3090 Ti under a different set. As separate sets
 * they each have a GPU slot, so without this rule the scheduler could start an
 * `epub-align` and a render on that engine at the same moment, which the single
 * global `gpu: 1` used to prevent by accident. It is stated here rather than
 * rediscovered on a card running two models.
 *
 * ── `serversOnThisMachine` IS NOT A KIND OF SERVER ───────────────────────
 *
 * Owen's ruling of 2026-09-15 deleted the reserved name `local` and with it the
 * idea that a server here is a different sort of thing. It is not: it is added,
 * named, ranked, coordinated with and drawn exactly like any other. This
 * parameter answers one narrow question that is about THIS APP'S OWN CARD —
 * *does the venue I am about to use share the card my aligner runs on* — and the
 * caller answers it from the address (`electron/crucible/discovery.ts`,
 * `isLoopbackUrl`, which says what that reading does and does not promise).
 *
 * It is a LIST because a machine can legitimately have two: a Windows box runs
 * an orchestrator and a WSL engine on two loopback ports, and both may be
 * registered.
 *
 * ENDS WHEN long-form alignment becomes a Crucible job
 * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7). With no in-app GPU tenant there is no
 * second venue over this machine's card and this rule has nothing left to say.
 *
 * Returns the OTHER set id already using this machine's card, or `null` when
 * nothing is. A venue that is not on this machine answers `null` immediately:
 * its card is not this one, which is the whole point of the per-server sets.
 *
 * NOT the same question as `external-gpu-job.lock` and the GPU arbiter, which
 * are about holders OUTSIDE this queue (a training chain). Whether a Crucible
 * here should replace those two is item A4 of
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md` §0b — a ruling, not this.
 */
export function thisMachinesCardHeldBy(options: {
  /** The venue the step is about to run at. */
  readonly venue: string;
  /** Registered servers that answer on this machine's loopback. See above. */
  readonly serversOnThisMachine: readonly string[];
  readonly occupancy: ReadonlyMap<string, SetOccupancy>;
}): string | null {
  const { venue, serversOnThisMachine, occupancy } = options;
  /*
   * A CLOUD LANE IS NEVER THIS MACHINE'S CARD, even for an engine that is on it.
   * The work runs on somebody's API; the engine forwarding it holds nothing.
   * Answered first so `<server>:cloud` cannot be mistaken for `<server>`.
   */
  if (isCloudLane(venue)) return null;
  const here: string[] = [LONGFORM_ALIGN_SET, ...serversOnThisMachine];
  if (!here.includes(venue)) return null;
  for (const id of here) {
    if (id === venue) continue;
    if ((occupancy.get(id)?.gpu ?? 0) > 0) return id;
  }
  return null;
}

/**
 * How many slots of `resource` a set has, or 0 when the set is not on the bench.
 *
 * Zero for an unknown set is the honest number: a set that does not exist has no
 * room, so a claim against it waits rather than launching into a machine the
 * queue is not tracking.
 */
export function slotsOf(sets: readonly SlotSet[], id: string, resource: StepResource): number {
  if (resource === 'wait') return WAIT_STEP_CAP;
  const set = sets.find((entry) => entry.id === id);
  if (set === undefined) return 0;
  return resource === 'gpu' ? set.gpu : set.cpu;
}
