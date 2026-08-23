/**
 * queue-engine — the work, owned by MAIN.
 *
 * ── Why it is here and not in the renderer ──────────────────────────────────
 *
 * The scheduler used to be a 5,373-line Angular service. Everything wrong with
 * that arrangement follows from one fact: the thing deciding what runs was in a
 * process that can be reloaded, closed, or opened twice.
 *
 *  - A renderer reload orphaned the GPU. The e2a workers kept rendering, and the
 *    only thing that knew they existed was gone; the row froze at whatever
 *    percentage was on screen.
 *  - Every extra window booted its OWN scheduler. A Listen window loaded the
 *    same service, read the same `queue.json`, and its debounced auto-save wrote
 *    over the queue the user was watching. `app:show-book-conversion` carries the
 *    comment that names this: "a second window enqueueing into its own copy
 *    would write a queue file over the one the user is watching."
 *  - Progress arrived on eight per-bridge channels with eight wire shapes, each
 *    parsed by its own handler in the renderer, every one of them mainWindow-only.
 *
 * Main runs the bridges. Main is where the decision belongs. The renderer holds
 * a MIRROR, pushed whole on every change — the same posture foundry's job-queue
 * takes, for the same reason.
 *
 * ── What this file is and is not ────────────────────────────────────────────
 *
 * It is the state, the scheduler, the persistence and the cancel registry. It is
 * NOT the work: every job type lives in `queue-steps/<type>.ts` and is REGISTERED
 * here. That is what lets this file be tested without Electron — the keeper
 * suite registers three fake modules and a temp directory, and exercises
 * ordering, chaining, slots, cancellation, persistence and migration against the
 * real scheduler.
 *
 * Nothing in here imports `electron`. `configure()` is given the state directory,
 * and `onChanged` is where the broadcast is wired — main knows whether anybody is
 * listening; the engine does not.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * A step is runnable when: the queue is running, the step is `queued`, its parent
 * is `done`, and a slot of its resource is free. One GPU, two CPU.
 *
 * A GPU step additionally has to get past ADMISSION, and admission can say wait:
 *
 *  - `%APPDATA%\BookForge\external-gpu-job.lock` exists. Something outside this
 *    app — a training chain, a CLI render — is using the card and said so. The
 *    queue holds, and the step's message says what it is holding for. This is new
 *    behaviour and it is deliberate: previously the queue started anyway and two
 *    processes fought over the same VRAM.
 *  - the gpu-arbiter reports a holder that is not one of ours (llama's cleanup
 *    model, an enhance run, a clipforge chain). Same treatment.
 *
 * It CHECKS the arbiter rather than acquiring it, because the bridges acquire it
 * themselves (parallel-tts-bridge, enhance-bridge, llama-bridge all call
 * `acquireGpu`). An engine that took the lock first would hand the bridge a
 * deadlock against its own scheduler.
 */
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  jobStatus,
  RESOURCE_SLOTS,
  RETIRED_JOB_TYPES,
  SOURCE_PARENT,
  TERMINAL_STEP_STATUSES,
  type ArtifactKind,
  type ArtifactRef,
  type FoundryJobLineage,
  type GpuThermalReading,
  type GpuThermalSummary,
  type JobStageProgress,
  type JobType,
  type QueueJob,
  type QueueSnapshot,
  type QueueStep,
  type StepMetrics,
  type StepProgress,
  type StepResource,
  type StepStatus,
  type ActiveBatchProgress,
} from '../shared/queue/engine-types';

// ────────────────────────────────────────────────────────────────────────────
// The step-module contract
// ────────────────────────────────────────────────────────────────────────────

/** A progress report from a running step. Merged onto the step by `report`. */
export interface StepReport {
  percent?: number;
  message?: string;
  /**
   * What the running stage is doing.
   *
   * OMITTED means "no opinion, leave it alone" — a one-off event (a download
   * note) carries none, and blanking on every unrelated emit would flicker the
   * line away mid-run. `null` means "there is nothing to say now", and CLEARS
   * it.
   *
   * The distinction is load-bearing and was missing: with `undefined` serving
   * both roles, a detail could be set and never removed. "Loading model
   * weights…" is set when a worker starts loading and cleared when it finishes
   * — and the clear was dropped, so the queue announced that a model was
   * loading for the entire nine hours after it had loaded (Owen, 2026-08-19).
   */
  detail?: string | null;
  /** Stage bars. Nullish-kept, for the same reason. */
  stages?: JobStageProgress[];
  /**
   * The batch currently decoding. REPLACED, not kept — pass `null` to clear.
   * A landed batch must not leave a full secondary bar under a chunk bar that is
   * moving again.
   */
  activeBatch?: ActiveBatchProgress | null;
  /**
   * Which pass a Foundry row's counts are counting. Set on every count, because
   * a run can change pass mid-flight (the endpoint route rasterises the whole
   * book before it reads it) and a stale phase would label pages as blocks.
   */
  foundryPhase?: 'render' | 'read' | 'translate';
  /** Measurements. Merged key by key; a key that is absent is left alone. */
  metrics?: Partial<StepMetrics>;
}

export interface StepRunContext {
  readonly jobId: string;
  readonly stepId: string;
  readonly step: QueueStep;
  readonly job: QueueJob;
  /**
   * What this step reads: its parent's output, or its own `sourceRef` when the
   * parent is SOURCE. Never null — a step with neither is refused at compose
   * time, so a module may rely on this.
   */
  readonly input: ArtifactRef;
  readonly signal: AbortSignal;
  report(update: StepReport): void;
}

export interface StepModule {
  readonly type: JobType;
  /**
   * The artifact kind this step reads, or null when it reads whatever it is
   * pointed at and validating the kind would be a lie (a pass reads the project's
   * book, which the project owns rather than the previous step).
   */
  readonly consumes: ArtifactKind | null;
  readonly produces: ArtifactKind;
  /**
   * Which pool this step contends for, given its config. A function because the
   * answer depends on the config: a translate pass against Claude is network
   * latency and belongs in the cpu pool; the same pass against Ollama is the GPU.
   */
  resource(config: Record<string, unknown>): StepResource;
  /**
   * Whether stopping this step leaves work that can be picked up. TTS does — the
   * rendered sentences are on disk and a resume skips them — so a stop leaves the
   * step HELD and interrupted rather than cancelled.
   */
  readonly stopIsResumable?: boolean;
  run(ctx: StepRunContext): Promise<ArtifactRef>;
  /**
   * Stop the running work. The abort signal fires either way.
   *
   * The STEP is handed over as well as its id, because not every bridge is keyed
   * by job id: a document stage is claimed by PROJECT, and the project is on the
   * config. A module that had only the id would have to keep a registry of its
   * own to find it again.
   */
  cancel(stepId: string, step: QueueStep): void | Promise<void>;
}

const modules = new Map<JobType, StepModule>();

export function registerStepModule(mod: StepModule): void {
  if (modules.has(mod.type)) {
    throw new Error(`Two step modules claim the job type "${mod.type}". One type, one runner.`);
  }
  modules.set(mod.type, mod);
}

/** For the keeper suite, which registers fakes against a fresh engine. */
export function clearStepModules(): void {
  modules.clear();
}

function moduleFor(type: JobType): StepModule {
  const mod = modules.get(type);
  if (!mod) {
    throw new Error(
      `Nothing in this build knows how to run a "${type}" step, so it cannot be scheduled.`,
    );
  }
  return mod;
}

// ────────────────────────────────────────────────────────────────────────────
// Composition input
// ────────────────────────────────────────────────────────────────────────────

export interface StepSpec {
  type: JobType;
  label: string;
  config: Record<string, unknown>;
  /**
   * Index into THIS spec's `steps` array of the step this one reads. Absent means
   * it reads `sourceRef` — a file the user picked, not a file a step will write.
   */
  parentIndex?: number;
  sourceRef?: ArtifactRef;
  /** Overrides what the module would choose. Used by nothing today; here so a
   *  caller that knows better than the config can say so explicitly. */
  resource?: StepResource;
}

