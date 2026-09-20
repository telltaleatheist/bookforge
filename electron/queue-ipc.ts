/**
 * queue-ipc — the doors onto the engine.
 *
 * Every one of them is a THIN wrapper. The engine decides; this file only turns
 * an IPC call into a call and an error into a sentence, because a renderer that
 * received a rejected promise with no message would show "undefined" where the
 * refusal should be.
 *
 * There is exactly one push: `jobs:changed`, carrying the WHOLE list, to EVERY
 * window. Not the eight per-bridge channels with eight wire shapes, and not
 * mainWindow-only — a Listen window is as entitled to see the queue as the main
 * one, and under the old arrangement it could only get one by booting a second
 * scheduler that then overwrote the first one's state file.
 *
 * ── Why the family is `jobs:` and not `queue:` ──────────────────────────────
 *
 * Because the vendored Foundry owns `queue:` and BookForge hosts it in THIS main
 * process. `queue:list`, `queue:enqueue`, `queue:start`, `queue:remove`,
 * `queue:cancel`, `queue:clear-finished` and `queue:changed` are all its channel
 * names, with the same verbs meaning a different queue — a duplicate
 * `ipcMain.handle` throws at registration and a duplicate renderer event fires
 * on the other app's messages in silence (tools/test-ipc-collision.js). The
 * subtree is sealed, so OURS is the one that renames.
 */
import { app, ipcMain } from 'electron';

import { broadcastToAllWindows } from './document-stage-run';
import { gpuHolder } from './gpu-arbiter';
import { startGpuThermalSampler } from './gpu-thermal-sampler';
import * as engine from './queue-engine';
import { registerAllStepModules } from './queue-steps';
import type { AppendStepSpec, JobSpec } from './queue-engine';
import { readRouting } from './crucible/routing';
import { activityOf, pingServer } from './crucible/probe';
import { crucibleLeaseSeam } from './crucible/lease';
import { busyLineFor, WAIT_FOR_ANY, type WaitForServer } from '../shared/queue/wait-for';

let registered = false;

// ────────────────────────────────────────────────────────────────────────────
// The engine's Crucible routing host
// ────────────────────────────────────────────────────────────────────────────
//
// `queue-engine.ts` imports no Electron and no registry, so the record and the
// prober are handed to it from here (see `CrucibleRoutingHost`).

/*
 * THE ROUTING VIEW IS READ FRESH, EVERY TIME. There is no memo here any more.
 *
 * ── What was here ───────────────────────────────────────────────────────────
 *
 * A ten-second memo over `readRouting()` and a second one over the GPU dial. Until 2026-09-15 the first was not an
 * optimisation at all but a necessity: `readRouting()` resolved the reserved
 * name `local` through a SYNCHRONOUS `wsl.exe` spawn of a few hundred
 * milliseconds. That name is gone and so is the spawn. What was left was a
 * memo over two small synchronous reads of files under `<userData>`.
 *
 * ── Why it had to go ────────────────────────────────────────────────────────
 *
 * Because the list it held is the list of MACHINES THAT EXIST, and a stale copy
 * of that is not a slow answer but a WRONG one. Only `setServerEnabled`
 * announced; `addServer`, `removeServer`, `setRoutingOrder` and
 * `forgetRoutingName` did not. So for up to ten seconds after a removal,
 * admission could still place an `any` book on a machine the registry no longer
 * has — the submit then fails against a missing entry and the row FAILS, which
 * is an error where a hold belongs — and a machine just added was invisible to
 * both the bench and admission (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A3
 * and C1; the hosted Foundry snapshot IS refreshed on add/remove, so the two
 * lists disagreed inside that window and `hostedCrucibleServerNotOffered`
 * failed the row).
 *
 * Owen, 2026-09-19: *"it can be a BookForge and Foundry-side change instantly.
 * Nothing gets sent to the other server from the queue."* Instant is two file
 * reads. The announcement stayed and grew — every registry and rank write calls
 * `announceCrucibleRecordChanged` now, which is what republishes the bench —
 * but nothing depends on it for FRESHNESS any more, which is the point: a memo
 * nobody remembered to invalidate is the defect, and the way to not forget is
 * to have nothing to remember.
 */

function crucibleRoutingHost(): engine.CrucibleRoutingHost {
  return {
    routing() {
      const view = readRouting();
      const ranked: WaitForServer[] = view.ranked.map((row) => ({
        name: row.name,
        enabled: row.enabled,
      }));
      return { ranked };
    },
    defaultWaitFor() {
      const view = readRouting();
      if (view.newJobsWaitFor === WAIT_FOR_ANY) return WAIT_FOR_ANY;
      const top = view.ranked.find((row) => row.enabled);
      // Null, not a name and not `any`: there is nothing to name, and both of
      // the alternatives would be a routing decision nobody made. See
      // `CrucibleRoutingHost.defaultWaitFor`.
      return top === undefined ? null : top.name;
    },
    async reach(server: string) {
      const pong = await pingServer(server);
      if (pong.outcome !== 'ok') {
        return { reachable: false as const, detail: pong.message };
      }
      return { reachable: true as const, busy: await busyAt(server) };
    },
  };
}

