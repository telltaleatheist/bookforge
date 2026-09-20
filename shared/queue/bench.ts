/**
 * The queue as a BENCH — what the tray and the queue page both draw, derived
 * from the one snapshot main owns.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every machine brings a slot set — one GPU and its CPU slots per Crucible
 * server, plus two CPU slots for what BookForge does itself
 * (`shared/queue/slot-sets.ts`, crucible `docs/PHASE7-LANES.md` §2.4).
 * Allocating those slots is the entire job of the scheduler, and until this
 * module neither
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
  TERMINAL_STEP_STATUSES,
  jobStatus,
  type ActiveBatchProgress,
  type PrepSubProgress,
  type GpuThermalReading,
  type JobStageProgress,
  type QueueJob,
  type QueueSnapshot,
  type QueueStep,
  type StepResource,
  type StepStatus,
} from './engine-types';
import { JOB_GERUND } from './job-words';
import { closedInterrupted } from './stop-reason';
import {
  LOCAL_WORK_SET, LONGFORM_ALIGN_SET, gpuHoldCharges, gpuHoldStep, gpuHoldWords,
  serverOfCloudLane, slotSetForStep, slotSetOccupancy, slotsOf,
} from './slot-sets';

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
  /**
   * STAGED, NOT QUEUED — the run is in Pending and has not been sent
   * ({@link QueueJob.pending}).
   *
   * Its own kind rather than `held`, because the two are different states with
   * different gestures: `held` is *in the queue, press Start*, and this is *not
   * in the queue yet, choose a server and press Send to queue*. Collapsing them
   * would put a Start button on a row Start refuses by name.
   */
  | 'pending'
  | 'held'
  | 'stopped'
  | 'ready';

export interface StillReason {
  kind: StillKind;
  /** One sentence, in the user's words. Never empty. */
  sentence: string;
}

/**
 * The pool a resource names ON ONE MACHINE, as the user would say it.
 *
 * The machine is in the sentence because there is one card per slot set now: a
 * row told "waiting for the graphics card" while a second machine's card sat
 * idle would be a true sentence that reads as a false one.
 *
 * ── The GPU wording is OWEN'S SECOND PARKED SENTENCE ────────────────────────
 *
 * `docs/PENDING-QUEUE-AND-GPU-DIAL.md`, "A parked row says what would unblock it
 * — three different sentences": *"The server is occupied: 'Waiting for the 3090
 * Ti to become free.' The dial matches, the card is working, and the fix is
 * time."* It used to read "waiting for the graphics card on 3090 Ti", which is
 * the same fact said less plainly; the point of the three sentences is that a
 * reader can tell this state from *"the queue is set to M1 Ultra"* (a dial turn
 * fixes it, and the card may be idle) and from *"disabled"* (a switch fixes it)
 * at a glance, and "to become free" is what says the machine is BUSY.
 *
 * The article is left off the label rather than written into the sentence: the
 * labels are "3090 Ti", "the local long-form aligner" and "M1 Ultra — routed
 * elsewhere", and a hard-coded "the" would read as "the the local long-form
 * aligner" on the one row that already carries its own.
 *
 * THIS IS THE ONLY OWNER OF THAT SENTENCE. The scheduler deliberately says
 * nothing when a venue's slot is full (`queue-engine.ts`, the `gpuSlotHolder`
 * branch RETIRES its hold there): the bench reads `step.venue` — pencilled in as
 * soon as the pump knows which machine it is trying — so it can always speak,
 * and two sentences for one fact is the shape crucible `docs/ARCHITECTURE.md` R1
 * forbids.
 */
function poolWord(resource: StepResource, setId: string, setLabel: string): string {
  if (resource === 'gpu') return `${setLabel} to become free`;
  /*
   * A CLOUD LANE IS A `cpu` SET AND IT IS NOT THIS MACHINE'S CPU.
   *
   * An upstream-routed act (crucible `docs/PHASE15-HOST.md` §5.3) is charged
   * to `<server>:cloud`, whose width is in the `cpu` counter because the work
   * occupies no card. "Waiting for a CPU slot" would be true of the counter
   * and false of the world: nothing of this row is on this machine at all, and
   * a person reading it would go looking at their own processor.
   */
  const server = serverOfCloudLane(setId);
  return server === null ? 'a CPU slot' : `${server} to finish what it is sending elsewhere`;
}

