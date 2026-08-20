/**
 * The queue as a BENCH — what the tray and the queue page both draw, derived
 * from the one snapshot main owns.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * There is one GPU slot and two CPU slots (`RESOURCE_SLOTS`). Allocating those
 * three slots is the entire job of the scheduler, and until this module neither
 * surface drew them: the tray showed "the running job" as a singular (there can
 * be three), and the page showed a flat list in which a row waiting on its
 * parent, a row waiting for the card, a row nobody has started and a row the
 * user stopped all rendered identically.
 *
 * So this answers two questions and nothing else:
 *
 *   1. What is in each slot right now, and which slots are free?
 *   2. For every row that is NOT in a slot — why not, in a sentence?
 *
 * ── Why it is here rather than in the tray service ──────────────────────────
 *
 * Same reason `job-words.ts` moved: two processes ask these questions. The
 * renderer draws the tray and the page; main composes the hosted Foundry
 * window's status chip out of the same snapshot (electron/foundry-host-status.ts)
 * and cannot import a renderer service. One queue must not be described in two
 * vocabularies — and a pure module is reachable by a keeper suite, which a
 * component's computed is not.
 *
 * Everything here is a PURE function of the snapshot. No clock of its own (a
 * `now` is passed in), no I/O, no Angular. Covers, thumbnails and measured ETAs
 * are decoration the renderer adds; they are not facts about the queue.
 */

import {
  RESOURCE_SLOTS,
  TERMINAL_STEP_STATUSES,
  jobStatus,
  type JobStageProgress,
  type QueueJob,
  type QueueSnapshot,
  type QueueStep,
  type StepResource,
  type StepStatus,
} from './engine-types';
import { JOB_GERUND } from './job-words';

// ────────────────────────────────────────────────────────────────────────────
// Why a row is still
// ────────────────────────────────────────────────────────────────────────────

/**
 * The reason a step is not running, as a kind AND a sentence.
 *
 * The kind is what the UI styles on — a hold the machine will clear by itself
 * reads differently from one waiting on the user — and the sentence is what the
 * user reads. Neither is derivable from the other, so both are carried.
 *
 * `ready` is a real state and not an error: released, parent done, a slot free,
 * and the pump simply has not run yet. It exists so that "no reason found" can
 * never be the answer.
 */
export type StillKind =
  | 'waiting-parent'
  | 'paused'
  | 'no-slot'
  | 'admission'
  | 'held'
  | 'stopped'
  | 'ready';

export interface StillReason {
  kind: StillKind;
  /** One sentence, in the user's words. Never empty. */
  sentence: string;
}

/** The pool a resource names, as the user would say it. */
function poolWord(resource: StepResource): string {
  return resource === 'gpu' ? 'the graphics card' : 'a CPU slot';
}

/**
 * What currently occupies a step's pool, named by what it is doing — "Narrating
 * Flashpoint of Revival". Empty string when nothing does, which the caller has
 * already ruled out before asking.
 */
function occupantWords(snapshot: QueueSnapshot, resource: StepResource): string[] {
  const words: string[] = [];
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'running' || step.resource !== resource) continue;
      words.push(`${JOB_GERUND[step.type]} ${job.title}`);
    }
  }
  return words;
}

function runningCount(snapshot: QueueSnapshot, resource: StepResource): number {
  let n = 0;
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status === 'running' && step.resource === resource) n += 1;
    }
  }
  return n;
}

/** The step a `parentStepId` names, searched across the whole snapshot. */
export function parentStep(snapshot: QueueSnapshot, step: QueueStep): QueueStep | null {
  if (step.parentStepId === 'source') return null;
  for (const job of snapshot.jobs) {
    const found = job.steps.find((s) => s.id === step.parentStepId);
    if (found) return found;
  }
  return null;
}

/**
 * Why this step is not running.
 *
 * ── The order of the tests is the causal order, and it is load-bearing ──────
 *
 * A still row usually satisfies several of these at once, and the one worth
 * saying is the one that has to change FIRST. A step whose parent has not
 * finished is not "waiting for the card" even when the card is also busy —
 * telling the user to free the GPU would be telling them to fix the wrong
 * thing. And the pool being full outranks a recorded admission hold, because
 * the engine stops asking admission the moment the pool is full, so a hold from
 * an earlier pump can still be sitting on the row (the engine retires it there
 * for exactly this reason — see `clearAdmissionHold`).
 *
 * Throws for a step that IS running or has finished: those have no reason to be
 * still, and answering with a sentence anyway would let a caller draw "waiting
 * for the card" beside a progress bar that is moving.
 */
