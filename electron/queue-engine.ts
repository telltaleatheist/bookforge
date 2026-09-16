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
 *    model, a clipforge chain). Same treatment.
 *
 * It CHECKS the arbiter rather than acquiring it, because the bridges acquire it
 * themselves (parallel-tts-bridge and llama-bridge both call `acquireGpu`). An
 * engine that took the lock first would hand the bridge a
 * deadlock against its own scheduler.
 */
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  jobStatus,
  RETIRED_JOB_TYPES,
  SOURCE_PARENT,
  STAGED_JOB_TYPES,
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
  type PrepSubProgress,
} from '../shared/queue/engine-types';
/*
 * THE PER-ROW ROUTING VOCABULARY AND ITS ONE DECISION, kept pure and shared so
 * the renderer's picker and this scheduler cannot drift on what `any` means or
 * on what a hold says. See that file's header for the whole model.
 */
import {
  decideWaitFor,
  holdBusy,
  WAIT_FOR_ANY,
  type ServerState,
  type WaitForServer,
} from '../shared/queue/wait-for';
/*
 * ONE SLOT SET PER MACHINE — the capacity model, pure and shared so the bench
 * and this scheduler count the same slots. crucible `docs/PHASE7-LANES.md`
 * §2.4; see that file's header for why the counts are of BOOKFORGE's own work
 * and never of a server's capacity.
 */
import {
  cloudLaneOf,
  isCloudLane,
  longformAlignCharged,
  LONGFORM_ALIGN_SET,
  slotSetForStep,
  slotSetOccupancy,
  slotSets,
  slotsOf,
  thisMachinesCardHeldBy,
  LOCAL_WORK_SET,
  WAIT_STEP_CAP,
  type EngineRole,
  type EngineUpstreams,
  type SetOccupancy,
  type SlotSet,
} from '../shared/queue/slot-sets';
import { crucibleRoleOf, crucibleRouteOf, crucibleUpstreamsOf, onCrucibleRecordChanged } from './crucible/routes';
import { JOB_GERUND } from '../shared/queue/job-words';
/*
 * THE ONE RULE FOR "WHICH PROJECT IS THIS ROW ABOUT", borrowed from the step
 * modules rather than restated here. It is a pure function over a config and an
 * artifact (no Electron, no window), which is why the engine can import it from
 * `queue-steps/runtime` without the cycle that module's other exports would
 * imply — everything it imports is `import type`.
 */
import { projectDirForStep } from './queue-steps/runtime';

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
  /** Counted work inside the preparing stage. REPLACED, not kept — see above. */
  prep?: PrepSubProgress | null;
  /**
   * Which pass a Foundry row's counts are counting. Set on every count, because
   * a run can change pass mid-flight (the endpoint route rasterises the whole
   * book before it reads it) and a stale phase would label pages as blocks.
   */
  foundryPhase?: 'render' | 'read' | 'translate' | 'clean' | 'rank' | 'verify';
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
   * The artifact kind this step reads — or a LIST of the kinds it legitimately
   * takes, or null when it reads whatever it is pointed at and validating the
   * kind would be a lie (a pass reads the project's book, which the project owns
   * rather than the previous step).
   *
   * A list is not the same statement as null. Null switches the check off; a
   * list keeps it and widens it, which is what the two enhancement passes need —
   * each reads a narration's session when it goes first and the other pass's
   * sentences when it goes second, and nothing else.
   */
  readonly consumes: ArtifactKind | readonly ArtifactKind[] | null;
  readonly produces: ArtifactKind;
  /**
   * Which pool this step contends for, given its config. A function because the
   * answer depends on the config: a translate pass against Claude is network
   * latency and belongs in the cpu pool; the same pass against Ollama is the GPU.
   */
  resource(config: Record<string, unknown>): StepResource;
  /**
   * WHICH MACHINES THIS STEP CAN RUN ON (crucible `docs/PHASE7-LANES.md` §4).
   *
   * Absent means `local`, and defaulting to `local` is the whole safety
   * property: **a step that has not been taught to travel does not travel.** A
   * module that spawns a python env here keeps behaving exactly as it does now,
   * and registering a Crucible server can never silently break a render. The
   * alternative default would hand a locally-spawning step a remote machine,
   * and it would either fail on a path that does not exist or — far worse — run
   * locally while occupying a remote slot.
   *
   * A function of the config for `resource`'s reason: the same step can be a
   * different thing depending on what it was asked to do.
   */
  machines?(config: Record<string, unknown>): 'local' | 'any';
  /**
   * DOES THIS STEP'S WORK REACH A CRUCIBLE AS A RUN OF CHAT COMPLETIONS against
   * one resident model?
   *
   * Read by the scheduler for exactly ONE decision: when the step in front of
   * this one finishes, may the run's Crucible lease be KEPT OPEN for it, or must
   * it be given back? A row that cleans and then simplifies holds one lease
   * across both; a row that cleans and then assembles gives the card back the
   * moment the cleaning is done, because an hour of ffmpeg has no business
   * holding somebody's model (`electron/crucible/lease.ts`, ONE LEASE PER ROW).
   *
   * Default FALSE, and that is the safe direction: an undeclared step ends the
   * run of acts, which is exactly today's behaviour — a lease per act. Declaring
   * it wrongly true would hold a card across work that does not use it.
   *
   * Asked of the CONFIG because a step's provider is a config field: the same
   * translation row leases against `crucible` and leases nothing against Claude.
   *
   * **NOT SUFFICIENT ON ITS OWN** — see {@link StepModule.leasedModel}.
   */
  leasesModel?(config: Record<string, unknown>): boolean;
  /**
   * WHICH resident thing this step's act will lease, by id — or null.
   *
   * ── Why `leasesModel` alone was wrong (Foundry, 2026-09-14) ───────────────
   *
   * A Crucible lease is taken on a MODEL (`POST /v1/models/{id}/lease`) and a
   * server holds exactly ONE. The first version of this seam kept the row's
   * lease open whenever the NEXT step declared `leasesModel`, whatever model
   * that step needed. But the acts of one row do not share a model: a cleanup
   * runs on the 9B and a simplify or a translation on the 27B. So the
   * archetypal row — clean, then simplify — carried the 9B's lease into a step
   * whose job is to put the 27B on that card, and the load is refused `leased`
   * naming `bookforge`, which is this app. The row parks on a claim it made
   * against itself until the ttl lapses.
   *
   * It is exactly the case the seam was built for, and the keeper proved it
   * "worked" because the fake server did not check model identity.
   *
   * ── The rule ─────────────────────────────────────────────────────────────
   *
   * The lease survives into the next step only when that step's own id for its
   * own act EQUALS the open lease's subject. Otherwise it is given back at
   * settle, exactly as it was before one lease per row existed — and the next
   * step takes its own.
   *
   * ── Null is an answer, not a gap ─────────────────────────────────────────
   *
   * "This act leases nothing this side can name": a provider with no card, an
   * act with no model chosen yet, a module that has not been taught. Null
   * never equals an open lease's subject, so it releases — the safe direction,
   * and the one that is true of a step nobody has declared for.
   *
   * MUST NOT THROW and must not reach the network: it is called synchronously
   * inside `settleStep`, in front of a step that has not started. A module
   * whose record is unreadable answers null and lets the ACT raise the refusal
   * where an operator can act on it.
   */
  leasedModel?(config: Record<string, unknown>): string | null;
  /**
   * WHICH CRUCIBLE CAPABILITY CLASS THIS STEP IS, or `null` when it is none.
   *
   * crucible `docs/PHASE15-HOST.md` §5.3: an engine can be configured to
   * forward one of the four llm classes — `clean translate simplify analysis`
   * — to Anthropic, OpenAI or a remote Ollama on the operator's account. A run
   * that goes that way holds no card anywhere, so it takes the engine's
   * `[cloud]` lane instead of its GPU slot (`shared/queue/slot-sets.ts`).
   *
   * To ask "is this row's class routed upstream on the machine it was just
   * placed on" the pump needs the CLASS, and only the step module knows it: a
   * `translation` step is `translate`, a `pass` step is its kind's act, a
   * render is none of them. Declared here rather than derived from the step
   * TYPE in the engine, which would be a fifth private copy of an
   * act-to-step mapping (crucible ARCHITECTURE.md R1) and would be wrong the
   * first time a pass kind moved.
   *
   * `null` — the default, by absence — means "not a routable class", and every
   * such step keeps the venue's GPU slot exactly as before. MUST NOT THROW and
   * must not reach the network: it is called synchronously inside the pump.
   */
  crucibleClass?(config: Record<string, unknown>): string | null;
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
   * `true` — runnable whatever the engine is doing, for work whose ordering was
   * ITSELF the scheduling decision. NO DOOR IN THE APP PASSES IT TODAY: the
   * Foundry host queue did until 2026-09-11, and dropped it because passing it
   * was how a clean-text press started itself on an idle queue (see the ruling
   * in `enqueue` below, and in `foundryHostQueue.enqueue`); main's narration
   * door has only ever used the ordinary one. It stays because the case is
   * real — a caller that can honestly say the press WAS the scheduling — and
   * because `false` is meaningless without it.
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
  /**
   * Set when the server refused this submit `409 server_busy`. The step's own
   * failure is then read as a WAIT: it settles back to `queued` carrying this
   * line, not `failed`. See {@link noteStepBusy}.
   */
  busyLine?: string;
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

/**
 * EVERY SLOT SET THAT EXISTS RIGHT NOW, composed from the routing record and
 * what is running.
 *
 * Asked on every snapshot rather than cached, so a server enabled a second ago
 * has its lane before the next pump. The routing read behind `host.routing()`
 * is itself cached (`electron/queue-ipc.ts`), so this is a map over three rows.
 */
