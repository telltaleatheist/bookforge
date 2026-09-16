import { expect, mock, test } from 'bun:test';
import type { CrucibleClient, TaskEvent } from '@crucible/client';
import { upgradeWindowsEngine } from '../electron/crucible-engine-upgrade';

const info = (backend: string) => ({ host: { backend }, server: { apiVersion: 1 } }) as Awaited<ReturnType<CrucibleClient['info']>>;
function client(backend: string, events: TaskEvent[]) {
  return {
    info: mock(async () => info(backend)),
    submitTask: mock(async () => 'upgrade-task'),
    async *taskEvents() { yield* events; },
  };
}

test('WSL upgrade is a remote task and re-resolves the engine after switching', async () => {
  const native = client('llama-windows', [{ id: 1, event: 'done', data: {} }]);
  const accelerated = client('cuda-linux', []);
  let calls = 0;
  const report = mock(() => {});
  const forget = mock(() => {});
  await upgradeWindowsEngine('PC', report, {
    client: async () => calls++ === 0 ? native : accelerated, forget,
    pause: async () => { throw new Error('ready engine must not wait'); },
  });
  expect(native.submitTask).toHaveBeenCalledWith({ type: 'engine', target: 'wsl' });
  expect(forget).toHaveBeenCalledTimes(1);
  expect(accelerated.info).toHaveBeenCalledTimes(1);
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({ server: 'PC', state: 'done' });
});

test('an explicit failed WSL task is not mistaken for a listener switch', async () => {
  const native = client('llama-windows', [{ id: 1, event: 'failed', data: { code: 'reboot_required', message: 'Restart Windows' } }]);
  const forget = mock(() => {});
  await expect(upgradeWindowsEngine('PC', () => {}, {
    client: async () => native, forget, pause: async () => {},
  })).rejects.toThrow('Restart Windows');
  expect(forget).not.toHaveBeenCalled();
});

test('a truncated stream requires a verified accelerated backend before success', async () => {
  const native = client('llama-windows', []);
  const report = mock(() => {});
  await expect(upgradeWindowsEngine('PC', report, {
    client: async () => native, forget: () => {}, pause: async () => {},
  })).rejects.toThrow('has not returned a working WSL engine');
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'failed' });
});

test('a non-Windows engine cannot receive a WSL setup task', async () => {
  const mac = client('mlx-darwin', []);
  await expect(upgradeWindowsEngine('Mac', () => {}, {
    client: async () => mac, forget: () => {}, pause: async () => {},
  })).rejects.toThrow('native Windows');
  expect(mac.submitTask).not.toHaveBeenCalled();
});