/**
 * What currently occupies a step's pool ON ITS OWN MACHINE, named by what it is
 * doing — "Narrating Flashpoint of Revival". Empty when nothing does, which the
 * caller has already ruled out before asking.
 */
function occupantWords(
  snapshot: QueueSnapshot,
  setId: string,
  resource: StepResource,
): string[] {
  const words: string[] = [];
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'running' || step.resource !== resource) continue;
      if (slotSetForStep(job, step) !== setId) continue;
      words.push(`${JOB_GERUND[step.type]} ${job.title}`);
    }
  }
  /*
   * A CARD CAN BE HELD BY A BOOK WITH NOTHING RUNNING ON IT — Owen's ruling of
   * 2026-09-20, `gpuHoldOf`. The slot is charged, so the row behind it is
   * genuinely waiting, and it must be told by WHOM and that the wait is a short
   * one: "holding the card for Mistborn between GPU steps — Narrate is
   * finishing on the CPU" reads very differently from a nine-hour render.
   *
   * Composed by {@link gpuHoldWords} rather than here, because the scheduler
   * says the same thing to an `any` row it steers elsewhere and two composers
   * for one fact drift (crucible `docs/ARCHITECTURE.md` R1). Capitalised to
   * match the running entries beside it, which start with a gerund.
   */
  if (resource === 'gpu') {
    for (const job of snapshot.jobs) {
      if (!gpuHoldCharges(job, setId)) continue;
      const held = gpuHoldWords(job);
      if (held === null) continue;
      words.push(held.charAt(0).toUpperCase() + held.slice(1));
    }
  }
  return words;
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

  /*
   * STAGED OUTRANKS EVERY OTHER REASON, because it is the only one that is true
   * of the WHOLE RUN rather than of this step. A pending run's steps are all
   * `held`, so without this the first of them would read "Held — you haven't
   * started it" (which invites a press Start refuses) and the rest would read
   * "Held — behind Narrate" (which names a queue position the run has not got
   * yet). Asked before the parent, before the pool and before admission, none of
   * which is even consulted for a run the pump skips.
   */
  if (job.pending === true) {
    return { kind: 'pending', sentence: 'Pending — not sent to the queue yet.' };
  }

  if (step.status === 'held') {
    if (step.wasInterrupted) {
      const percent = step.progress.percent;
      /*
       * WHO ENDED IT IS PART OF THE SENTENCE — bug hunt 2026-09-20, S12.
       *
       * The `kind` stays `stopped`, because that is what the surfaces derive
       * the ▶ *Resume* label from and both gestures resume the same way. Only
       * the words change, and they have to: *"Stopped"* names a gesture, and
       * Owen came back on 2026-09-20 to two renders aimed at idle cards being
       * described as stopped when nobody had touched them. A close has no
       * percent to report either (see `reviveInterrupted`), so this branch is
       * the whole of what it can say.
       */
      if (closedInterrupted(step)) {
        return {
          kind: 'stopped',
          sentence: 'Interrupted when BookForge closed — it picks up where it left off.',
        };
      }
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

  /*
   * THE POOL IS ONE MACHINE'S, so the set has to be known before the question
   * can be asked. `null` means the row has not been routed yet (a travelling
   * GPU step whose run has no venue), and that is NOT a slot problem — nothing
   * can say which card it is waiting for. Admission says so in its own words on
   * the row, which the `admission` branch below reads, so skipping the test
   * here cannot leave a row with no reason.
   */
  const setId = slotSetForStep(job, step);
  if (setId !== null) {
    const occupancy = slotSetOccupancy(snapshot).get(setId) ?? { gpu: 0, cpu: 0 };
    /*
     * A BOOK NEVER WAITS FOR ITS OWN HELD CARD (Owen, 2026-09-20).
     *
     * The hold charges this set precisely so nobody else takes the slot while
     * this run is between GPU acts — so counting it against this run's own next
     * act would produce the sentence Owen read on Mistborn: *"Waiting for
     * crucible@<the Mac>: busy … tts mistborn, 99% done"*, the book
     * queued behind itself. One slot, one owner, and the owner does not queue
     * for it.
     */
    const ownHold = step.resource === 'gpu' && gpuHoldCharges(job, setId) ? 1 : 0;
    const inUse = (step.resource === 'gpu' ? occupancy.gpu : occupancy.cpu) - ownHold;
    if (inUse >= slotsOf(snapshot.slotSets, setId, step.resource)) {
      const label = snapshot.slotSets.find((set) => set.id === setId)?.label ?? setId;
      const busy = occupantWords(snapshot, setId, step.resource);
      return {
        kind: 'no-slot',
        sentence: busy.length > 0
          ? `Waiting for ${poolWord(step.resource, setId, label)} — ${busy.join(' and ')}.`
          : `Waiting for ${poolWord(step.resource, setId, label)}.`,
      };
    }
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
  /**
   * Progress INSIDE the MLX batch decoding right now, when one is.
   *
   * The stage breakdown above is not enough either. On Mac an Orpheus batch is
   * ~96 chunks in ONE atomic decode: "Converting sentences" sits at 0% for ten
   * minutes because not one file has landed, while 83 of the batch's 94 rows
   * have actually finished. This is the only number that moves in that window,
   * and the bench dropped it on the floor until now (Owen, 2026-08-20).
   */
  activeBatch?: ActiveBatchProgress;
  /**
   * Counted work inside the PREPARING stage, when there is some.
   *
   * The stage breakdown is not enough here for `activeBatch`'s reason, one
   * stage earlier: "Preparing book" sits at 0% while the number-normalization
   * pass walks a 400-paragraph book through a local model, and this is the only
   * number that moves in that window.
   */
  prep?: PrepSubProgress;
}

/**
 * "Normalizing numbers · 84 / 312" — what the prep pass is doing, then how far.
 *
 * Here rather than in a component for `batchLabel`'s reason: the bench card, the
 * shelf and the queue page's step rows all draw this line, and one pass must not
 * be described in three vocabularies.
 */
export function prepLabel(p: PrepSubProgress): string {
  return `${p.label} · ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`;
}

/** 0-1 of the prep pass, or undefined when it has counted nothing to divide by. */
export function prepFraction(p: PrepSubProgress): number | undefined {
  return p.total > 0 ? Math.min(1, p.done / p.total) : undefined;
}

/**
 * "batch 12/95 chunks · 1.3k tokens" — rows first (the thing being waited
 * on), tokens second (how deep the decode is). Each clause is dropped when the
 * engine didn't report it rather than filled in with a guess.
 *
 * Here rather than in a component because BOTH the bench card and the queue
 * page's step rows draw this, and one batch must not be described in two
 * vocabularies (the same reason the rest of this module is here).
 */
export function batchLabel(b: ActiveBatchProgress, now: number = Date.now()): string {
  const parts: string[] = [];
  parts.push(b.rowsDone !== undefined
    ? `batch ${b.rowsDone}/${b.rowsTotal} chunks`
    : `batch of ${b.rowsTotal} chunks`);
  parts.push(`${compactTokens(b.tokenStep)} tokens`);
  // Which sub-batch of the current engine call this is — only worth saying when
  // the call was split into several (a batch too deep to run at full width).
  if (b.batchNo !== undefined && b.batchCount !== undefined && b.batchCount > 1) {
    parts.push(`part ${b.batchNo}/${b.batchCount}`);
  }
  // THIS batch's own clock. The step's elapsed cannot say this: it folds in the
  // model load and every batch already finished, so it grows all run while the
  // number a reader wants — how long this decode has been going, against the
  // ~13 minutes one usually takes — is only here.
  if (b.startedAt !== undefined) {
    const seconds = Math.max(0, Math.round((now - b.startedAt) / 1000));
    parts.push(elapsedWords(seconds));
  }
  return parts.join(' · ');
}

/** 795 → "13m 15s", 42 → "42s". Minutes first: a decode runs in minutes. */
function elapsedWords(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 1259 → "1.3k". Token counts run to four digits and only the magnitude matters. */
function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** One slot of one pool ON ONE MACHINE. */
export interface BenchLane {
  /**
   * Which slot set this lane belongs to — a server's name,
   * `local-longform-align`, or `local-work` (`shared/queue/slot-sets.ts`).
   *
   * Part of a lane's IDENTITY, not decoration: two machines each have a "GPU ·
   * slot 1 of 1", and a surface tracking lanes by resource and index alone
   * would swap one machine's occupant onto the other's card on every redraw.
   */
  setId: string;
  /** The set's heading, as the user reads it — "mac", "CPU slots". */
  setLabel: string;
  /**
   * This set takes no new work and disappears when its occupant lands: its
   * server was disabled or removed mid-run (§4.3 — a job finishes on the
   * machine it started on).
   */
  retiring: boolean;
  /**
   * The operator switched this server off — {@link SlotSet.disabled}. The lane
   * is drawn greyed with its switch on it rather than removed, so a card you
   * own and turned off never looks like one BookForge cannot find.
   */
  disabled: boolean;
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
  /**
   * THE MACHINE BEHIND THIS LANE IS NOT ANSWERING — its last refusal, in the
   * transport's own words — or null.
   *
   * ── Why a lane says this at all ────────────────────────────────────────────
   *
   * The switch above a GPU lane is the operator's standing choice about that
   * hardware; whether the hardware is AWAKE is a different fact entirely, and
   * until 2026-09-18 the bench knew only the first. A Mac that had gone to sleep
   * drew a lane identical to a working one, and the books bound for it simply
   * never started — the reason sitting in the scheduler's own reach cache, one
   * process away (`QueueSnapshot.servers`).
   *
   * ── The three rules ────────────────────────────────────────────────────────
   *
   *  - ONLY A SERVER'S GPU LANE. `local-work` is this app's CPU pair and
   *    `local-longform-align` is its own aligner: neither has a machine to be
   *    unreachable, which is the same test `switchOf` makes about the switch.
   *  - DISABLED WINS. A server the operator switched off is not being asked, so
   *    "down" would be a claim nobody measured. The lane already says `off`, and
   *    that is the fact that matters about it.
   *  - IT IS OBSERVED, NEVER WRITTEN. Nothing derives `disabled` from this, and
   *    no surface may: a machine that is asleep has not been switched off, and
   *    turning the one into the other would disable hardware on the operator's
   *    behalf and leave it disabled after it woke.
   */
  down: string | null;
  /**
   * The card's latest reading, on the GPU lane only, while something samples.
   * `throttleSustained` on it is the warning: the driver itself saying the card is
   * slowing down — which is what "the run is mysteriously slow" looked like
   * from the outside before this existed.
   */
  thermal: GpuThermalReading | null;
}

/**
 * The reach detail for a lane's machine, or null — {@link BenchLane.down}.
 *
 * A lane whose set is not a registered server is answered null without looking:
 * `servers` is keyed by server name, and a cloud lane's id (`<server>:cloud`)
 * is deliberately not one, so nothing here can accidentally match it.
 */
function laneDown(
  snapshot: QueueSnapshot,
  setId: string,
  resource: StepResource,
  disabled: boolean,
): string | null {
  if (resource !== 'gpu') return null;
  if (disabled) return null;
  if (setId === LOCAL_WORK_SET || setId === LONGFORM_ALIGN_SET) return null;
  const row = snapshot.servers.find((s) => s.name === setId);
  if (row === undefined || row.reach !== 'unreachable') return null;
  /*
   * A reach of `unreachable` with no detail would be a lane greyed out with
   * nothing to hover — the shape `voice-inventory.ts` refuses on the server's
   * own unloadable rows. The engine always carries the transport's sentence, so
   * an empty one can only be a defect on the way here; it is named rather than
   * drawn as a blank tooltip.
   */
  return row.detail ?? `"${setId}" is not answering, and nothing said why.`;
}

/** Everything drawn on one lane's occupant, read off a running step. */
function occupantOf(job: QueueJob, step: QueueStep): LaneOccupant {
  return {
    jobId: job.id,
    stepId: step.id,
    verb: JOB_GERUND[step.type],
    title: job.title,
    label: step.label,
    percent: step.progress.percent ?? null,
    ...(step.progress.message === undefined ? {} : { message: step.progress.message }),
    ...(step.progress.detail === undefined ? {} : { detail: step.progress.detail }),
    ...(step.progress.activeBatch === undefined
      ? {}
      : { activeBatch: step.progress.activeBatch }),
    ...(step.progress.prep === undefined ? {} : { prep: step.progress.prep }),
    stages: step.progress.stages ?? [],
  };
}

/**
 * THE BOOK KEEPING A CARD BETWEEN ITS GPU STEPS, drawn in the slot it is
 * charged (Owen, 2026-09-20 — `gpuHoldOf`).
 *
 * A charged slot with an empty lane would be the bench contradicting its own
 * count, and the row waiting for that card would be told it is waiting for
 * nobody. The step it names is the one the book is actually doing —
 * {@link gpuHoldStep} — so the lane's Stop button acts on something real: on
 * the render's CPU tail while it copies, and otherwise on the GPU act the book
 * is holding the card for, which is precisely the gesture that gives the card
 * back (a stopped step is `held`, and a held step ends the hold).
 */
function heldOccupant(job: QueueJob): LaneOccupant | null {
  const step = gpuHoldStep(job);
  const words = gpuHoldWords(job);
  if (step === null || words === null) return null;
  return {
    jobId: job.id,
    stepId: step.id,
    // NOT the step's gerund: the step is not what the card is doing. A lane
    // reading "Narrating Mistborn" while the render is copying files would be
    // the exact wrong answer to "why is my card busy".
    verb: 'Holding the card',
    title: job.title,
    label: step.label,
    percent: step.progress.percent ?? null,
    message: words,
    ...(step.progress.detail === undefined ? {} : { detail: step.progress.detail }),
    stages: step.progress.stages ?? [],
  };
}

/**
 * Every slot of every machine, occupied or not, in a stable order: the sets in
 * the order the engine listed them (servers by rank, then the legacy spawn,
 * then BookForge's own work), and within each set the GPU before the CPU pool.
 *
 * ALL slots are always returned. A free slot is information — it says nothing
 * queued wants that resource, which is the difference between a queue that is
 * stuck and a queue that has nothing to do — and a surface that drew only the
 * busy ones could not tell those apart either.
 *
 * Per MACHINE since crucible `docs/PHASE7-LANES.md` §2.4: one global GPU lane
 * could not show two books rendering on two machines at once, which is the
 * whole reason a second server exists.
 */
export function benchLanes(snapshot: QueueSnapshot): BenchLane[] {
  const lanes: BenchLane[] = [];
  /*
   * A hold on a row that has NO machine yet — "this book does not say which
   * Crucible server to render on". It belongs to no set, so it is drawn once,
   * on the first free GPU lane on the bench, rather than repeated on every set
   * (which would read as every machine being blocked) or dropped (which would
   * leave the tray chip with nothing to say about a queue that is stuck).
   */
  let unrouted = unroutedHold(snapshot);

  for (const set of snapshot.slotSets) {
    for (const resource of ['gpu', 'cpu'] as const) {
      const of = resource === 'gpu' ? set.gpu : set.cpu;
      if (of === 0) continue;

      const occupants: LaneOccupant[] = [];
      for (const job of snapshot.jobs) {
        for (const step of job.steps) {
          if (step.status !== 'running' || step.resource !== resource) continue;
          if (slotSetForStep(job, step) !== set.id) continue;
          occupants.push(occupantOf(job, step));
        }
      }
      // The held card, after the running work and never instead of it: the
      // hold exists only in the gaps (`gpuHoldCharges`), so these two can
      // never name the same book on the same card.
      if (resource === 'gpu') {
        for (const job of snapshot.jobs) {
          if (!gpuHoldCharges(job, set.id)) continue;
          const held = heldOccupant(job);
          if (held !== null) occupants.push(held);
        }
      }

      for (let index = 1; index <= of; index += 1) {
        const occupant = occupants[index - 1] ?? null;
        // A hold is a fact about the POOL, not about one slot, so it is shown on
        // the first free slot of that pool and nowhere else — repeated on both
        // CPU slots it would read as two separate blockages.
        const firstFree = occupant === null && index === occupants.length + 1;
        let hold: string | null = null;
        if (firstFree) {
          hold = admissionHoldFor(snapshot, set.id, resource);
          if (hold === null && resource === 'gpu' && unrouted !== null) {
            hold = unrouted;
            unrouted = null;
          }
        }
        lanes.push({
          setId: set.id,
          setLabel: set.label,
          retiring: set.retiring,
          disabled: set.disabled,
          resource,
          index,
          of,
          occupant,
          hold,
          down: laneDown(snapshot, set.id, resource, set.disabled),
          /*
           * THE THERMAL READING IS THIS MACHINE'S CARD, so it goes on no
           * remote set's lane. `gpuThermal` is sampled by nvidia-smi here; a
           * remote render's temperature is the other machine's to report and
           * BookForge has never asked for it. Drawing it on the Mac's lane
           * would be this PC's fan speed labelled as somebody else's.
           */
          thermal: resource === 'gpu' && isThisMachine(set.id)
            ? (snapshot.gpuThermal ?? null)
            : null,
        });
      }
    }
  }

  return lanes;
}

// ────────────────────────────────────────────────────────────────────────────
// The bench, GROUPED
// ────────────────────────────────────────────────────────────────────────────

/**
 * WHICH GROUP A LANE BELONGS TO.
 *
 * Owen, 2026-09-15: *"im not a fan of how the slots are laid out. maybe we
 * should have a local cpu slot section and a gpu slot section. they look kind of
 * ugly clustered together randomly. and its hard to tell which slot im looking
 * at unless i look closely at the names."*
 *
 * `gpu` — the Crucible engines' cards, one row per engine. **This is the
 *   section the dial acts on**, which is why it is first and why the dial is
 *   drawn on its heading rather than in the toolbar: the control sits on the
 *   thing it governs.
 * `cpu` — what BookForge does itself: `local-work`'s two slots.
 * `cloud` — an engine's upstream lane, which is neither.
 *
 * ── Why `cloud` exists when the ruling named two sections ───────────────────
 *
 * The ruling defines the two by their TENANTS ("the Crucible engines", "the two
 * `local-work` slots") and then places the aligner row "with the section its
 * resource says it is" — GPU, which is where {@link laneGroup} puts it. A cloud
 * lane (`<server>:cloud`, crucible PHASE15 §5.3) is a `cpu` lane that belongs to
 * neither tenant: it holds no card, and it is emphatically not this machine's
 * own CPU — the work is on somebody's API and the engine is forwarding it.
 * Filing it under "CPU slots" would be a heading that lies about what is in it,
 * which is the failure this whole document is about. It is drawn only when such
 * a lane exists, which is the ruling's own rule for empty sections.
 */
export type BenchGroup = 'gpu' | 'cpu' | 'cloud';

function laneGroup(lane: BenchLane): BenchGroup {
  if (lane.resource === 'gpu') return 'gpu';
  return serverOfCloudLane(lane.setId) === null ? 'cpu' : 'cloud';
}

/** One heading's worth of bench. */
export interface BenchSection {
  group: BenchGroup;
  /** The heading, as the user reads it. */
  heading: string;
  /** The one line under it saying what the group IS. */
  note: string;
  lanes: BenchLane[];
  /** How many of this section's lanes hold something. */
  inUse: number;
}

const SECTION_ORDER: readonly BenchGroup[] = ['gpu', 'cpu', 'cloud'];

const SECTION_WORDS: Readonly<Record<BenchGroup, { heading: string; note: string }>> = {
  gpu: {
    heading: 'GPU — the Crucible engines',
    note: 'One card per registered engine. Switch one off to keep new work away from it.',
  },
  cpu: {
    // Owen, 2026-09-15: *"it shouldnt be called 'BookForge itself', it can be
    // called 'CPU slots'."* These two have no switch either — they are what
    // this machine does for itself, and there is nowhere else for that work to
    // go, so an off position would only ever mean "stop working".
    heading: 'CPU slots',
    note: 'Assembly, muxing, exports — work this machine does and never sends anywhere.',
  },
  cloud: {
    heading: 'Routed elsewhere',
    note: 'An engine forwarding a request to its upstream. No card is held by it.',
  },
};

/**
 * THE BENCH IN GROUPS, in a fixed order, with EMPTY SECTIONS ABSENT.
 *
 * A heading with nothing under it is worse than nothing — Owen's own rule in the
 * same paragraph — so a machine with no Crucible server draws no GPU section at
 * all rather than an empty one captioned as though a card ought to be there.
 *
 * The lanes themselves are untouched and in {@link benchLanes}' order: this
 * groups them, it does not re-derive them. The overall "N of M slots in use"
 * stays the page's, computed off the same list.
 */
/**
 * THE BENCH GRID — how many lanes sit on each row, Owen's rule of 2026-09-15.
 *
 * *"if theres one gpu available, the gpu slot stretches across the whole screen,
 * left to right. if there are two, the two are split... if there are three,
 * split it into thirds... if there are four, drop the third and fourth down to a
 * second row and split it in half. if there are five, row 1 gets 3, row 2 gets
 * 2. if 6, row 1 gets 3, row 2 gets 3, etc."*
 *
 * Three per row at most, and then AS EVEN AS THEY GO. Both halves are load
 * bearing and the second one is why this is a function rather than a
 * `repeat(3, 1fr)`: filling rows of three greedily would put four lanes at 3+1,
 * and Owen's four is 2+2. Evenness is the rule his examples actually describe —
 * `rows = ceil(n / 3)`, then n spread across them, bigger rows first —
 * and it reproduces every number he gave:
 *
 *   1 -> [1]      4 -> [2,2]     7 -> [3,2,2]
 *   2 -> [2]      5 -> [3,2]     8 -> [3,3,2]
 *   3 -> [3]      6 -> [3,3]     9 -> [3,3,3]
 *
 * A row is drawn as its own grid of exactly this many columns, so the two lanes
 * on a 3+2 second row take half the width each rather than sitting under the
 * first two columns with a hole on the right. That is what "row 2 gets 2" reads
 * as on a bench, and it is the whole reason the row sizes are computed here
 * instead of left to `grid-auto-flow`.
 */
export const BENCH_ROW_MAX = 3;

export function benchRowSizes(count: number): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`benchRowSizes: ${count} is not a lane count`);
  }
  if (count === 0) return [];
  const rows = Math.ceil(count / BENCH_ROW_MAX);
  const base = Math.floor(count / rows);
  // The remainder goes one lane to each of the FIRST rows, which is what makes
  // 5 read 3 then 2 rather than 2 then 3.
  const wide = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < wide ? 1 : 0));
}

