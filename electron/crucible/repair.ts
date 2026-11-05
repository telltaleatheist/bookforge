/**
 * REPAIR A CRUCIBLE: verify what it has installed by hash, and put back what is broken.
 *
 * Owen, 2026-11-04: "a doctor that repairs broken environments by redownloading them
 * if they arent right." Two doors, one answer:
 *
 *  - REPAIRING THIS MACHINE'S engine goes through `@crucible/bootstrap`'s `repair()`,
 *    because the server and its service cannot be repaired from inside themselves.
 *  - EVERYTHING ELSE is the server's own `repair` task, submitted over the API.
 *
 * CHECK ONLY NEVER TAKES THE FIRST DOOR, on any row. `repair({scope:{verifyOnly:true}})`
 * makes only the TASK verify-only: before the task it can still reinstall the runtime and
 * start the service. A check asks the server that is running, and if none answers it
 * says so and has touched nothing.
 *
 * Both end in the same `RepairResult`, and `shared/crucible/repair-wire.ts` is the one
 * view of it. Whether a row is this machine's is decided the way the uninstall door
 * decides it: its address against the address of the Crucible found here, never its name.
 *
 * WEATHER AND MISCONFIGURATION. A dropped stream during a long hash is weather: the task
 * is still running on the server, so this reconnects within a budget and then asks the
 * task how it ended. A server too old to have the task is something a person repairs,
 * so it is one sentence saying that server needs updating, and never a crash.
 */

import {
  CrucibleRefused,
  type RepairResult,
  type TaskRepairData,
} from '@crucible/client';

import {
  CRUCIBLE_REPAIR_HERE,
  type CrucibleRepairEvent,
  type CrucibleRepairResult,
} from '../../shared/crucible/repair-wire';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { crucibleUnavailableCause } from './transport-failure';

/** The app's shape IS the SDK's, and the compiler is what says so (install-door.ts does the same). */
const asAppResult = (result: RepairResult): CrucibleRepairResult => result;

/** How long a dropped stream is reconnected for before the row says it lost the server. */
const STREAM_LOST_BUDGET_MS = 10 * 60_000;
const STREAM_RETRY_MS = 5_000;

export interface RepairOptions {
  readonly verifyOnly: boolean;
}

/** What the door needs from the world; a keeper hands it fakes. */
export interface RepairDeps {
  /** Is this registered server the Crucible on this machine? */
  readonly isLocal: (server: string) => Promise<boolean>;
  /** `@crucible/bootstrap`'s `repair`, with this app's runner and distro already applied. */
  readonly localRepair: (options: {
    scope: { verifyOnly: false };
    onStep: (step: { name: string; status: 'running' | 'ok' | 'failed'; detail: string }) => void;
    onRepair: (data: TaskRepairData) => void;
    onProgress: (progress: { bytesDone: number; bytesTotal: number | null; file: string }) => void;
  }) => Promise<{
    server: 'ok' | 'reinstalled' | 'broken';
    service: 'running' | 'started' | 'stopped';
    task: RepairResult | null;
    healthy: boolean;
    detail: string | null;
  }>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly streamLostBudgetMs?: number;
}

/**
 * A server that does not know the task refuses the body: 2.0.34's `TaskCreate` forbids
 * extra fields, so `scope` comes back 400 `invalid_request`, "body.scope: Extra inputs are
 * not permitted". Only that field: any other invalid request is a real refusal, kept in
 * its own words rather than blamed on the server's age.
 */
function tooOldForRepair(err: unknown): boolean {
  return err instanceof CrucibleRefused
    && err.code === 'invalid_request' && /body\.scope\b/.test(err.serverMessage);
}

function frameEvent(server: string, data: TaskRepairData): CrucibleRepairEvent {
  return {
    kind: 'frame', server, step: data.step, state: data.state,
    subject: data.subject, detail: data.detail, bytesToCheck: data.bytesToCheck,
  };
}