export interface JobSpec {
  title: string;
  projectId?: string;
  documentPath?: string;
  documentLabel?: string;
  /**
   * Set when Foundry ordered this run — see {@link FoundryJobLineage}.
   *
   * CAPTURED AT COMPOSE TIME AND NEVER AFTERWARDS. The invoke that opened the
   * narration modal is the only moment the ledger step is known; by the time a
   * step is running there is nothing left to ask.
   */
  foundry?: FoundryJobLineage;
  steps: StepSpec[];
  /**
   * Whether these steps are runnable the moment they exist. THREE-WAY.
   *
   * `true` — runnable whatever the engine is doing. For work whose ordering was
   * the scheduling decision (the Foundry host queue; main's foundry-narrate).
   *
   * `false` — held, explicitly. Composing a run must not be the moment it commits
   * the GPU: this is how "queue these four and run them overnight" stays a thing
   * this app can do, and how a plan is parked beside a queue that is already
   * running.
   *
   * `undefined` — the ordinary door, and it follows the engine: held while it is
   * idle (Start is still the gesture that begins the session's work), runnable
   * while it runs (a run added behind a running one joins the run — Owen,
   * 2026-08-23; see the rule in `enqueue`).
   */
  release?: boolean;
}

/** A step appended to a job that already exists — the parent may not have run. */
export interface AppendStepSpec extends Omit<StepSpec, 'parentIndex'> {
  /** An existing step's id, or SOURCE_PARENT. */
  parentStepId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Engine state
// ────────────────────────────────────────────────────────────────────────────

interface EngineConfig {
  /** Where the state file lives — `app.getPath('userData')` in the app. */
  stateDir: string;
  /**
   * Where the RETIRED renderer blob lives, for the one-time migration. Same
   * directory in the app; separate so the keeper suite can point at a fixture.
   */
  legacyQueueFile?: string;
}

let config: EngineConfig | null = null;
let jobs: QueueJob[] = [];
let running = false;
let listeners: Array<(snapshot: QueueSnapshot) => void> = [];

/** One entry per RUNNING step. The whole cancel story, in one place. */
interface RunningStep {
  jobId: string;
  stepId: string;
  type: JobType;
  abort: AbortController;
  resource: StepResource;
  /** Set when the user asked for this to stop, so the outcome is read as a stop. */
  stopRequested: boolean;
}
const runningSteps = new Map<string, RunningStep>();

function stateFile(): string {
  if (!config) {
    throw new Error('The queue engine was used before it was configured with a state directory.');
  }
  return path.join(config.stateDir, 'queue-engine.json');
}

function legacyFile(): string {
  if (!config) {
    throw new Error('The queue engine was used before it was configured with a state directory.');
  }
  return config.legacyQueueFile ?? path.join(config.stateDir, 'queue.json');
}

// ────────────────────────────────────────────────────────────────────────────
// Publication
// ────────────────────────────────────────────────────────────────────────────

/**
 * Where the queue publishes. Called with the WHOLE list on every change — the
 * renderer patches nothing, it replaces, so there is no way for a mirror to
 * drift from the truth by missing one event.
 */
export function onQueueChanged(listener: (snapshot: QueueSnapshot) => void): () => void {
  listeners.push(listener);
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

/**
 * What a step that just ended has to say to the rest of the app.
 *
 * Separate from `onQueueChanged` because it is an EVENT and not a state: linking
 * the finished audio into the project, filing its analytics and refreshing the
 * shelf must happen once, on the transition, and a listener that had to diff two
 * snapshots to find that transition would fire twice the first time it lost one.
 */
export interface StepFinished {
  jobId: string;
  stepId: string;
  type: JobType;
  label: string;
  projectId?: string;
  success: boolean;
  /**
   * What the step SETTLED AS, which `success` cannot express.
   *
   * `success` is a boolean over three outcomes: it finished, it failed, or the
   * USER STOPPED IT. A stop settles as `held` + `wasInterrupted` — resumable,
   * deliberate, and not news — but it reported `success: false` with no error,
   * so every listener that branched on the boolean announced "Run failed … no
   * reason given" for a button the user had just pressed themselves.
   *
   * Carried as the status rather than a `stopped` flag because the status is the
   * fact; a flag would be this one consumer's question baked into the event.
   */
  status: StepStatus;
  outputPath?: string;
  error?: string;
  analytics?: unknown;
  completionNotes?: string[];
}

let finishListeners: Array<(event: StepFinished) => void> = [];

export function onStepFinished(listener: (event: StepFinished) => void): () => void {
  finishListeners.push(listener);
  return () => { finishListeners = finishListeners.filter((l) => l !== listener); };
}

function announceFinished(event: StepFinished): void {
  for (const listener of finishListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('[QUEUE-ENGINE] a step-finished listener threw:', err);
    }
  }
}

export function snapshot(): QueueSnapshot {
  // A deep-enough copy: the mirror must not be able to reach back into the truth.
  return {
    running,
    ...(gpuThermal === null ? {} : { gpuThermal: { ...gpuThermal } }),
    jobs: jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => ({
        ...step,
        progress: { ...step.progress },
        metrics: { ...step.metrics },
        output: step.output ? { ...step.output } : undefined,
      })),
    })),
  };
}

/**
 * Progress is coalesced; structure is not.
 *
 * A run emits hundreds of progress lines a minute and every one of them would
 * otherwise be a whole-list broadcast and a whole-file write. Ten a second is
 * faster than a screen refreshes and cheap enough to persist. A STRUCTURAL change
 * — a step started, finished, was cancelled, a job was added — publishes and
 * writes immediately, because those are the facts a crash must not lose.
 */
const PROGRESS_FLUSH_MS = 100;
const PROGRESS_PERSIST_MS = 2000;
let progressDirty = false;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Admission is the one refusal nothing else re-triggers. Every other "not yet"
 * resolves through a state change that calls pump() — a step lands, a slot
 * frees, the user presses Start. The external GPU lock and a foreign arbiter
 * holder clear WITHOUT touching this engine: the training chain deletes its
 * lock file and nothing here hears it. So a pump that refused a step on
 * admission arms a recheck, and the recheck disarms itself the first time
 * nothing is being held back.
 */
let admissionRecheckMs = 15_000;
let admissionRecheckTimer: ReturnType<typeof setTimeout> | null = null;

function publish(): void {
  const snap = snapshot();
  for (const listener of listeners) {
    try {
      listener(snap);
    } catch (err) {
      console.error('[QUEUE-ENGINE] a queue:changed listener threw:', err);
    }
  }
}

function touchProgress(): void {
  progressDirty = true;
  if (!progressTimer) {
    progressTimer = setTimeout(() => {
      progressTimer = null;
      if (!progressDirty) return;
      progressDirty = false;
      publish();
    }, PROGRESS_FLUSH_MS);
    if (typeof progressTimer.unref === 'function') progressTimer.unref();
  }
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PROGRESS_PERSIST_MS);
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
  }
}

function changed(): void {
  progressDirty = false;
  publish();
  void persist();
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

const STATE_VERSION = 1;

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, target);
}

let persisting: Promise<void> = Promise.resolve();

/** Write the whole state. Serialized: two writes must not interleave a rename. */
export function persist(): Promise<void> {
  if (!config) return Promise.resolve();
  const body = JSON.stringify({
    version: STATE_VERSION,
    running,
    jobs,
    savedAt: new Date().toISOString(),
  }, null, 2);
  persisting = persisting
    .then(() => atomicWrite(stateFile(), body))
    .catch((err) => { console.error('[QUEUE-ENGINE] could not write the queue state:', err); });
  return persisting;
}

