/**
 * Foundry installs the LATEST Crucible, and never one older than the engine
 * already running on this computer.
 *
 * Owen, 2026-09-18: *"It shouldn't install an older Crucible. Maybe it should
 * pull 'latest' and latest should be the latest build. Like how WordPress does
 * it."*
 *
 * Foundry vendored `@crucible/bootstrap` 1.0.0 and handed that number to
 * `install()` as the release to install, against a machine whose server was
 * already 1.0.2 — so Set up took the engine BookForge shares back two versions
 * and said nothing. crucible `docs/INSTALL-UNINSTALL.md` §6.5 is the shape this
 * holds: the release channel owns "latest", the app asks `GET /v1/info` first,
 * and a channel older than what runs is a refusal by name with nothing spawned.
 */
import { expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-install-latest-test', name),
    getName: () => 'Foundry', getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir), isPackaged: false,
    on: () => {}, whenReady: async () => {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {}, net: {}, protocol: {}, session: {}, shell: {},
}));

const bootstrap = await import('@crucible/bootstrap');
const installer = await import('../electron/crucible-install');

/** A channel and a running engine, both scripted. Nothing here reaches a network. */
const sources = (latest: string, running: string | null) => ({
  latest: async () => latest,
  running: async () => running,
});

/**
 * A runner that FAILS THE TEST IF IT IS ASKED TO DO ANYTHING.
 *
 * The gate's value is that it happens before a machine is touched, so a refusal
 * that spawned PowerShell and then refused would not be the thing being tested.
 */
const refusingRunner = (): bootstrap.Runner => ({
  platform: 'win32',
  env: {},
  homedir: 'C:\\Users\\t',
  run: async (argv) => { throw new Error(`nothing must be run: ${JSON.stringify(argv)}`); },
  stream: async (argv) => { throw new Error(`nothing must be spawned: ${JSON.stringify(argv)}`); },
  fileExists: () => { throw new Error('nothing must be read'); },
  readFile: () => { throw new Error('nothing must be read'); },
  realpathNative: (p: string) => p,
});

test('the channel pointer is the PROMOTED release, built from the package\'s own repository slug', () => {
  expect(installer.CRUCIBLE_CHANNEL_URL)
    .toBe(`https://api.github.com/repos/${bootstrap.RELEASE_REPO}/releases/latest`);
  // `releases?per_page=1` is the newest TAG, which between a cut and its
  // promotion is the candidate promote_release.py exists to hold back.
  expect(installer.CRUCIBLE_CHANNEL_URL).not.toContain('per_page');
});

test('a channel older than the running engine refuses by name and spawns nothing', async () => {
  const refused = installer.driveCrucibleInstall(() => {}, refusingRunner(), sources('1.0.1', '1.0.2'));
  await expect(refused).rejects.toThrow(/install_older_than_running/);
  await refused.catch((err: { code?: string; message: string }) => {
    expect(err.code).toBe('install_older_than_running');
    expect(err.message).toContain('1.0.1');
    expect(err.message).toContain('1.0.2');
  });
});

test('a channel equal to the running engine says there is nothing to install, by name', async () => {
  const refused = installer.driveCrucibleInstall(() => {}, refusingRunner(), sources('1.0.2', '1.0.2'));
  await expect(refused).rejects.toThrow(/crucible_already_latest/);
  await refused.catch((err: { code?: string }) => expect(err.code).toBe('crucible_already_latest'));
});

test('a channel newer than the running engine installs the CHANNEL\'s release, not the vendored one', async () => {
  const asked: string[] = [];
  const runner = { ...refusingRunner(),
    stream: async (argv: readonly string[]) => {
      asked.push(String(argv.at(-1)));
      return { code: 9, failure: null, stdout: '', stderr: 'stopped here on purpose' };
    } } as unknown as bootstrap.Runner;
  await expect(installer.driveCrucibleInstall(() => {}, runner, sources('1.0.3', '1.0.2')))
    .rejects.toThrow(/stopped here on purpose/);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('v1.0.3');
  expect(asked[0]).not.toContain(`v${bootstrap.BOOTSTRAP_VERSION}`);
});

test('a machine with no Crucible installs the channel\'s latest', async () => {
  const asked: string[] = [];
  const runner = { ...refusingRunner(),
    stream: async (argv: readonly string[]) => {
      asked.push(String(argv.at(-1)));
      return { code: 9, failure: null, stdout: '', stderr: 'stopped here on purpose' };
    } } as unknown as bootstrap.Runner;
  await expect(installer.driveCrucibleInstall(() => {}, runner, sources('1.0.3', null)))
    .rejects.toThrow(/stopped here on purpose/);
  expect(asked[0]).toContain('v1.0.3');
});

test('an unreadable channel is refused by name; there is no vendored fallback', async () => {
  for (const [body, status] of [['<html>404</html>', 200], ['{}', 200], ['{"tag_name":"nightly"}', 200], ['{}', 403]] as const) {
    const fetchImpl = (async () => new Response(body, { status })) as typeof fetch;
    const refused = installer.crucibleChannelLatest(fetchImpl);
    await expect(refused).rejects.toThrow(/release_channel_unreadable/);
  }
  const ok = (async () => new Response('{"tag_name":"v1.0.2"}')) as typeof fetch;
  expect(await installer.crucibleChannelLatest(ok)).toBe('1.0.2');

  const offline = (async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }) as typeof fetch;
  await expect(installer.crucibleChannelLatest(offline)).rejects.toThrow(/ENOTFOUND/);
});

test('releases order by their three numbers, so 1.0.10 is newer than 1.0.2', () => {
  expect(installer.compareCrucibleVersions('1.0.2', '1.0.10')).toBeLessThan(0);
  expect(installer.compareCrucibleVersions('1.0.2', '1.0.2')).toBe(0);
  expect(installer.compareCrucibleVersions('1.0.3', '1.0.2')).toBeGreaterThan(0);
  expect(installer.compareCrucibleVersions('v1.0.2', '1.0.2')).toBe(0);
  expect(() => installer.compareCrucibleVersions('nightly', '1.0.2')).toThrow(/release_channel_unreadable/);
});

test('the step a person is shown names the channel, and no version at all', () => {
  const [first] = installer.installationSteps('win32');
  expect(first?.command).toContain('releases/latest/download/install.ps1');
  // A baked version in the line somebody copies is the same defect one layer
  // out: the copy would still be right on the day it was written and wrong
  // every day after.
  expect(first?.command).not.toContain(bootstrap.BOOTSTRAP_VERSION);
});