export function stillReason(
  snapshot: QueueSnapshot,
  job: QueueJob,
  step: QueueStep,
): StillReason {
  if (step.status === 'running') {
    throw new Error(`${step.label} is running, so it is not waiting for anything.`);
  }
  if (TERMINAL_STEP_STATUSES.has(step.status)) {
    throw new Error(`${step.label} has already finished, so it is not waiting for anything.`);
  }

  if (step.status === 'held') {
    if (step.wasInterrupted) {
      const percent = step.progress.percent;
      return {
        kind: 'stopped',
        sentence: percent === undefined
          ? 'Stopped — it picks up where it left off.'
          : `Stopped at ${Math.round(percent)}% — it picks up where it left off.`,
      };
    }
    const parent = parentStep(snapshot, step);
    if (parent && !TERMINAL_STEP_STATUSES.has(parent.status)) {
      return { kind: 'held', sentence: `Held — behind ${parent.label}.` };
    }
    return { kind: 'held', sentence: "Held — you haven't started it." };
  }

  if (step.status === 'waiting') {
    const parent = parentStep(snapshot, step);
    if (!parent) {
      throw new Error(
        `${step.label} is waiting on a step that is not in this queue, so nothing can say `
        + 'when it will run.',
      );
    }
    return { kind: 'waiting-parent', sentence: `Waiting for ${parent.label} to finish.` };
  }

  // status === 'queued' — released, and its parent (if any) is done.
  if (!snapshot.running) {
    return { kind: 'paused', sentence: 'The queue is paused.' };
  }

  if (runningCount(snapshot, step.resource) >= RESOURCE_SLOTS[step.resource]) {
    const busy = occupantWords(snapshot, step.resource);
    return {
      kind: 'no-slot',
      sentence: busy.length > 0
        ? `Waiting for ${poolWord(step.resource)} — ${busy.join(' and ')}.`
        : `Waiting for ${poolWord(step.resource)}.`,
    };
  }

  const hold = step.progress.admissionHold;
  if (hold !== undefined) {
    return { kind: 'admission', sentence: hold };
  }

  return { kind: 'ready', sentence: 'Starting now.' };
}

// ────────────────────────────────────────────────────────────────────────────
// The bench
// ────────────────────────────────────────────────────────────────────────────

/** What is in a slot. */
export interface LaneOccupant {
  jobId: string;
  stepId: string;
  /** "Narrating" — what the step is doing. */
  verb: string;
  /** The book, as the user knows it. */
  title: string;
  /** The step's own heading — "Narrate", "Assemble". */
  label: string;
  /**
   * 0-100, or null when the step has measured none. Null is drawn as no bar
   * rather than a bar at zero: a step that has said nothing yet has not said
   * "nothing done".
   */
  percent: number | null;
  /** What the step last said about itself, when it has said anything. */
  message?: string;
  /** What the running STAGE is doing when its own percentage cannot move. */
  detail?: string;
  /**
   * The step's stage breakdown, when it reports one. Empty when it does not.
   *
   * On the bench because the overall percentage is NOT enough to show life. An
   * Orpheus worker renders 64 sentences as one batch and reports no completions
   * until the whole batch lands, so the headline number can sit at 0 for many
   * minutes on a run that is working perfectly — while "Preparing" and "Loading
   * voice model" underneath it are moving the entire time. Drawing only the
   * headline made a healthy run look stalled (Owen, 2026-08-19).
   */
  stages: JobStageProgress[];
}

/** One slot of one pool. */
export interface BenchLane {
  resource: StepResource;
  /** 1-based within its pool, with the pool's size: "CPU · slot 2 of 2". */
  index: number;
  of: number;
  occupant: LaneOccupant | null;
  /**
   * Why an EMPTY lane is empty, when something is being kept out of it. Set only
   * on a free GPU lane that admission is refusing; null when the lane is free
   * because nothing wants it, which is a different fact and reads differently.
   */
  hold: string | null;
}

/**
 * Every slot, occupied or not, in a stable order: the GPU first, then the CPU
 * pool.
 *
 * ALL slots are always returned. A free slot is information — it says nothing
 * queued wants that resource, which is the difference between a queue that is
 * stuck and a queue that has nothing to do — and a surface that drew only the
 * busy ones could not tell those apart either.
 */
