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

/**
 * THE HEARTBEAT GIVES UP ONCE — the regression test for the 10-hour loop
 * measured on 2026-09-18: 264 × (404 `unknown_lease` heartbeat → 409 re-lease
 * refused) at a flat 40.0 s cadence, on a run that had ended long before.
 *
 * `unknown_lease` used to be read as "the server restarted", and a restart is
 * the one reading under which re-leasing can work. It is also not what happened:
 * the lease had been RELEASED, and a re-lease of a model nothing is holding can
 * only ever be refused. So the assertion is that a refusal of the RE-LEASE ends
 * the timer rather than arming the next identical attempt — and that it says so
 * once, because a run left unprotected in silence is what made this invisible in
 * the first place.
 */
test('a heartbeat whose re-lease is refused stops beating and says the run is unprotected', async () => {
  let beat!: () => void;
  spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    beat = callback;
    return { unref() {} };
  }) as typeof setInterval);
  const cleared = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  let acquisitions = 0;
  const client = {
    lease: mock(async () => {
      if (++acquisitions === 1) return { leaseId: 'the-one-it-forgot' };
      throw new CrucibleRefused(409, 'not_resident', 'dots-ocr is not resident here', null);
    }),
    heartbeat: mock(async () => {
      throw new CrucibleRefused(404, 'unknown_lease', 'this server has no lease the-one-it-forgot', null);
    }),
    release: mock(async (_id: string) => {}),
  };
  spyOn(registry, 'clientFor').mockReturnValue(client as never);
  const said: string[] = [];
  spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { said.push(parts.join(' ')); });
  await dispatch.takeLease({
    name: 'test', url: 'http://127.0.0.1:1', token: 'test', enabled: true,
  }, 'dots-ocr', 'pages');
  beat();
  await flush();
  expect(client.heartbeat).toHaveBeenCalledTimes(1);
  expect(client.lease).toHaveBeenCalledTimes(2);
  expect(cleared).toHaveBeenCalled();
  // AND THE CALLBACK ITSELF IS DEAD, which is the half `clearInterval` cannot
  // prove here: this suite hands the timer out as a function, so the loop that
  // was measured would run again on the next tick whatever the clock was told.
  beat();
  await flush();
  expect(client.heartbeat).toHaveBeenCalledTimes(1);
  expect(client.lease).toHaveBeenCalledTimes(2);
  // ONE LINE, and it names the server's own refusal and what the run has lost.
  expect(said).toHaveLength(1);
  expect(said[0]).toContain('not_resident');
  expect(said[0]).toContain('dots-ocr is not resident here');
  expect(said[0]).toContain('UNPROTECTED');
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
      /*
       * `extra` IS ALWAYS ON A `done` FRAME — the SDK carries every key the job
       * type put there verbatim and `{}` is the true answer to "what else was on
       * the frame", never an absence. This one is empty because this fixture's
       * server leases nothing on the load, which is what keeps the separate
       * `client.lease` below under test.
       */
      events: async function* () { yield { event: 'done', data: { extra: {} } }; },
      lease: mock(async () => ({ leaseId: 'native-lease' })),
      release: mock(async () => {}),
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
      // THE LEASE RIDES ON THE LOAD (Crucible 1.0.13) — the act and the ttl both.
      expect(client.loadModel).toHaveBeenCalledWith(model, {
        lease: { act: capability, ttlSeconds: expect.any(Number) },
      });
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
