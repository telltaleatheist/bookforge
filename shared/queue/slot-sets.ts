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
  /** The set's heading on the bench — "mac", "CPU slots". */
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
   * THE OPERATOR SWITCHED THIS ONE OFF — `routing.disabled`, the same flag the
   * Settings panel has always written and `decideWaitFor` has always honoured
   * (`holdDisabled`, and `any` only ever tries enabled rows). Nothing about
   * where work goes changes here.
   *
   * What changes is that it is DRAWN. A disabled server used to be filtered out
   * of the ranked list before this function ever saw it, so the row vanished —
   * and a card you own silently missing from the bench is indistinguishable
   * from one BookForge cannot see, which is the reading somebody debugs for
   * twenty minutes. It is now a greyed lane with its switch on it, which says
   * both things at once: this machine exists, and you are the reason it is idle.
   *
   * NOT `retiring`. That means "finishing what it holds and then gone", a
   * transition nobody chose and cannot undo; this is a switch, and the row it
   * draws is waiting to be switched back.
   */
  readonly disabled: boolean;
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
  // Owen, 2026-09-15: *"it shouldnt be called 'BookForge itself', it can be
  // called 'CPU slots'."* The old name answered "whose slots are these"; the
  // question somebody actually has in front of the bench is "what runs here".
  if (id === LOCAL_WORK_SET) return 'CPU slots';
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
export function slotSetForStep(
  job: QueueJob,
  step: QueueStep,
): string | null {
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
    const recorded = step.venue === RETIRED_LOCAL_NARRATOR_VENUE
      ? LONGFORM_ALIGN_SET : step.venue;
    return recorded;
  }
  if (step.resource === 'cpu') return LOCAL_WORK_SET;
  if (step.travels !== true) return LONGFORM_ALIGN_SET;
  return job.waitForResolved ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// A BOOK IS ATOMIC ON THE CARD
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE SERVER A BOOK IS HOLDING BETWEEN ITS GPU STEPS — Owen's ruling of
 * 2026-09-20, in one derived fact.
 *
 * ── What he watched ────────────────────────────────────────────────────────
 *
 * *Mistborn* finished its render, moved to the CPU for the session copy, and
 * then queued for the card it had just been on: *"Waiting for
 * crucible@<the Mac>: busy: bookforge crucible-client/1.0.6, tts
 * mistborn, 99% done — 80 of 81 chunk(s) rendered"*. The book was parked on its
 * OWN render's tail. The ruling:
 *
 * > i want books to be atomic actions, ideally, where they keep the GPU until
 * > all of their GPU steps are complete. they can run the preparation step
 * > locally before going to the GPU, but CPU steps that might take place
 * > between GPU steps are very small and fast. they shouldnt lose their GPU
 * > slot because theyre doing a quick step.
 *
 * So the unit that occupies a card is the BOOK, not the step: from the moment
 * one travelling GPU step of a run has started until the last of them is
 * terminal, that run holds {@link QueueJob.waitForResolved}'s slot — through
 * the render's CPU tail, through the gap between one GPU step settling and the
 * next launching, through a local pass in between. `handOverGpuSlot`
 * (electron/queue-engine.ts) is unchanged and still fires: it is POOL
 * bookkeeping, because the session copy is CPU work and the bench must say so.
 * What it no longer does is free the card.
 *
 * ── Why it is DERIVED and never stored ─────────────────────────────────────
 *
 * A `holdsGpu` flag on the job would be a second owner of what the steps
 * already say (crucible `docs/ARCHITECTURE.md` R1), and the two would disagree
 * the first moment anything settled a step without remembering to clear it: a
 * crash between the last step landing and the flag being cleared would strand a
 * card until the app was restarted, and `queue.json` restored from disk would
 * carry the stale flag straight back. Derived, the hold cannot be stale — it is
 * read off the same statuses the pump and the bench read, and every door that
 * ends a run (settle, cancel, retry, return-to-Pending, remove) ends the hold
 * by doing what it already does.
 *
 * ── The two halves, and what each rules out ────────────────────────────────
 *
 * (a) STARTED — a travelling GPU step of this run is `running` or `done`. A run
 *     whose render has not begun holds nothing: `prepare` is local work and
 *     Owen's ruling says so in as many words ("they can run the preparation
 *     step locally before going to the GPU"). `failed` and `cancelled` are not
 *     starts either — the run is over, and a hold that survived a failure would
 *     be a card held for work that will never run.
 * (b) OUTSTANDING — a travelling GPU step of this run is RELEASED and not
 *     terminal (`queued`, `waiting`, `running`). `held` is deliberately not
 *     outstanding: a held step is one the queue will not start on its own (a
 *     user Stop lands there), so a card kept for it would be a card kept for an
 *     act nobody has ordered, with nothing on screen counting down. Pause is
 *     the opposite case and KEEPS the hold — a paused queue starts nothing but
 *     its steps are still `queued`, and the book is still mid-flight.
 *
 * A NON-TRAVELLING GPU STEP NEITHER STARTS NOR EXTENDS A HOLD. A local RVC or
 * denoise pass runs on {@link LONGFORM_ALIGN_SET}, this machine's own row; it
 * has never been on the server's card and claiming its slot for one would be
 * this app holding somebody's engine for work it is doing itself.
 *
 * The set charged is the run's ASSIGNED SERVER — the same id
 * {@link slotSetForStep} answers for a travelling step of this run that has no
 * venue yet, so the hold and the queued row it covers are counted on one row.
 *
 * ── The one shape this does not reach, stated so nobody rediscovers it ─────
 *
 * A run assigned to an ORCHESTRATOR ALIAS. `waitForResolved` is the registered
 * name the operator chose; the step's `venue` is that name folded onto the
 * engine's own lane (`engineLaneId`, electron/queue-engine.ts), and the two
 * differ only there. The hold is then charged to a row the bench does not draw,
 * so on such a machine the ruling simply does not bite — the book behaves as it
 * did before 2026-09-20. It is never WRONG (nothing else is charged either),
 * and it is the same mismatch a queued travelling row of that run has always
 * had, which is why it is not fixed here: folding a name onto a lane is the
 * engine's knowledge, and this module is pure by design.
 */
