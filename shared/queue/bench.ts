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
import {
  LONGFORM_ALIGN_SET, serverOfCloudLane, slotSetForStep, slotSetOccupancy, slotsOf,
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
    const inUse = step.resource === 'gpu' ? occupancy.gpu : occupancy.cpu;
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
  /** The set's heading, as the user reads it — "mac", "BookForge itself". */
  setLabel: string;
  /**
   * This set takes no new work and disappears when its occupant lands: its
   * server was disabled or removed mid-run (§4.3 — a job finishes on the
   * machine it started on).
   */
  retiring: boolean;
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
   * The card's latest reading, on the GPU lane only, while something samples.
   * `throttleSustained` on it is the warning: the driver itself saying the card is
   * slowing down — which is what "the run is mysteriously slow" looked like
   * from the outside before this existed.
   */
  thermal: GpuThermalReading | null;
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
          resource,
          index,
          of,
          occupant,
          hold,
          /*
           * THE THERMAL READING IS THIS MACHINE'S CARD, so it goes on no
           * remote set's lane. `gpuThermal` is sampled by nvidia-smi here; a
           * remote render's temperature is the other machine's to report and
           * BookForge has never asked for it. Drawing it on the Mac's lane
           * would be this PC's fan speed labelled as somebody else's.
           */
          thermal: resource === 'gpu' && isThisMachine(set.id, snapshot)
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
 * neither tenant: it holds no card, and it is emphatically not BookForge itself
 * — the work is on somebody's API and the engine is forwarding it. Filing it
 * under "BookForge itself" would be a heading that lies about what is in it,
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
    note: 'One card per registered engine. This is what the queue’s GPU dial steers.',
  },
  cpu: {
    heading: 'CPU — BookForge itself',
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
 * Does this slot set run on the machine BookForge is on?
 *
 * The in-app long-form aligner always does. A SERVER might — one that answers
 * on this machine's loopback is the same card — but the snapshot does not carry
 * which names those are. Since Owen's ruling of 2026-09-15 there is no reserved
 * word to spell either: the question is about ADDRESSES, which only the registry
 * holds (`electron/crucible/servers.ts serversOnThisMachine`). So a server's
 * lane carries no temperature at all, which is the honest answer for every
 * server somewhere else and a missing decoration for one here.
 *
 * CONSEQUENCE OF THE IN-APP ROW BECOMING CONDITIONAL (2026-09-15), and WIDENED
 * when the legacy narrator was deleted the same day: the reading is drawn only
 * while {@link LONGFORM_ALIGN_SET} is on the bench, and that row now appears
 * only while an `epub-align` step is queued. So the card's temperature — a fact
 * about THIS MACHINE, not about that step — is usually not drawn at all. That is
 * a missing decoration rather than a lie, and it is deliberately left that way:
 * what would fix it is the snapshot carrying which server names answer on this
 * machine's loopback — the scheduler already asks that question for its one-card
 * rule — and that is a RULING about what a bench row shows, not a bench change
 * (docs/LEGACY-REMOVAL.md).
 */
function isThisMachine(setId: string, _snapshot: QueueSnapshot): boolean {
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