// ────────────────────────────────────────────────────────────────────────────
// Composition
// ────────────────────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function buildStep(
  spec: StepSpec | AppendStepSpec,
  parentStepId: string,
  held: boolean,
): QueueStep {
  const mod = moduleFor(spec.type);
  if (parentStepId === SOURCE_PARENT && !spec.sourceRef) {
    throw new Error(
      `The ${spec.label} step reads no earlier step, so it needs a source to read — `
      + 'and none was given.',
    );
  }
  return {
    id: newId('step'),
    type: spec.type,
    label: spec.label,
    config: spec.config,
    parentStepId,
    sourceRef: spec.sourceRef,
    resource: spec.resource ?? mod.resource(spec.config),
    status: held ? 'held' : (parentStepId === SOURCE_PARENT ? 'queued' : 'waiting'),
    progress: {},
    metrics: {},
    addedAt: new Date().toISOString(),
  };
}

/** Refuse a chain whose steps cannot read each other, at COMPOSE time. */
function checkLineage(child: QueueStep, parent: QueueStep | null): void {
  const mod = moduleFor(child.type);
  if (mod.consumes === null) return;
  if (!parent) {
    const kind = child.sourceRef?.kind;
    if (kind !== mod.consumes) {
      throw new Error(
        `${child.label} reads a ${mod.consumes}, and it was pointed at `
        + `${kind ? `a ${kind}` : 'nothing'}.`,
      );
    }
    return;
  }
  const parentMod = moduleFor(parent.type);
  if (parentMod.produces !== mod.consumes) {
    throw new Error(
      `${child.label} reads a ${mod.consumes}, and ${parent.label} writes `
      + `${parentMod.produces === 'none' ? 'nothing another step can read' : `a ${parentMod.produces}`}.`,
    );
  }
}

/** Put a whole run in the queue. Held unless the caller says otherwise. */
/**
 * Options for a caller that cannot be re-entered.
 *
 * `deferPump` — mint the row, notify, and decide what runs on a LATER turn.
 *
 * ── The one caller that needs it, and why it is not the default ─────────────
 *
 * `enqueue` ends with `changed(); pump();`, inline, same tick. `pump()` calls
 * `void launch(...)`, and `launch` runs synchronously as far as
 * `await mod.run(ctx)` — which itself runs synchronously as far as the module's
 * first await. So a step can begin EXECUTING inside the enqueue that created it.
 *
 * For every caller in this app that is exactly right: the press wants the work
 * started, and the stack it started on is this one.
 *
 * It is wrong for the Foundry host queue (electron/foundry-host-queue.ts). There,
 * enqueue is called BY Foundry, from inside its own IPC handler, and the step
 * this engine would pick runs by calling back INTO Foundry (`runJob`). Pumping
 * inline re-enters Foundry from inside its own enqueue, before that call has even
 * returned the row it is waiting for. Foundry's agent refused the mirror of this
 * on their side — `exportEpubFromStep` enqueues, so a host act that called it
 * from inside our scheduler would have the scheduler awaiting itself — and this
 * is the same bug with the arrow reversed (agreed on the channel, 2026-08-18).
 *
 * DEFERRED, NOT SKIPPED. The pump still happens, on a clean stack, one turn
 * later; the row is still minted synchronously, which is the guarantee Foundry's
 * shelf actually needs ("pressing Add cannot leave a moment where nothing has
 * appeared").
 */
export interface EnqueueOptions {
  deferPump?: boolean;
}

export function enqueue(spec: JobSpec, opts?: EnqueueOptions): QueueJob {
  if (!spec.steps || spec.steps.length === 0) {
    throw new Error('A queued run with no steps would do nothing, so it is not queued.');
  }
  /*
   * A RUN ADDED TO A QUEUE THAT IS ALREADY RUNNING JOINS THE RUN.
   *
   * Owen, 2026-08-23, having queued Wool behind For the Soul of the People:
   * "it finished TTSing and cleared the GPU slot, and assembly entered the CPU
   * slot. I expected wool to take the GPU slot." It did not, and the scheduler
   * was not why — the slot rule had already done its half (assembly took a CPU
   * slot 1 ms after the narration settled, `queue-steps/reassembly.ts`). Wool
   * was simply never RUNNABLE: every enqueue landed `held`, and held steps are
   * never claimed, so the trilogy sat on the shelf behind a press.
   *
   * `held` had one rule — "released only if the caller said so" — and it was
   * answering a question nobody asked twice. Composing a run must not commit the
   * GPU, which is true while the engine is idle: that is what Start is FOR, and
   * a queue that ran the moment you added to it would take the card out from
   * under a person still deciding. But once Start has been pressed the person
   * HAS decided, and every later addition is that same decision restated. Making
   * them press Start again per book is asking a question already answered.
   *
   * So the rule is three-way, and only the middle one is new:
   *   release === true   → runnable, whatever the engine is doing (the host
   *                        queue's door, and main's foundry-narrate door: work
   *                        ordered through a seam was scheduled by the asking)
   *   release === false  → held, explicitly. STAGING SURVIVES: this is how you
   *                        park a plan beside a live queue, and the keeper's
   *                        "Planned book" is exactly that case
   *   release undefined  → held while the engine is idle, runnable while it runs
   *
   * Not touched, deliberately: `held` is ALSO the resting state of an interrupted
   * step ("Press Start to pick it up from where it got to", the load path). That
   * meaning belongs to a step that already ran and is nobody's business here —
   * this decides the status of a step being born, and a brand-new step has no
   * interrupted past to resume.
   */
  const held = spec.release === undefined ? !running : spec.release !== true;
  const job: QueueJob = {
    id: newId('job'),
    projectId: spec.projectId,
    // Verbatim, and only when there is one: the field's absence is what tells
    // the node pusher this run belongs on no tree.
    ...(spec.foundry === undefined ? {} : { foundry: spec.foundry }),
    title: spec.title,
    documentPath: spec.documentPath,
    documentLabel: spec.documentLabel,
    steps: [],
    createdAt: new Date().toISOString(),
  };

  spec.steps.forEach((stepSpec, index) => {
    const parentIndex = stepSpec.parentIndex;
    if (parentIndex !== undefined) {
      if (parentIndex < 0 || parentIndex >= index) {
        throw new Error(
          `The ${stepSpec.label} step names step ${parentIndex} as its parent, which is not `
          + 'an earlier step of this run.',
        );
      }
    }
    const parent = parentIndex === undefined ? null : job.steps[parentIndex];
    const step = buildStep(stepSpec, parent ? parent.id : SOURCE_PARENT, held);
    checkLineage(step, parent);
    job.steps.push(step);
  });

  jobs.push(job);
  changed();
  if (opts?.deferPump === true) setImmediate(() => pump());
  else pump();
  return job;
}

/**
 * Hang a step off a job that already exists — INCLUDING off a step that has not
 * run yet.
 *
 * This is the act the old queue could not express. A user who has narrated a book
 * and now wants it assembled chains Assemble onto the narration; if the narration
 * is still queued, the assemble step is `waiting` and the engine resolves its
 * input from the narration's OUTPUT when that lands. The old queue had to be
 * handed the session paths at enqueue time, before the session existed, which is
 * why the reassembly row carried an empty `sessionId` and re-discovered it with a
 * four-attempt retry ladder at run time.
 */
export function appendStep(jobId: string, spec: AppendStepSpec): QueueStep {
  const job = requireJob(jobId);
  const parentStepId = spec.parentStepId;
  let parent: QueueStep | null = null;
  if (parentStepId !== SOURCE_PARENT) {
    parent = job.steps.find((s) => s.id === parentStepId) ?? null;
    if (!parent) {
      throw new Error(
        `This run has no step "${parentStepId}", so nothing here can be the one the new `
        + 'step reads.',
      );
    }
    if (parent.status === 'failed' || parent.status === 'cancelled') {
      throw new Error(
        `${parent.label} ${parent.status === 'failed' ? 'failed' : 'was cancelled'}, so it will `
        + 'never write the thing this step would read.',
      );
    }
  }
  // A step appended to a run the user already released is released too: they
  // pressed Start for this run, and holding the new step would leave it sitting
  // behind a queue that is already moving.
  const jobIsHeld = jobStatus(job) === 'held';
  const step = buildStep(spec, parentStepId, jobIsHeld);
  checkLineage(step, parent);
  if (parent && parent.status === 'done') step.status = jobIsHeld ? 'held' : 'queued';
  job.steps.push(step);
  if (job.finishedAt) job.finishedAt = undefined;
  changed();
  pump();
  return step;
}

