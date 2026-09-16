import type { CrucibleClient } from '@crucible/client';
import type { EngineUpgradeProgress } from '../shared/engine-upgrade';

interface UpgradeDependencies {
  client(server: string): Promise<Pick<CrucibleClient, 'info' | 'submitTask' | 'taskEvents'>>;
  forget(): void;
  pause(): Promise<void>;
}

/** Submit a controller-owned task; never execute a local WSL command in Foundry. */
export async function upgradeWindowsEngine(
  server: string,
  report: (progress: EngineUpgradeProgress) => void,
  deps: UpgradeDependencies,
): Promise<void> {
  const say = (state: EngineUpgradeProgress['state'], message: string) => report({ server, state, message });
  try {
    const client = await deps.client(server);
    if ((await client.info()).host.backend !== 'llama-windows') {
      throw new Error('The optional WSL upgrade is available on a native Windows engine only.');
    }
    const taskId = await client.submitTask({ type: 'engine', target: 'wsl' });
    say('running', 'Preparing WSL acceleration. The engine manages downloads and any Windows permissions or restart requirements.');
    let failure: string | null = null;
    try {
      for await (const event of client.taskEvents(taskId)) {
        if (event.event === 'failed') { failure = `${event.data.code}: ${event.data.message}`; break; }
        if (event.event === 'cancelled') { failure = 'The WSL upgrade was cancelled.'; break; }
        if (event.event === 'step') say('running', event.data.name);
        if (event.event === 'unknown' && event.kind === 'state' && typeof event.data['sentence'] === 'string') {
          say('running', event.data['sentence']);
        }
        if (event.event === 'progress') {
          say('running', 'line' in event.data ? event.data.line
            : `${event.data.file}: ${(event.data.bytesDone / 1e6).toFixed(1)} MB downloaded`);
        }
        if (event.event === 'done') break;
      }
    } catch (error) {
      say('running', `The engine connection changed. Verifying WSL readiness: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failure !== null) throw new Error(failure);
    for (let attempt = 0; attempt < 30; attempt++) {
      deps.forget();
      try {
        // Re-resolve the registered front door after the controller switches engines.
        const info = await (await deps.client(server)).info();
        if (info.server.apiVersion === 1 && info.host.backend === 'cuda-linux') {
          say('done', 'WSL acceleration is ready. Preparing this engine for Foundry.');
          return;
        }
      } catch { /* The controller can be between listeners during its switch. */ }
      if (attempt < 29) await deps.pause();
    }
    throw new Error(`Setup task ${taskId} has not returned a working WSL engine. If Windows requested a restart, restart that computer and reconnect. Otherwise check the progress above.`);
  } catch (error) {
    say('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
