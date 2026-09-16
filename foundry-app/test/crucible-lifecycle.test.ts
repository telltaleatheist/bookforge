import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-lifecycle-test', name),
    getName: () => 'Foundry', getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir), isPackaged: false,
    on: () => {}, whenReady: async () => {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {}, net: {}, protocol: {}, session: {}, shell: {},
}));

const bootstrap = await import('@crucible/bootstrap');
const host = await import('../electron/host');
const pairing = await import('../electron/crucible-pairing');
const registry = await import('../electron/crucible-registry');
const settings = await import('../electron/app-settings');
const start = await import('../electron/crucible-start');
const installer = await import('../electron/crucible-install');
const uninstall = await import('../electron/crucible-uninstall');
afterEach(() => mock.restore());

const status = (state: bootstrap.LocalStatus['state']): bootstrap.LocalStatus => ({
  schema_version: 1, state, name: 'local', url: 'http://127.0.0.1:9191', detail: `status: ${state}`,
});

test('local lifecycle preserves absent, stopped and damaged distinctions', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  for (const state of ['absent', 'stopped', 'running', 'broken', 'wrong_service', 'unauthorized'] as const) {
    spyOn(bootstrap, 'localStatus').mockResolvedValue(status(state));
    expect((await start.crucibleRunState()).kind)
      .toBe(['absent', 'stopped', 'running'].includes(state) ? state : 'problem');
  }
  spyOn(bootstrap, 'localStatus').mockRejectedValue(new Error('invalid installation record'));
  expect(await start.crucibleRunState()).toEqual({ kind: 'problem', why: 'invalid installation record' });
});

test('hosted Foundry never controls the local service', async () => {
  spyOn(host, 'hosted').mockReturnValue(true);
  const control = spyOn(bootstrap, 'startLocal');
  expect(await start.crucibleRunState()).toEqual({ kind: 'not-ours' });
  expect((await start.startCrucible()).started).toBe(false);
  expect(control).not.toHaveBeenCalled();
});

test('Windows installation uses the native installer and refuses a second concurrent request', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  spyOn(bootstrap, 'startLocal').mockResolvedValue(status('running'));
  const posixInstall = spyOn(bootstrap, 'install');
  spyOn(registry, 'addLocalCrucible').mockResolvedValue({ outcome: 'added', servers: [],
    serverName: 'local', url: 'http://127.0.0.1:9191', configPath: 'published-pairing' });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const stream = mock(async () => {
    await pending;
    return { code: 0, stdout: '', stderr: '', failure: null };
  });
  const runner = { platform: 'win32', stream } as unknown as bootstrap.Runner;
  const first = installer.driveCrucibleInstall(() => {}, runner);
  await expect(installer.driveCrucibleInstall(() => {}, runner)).rejects.toThrow('already running');
  finish();
  await first;
  expect(posixInstall).not.toHaveBeenCalled();
  const argv = stream.mock.calls[0]![0] as unknown as string[];
  expect(argv[0]).toBe('powershell.exe');
  expect(argv.at(-1)).toContain(bootstrap.hostInstallCommand(bootstrap.BOOTSTRAP_VERSION));
  expect(argv.join(' ')).not.toContain('wsl.exe');
  expect(installer.installationSteps('win32')[0]!.detail).toContain('native Windows');
});

test('published local pairing refreshes a token without moving the preferred server', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  spyOn(pairing, 'pairingFileRead').mockResolvedValue({ found: 'pairing', path: 'pairing',
    pairing: { name: 'LOCAL', url: 'http://127.0.0.1:9191', token: 'new-token' } });
  const servers = [
    { name: 'local', url: 'http://127.0.0.1:9191', token: 'old', enabled: false },
    { name: 'remote', url: 'http://remote:7100', token: 'remote', enabled: true },
  ];
  spyOn(settings, 'readAppSettings').mockReturnValue({ crucibleServers: servers } as never);
  const write = spyOn(registry, 'addCrucibleServer').mockReturnValue([]);
  const result = await registry.addLocalCrucible('');
  expect(result.outcome).toBe('added');
  expect(write).toHaveBeenCalledWith('local', 'http://127.0.0.1:9191', 'new-token');
});

