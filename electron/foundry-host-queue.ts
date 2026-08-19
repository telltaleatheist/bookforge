/**
 * foundry-host-queue — BookForge's queue, offered to the hosted Foundry window.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-18: *"we need to centralize the queue in bookforge. foundry has
 * their own queue but things shouldnt be queued in foundry's queue from within
 * bookforge. we need to centralize the queue."*
 *
 * He had pressed Read on two books in the hosted window, looked in BookForge's
 * queue, and found it empty. It was empty correctly — the work was in Foundry's
 * queue — and one of the two books then sat HELD in a list he was not looking at
 * and evaporated on the next restart, because that list is in memory with no
 * store behind it.
 *
 * ── What crosses, and what does not ─────────────────────────────────────────
 *
 * SCHEDULING CROSSES. EXECUTION DOES NOT. Foundry's runner writes the ledger,
 * fills the bank, rotates the working tree and announces export landings; this
 * side reimplementing any of that is two copies of one truth waiting to disagree.
 * So Foundry hands us the request, we mint the row and decide when, and we call
 * back into `runJob` when its turn comes.
 *
 * ONLY WHAT A PERSON PRESSED IN THE HOSTED WINDOW CROSSES. Work the HOST itself
 * ordered through the mount seam stays on Foundry's internal path, and that line
 * is not a nicety — it is a deadlock this design would otherwise build. Foundry's
 * `exportEpubFromStep` (the call our own Narrate makes to auto-mint an EPUB)
 * ENQUEUES, and awaits its own queue's settle. Route that into our queue and our
 * scheduler is asked to schedule work while inside a call it is itself awaiting;
 * on one gpu resource that is a hard hang. Their agent caught it, and their rule
 * is the fix: by calling them we have already made the scheduling decision, so
 * that export is not "queued in Foundry's queue from within BookForge", it is
 * BookForge's own act being executed. Owen's sentence stays literally true and
 * the loop cannot form. (Agreed on the channel, 2026-08-18, their seq 25.)
 *
 * ── The shapes below are THEIRS, re-declared ────────────────────────────────
 *
 * `foundry-host-nodes.ts` and `foundry-host-status.ts` set the house rule: the
 * published spellings from `foundry-app/shared/types.ts` are written out here
 * rather than imported, so a change on their side is a compile error in a file
 * whose comments say what the field meant, instead of a silent retype.
 */
import {
  cancel as engineCancel,
  enqueue as engineEnqueue,
  onAfterPump,
  onQueueChanged,
  remove as engineRemove,
  snapshot,
  start as engineStart,
} from './queue-engine';
import { TERMINAL_STEP_STATUSES } from '../shared/queue/engine-types';
import type { QueueJob, QueueStep } from '../shared/queue/engine-types';

// ─────────────────────────────────────────────────────────────────────────────
// Foundry's published shapes (foundry-app/shared/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** `ConversionKind | 'read' | 'env-install' | 'translate'`, minus the one we never see. */
export type FoundryJobKind = 'epub' | 'txt' | 'pdf' | 'read' | 'translate';

/** Their `JobState`. `waiting` has no spelling there, so ours maps onto `queued`. */
export type FoundryJobState = 'held' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * A request, stored VERBATIM and never normalised on the way in.
 *
 * Foundry composes it from facts this side does not have — the workspace plan,
 * the readings path, the step id minted for a branching re-read — so a field
 * this engine helpfully filled in would be a decision taken by the wrong
 * process. Indexed rather than fully enumerated for the same reason: their
 * request grows fields (it grew `stepId`), and a row that dropped one on the
 * way through would be a run configured by omission.
 */
export interface FoundryJobRequest {
  kind: FoundryJobKind;
  inputPath: string;
  /** Present on a read: the bank this job fills, and its identity. */
  readingsPath?: string;
  /** Present on a rendering: the file it writes. */
  outputPath?: string;
  [field: string]: unknown;
}

export interface FoundryJobProgress {
  done?: number;
  total?: number;
  message?: string;
  /** Their "not a count" line — see `Job.note`. What tells working from wedged. */
  note?: string | null;
}