function requireJob(jobId: string): QueueJob {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`There is no run "${jobId}" in the queue.`);
  return job;
}

function findStep(stepId: string): { job: QueueJob; step: QueueStep } | null {
  for (const job of jobs) {
    const step = job.steps.find((s) => s.id === stepId);
    if (step) return { job, step };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Control
// ────────────────────────────────────────────────────────────────────────────

/**
 * Release what is HELD and start claiming work.
 *
 * Releases everything held AT THIS MOMENT and nothing else — a run added after
 * the press is held again, because Start means "run what is here" and a button
 * that silently also armed the future would make the next enqueue a surprise.
 */
export function start(target?: { jobId?: string; stepId?: string }): void {
  release(target);
  running = true;
  changed();
  pump();
}

/** Held → queued, for one step, one job, or everything. */
export function release(target?: { jobId?: string; stepId?: string }): void {
  const affected: QueueStep[] = [];
  for (const job of jobs) {
    if (target?.jobId && job.id !== target.jobId) continue;
    for (const step of job.steps) {
      if (target?.stepId && step.id !== target.stepId) continue;
      if (step.status !== 'held') continue;
      affected.push(step);
    }
  }
  for (const step of affected) {
    step.status = parentOf(step)?.status === 'done' || step.parentStepId === SOURCE_PARENT
      ? 'queued'
      : 'waiting';
  }
  if (affected.length > 0) changed();
}

/**
 * Stop claiming work. Does NOT stop what is already running — you stop those one
 * at a time and deliberately, because each of them is minutes of GPU that
 * restarting would spend again.
 */
export function pause(): void {
  running = false;
  changed();
}

export function isRunning(): boolean {
  return running;
}

/**
 * Stop a step, or every live step of a job.
 *
 * A step whose module says its stop is RESUMABLE lands `held` with
 * `wasInterrupted` — it is exactly a step that is present, will not be
 * auto-picked, and needs an explicit gesture. That is what makes a stopped
 * narration resumable: nothing revives `cancelled`, and marking a stop as a
 * failure is what once left a stopped job unresumable forever.
 */
export async function cancel(
  target: { jobId?: string; stepId?: string },
  reason = 'Stopped by the user.',
): Promise<void> {
  const targets: Array<{ job: QueueJob; step: QueueStep }> = [];
  if (target.stepId) {
    const found = findStep(target.stepId);
    if (!found) throw new Error(`There is no step "${target.stepId}" in the queue.`);
    targets.push(found);
  } else if (target.jobId) {
    const job = requireJob(target.jobId);
    for (const step of job.steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) targets.push({ job, step });
    }
  } else {
    throw new Error('Cancelling needs to be told what to cancel.');
  }

  for (const { job, step } of targets) {
    if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
    if (step.status === 'running') {
      const live = runningSteps.get(step.id);
      if (live) {
        live.stopRequested = true;
        try {
          await moduleFor(step.type).cancel(step.id, step);
        } catch (err) {
          console.error(`[QUEUE-ENGINE] ${step.label} did not stop cleanly:`, err);
        }
        live.abort.abort();
      }
      // The finish path (settleStep) writes the terminal state when run() returns.
      continue;
    }
    // Not started: it is cancelled here and now, and so is everything under it.
    settleNotStarted(job, step, reason);
  }
  // A user stop idles the queue: you stop a GPU job to get the card back, and
  // auto-starting the next one would defeat the purpose.
  running = false;
  changed();
}

function settleNotStarted(job: QueueJob, step: QueueStep, reason: string): void {
  step.status = 'cancelled';
  step.error = reason;
  step.finishedAt = new Date().toISOString();
  cascadeCancel(job, step.id, `Skipped: ${step.label} was cancelled.`);
}

/** Every step downstream of `stepId` that has not run is cancelled, with a reason. */
function cascadeCancel(job: QueueJob, stepId: string, reason: string): void {
  let changedAny = true;
  const cancelledIds = new Set<string>([stepId]);
  while (changedAny) {
    changedAny = false;
    for (const step of job.steps) {
      if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
      if (!cancelledIds.has(step.parentStepId)) continue;
      step.status = 'cancelled';
      step.error = reason;
      step.finishedAt = new Date().toISOString();
      cancelledIds.add(step.id);
      changedAny = true;
    }
  }
}

/** Take a run out of the queue. Anything of it that is running is stopped first. */
export async function remove(jobId: string): Promise<void> {
  const job = requireJob(jobId);
  for (const step of job.steps) {
    if (step.status !== 'running') continue;
    const live = runningSteps.get(step.id);
    if (!live) continue;
    live.stopRequested = true;
    try {
      await moduleFor(step.type).cancel(step.id, step);
    } catch (err) {
      console.error(`[QUEUE-ENGINE] ${step.label} did not stop cleanly on removal:`, err);
    }
    live.abort.abort();
    runningSteps.delete(step.id);
  }
  jobs = jobs.filter((j) => j.id !== jobId);
  changed();
  pump();
}

/** Move a run before another one. Position is the queue's only ordering. */
/**
 * SAY THAT THIS STEP'S WORK WAS STOPPED RATHER THAN BROKEN — for a runner whose
 * work can be stopped somewhere this engine's `cancel()` does not reach.
 *
 * ── The one case, and why the flag cannot be inferred ───────────────────────
 *
 * `settleStep` tells a cancellation from a failure by `stopRequested`, which
 * `cancel()` is the only writer of. That is complete for everything this engine
 * starts and stops itself.
 *
 * It is not complete for a step whose work runs in ANOTHER process that has its
 * own stop. A Foundry job can be stopped inside Foundry; the row comes back
 * saying `cancelled`, nothing here requested it, and without this the module's
 * only way to report it is to throw — which files a deliberate stop as a FAILURE.
 * That is wrong twice over: it puts an error message on a row where nobody did
 * anything wrong, and a failed step is what `retry()` resets, so the scheduler
 * would be free to start work the user had just stopped.
 *
 * Setting the flag instead lands the step where a stop belongs — HELD and
 * interrupted for a resumable module, `cancelled` otherwise — which is the same
 * place our own Stop button puts it.
 *
 * IGNORED FOR A STEP THAT IS NOT RUNNING. There is nothing to annotate on a row
 * that has already settled, and a late report is a message in flight rather than
 * a state to resurrect — `recordStageProgress` refuses on the same reasoning.
 */
export function noteStepStopped(stepId: string): void {
  const live = runningSteps.get(stepId);
  if (live) live.stopRequested = true;
}

export function reorder(jobId: string, beforeJobId: string | null): void {
  const from = jobs.findIndex((j) => j.id === jobId);
  if (from < 0) throw new Error(`There is no run "${jobId}" in the queue.`);
  const [job] = jobs.splice(from, 1);
  if (beforeJobId === null) {
    jobs.push(job);
  } else {
    const to = jobs.findIndex((j) => j.id === beforeJobId);
    if (to < 0) {
      jobs.splice(from, 0, job);
      throw new Error(`There is no run "${beforeJobId}" to put this one in front of.`);
    }
    jobs.splice(to, 0, job);
  }
  changed();
}

/**
 * Change a step's settings BEFORE it runs.
 *
 * Refused once it has started, and refused loudly: a config swapped under a
 * running bridge would be a setting the user believes is in force and a process
 * that never saw it.
 */
export function updateStepConfig(stepId: string, patch: Record<string, unknown>): void {
  const found = findStep(stepId);
  if (!found) throw new Error(`There is no step "${stepId}" in the queue.`);
  if (!TERMINAL_STEP_STATUSES.has(found.step.status) && found.step.status !== 'running') {
    found.step.config = { ...found.step.config, ...patch };
    changed();
    return;
  }
  throw new Error(
    `${found.step.label} has already ${found.step.status === 'running' ? 'started' : 'finished'}, `
    + 'so changing its settings would change nothing about what it did.',
  );
}

/** Drop the runs that are over. */
export function clearFinished(): void {
  const before = jobs.length;
  jobs = jobs.filter((job) => {
    const status = jobStatus(job);
    return status !== 'done' && status !== 'failed' && status !== 'cancelled';
  });
  if (jobs.length !== before) changed();
}

/**
 * Put a terminal step back in the queue.
 *
 * A retried step is HELD, not queued: re-running is a decision, and a failure the
 * user has not looked at yet must not restart itself because the queue happened
 * to be running.
 */
export function retry(target: { jobId?: string; stepId?: string }): void {
  const reset = (step: QueueStep): void => {
    step.status = 'held';
    step.error = undefined;
    step.progress = {};
    step.metrics = {};
    step.output = undefined;
    step.outputPath = undefined;
    step.completionNotes = undefined;
    step.startedAt = undefined;
    step.finishedAt = undefined;
  };
  if (target.stepId) {
    const found = findStep(target.stepId);
    if (!found) throw new Error(`There is no step "${target.stepId}" in the queue.`);
    reset(found.step);
    // Everything downstream of it has to run again too: it read what this step
    // wrote, and this step is about to write it differently.
    for (const step of found.job.steps) {
      if (step.parentStepId === found.step.id) reset(step);
    }
    found.job.finishedAt = undefined;
  } else if (target.jobId) {
    const job = requireJob(target.jobId);
    // Steps that already SUCCEEDED are left alone — re-narrating a book because
    // its assembly failed is an hour of GPU nobody asked for.
    for (const step of job.steps) {
      if (step.status === 'done') continue;
      reset(step);
    }
    job.finishedAt = undefined;
  } else {
    throw new Error('Retrying needs to be told what to retry.');
  }
  changed();
}

// ────────────────────────────────────────────────────────────────────────────
// GPU thermal telemetry
// ────────────────────────────────────────────────────────────────────────────
//
// The SAMPLING lives in main (electron/gpu-thermal-sampler.ts) — this engine
// imports nothing that can run a process, which is what keeps it keeper-
// testable. What lives here is the RECORD: the latest reading for the snapshot,
// and a per-step accumulator so a finished run's analytics can say what the
// card went through — which is how "the Himmler run was slow" stops being a
// mystery and becomes "the card spent 40 minutes throttled".

let gpuThermal: GpuThermalReading | null = null;

interface ThermalAccumulator {
  samples: number;
  maxTempC: number;
  sumTempC: number;
  throttledSeconds: number;
  /** When the previous sample landed, for crediting throttled wall-time. */
  lastAt: number;
}

const thermalByStep = new Map<string, ThermalAccumulator>();

/**
 * Record a reading, or `null` for "nothing is sampling any more".
 *
 * Accumulates onto every RUNNING GPU step (the pool has one slot, so in
 * practice one). Throttled time is credited as the gap since the previous
 * sample when the CURRENT sample reports a throttle — wall-clock between
 * samples is what the card actually spent, and counting fixed intervals would
 * overcharge the first sample and undercharge a cadence change.
 */
export function recordGpuThermal(reading: GpuThermalReading | null): void {
  if (reading === null) {
    if (gpuThermal === null) return;
    gpuThermal = null;
    changed();
    return;
  }
  gpuThermal = reading;
  const now = new Date(reading.at).getTime();
  for (const live of runningSteps.values()) {
    if (live.resource !== 'gpu') continue;
    const acc = thermalByStep.get(live.stepId);
    if (acc === undefined) {
      thermalByStep.set(live.stepId, {
        samples: 1,
        maxTempC: reading.tempC,
        sumTempC: reading.tempC,
        throttledSeconds: 0,
        lastAt: now,
      });
      continue;
    }
    acc.samples += 1;
    acc.maxTempC = Math.max(acc.maxTempC, reading.tempC);
    acc.sumTempC += reading.tempC;
    if (reading.throttleActive && now > acc.lastAt) {
      acc.throttledSeconds += (now - acc.lastAt) / 1000;
    }
    acc.lastAt = now;
  }
  changed();
}

/** Whether anything is on the card — the sampler asks before spending a process. */
export function hasRunningGpuStep(): boolean {
  for (const live of runningSteps.values()) {
    if (live.resource === 'gpu') return true;
  }
  return false;
}

/** The finished step's thermal story, for its analytics. Consumes the accumulator. */
function takeThermalSummary(stepId: string): GpuThermalSummary | null {
  const acc = thermalByStep.get(stepId);
  thermalByStep.delete(stepId);
  if (acc === undefined || acc.samples === 0) return null;
  return {
    samples: acc.samples,
    maxTempC: acc.maxTempC,
    avgTempC: Math.round((acc.sumTempC / acc.samples) * 10) / 10,
    throttledSeconds: Math.round(acc.throttledSeconds),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GPU admission
// ────────────────────────────────────────────────────────────────────────────

/**
 * The external-GPU-job lock, read exactly as parallel-tts-bridge reads it.
 *
 * Any process outside this app may create `%APPDATA%\BookForge\external-gpu-job.lock`
 * (content = free-text description) to say it is using the card. The sweeps
 * already honour it; now the SCHEDULER does too — it holds, politely, and says
 * what it is holding for.
 */
export function externalGpuJobLock(): string | null {
  if (os.platform() !== 'win32') return null;
  const appData = process.env['APPDATA'];
  if (!appData) return null;
  const p = path.join(appData, 'BookForge', 'external-gpu-job.lock');
  if (!fsSync.existsSync(p)) return null;
  try {
    return fsSync.readFileSync(p, 'utf-8').trim() || '(empty lock file)';
  } catch {
    return '(unreadable lock file)';
  }
}

/**
 * Who else holds the GPU. Injected rather than imported so the engine keeps its
 * one property — no Electron, no bridges — and the keeper suite can drive it.
 * main wires it to `gpu-arbiter.gpuHolder`.
 */
let gpuHolderProbe: () => string | null = () => null;
export function setGpuHolderProbe(probe: () => string | null): void {
  gpuHolderProbe = probe;
}

/** For the keeper suite: override the lock reader. */
let gpuLockProbe: () => string | null = externalGpuJobLock;
export function setGpuLockProbe(probe: () => string | null): void {
  gpuLockProbe = probe;
}

function gpuAdmission(): { ok: true } | { ok: false; reason: string } {
  const lock = gpuLockProbe();
  if (lock) {
    return {
      ok: false,
      reason: `Waiting for the GPU: another job outside BookForge is using it — ${lock}. `
        + 'This run starts as soon as that lock is gone.',
    };
  }
  const holder = gpuHolderProbe();
  if (holder) {
    return {
      ok: false,
      reason: `Waiting for the GPU: ${holder} is using it. This run starts as soon as it lets go.`,
    };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────
// The scheduler
// ────────────────────────────────────────────────────────────────────────────

function parentOf(step: QueueStep): QueueStep | null {
  if (step.parentStepId === SOURCE_PARENT) return null;
  for (const job of jobs) {
    const parent = job.steps.find((s) => s.id === step.parentStepId);
    if (parent) return parent;
  }
  return null;
}

/**
 * Retire a recorded GPU hold. A no-op when there is none, so it is safe to call
 * on every pass of the pump; it touches progress only when something changed,
 * because a snapshot pushed on every tick is a snapshot nobody can diff.
 */
function clearAdmissionHold(step: QueueStep): void {
  if (step.progress.admissionHold === undefined) return;
  const { admissionHold: _retired, ...rest } = step.progress;
  step.progress = rest;
  touchProgress();
}

function slotsInUse(resource: StepResource): number {
  let n = 0;
  for (const live of runningSteps.values()) if (live.resource === resource) n += 1;
  return n;
}

/**
 * Claim what can be claimed, in queue order, filling every free slot.
 *
 * Idempotent and cheap: it is called after every state change, and a pass that
 * can start nothing does nothing.
 */
/**
 * Listeners run when the pump has FINISHED DECIDING what to launch.
 *
 * ── Why a hook here and not on `onQueueChanged` ─────────────────────────────
 *
 * Because "nothing of yours is running" is only true after the scheduler has had
 * its turn. `changed()` fires the instant a step settles — BEFORE the pump has
 * looked at what is queued behind it — so a listener reading state there sees a
 * transient trough between one step ending and the next starting.
 *
 * That trough is not cosmetic for the Foundry seam. Foundry tears its vLLM
 * reading server down on our idle signal, and its default `keepServerWarmMinutes`
 * is 0 — an immediate `stopServer`, no timer. Two reads batched (the ordinary way
 * anybody works through a shelf) would have gone: A settles, changed() fires,
 * nothing is running yet because B is still queued, we say idle, the server
 * stops, the pump then launches B, and B pays a full model reload. N reads, N
 * model starts, minutes each. Foundry's agent caught it in review of the first
 * cut and it was their own rule that produced it (channel, 2026-08-19).
 *
 * Asked after the decision, the same predicate is right in every case: the pump
 * launched a Foundry step (no idle), launched something else while one waits
 * (idle — free the VRAM, pay one reload later), or launched nothing (idle).
 */
const afterPumpListeners = new Set<() => void>();

export function onAfterPump(listener: () => void): () => void {
  afterPumpListeners.add(listener);
  return () => { afterPumpListeners.delete(listener); };
}

export function pump(): void {
  if (!running) return;
  let admissionBlocked = false;

  // A `waiting` step whose parent has landed becomes runnable. Done here rather
  // than at completion so there is ONE place that decides what is runnable.
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.status !== 'waiting') continue;
      const parent = parentOf(step);
      if (parent && parent.status === 'done') step.status = 'queued';
    }
  }

  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.status !== 'queued') continue;
      const parent = parentOf(step);
      if (parent && parent.status !== 'done') { step.status = 'waiting'; continue; }
      if (slotsInUse(step.resource) >= RESOURCE_SLOTS[step.resource]) {
        // The pool being full IS this row's reason, and it outranks whatever
        // admission last said — a hold recorded before our own work took the
        // card would otherwise sit on the row naming an external lock that may
        // be long gone. Admission is not even asked below in this case, so this
        // is the only place that stale answer can be retired.
        clearAdmissionHold(step);
        continue;
      }
      if (step.resource === 'gpu') {
        const admission = gpuAdmission();
        if (!admission.ok) {
          // Said on the row, not swallowed. A queue that appears to be doing
          // nothing is indistinguishable from a broken one.
          //
          // Written to BOTH fields: `message` because every existing readout
          // shows it, and `admissionHold` because a surface has to be able to
          // ask "is this row being held off the card?" without guessing at
          // prose. See StepProgress.admissionHold.
          admissionBlocked = true;
          if (step.progress.admissionHold !== admission.reason) {
            step.progress = {
              ...step.progress,
              message: admission.reason,
              admissionHold: admission.reason,
            };
            touchProgress();
          }
          continue;
        }
        // Admission passed and a slot is free, so this step launches on the next
        // line and `launch` blanks its progress wholesale. Nothing to clear.
      }
      void launch(job, step);
    }
  }

  // The lock file's deletion is invisible to this engine — see the constant.
  if (admissionBlocked) {
    if (!admissionRecheckTimer) {
      admissionRecheckTimer = setTimeout(() => {
        admissionRecheckTimer = null;
        pump();
      }, admissionRecheckMs);
      if (typeof admissionRecheckTimer.unref === 'function') admissionRecheckTimer.unref();
    }
  } else if (admissionRecheckTimer) {
    clearTimeout(admissionRecheckTimer);
    admissionRecheckTimer = null;
  }

  /*
   * The decision is made; anyone who needs to read "what is running now" may.
   * Each listener is isolated — one watcher's throw is not another's, and none of
   * them may unwind the scheduler. That last clause is not hypothetical: an
   * unguarded push inside Foundry's own pump was exactly this bug on their side
   * (foundry c999195), where a throw would leave a row marked running with
   * nothing running.
   */
  for (const listener of [...afterPumpListeners]) {
    try {
      listener();
    } catch (err) {
      console.error(`[queue] an after-pump listener threw: ${(err as Error).message}`);
    }
  }
}

