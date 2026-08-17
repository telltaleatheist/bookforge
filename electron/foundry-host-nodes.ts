/**
 * foundry-host-nodes — what BookForge is making, as rows on Foundry's tree.
 *
 * ── The two halves of the socket, and which one this is ─────────────────────
 *
 * The host-operations socket has a door in each direction. `mountFoundry({…,
 * hostOperations})` is the one Foundry calls INTO us (main.ts registers three
 * acts there); `setHostNodes(projectDir, nodes)` is the one we call into
 * Foundry, and it is this file. It answers exactly one question, whenever the
 * queue moves: what is BookForge making in this project, right now.
 *
 * ── Why the mapping is a pure function ──────────────────────────────────────
 *
 * `hostNodeSets` takes a queue snapshot and gives back the whole set of rows per
 * project, and it imports nothing from Electron or from the engine's mutable
 * state. So the wording of every row, the state table, the queue position and
 * the id scheme are all reachable from a keeper suite with a hand-built snapshot
 * — see tools/test-foundry-host-nodes.js. The subscription half below is nine
 * lines and holds the one piece of state a whole-set protocol needs.
 *
 * ── Whole-set semantics, and the one thing they cost ────────────────────────
 *
 * Foundry keeps what it was last given, per project, and an absent node is a
 * gone node. That makes removal free — a cleared run simply stops appearing —
 * with one obligation in return: a project whose LAST job goes away must still
 * be pushed, once, holding an empty list. Nothing else would tell Foundry the
 * rows are gone. `pushedProjects` is that memory and is the only state here.
 *
 * ── A host node is not a ledger step, and this file must never make one ─────
 *
 * Foundry's own rule (foundry-app/shared/host-ops.ts): these rows are display
 * only, they live as long as we keep pushing them, and nothing in Foundry's
 * project.json ever records one. The `parentStepId` we send is a LEDGER step id
 * that came back to us on an invoke — never an id of ours — which is why the
 * lineage field the engine carries stores it verbatim rather than deriving it.
 */
import {
  TERMINAL_STEP_STATUSES,
  type FoundryJobLineage,
  type JobType,
  type QueueJob,
  type QueueSnapshot,
  type QueueStep,
  type StepStatus,
} from '../shared/queue/engine-types';

// ────────────────────────────────────────────────────────────────────────────
// The socket's shapes, declared on OUR side
// ────────────────────────────────────────────────────────────────────────────
//
// DECLARED, NOT IMPORTED, for the reason main.ts declares the rest of the mount
// contract (electron/main.ts, "the hosted Foundry" block): `foundry-app/` is
// built output of a separate program with its own tsconfig, and a static import
// would drag the sealed subtree into BookForge's type program. These are the
// published spellings from foundry-app/shared/types.ts, and a change on their
// side shows up here as a compile error naming the field.

/** Where a host node has got to, in Foundry's four words. */
export type HostNodeState = 'queued' | 'running' | 'done' | 'failed';

/** All three together or none — Foundry's rule, not a convenience. */
export interface HostNodeProgress {
  percent: number;
  message: string;
  eta: string;
}

/** Which act a row is, which is what picks its icon on the tree. */
export type HostOperationKind = 'narrate' | 'enhance' | 'assemble';

/**
 * WHAT A PERSON MAY DO TO ONE OF OUR ROWS THAT FAILED — Foundry's fixed pair.
 *
 * Not an open list and not ours to extend: the tree draws exactly these two
 * buttons, named by Foundry, on a failed host node and only when the host
 * registered `onNodeAction`. See foundry-app/shared/host-ops.ts.
 */
export type HostNodeAction = 'retry' | 'dismiss';

export interface HostNode {
  id: string;
  parentStepId: string;
  title: string;
  detail: string;
  kind: HostOperationKind;
  state: HostNodeState;
  progress?: HostNodeProgress;
}

/*
 * The lineage a queued run carries when Foundry ordered it lives in
 * shared/queue/engine-types.ts beside `QueueJob`, because it is a field of the
 * PERSISTED queue and the renderer composes one. Re-exported here so a reader of
 * this file has the whole socket in one import.
 */