/** Their `Job`, as their shelf draws it. */
export interface FoundryJobRow {
  id: string;
  inputPath: string;
  outputPath: string;
  kind: FoundryJobKind;
  state: FoundryJobState;
  progress: FoundryJobProgress | null;
  title?: string;
  error?: string;
  message?: string;
  parentStep?: string | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type FoundrySettled = { ok: true } | { ok: false; error: string };

export interface FoundryRunJobOptions {
  parentStep: string | null;
  signal: AbortSignal;
  onProgress(progress: FoundryJobProgress): void;
}

/** What the mount must offer for a row of ours to be runnable at all. */
export type FoundryRunner =
  (request: FoundryJobRequest, opts: FoundryRunJobOptions) => Promise<FoundrySettled>;

// ─────────────────────────────────────────────────────────────────────────────
// The seam, injected
// ─────────────────────────────────────────────────────────────────────────────

/*
 * INJECTED RATHER THAN IMPORTED, on `setGpuHolderProbe`'s precedent in the engine
 * itself. The mount is loaded by main and cannot be reached from here without a
 * cycle; handing the three functions in at mount time keeps this module testable
 * and keeps main the one place that knows where the subtree sits.
 */
let runner: FoundryRunner | null = null;
let pushRows: ((projectDir: string, rows: readonly FoundryJobRow[]) => void) | null = null;
let sayDrained: (() => void) | null = null;

export function setFoundrySeam(seam: {
  runJob: FoundryRunner | null;
  setQueueRows: ((projectDir: string, rows: readonly FoundryJobRow[]) => void) | null;
  drained: (() => void) | null;
}): void {
  runner = seam.runJob;
  pushRows = seam.setQueueRows;
  sayDrained = seam.drained;
}

/** The runner, or the sentence saying why this row cannot run. */
export function foundryRunner(): FoundryRunner {
  if (runner === null) {
    throw new Error(
      'This version of the Foundry engine cannot be asked to run one job on demand, so BookForge '
      + 'cannot schedule its work. Update Foundry — the queue seam (runJob) arrives with it.',
    );
  }
  return runner;
}

// ─────────────────────────────────────────────────────────────────────────────
// Our row <-> their row
// ─────────────────────────────────────────────────────────────────────────────

/** What a `foundry-job` step carries. Read by the step module and by `rows`. */
export interface FoundryJobStepConfig {
  type: 'foundry-job';
  request: FoundryJobRequest;
  parentStep: string | null;
  projectDir: string;
  label: string;
}

function configOf(step: QueueStep): FoundryJobStepConfig | null {
  if (step.type !== 'foundry-job') return null;
  const config = step.config as unknown as FoundryJobStepConfig;
  return config?.request ? config : null;
}

/**
 * Our status, in their vocabulary.
 *
 * `waiting` becomes `queued`, which is the only lossy pair and is honest: their
 * shelf's distinction is person-vs-machine ("held means waiting for you, queued
 * means waiting for the machine"), and a step waiting on a parent is waiting for
 * the machine. There is nothing for a person to do about it either way.
 */
function stateOf(step: QueueStep): FoundryJobState {
  switch (step.status) {
    case 'held': return 'held';
    case 'waiting': return 'queued';
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

/**
 * One of our steps as their shelf draws it.
 *
 * THE ID IS THE STEP'S, not the job's. A hosted read is one step of one run —
 * which is exactly what their row models — and every gesture they send back
 * (cancel, remove) names what they were given.
 */
function rowOf(step: QueueStep): FoundryJobRow {
  const config = configOf(step);
  const request = config?.request;
  return {
    id: step.id,
    inputPath: String(request?.inputPath ?? ''),
    // Their identity for a read IS the bank ("it points at what it actually
    // makes"), so the same field carries the same fact here.
    outputPath: String(request?.readingsPath ?? request?.outputPath ?? ''),
    kind: (request?.kind ?? 'read') as FoundryJobKind,
    state: stateOf(step),
    progress: step.progress
      ? { done: undefined, total: undefined, message: step.progress.message }
      : null,
    title: config?.label,
    error: step.error,
    message: step.progress?.message,
    parentStep: config?.parentStep ?? null,
    createdAt: Date.parse(step.addedAt),
    startedAt: step.startedAt ? Date.parse(step.startedAt) : undefined,
    finishedAt: step.finishedAt ? Date.parse(step.finishedAt) : undefined,
  };
}

function foundrySteps(): { job: QueueJob; step: QueueStep }[] {
  const out: { job: QueueJob; step: QueueStep }[] = [];
  for (const job of snapshot().jobs) {
    for (const step of job.steps) if (configOf(step) !== null) out.push({ job, step });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The queue Foundry is handed
// ─────────────────────────────────────────────────────────────────────────────

export const foundryHostQueue = {
  /**
   * Mint the row. SYNCHRONOUS, which is the guarantee their shelf needs.
   *
   * Their `enqueue` returns the row immediately and deliberately — "pressing Add
   * cannot leave a moment where nothing has appeared" — and ours does too
   * (`queue-engine.enqueue` builds, pushes, notifies and returns, awaiting
   * nothing; persistence is a separate call no enqueuer waits on).
   *
   * THE PUMP IS DEFERRED, and that is not an implementation detail. Our enqueue
   * ends `changed(); pump();` inline, and pump runs synchronously into a step
   * module's first await — so without deferring, this call would re-enter Foundry
   * through `runJob` before it had returned the row Foundry is waiting for. See
   * EnqueueOptions in queue-engine.ts.
   *
   * HELD FOR A READ, RELEASED FOR EVERYTHING ELSE — their rule, kept exactly.
   * The hold exists so that hours of GPU are never spent by the act of
   * configuring them; a rendering spends none, so making it wait would be the
   * mechanism applied to the case it was never about. What changes is only WHOSE
   * Start releases it, and that is the whole of the fix for what Owen hit: he
   * pressed Start, then added a second book, and their Start "releases everything
   * held AT THAT MOMENT and nothing else" — so the second sat held in a list he
   * was not looking at. Now it is held in the list he is looking at.
   */
  enqueue(request: FoundryJobRequest, parentStep: string | null, projectDir: string): FoundryJobRow {
    const label = labelFor(request);
    const config: FoundryJobStepConfig = {
      type: 'foundry-job',
      request,
      parentStep,
      projectDir,
      label,
    };
    const job = engineEnqueue({
      title: label,
      documentPath: request.inputPath,
      documentLabel: label,
      steps: [{
        type: 'foundry-job',
        label,
        config: config as unknown as Record<string, unknown>,
        sourceRef: { kind: 'none' },
      }],
      release: request.kind !== 'read',
    }, { deferPump: true });

    const step = job.steps[0];
    if (!step) {
      throw new Error('The queue minted a Foundry run with no step, which cannot happen.');
    }
    return rowOf(step);
  },

  /** Their shelf's gestures, forwarded. The rows are ours to move. */
  async cancel(id: string): Promise<void> { await engineCancel({ stepId: id }); },
  async remove(id: string): Promise<void> { await engineRemove(id); },
  start(): void { engineStart(); },

  /**
   * Sweep the settled rows — their `queue:clear-finished`, which hosted must
   * sweep OURS or it clears an empty local list while the rows stay on screen.
   *
   * FOUNDRY'S ROWS ONLY, which is a deliberate narrowing of our own
   * `clearFinished()`. That one sweeps every finished job in BookForge's queue,
   * and a press on Foundry's shelf must not silently clear a narration history in
   * a window the user is not looking at. The button sweeps what the shelf draws.
   *
   * ACROSS ALL PROJECTS rather than the open one, matching their own local
   * semantics (their `clearFinished` is global over their queue). Flagged to them
   * on the channel — if their shelf means "this book's finished rows", this takes
   * a projectDir and nothing else changes.
   */
  async clearFinished(): Promise<void> {
    for (const { job, step } of foundrySteps()) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) continue;
      // A Foundry run is one job of one step, so removing the job removes
      // exactly the row their shelf is asking about.
      await engineRemove(job.id);
    }
  },

  /**
   * Every Foundry row for one project, in the order this queue holds them.
   *
   * THE WHOLE SET, every time — `setHostNodes`' rule in the other direction. A
   * row that has left this list has left it, and a merge would keep a finished
   * read on their shelf forever because nothing ever said the word "delete".
   */
  rows(projectDir: string): readonly FoundryJobRow[] {
    const want = fold(projectDir);
    return foundrySteps()
      .filter(({ step }) => fold(configOf(step)!.projectDir) === want)
      .map(({ step }) => rowOf(step));
  },
};

/** Windows spells one path three ways; one project must not be two lists. */
function fold(p: string): string { return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

/** What the row is called, in BookForge's queue and on their shelf. */
function labelFor(request: FoundryJobRequest): string {
  const file = String(request.inputPath ?? '').split(/[\\/]/).pop() ?? 'a document';
  switch (request.kind) {
    case 'read': return `Read the pages — ${file}`;
    case 'translate': return `Translate — ${file}`;
    default: return `Make the ${request.kind.toUpperCase()} — ${file}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telling Foundry what changed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether any Foundry-executed step is RUNNING — the whole of the idle rule.
 *
 * ── Why RUNNING and not "running or queued" ─────────────────────────────────
 *
 * Foundry tears down or keeps warm its vLLM reading server off this signal, and
 * it asked for the narrower rule with a case that settles it: a read queued
 * behind two hours of TTS. On "running or queued" we would never say idle, so a
 * twenty-gigabyte reading server would sit holding VRAM for the whole narration —
 * against the card this centralization exists to protect, and possibly against
 * the narration fitting at all. On "running only" the timer expires, the VRAM
 * goes, and the queued read pays ONE model reload when its turn comes. A reload
 * is minutes; the alternative is hours, and they are the wrong hours.
 *
 * The back-to-back case is covered by them rather than by us: A ends, we say
 * idle, they arm a keep-warm timer, B starts a second later and their own
 * `noteQueueBusy` cancels it. Busy stays theirs; only drain is ours to report.
 */
function anyFoundryStepRunning(): boolean {
  return foundrySteps().some(({ step }) => step.status === 'running');
}

/**
 * EDGE-TRUTHFUL. Said once when the last Foundry step stops running, and not
 * again until one runs and stops once more.
 *
 * A heartbeat would be this side polling a fact it already knows, and a repeated
 * idle would re-arm their keep-warm timer over and over — which is the opposite
 * of the thing the narrow rule was chosen for.
 */
let wasRunning = false;

/** Arm the two pushes. Called once, from main, after the mount is up. */
export function watchFoundryQueue(): void {
  /*
   * IDLE IS ASKED AFTER THE PUMP HAS DECIDED, not when the queue changed.
   *
   * The first cut read it from `onQueueChanged` and that was wrong in the
   * ORDINARY case rather than an edge one. `changed()` fires the moment a step
   * settles, before the scheduler has looked at what is queued behind it — so two
   * reads batched would have gone: A settles, nothing is running yet because B is
   * still queued, we say idle, and Foundry stops its reading server OUTRIGHT
   * (their default keepServerWarmMinutes is 0 — no timer, an immediate
   * stopServer). The pump then launches B, which pays a full model reload. N
   * reads become N model starts.
   *
   * After the decision the same predicate is right everywhere: a Foundry step was
   * launched (not idle, the batch pays one start), something else was launched
   * with a read queued behind it (idle — free the VRAM for the narration, and the
   * read pays one reload when its turn comes, which is the case the narrow rule
   * was chosen for), or nothing was launched (idle).
   *
   * It also closes the `deferPump` window for free: nothing can emit in the gap
   * between a row being minted and the pump running.
   */
  onAfterPump(() => {
    const running = anyFoundryStepRunning();
    if (wasRunning && !running) {
      wasRunning = false;
      if (sayDrained !== null) sayDrained();
    } else if (!wasRunning && running) {
      wasRunning = true;
    }
  });

  onQueueChanged(() => {
    if (pushRows === null) return;
    /*
     * One push per project that has rows — AND ONE EMPTY PUSH, ONCE, for a
     * project that has just stopped having them.
     *
     * ── Why the empty edge is not "broadcasting the absence of news" ──────────
     *
     * The first cut pushed only projects that HAD rows, by analogy with
     * `setHostNodes`: a tree asks about a book when it opens one, so pushing
     * emptiness at books nobody mentioned would be noise. Foundry's agent found
     * the flaw in their own analogy (channel, 2026-08-19): the host-nodes tree is
     * per-project, but THE QUEUE SHELF IS NOT. It mirrors one global list —
     * `api.queue.onChanged((jobs) => this.all.set(jobs))`, every job in the
     * process, no project filter — because "what is this machine doing" is the
     * question it exists to answer.
     *
     * Against a replace-what-you-are-told mirror, silence is not neutral. Book
     * A's last Foundry row settles and is swept, A drops out of the map, nothing
     * is pushed for A — and A's stale rows sit on their shelf for the life of the
     * window, because a mirror that is never told is never corrected.
     *
     * So emptiness is pushed exactly ONCE, on the falling edge, and never again
     * until that project has rows to lose. Same discipline as the idle signal and
     * for the same reason: it is the one piece of news the other side cannot
     * infer, and repeating it would be a heartbeat.
     */
    const byProject = new Map<string, { dir: string; rows: FoundryJobRow[] }>();
    for (const { step } of foundrySteps()) {
      const dir = configOf(step)!.projectDir;
      // Folded, because Windows spells one path three ways and two spellings
      // would push two lists for one book — each replacing the other.
      const key = fold(dir);
      const held = byProject.get(key);
      if (held) held.rows.push(rowOf(step));
      else byProject.set(key, { dir, rows: [rowOf(step)] });
    }

    for (const [key, { dir, rows }] of byProject) {
      pushed.set(key, dir);
      pushRows(dir, rows);
    }
    for (const [key, dir] of [...pushed]) {
      if (byProject.has(key)) continue;
      pushed.delete(key);
      pushRows(dir, []);
    }
  });
}

/**
 * The projects we have pushed a non-empty list for, and the spelling we pushed
 * it under.
 *
 * Held so the falling edge can be seen at all: "this project has no rows" is only
 * news the first time, and the pushed spelling is kept rather than re-derived so
 * the empty list lands on the same key the rows did.
 */
const pushed = new Map<string, string>();