/** The lanes of one section, cut into {@link benchRowSizes} rows. */
export function benchRows<T>(lanes: readonly T[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const size of benchRowSizes(lanes.length)) {
    out.push(lanes.slice(at, at + size));
    at += size;
  }
  return out;
}

export function benchSections(snapshot: QueueSnapshot): BenchSection[] {
  const lanes = benchLanes(snapshot);
  const sections: BenchSection[] = [];
  for (const group of SECTION_ORDER) {
    const mine = lanes.filter((lane) => laneGroup(lane) === group);
    if (mine.length === 0) continue;
    sections.push({
      group,
      heading: SECTION_WORDS[group].heading,
      note: SECTION_WORDS[group].note,
      lanes: mine,
      inUse: mine.filter((lane) => lane.occupant !== null).length,
    });
  }
  return sections;
}

/**
 * Does this slot set run on the card BookForge itself drives?
 *
 * {@link LONGFORM_ALIGN_SET} alone, and that is the whole answer since Owen's
 * ruling of 2026-09-19: *"Crucible is configured to be system agnostic … it
 * should effectively be treated the same locally or otherwise."* A Crucible
 * server is scheduled — and drawn — identically whether it answers on this
 * machine's loopback or across the tailnet, so no server's lane claims this
 * PC's thermal reading. A registered engine reports its own card through its
 * own door or not at all; nvidia-smi run HERE knows nothing about the Mac, and
 * a reading labelled with somebody else's hardware is a number a person acts
 * on.
 *
 * So the reading is drawn only while the in-app aligner's row is on the bench,
 * and that row appears only while an `epub-align` step is charged. The card's
 * temperature is therefore usually not drawn at all — a missing decoration
 * rather than a lie, and deliberately left that way.
 */