export type { FoundryJobLineage };

// ────────────────────────────────────────────────────────────────────────────
// Node ids
// ────────────────────────────────────────────────────────────────────────────

/**
 * `bf-node:<jobId>:<stepId>` — the id we mint, and the id that comes back.
 *
 * IT IS A ROUND TRIP AND THAT IS ITS WHOLE PURPOSE. When the user presses
 * Enhance from a narration that has not run yet, Foundry hands the pressed
 * node's id to our `invoke`, and this is how that id becomes "append a step to
 * job X after step Y" without a registry to keep in sync. A ledger step id can
 * never be mistaken for one of these, because we minted one of them and the
 * prefix says so.
 *
 * Engine ids are `job_<base36>_<hex8>` / `step_<base36>_<hex8>` — no colons —
 * so a two-colon split is exact rather than a parse that has to stay right.
 */
const NODE_ID_PREFIX = 'bf-node';

export function encodeNodeId(jobId: string, stepId: string): string {
  if (jobId.includes(':') || stepId.includes(':')) {
    throw new Error(
      `A queue id with a colon in it cannot be put in a host node id (job "${jobId}", `
      + `step "${stepId}"). Engine ids are minted without one.`,
    );
  }
  return `${NODE_ID_PREFIX}:${jobId}:${stepId}`;
}

/** The job and step a node id names, or null when it is not one of ours. */
export function decodeNodeId(nodeId: string): { jobId: string; stepId: string } | null {
  const parts = nodeId.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== NODE_ID_PREFIX) return null;
  const [, jobId, stepId] = parts;
  if (!jobId || !stepId) return null;
  return { jobId, stepId };
}

// ────────────────────────────────────────────────────────────────────────────
// The tables
// ────────────────────────────────────────────────────────────────────────────

/**
 * WHICH JOB TYPES ARE AUDIO WORK, and which act each one is.
 *
 * A `Partial<Record>` over the whole `JobType` union rather than a list of three
 * strings: a job type added later shows up here as an absent key, which is a
 * step that draws nothing, and adding it is a one-line decision made in the
 * place that already knows what the three kinds mean. A translation pass or a
 * VLM conversion is Foundry's own work and has a ledger step of its own — it
 * must never be mirrored back as a host node.
 */
export const NODE_KIND_OF: Partial<Readonly<Record<JobType, HostOperationKind>>> = {
  'tts-conversion': 'narrate',
  'rvc-enhancement': 'enhance',
  'reassembly': 'assemble',
};

/**
 * Engine step status → what Foundry draws. `null` means NO ROW AT ALL.
 *
 * A full `Record` over `StepStatus`, so a new engine status is a compile error
 * here rather than a step that silently stops being drawn.
 *
 *  - `held` and `waiting` are both 'queued' to Foundry, which has no third word
 *    for them. The difference is real and it is said in the DETAIL instead —
 *    "not started" versus "starts when Narrate finishes" — which is the field
 *    the socket reserves for exactly this ("Foundry never composes one").
 *  - `cancelled` draws NOTHING. A cancelled step is work the user called off,
 *    and a row saying so on somebody else's tree is this app leaving litter in
 *    another application's window. A FAILURE is different and stays: it is news
 *    the user has not seen yet.
 */
export const NODE_STATE_OF: Readonly<Record<StepStatus, HostNodeState | null>> = {
  held: 'queued',
  queued: 'queued',
  waiting: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: null,
};

// ────────────────────────────────────────────────────────────────────────────
// The words
// ────────────────────────────────────────────────────────────────────────────

