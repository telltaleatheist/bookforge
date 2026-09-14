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
 *     mac          [ gpu ] [ cpu ] [ cpu ]     ← a registered remote
 *     legacy…      [ gpu ]                     ← the dated local-narrator spawn
 *     local-work           [ cpu ] [ cpu ]     ← what BookForge does ITSELF
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
  if (step.resource === 'cpu') return LOCAL_WORK_SET;
  if (step.venue !== undefined) return step.venue;
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

export interface SlotSetFacts {
  /**
   * Every ENABLED registered server, in rank order, this machine's own `local`
   * included. A disabled server contributes no set: §4.2.2's enable switch is a
   * capacity switch, so turning it off takes its slots away and new claims stop
   * going there.
   */
  readonly enabledServers: readonly string[];
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
  }

  /*
   * THE LEGACY SET IS ALWAYS HERE, and it is not conditional on the switch.
   *
   * `routing.legacyLocalRender` decides whether a RENDER takes the local
   * narrator spawn. It does not decide whether that spawn layer exists: a GPU
   * step whose module has not been taught to travel spawns on this machine
   * whatever the switch says, and with no set to charge it to the scheduler
   * would find nought slots and never launch it. So the set exists for as long
   * as the layer does — it is deleted with it, after Owen's in-app pass
   * (docs/CRUCIBLE_ROLLOUT_PLAN.md §0b A2).
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
    sets.push({
      id,
      label: labelFor(id),
      gpu: SERVER_GPU_SLOTS,
      cpu: id === LEGACY_LOCAL_NARRATOR ? 0 : SERVER_CPU_SLOTS,
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
