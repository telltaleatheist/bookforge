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
import * as engine from './queue-engine';
import { registerAllStepModules } from './queue-steps';
import type { AppendStepSpec, JobSpec } from './queue-engine';

let registered = false;

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
  await engine.configure({
    stateDir: app.getPath('userData'),
    gpuHolder,
  });
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
}