export function gpuHoldOf(job: QueueJob): { readonly server: string } | null {
  const server = job.waitForResolved;
  if (server === undefined) return null;
  /*
   * NOT A SERVER, so there is no card to hold. A row assigned to the deleted
   * narrator spawn holds with its own sentence (`wait-for.ts`); reading it as a
   * machine name here would charge a slot set nothing is on.
   */
  if (server === RETIRED_LOCAL_NARRATOR_VENUE) return null;
  let started = false;
  let outstanding = false;
  for (const step of job.steps) {
    if (!isTravellingGpuStep(step)) continue;
    if (step.status === 'running' || step.status === 'done') started = true;
    if (step.status === 'queued' || step.status === 'waiting' || step.status === 'running') {
      outstanding = true;
    }
  }
  return started && outstanding ? { server } : null;
}

/**
 * IS THIS STEP ONE OF THE RUN'S GPU ACTS ON A SERVER?
 *
 * `travels` is the whole answer, because a travelling step is GPU work BY
 * CONSTRUCTION: no module declares travelling CPU work ({@link
 * SERVER_CPU_SLOTS}), and the one that could have — a Foundry rendering —
 * declares `local` precisely when its resource is `cpu`
 * (`electron/queue-steps/foundry-job.ts`).
 *
 * So `resource` is NOT asked, and that is the point: the render's hand-over
 * recharges the step to `cpu` the moment its last chunk lands, and a hold that
 * read `resource` would end exactly where Owen's ruling says it must not. The
 * ONE case where a travelling step is genuinely not on a card is an
 * upstream-routed act (crucible `docs/PHASE15-HOST.md` §5.3), which is written
 * with its engine's cloud lane as its venue — it costs the engine a socket, so
 * it holds no card and cannot hold one for the book either.
 */
function isTravellingGpuStep(step: QueueStep): boolean {
  if (step.travels !== true) return false;
  if (step.venue !== undefined && isCloudLane(step.venue)) return false;
  return true;
}

/**
 * DOES THIS RUN'S HOLD CHARGE THIS SET'S CARD RIGHT NOW — the one owner of the
 * question, asked by the occupancy count, the bench and the pump alike.
 *
 * False when one of the run's own steps is ALREADY charging a GPU there: the
 * hold covers the GAPS, and a book cannot take one server's single slot twice.
 * That is also what keeps the hand-over honest — while the render is on the
 * card the render is the charge, and from the instant it gives the slot back
 * (`handOverGpuSlot`) the hold is.
 */
export function gpuHoldCharges(job: QueueJob, setId: string): boolean {
  const hold = gpuHoldOf(job);
  if (hold === null || hold.server !== setId) return false;
  return !job.steps.some((step) => step.status === 'running' && step.resource === 'gpu'
    && slotSetForStep(job, step) === setId);
}