/**
 * A step whose parent is not done cannot run; a step whose parent FAILED will
 * never run. Both are said out loud rather than left pending in a queue that
 * quietly steps over them.
 */
function resolveInput(step: QueueStep): ArtifactRef {
  if (step.parentStepId === SOURCE_PARENT) {
    if (!step.sourceRef) {
      throw new Error(`${step.label} reads nothing, so there is nothing to run it against.`);
    }
    return step.sourceRef;
  }
  const parent = parentOf(step);
  if (!parent) {
    throw new Error(
      `${step.label} reads a step that is no longer in this run, so its input cannot be found.`,
    );
  }
  if (parent.status !== 'done') {
    throw new Error(`${step.label} reads ${parent.label}, which has not finished.`);
  }
  if (!parent.output) {
    throw new Error(
      `${parent.label} finished without saying what it wrote, so ${step.label} has nothing `
      + 'to read.',
    );
  }
  return parent.output;
}

async function launch(job: QueueJob, step: QueueStep): Promise<void> {
  const mod = moduleFor(step.type);
  const abort = new AbortController();
  runningSteps.set(step.id, {
    jobId: job.id,
    stepId: step.id,
    type: step.type,
    abort,
    resource: step.resource,
    stopRequested: false,
  });

  step.status = 'running';
  step.startedAt = new Date().toISOString();
  step.finishedAt = undefined;
  step.error = undefined;
  // Everything the PREVIOUS run measured goes. A resume reuses the row, and a
  // rate anchor kept across the gap times this session's chunks against a window
  // that opened before the previous session ended — 1.3 chunks/min reported
  // against ~25 actual (thirdreich, 2026-08-16).
  step.metrics = {
    resumeCompletedSentences: step.metrics.resumeCompletedSentences,
    resumeMissingSentences: step.metrics.resumeMissingSentences,
  };
  step.progress = { percent: 0 };
  if (!job.startedAt) job.startedAt = new Date().toISOString();
  changed();

  let input: ArtifactRef;
  try {
    input = resolveInput(step);
  } catch (err) {
    settleStep(job, step, { ok: false, error: (err as Error).message });
    return;
  }

  const ctx: StepRunContext = {
    jobId: job.id,
    stepId: step.id,
    step,
    job,
    input,
    signal: abort.signal,
    report: (update) => applyReport(step, update),
  };

  try {
    const output = await mod.run(ctx);
    settleStep(job, step, { ok: true, output });
  } catch (err) {
    settleStep(job, step, { ok: false, error: (err as Error)?.message || String(err) });
  }
}