function currentSlotSets(): SlotSet[] {
  const occupied: string[] = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.status !== 'running') continue;
      const id = slotSetForStep(job, step);
      if (id !== null && !occupied.includes(id)) occupied.push(id);
    }
  }

  let enabledServers: string[] = [];
  /*
   * AND THE ONES SWITCHED OFF, which the bench now DRAWS instead of dropping
   * (Owen, 2026-09-15: greyed until re-checked). Split out of the SAME `ranked`
   * array as the line above rather than read again, so the two can never
   * disagree about a server — `slotSets` refuses a name that reaches it in both.
   */
  let disabledServers: string[] = [];
  /*
   * Which of them answer on THIS box. Read from the same `host.routing()` call
   * as the ranked list so the two cannot come from different moments, and left
   * EMPTY when that record is unreadable — the catch below draws the sets that
   * need no record, and a set that cannot prove it is here simply shows no
   * temperature. The other way round would put this PC's fan speed on the Mac's
   * row, which is a number somebody would act on.
   */
  let serversHere: readonly string[] = [];
  const host = crucibleHost;
  if (host !== null) {
    try {
      const record = host.routing();
      enabledServers = record.ranked.filter((row) => row.enabled).map((row) => row.name);
      disabledServers = record.ranked.filter((row) => !row.enabled).map((row) => row.name);
      serversHere = record.serversOnThisMachine;
    } catch {
      /*
       * A CORRUPT ROUTING RECORD IS REFUSED AT ADMISSION, in `routing.ts`'s own
       * words, and every travelling row carries them (`crucibleAdmission`). The
       * bench still has to draw, so it draws the sets that need no record —
       * whatever is running, the legacy spawn, and BookForge's own work. It
       * does not invent a server, and no claim can go to one it cannot name.
       */
    }
  }

  /*
   * ONE ENTRY PER ENABLED SERVER, always, because `slotSets` refuses a name it
   * was told nothing about. The record always answers — `unknown` for an engine
   * nobody has read yet — so this map is complete by construction, and a name
   * missing from it could only be a defect here rather than a machine that has
   * not spoken.
   *
   * Read straight from `crucible/routes.ts` rather than through the injected
   * host, for the same reason `crucibleRouteOf` is: it is a synchronous
   * in-memory record with no Electron, no registry and no HTTP in it, so it
   * costs this file none of the properties the injected seams exist to keep.
   */
  const upstreams: Record<string, EngineUpstreams> = {};
  for (const name of enabledServers) upstreams[name] = crucibleUpstreamsOf(name);

  /*
   * …AND WHICH OF THEM HAS A CARD AT ALL. A registered address can be an
   * ORCHESTRATOR (crucible PHASE17 §1) — zero job types, one engine managed,
   * capability read through to it — and a GPU row for one is a lane the
   * scheduler could claim into that nothing can serve. Owen, 2026-09-15:
   * *"crucible on windows is a passthrough orchestrator so it shouldnt show
   * up."* Same record, same reason it is read here and not through the host.
   */
  const roles: Record<string, EngineRole> = {};
  for (const name of enabledServers) roles[name] = crucibleRoleOf(name);

  /*
   * AND WHETHER THE LEGACY GPU ROW EXISTS AT ALL — read off the same jobs the
   * `occupied` pass above reads, with `slotSetForStep`, so the row is present
   * for exactly the steps this scheduler would send there. Owen, 2026-09-15:
   * *"without a crucible server, there is no gpu slot, because bookforge
   * shouldnt know how to drive gpu work in-app."*
   *
   * Computed here rather than inside `slotSets` because that module takes facts
   * and never a snapshot — which is what keeps it drivable by a keeper with no
   * engine — and computed with the shared function rather than by listing the
   * step kinds, so this and the bench cannot disagree about a row.
   */
  return slotSets({
    enabledServers,
    disabledServers,
    upstreams,
    roles,
    occupied,
    alignerCharged: longformAlignCharged({ jobs }),
    // Which registered servers answer on THIS box. The bench draws the
    // nvidia-smi thermal reading on their rows and on no others, and
    // `gpuHeldElsewhere` reads the same fact — so it is supplied once, here,
    // rather than re-derived by either.
    serversOnThisMachine: serversHere,
  });
}

/**
 * THE QUEUE'S GPU DIAL, for the snapshot.
 *
 * Asked on every snapshot rather than cached, for `currentSlotSets`'s reason: a
 * dial turned a second ago — in this window or another one — must be on the page
 * before the next pump.
 *
 * A build that wired no routing host, or a record that will not parse, answers
 * `any`. That is NOT a fallback hiding a bug: this value is DECORATION here (the
 * position the control draws), and the decision it belongs to is made in
 * `crucibleAdmission`, which refuses BY NAME in both cases and puts the record's
 * own repair sentence on every travelling row. Throwing here would take the
 * whole snapshot — and with it the bench, the plans and the history — down over
 * a knob.
 */
function currentGpuDial(): string {
  const host = crucibleHost;
  if (host === null) return WAIT_FOR_ANY;
  try {
    return host.dial();
  } catch {
    return WAIT_FOR_ANY;
  }
}

export function snapshot(): QueueSnapshot {
  // A deep-enough copy: the mirror must not be able to reach back into the truth.
  return {
    running,
    slotSets: currentSlotSets(),
    gpuDial: currentGpuDial(),
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

/**
 * THE BENCH IS COMPOSED FROM A RECORD THAT LEARNS, SO IT REPUBLISHES WHEN IT
 * DOES.
 *
 * ── The defect, measured 2026-09-15 ────────────────────────────────────────
 *
 * Owen's bench drew eight slots where four belong — `local` and `mac` each with
 * a phantom `— routed elsewhere` lane — while `GET /api/queue/snapshot` against
 * the SAME running process answered three sets and no lane. The renderer asks
 * for one snapshot as it boots and then only ever replaces it from this
 * publication (`QueueService`). Every other publication is a STRUCTURAL change
 * in the queue: a step landed, a run was added, Start was pressed. With an empty
 * queue there are none, ever.
 *
 * And the facts the bench is composed from are not the queue's. Whether an
 * engine has an upstream, and whether an address is an engine at all, are learnt
 * a second or two after the window opens — coordination and the start-up reads —
 * and every one of them is `unknown` until then, which deliberately DRAWS the
 * row and the lane. So the first snapshot is the conservative one by design, and
 * before this nothing ever replaced it.
 *
 * ── Why this and not an earlier read ───────────────────────────────────────
 *
 * Moving the reads before the window would only narrow the window: one of them
 * is a file, but the rest are HTTP to a WSL guest and a Mac, and a machine that
 * is asleep answers when it answers. `unknown → draw it` stays the rule (it is
 * what stops a running upstream-routed row being stranded by a hidden lane); the
 * fix is that the moment it stops being unknown is a moment the bench hears
 * about. Nothing polls: the record announces, and it announces only when an
 * ANSWER changes.
 *
 * A pump is deliberately NOT started from here. A row held at admission because
 * a route was `unknown` is already re-tried by `admissionRecheckTimer`, which
 * exists for exactly the refusals nothing else re-triggers; starting work from a
 * record listener would give this module a second door into the scheduler.
 */
let unsubscribeCrucibleRecord: (() => void) | null = null;

function watchCrucibleRecord(): void {
  if (unsubscribeCrucibleRecord !== null) unsubscribeCrucibleRecord();
  unsubscribeCrucibleRecord = onCrucibleRecordChanged(() => { publish(); });
}

/**
 * PUSH THE SNAPSHOT WITHOUT CHANGING THE QUEUE — for a fact the queue carries
 * but does not own.
 *
 * The GPU dial is the one such fact today: it lives in its own record
 * (`electron/crucible/gpu-dial.ts`), it rides on the snapshot so the page can
 * draw the control, and turning it alters nothing in `jobs[]`. `changed()` would
 * be wrong — it PERSISTS, and writing `queue-engine.json` because somebody moved
 * a knob that is not in it is a file write for nothing, on the same main thread
 * a render is reporting progress to.
 *
 * Same reason `watchCrucibleRecord` publishes rather than `changed()`s when the
 * capability record learns something.
 */
export function publishSnapshot(): void {
  publish();
}

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
    travels: mod.machines !== undefined && mod.machines(spec.config) === 'any',
    status: held ? 'held' : (parentStepId === SOURCE_PARENT ? 'queued' : 'waiting'),
    progress: {},
    metrics: {},
    addedAt: new Date().toISOString(),
  };
}

/**
 * What a step will read, as a list — one entry for the ordinary case, several
 * for a step that genuinely takes either of two artifacts.
 *
 * The two enhancement passes are the case that needed this: a denoise reads a
 * narration's SESSION when it runs first and another pass's SENTENCES when it
 * runs second, and so does a conversion, because the user picks which of the two
 * goes first (Owen's ruling, 2026-08-29). Saying only one of the kinds would
 * refuse half of the orders the dialog can express; saying `null` — the escape
 * `reassembly` uses — would switch the check off for a step that really does
 * have a rule about what it can read.
 */
function consumedKinds(mod: StepModule): readonly ArtifactKind[] | null {
  if (mod.consumes === null) return null;
  return typeof mod.consumes === 'string' ? [mod.consumes] : mod.consumes;
}

/** "a sentences", or "a sentences or an audio-session" — the wanted half of the
 *  refusal, phrased the same whether one kind is legitimate or several. */
function kindsPhrase(kinds: readonly ArtifactKind[]): string {
  return kinds.map((k) => `a ${k}`).join(' or ');
}

/** Refuse a chain whose steps cannot read each other, at COMPOSE time. */
function checkLineage(child: QueueStep, parent: QueueStep | null): void {
  const mod = moduleFor(child.type);
  const kinds = consumedKinds(mod);
  if (kinds === null) return;
  if (kinds.length === 0) {
    throw new Error(
      `${child.label} declares that it reads nothing at all, which no step may do: a step that `
      + 'takes no input cannot be scheduled behind anything. This is a bug in its step module.',
    );
  }
  if (!parent) {
    const kind = child.sourceRef?.kind;
    if (kind === undefined || !kinds.includes(kind)) {
      throw new Error(
        `${child.label} reads ${kindsPhrase(kinds)}, and it was pointed at `
        + `${kind ? `a ${kind}` : 'nothing'}.`,
      );
    }
    return;
  }
  const parentMod = moduleFor(parent.type);
  if (!kinds.includes(parentMod.produces)) {
    throw new Error(
      `${child.label} reads ${kindsPhrase(kinds)}, and ${parent.label} writes `
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

/**
 * Is the queue MOVING — is there live work here right now?
 *
 * Not `running`, which is a latch: Start sets it and only Pause clears it, so it
 * stays true over a queue that finished everything hours ago. Both halves are
 * needed. Paused with work still queued is not moving (the person took the card
 * back on purpose). Un-paused with nothing left to do is not moving either — it
 * is a queue that has simply stopped, and the next thing added to it deserves
 * the same Start press the first thing did.
 *
 * `waiting` counts: a step whose parent is still rendering is work in flight, and
 * a chain's last step must not read as an idle queue while its first one runs.
 * Nothing dead counts — done, failed, cancelled and held are all resting states.
 */
function queueIsMoving(): boolean {
  if (!running) return false;
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.status === 'running' || step.status === 'queued' || step.status === 'waiting') {
        return true;
      }
    }
  }
  return false;
}