/**
 * WHAT IS ON THAT MACHINE'S CARD, before anything is submitted to it.
 *
 * Owen, 2026-09-19: *"Poll the server to see if it's available. If it isn't, it
 * just waits in the queue until it's available."* This is that poll, and it
 * rides the reach sweep the bench already runs — one `GET /v1/activity` per
 * enabled server per 15 s, beside the ping that is already going.
 *
 * ── The question it asks is the door's own question ────────────────────────
 *
 * `slots.accelerated.acceptsWork` is exactly what `POST /v1/jobs` will answer
 * with: false means the lane is held and a submit comes back `409 server_busy`.
 * Asking anything else here — chats in flight, a resident model, a lease held
 * by somebody — would park rows over facts that do not refuse a job (a vLLM
 * engine batches chats and really will take more, and a held LEASE is refused
 * on the lease door, which is where the reserve meets it).
 *
 * ── Null when it cannot say, and the backstop that covers it ───────────────
 *
 * `/v1/activity` arrived in Crucible 0.5.0, so an older server has no such
 * route and answers 404; a machine can also answer `ping` and then drop the
 * second call. Neither is evidence that the card is free, and neither is
 * evidence that it is held — so this answers `null`, the row is admitted, and
 * the `409` backstop does what it has always done. That is not a silent
 * fallback: it is the documented order with its first step unavailable, and it
 * is said out loud in the log, once per machine per run of the app.
 */
const activityGapReported = new Set<string>();

async function busyAt(server: string): Promise<{ line: string } | null> {
  const seen = await activityOf(server);
  if (seen.outcome !== 'ok') {
    if (!activityGapReported.has(server)) {
      activityGapReported.add(server);
      console.warn(
        `[QUEUE-IPC] crucible "${server}" answers its ping but not /v1/activity, so the queue `
        + `cannot see whether its card is free before it sends work there — it will learn from a `
        + `409 instead (${seen.message})`,
      );
    }
    return null;
  }
  const { activity } = seen;
  if (activity.slot.acceptsWork) return null;

  /*
   * WHO IS IN THE WAY, in the order the server can name them. A job is the
   * ordinary case; a streaming session holds the engine's exclusive claim and
   * has NO denominator by contract (`ActivityStreaming.progress`), which is why
   * the line composer takes a nullable progress rather than printing `0% done`
   * for a reader who has said nothing yet.
   */
  const job = activity.running[0];
  if (job !== undefined) {
    return {
      line: busyLineFor({
        holder: job.client,
        what: job.model === null ? job.type : `${job.type} ${job.model}`,
        progress: job.progress,
        message: job.message,
      }),
    };
  }
  const streaming = activity.streaming;
  if (streaming !== null) {
    return {
      line: busyLineFor({
        holder: streaming.client,
        what: `a streaming session (${streaming.voice})`,
        progress: null,
        message: null,
      }),
    };
  }
  /*
   * THE LANE IS SHUT AND THE SERVER NAMED NOBODY — a claim with no session yet,
   * a model being warmed, a shutdown in progress. The holder is reported as
   * what it is rather than guessed at, because a bench must never be
   * confidently wrong about whose render is on the card (PHASE7-LANES §5).
   */
  return {
    line: busyLineFor({
      holder: activity.claimedBy,
      what: activity.warming === null
        ? 'its accelerated slot is not taking work'
        : `loading ${activity.warming}`,
      progress: null,
      message: null,
    }),
  };
}

/**
 * Bring the engine up and open its doors.
 *
 * Ordering matters: the modules are registered BEFORE the state is loaded,
 * because loading is where a persisted step of a type nobody claims is turned
 * into a failed row saying so — and with no modules registered, that would be
 * every row.
 */
export async function startQueueEngine(): Promise<void> {
  registerAllStepModules();
  engine.onQueueChanged((snapshot) => {
    broadcastToAllWindows('jobs:changed', snapshot);
  });
  // The transition, not the state — see StepFinished. It is what the shelf, the
  // analytics ledger and the audio link hang off.
  engine.onStepFinished((event) => {
    broadcastToAllWindows('jobs:step-finished', event);
  });
  // Wired BEFORE `configure`, because the load path asks each step's module
  // whether it travels and then reports the runs that carry one and say
  // nothing about where — see `waitForMigrationReport`.
  engine.setCrucibleRoutingHost(crucibleRoutingHost());
  /*
   * ONE LEASE PER ROW. The scheduler is the only thing that knows a RUN is a
   * sequence of acts, so it is the only thing that can hold ONE lease across
   * them — a row that cleans and then simplifies used to take two, and the
   * model was unloaded in the gap. See `electron/crucible/lease.ts`, ONE LEASE
   * PER ROW. Wired HERE rather than imported by the engine, which keeps its one
   * property: no Electron, no registry, no HTTP.
   */
  engine.setCrucibleLeaseHost(crucibleLeaseSeam());
  await engine.configure({
    stateDir: app.getPath('userData'),
    gpuHolder,
  });
  // THE MIGRATION, SAID ONCE AND BY NAME. Not a crash and not a silent
  // default: the rows hold, each with its own sentence, and this is the line
  // that says so where somebody reading the log will see it.
  const migration = engine.waitForMigrationReport();
  if (migration !== null) console.warn(`[QUEUE-ENGINE] ${migration}`);
  // Thermal telemetry: samples only while a GPU step runs, disables itself on
  // machines with no nvidia-smi. See electron/gpu-thermal-sampler.ts.
  startGpuThermalSampler();
  registerQueueIpc();
}