export function benchLanes(snapshot: QueueSnapshot): BenchLane[] {
  const lanes: BenchLane[] = [];

  for (const resource of ['gpu', 'cpu'] as const) {
    const occupants: LaneOccupant[] = [];
    for (const job of snapshot.jobs) {
      for (const step of job.steps) {
        if (step.status !== 'running' || step.resource !== resource) continue;
        occupants.push({
          jobId: job.id,
          stepId: step.id,
          verb: JOB_GERUND[step.type],
          title: job.title,
          label: step.label,
          percent: step.progress.percent ?? null,
          ...(step.progress.message === undefined ? {} : { message: step.progress.message }),
          ...(step.progress.detail === undefined ? {} : { detail: step.progress.detail }),
          stages: step.progress.stages ?? [],
        });
      }
    }

    const of = RESOURCE_SLOTS[resource];
    for (let index = 1; index <= of; index += 1) {
      const occupant = occupants[index - 1] ?? null;
      lanes.push({
        resource,
        index,
        of,
        occupant,
        // A hold is a fact about the POOL, not about one slot, so it is shown on
        // the first free slot of that pool and nowhere else — repeated on both
        // CPU slots it would read as two separate blockages.
        hold: occupant === null && index === occupants.length + 1
          ? admissionHoldFor(snapshot, resource)
          : null,
      });
    }
  }

  return lanes;
}

/**
 * The hold keeping work out of a pool, or null.
 *
 * Read off the steps rather than re-derived, because the engine is the only
 * thing that knows whether admission refused — it holds the lock file and the
 * arbiter. A reader that re-checked them here would be a second opinion about a
 * decision that has already been made.
 */
function admissionHoldFor(snapshot: QueueSnapshot, resource: StepResource): string | null {
  if (resource !== 'gpu') return null;
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'queued' || step.resource !== resource) continue;
      if (step.progress.admissionHold !== undefined) return step.progress.admissionHold;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// The bands
// ────────────────────────────────────────────────────────────────────────────

/** A step that is neither running nor finished, with the reason it is still. */
export interface StillStep {
  jobId: string;
  stepId: string;
  /** The step's own heading. */
  label: string;
  /** The book, as the user knows it. */
  title: string;
  status: StepStatus;
  reason: StillReason;
  /** How far it got before it stopped, for a row that has run. Null otherwise. */
  percent: number | null;
  /** Can the user release this one right now? True for held and stopped rows. */
  startable: boolean;
}

/** A run that failed, and the sentence that says what happened. */
export interface FailedRun {
  jobId: string;
  stepId: string;
  title: string;
  label: string;
  /** The engine's own error text. Never invented, never summarised. */
  error: string;
  finishedAt?: string;
}

/** One book's worth of queued work, however many runs it is spread across. */
export interface BookPlan {
  /** The project this is about, or the run's id when it is about no project. */
  key: string;
  title: string;
  /** Every run in the group, oldest first. */
  jobIds: string[];
  /** Every step of every run in the group, in chain order. */
  steps: PlannedStep[];
  /** True when nothing in the group is released — one Start covers all of it. */
  allHeld: boolean;
}

/** A step inside a book plan: running ones are marked, not re-drawn. */
export interface PlannedStep {
  jobId: string;
  stepId: string;
  label: string;
  status: StepStatus;
  percent: number | null;
  /**
   * The reason it is still, or null when it is RUNNING — a running step is on
   * the bench, and the plan says so rather than repeating the readout.
   */
  reason: StillReason | null;
  startable: boolean;
}

