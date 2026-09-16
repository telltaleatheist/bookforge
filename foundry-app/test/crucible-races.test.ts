import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-crucible-races-test', name),
    getName: () => 'Foundry', getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir), isPackaged: false,
    on: () => {}, whenReady: async () => {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {}, net: {}, protocol: {}, session: {}, shell: {},
}));

const registry = await import('../electron/crucible-registry');
const dispatch = await import('../electron/crucible-dispatch');
const queue = await import('../electron/job-queue');
const engine = await import('../electron/engine');
const settings = await import('../electron/app-settings');
const { CrucibleRefused } = await import('@crucible/client');

afterEach(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((done) => setImmediate(done));

for (const verdict of ['go', 'wait', 'refuse'] as const) {
  test(`cancellation during placement preserves cancelled state after ${verdict}`, async () => {
    const entered = deferred<void>();
    const answer = deferred<dispatch.PlacementOutcome>();
    const release = mock(async () => {});
    const spawned = spyOn(engine, 'runEngine').mockImplementation(() => {
      throw new Error('a cancelled request must not spawn');
    });
    spyOn(dispatch, 'placeJob').mockImplementation(async () => {
      entered.resolve();
      return answer.promise;
    });
    const controller = new AbortController();
    const result = queue.runJob({
      kind: 'clean', inputPath: path.join(os.tmpdir(), 'cancel-race.epub'),
      recordsPath: path.join(os.tmpdir(), 'cancel-race.json'),
      stampPath: path.join(os.tmpdir(), 'cancel-race.stamp.json'),
      model: 'test', ollama: 'http://127.0.0.1:1', stepId: `race-${verdict}`,
    }, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    answer.resolve(verdict === 'go'
      ? { verdict, placement: { ...dispatch.UNPLACED, lease: { id: 'late', release } } }
      : verdict === 'wait'
        ? { verdict, reason: 'busy', standing: false }
        : { verdict, reason: 'refused' });
    expect((await result).state).toBe('cancelled');
    expect(spawned).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(verdict === 'go' ? 1 : 0);
  });
}

test('release racing lease replacement releases both receipts and serializes heartbeats', async () => {
  let beat!: () => void;
  spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    beat = callback;
    return { unref() {} };
  }) as typeof setInterval);
  spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const replacement = deferred<{ leaseId: string }>();
  let acquisitions = 0;
  const client = {
    lease: mock(async () => ++acquisitions === 1 ? { leaseId: 'old' } : replacement.promise),
    heartbeat: mock(async () => { throw new CrucibleRefused(404, 'unknown_lease', 'gone', null); }),
    release: mock(async (_id: string) => {}),
  };
  spyOn(registry, 'clientFor').mockReturnValue(client as never);
  const lease = await dispatch.takeLease({
    name: 'test', url: 'http://127.0.0.1:1', token: 'test', enabled: true,
  }, 'test', 'clean');
  beat();
  await flush();
  beat();
  expect(client.heartbeat).toHaveBeenCalledTimes(1);
  await lease.release();
  replacement.resolve({ leaseId: 'new' });
  await flush();
  expect(client.release.mock.calls.map(([id]) => id)).toEqual(['old', 'new']);
  await lease.release();
  expect(client.release).toHaveBeenCalledTimes(2);
});