/** A config value that is a non-empty string, or null. Never a guess. */
function textConfig(step: QueueStep, key: string): string | null {
  const value = step.config[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The card's title: what this act is, and the one thing about it worth naming.
 *
 * A narration is identified by its VOICE and an enhancement by its MODEL,
 * because a user who ordered two of them from one book is telling them apart by
 * nothing else. When the config names neither, the title says less rather than
 * inventing a name for it.
 */
export function nodeTitle(step: QueueStep, kind: HostOperationKind): string {
  if (kind === 'narrate') {
    // `fine_tuned` is the Orpheus spelling and `voice` everyone else's; the
    // config carries whichever the engine took, so both are read and neither is
    // defaulted.
    const voice = textConfig(step, 'voice') ?? textConfig(step, 'fineTuned');
    return voice === null ? 'Narrate' : `Narrate with ${voice}`;
  }
  if (kind === 'enhance') {
    const model = textConfig(step, 'rvcModel') ?? textConfig(step, 'modelName');
    return model === null ? 'Enhance the narration' : `Enhance with ${model}`;
  }
  return 'Assemble the audiobook';
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function fileName(p: string): string {
  const parts = p.split(/[\\/]/).filter((part) => part !== '');
  return parts.length === 0 ? p : parts[parts.length - 1]!;
}

/**
 * The row's one line, whatever state it is in — the host's sentence, which
 * Foundry is contractually forbidden to compose for us.
 *
 * `queuePosition` is 1-based among everything released and not yet running that
 * contends for the same pool, or null when this row is not in that line. It is
 * computed once for the whole snapshot rather than per row, because it is a fact
 * about the queue and not about the step.
 */
export function nodeDetail(
  step: QueueStep,
  job: QueueJob,
  queuePosition: number | null,
): string {
  switch (step.status) {
    case 'held':
      return step.wasInterrupted === true
        ? 'stopped part-way · press Start in BookForge to pick it up'
        : 'not started · press Start in BookForge';
    case 'waiting': {
      const parent = job.steps.find((s) => s.id === step.parentStepId);
      return parent === undefined
        ? 'waiting for the step before it'
        : `starts when ${parent.label} finishes`;
    }
    case 'queued':
      return queuePosition === null ? 'queued' : `queued · ${ordinal(queuePosition)} in line`;
    case 'running':
      return step.progress.message ?? step.progress.detail ?? 'running';
    case 'done':
      return step.outputPath === undefined ? 'finished' : `finished · ${fileName(step.outputPath)}`;
    case 'failed':
      return step.error ?? 'failed, and the run recorded no reason.';
    case 'cancelled':
      // Unreachable: NODE_STATE_OF draws no row for it. Written out anyway so
      // the switch is exhaustive and a new status cannot fall through silently.
      return 'cancelled';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Progress
// ────────────────────────────────────────────────────────────────────────────

/**
 * Seconds left, measured — never estimated from nothing.
 *
 * The same measurement the queue's own readouts take (JobEtaService, and the
 * anchor `StepMetrics.firstChunkCompletedAt` / `chunksAtFirstStamp` exists for):
 * chunks completed since the anchor, over the wall time since the anchor. It is
 * NOT measured from `startedAt`, which would fold model load into the rate, and
 * it is not reported at all until the window is long enough to average out a
 * batched engine's bursts (`RATE_WINDOW_MIN_SECONDS`).
 */
const RATE_WINDOW_MIN_MS = 45_000;

export function etaSeconds(step: QueueStep, now: number): number | null {
  const m = step.metrics;
  const anchorAt = m.firstChunkCompletedAt;
  const anchorCount = m.chunksAtFirstStamp;
  const done = m.chunksCompletedInJob;
  const total = m.totalChunksInJob;
  if (anchorAt === undefined || anchorCount === undefined) return null;
  if (done === undefined || total === undefined) return null;
  const elapsedMs = now - anchorAt;
  if (elapsedMs < RATE_WINDOW_MIN_MS) return null;
  const completed = done - anchorCount;
  if (completed <= 0) return null;
  const remaining = total - done;
  if (remaining <= 0) return null;
  const perMs = completed / elapsedMs;
  return Math.round(remaining / perMs / 1000);
}

/** "1 h 12 m left", "4 m left", "40 s left". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} m left`;
}

/**
 * The live half of a running card, or nothing.
 *
 * ALL THREE OR NONE is Foundry's rule and it is why this returns undefined
 * rather than a partly-filled object: a bar with no percentage and a percentage
 * with no bar are two halves of one control.
 *
 * The ETA is the one field with no measurement behind it early in a run, and
 * "estimating…" is what it says then. That is not a fallback value — it is the
 * true answer to how much longer, said in words, and the alternative (dropping
 * the whole progress object for the first minute of a nine-hour narration) would
 * hide a bar we can honestly draw for the sake of a number we cannot.
 */
export function nodeProgress(step: QueueStep, now: number): HostNodeProgress | undefined {
  if (step.status !== 'running') return undefined;
  const percent = step.progress.percent;
  if (percent === undefined) return undefined;
  const message = step.progress.message ?? step.progress.detail;
  if (message === undefined) return undefined;
  const seconds = etaSeconds(step, now);
  return {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message,
    eta: seconds === null ? 'estimating…' : formatEta(seconds),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// The mapping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every project's whole set of host nodes, as of this snapshot.
 *
 * Keyed by the project directory the job's lineage names, spelled exactly as the
 * invoke gave it: Foundry folds the key itself for the Windows-casing reason,
 * and re-spelling it here would be this side guessing at that fold.
 *
 * A job with no `foundry` lineage contributes nothing — that is the whole
 * gate, and it is why an ordinary narration started from the versions page never
 * appears on anybody's tree.
 */
export function hostNodeSets(
  snapshot: QueueSnapshot,
  now: number = Date.now(),
): Map<string, HostNode[]> {
  /*
   * The line, computed once. Everything released and not yet running, in the
   * order the engine will claim it — job order, then step order — split by pool,
   * because a cpu step queued behind a nine-hour narration is not behind it.
   */
  const positions = new Map<string, number>();
  const seen: Record<string, number> = { gpu: 0, cpu: 0 };
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status !== 'queued') continue;
      seen[step.resource] = (seen[step.resource] ?? 0) + 1;
      positions.set(step.id, seen[step.resource]!);
    }
  }

  const sets = new Map<string, HostNode[]>();
  for (const job of snapshot.jobs) {
    const lineage = job.foundry;
    if (lineage === undefined) continue;
    const nodes = sets.get(lineage.projectDir) ?? [];
    for (const step of job.steps) {
      const kind = NODE_KIND_OF[step.type];
      if (kind === undefined) continue;
      const state = NODE_STATE_OF[step.status];
      if (state === null) continue;
      const progress = nodeProgress(step, now);
      nodes.push({
        id: encodeNodeId(job.id, step.id),
        parentStepId: lineage.parentStepId,
        title: nodeTitle(step, kind),
        detail: nodeDetail(step, job, positions.get(step.id) ?? null),
        kind,
        state,
        // Omitted rather than set to undefined: the whole set crosses the seam
        // and an explicit `progress: undefined` is a key Foundry would read.
        ...(progress === undefined ? {} : { progress }),
      });
    }
    sets.set(lineage.projectDir, nodes);
  }
  return sets;
}

/**
 * Whether a step can still be chained onto — the question `invoke` asks before
 * it appends, so a press on a row that has already failed is refused in words
 * rather than by the engine's own message about lineage.
 */
export function isChainable(step: QueueStep): boolean {
  return !TERMINAL_STEP_STATUSES.has(step.status) || step.status === 'done';
}

// ────────────────────────────────────────────────────────────────────────────
// Retry and Dismiss
// ────────────────────────────────────────────────────────────────────────────

/**
 * WHICH ENGINE CALL A PRESS ON A FAILED CARD IS — the whole of the decision,
 * with none of the doing.
 *
 * `retry` targets the STEP and `dismiss` takes the RUN, and the asymmetry is the
 * point rather than an oversight. A retry is about the one row that failed: the
 * engine resets it and everything downstream of it and leaves the steps that
 * already succeeded alone, which is what stops "the assembly failed" from
 * re-narrating nine hours of book. A dismiss is about the whole run, because
 * there is no such thing as removing one step — the queue's unit of forgetting
 * is a job, and a job with its failed step deleted would be a run that claimed
 * to have finished work nobody did.
 *
 * A RETRIED STEP COMES BACK HELD, NOT RUNNING, and that is the engine's own
 * design (`retry`, queue-engine.ts: "re-running is a decision, and a failure the
 * user has not looked at yet must not restart itself because the queue happened
 * to be running"). The card therefore returns to the tree saying "not started ·
 * press Start in BookForge" rather than going straight back to work, which is
 * the honest reading of what just happened.
 */
export type HostNodeActionPlan =
  | { readonly call: 'retry'; readonly stepId: string }
  | { readonly call: 'remove'; readonly jobId: string };

/**
 * What to do about a press on a failed card, proved against the live queue.
 *
 * BOTH REFUSALS NAME WHAT WAS LOOKED FOR, because both are reached the same way
 * — a tree drawing a row the queue has moved on from — and the rejection travels
 * back over `host-ops:node-action` to be SAID AT THE BUTTON (foundry-app's
 * `actOnHostNode`). A sentence about an id nobody can place is the one thing
 * that must not arrive there, so the id is spelled out and the sentence says
 * which of the two verbs could not be carried out.
 *
 * Pure, and takes the snapshot rather than reaching for the engine, for the same
 * reason `hostNodeSets` does: the decision is worth defending from a keeper with
 * a hand-built queue rather than only by running two applications.
 */
export function planNodeAction(
  nodeId: string,
  action: HostNodeAction,
  snapshot: QueueSnapshot,
): HostNodeActionPlan {
  const decoded = decodeNodeId(nodeId);
  if (decoded === null) {
    throw new Error(
      `BookForge cannot ${action} "${nodeId}": that is not one of the rows it is making. Retry `
      + 'and Dismiss act on BookForge\'s own work, and this row belongs to something else.',
    );
  }
  const job = snapshot.jobs.find((j) => j.id === decoded.jobId);
  const step = job?.steps.find((s) => s.id === decoded.stepId);
  if (job === undefined || step === undefined) {
    throw new Error(
      `BookForge's queue no longer holds the run "${decoded.jobId}" with the step `
      + `"${decoded.stepId}", so there is nothing left to ${action}. It was cleared or removed `
      + 'while this row was on screen.',
    );
  }
  return action === 'retry'
    ? { call: 'retry', stepId: step.id }
    : { call: 'remove', jobId: job.id };
}

// ────────────────────────────────────────────────────────────────────────────
// The subscription
// ────────────────────────────────────────────────────────────────────────────

/** Exactly `setHostNodes` from the mount seam. Passed in, so this file is pure. */
export type PushHostNodes = (projectDir: string, nodes: readonly HostNode[]) => void;

/**
 * Projects we have pushed a non-empty set for, so we know which ones need the
 * empty push that says "nothing of mine is here any more". Without it, clearing
 * a finished run would leave its rows on the tree until Foundry restarted.
 */
const pushedProjects = new Set<string>();

/**
 * Wire the queue to the tree. Called once, at mount, with the seam's push door.
 *
 * `onQueueChanged` already coalesces progress (ten a second at most), so this
 * pushes on EVERY change and does no throttling of its own — one more layer of
 * timers between the queue and a readout is how a readout comes to be a second
 * behind the thing it reads.
 *
 * The first push happens on the engine's own load-time `changed()`, which is why
 * a run that survived a restart draws immediately rather than at the next
 * progress line.
 */
export function publishHostNodes(snapshot: QueueSnapshot, push: PushHostNodes): void {
  const sets = hostNodeSets(snapshot);
  for (const [projectDir, nodes] of sets) {
    push(projectDir, nodes);
    if (nodes.length === 0) pushedProjects.delete(projectDir);
    else pushedProjects.add(projectDir);
  }
  for (const projectDir of [...pushedProjects]) {
    if (sets.has(projectDir)) continue;
    push(projectDir, []);
    pushedProjects.delete(projectDir);
  }
}

/** For the keeper suite, which drives `publishHostNodes` over several snapshots. */
export function resetPushedProjects(): void {
  pushedProjects.clear();
}