/** Nobody answered, so nothing happened. Which of the two buttons was pressed changes the cure. */
function notAnswering(server: string, cause: string, verifyOnly: boolean, local: boolean): CrucibleRepairEvent {
  const cure = verifyOnly
    ? `Check only asks the running server and never starts or installs anything.${local ? ' Repair is what brings this computer\'s engine back.' : ''}`
    : 'Start that server, then run this again.';
  return {
    kind: 'refused', server, code: 'server_not_answering', needsUpdate: false, command: null,
    message: `crucible "${server}" did not answer (${cause}), so nothing was checked or changed. ${cure}`,
  };
}

function refusalOf(server: string, err: unknown): CrucibleRepairEvent {
  // A bootstrap refusal carries its own code and cure (`server_unrepairable`: reinstall).
  const named = err as { code?: unknown; message?: unknown; command?: unknown } | null;
  const code = typeof named?.code === 'string' ? named.code : 'repair_failed';
  const message = err instanceof Error ? err.message : String(err);
  const command = typeof named?.command === 'string' ? named.command : null;
  return { kind: 'refused', server, code, message, command, needsUpdate: false };
}

/** Follow one server's repair task to its end, surviving a dropped stream. */
async function followRepairTask(
  server: string,
  taskId: string,
  emit: (event: CrucibleRepairEvent) => void,
  deps: RepairDeps,
): Promise<CrucibleRepairEvent> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const budget = deps.streamLostBudgetMs ?? STREAM_LOST_BUDGET_MS;
  let lostSince: number | null = null;
  for (;;) {
    try {
      for await (const event of client.taskEvents(taskId)) {
        lostSince = null;
        if (event.event === 'repair') emit(frameEvent(server, event.data));
        else if (event.event === 'progress' && !('line' in event.data)) {
          emit({
            kind: 'progress', server, bytesDone: event.data.bytesDone,
            bytesTotal: event.data.bytesTotal, file: event.data.file,
          });
        }
      }
      break;
    } catch (err) {
      const cause = crucibleUnavailableCause(err);
      if (cause === null) throw err;
      const now = Date.now();
      lostSince = lostSince ?? now;
      if (now - lostSince >= budget) throw err;
      // A frame that says so, in the only words it can honestly use: the server may well
      // still be working, and hashing hundreds of GB is no reason to stop asking.
      emit({
        kind: 'frame', server, step: 'wait', state: 'running', subject: null,
        detail: `Lost touch with crucible "${server}" (${cause}); asking again shortly. The repair continues on the server.`,
        bytesToCheck: null,
      });
      await sleep(STREAM_RETRY_MS);
    }
  }
  const status = await client.task(taskId);
  if (status.state === 'done' && status.result !== null) {
    return { kind: 'done', server, result: asAppResult(status.result), hostNote: null };
  }
  const code = status.error?.code ?? `repair_${status.state}`;
  const message = status.error?.message
    ?? (status.state === 'cancelled' ? 'The repair was stopped.' : `The repair ended ${status.state} with no result.`);
  return { kind: 'refused', server, code, message, command: null, needsUpdate: false };
}

/**
 * Repair one registered server, pushing each event as it happens. Never throws: a
 * refusal is the last event, because the row that started it is the one that says so.
 */
