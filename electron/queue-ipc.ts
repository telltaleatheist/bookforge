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
import { LOCAL_SERVER_NAME } from './crucible/local';
import { readRouting } from './crucible/routing';
import { pingServer } from './crucible/probe';
import { closeCrucibleRowLease, withCrucibleRowScope } from './crucible/lease';
import { WAIT_FOR_ANY, type WaitForServer } from '../shared/queue/wait-for';

let registered = false;

// ────────────────────────────────────────────────────────────────────────────
// The engine's Crucible routing host
// ────────────────────────────────────────────────────────────────────────────
//
// `queue-engine.ts` imports no Electron and no registry, so the record and the
// prober are handed to it from here (see `CrucibleRoutingHost`).

/**
 * The routing view, MEMOISED FOR A FEW SECONDS.
 *
 * Not an optimisation: `readRouting()` calls `describeLocal()`, which on
 * Windows reads the local server's `config.toml` through a SYNCHRONOUS
 * `wsl.exe` spawn. The scheduler asks the routing question on every pump pass
 * over a queued narration, and a wsl spawn on the main thread per pass would
 * stutter the UI for as long as the queue holds.
 *
 * The staleness is bounded and harmless: admission re-asks on its own tick
 * (15 s), so a server enabled in Settings is used within one tick at worst, and
 * the doors in THIS file that change a row invalidate it immediately.
 */
const ROUTING_CACHE_MS = 10_000;
let routingCache: { at: number; view: ReturnType<typeof readRouting> } | null = null;

function cachedRouting(): ReturnType<typeof readRouting> {
  const now = Date.now();
  if (routingCache !== null && now - routingCache.at < ROUTING_CACHE_MS) return routingCache.view;
  const view = readRouting();
  routingCache = { at: now, view };
  return view;
}

function forgetRoutingCache(): void {
  routingCache = null;
}

function crucibleRoutingHost(): engine.CrucibleRoutingHost {
  return {
    routing() {
      const view = cachedRouting();
      const ranked: WaitForServer[] = view.ranked.map((row) => ({
        name: row.name,
        enabled: row.enabled,
      }));
      return {
        ranked,
        legacyLocalRender: view.legacyLocalRender,
        // Named only when this machine actually has one: `local` is in the
        // ranked list exactly when `describeLocal().present`.
        localName: ranked.some((row) => row.name === LOCAL_SERVER_NAME)
          ? LOCAL_SERVER_NAME
          : null,
      };
    },
    defaultWaitFor() {
      const view = cachedRouting();
      if (view.newJobsWaitFor === WAIT_FOR_ANY) return WAIT_FOR_ANY;
      const top = view.ranked.find((row) => row.enabled);
      // Null, not a name and not `any`: there is nothing to name, and both of
      // the alternatives would be a routing decision nobody made. See
      // `CrucibleRoutingHost.defaultWaitFor`.
      return top === undefined ? null : top.name;
    },
    async reach(server: string) {
      const pong = await pingServer(server);
      return pong.outcome === 'ok'
        ? { reachable: true as const }
        : { reachable: false as const, detail: pong.message };
    },
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
  engine.setCrucibleLeaseHost({
    withRowScope: withCrucibleRowScope,
    closeRow: closeCrucibleRowLease,
  });
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

  ipcMain.handle('jobs:cancel', async (
    _event, target: { jobId?: string; stepId?: string }, reason?: string,
  ) => {
    try {
      await engine.cancel(target, reason);
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
      forgetRoutingCache();
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
      forgetRoutingCache();
      return { success: true, data: { moved: engine.bulkWaitFor(from, to) } };
    } catch (err) { return refused(err); }
  });
}
