/** Crucible owns its installation layout and lifecycle on every platform. */
import { localStatus, startLocal, type LocalStatus } from '@crucible/bootstrap';
import { crucibleProcessRunner } from './host-runner';

export type EnginePresence = LocalStatus;
export function readEnginePresence(): Promise<EnginePresence> {
  return localStatus({}, crucibleProcessRunner());
}
export interface EngineStartOutcome { readonly started: boolean; readonly detail: string }
export async function startEngine(): Promise<EngineStartOutcome> {
  try {
    const result = await startLocal({}, crucibleProcessRunner());
    return { started: result.state === 'running', detail: result.detail };
  } catch (error) {
    return { started: false, detail: (error as Error).message };
  }
}

/** Check after the main window exists; unrelated remote engines still work. */
export async function offerLocalCrucibleStart(): Promise<void> {
  const { dialog } = await import('electron');
  const observed = await readEnginePresence();
  if (observed.state === 'running' || observed.state === 'absent') return;
  if (observed.state !== 'stopped' && observed.state !== 'unreachable') {
    await dialog.showMessageBox({ type: 'warning', title: 'Crucible needs attention',
      message: 'The local Crucible installation needs attention.', detail: observed.detail,
      buttons: ['Continue'], noLink: true });
    return;
  }
  const choice = await dialog.showMessageBox({ type: 'question', title: 'Start Crucible?',
    message: observed.state === 'stopped' ? 'Crucible is stopped on this computer.' : 'Crucible is installed but is not answering.',
    detail: 'Start it to use models on this computer. Other configured servers remain available.',
    buttons: ['Start Crucible', 'Not now'], defaultId: 0, cancelId: 1, noLink: true });
  if (choice.response !== 0) return;
  const outcome = await startEngine();
  if (!outcome.started) {
    await dialog.showMessageBox({ type: 'error', title: 'Crucible could not start',
      message: 'Crucible could not start.', detail: outcome.detail, buttons: ['Continue'] });
  }
}
