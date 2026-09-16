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
