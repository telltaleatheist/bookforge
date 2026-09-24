import type { CrucibleClient } from '@crucible/client';
import type { CrucibleEngineUpgradeProgress } from '../../shared/crucible/engine-controls-wire';
import { crucibleClientFor } from './servers';
import { forgetResolvedEngine } from './engine-resolve';
import { stated } from './unstated';

interface UpgradeDeps {
  client(server: string): Promise<Pick<CrucibleClient, 'info' | 'submitTask' | 'taskEvents'>>;
  pause(): Promise<void>;
  forget(server: string): void;
}
const defaults: UpgradeDeps = {
  client: (server) => crucibleClientFor(server, 'BookForge'),
  pause: () => new Promise(resolve => setTimeout(resolve, 2000)),
  forget: forgetResolvedEngine,
};

/** The engine delegates WSL ownership to its controller; BookForge only follows its task. */
export async function upgradeWsl(
  server: string, report: (progress: CrucibleEngineUpgradeProgress) => void, deps: UpgradeDeps = defaults,
): Promise<void> {
  const say = (state: CrucibleEngineUpgradeProgress['state'], message: string) => report({ server, state, message });
  try {
    const client = await deps.client(server);
    const before = await client.info();
    if (before.host.backend !== 'llama-windows') throw new Error('The WSL upgrade is available on a native Windows engine only.');
    const taskId = await client.submitTask({ type: 'engine', target: 'wsl' });
    say('running', 'Crucible is preparing WSL acceleration. Its controller handles any Windows permission or restart requirements.');
    let failure: string | null = null;
    // Switching engines can close the old process's stream before its last frame.
    try {
      for await (const event of client.taskEvents(taskId)) {
        if (event.event === 'failed') { failure = `${event.data.code}: ${event.data.message}`; break; }
        if (event.event === 'cancelled') { failure = 'The WSL upgrade was cancelled.'; break; }
        if (event.event === 'step') say('running', stated(event.data.name));
        if (event.event === 'unknown' && event.kind === 'state' && typeof event.data['sentence'] === 'string') {
          say('running', event.data['sentence']);
        }
        if (event.event === 'progress') {
          say('running', 'line' in event.data ? event.data.line
            : `${stated(event.data.file)}: ${(event.data.bytesDone / 1e6).toFixed(1)} MB downloaded`);
        }
        if (event.event === 'done') break;
      }
    } catch (error) {
      say('running', `The engine connection changed; checking whether WSL is ready. ${(error as Error).message}`);
    }
    if (failure !== null) throw new Error(failure);
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        deps.forget(server);
        const current = await (await deps.client(server)).info();
        if (current.server.apiVersion === 1 && current.host.backend === 'cuda-linux') {
          say('done', 'WSL acceleration is ready. BookForge is preparing the engine for your projects.');
          return;
        }
      } catch { /* The controller can still be switching its listener. */ }
      await deps.pause();
    }
    throw new Error('The WSL upgrade has not returned a working accelerated engine. Check the progress above; if Windows requested a restart, restart Windows and reopen BookForge.');
  } catch (error) {
    say('failed', (error as Error).message);
    throw error;
  }
}