function isThisMachine(setId: string): boolean {
  return setId === LONGFORM_ALIGN_SET;
}

/**
 * The hold keeping work out of one machine's pool, or null.
 *
 * Read off the steps rather than re-derived, because the engine is the only
 * thing that knows whether admission refused — it holds the lock file and the
 * arbiter. A reader that re-checked them here would be a second opinion about a
 * decision that has already been made.
 */
function admissionHoldFor(
  snapshot: QueueSnapshot,
  setId: string,
  resource: StepResource,
): string | null {
  if (resource !== 'gpu') return null;
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'queued' || step.resource !== resource) continue;
      if (slotSetForStep(job, step) !== setId) continue;
      if (step.progress.admissionHold !== undefined) return step.progress.admissionHold;
    }
  }
  return null;
}

/** The first hold on a queued GPU row that has not been given a machine yet. */
function unroutedHold(snapshot: QueueSnapshot): string | null {
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'queued' || step.resource !== 'gpu') continue;
      if (slotSetForStep(job, step) !== null) continue;
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
  /**
   * This book has a step that can run on a Crucible server, so the question
   * *"which server should it wait for"* applies to it and the page draws a
   * picker. False for a book of passes and assemblies, which travel nowhere
   * (crucible `docs/PHASE7-LANES.md` §4: a step that has not been taught to
   * travel does not travel).
   */
  travels: boolean;
  /**
   * What its runs SAY: a server's name, `any`, or `null` for a run that says
   * nothing (§4.2.1a's two honest absences — see `shared/queue/wait-for.ts`).
   *
   * A LIST, distinct, in the order the runs were found, because a book can be
   * spread across more than one run and they could disagree. One entry is the
   * ordinary case and the picker shows it; more than one is a state the page
   * says out loud rather than picking a winner from.
   */
  waitFor: Array<string | null>;
  /**
   * Where its work was actually sent, once it has been — a server's name.
   * Empty until the first GPU step is admitted; after
   * that the picker is read-only, because a job finishes on the machine it
   * started on (§4.3).
   */
  waitForResolved: string[];
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
 * CAN A PRESS ON THIS ROW ACTUALLY START IT?
 *
 * `held` alone is not the answer, and drawing Start on a row where it is not
 * was the defect (bug hunt 2026-09-20, Q8). A chain's rows are all `held` until
 * the run is started, so a held step BEHIND a held parent was drawn with a
 * Start button that calls `release({stepId})` — which sets the row `waiting`
 * and launches nothing, because its parent has not run. The press did
 * something invisible and the book did not move. Worse on the same shape:
 * `allHeld` is false whenever one row is mid-chain, so "Start this book" was
 * suppressed on exactly the run that needed it.
 *
 * So a row is startable when the work in front of it is finished: its parent
 * is `done`, or it reads the SOURCE and has no parent at all. A row behind a
 * live parent is not offered a press — its reason already says what it is
 * behind, which is the truthful instruction.
 *
 * Deliberately NOT "parent terminal": a parent that failed or was cancelled
 * did not write what this step reads, and offering to start it would be
 * offering to run it on nothing.
 */
