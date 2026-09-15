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
 *     local        [ gpu ] [ cpu ] [ cpu ]     ← this machine's Crucible
 *     local:cloud          [ cpu ] [ cpu ]     ← only if it HAS an upstream
 *     mac          [ gpu ] [ cpu ] [ cpu ]     ← a registered remote
 *     mac:cloud            [ cpu ] [ cpu ]     ← only if IT has an upstream
 *     legacy…      [ gpu ]                     ← the dated local-narrator spawn
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
 *     <server>     [ gpu ] [ cpu ] [ cpu ]     one per REGISTERED Crucible
 *     <server>:cloud       [ cpu ] [ cpu ]     ONLY if it has an upstream
 *     local-work           [ cpu ] [ cpu ]     CPU slots stay local
 *
 * — and no more. Owen again, 2026-09-15: *"without a crucible server, there is
 * no gpu slot, because bookforge shouldnt know how to drive gpu work in-app …
 * even if that server is just a local windows install with no wsl engine."*
 *
 * The legacy set below is the one row that is not yet that, and THIS FILE USED
 * TO SAY IT WAS ONE SUBTRACTION AWAY. Measured 2026-09-15, it is not: three
 * different things send GPU work there, and only the first is the legacy spawn
 * layer.
 *
 *  1. **Any render at all while `legacyLocalRender` is on** — the dated switch,
 *     which does go with that layer after Owen's in-app pass.
 *  2. **`generate-sentences` with `method: 'epub-align'`** — the whole-audiobook
 *     forced alignment (`electron/whisperx-align-bridge.ts`,
 *     `electron/scripts/align_audiobook.py`). It is not a Crucible job because
 *     Crucible has no job of that SHAPE, not because nobody wired it: the
 *     `align` job takes `chunks:[{index,text}]` and one audio input PER chunk,
 *     which is a caller that ALREADY KNOWS which audio goes with which text —
 *     and discovering that (a rough transcript of the whole m4b, then a coarse
 *     DTW of the ebook's sentences onto it) is this act's middle stage and most
 *     of its cost. `align-longform` is a Crucible job type that does not exist;
 *     it is written up as a ruling in `docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7.
 *  3. **`video-assembly`** — subtitle frames drawn in a hidden BrowserWindow and
 *     muxed by ffmpeg. Not inference at all, so not a job type Crucible would
 *     ever grow. Whether it is really GPU work, or a `cpu` step declared `gpu`
 *     since before any of this, is a question nobody has measured.
 *
 * So the row stays, and it stays for a stated reason rather than as a leftover:
 * deleting it would leave those steps charging a set with no slots, and
 * {@link slotsOf} answers 0 for a set that is not on the bench, so the
 * scheduler would simply never launch them. `tools/test-queue-slot-sets.js`
 * pins the SHAPE instead — every GPU row is a registered server, bar this one
 * named exception — so a new in-app GPU venue has to come past that check.
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

import { LEGACY_LOCAL_NARRATOR } from './wait-for';
import type { QueueJob, QueueStep, StepResource } from './engine-types';

/**
 * The set holding work BOOKFORGE DOES ITSELF and never sends anywhere —
 * assembly, muxing, an export landing, a hosted-API pass.
 *
 * §2.4 calls this row `local`. It is spelled `local-work` here because `local`
 * is the RESERVED NAME of this machine's own Crucible server
 * (`electron/crucible/local.ts`), and one word meaning two machines is exactly
 * the duplicated fact crucible `docs/ARCHITECTURE.md` R1 forbids.
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
 * A registry name cannot contain it: `servers.ts` refuses any name that does
 * not match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and the reserved `local` and the
 * legacy set's id carry no colon either. That is what makes
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
   * A registered server's NAME, {@link LEGACY_LOCAL_NARRATOR}, or
   * {@link LOCAL_WORK_SET}. It is what `slotSetForStep` returns, so the two
   * cannot drift.
   */
  readonly id: string;
  /** The set's heading on the bench — "mac", "BookForge itself". */
  readonly label: string;
  readonly gpu: number;
  readonly cpu: number;
  /**
   * This set takes no NEW work: its server was disabled or removed, or the
   * legacy switch was turned off, while something of ours was still running
   * there. §4.3 — a job that started on a machine finishes on that machine — so
   * the set stays on the bench until its occupant lands, and then it is gone.
   */
  readonly retiring: boolean;
}

/** How a set's id reads as a heading. */
function labelFor(id: string): string {
  if (id === LOCAL_WORK_SET) return 'BookForge itself';
  if (id === LEGACY_LOCAL_NARRATOR) return 'the local narrator (legacy)';
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
 *  4. A GPU step whose module has NOT been taught to travel spawns on this
 *     machine, always — the legacy set, whatever its run says.
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
  if (step.venue !== undefined) return step.venue;
  if (step.resource === 'cpu') return LOCAL_WORK_SET;
  if (step.travels !== true) return LEGACY_LOCAL_NARRATOR;
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

export interface SlotSetFacts {
  /**
   * Every ENABLED registered server, in rank order, this machine's own `local`
   * included. A disabled server contributes no set: §4.2.2's enable switch is a
   * capacity switch, so turning it off takes its slots away and new claims stop
   * going there.
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
   * Set ids that currently hold something of ours. A set named here survives
   * even when its server was disabled or removed, marked `retiring` — §4.3.
   */
  readonly occupied: readonly string[];
}

/**
 * EVERY SLOT SET THAT EXISTS RIGHT NOW, in a stable order: the servers in rank
 * order, then the legacy spawn, then BookForge's own work last.
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

  for (const name of facts.enabledServers) {
    if (seen.has(name)) continue;
    seen.add(name);
    sets.push({
      id: name,
      label: labelFor(name),
      gpu: SERVER_GPU_SLOTS,
      cpu: SERVER_CPU_SLOTS,
      retiring: false,
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
      });
    }
  }

  /*
   * THE LEGACY SET IS ALWAYS HERE, and it is not conditional on the switch.
   *
   * `routing.legacyLocalRender` decides whether a RENDER takes the local
   * narrator spawn. It does not decide whether that spawn layer exists: a GPU
   * step whose module has not been taught to travel spawns on this machine
   * whatever the switch says, and with no set to charge it to the scheduler
   * would find nought slots and never launch it.
   *
   * AND THE SWITCH IS NOT THE LAST TENANT EITHER — see the header's list,
   * measured 2026-09-15: `generate-sentences`'s `epub-align` method and
   * `video-assembly` both come here, and neither goes away with the legacy
   * layer. So this row outlives that layer, and what removes it is §B7 (a
   * Crucible `align-longform` job type, Owen's ruling) plus an answer about
   * whether a video mux is GPU work at all.
   *
   * Its gpu slot is ONE, which is what keeps the stopgap behaving exactly as it
   * did under the old global number.
   */
  if (!seen.has(LEGACY_LOCAL_NARRATOR)) {
    seen.add(LEGACY_LOCAL_NARRATOR);
    sets.push({
      id: LEGACY_LOCAL_NARRATOR,
      label: labelFor(LEGACY_LOCAL_NARRATOR),
      gpu: SERVER_GPU_SLOTS,
      // The legacy spawn is a GPU stopgap and nothing else: CPU work has never
      // gone through it, and giving it a CPU lane would invent a second home
      // for work `local-work` already owns.
      cpu: 0,
      retiring: false,
    });
  }

  // A set nobody may claim into, kept alive by its occupant alone.
  for (const id of facts.occupied) {
    if (id === LOCAL_WORK_SET || seen.has(id)) continue;
    seen.add(id);
    const cloud = isCloudLane(id);
    sets.push({
      id,
      label: labelFor(id),
      gpu: cloud ? 0 : SERVER_GPU_SLOTS,
      cpu: cloud
        ? CLOUD_LANE_SLOTS
        : id === LEGACY_LOCAL_NARRATOR ? 0 : SERVER_CPU_SLOTS,
      retiring: true,
    });
  }

  sets.push({
    id: LOCAL_WORK_SET,
    label: labelFor(LOCAL_WORK_SET),
    gpu: 0,
    cpu: LOCAL_WORK_CPU_SLOTS,
    retiring: false,
  });

  return sets;
}

/**
 * THIS MACHINE HAS ONE CARD, and two slot sets can point at it.
 *
 * The legacy narrator spawn and this machine's own Crucible server (`local`)
 * are two venues over one 3090 Ti. As separate sets they each have a GPU slot,
 * so without this rule the scheduler could start a legacy RVC pass and a
 * `local` render at the same moment — which the single global `gpu: 1` used to
 * prevent by accident. It is stated here rather than rediscovered.
 *
 * Returns the OTHER set id already using this machine's card, or `null` when
 * nothing is. A remote server's venue answers `null` immediately: its card is
 * not this one, which is the whole point of the per-server sets.
 *
 * NOT the same question as `external-gpu-job.lock` and the GPU arbiter, which
 * are about holders OUTSIDE this queue (a training chain). Whether a local
 * Crucible should replace those two is item A4 of
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md` §0b — a ruling, not this.
 */
export function thisMachinesCardHeldBy(options: {
  /** The venue the step is about to run at. */
  readonly venue: string;
  /** The reserved name of this machine's own Crucible server, when it has one. */
  readonly localServerName: string | null;
  readonly occupancy: ReadonlyMap<string, SetOccupancy>;
}): string | null {
  const { venue, localServerName, occupancy } = options;
  /*
   * A CLOUD LANE IS NEVER THIS MACHINE'S CARD, even `local`'s. The work runs
   * on somebody's API; the engine forwarding it holds nothing. Answered first
   * so `local:cloud` cannot be mistaken for `local`.
   */
  if (isCloudLane(venue)) return null;
  const here: string[] = [LEGACY_LOCAL_NARRATOR];
  if (localServerName !== null) here.push(localServerName);
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