type StepOutcome =
  | { ok: true; output: ArtifactRef }
  | { ok: false; error: string };

function settleStep(job: QueueJob, step: QueueStep, outcome: StepOutcome): void {
  const live = runningSteps.get(step.id);
  const stopped = live?.stopRequested === true;
  runningSteps.delete(step.id);
  step.finishedAt = new Date().toISOString();

  // What the card went through, onto the run's analytics — however it ended.
  // A run that was stopped BECAUSE the machine was cooking is exactly the one
  // whose thermal story matters. Analytics flow verbatim to the project ledger,
  // so this is how a slow week becomes attributable after the fact.
  const thermal = takeThermalSummary(step.id);
  if (thermal !== null && step.resource === 'gpu') {
    const analytics = (step.analytics ?? {}) as Record<string, unknown>;
    analytics['gpuThermal'] = thermal;
    step.analytics = analytics;
  }

  if (outcome.ok) {
    step.status = 'done';
    step.output = outcome.output;
    step.outputPath = outcome.output.path;
    step.progress = { ...step.progress, percent: 100 };
    step.error = undefined;
    step.wasInterrupted = false;
  } else if (stopped && moduleFor(step.type).stopIsResumable === true) {
    // Resumable: present, not auto-picked, needs an explicit gesture. This is what
    // makes a stopped narration resumable — nothing revives `cancelled`.
    step.status = 'held';
    step.wasInterrupted = true;
    step.error = undefined;
  } else if (stopped) {
    step.status = 'cancelled';
    step.error = outcome.error || 'Stopped by the user.';
    cascadeCancel(job, step.id, `Skipped: ${step.label} was stopped.`);
  } else {
    step.status = 'failed';
    step.error = outcome.error || `${step.label} failed and gave no reason.`;
    // Downstream steps read what this one would have written. They are CANCELLED
    // with the reason, not left pending — a workflow that silently sits forever
    // is the failure mode this replaces.
    cascadeCancel(job, step.id, `Skipped: ${step.label} failed. Fix it and run the job again.`);
  }

  const status = jobStatus(job);
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    job.finishedAt = new Date().toISOString();
  }
  // Announced BEFORE the queue advances: the next step may read what this one
  // wrote, and filing it has to have happened by then.
  announceFinished({
    jobId: job.id,
    stepId: step.id,
    type: step.type,
    label: step.label,
    projectId: job.projectId,
    success: step.status === 'done',
    status: step.status,
    outputPath: step.output?.path,
    error: step.error,
    analytics: step.analytics,
    completionNotes: step.completionNotes,
  });
  changed();
  pump();
}