/**
 * WHAT THE BOOK IS DOING WHILE IT HOLDS THE CARD — the step the phrase names,
 * or null when this run holds nothing.
 *
 * The running CPU step first, because that is the thing actually happening (the
 * render's session copy, an assembly between two GPU acts); otherwise the next
 * GPU act it is waiting to start, which is the honest answer for the gap
 * between one step settling and the next being admitted.
 */
export function gpuHoldStep(job: QueueJob): QueueStep | null {
  if (gpuHoldOf(job) === null) return null;
  const onCpu = job.steps.find((s) => s.status === 'running' && s.resource === 'cpu');
  if (onCpu !== undefined) return onCpu;
  return job.steps.find((s) => isTravellingGpuStep(s)
    && (s.status === 'queued' || s.status === 'waiting' || s.status === 'running')) ?? null;
}

/**
 * THE HELD CARD, AS THE ONE PHRASE EVERY SURFACE SAYS IT WITH — mid-sentence,
 * lower case, or null when this run holds nothing.
 *
 * ONE composer for two readers (crucible `docs/ARCHITECTURE.md` R1): the
 * bench's lane and its "waiting for the card" sentence, and the scheduler's own
 * `occupantPhrase`, which is what a SECOND book bound for the same machine is
 * told. A slot charged to something with no name on it is the unreadable bench
 * this whole layer exists to prevent — and the reader must be able to tell a
 * card that is rendering from a card that is being kept between steps, because
 * the second one frees itself in seconds.
 */