/** What finished, and when, for the history band. */
export interface FinishedRun {
  jobId: string;
  stepId: string;
  title: string;
  label: string;
  status: 'done' | 'failed' | 'cancelled';
  /** What it wrote, when it wrote a file. */
  outputPath?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * A run is LIVE when something about it might still happen. Terminal runs are
 * history; everything else is either on the bench or waiting to be.
 */
function isLive(job: QueueJob): boolean {
  const status = jobStatus(job);
  return status !== 'done' && status !== 'failed' && status !== 'cancelled';
}

/**
 * The runs that need the user before they can go anywhere: the failed ones.
 *
 * A STOPPED run is deliberately not here. The user stopped it, so it is not
 * news to them, and it can be resumed from the plan with one press. A failure
 * is different in kind — it will never proceed without a decision — which is
 * why it gets the band that is empty most of the time and therefore worth
 * reading when it is not.
 */
export function needsYou(snapshot: QueueSnapshot): FailedRun[] {
  const failed: FailedRun[] = [];
  for (const job of snapshot.jobs) {
    if (jobStatus(job) !== 'failed') continue;
    for (const step of job.steps) {
      if (step.status !== 'failed') continue;
      failed.push({
        jobId: job.id,
        stepId: step.id,
        title: job.title,
        label: step.label,
        error: step.error ?? `${step.label} failed and gave no reason.`,
        ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
      });
    }
  }
  return failed;
}

/**
 * Everything released-or-held and not running, in the engine's own order, each
 * with the reason it is still.
 *
 * The flat shape, for the tray: a narrow panel cannot draw chains, and the tray
 * already shows what is running on the bench above, so a running step would be
 * the same fact twice in 430 pixels.
 */
export function upNext(snapshot: QueueSnapshot): StillStep[] {
  const rows: StillStep[] = [];
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status === 'running' || TERMINAL_STEP_STATUSES.has(step.status)) continue;
      const reason = stillReason(snapshot, job, step);
      rows.push({
        jobId: job.id,
        stepId: step.id,
        label: step.label,
        title: job.title,
        status: step.status,
        reason,
        percent: step.progress.percent ?? null,
        startable: step.status === 'held',
      });
    }
  }
  return rows;
}

/**
 * The same work grouped by BOOK, with each run's chain intact — the page's
 * shape.
 *
 * Grouped because the user reasons about books: narrate, enhance and assemble
 * on one book are one intention, and listing them as three peers of three other
 * books' rows is the list making the reader do the grouping. The engine's order
 * is still visible, because a group cannot jump its own steps and the groups
 * themselves are ordered by their earliest run.
 *
 * A RUNNING step is included, carrying `reason: null`. Its progress belongs to
 * the bench; here it is a marker that says where in the chain the work has got
 * to, which is the fact the chain is for.
 */
export function bookPlans(snapshot: QueueSnapshot): BookPlan[] {
  const byKey = new Map<string, BookPlan>();

  for (const job of snapshot.jobs) {
    if (!isLive(job)) continue;
    // Runs about the same project are one book's work. A run about no project
    // is its own group: nothing else can be said to belong with it.
    const key = job.projectId ?? job.id;
    let plan = byKey.get(key);
    if (plan === undefined) {
      plan = { key, title: job.title, jobIds: [], steps: [], allHeld: true };
      byKey.set(key, plan);
    }
    plan.jobIds.push(job.id);

    for (const step of job.steps) {
      if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
      plan.steps.push({
        jobId: job.id,
        stepId: step.id,
        label: step.label,
        status: step.status,
        percent: step.progress.percent ?? null,
        reason: step.status === 'running' ? null : stillReason(snapshot, job, step),
        startable: step.status === 'held',
      });
      if (step.status !== 'held') plan.allHeld = false;
    }
  }

  // A group whose steps were all terminal (a run finishing as this is read)
  // has nothing to plan, and an empty card is litter.
  return [...byKey.values()].filter((plan) => plan.steps.length > 0);
}

/**
 * What finished since the start of the day `now` falls in.
 *
 * The day boundary is computed by the caller's clock and passed in, because a
 * pure function that reads the wall clock cannot be tested and this one is the
 * history the user checks in the morning.
 */
export function finishedSince(snapshot: QueueSnapshot, sinceMs: number): FinishedRun[] {
  const runs: FinishedRun[] = [];
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) continue;
      if (step.finishedAt === undefined) continue;
      if (new Date(step.finishedAt).getTime() < sinceMs) continue;
      runs.push({
        jobId: job.id,
        stepId: step.id,
        title: job.title,
        label: step.label,
        status: step.status as 'done' | 'failed' | 'cancelled',
        ...(step.outputPath === undefined ? {} : { outputPath: step.outputPath }),
        ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
        finishedAt: step.finishedAt,
      });
    }
  }
  // Newest first: the thing that just landed is the thing being looked for.
  return runs.sort((a, b) =>
    new Date(b.finishedAt!).getTime() - new Date(a.finishedAt!).getTime());
}

/** Midnight of the day `nowMs` falls in, in local time. */
export function startOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