/** What a door answers when the engine refuses. The reason is never swallowed. */
function refused(err: unknown): { success: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[QUEUE-IPC]', message);
  return { success: false, error: message };
}

export function registerQueueIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('jobs:list', () => ({ success: true, data: engine.snapshot() }));

  ipcMain.handle('jobs:enqueue', (_event, spec: JobSpec) => {
    try {
      return { success: true, data: engine.enqueue(spec) };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:append-step', (_event, jobId: string, spec: AppendStepSpec) => {
    try {
      return { success: true, data: engine.appendStep(jobId, spec) };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:release', (_event, target?: { jobId?: string; stepId?: string }) => {
    try {
      engine.release(target);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:start', (_event, target?: { jobId?: string; stepId?: string }) => {
    try {
      engine.start(target);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:pause', () => {
    engine.pause();
    return { success: true };
  });

  /**
   * `opts.resumable` says THE PRESS PROMISES A RESUME — the Stop button, and
   * nothing else. Carried across the wire rather than decided here, because
   * this door serves both Stop and the removal of one step of a multi-step run
   * and only the renderer knows which button was pressed.
   */
  ipcMain.handle('jobs:cancel', async (
    _event, target: { jobId?: string; stepId?: string }, reason?: string,
    opts?: { resumable?: boolean },
  ) => {
    try {
      await engine.cancel(target, reason, opts);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:retry', (_event, target: { jobId?: string; stepId?: string }) => {
    try {
      engine.retry(target);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:remove', async (_event, jobId: string) => {
    try {
      await engine.remove(jobId);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:reorder', (_event, jobId: string, beforeJobId: string | null) => {
    try {
      engine.reorder(jobId, beforeJobId);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:update-step-config', (
    _event, stepId: string, patch: Record<string, unknown>,
  ) => {
    try {
      engine.updateStepConfig(stepId, patch);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  ipcMain.handle('jobs:clear-finished', () => {
    engine.clearFinished();
    return { success: true };
  });

  // ── Per-row Crucible routing (crucible docs/PHASE7-LANES.md §4.2.1) ───────

  /** Point one book at a server, or at `any`. Refused by name — see setWaitFor. */
  ipcMain.handle('jobs:set-wait-for', (_event, jobId: string, value: string) => {
    try {
      engine.setWaitFor(jobId, value);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  /**
   * How many queued books name each server — the count §4.2.1a asks the
   * Servers row to show beside a switch somebody just turned off.
   */
  ipcMain.handle('jobs:wait-for-counts', () => {
    try {
      return { success: true, data: engine.waitForCounts() };
    } catch (err) { return refused(err); }
  });

  /** The one-click bulk change beside that count. `from: null` = the unanswered. */
  ipcMain.handle('jobs:bulk-wait-for', (_event, from: string | null, to: string) => {
    try {
      return { success: true, data: { moved: engine.bulkWaitFor(from, to) } };
    } catch (err) { return refused(err); }
  });

  // ── Pending ───────────────────────────────────────────────────────────────
  //
  // A `jobs:set-gpu-dial` door was here. The queue-wide GPU dial is gone (Owen,
  // 2026-09-19: *"that works for me"*) — the per-slot enable switches replaced
  // its control and nothing turned it any more. See `shared/queue/wait-for.ts`.

  /** Move a staged book into the live queue. Refused by name for one that is not staged. */
  ipcMain.handle('jobs:send-to-queue', (_event, jobId: string) => {
    try {
      engine.sendToQueue(jobId);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  /**
   * Take a book back OUT of the live queue and into Pending — stopping it first
   * if it is running. Its settings are kept verbatim and its server becomes a
   * question again. Refused by name for a run that is already staged, and for
   * one that chooses no machine and so has no staging band to return to.
   */
  ipcMain.handle('jobs:return-to-pending', async (_event, jobId: string) => {
    try {
      await engine.returnToPending(jobId);
      return { success: true };
    } catch (err) { return refused(err); }
  });

  /**
   * WHAT A RETURN WOULD NOT THROW AWAY, asked BEFORE the press so the dialog can
   * say it. Read-only; a null means there is nothing to warn about.
   */
  ipcMain.handle('jobs:return-to-pending-warning', (_event, jobId: string) => {
    try {
      return { success: true, data: { warning: engine.returnToPendingKeepsBank(jobId) } };
    } catch (err) { return refused(err); }
  });
}