export async function repairCrucibleServer(
  server: string,
  options: RepairOptions,
  emit: (event: CrucibleRepairEvent) => void,
  deps: RepairDeps,
): Promise<void> {
  const scope = { verifyOnly: options.verifyOnly };
  try {
    const local = await deps.isLocal(server);
    if (local && !options.verifyOnly) {
      await repairThroughBootstrap(server, emit, deps);
      return;
    }
    emit({ kind: 'started', server, verifyOnly: options.verifyOnly, local: false, taskId: null });
    let taskId: string;
    try {
      const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
      taskId = await client.submitTask({ type: 'repair', scope });
    } catch (err) {
      const cause = crucibleUnavailableCause(err);
      if (cause !== null) {
        emit(notAnswering(server, cause, options.verifyOnly, local));
        return;
      }
      if (tooOldForRepair(err)) {
        emit({
          kind: 'refused', server, code: 'server_needs_update', needsUpdate: true, command: null,
          message: `crucible "${server}" is too old to repair itself: it does not have the repair task. `
            + 'Update that server, then run this again. Nothing was checked or changed.',
        });
        return;
      }
      throw err;
    }
    emit({ kind: 'task', server, taskId });
    emit(await followRepairTask(server, taskId, emit, deps));
  } catch (err) {
    emit(refusalOf(server, err));
  }
}

/** The one door that may reinstall the runtime or start the service. Never a check. */
async function repairThroughBootstrap(
  server: string,
  emit: (event: CrucibleRepairEvent) => void,
  deps: RepairDeps,
): Promise<void> {
  emit({ kind: 'started', server, verifyOnly: false, local: true, taskId: null });
  const outcome = await deps.localRepair({
    scope: { verifyOnly: false },
    onStep: (step) => emit({ kind: 'host-step', server, name: step.name, status: step.status, detail: step.detail }),
    onRepair: (data) => emit(frameEvent(server, data)),
    onProgress: (p) => emit({ kind: 'progress', server, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, file: p.file }),
  });
  if (outcome.task === null) {
    // Only a verify-only run should end here, and this door is never one. Said, not assumed.
    emit({
      kind: 'refused', server, code: 'repair_failed', needsUpdate: false, command: null,
      message: outcome.detail ?? 'The repair ended with no result from the server, and nothing said why.',
    });
    return;
  }
  const notes = [
    outcome.server === 'reinstalled' ? 'The server would not answer, so it was reinstalled.' : null,
    outcome.service === 'started' ? 'Its service was not running and was started.' : null,
  ].filter((n): n is string => n !== null);
  emit({ kind: 'done', server, result: asAppResult(outcome.task), hostNote: notes.length > 0 ? notes.join(' ') : null });
}

/**
 * REPAIR THE ENGINE ON THIS COMPUTER WHEN NO ROW NAMES IT. A Crucible too broken to
 * answer, or with a config nothing can read, may never have become a row, and it is
 * exactly the one that needs this. Same door, same events, keyed CRUCIBLE_REPAIR_HERE.
 */
export async function repairCrucibleHere(
  emit: (event: CrucibleRepairEvent) => void,
  deps: RepairDeps,
): Promise<void> {
  try {
    await repairThroughBootstrap(CRUCIBLE_REPAIR_HERE, emit, deps);
  } catch (err) {
    emit(refusalOf(CRUCIBLE_REPAIR_HERE, err));
  }
}

/** The real world's deps. Lazily imported, as `install.ts` does with the package. */
export function processRepairDeps(): RepairDeps {
  return {
    isLocal: async (server) => {
      const { discoverCrucible, processDiscoveryHost, CrucibleDiscoveryError } = await import('./discovery.js');
      const { getWslDistro } = await import('../tool-paths.js');
      const { getServer } = await import('./servers.js');
      const entry = getServer(server);
      try {
        const found = discoverCrucible(processDiscoveryHost(getWslDistro()));
        return found.url.replace(/\/+$/, '') === entry.url.replace(/\/+$/, '');
      } catch (err) {
        if (err instanceof CrucibleDiscoveryError) return false;
        throw err;
      }
    },
    localRepair: async (options) => {
      const bootstrap = await import('@crucible/bootstrap');
      const { crucibleProcessRunner } = await import('./host-runner.js');
      const { getWslDistro } = await import('../tool-paths.js');
      return bootstrap.repair(
        { ...options, distro: getWslDistro(), clientName: CRUCIBLE_CLIENT_NAME },
        crucibleProcessRunner(),
      );
    },
  };
}