test('cancelling during a Crucible model load cancels that server job and takes no lease', async () => {
  const entered = deferred<void>();
  const cancelled = deferred<void>();
  const client = {
    models: async () => [{ id: 'test-model', resident: false }],
    loadModel: async () => 'load-123',
    events: async function* () {
      entered.resolve();
      await cancelled.promise;
      yield { event: 'cancelled', data: {} };
    },
    cancel: mock(async (_id: string) => { cancelled.resolve(); }),
    lease: mock(async () => ({ leaseId: 'must-not-acquire' })),
    capability: async () => ({ backendKind: 'cuda', totalBytes: 1, classes: [{
      capability: 'clean', enabled: true, selected: 'test-model',
      reason: '', shortfallBytes: 0, route: 'local',
    }] }),
  };
  const entry = { name: 'test', url: 'http://127.0.0.1:1', token: 'test', enabled: true };
  spyOn(settings, 'readAppSettings').mockReturnValue({ queueGpuDial: 'any' } as never);
  spyOn(registry, 'slotAvailability').mockReturnValue({
    slots: [{ kind: 'crucible', name: 'test' }], refusal: null,
  } as never);
  spyOn(registry, 'engineSharedWith').mockImplementation((name) => name === 'tray-alias' ? 'test' : null);
  spyOn(registry, 'crucibleServerNamed').mockReturnValue(entry);
  spyOn(registry, 'resolveEngine').mockResolvedValue({ entry, hop: null });
  spyOn(registry, 'clientFor').mockReturnValue(client as never);
  spyOn(registry, 'engineClientFor').mockResolvedValue(client as never);
  const controller = new AbortController();
  const result = dispatch.placeJob('clean', 'tray-alias', () => {}, () => true, controller.signal);
  await entered.promise;
  controller.abort();
  expect((await result).verdict).toBe('wait');
  expect(client.cancel).toHaveBeenCalledWith('load-123');
  expect(client.lease).not.toHaveBeenCalled();
});


for (const [kind, capability, model] of [
  ['read', 'pages', 'dots-ocr'], ['clean', 'clean', 'qwen3.5-9b'],
  ['translate', 'translate', 'qwen3.8-27b-4bit'],
  ['simplify', 'simplify', 'qwen3.8-27b-4bit'],
  ['analysis', 'analysis', 'qwen3.8-27b-4bit'],
] as const) {
  test(`native Windows ${kind} uses its selected engine model through the controller registration`, async () => {
    const controller = { name: 'Windows', url: 'http://windows-pc:7101', token: 'fixture-token', enabled: true };
    const native = { ...controller, url: 'http://windows-pc:7100' };
    const client = {
      models: mock(async () => [{ id: model, resident: false }]),
      loadModel: mock(async () => 'load-native'),
      events: async function* () { yield { event: 'done', data: {} }; },
      lease: mock(async () => ({ leaseId: 'native-lease' })),
      release: mock(async () => {}),
      capability: async () => ({ backendKind: 'llama-windows', totalBytes: 24e9, classes: [{
        capability, enabled: true, selected: model, reason: 'native Windows', shortfallBytes: 0, route: 'local',
      }] }),
    };
    spyOn(settings, 'readAppSettings').mockReturnValue({ queueGpuDial: 'any' } as never);
    spyOn(registry, 'slotAvailability').mockReturnValue({ slots: [{ kind: 'crucible', name: 'Windows' }], refusal: null } as never);
    spyOn(registry, 'engineSharedWith').mockReturnValue(null);
    spyOn(registry, 'crucibleServerNamed').mockReturnValue(controller);
    spyOn(registry, 'resolveEngine').mockResolvedValue({ entry: native, hop: null });
    spyOn(registry, 'clientFor').mockReturnValue(client as never);
    spyOn(registry, 'engineClientFor').mockResolvedValue(client as never);
    const result = await dispatch.placeJob(kind, 'Windows', () => {}, () => true);
    expect(result.verdict).toBe('go');
    if (result.verdict !== 'go') throw Error('native route was refused');
    try {
      expect(client.loadModel).toHaveBeenCalledWith(model);
      expect(client.lease).toHaveBeenCalledWith(model, expect.objectContaining({ act: capability, ttlSeconds: expect.any(Number) }));
      expect(result.placement.model).toBe(model);
      expect(result.placement.endpoint).toBe('http://windows-pc:7100/openai');
      expect(result.placement.door).toBe('openai');
      const headers = JSON.parse(result.placement.env['FOUNDRY_ENDPOINT_HEADERS']!);
      expect(headers['Authorization']).toBe('Bearer fixture-token');
      expect(headers['X-Crucible-Act']).toBe(capability);
    } finally { await result.placement.lease?.release(); }
    expect(client.release).toHaveBeenCalledWith('native-lease');
  });
}