/** Merge one report onto a step, applying the rate-anchor rule in ONE place. */
function applyReport(step: QueueStep, update: StepReport): void {
  const progress: StepProgress = { ...step.progress };
  if (update.percent !== undefined) progress.percent = Math.min(100, Math.max(0, update.percent));
  if (update.message !== undefined) progress.message = update.message;
  // Nullish-kept: a one-off event carries no breakdown, and erasing the bars on
  // those would flicker them away mid-run.
  // `in`, not `!== undefined`: null is an ANSWER here (nothing to say), and the
  // guard that could not tell it from "no opinion" is why a stage detail could
  // be set and never cleared. Same shape as activeBatch below.
  if ('detail' in update) progress.detail = update.detail ?? undefined;
  if (update.stages !== undefined) progress.stages = update.stages;
  // Replaced, including to nothing: a landed batch must not leave a full bar.
  if ('activeBatch' in update) progress.activeBatch = update.activeBatch ?? undefined;
  if (update.foundryPhase !== undefined) progress.foundryPhase = update.foundryPhase;
  step.progress = progress;

  if (update.metrics) {
    const metrics: StepMetrics = { ...step.metrics };
    for (const [key, value] of Object.entries(update.metrics)) {
      if (value === undefined) continue;
      (metrics as Record<string, unknown>)[key] = value;
    }
    const sessionDone = update.metrics.chunksDoneInSession
      ?? update.metrics.chunksCompletedInJob;
    if (sessionDone !== undefined) {
      const anchor = firstChunkAnchor(step, metrics, sessionDone);
      metrics.firstChunkCompletedAt = anchor.firstChunkCompletedAt;
      metrics.chunksAtFirstStamp = anchor.chunksAtFirstStamp;
      if (sessionDone > (step.metrics.chunksDoneInSession ?? -1)) {
        metrics.chunkCompletedAt = Date.now();
      }
    }
    step.metrics = metrics;
  }
  touchProgress();
}

/**
 * The anchor every rate measurement is taken from: the time of the FIRST observed
 * session progress AND the chunk count at that instant. Set once per RUN.
 *
 * Both halves are required. Measuring from startedAt would fold in model load and
 * planning; measuring from the stamp WITHOUT its count assumes progress arrives
 * one chunk at a time, which is false — Orpheus emits only when a whole batch of
 * 64 finishes, so the first observation is routinely already 128 chunks deep, and
 * crediting all of them to the window that opened at that instant overstates the
 * rate ~6x.
 *
 * Consequence: no rate exists until the SECOND flush lands. That is correct — one
 * observation cannot time anything.
 */
function firstChunkAnchor(
  step: QueueStep,
  metrics: StepMetrics,
  sessionDone: number,
): { firstChunkCompletedAt?: number; chunksAtFirstStamp?: number } {
  const stamped = metrics.firstChunkCompletedAt;
  if (stamped !== undefined) {
    // An anchor marks a chunk completing, and a chunk cannot complete before the
    // run that rendered it started — so a stamp older than startedAt is a
    // PREVIOUS run's, and re-stamping is the only honest reading.
    const startedAt = step.startedAt ? new Date(step.startedAt).getTime() : null;
    if (startedAt === null || stamped >= startedAt) {
      return { firstChunkCompletedAt: stamped, chunksAtFirstStamp: metrics.chunksAtFirstStamp };
    }
  }
  if (sessionDone <= 0) return {};
  return { firstChunkCompletedAt: Date.now(), chunksAtFirstStamp: sessionDone };
}

// ────────────────────────────────────────────────────────────────────────────
// Startup: load, migrate, revive
// ────────────────────────────────────────────────────────────────────────────

export interface ConfigureOptions extends EngineConfig {
  /** Where the GPU holder is read from. main passes gpu-arbiter's `gpuHolder`. */
  gpuHolder?: () => string | null;
  /** How often a pump refused on admission re-checks. Tests shorten it. */
  admissionRecheckMs?: number;
}

/**
 * Point the engine at a state directory and load what is there.
 *
 * Also performs the ONE-TIME migration of the retired renderer blob. The old file
 * is kept as `queue.json.bak` rather than deleted: it is the only record of what a
 * user had queued when they upgraded, and a migration that loses a nine-hour
 * narration's resume flag is worse than one that leaves a file behind.
 */
export async function configure(options: ConfigureOptions): Promise<void> {
  config = { stateDir: options.stateDir, legacyQueueFile: options.legacyQueueFile };
  if (options.gpuHolder) gpuHolderProbe = options.gpuHolder;
  if (options.admissionRecheckMs !== undefined) admissionRecheckMs = options.admissionRecheckMs;
  jobs = [];
  running = false;
  runningSteps.clear();

  const loaded = await loadState();
  if (!loaded) {
    const migrated = await migrateLegacyQueue();
    jobs = migrated;
  }
  reviveInterrupted();
  changed();
}

async function loadState(): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`The queue state at ${stateFile()} could not be read: ${(err as Error).message}`);
  }
  let parsed: { version?: number; jobs?: QueueJob[] };
  try {
    parsed = JSON.parse(raw) as { version?: number; jobs?: QueueJob[] };
  } catch (err) {
    // The file existed and could not be understood. It is PRESERVED under a name
    // that says so, because the next mutation would otherwise write over it.
    const corrupt = `${stateFile()}.corrupt-${Date.now()}`;
    await fs.rename(stateFile(), corrupt).catch(() => { /* naming it is best-effort */ });
    console.error(
      `[QUEUE-ENGINE] the saved queue could not be parsed and was preserved at ${corrupt}:`,
      (err as Error).message,
    );
    return false;
  }
  jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  // Deliberately NOT restoring `running`. Coming back up claiming the GPU because
  // the app was killed while busy is the app deciding for the user.
  running = false;
  return true;
}

/**
 * A step that was running when the process ended.
 *
 * Its child processes died with the app, so there is nothing to re-attach to —
 * that is the shape of the problem now that the queue lives in the process that
 * OWNS those children. What survives is what is on disk, so the step is HELD and
 * marked interrupted: present, not auto-picked, and resumable by Start.
 */