test('first-run empty registry automatically adopts the SDK-published local connection', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  spyOn(pairing, 'pairingFileRead').mockResolvedValue({ found: 'pairing', path: 'published/pairing',
    pairing: { name: 'My computer', url: 'http://127.0.0.1:9191', token: 'published-token' } });
  spyOn(settings, 'readAppSettings').mockReturnValue({ crucibleServers: [], cloudProviders: [] } as never);
  const write = spyOn(registry, 'writeCrucibleServers').mockReturnValue([]);
  const result = await registry.addLocalCrucible('');
  expect(result.outcome).toBe('added');
  expect(write).toHaveBeenCalledWith([
    { name: 'My computer', url: 'http://127.0.0.1:9191', token: 'published-token', enabled: true },
  ]);
  expect(JSON.stringify(result)).not.toContain('published-token');
});

test('refreshing a registered server preserves its rank, spelling and disabled state', () => {
  spyOn(registry, 'crucibleServers').mockReturnValue([
    { name: 'local', url: 'http://127.0.0.1:9191', token: 'old', enabled: false },
    { name: 'remote', url: 'http://remote:7100', token: 'remote', enabled: true },
  ]);
  const write = spyOn(registry, 'writeCrucibleServers').mockReturnValue([]);
  registry.addCrucibleServer('LOCAL', 'http://127.0.0.1:9191', 'new-token');
  expect(write.mock.calls[0]![0]).toEqual([
    { name: 'local', url: 'http://127.0.0.1:9191', token: 'new-token', enabled: false },
    { name: 'remote', url: 'http://remote:7100', token: null, enabled: true },
  ]);
});

test('uninstall preview runs the published custom installation command without purge flags', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  spyOn(bootstrap, 'readLocalInstallation').mockReturnValue({ platform: 'win32' } as never);
  spyOn(pairing, 'pairingFileRead').mockResolvedValue({ found: 'absent', path: 'custom/pairing' });
  const command = {
    argv: ['C:\\custom\\python.exe', '-m', 'crucible', 'uninstall', '--json', '--dry-run'],
    env: { CRUCIBLE_HOME: 'C:\\custom' }, cwd: 'C:\\custom', platform: 'win32' as const,
  };
  const build = spyOn(bootstrap, 'localUninstallCommand').mockReturnValue(command);
  const run = mock(async () => ({ code: 0, failure: null, stderr: '', stdout: JSON.stringify({
    dry_run: true, home: 'C:\\custom', platform: 'win32', mechanism: 'host', backend_kind: null,
    purge_weights: false, wsl_too: false, steps: [], kept: { weights_bytes: 12, paths: ['models'] },
    removed_bytes: 0, ok: true,
  }) }));
  spyOn(bootstrap, 'processRunner').mockReturnValue({ run } as never);
  const result = await uninstall.crucibleUninstallDryRun({ purgeWeights: false, wslToo: false });
  expect(result.dryRun).toBe(true);
  expect(result.kept.weightsBytes).toBe(12);
  expect(build).toHaveBeenCalledWith({ dryRun: true, purgeWeights: false, wslToo: false });
  expect(run.mock.calls[0]).toEqual([command.argv, {
    timeoutMs: 120_000, env: command.env, cwd: command.cwd,
  }]);
});