function startableStep(snapshot: QueueSnapshot, step: QueueStep): boolean {
  if (step.status !== 'held') return false;
  const parent = parentStep(snapshot, step);
  return parent === null || parent.status === 'done';
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
    // A staged run is not "up next": it is not in the queue at all until it is
    // sent, and the tray's flat list has no room to say the difference. The
    // chip counts it separately; the page draws it in its own band.
    if (job.pending === true) continue;
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
        startable: startableStep(snapshot, step),
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
  return plansOf(snapshot, false);
}

/**
 * THE PENDING BAND — books that have been ADDED but not sent.
 *
 * `docs/PENDING-QUEUE-AND-GPU-DIAL.md` §1-§3: adding a book stages it, its
 * server is chosen there while nothing is committed, and **Send to queue** moves
 * it into the live queue.
 *
 * The same shape as {@link bookPlans} and the same grouping, deliberately: a
 * pending item IS a book's plan — the chain it will run, and the one answer to
 * "which machine" that every step of it follows — and a second vocabulary for
 * the same object is what would make the two bands disagree about what a book
 * is. The only difference is which side of the press it is on, and that is the
 * one argument this pair takes.
 *
 * `travels` is true of every row here by construction (only a run that can
 * travel is ever staged, see {@link QueueJob.pending}), so the picker is always
 * drawn — which is the whole point of the band.
 */
