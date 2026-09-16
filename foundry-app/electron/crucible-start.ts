/** Crucible owns local discovery and lifecycle; Foundry only offers the action. */
import { localStatus, startLocal } from '@crucible/bootstrap';
import type { CrucibleStartResult } from '../shared/slots';
import { hosted } from './host';

export type CrucibleRunState =
  | { kind: 'running'; url: string | null; name: string | null }
  | { kind: 'stopped'; url: string | null }
  | { kind: 'absent'; why: string }
  | { kind: 'problem'; why: string }
  | { kind: 'not-ours' };

export async function crucibleRunState(): Promise<CrucibleRunState> {
  if (hosted()) return { kind: 'not-ours' };
  try {
    const status = await localStatus();
    switch (status.state) {
      case 'running': return { kind: 'running', url: status.url, name: status.name };
      case 'stopped': return { kind: 'stopped', url: status.url };
      case 'absent': return { kind: 'absent', why: status.detail };
      default: return { kind: 'problem', why: status.detail };
    }
  } catch (err) {
    return { kind: 'problem', why: err instanceof Error ? err.message : String(err) };
  }
}

export async function startCrucible(): Promise<CrucibleStartResult> {
  if (hosted()) {
    return { started: false, detail: 'The servers belong to the application Foundry is running inside.' };
  }
  try {
    const status = await startLocal();
    return { started: status.state === 'running', detail: status.detail };
  } catch (err) {
    return { started: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
