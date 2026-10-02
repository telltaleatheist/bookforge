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
      ? { verdict, placement: { ...dispatch.UNPLACED, session: { id: 'late', release } } }
      : verdict === 'wait'
        ? { verdict, reason: 'busy', standing: false }
        : { verdict, reason: 'refused' });
    /*
     * THE TYPED OUTCOME (PK6): a cancel is its own arm, carrying the settled row,
     * and it is the one thing a result type had to be able to say — a cancel filed
     * as a failure is how a host's retry restarts work a person just stopped.
     */
    const outcome = await result;
    expect(outcome.outcome).toBe('cancelled');
    expect(outcome.outcome === 'cancelled' && outcome.row.state).toBe('cancelled');
    expect(spawned).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(verdict === 'go' ? 1 : 0);
  });
}

test('cancelling while the session waits in the server\'s line leaves the line and spawns nothing', async () => {
  const entered = deferred<void>();
  const client = {
    models: async () => [{ id: 'test-model', resident: false }],
    session: mock(async (options: { signal?: AbortSignal }) => {
      entered.resolve();
      // The SDK takes a waiting session out of the line and throws the abort.
      await new Promise<void>((_done, fail) => {
        options.signal?.addEventListener('abort', () => fail(options.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    }),
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
  // The session was asked for with the model and the act, and the Stop's signal.
  expect(client.session).toHaveBeenCalledWith(expect.objectContaining({
    act: 'clean', model: 'test-model', signal: controller.signal,
  }));
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
    const closeSession = mock(async () => ({ reason: 'client', message: '', itemsRun: 0, heldS: 0 }));
    const client = {
      models: mock(async () => [{ id: model, resident: false }]),
      session: mock(async () => ({
        id: 'ses-native',
        touch: async () => {},
        close: closeSession,
        closed: new Promise(() => {}),
      })),
      activity: mock(async () => ({ chat: { maxInFlight: null, maxInFlightBasis: null } })),
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
      // ONE SESSION, opened with the selected model resident (Crucible 1.0.76).
      expect(client.session).toHaveBeenCalledWith(expect.objectContaining({ act: capability, model }));
      expect(result.placement.session?.id).toBe('ses-native');
      expect(result.placement.model).toBe(model);
      expect(result.placement.endpoint).toBe('http://windows-pc:7100/openai');
      expect(result.placement.door).toBe('openai');
      const headers = JSON.parse(result.placement.env['FOUNDRY_ENDPOINT_HEADERS']!);
      expect(headers['Authorization']).toBe('Bearer fixture-token');
      expect(headers['X-Crucible-Act']).toBe(capability);
      // This install's name, so the engine's chats are items of the session.
      expect(headers['X-Crucible-Client']).toBe(registry.CRUCIBLE_CLIENT_NAME);
    } finally { await result.placement.session?.release(); }
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
}