function reviveInterrupted(): void {
  for (const job of jobs) {
    for (const step of job.steps) {
      /*
       * THE MODULE IS THE AUTHORITY ON WHAT A STEP NEEDS, so a step that has
       * not run yet is re-asked on every load.
       *
       * `resource` is persisted with the step, which was right while it could
       * only have come from the module — but a build that changes its mind
       * must be able to say so about work already in the queue. It changed its
       * mind for real: assembly declared `gpu` wholesale until plain ffmpeg
       * assemblies moved to the CPU pool, and without this the rows composed
       * before that change would keep holding the card for work that never
       * touches it, which is the exact behaviour the change removed.
       *
       * Terminal steps keep what they ran with: that is history, not a plan.
       */
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        const mod = modules.get(step.type);
        if (mod) step.resource = mod.resource(step.config ?? {});
      }
      const retired = RETIRED_JOB_TYPES.get(step.type);
      if (retired && step.status !== 'done') {
        step.status = 'failed';
        step.error = retired;
        continue;
      }
      if (!modules.has(step.type) && step.status !== 'done') {
        step.status = 'failed';
        step.error = `Nothing in this build knows how to run a "${step.type}" step. Remove this row.`;
        continue;
      }
      if (step.status === 'running') {
        step.status = 'held';
        step.wasInterrupted = true;
        step.progress = {
          ...step.progress,
          message: 'Interrupted when BookForge closed. Press Start to pick it up from where it got to.',
        };
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Migration of the retired renderer blob
// ────────────────────────────────────────────────────────────────────────────

interface LegacyJob {
  id: string;
  type: string;
  status: string;
  epubPath?: string;
  epubFilename?: string;
  progress?: number;
  error?: string;
  outputPath?: string;
  addedAt?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: { title?: string; [k: string]: unknown };
  config?: Record<string, unknown>;
  bfpPath?: string;
  projectDir?: string;
  parentJobId?: string;
  workflowId?: string;
  wasInterrupted?: boolean;
  isResumeJob?: boolean;
  resumeCompletedSentences?: number;
  resumeMissingSentences?: number;
}

/**
 * Read the retired `queue.json` and make runs out of it.
 *
 * The old model was a flat list where a workflow was expressed as a master row of
 * type 'audiobook' plus children carrying `parentJobId`/`workflowId`, ordered by
 * array position. That maps exactly onto a job with a chain of steps, and the
 * ordering rule ("no earlier sibling may be incomplete") becomes the lineage.
 *
 * Nothing is dropped:
 *  - a `processing` row was interrupted, so it comes back HELD and interrupted —
 *    resumable, and requiring the user to say so.
 *  - a retired type becomes a FAILED step carrying the recorded sentence, so the
 *    user reads what replaced it instead of finding a row that never runs.
 *  - a type this build does not know becomes a failed step saying that.
 */
export async function migrateLegacyQueue(): Promise<QueueJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(legacyFile(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error('[QUEUE-ENGINE] the old queue file could not be read:', (err as Error).message);
    return [];
  }

  let state: { jobs?: LegacyJob[] };
  try {
    state = JSON.parse(raw) as { jobs?: LegacyJob[] };
  } catch (err) {
    console.error('[QUEUE-ENGINE] the old queue file could not be parsed:', (err as Error).message);
    return [];
  }

  const legacy = Array.isArray(state.jobs) ? state.jobs : [];
  const migrated = buildJobsFromLegacy(legacy);

  // Kept, not deleted. It is the only record of what was queued at upgrade time.
  await fs.rename(legacyFile(), `${legacyFile()}.bak`).catch((err) => {
    console.error('[QUEUE-ENGINE] the old queue file could not be renamed to .bak:', err);
  });

  console.log(`[QUEUE-ENGINE] migrated ${legacy.length} old row(s) into ${migrated.length} run(s).`);
  return migrated;
}

/** The pure half of the migration, so the keeper suite can drive it directly. */
export function buildJobsFromLegacy(legacy: LegacyJob[]): QueueJob[] {
  const out: QueueJob[] = [];
  const byMaster = new Map<string, LegacyJob[]>();
  const standalone: LegacyJob[] = [];
  const masters = new Map<string, LegacyJob>();

  for (const row of legacy) {
    if (row.type === 'audiobook' && !row.parentJobId) {
      masters.set(row.id, row);
      if (!byMaster.has(row.id)) byMaster.set(row.id, []);
    }
  }
  for (const row of legacy) {
    if (masters.has(row.id)) continue;
    if (row.parentJobId && masters.has(row.parentJobId)) {
      byMaster.get(row.parentJobId)!.push(row);
    } else {
      standalone.push(row);
    }
  }

  for (const [masterId, children] of byMaster) {
    const master = masters.get(masterId)!;
    if (children.length === 0) {
      // A container with nothing under it ran nothing and can run nothing. It is
      // not carried forward as an empty run — jobStatus would have no steps to
      // read — and saying so in the log is the whole of what it deserves.
      console.warn(`[QUEUE-ENGINE] old master row ${masterId} had no steps; not migrated.`);
      continue;
    }
    out.push(makeJob(master, children));
  }
  for (const row of standalone) {
    out.push(makeJob(row, [row]));
  }
  return out;
}

function makeJob(header: LegacyJob, rows: LegacyJob[]): QueueJob {
  const job: QueueJob = {
    id: newId('job'),
    projectId: header.bfpPath ?? header.projectDir,
    title: header.metadata?.title ?? header.epubFilename ?? 'Migrated run',
    documentPath: header.epubPath,
    documentLabel: header.epubFilename,
    steps: [],
    createdAt: header.addedAt ?? new Date().toISOString(),
    startedAt: header.startedAt,
  };
  let previousId = SOURCE_PARENT;
  for (const row of rows) {
    const step = migrateStep(row, previousId, job);
    job.steps.push(step);
    previousId = step.id;
  }
  return job;
}

function migrateStep(row: LegacyJob, parentStepId: string, job: QueueJob): QueueStep {
  const retired = RETIRED_JOB_TYPES.get(row.type);
  const known = modules.has(row.type as JobType);
  const resource: StepResource = known
    ? modules.get(row.type as JobType)!.resource(row.config ?? {})
    : 'cpu';

  const step: QueueStep = {
    id: newId('step'),
    type: row.type as JobType,
    label: row.metadata?.title ?? row.type,
    config: row.config ?? {},
    parentStepId,
    sourceRef: parentStepId === SOURCE_PARENT
      ? { kind: 'epub', path: row.epubPath ?? job.documentPath }
      : undefined,
    resource,
    status: 'held',
    progress: {},
    metrics: {
      resumeCompletedSentences: row.resumeCompletedSentences,
      resumeMissingSentences: row.resumeMissingSentences,
    },
    addedAt: row.addedAt ?? new Date().toISOString(),
    startedAt: row.startedAt,
    finishedAt: row.completedAt,
    outputPath: row.outputPath,
  };

  if (retired) {
    step.status = 'failed';
    step.error = retired;
    return step;
  }
  if (!known) {
    step.status = 'failed';
    step.error = `Nothing in this build knows how to run a "${row.type}" step. Remove this row.`;
    return step;
  }

  switch (row.status) {
    case 'complete':
      step.status = 'done';
      step.progress = { percent: 100 };
      step.output = { kind: modules.get(row.type as JobType)!.produces, path: row.outputPath };
      break;
    case 'error':
      step.status = 'failed';
      step.error = row.error ?? 'This run failed before the queue was rebuilt, and gave no reason.';
      break;
    case 'processing':
      // Interrupted: the process that was running it is gone.
      step.status = 'held';
      step.wasInterrupted = true;
      step.progress = {
        message: 'Interrupted when BookForge closed. Press Start to pick it up from where it got to.',
      };
      break;
    case 'stopped':
      step.status = 'held';
      step.wasInterrupted = true;
      break;
    default:
      step.status = 'held';
      step.wasInterrupted = row.wasInterrupted === true ? true : undefined;
      break;
  }
  return step;
}

// ────────────────────────────────────────────────────────────────────────────
// Shutdown
// ────────────────────────────────────────────────────────────────────────────

/** Stop claiming, and write what is on the board. Called on app quit. */
export async function shutdown(): Promise<void> {
  running = false;
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  await persist();
}

/** Read-only view of what is running right now — for the bookshelf server. */
export function runningStepIds(): string[] {
  return [...runningSteps.keys()];
}