export function gpuHoldWords(job: QueueJob): string | null {
  const step = gpuHoldStep(job);
  if (step === null) return null;
  const what = step.resource === 'cpu'
    ? `${step.label} is finishing on the CPU`
    : `waiting to start ${step.label}`;
  return `holding the card for ${job.title} between GPU steps — ${what}`;
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
  /*
   * THE JOBS ALONE ANSWER IT. `slotSetForStep` needs nothing but the step since
   * Owen's ruling of 2026-09-19 — a non-travelling GPU step is always
   * {@link LONGFORM_ALIGN_SET} and a server's lane is only ever reached through
   * a venue the step carries — so an occupancy count cannot disagree with the
   * bench about which row a step is on.
   */
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
    /*
     * A BOOK IS ATOMIC ON THE CARD (Owen, 2026-09-20) — see {@link gpuHoldOf}.
     *
     * Counted per JOB rather than per step, because between two GPU acts there
     * is no step to count: the render is copying its session on the CPU, or
     * nothing of the run is running at all while the next act's lease is being
     * reserved. Those are exactly the moments the book used to lose its slot
     * and then queue behind its own tail.
     *
     * {@link gpuHoldCharges} is asked rather than re-derived here, so the count,
     * the bench and the pump cannot disagree about whether this run's hold is
     * on that card.
     */
    const hold = gpuHoldOf(job);
    if (hold !== null && gpuHoldCharges(job, hold.server)) {
      const entry = counts.get(hold.server) ?? { gpu: 0, cpu: 0 };
      entry.gpu += 1;
      counts.set(hold.server, entry);
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

/**
 * A registered server, in the person's own priority order, with its switch.
 *
 * ONE ORDERED LIST AND NOT TWO. It was `enabledServers` plus `disabledServers`
 * for a few hours, and Owen found what that costs: *"the crucible slots
 * shouldnt switch positions. i just re-checked one and they switched where they
 * were."* Two lists cannot interleave, so the bench drew every enabled card and
 * then every disabled one, and flipping a switch MOVED the card somebody was
 * pointing at — the one thing a row under the cursor must not do.
 *
 * The order is the registry's RANK, which is the order the person dragged the
 * rows into in Settings: *"whichever is at the top shoudl be on the left. from
 * left to right, like a book."*
 *
 * It also makes the disjointness this used to check impossible rather than
 * merely checked: a server is one row carrying a boolean, so it cannot be named
 * as both on and off.
 */
export interface RankedServer {
  readonly name: string;
  readonly enabled: boolean;
}

export interface SlotSetFacts {
  /**
   * Every ENABLED registered server, in rank order — and since 2026-09-15 that
   * is every server there is, wherever it answers. A disabled one contributes no
   * set: §4.2.2's enable switch is a capacity switch, so turning it off takes its
   * slots away and new claims stop going there.
   */
  readonly rankedServers: readonly RankedServer[];

  /**
   * PER ENGINE: can it send work elsewhere at all. One entry for every name in
   * {@link rankedServers} — a name missing from here is REFUSED BY NAME rather
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
  /*
   * THE SWITCHED-OFF LIST IS REQUIRED TOO, and for the same reason the others
   * are: the only two guesses are both wrong in a way nobody would see. `[]`
   * says the operator has switched nothing off, so every greyed row silently
   * disappears again — the exact rendering this field was added to stop. Taking
   * "everything not enabled" would invent rows for servers that are simply not
   * registered.
   */
  if (!Array.isArray(facts.rankedServers)) {
    throw new Error(
      'slotSets: `rankedServers` was not supplied. It is the routing record\'s `ranked` array '
        + '— every registered server, best first, each saying whether it is switched on.',
    );
  }
  const notRows = facts.rankedServers.filter(
    (row) => typeof row?.name !== 'string' || typeof row?.enabled !== 'boolean',
  );
  if (notRows.length > 0) {
    throw new Error(
      'slotSets: `rankedServers` holds something that is not a {name, enabled} row. A bare list '
        + 'of names loses the switch, and the switch is what decides whether a row is drawn grey.',
    );
  }
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

  for (const { name, enabled } of facts.rankedServers) {
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
    /*
     * ASKED OF THE ENABLED ONES, which is what this refusal always said —
     * "Every ENABLED server needs an entry in `roles`" — and what it now does.
     *
     * A switched-off server may never have been coordinated with at all: the
     * role is read from that server's own `/v1/info`, and one the queue will
     * not use is one nothing has asked. Demanding it would refuse to draw the
     * WHOLE bench because a row somebody turned off has not been introduced,
     * which is the same "absence of knowledge is not absence of an engine"
     * mistake `unknown` exists to avoid.
     */
    if (enabled && role === undefined) {
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
      /*
       * SWITCHED OFF WHILE IT WAS WORKING IS BOTH THINGS AT ONCE. §4.3 keeps a
       * job on the machine it started on, so flipping the switch mid-render
       * does not take the render off that card — it stops the NEXT one going
       * there. `retiring` is the bench's word for that ("finishing — no new
       * work goes here") and it stays true until the occupant lands, because
       * the alternative is a greyed row with a live progress bar in it and no
       * sentence saying why work is still moving on a machine you just turned
       * off.
       */
      retiring: !enabled && facts.occupied.includes(name),
      /*
       * SWITCHED OFF DRAWS THE SAME ROW, GREY — Owen, 2026-09-15: *"if a
       * crucible slot is unchecked, it grays it out until it's
       * re-checked/re-enabled."* And it draws it HERE, in rank order, rather
       * than in a pass of its own: a second pass put every disabled card after
       * every enabled one, so flipping a switch MOVED the card somebody was
       * pointing at. *"the crucible slots shouldnt switch positions."*
       *
       * Nothing about placement is decided here and none of it changed:
       * `decideWaitFor` already refuses a disabled server by name
       * (`holdDisabled`) and already tries only enabled rows for `any`.
       */
      disabled: !enabled,
    });
    if (!enabled) {
      /*
       * NO CLOUD LANE FOR A SWITCHED-OFF ENGINE. The lane exists because that
       * engine forwards work somewhere; one the queue will not send to forwards
       * nothing, and drawing the lane would offer a route through a shut door.
       */
      continue;
    }
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
        disabled: false,
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
  /*
   * IT IS THE ROW FOR THIS APP'S OWN GPU WORK AND NOTHING ELSE (Owen,
   * 2026-09-19). A Crucible on loopback used to swallow this row — its two slots
   * were held to BE the card, so the aligner was filed into them — and that was
   * the last place the queue treated a server differently for being here. A
   * Crucible server is scheduled the same way wherever it answers, so the
   * in-app aligner keeps a lane of its own and takes it whenever it is charged.
   */
  if (facts.alignerCharged && !seen.has(LONGFORM_ALIGN_SET)) {
    seen.add(LONGFORM_ALIGN_SET);
    sets.push({
      id: LONGFORM_ALIGN_SET,
      label: labelFor(LONGFORM_ALIGN_SET),
      gpu: SERVER_GPU_SLOTS,
      // This row is a GPU venue and nothing else: CPU work has never gone
      // through it, and giving it a CPU lane would invent a second home for
      // work `local-work` already owns.
      cpu: 0,
      retiring: false,
      disabled: false,
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
      // A retiring set is not a switched-off one: nobody chose this and
      // nothing switches it back. See `SlotSet.disabled`.
      disabled: false,
    });
  }

  sets.push({
    id: LOCAL_WORK_SET,
    label: labelFor(LOCAL_WORK_SET),
    gpu: 0,
    cpu: LOCAL_WORK_CPU_SLOTS,
    retiring: false,
    disabled: false,
  });

  return sets;
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