test('native Windows setup restores the engine even when all model weights survived reinstall', async () => {
  const { missingForFoundry } = await import('../electron/crucible-coordinate');
  const classes = ['clean', 'translate', 'simplify', 'analysis', 'pages'];
  const record = {
    backendKind: 'llama-windows', totalBytes: 24e9, desktopAllowanceBytes: 2e9,
    classes: classes.map(capability => ({ capability, enabled: true,
      selected: capability === 'pages' ? 'dots-ocr' : 'qwen3.5-9b',
      reason: 'native Windows', shortfallBytes: 0, route: 'local' as const })),
  };
  const row = (kind: 'model' | 'engine', id: string, installed: boolean) => ({
    kind, id, name: id, jobType: 'llm', installed, installedBytes: installed ? 1 : null,
    expectedBytes: 1, floors: [], license: null, source: 'fixture', resident: false,
  });
  const catalog = [row('model', 'dots-ocr', true), row('model', 'qwen3.5-9b', true),
    row('engine', 'llama-cpp', false)];
  const missing = missingForFoundry(['llm'], catalog, record);
  expect(missing.unmet).toEqual([]);
  expect(missing.missing).toEqual([{ what: 'subject', kind: 'engine', id: 'llama-cpp',
    name: 'llama-cpp', jobType: 'llm', expectedBytes: 1, inCatalog: true }]);
  expect(missingForFoundry(['llm'], catalog.map(r => ({ ...r, installed: true })), record).missing).toEqual([]);
});

test('upstream-only Foundry work does not install an unused native engine or weights', async () => {
  const { missingForFoundry } = await import('../electron/crucible-coordinate');
  const record = { backendKind: 'llama-windows', totalBytes: 1, desktopAllowanceBytes: 0,
    classes: ['clean', 'translate', 'simplify', 'analysis', 'pages'].map(capability => ({
      capability, enabled: capability !== 'pages', selected: capability === 'pages' ? '' : 'ollama/existing-model',
      reason: 'fixture', shortfallBytes: 0, route: 'upstream' as const,
    })) };
  const result = missingForFoundry(['llm'], [{ kind: 'engine', id: 'llama-cpp', name: 'llama.cpp',
    jobType: 'llm', installed: false, installedBytes: null, expectedBytes: 1,
    floors: [], license: null, source: 'fixture', resident: false }], record);
  expect(result.missing).toEqual([]);
  expect(result.unmet.map(row => row.class)).toEqual(['pages']);
});


test('first-run coordination waits until model choices are finished, including a dismissed wizard', async () => {
  const { coordinateServer } = await import('../electron/crucible-coordinate');
  const setup = await import('../electron/setup');
  spyOn(host, 'foundryHost').mockReturnValue(null);
  const read = spyOn(settings, 'readAppSettings').mockReturnValue({
    setupCompleted: false, setupSkipped: [],
  } as never);
  const lookup = spyOn(registry, 'crucibleServerNamed').mockReturnValue(null);
  expect(await coordinateServer('first-run-gate')).toEqual({server: 'first-run-gate', phase: 'awaiting-setup'});
  expect(lookup).not.toHaveBeenCalled();
  read.mockReturnValue({setupCompleted: true, setupSkipped: ['routes']} as never);
  expect(setup.modelPreparationReady()).toBe(false);
  read.mockReturnValue({setupCompleted: true, setupSkipped: []} as never);
  expect(setup.modelPreparationReady()).toBe(true);
  expect((await coordinateServer('first-run-gate')).phase).toBe('unreachable');
  expect(lookup).toHaveBeenCalledWith('first-run-gate');
});

test('hosted Foundry honors the host first-run choices before preparing models', async () => {
  const setup = await import('../electron/setup');
  let ready = false;
  spyOn(host, 'foundryHost').mockReturnValue({modelPreparationReady: () => ready} as never);
  expect(setup.modelPreparationReady()).toBe(false);
  ready = true;
  expect(setup.modelPreparationReady()).toBe(true);
});


test('generated backend annotations filter preparation and never reach the module task API', async () => {
  const { foundryModuleForBackend } = await import('../electron/crucible-coordinate');
  const module = { name: 'fixture', version: '1', needs: [{ class: 'pages' }], subjects: [], job_types: [
    { type: 'llm', backends: ['llama-windows', 'cuda-linux'] },
    { type: 'asr', backends: ['cuda-linux'] },
    { type: 'tts', narrator_engine: 'higgs-v3', backends: ['cuda-linux'] },
  ] };
  expect(foundryModuleForBackend('llama-windows', module).job_types).toEqual([{ type: 'llm' }]);
  expect(foundryModuleForBackend('cuda-linux', module).job_types).toEqual([
    { type: 'llm' }, { type: 'asr' }, { type: 'tts', narrator_engine: 'higgs-v3' },
  ]);
  expect(JSON.stringify(foundryModuleForBackend('cuda-linux', module))).not.toContain('backends');
});