export function pendingPlans(snapshot: QueueSnapshot): BookPlan[] {
  return plansOf(snapshot, true);
}

function plansOf(snapshot: QueueSnapshot, pending: boolean): BookPlan[] {
  const byKey = new Map<string, BookPlan>();

  for (const job of snapshot.jobs) {
    if ((job.pending === true) !== pending) continue;
    if (!isLive(job)) continue;
    // Runs about the same project are one book's work. A run about no project
    // is its own group: nothing else can be said to belong with it.
    const key = job.projectId ?? job.id;
    let plan = byKey.get(key);
    if (plan === undefined) {
      plan = {
        key, title: job.title, jobIds: [], steps: [], allHeld: true,
        travels: false, waitFor: [], waitForResolved: [],
      };
      byKey.set(key, plan);
    }
    plan.jobIds.push(job.id);

    if (job.steps.some((step) => step.travels === true)) {
      plan.travels = true;
      // Distinct, order-preserving: one entry is the ordinary case and two is a
      // disagreement the page reports rather than resolves.
      const says = job.waitFor ?? null;
      if (!plan.waitFor.includes(says)) plan.waitFor.push(says);
      if (job.waitForResolved !== undefined && !plan.waitForResolved.includes(job.waitForResolved)) {
        plan.waitForResolved.push(job.waitForResolved);
      }
    }

    for (const step of job.steps) {
      if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
      plan.steps.push({
        jobId: job.id,
        stepId: step.id,
        label: step.label,
        status: step.status,
        percent: step.progress.percent ?? null,
        reason: step.status === 'running' ? null : stillReason(snapshot, job, step),
        startable: startableStep(snapshot, step),
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