export function enqueue(spec: JobSpec, opts?: EnqueueOptions): QueueJob {
  if (!spec.steps || spec.steps.length === 0) {
    throw new Error('A queued run with no steps would do nothing, so it is not queued.');
  }
  /*
   * A RUN ADDED TO A QUEUE THAT IS ALREADY MOVING JOINS THE RUN.
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
   * GPU, which is true while the queue is idle: that is what Start is FOR, and a
   * queue that ran the moment you added to it would take the card out from under
   * a person still deciding. But a queue that is MOVING has already been told to
   * go, and each addition restates that. Owen's words, and they are the rule:
   * "I shouldn't have to hit start if the queue is moving. If I add something to
   * the queue but it isn't already moving, don't start it until I hit start."
   *
   * MOVING, not merely un-paused. The distinction is the whole of this decision.
   * `running` is a latch: Start sets it, only Pause clears it, so a queue that
   * drained hours ago is still `running` with nothing in it. Keying off the latch
   * would spin the card up for a book added the next morning, which is the exact
   * surprise the held default exists to prevent. So the question asked is "is
   * there live work here" — anything running, or claimed and about to be.
   *
   * So the rule is three-way, and only the middle one is new:
   *   release === true   → runnable, whatever the engine is doing. No door
   *                        passes it now. The Foundry host queue's did, written
   *                        two days BEFORE this rule existed and never revisited
   *                        against it, which is how "add a cleaning job" started
   *                        one on an idle queue (Owen, 2026-09-11); it now passes
   *                        nothing and takes the answer below, which serves the
   *                        August case too because that queue was moving
   *   release === false  → held, explicitly. STAGING SURVIVES: this is how you
   *                        park a plan beside a live queue, and the keeper's
   *                        "Planned book" is exactly that case
   *   release undefined  → runnable if the queue is moving, held if it is not
   *
   * Not touched, deliberately: `held` is ALSO the resting state of an interrupted
   * step ("Press Start to pick it up from where it got to", the load path). That
   * meaning belongs to a step that already ran and is nobody's business here —
   * this decides the status of a step being born, and a brand-new step has no
   * interrupted past to resume.
   */
  const held = spec.release === undefined ? !queueIsMoving() : spec.release !== true;
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

  /*
   * WHICH SERVER THIS BOOK WAITS FOR, written HERE and written VISIBLY.
   *
   * §4.2.1a: the default is a setting, and the row displays what it will do.
   * Only a run that carries a step which can travel gets the field at all — a
   * pass, an assembly and a VLM read have no Crucible question to answer, and
   * a field on those would be a value nothing reads (the representable state
   * §4.2.3 spent two drafts removing).
   *
   * `null` from the host means there was nothing to name. The field stays
   * ABSENT and admission says so by name; it is not defaulted to `any`, which
   * would be a silent routing decision nobody made.
   */
  if (crucibleHost !== null && jobTravels(job)) {
    const wanted = crucibleHost.defaultWaitFor();
    if (wanted !== null) job.waitFor = wanted;
  }

  /*
   * ── ADDING A BOOK PUTS IT IN PENDING ────────────────────────────────────────
   *
   * Owen's ruling of 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md` §1): a
   * book is STAGED before it runs, and Pending is where its server is chosen
   * while nothing about it is committed. See {@link QueueJob.pending} for what
   * that costs and what enforces it.
   *
   * ── Which runs, and why not all of them ─────────────────────────────────────
   *
   * The ones that carry a {@link STAGED_JOB_TYPES} step — a book being
   * NARRATED. Its own note says why that is narrower than "every run that can
   * travel", and the short of it is that a Foundry-ordered text act travels as
   * well, and staging one would put a Send-to-queue gate in front of a button
   * pressed in another application's window. Pending is where tonight's render
   * waits while a person decides which card; it is not a second confirmation on
   * every pass.
   *
   * It is deliberately NOT the same predicate that gates `waitFor` two lines
   * above. Every staged run travels, so it always has a picker to draw, but the
   * converse does not hold and treating them as one fact is exactly the mistake
   * the keeper caught.
   *
   * ── `release: true` still means what it says ────────────────────────────────
   *
   * That flag is a caller stating THE PRESS WAS THE SCHEDULING DECISION (see
   * {@link JobSpec.release}); staging such a run would be this engine overruling
   * a caller that had already answered the question Pending is for. No door in
   * the app passes it today, so today every added book stages.
   *
   * The steps are `held` either way — `held` is computed above from the
   * three-way rule and a pending run is all-held by construction, because
   * `spec.release !== true` is exactly the condition that makes `held` true
   * whenever the queue is idle AND the condition that makes it true here.
   * A pending run composed while the queue was MOVING is the one case where the
   * two differ, and this settles it: the steps are forced held, because a staged
   * book that started itself would be Pending in name only.
   */
  if (jobIsStageable(job) && spec.release !== true) {
    job.pending = true;
    for (const step of job.steps) step.status = 'held';
  }

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
export function appendStep(jobId: string, spec: AppendStepSpec, opts?: EnqueueOptions): QueueStep {
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
  // A run that acquires its first travelling step acquires the question with
  // it. Same rule as `enqueue`, and never overwritten: a run that already has
  // an answer keeps it, because appending is not a re-routing.
  if (crucibleHost !== null && job.waitFor === undefined && step.travels === true) {
    const wanted = crucibleHost.defaultWaitFor();
    if (wanted !== null) job.waitFor = wanted;
  }
  if (job.finishedAt) job.finishedAt = undefined;
  changed();
  // Deferred on the same reasoning as `enqueue`'s: the Foundry host queue
  // appends a CHAINED row from inside Foundry's own enqueue, and an inline pump
  // could start some other queued row — re-entering Foundry through `runJob` —
  // before this call has returned the row Foundry is waiting for.
  if (opts?.deferPump === true) setImmediate(() => pump());
  else pump();
  return step;
}

/** Every step under `stepId` in this run, transitively, by `parentStepId`. */
function descendantsOf(job: QueueJob, stepId: string): QueueStep[] {
  const under = new Set<string>([stepId]);
  const out: QueueStep[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of job.steps) {
      if (under.has(step.id) || !under.has(step.parentStepId)) continue;
      under.add(step.id);
      out.push(step);
      grew = true;
    }
  }
  return out;
}

/**
 * Take ONE STEP out of the queue — AND EVERYTHING UNDER IT.
 *
 * Owen's ruling (2026-09-07), for the chains Foundry composes onto a row that
 * has not landed yet: "if that item is removed from the queue, anything under
 * it also disappears." A step under a removed one would wait forever on a
 * parent that no longer exists, and `parentOf` answering null for it would
 * let the pump claim it as if it had no parent at all — running a clean-up's
 * export on a book that was never cleaned. So the subtree goes with the step,
 * transitively, and anything of it that is running is stopped first, exactly
 * as `remove` stops a run's steps. A run left with no steps is removed too.
 *
 * `remove(jobId)` stays for the Queue page, where the unit is the whole run.
 */