test('POSIX initial installation prepares only the lightweight core before model choices', async () => {
  spyOn(host, 'hosted').mockReturnValue(false);
  spyOn(bootstrap, 'startLocal').mockResolvedValue(status('running'));
  spyOn(registry, 'addLocalCrucible').mockResolvedValue({ outcome: 'added', servers: [],
    serverName: 'local', url: 'http://127.0.0.1:7100', configPath: 'pairing' });
  const install = spyOn(bootstrap, 'install').mockResolvedValue({} as never);
  await installer.driveCrucibleInstall(() => {}, { platform: 'darwin' } as bootstrap.Runner);
  expect(install.mock.calls[0]![0].jobTypes).toEqual(['echo']);
});

test('first-run completion persists only after readiness and resets its gate after failure', async () => {
  const setup = await import('../electron/setup');
  spyOn(host, 'foundryHost').mockReturnValue(null);
  spyOn(settings, 'readAppSettings').mockReturnValue({setupCompleted: false, setupSkipped: []} as never);
  const write = spyOn(settings, 'writeAppSettings').mockReturnValue({setupCompleted: true, setupSkipped: []} as never);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const completion = setup.finishPreparedSetup([], () => pending);
  expect(setup.modelPreparationReady()).toBe(true);
  expect(write).not.toHaveBeenCalled();
  release();
  await completion;
  expect(write).toHaveBeenCalledWith({setupCompleted: true, setupSkipped: []});
  write.mockClear();
  await expect(setup.finishPreparedSetup([], async () => { throw new Error('download failed'); })).rejects.toThrow('download failed');
  expect(write).not.toHaveBeenCalled();
  expect(setup.modelPreparationReady()).toBe(false);
});


test('readiness verifies current stock without posting again and rejects a disappeared runtime', async () => {
  const coordinate = await import('../electron/crucible-coordinate');
  const dispatch = await import('../electron/crucible-dispatch');
  const setup = await import('../electron/setup');
  spyOn(setup, 'modelPreparationReady').mockReturnValue(true);
  const entry = {name:'readiness-fixture',url:'http://fixture:7100',token:'fixture',enabled:true};
  spyOn(registry, 'crucibleServers').mockReturnValue([entry]);
  spyOn(registry, 'crucibleServerNamed').mockReturnValue(entry);
  const capability = {backendKind:'llama-windows',totalBytes:24e9,desktopAllowanceBytes:0,
    classes:['clean','translate','simplify','analysis','pages'].map(capability => ({capability,
      enabled:true,selected:'fixture-model',reason:'fixture',shortfallBytes:0,route:'local' as const}))};
  spyOn(dispatch, 'readCapability').mockResolvedValue(capability);
  const rows = [{kind:'model',id:'fixture-model',name:'fixture',jobType:'llm',installed:true,
    installedBytes:1,expectedBytes:1,floors:[],license:null,source:'fixture',resident:false}];
  const catalog = mock(async () => rows);
  const submitTask = mock(async () => 'should-not-post');
  spyOn(registry, 'engineClientFor').mockResolvedValue({info:async()=>({capabilities:[{jobType:'llm'}]}),
    catalog,submitTask} as never);
  expect((await coordinate.prepareFoundryForUse())[0]!.phase).toBe('stocked');
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(submitTask).not.toHaveBeenCalled();
  catalog.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.map(row=>({...row,installed:false})));
  await expect(coordinate.prepareFoundryForUse()).rejects.toThrow('still missing');
  expect(submitTask).not.toHaveBeenCalled();
});