export async function removeStep(stepId: string): Promise<void> {
  const found = findStep(stepId);
  if (!found) throw new Error(`There is no step "${stepId}" in the queue.`);
  const { job } = found;
  const going = [found.step, ...descendantsOf(job, stepId)];
  for (const step of going) {
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
  const gone = new Set(going.map((s) => s.id));
  job.steps = job.steps.filter((s) => !gone.has(s.id));
  if (job.steps.length === 0) jobs = jobs.filter((j) => j.id !== job.id);
  changed();
  pump();
}

/** Is every step under `stepId` (transitively) already settled? */
export function subtreeSettled(stepId: string): boolean {
  const found = findStep(stepId);
  if (!found) throw new Error(`There is no step "${stepId}" in the queue.`);
  return descendantsOf(found.job, stepId).every((s) => TERMINAL_STEP_STATUSES.has(s.status));
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

/**
 * Held → queued, for one step, one job, or everything.
 *
 * ── A STAGED RUN IS NOT RELEASED, and which way it refuses depends on the ask ─
 *
 * A pending run's steps are `held` — that is what "nothing is committed" is made
 * of — so without this they would be swept up by the whole-queue Start and land
 * `queued` inside a run `pump` skips by name. The row would sit released,
 * unclaimed, with nothing able to say why.
 *
 *  - UNTARGETED (the toolbar's Start): pending runs are simply not "what is
 *    here". Start means *run what is in the queue*, and a staged book is not in
 *    it yet; sweeping it in would make Send to queue a button that can be
 *    bypassed by accident.
 *  - TARGETED (Start pressed on one book or one step): REFUSED BY NAME. Silently
 *    doing nothing to a book somebody pressed Start on is the failure this whole
 *    page exists to remove.
 */
export function release(target?: { jobId?: string; stepId?: string }): void {
  if (target?.jobId !== undefined || target?.stepId !== undefined) {
    const owner = target.jobId !== undefined
      ? jobs.find((job) => job.id === target.jobId)
      : findStep(target.stepId as string)?.job;
    if (owner !== undefined && isPending(owner)) {
      throw new QueueRoutingRefusal(
        'still_pending',
        `${owner.title} is in Pending — it has not been sent to the queue, so there is nothing `
        + 'here to start. Choose its server and press Send to queue.',
      );
    }
  }
  const affected: QueueStep[] = [];
  for (const job of jobs) {
    if (isPending(job)) continue;
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

/**
 * WHAT ANOTHER STEP OF THE SAME RUN IS DOING RIGHT NOW — read live, never held.
 *
 * For a step that has a SIBLING to join on. The assembly is the case this exists
 * for: an align row is a leaf (nothing waits on it, so it and the assembly take
 * a CPU slot each), but the assembly's TAIL wants the measured sentence cues the
 * align writes, so it polls this until the align settles and seals whichever
 * transcript is there by then.
 *
 * Read through the engine rather than off `ctx.job`, because the caller holds
 * the job object it was handed when it launched and this always reads the one
 * the engine has now. Null means there is no such step in any run — it was
 * removed — which a waiter must treat as "stop waiting", never as "wait longer".
 */
export function peekStep(stepId: string): {
  status: StepStatus; label: string; percent: number | undefined;
  /** `held` + this = a person STOPPED the row; `held` alone = staged, not yet started. */
  wasInterrupted: boolean;
} | null {
  const found = findStep(stepId);
  if (!found) return null;
  return {
    status: found.step.status,
    label: found.step.label,
    percent: found.step.progress.percent,
    wasInterrupted: found.step.wasInterrupted === true,
  };
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

// ────────────────────────────────────────────────────────────────────────────
// The per-row routing doors
// ────────────────────────────────────────────────────────────────────────────

/**
 * EVERY WAY A ROUTING EDIT CAN BE REFUSED, each with a name.
 *
 * Owen's rule (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`, "Mutability"): *"The edit
 * and admission race, and the race must be settled by name. An edit that arrives
 * after admission is REFUSED (naming the row and the server it went to), never
 * silently applied to a running job and never silently dropped."*
 *
 * A bare `Error` would have carried the sentence and nothing a caller could
 * branch on, so a surface wanting to say "this one lost the race, the others
 * moved" would have had to read the prose. The CODE is what it reads; the
 * message is still the whole sentence, and it is never swallowed.
 */
export type QueueRoutingRefusalCode =
  /**
   * THE RACE, and the only outcome it may have. A GPU took the row — the venue
   * is written and the work is on a machine — so the answer is not a setting any
   * more. The message names the row and the server it went to.
   */
  | 'venue_fixed_at_admission'
  /** A name that is not one of this machine's Crucible servers. */
  | 'unknown_server'
  /** The run carries nothing that can run on a Crucible server. */
  | 'not_travelling'
  /** Send to queue was pressed on a run that is not in Pending. */
  | 'not_pending'
  /** Start was pressed on a run that IS in Pending. Send it to the queue first. */
  | 'still_pending';

export class QueueRoutingRefusal extends Error {
  readonly code: QueueRoutingRefusalCode;

  constructor(code: QueueRoutingRefusalCode, message: string) {
    super(message);
    this.name = 'QueueRoutingRefusal';
    this.code = code;
  }
}

/**
 * Point one book at a server, or at `any`.
 *
 * ── The boundary, and how the race is settled ───────────────────────────────
 *
 * Editable right up to the moment a GPU takes the row, and refused after. Owen,
 * 2026-09-15: *"all the way up to the moment it's taken by a gpu. the moment
 * it's taken, it's immutable. it's running and will have to be canceled and
 * re-added to resolve it."*
 *
 * `waitForResolved` IS that moment, and since this build it is written at the
 * instant the step LAUNCHES rather than when the pump decided which machine to
 * try — see the assignment in `pump`. A row parked waiting for a card it has
 * been pointed at is therefore still editable, which is what the ruling says and
 * what the old ordering quietly denied.
 *
 * THE RACE CANNOT INTERLEAVE. Both halves run on main's one thread: `pump` is
 * synchronous from the first `for` to the `void launch(...)` that writes the
 * venue, and this door reads `waitForResolved` synchronously in the same loop.
 * So either the edit is seen with the field absent — and it applies, and the
 * pump that follows reads the new answer — or the field is set and the edit is
 * REFUSED BY NAME. There is no third outcome and nothing is best-effort.
 *
 * Refused by name for a server this machine does not have, too, because
 * silently accepting it would produce a row that can only ever hold.
 */
export function setWaitFor(jobId: string, value: string): void {
  const job = requireJob(jobId);
  if (!jobTravels(job)) {
    throw new QueueRoutingRefusal(
      'not_travelling',
      `${job.title} has no step that can run on a Crucible server, so there is nothing for it to `
      + 'wait for. Only the narration step travels today.',
    );
  }
  if (job.waitForResolved !== undefined) {
    throw new QueueRoutingRefusal(
      'venue_fixed_at_admission',
      `${job.title} was taken by a GPU on ${job.waitForResolved} before this change arrived, and a `
      + 'book finishes on the machine it started on. Nothing here has been altered. Cancel it and '
      + 'queue it again to send it somewhere else.',
    );
  }
  if (value !== WAIT_FOR_ANY) {
    const host = crucibleHost;
    if (host === null) {
      throw new Error(
        'This build did not wire the queue\'s Crucible routing, so it cannot check that server '
        + 'name. That is a bug in BookForge.',
      );
    }
    const known = host.routing().ranked.map((row) => row.name);
    if (!known.includes(value)) {
      throw new QueueRoutingRefusal(
        'unknown_server',
        `"${value}" is not one of this machine's Crucible servers `
        + `(${known.length === 0 ? 'there are none' : known.join(', ')}).`,
      );
    }
  }
  job.waitFor = value;
  // The hold on its steps was about the OLD answer. Retiring it here rather
  // than leaving it for the next pump keeps the row from showing "waiting for
  // mac: disabled" one tick after the operator moved it off mac.
  //
  // AND SO IS THE VENUE A PARKED STEP WAS PENCILLED IN FOR. `pump` writes
  // `step.venue` as soon as it has decided which machine to TRY — which is what
  // lets the bench say "waiting for mac to become free" about a row behind a
  // full slot — and that pencilling is now, by construction, a decision that can
  // still be changed (see `assignRunVenue`: the run is not assigned until it
  // launches). A stale one left here would have the bench naming the machine the
  // operator has just moved the book OFF, for as long as it took the next pump
  // to overwrite it. Only steps that have not started: a running or finished
  // step's venue is history.
  for (const step of job.steps) {
    if (step.status !== 'queued' && step.status !== 'waiting' && step.status !== 'held') continue;
    clearAdmissionHold(step);
    step.venue = undefined;
  }
  changed();
  pump();
}

/**
 * IS THIS RUN STAGED RATHER THAN QUEUED — the one owner of the question, so the
 * scheduler, the release door and the bench cannot come to disagree about it.
 */
function isPending(job: QueueJob): boolean {
  return job.pending === true;
}

/**
 * SEND A PENDING RUN INTO THE LIVE QUEUE — the press Owen's §3 names.
 *
 * Two things happen and they are one act: the run stops being staged, and its
 * steps are released. Doing only the first would leave a book in the live queue
 * that nothing claims; only the second would leave released steps inside a run
 * `pump` skips by name, which is the invisible stall this flag exists to make
 * impossible.
 *
 * `running` is NOT set here, deliberately. Send to queue says *where this book
 * belongs*, not *start the card*: a queue that is paused stays paused and the
 * book waits in it, which is the same thing Start has always meant. A queue that
 * is already moving picks the book up on the pump below without another press.
 *
 * Refused by name for a run that is not pending, because the press would
 * otherwise appear to work on a book that is already running — and "it did
 * nothing" is indistinguishable from "it is broken".
 */
export function sendToQueue(jobId: string): void {
  const job = requireJob(jobId);
  if (!isPending(job)) {
    throw new QueueRoutingRefusal(
      'not_pending',
      `${job.title} is not in Pending — it is already in the live queue. Nothing here has been `
      + 'altered.',
    );
  }
  job.pending = undefined;
  release({ jobId });
  changed();
  pump();
}

/**
 * HOW MANY QUEUED BOOKS NAME EACH SERVER — the count §4.2.1a asks for.
 *
 * *"12 rows are waiting for this PC, which is now disabled."* Disabling a
 * server that queued rows name must SURFACE them: they are told, never moved,
 * because a named server is an instruction and re-routing twenty books onto
 * slower hardware without being asked is the failure the whole section exists
 * to prevent. Leaving the operator to discover it one row at a time is the
 * other failure, and this is half the answer to both — {@link bulkWaitFor} is
 * the other half.
 *
 * Counts LIVE runs only, and only those not yet assigned: a book already
 * running on a machine is not waiting for anything.
 */
export function waitForCounts(): { counts: Record<string, number>; unset: number } {
  const counts: Record<string, number> = {};
  let unset = 0;
  for (const job of jobs) {
    if (!jobTravels(job)) continue;
    if (job.waitForResolved !== undefined) continue;
    const status = jobStatus(job);
    if (TERMINAL_STEP_STATUSES.has(status)) continue;
    if (job.waitFor === undefined) { unset += 1; continue; }
    counts[job.waitFor] = (counts[job.waitFor] ?? 0) + 1;
  }
  return { counts, unset };
}

/**
 * Move every queued book that names one server onto another answer — the
 * one-click bulk change beside the count.
 *
 * `from` is a server name, or `null` for the books that say nothing at all
 * (the migration). Returns how many moved, so the caller can say it.
 */
export function bulkWaitFor(from: string | null, to: string): number {
  let moved = 0;
  for (const job of jobs) {
    if (!jobTravels(job) || job.waitForResolved !== undefined) continue;
    if (TERMINAL_STEP_STATUSES.has(jobStatus(job))) continue;
    if (from === null ? job.waitFor !== undefined : job.waitFor !== from) continue;
    setWaitFor(job.id, to);
    moved += 1;
  }
  return moved;
}

/**
 * THE MIGRATION, REPORTED ONCE, BY NAME — or null when there was nothing to
 * report.
 *
 * A queue file written before `waitFor` existed holds runs that CAN travel and
 * say nothing about where. That is not a crash and it is not a silent default:
 * the honest reading is that those rows carry no instruction, because nobody
 * was ever asked, so the field stays absent, admission holds them with
 * {@link holdNoAnswer}'s sentence, and this line names them once at load so the
 * operator does not have to find them one at a time.
 *
 * Set by `reviveInterrupted` on every load and read by main, which logs it.
 */
let migrationReport: string | null = null;
export function waitForMigrationReport(): string | null {
  return migrationReport;
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
 * The external-GPU-job lock — THE reader, shared with the sweeps.
 *
 * This used to be a second, byte-identical copy of the one in
 * `parallel-tts-bridge.ts`. Two copies of a safety interlock is one copy that can
 * be fixed while the other is not, and the stale one fails silently: a lock it
 * does not notice simply means the sweep proceeds. Re-exported rather than
 * inlined so the scheduler's callers keep their import.
 */
export { externalGpuJobLock } from '../shared/gpu/external-job-lock';
import { externalGpuJobLock } from '../shared/gpu/external-job-lock';

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

// ────────────────────────────────────────────────────────────────────────────
// Crucible admission: which server this book waits for
// ────────────────────────────────────────────────────────────────────────────
//
// The second half of GPU admission, and it applies ONLY to a step whose module
// says it can travel (`machines()`). Everything else is unchanged: the lock
// file and the arbiter, because those describe this machine's card.
//
// Injected rather than imported, for the property this whole file keeps: no
// Electron, no registry, no HTTP. `queue-ipc.ts` wires it to the real routing
// record and a real `ping`; the keeper drives every branch with a scripted
// record and a scripted prober.

/** What the scheduler needs to know about this machine's Crucible servers. */
export interface CrucibleRoutingHost {
  /**
   * Every server in rank order (disabled ones included), and which of those
   * ANSWER ON THIS MACHINE'S LOOPBACK.
   *
   * The second half is not a kind of server — since Owen's ruling of
   * 2026-09-15 there is only one kind, and this engine cannot tell them apart
   * by anything but the address. It is asked for rather than worked out here
   * because the registry is the thing with the addresses and this file has no
   * registry in it. It decides one thing: whether this machine's GPU lock and
   * arbiter have anything to say about a step, and whether the one-card rule
   * below applies. Work bound for the Mac must not wait on either.
   */
  routing(): { ranked: WaitForServer[]; serversOnThisMachine: readonly string[] };
  /**
   * What a NEW row's `waitFor` is written as — the top-ranked server's NAME, or
   * `any` (crucible `docs/PHASE7-LANES.md` §4.2.1a).
   *
   * `null` means THERE IS NOTHING TO NAME: no server is registered, or every
   * one is disabled, and the setting says `top-ranked`. The row is then queued
   * with no answer and admission says so by name — see `holdNoAnswer`. Writing
   * a name there would be the manufactured instruction §4.2.1a exists to
   * prevent, and writing `any` would be a silent default.
   */
  defaultWaitFor(): string | null;
  /**
   * THE QUEUE'S GPU DIAL — `any`, or one registered server's name.
   *
   * A live lever the operator turns while work is moving, read on every
   * admission pass rather than cached here, so a dial turned a second ago is in
   * force on the next pump. It DEFERS and never overrides: the whole precedence
   * table is on `GPU_DIAL_ANY` in `shared/queue/wait-for.ts`, and
   * `decideWaitFor` is the one thing that applies it.
   *
   * Injected like the rest of this host, for the property this file keeps: no
   * Electron, no registry, no file. `electron/crucible/gpu-dial.ts` is the
   * record; `queue-ipc.ts` binds the two.
   *
   * It never answers `null`. A dial nobody has turned is `any`, which is a real
   * setting and the one in which the dial changes nothing.
   */
  dial(): string;
  /** One unauthenticated reachability check. Never admission — the door decides. */
  reach(server: string): Promise<{ reachable: true } | { reachable: false; detail: string }>;
}

/**
 * ONE LEASE PER ROW — the two calls the scheduler makes, injected.
 *
 * INJECTED rather than imported for the property this whole file keeps: no
 * Electron, no registry, no HTTP. `electron/crucible/lease.ts` reaches the
 * server registry and `app.on('before-quit')`, so importing it here would make
 * the scheduler unloadable outside Electron — which the keeper suite, the CLI
 * and every headless run depend on. `queue-ipc.ts` wires the real one.
 *
 * NULL IS A REAL STATE and not a missing fact: a build that wired no lease seam
 * runs every step outside a row scope, which is exactly the behaviour before
 * this existed — a lease per act, released by the act that took it. Nothing is
 * masked, because nothing here was going to lease anyway.
 */
export interface CrucibleLeaseHost {
  /** Run one step inside its run's lease scope. */
  withRowScope<T>(row: string, fn: () => Promise<T>): Promise<T>;
  /** Give back the lease this run was holding, if any. Never throws. */
  closeRow(row: string): Promise<void>;
  /**
   * The id of the thing this run's lease is on, or null when it holds none.
   *
   * The scheduler compares it to the NEXT step's own id
   * ({@link StepModule.leasedModel}) and keeps the lease only when they are
   * the same — a lease is per model and a server holds one, so keeping it open
   * for an act that wants a different model is a refusal this app hands
   * itself. Synchronous and local: it reads the map `withRowScope` fills, and
   * never the network.
   */
  leaseSubject(row: string): string | null;
}

let crucibleLeaseHost: CrucibleLeaseHost | null = null;

/** main wires this once, in `startQueueEngine`. The keeper passes a fake. */
export function setCrucibleLeaseHost(host: CrucibleLeaseHost | null): void {
  crucibleLeaseHost = host;
}

let crucibleHost: CrucibleRoutingHost | null = null;

/** main wires this once, in `startQueueEngine`. The keeper passes a fake. */
export function setCrucibleRoutingHost(host: CrucibleRoutingHost | null): void {
  crucibleHost = host;
  reachCache.clear();
  busyHolds.clear();
}

interface ReachEntry {
  at: number;
  /** `null` while the probe is in flight — asked, not yet answered. */
  answer: { reachable: true } | { reachable: false; detail: string } | null;
}

/**
 * What each server last said, and when.
 *
 * A CACHE OF THIS CLIENT'S OWN OBSERVATIONS, never of the server's capacity: it
 * answers "did the address answer when we asked", which is the only thing a
 * poll can honestly answer (crucible `docs/PHASE7-LANES.md` §2.5). Whether
 * there is room is settled at the door by `POST /v1/jobs`, and a 409 arrives
 * through {@link noteStepBusy} rather than through anything here.
 *
 * It expires on the admission recheck cadence, so a server that came back up is
 * re-asked on the next tick rather than staying unreachable until a restart.
 */
const reachCache = new Map<string, ReachEntry>();

/** One server's 409, held for a cool-off so the queue does not hammer the door. */
interface BusyHold {
  line: string;
  until: number;
}
const busyHolds = new Map<string, BusyHold>();

function reachTtlMs(): number {
  return admissionRecheckMs;
}

function serverState(name: string): ServerState {
  const busy = busyHolds.get(name);
  if (busy !== undefined) {
    if (busy.until > Date.now()) return { kind: 'busy', line: busy.line };
    busyHolds.delete(name);
  }
  const entry = reachCache.get(name);
  if (entry === undefined) return { kind: 'unknown' };
  // In flight, or stale. Both are "nobody has a current answer", and the
  // difference matters only to `askReach`, which will not ask twice.
  if (entry.answer === null) return { kind: 'unknown' };
  if (Date.now() - entry.at > reachTtlMs()) return { kind: 'unknown' };
  return entry.answer.reachable
    ? { kind: 'ready' }
    : { kind: 'unreachable', detail: entry.answer.detail };
}

/** Ask one server whether it answers, once, and pump again when it says. */
function askReach(name: string): void {
  const host = crucibleHost;
  if (host === null) return;
  const entry = reachCache.get(name);
  if (entry !== undefined && entry.answer === null) return; // already in flight
  reachCache.set(name, { at: Date.now(), answer: null });
  void host.reach(name)
    .then((answer) => { reachCache.set(name, { at: Date.now(), answer }); })
    .catch((err) => {
      // A prober that THREW is not a reachable server, and it is not silence
      // either: the throw is the detail.
      reachCache.set(name, {
        at: Date.now(),
        answer: { reachable: false, detail: `${(err as Error)?.message || String(err)}.` },
      });
    })
    .finally(() => { pump(); });
}

/**
 * A 409 `server_busy` came back from a submit. THIS IS A WAIT, NOT A FAILURE.
 *
 * crucible `docs/ARCHITECTURE.md` §3 and PHASE7-LANES §6: it is the one answer
 * that is never the step's fault, it names the holder, and the client's own
 * queue holds the row and retries. So the step settles back to `queued` with
 * the holder's line on it (see `settleStep`), and the server is held off for
 * one admission tick so the queue does not hammer a door it has just been told
 * is shut.
 *
 * Keyed by SERVER, not by row: every book waiting on that machine is waiting on
 * the same job, and telling one of them while the others retry in a loop would
 * be the tight polling `busyLine` exists to avoid.
 *
 * A no-op for a step id the queue does not know — a CLI or headless render
 * passes its own id, and a message about a row that does not exist is a message
 * in flight, not a state to invent.
 */
export function noteStepBusy(stepId: string, busyLine: string): void {
  const found = findStep(stepId);
  if (!found) return;
  const server = found.job.waitForResolved ?? found.job.waitFor;
  if (server === undefined || server === WAIT_FOR_ANY) return;
  busyHolds.set(server, { line: busyLine, until: Date.now() + admissionRecheckMs });
  const live = runningSteps.get(stepId);
  if (live) live.busyLine = busyLine;
}

/** Does this run carry a step that can be sent to a Crucible server? */
function jobTravels(job: QueueJob): boolean {
  return job.steps.some((step) => step.travels === true);
}

/**
 * IS THIS RUN A BOOK BEING ADDED — the one question Pending turns on.
 *
 * Both halves are required and each is a different fact. {@link
 * STAGED_JOB_TYPES} says the act is a book's render rather than a pass ordered
 * from somewhere else; `travels` says the module can actually be sent to a
 * machine, so there is a server to choose in Pending at all. A render whose
 * module had not been taught to travel would have nothing to decide there, and
 * a Send-to-queue press over an empty picker is a press for nothing.
 */
function jobIsStageable(job: QueueJob): boolean {
  return job.steps.some((step) => STAGED_JOB_TYPES.has(step.type) && step.travels === true);
}

function stepTravels(type: JobType, config: Record<string, unknown>): boolean {
  const mod = modules.get(type);
  if (!mod || mod.machines === undefined) return false;
  return mod.machines(config ?? {}) === 'any';
}

/**
 * WHERE THIS STEP RUNS, or why it is not running yet.
 *
 * Synchronous on purpose — the pump is — so every network answer it needs has
 * either been cached already or is asked for here and decided on the next pass.
 */
type CrucibleAdmission =
  | {
      ok: true;
      venue: string;
      /**
       * The work lands on THIS machine's card — the local Crucible, or the
       * legacy narrator spawn. It is what decides whether the external GPU lock
       * and the arbiter are asked about this step at all.
       */
      onThisMachine: boolean;
    }
  | { ok: false; reason: string };

function crucibleAdmission(job: QueueJob): CrucibleAdmission {
  const host = crucibleHost;
  if (host === null) {
    // NOT a fallback to the local card: a build whose queue cannot ask where a
    // render goes must say so, not quietly take this machine's GPU.
    return {
      ok: false,
      reason: 'Waiting: this build did not wire the queue\'s Crucible routing, so nothing can say '
        + 'where this book renders. That is a bug in BookForge, not a setting.',
    };
  }

  let record: { ranked: WaitForServer[]; serversOnThisMachine: readonly string[] };
  try {
    record = host.routing();
  } catch (err) {
    // A corrupt routing record is refused by `routing.ts`, in its own words,
    // and those words carry the repair. They are shown rather than replaced.
    return { ok: false, reason: `Waiting: ${(err as Error)?.message || String(err)}` };
  }

  /*
   * THE DIAL, READ ON EVERY PASS AND NEVER CACHED HERE.
   *
   * It is a lever the operator turns while work is moving, so a value held from
   * an earlier pump would mean a turn took effect whenever the queue next
   * happened to change for some other reason. The record behind it is a small
   * synchronous file read, memoised by the host for a few seconds
   * (`queue-ipc.ts`), which is the same arrangement the routing view has.
   *
   * A HOST THAT CANNOT SAY IS REFUSED, not defaulted: assuming `any` would
   * silently ignore a dial somebody set, and there is no honest second guess.
   */
  let dial: string;
  try {
    dial = host.dial();
  } catch (err) {
    // A corrupt dial record is refused by `crucible/gpu-dial.ts` in its own
    // words, and those words carry the repair. Shown, never replaced.
    return { ok: false, reason: `Waiting: ${(err as Error)?.message || String(err)}` };
  }

  const verdict = decideWaitFor({
    waitFor: job.waitFor,
    resolved: job.waitForResolved,
    ranked: record.ranked,
    dial,
    state: serverState,
    // OUR OWN bookkeeping, never the server's state: how many GPU steps
    // BookForge already has in flight there (crucible
    // `docs/PHASE7-LANES.md` §2.4). It is what lets two books render on two
    // machines while two books bound for one machine take turns.
    gpuSlotTaken: (server) => gpuSlotTakenAt(server),
  });

  switch (verdict.kind) {
    case 'run':
      return {
        ok: true,
        venue: verdict.server,
        onThisMachine: record.serversOnThisMachine.includes(verdict.server),
      };
    case 'ask':
      askReach(verdict.server);
      return { ok: false, reason: verdict.sentence };
    case 'hold': return { ok: false, reason: verdict.sentence };
  }
}

/**
 * A SERVER'S GPU SLOT IS FULL OF OUR OWN WORK — the phrase naming it, or null.
 *
 * The count and the phrase are one answer rather than two calls, so a race
 * between them is not representable: a caller cannot be told the slot is taken
 * and then find nothing to name.
 */
function gpuSlotTakenAt(server: string): string | null {
  return gpuSlotHolder(server, currentSlotSets());
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
/**
 * Say on the row why it is not starting. Written to BOTH fields — `message`
 * because every existing readout shows it, and `admissionHold` because a
 * surface has to be able to ask "is this row being held off the card?" without
 * guessing at prose. A no-op when the sentence has not changed, so a snapshot
 * is not pushed on every tick.
 */
function holdStep(step: QueueStep, reason: string): void {
  if (step.progress.admissionHold === reason) return;
  step.progress = { ...step.progress, message: reason, admissionHold: reason };
  touchProgress();
}

function clearAdmissionHold(step: QueueStep): void {
  if (step.progress.admissionHold === undefined) return;
  const { admissionHold: _retired, ...rest } = step.progress;
  step.progress = rest;
  touchProgress();
}

/**
 * What BookForge has in flight, per slot set. Counted off the jobs — never
 * polled, never a model of a server's capacity (see `slot-sets.ts`).
 */
function currentOccupancy(): Map<string, SetOccupancy> {
  return slotSetOccupancy({ jobs });
}

/**
 * How many steps of one resource are running in one set.
 *
 * `wait` belongs to no machine, so its cap is counted across the whole queue —
 * a waiting step is on no bench at all (`StepResource`).
 */
function slotsInUse(setId: string, resource: StepResource): number {
  if (resource === 'wait') {
    let n = 0;
    for (const live of runningSteps.values()) if (live.resource === 'wait') n += 1;
    return n;
  }
  const entry = currentOccupancy().get(setId);
  if (entry === undefined) return 0;
  return resource === 'gpu' ? entry.gpu : entry.cpu;
}

/**
 * WHAT HOLDS A SET'S ONE GPU SLOT, as a phrase, or null when there is room.
 *
 * The count and the phrase are one answer rather than two calls, so a race
 * between them is not representable: a caller cannot be told the slot is taken
 * and then find nothing to name.
 */
function gpuSlotHolder(setId: string, sets: readonly SlotSet[]): string | null {
  const inUse = slotsInUse(setId, 'gpu');
  // Nothing of ours there: free, and there would be nothing to name anyway.
  if (inUse === 0) return null;
  if (inUse < slotsOf(sets, setId, 'gpu')) return null;
  // Non-null by construction: `occupantPhrase` reads the same running steps
  // `inUse` counted, so a positive count always has an occupant to name.
  return occupantPhrase(setId, 'gpu');
}

/**
 * WHICH REGISTERED SERVERS ANSWER ON THIS MACHINE'S LOOPBACK, for the one-card
 * rule below. Never worked out here — this file has no registry in it, so the
 * host is asked (crucible `docs/ARCHITECTURE.md` R1).
 */
function serversOnThisMachine(): readonly string[] {
  const host = crucibleHost;
  if (host === null) return [];
  try {
    return host.routing().serversOnThisMachine;
  } catch {
    // The record is unreadable; admission has already refused every travelling
    // row in `routing.ts`'s own words. Naming no server here leaves the
    // one-card rule with the in-app aligner alone, which is the set the only
    // work that can still start belongs to.
    return [];
  }
}

/**
 * THE MOMENT A BOOK IS TAKEN BY A GPU — the one place `waitForResolved` is
 * written, and the boundary every routing edit is measured against.
 *
 * Owen, 2026-09-15: *"all the way up to the moment it's taken by a gpu. the
 * moment it's taken, it's immutable."* This is that moment: it is called on the
 * line before `launch`, on every path that reaches it, and nowhere else.
 *
 * §4.3 is unchanged and enforced here rather than merely described: the field is
 * written ONCE and a second call over an already-assigned run is a no-op, so a
 * later step of the same run cannot move the book even if the record, the dial
 * or the operator has changed underneath it. A resume after a restart reads the
 * same value off disk and goes back to the same machine.
 *
 * `server` is the SERVER, never a cloud lane: the lane is where one STEP was
 * charged (`step.venue`), and the run was placed on the engine. They are two
 * scopes of one record and the callers keep them apart.
 *
 * Non-travelling steps assign nothing. Their venue is this machine's in-app
 * aligner, which is not a Crucible server and would be read as one by every door
 * that takes `waitForResolved` for a server's name.
 */
function assignRunVenue(job: QueueJob, step: QueueStep, server: string): void {
  if (step.travels !== true) return;
  if (job.waitForResolved !== undefined) return;
  job.waitForResolved = server;
}

/**
 * What is running in a set, as a phrase a sentence can carry — "narrating
 * Mistborn". Null when nothing is.
 *
 * Lower case and gerund-first because every caller puts it mid-sentence:
 * *"BookForge is already narrating Mistborn there."*
 */
function occupantPhrase(setId: string, resource: StepResource): string | null {
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.status !== 'running' || step.resource !== resource) continue;
      if (slotSetForStep(job, step) !== setId) continue;
      return `${JOB_GERUND[step.type].toLowerCase()} ${job.title}`;
    }
  }
  return null;
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
  /*
   * THE SLOT SETS, read ONCE for the whole pass. A pass that re-read them
   * between two rows could allocate against two different capacity models in
   * one pump — the server list is a fact about this instant, not about each
   * row in turn.
   */
  const sets = currentSlotSets();

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
    /*
     * A STAGED RUN IS SKIPPED WHOLE, and this is where "nothing about a pending
     * item is committed" is actually enforced. No venue is decided for it, no
     * slot is counted against it and no admission sentence is written on it, so
     * turning the dial or re-pointing the book costs exactly nothing right up to
     * the press that sends it. Its steps are `held` as well — belt and braces,
     * because either one alone would be a rule somebody could delete without a
     * test noticing.
     */
    if (isPending(job)) continue;
    for (const step of job.steps) {
      if (step.status !== 'queued') continue;
      const parent = parentOf(step);
      if (parent && parent.status !== 'done') { step.status = 'waiting'; continue; }

      if (step.resource !== 'gpu') {
        /*
         * NON-GPU WORK NEEDS NO MACHINE DECIDED, so its set is known up front:
         * a `cpu` step is work BookForge does itself and a `wait` step is on no
         * bench at all (`shared/queue/slot-sets.ts`).
         */
        const setId = slotSetForStep(job, step);
        const cap = setId === null ? WAIT_STEP_CAP : slotsOf(sets, setId, step.resource);
        if (slotsInUse(setId ?? LOCAL_WORK_SET, step.resource) >= cap) {
          // The pool being full IS this row's reason, and it outranks whatever
          // admission last said — a hold recorded before our own work took the
          // card would otherwise sit on the row naming an external lock that may
          // be long gone. Admission is not even asked below in this case, so this
          // is the only place that stale answer can be retired.
          clearAdmissionHold(step);
          continue;
        }
      } else {
        /*
         * TWO ADMISSIONS, AND THEY ARE ABOUT DIFFERENT MACHINES.
         *
         * The Crucible one is asked FIRST because its answer says whose card
         * this step wants — and since §2.4's slot sets are per machine, which
         * slot the step would occupy is not even a question until the venue is
         * known. The lock file and the arbiter describe THIS machine's card, so
         * they are asked only when the work is coming here: a book bound for the
         * Mac must not wait on a training chain that is holding the 3090 Ti
         * (crucible `docs/PHASE7-LANES.md` §2.5 — "a step running on a remote
         * machine does not hold the LOCAL card's slot").
         *
         * The SET is where the slot question is answered, and `decideWaitFor`
         * answers it for a server (it owns the sentence that names what
         * BookForge already has there). Two things it cannot answer are handled
         * below: the legacy spawn's own slot, and the fact that this machine has
         * one card behind two venues.
         *
         * RULING OWED, A4: for work landing HERE the queue still asks
         * `external-gpu-job.lock` and the GPU arbiter after Crucible admission.
         * With a local Crucible its 409 and its accelerator probe are the truth
         * about the card, and the lock file is how a TRAINING CHAIN — not a
         * Crucible client — says the card is taken. Whether the fine-tune should
         * instead take a Crucible lease is Owen's
         * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §0b A4).
         */
        const routed = step.travels === true
          ? crucibleAdmission(job)
          : { ok: true as const, venue: LONGFORM_ALIGN_SET, onThisMachine: true };
        if (!routed.ok) {
          admissionBlocked = true;
          if (step.progress.admissionHold !== routed.reason) {
            step.progress = {
              ...step.progress,
              message: routed.reason,
              admissionHold: routed.reason,
            };
            touchProgress();
          }
          continue;
        }

        /*
         * ── THE BOOK IS NOT ASSIGNED HERE ANY MORE ─────────────────────────
         *
         * `job.waitForResolved = routed.venue` used to be written on this line,
         * BEFORE every check below, so that a row waiting for a card was
         * "already pinned to the machine it will run on" and the bench could say
         * which card it was waiting for.
         *
         * Owen's ruling of 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`,
         * "Mutability") moved the boundary: *"i should be able to switch either
         * the queue item or the queue itself to resolve that. all the way up to
         * the moment it's taken by a gpu."* A row that merely DECIDED which
         * machine to try has not been taken by one — it may be sitting behind a
         * full slot for an hour — and `setWaitFor` refuses every edit to a
         * resolved row, so the old ordering made a book immutable long before a
         * GPU had it. That is the ruling denied by an implementation detail.
         *
         * So the assignment is written at the one moment the ruling names: the
         * instant the step LAUNCHES, on the two lines below that reach `launch`.
         * §4.3 is untouched — once written it is never changed, a resume goes
         * back to the same machine, and later steps of the run follow it.
         *
         * WHAT THAT COSTS, AND WHAT PAYS IT: `slotSetForStep` answers `null` for
         * an unassigned travelling row, so the bench can no longer derive a
         * "waiting for the card on X" sentence for one. It does not have to —
         * the admission hold written a few lines down NAMES the machine and what
         * is on it (`holdOurSlotTaken`), which is Owen's second parked sentence
         * and strictly more than the bench could say.
         */

        /*
         * ── DOES THIS ENGINE RUN THIS CLASS, OR FORWARD IT? ─────────────────
         *
         * crucible `docs/PHASE15-HOST.md` §5.3. The engine the row was just
         * placed on may be configured to route this step's capability class to
         * an upstream — Anthropic, OpenAI, a remote Ollama — on the operator's
         * account. Such a run holds no card: it costs the engine a socket. So
         * it takes that engine's `[cloud]` lane rather than its GPU slot, which
         * is what stops a translation on somebody's API waiting behind a
         * nine-hour narration for a card it will never touch.
         *
         * THIS IS THE ONE MOMENT BOTH FACTS EXIST. The route belongs to the
         * SERVER, so it is unknowable when the step is enqueued and the server
         * has not been chosen; the class belongs to the step module. They meet
         * here, once, and the answer is written onto the step — venue and
         * resource together — for `slotSetForStep` to read.
         *
         * `unknown` is a WAIT and never a guess (`crucible/routes.ts`): the row
         * is held with a sentence until coordination has read that engine's
         * capability document, which is one connect away and never a poll.
         * Assuming `local` would park an upstream-routed class on a card
         * nothing runs on; assuming `upstream` would do the mirror.
         */
        const routableClass = step.travels === true
          ? (moduleFor(step.type).crucibleClass?.(step.config ?? {}) ?? null)
          : null;
        let venue = routed.venue;
        if (routableClass !== null && routed.venue !== LONGFORM_ALIGN_SET) {
          const route = crucibleRouteOf(routed.venue, routableClass);
          if (route === 'unknown') {
            const reason = `Waiting: BookForge has not yet read where "${routed.venue}" runs `
              + `${routableClass} work. It asks that engine on every connect; this clears as soon `
              + 'as it answers.';
            admissionBlocked = true;
            if (step.progress.admissionHold !== reason) {
              step.progress = { ...step.progress, message: reason, admissionHold: reason };
              touchProgress();
            }
            continue;
          }
          if (route === 'upstream') {
            venue = cloudLaneOf(routed.venue);
            /*
             * The RESOURCE changes with the venue, and both are written here
             * for the same reason: the step was enqueued as `gpu` because that
             * is what an AI step is on the machine that runs it, and this run
             * is not going to run on a machine. `slotSetForStep` reads the
             * venue FIRST precisely so this pair lands in the cloud lane.
             */
            step.resource = 'cpu';
          }
        }

        // WHERE THIS STEP ITSELF WENT, written once — it is the slot set the
        // step occupies while it runs, and a run can hold two steps at two
        // venues while the migration is half done.
        step.venue = venue;

        /*
         * ── A CLOUD LANE IS ADMITTED HERE AND NOWHERE BELOW ────────────────
         *
         * Every gate after this one is about a CARD: the engine's GPU slot,
         * this machine's single 3090 Ti held by two venues, the external
         * training lock and the arbiter. An upstream-routed act touches none
         * of them — the engine forwards the request and settles nothing
         * (crucible PHASE15 §3.4: "no lease, no lane, the settlement
         * untouched (nothing was on the card)") — so asking would make a
         * translation on somebody's API wait for a narration to finish, which
         * is precisely the thing the lane exists to stop. Falling through with
         * a `cpu` resource would ALSO have read `gpuSlotHolder` against the
         * SERVER rather than the lane, which is a second wrong answer to the
         * same question.
         *
         * What it does wait for is its own lane being full, checked exactly as
         * the non-travelling branch above checks a set: a full pool IS the
         * row's reason, and the bench derives the sentence from the venue just
         * written, so no hold is recorded here.
         */
        if (isCloudLane(venue)) {
          if (slotsInUse(venue, step.resource) >= slotsOf(sets, venue, step.resource)) {
            clearAdmissionHold(step);
            continue;
          }
          clearAdmissionHold(step);
          assignRunVenue(job, step, routed.venue);
          void launch(job, step);
          continue;
        }

        /*
         * THE VENUE'S OWN SLOT, enforced in ONE place for every venue — a
         * server, or the legacy narrator spawn. The legacy set's one GPU slot
         * is what keeps the stopgap behaving exactly as it did under the old
         * global number; a server's is §2.4's per-machine capacity.
         *
         * The hold is RETIRED rather than replaced, exactly as the old
         * full-pool branch did: a full pool IS this row's reason and the bench
         * derives the sentence for it (`stillReason`'s `no-slot`, off the
         * `venue` just written). Writing one here would be a second sentence
         * for one fact, and the bench's outranks it, so it would sit on the row
         * unread. `admissionBlocked` is not set either: a slot frees when a
         * step settles, and settling pumps.
         */
        if (gpuSlotHolder(routed.venue, sets) !== null) {
          clearAdmissionHold(step);
          continue;
        }

        /*
         * THIS MACHINE HAS ONE CARD AND MORE THAN ONE VENUE OVER IT — the
         * in-app long-form aligner, and any Crucible that answers on this
         * machine's loopback. Separate sets, so nothing above would stop both
         * starting at once; the single global `gpu: 1` used to prevent that by
         * accident, and it is stated here now rather than rediscovered on a card
         * running two models.
         */
        const alsoHere = thisMachinesCardHeldBy({
          venue: routed.venue,
          serversOnThisMachine: serversOnThisMachine(),
          occupancy: currentOccupancy(),
        });
        const alsoWhat = alsoHere === null ? null : occupantPhrase(alsoHere, 'gpu');
        if (alsoHere !== null && alsoWhat !== null) {
          holdStep(step, `Waiting for this machine's graphics card: ${alsoHere} is already `
            + `${alsoWhat} on it. One card, one job — this run starts as soon as that `
            + 'finishes.');
          admissionBlocked = true;
          continue;
        }

        if (!routed.onThisMachine) {
          clearAdmissionHold(step);
          assignRunVenue(job, step, routed.venue);
          void launch(job, step);
          continue;
        }
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
        assignRunVenue(job, step, routed.venue);
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
    /*
     * EVERY STEP RUNS INSIDE ITS RUN'S CRUCIBLE LEASE SCOPE.
     *
     * The scope is what makes a row that cleans and then simplifies hold ONE
     * lease instead of two — without it the model is unloaded between the acts
     * and the second pays a full reload (`electron/crucible/lease.ts`, ONE
     * LEASE PER ROW). Around EVERY step, not only the leasing ones: a step that
     * never speaks to a Crucible simply never asks the scope for anything, and
     * a list of which types lease kept here would be a second owner of what
     * `leasesModel` already says.
     *
     * Named by the RUN, not by the step: the whole point is that the lease
     * outlives one step. `settleStep` is what closes it.
     */
    const output = crucibleLeaseHost === null
      ? await mod.run(ctx)
      : await crucibleLeaseHost.withRowScope(job.id, () => mod.run(ctx));
    settleStep(job, step, { ok: true, output });
  } catch (err) {
    settleStep(job, step, { ok: false, error: (err as Error)?.message || String(err) });
  }
}

type StepOutcome =
  | { ok: true; output: ArtifactRef }
  | { ok: false; error: string };

/**
 * IS THE RUN'S CRUCIBLE LEASE STILL WANTED once this step has ended?
 *
 * Yes exactly when a step that would use it — THE SAME ONE — is next in the
 * chain: a child of the one that just finished, not yet terminal, whose module
 * says its work is a run of chat completions (`StepModule.leasesModel`) AND
 * whose own model id (`StepModule.leasedModel`) is what the open lease is
 * already on. That is what makes "one lease per row" mean *per consecutive run
 * of acts against one model*.
 *
 * ── BOTH HALVES, AND WHY (Foundry, 2026-09-14) ─────────────────────────────
 *
 * `leasesModel` alone kept the lease across every pairing, and the acts of one
 * row do not share a model — clean runs on the 9B, simplify and translate on
 * the 27B. So clean → simplify carried the 9B's lease into the step that has
 * to put the 27B on the card, whose load Crucible refuses `leased`, naming
 * `bookforge`: this app, blocking itself, until the ttl lapsed. The archetypal
 * row this seam exists for was the one it broke.
 *
 * Comparing ids is the whole fix. An unnamed model (null) never equals an open
 * lease's subject, so anything undeclared releases — the behaviour before the
 * row scope existed, which is the safe direction.
 *
 * The SERVER is not compared because it cannot differ: a row has one
 * `waitForResolved`, and every act of it goes to that machine.
 *
 * ONLY AFTER A SUCCESS. A step that failed, was stopped, or came back
 * `409 server_busy` has no next act — its children are cancelled with it, or it
 * is itself going back into the queue — and its children are still `waiting` at
 * the moment this is asked, so reading them would keep a card held for work
 * that will never arrive. That is decided by the caller, which knows the
 * outcome; this answers only the chain question.
 */
function leaseWantedAfter(job: QueueJob, step: QueueStep, heldModel: string | null): boolean {
  if (heldModel === null) return false;
  for (const child of job.steps) {
    if (child.parentStepId !== step.id) continue;
    if (TERMINAL_STEP_STATUSES.has(child.status)) continue;
    const mod = modules.get(child.type);
    if (mod?.leasesModel?.(child.config ?? {}) !== true) continue;
    /*
     * A MODULE THAT LEASES AND WILL NOT SAY WHAT ends the run of acts. It is
     * not treated as "probably the same": the whole defect above was a lease
     * kept for an act that wanted something else, and a module with no answer
     * is precisely the case nothing can rule that out for.
     */
    if (mod.leasedModel?.(child.config ?? {}) === heldModel) return true;
  }
  return false;
}

function settleStep(job: QueueJob, step: QueueStep, outcome: StepOutcome): void {
  const live = runningSteps.get(step.id);
  const stopped = live?.stopRequested === true;
  const busyLine = live?.busyLine;
  runningSteps.delete(step.id);
  step.finishedAt = new Date().toISOString();

  /*
   * THE RUN'S LEASE, GIVEN BACK UNLESS THE NEXT ACT WANTS IT.
   *
   * Fired on EVERY settle — success, failure, cancel and the 409 wait below —
   * because a lease left open on a row that is not about to use it holds
   * somebody's card for its whole ttl. A no-op when the row holds none, which
   * is every row that never spoke to a Crucible.
   *
   * `void`, not awaited: the release is a DELETE over the network and the
   * scheduler's settle is synchronous by design (every caller reads the row's
   * new state on the next line). Nothing depends on the release having landed —
   * the ttl is the mechanism and this is the courtesy — and `release()` never
   * throws.
   */
  if (crucibleLeaseHost !== null) {
    // WHAT IS ACTUALLY HELD, asked of the seam rather than assumed from the
    // step that just ran: a lease survives its act, so the thing on the card
    // may have been taken three steps ago.
    const held = crucibleLeaseHost.leaseSubject(job.id);
    const leaseSurvives = outcome.ok && !stopped && leaseWantedAfter(job, step, held);
    if (!leaseSurvives) void crucibleLeaseHost.closeRow(job.id);
  }

  /*
   * A 409 IS A WAIT, NOT A FAILURE (crucible `docs/ARCHITECTURE.md` §3).
   *
   * The submit was refused because that machine is running somebody else's
   * job, so nothing about this row is wrong and nothing of its work is lost —
   * it never started. It goes back to `queued` carrying the holder's own line,
   * and the ordinary admission tick tries again. Failing it instead would put
   * an error on a row nobody did anything wrong on, and `retry()` — which
   * resets failures — would be the only way back.
   *
   * Handled FIRST, before the thermal accumulator and every other branch,
   * because this is the one outcome that is not an ending.
   */
  if (!outcome.ok && busyLine !== undefined && !stopped) {
    takeThermalSummary(step.id);
    step.status = 'queued';
    step.finishedAt = undefined;
    step.startedAt = undefined;
    step.error = undefined;
    const reason = holdBusy(job.waitForResolved ?? job.waitFor ?? 'that server', busyLine);
    step.progress = { ...step.progress, percent: undefined, message: reason, admissionHold: reason };
    changed();
    pump();
    return;
  }

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
    /*
     * THE RUN LEARNS ITS PROJECT FROM THE STEP THAT MINTS IT.
     *
     * A Foundry-ORDERED run is enqueued with a `documentPath` and NO `projectId`
     * (electron/foundry-host-queue.ts, `enqueue`) — at the press there is no
     * BookForge project in the conversation, only a Foundry step. The project
     * appears one step later: `foundry-export-landing` answers "which file, in
     * which book" and states it as `detail.projectDir`, and `tts-conversion`
     * repeats it.
     *
     * It has to be recorded on the JOB because two consumers gate on the job's
     * projectId and neither can reach a step's artifact: `StepFinished.projectId`
     * is filled from `job.projectId` below, and the renderer's
     * `handleStepFinished` (src/app/features/queue/services/queue.service.ts)
     * returns early without one — so on 2026-09-12 Owen's Starcraft narration
     * would have finished with the m4b linked to no project and Studio never
     * reloaded, even once the assembly itself was fixed.
     *
     * ONLY WHEN THE RUN HAS NONE. A run that named its project at compose time
     * said so about the whole run; a step is in no position to correct it.
     */
    if (!job.projectId) {
      const said = outcome.output.detail?.['projectDir'];
      if (typeof said === 'string' && said !== '') {
        job.projectId = said;
        console.log(
          `[QUEUE] ${job.id} had no project; ${step.type} (${step.id}) says it is ${said}.`);
      }
    }
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
    /*
     * THE RUN'S PROJECT, OR THIS ROW'S OWN. The branch above records the run's
     * the moment a step states one, so this fallback is for the step that STATED
     * it — a landing row whose event is announced in the same breath — and for a
     * row carrying `bfpPath` under a run that never had a project at all. Same
     * rule as the steps read it by, so the event and the work cannot disagree.
     */
    projectId: job.projectId ?? projectDirForStep({ input: step.output, job }, step.config),
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
  // Replaced, including to nothing: a finished prep pass must not leave a bar.
  if ('prep' in update) progress.prep = update.prep ?? undefined;
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
  // Observations about servers belong to a session, not to a queue file: a
  // machine that was unreachable when the app last shut down is not thereby
  // unreachable now.
  reachCache.clear();
  busyHolds.clear();
  // The bench redraws when the Crucible record learns something. Armed here
  // rather than at import so a second `configure` in one process (the keepers)
  // leaves exactly one listener behind, not two.
  watchCrucibleRecord();

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
  migrationReport = null;
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
        if (mod) {
          step.resource = mod.resource(step.config ?? {});
          /*
           * …EXCEPT WHERE THE STEP IS ALREADY ON A CLOUD LANE, and that is not
           * an exception to the rule above but the rule applied to a pair.
           *
           * A step admitted to an engine that ROUTES its class upstream was
           * written `venue: '<server>:cloud'` and `resource: 'cpu'` together,
           * at the one moment both facts existed (crucible PHASE15 §5.3). The
           * VENUE persists on purpose — §4.3, a job that started on a machine
           * finishes on that machine — so re-deriving only the resource would
           * split the pair and leave a `gpu` step sitting on a lane whose gpu
           * count is 0. It would never be admitted again and nothing would say
           * why. The module cannot answer this one: the route belongs to the
           * server, and the module is not told which server.
           */
          if (step.venue !== undefined && isCloudLane(step.venue)) step.resource = 'cpu';
          // Same rule, same reason: the module is the authority on whether this
          // step can travel, and a build that teaches one to must be able to
          // say so about work already in the queue.
          step.travels = stepTravels(step.type, step.config ?? {});
        }
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
  migrationReport = describeWaitForMigration(jobs);
}

/**
 * The one line a queue written before `waitFor` existed earns — see
 * {@link waitForMigrationReport}. Pure, so the keeper reads it directly.
 *
 * A run counts only when it can travel, is not finished, and has not already
 * been assigned: a book that is running on a machine answered the question by
 * doing it, and a finished one is history.
 */
export function describeWaitForMigration(list: readonly QueueJob[]): string | null {
  const named: string[] = [];
  for (const job of list) {
    if (!job.steps.some((step) => step.travels === true)) continue;
    if (job.waitFor !== undefined || job.waitForResolved !== undefined) continue;
    if (job.steps.length > 0 && TERMINAL_STEP_STATUSES.has(jobStatus(job))) continue;
    named.push(job.title);
  }
  if (named.length === 0) return null;
  return `${named.length} queued run(s) were composed before BookForge could name a Crucible `
    + `server, so they do not say where to render: ${named.join(', ')}. Each one holds until a `
    + 'server is chosen for it — pick one on the queue page, or set them all to Any.';
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
  if (unsubscribeCrucibleRecord !== null) {
    unsubscribeCrucibleRecord();
    unsubscribeCrucibleRecord = null;
  }
  await persist();
}

/** Read-only view of what is running right now — for the bookshelf server. */
export function runningStepIds(): string[] {
  return [...runningSteps.keys()];
}
