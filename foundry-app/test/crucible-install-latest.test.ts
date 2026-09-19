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
 * A RUN THAT NARRATES INTO NOTHING.
 *
 * `driveCrucibleInstall` reports into three sinks now (PHASE19 §3.1's rows,
 * the orchestrator's own event stream, and the one-shot that finishes the
 * Windows engine row). None of these tests is about what it SAYS, so all three
 * are drains — and they are spelled out rather than cast, so adding a fourth
 * sink breaks here loudly instead of arriving as `undefined is not a function`
 * halfway through a run.
 */
const silent = (): import('../electron/crucible-install').InstallNarration => ({
  event: () => {}, hostEvent: () => {}, windowsEngineUp: () => {},
});


/**
 * A runner that FAILS THE TEST IF IT IS ASKED TO DO ANYTHING.
 *
 * The gate's value is that it happens before a machine is touched, so a refusal
 * that spawned PowerShell and then refused would not be the thing being tested.
 */
const refusingRunner = (): bootstrap.Runner => ({
  platform: 'win32',
  /*
   * LOCALAPPDATA IS SET BECAUSE THE SDK NOW ASKS (PHASE19 §2.6). `install()`
   * on win32 tests for the host pack under `%LOCALAPPDATA%\\Crucible` before it
   * does anything else, and a runner with no environment refuses
   * `host_unresponsive` there — which would pass this test for the wrong
   * reason, since the point is that the CHANNEL gate refuses BEFORE any of
   * that.
   */
  env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
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
  const refused = installer.driveCrucibleInstall(silent(), refusingRunner(), sources('1.0.1', '1.0.2'));
  await expect(refused).rejects.toThrow(/install_older_than_running/);
  await refused.catch((err: { code?: string; message: string }) => {
    expect(err.code).toBe('install_older_than_running');
    expect(err.message).toContain('1.0.1');
    expect(err.message).toContain('1.0.2');
  });
});

test('a channel equal to the running engine says there is nothing to install, by name', async () => {
  const refused = installer.driveCrucibleInstall(silent(), refusingRunner(), sources('1.0.2', '1.0.2'));
  await expect(refused).rejects.toThrow(/crucible_already_latest/);
  await refused.catch((err: { code?: string }) => expect(err.code).toBe('crucible_already_latest'));
});

/**
 * A WINDOWS MACHINE WITH NO HOST PACK, whose installer exits non-zero.
 *
 * `install()` on win32 fetches and runs `install.ps1` when the pack is absent
 * (PHASE19 §2.6) and refuses `host_not_installed` when it fails — so stopping
 * the installer is how these two tests read the release WITHOUT letting the
 * run go on to watch a move that does not exist. The script the SDK composes
 * carries the release twice: in the asset URL it downloads and in the
 * `-Release` switch it passes.
 */
const stoppedInstaller = (): { runner: bootstrap.Runner; asked: string[] } => {
  const asked: string[] = [];
  const runner = { ...refusingRunner(),
    fileExists: () => false,
    stream: async (argv: readonly string[]) => {
      asked.push(String(argv.at(-1)));
      return { code: 9, failure: null, stdout: '', stderr: 'stopped here on purpose' };
    } } as unknown as bootstrap.Runner;
  return { runner, asked };
};

test('a channel newer than the running engine installs the CHANNEL\'s release, not the vendored one', async () => {
  const { runner, asked } = stoppedInstaller();
  await expect(installer.driveCrucibleInstall(silent(), runner, sources('1.0.3', '1.0.2')))
    .rejects.toMatchObject({ code: 'host_not_installed' });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('v1.0.3');
  // THE VENDORED LIBRARY'S OWN NUMBER IS NOT WHAT A MACHINE GETS (§6.5.2).
  expect(asked[0]).not.toContain(`v${bootstrap.BOOTSTRAP_VERSION}`);
});

test('a machine with no Crucible installs the channel\'s latest', async () => {
  const { runner, asked } = stoppedInstaller();
  await expect(installer.driveCrucibleInstall(silent(), runner, sources('1.0.3', null)))
    .rejects.toMatchObject({ code: 'host_not_installed' });
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

/*
 * ── THIS ASSERTION WAS INVERTED BY PHASE19 §0, ON PURPOSE ─────────────────
 *
 * It used to read `expect(first?.command).toContain('releases/latest/download/
 * install.ps1')` — the channel's line, with no version baked into it, which
 * was the right shape for a door that printed a command to copy. There is no
 * such door: *"Nobody is ever shown a command … A command a person could run
 * is a step the app should be running."* So the same fact is now checked from
 * the other side, and the version clause it carried is checked where the
 * version is actually used — `hostInstallCommand(release)` in the run below,
 * which `crucible-lifecycle.test.ts` pins against the CHANNEL's release.
 */
test('no step a person is shown carries a command, on any platform', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const steps = installer.installationSteps(platform);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.command).toBeNull();
      // And no step NAMES an installer either: the door is a progress list of
      // what is happening, not a manual for Crucible's own front door.
      expect(`${step.title} ${step.detail}`).not.toContain('install.ps1');
      expect(`${step.title} ${step.detail}`).not.toContain('install.sh');
    }
  }
  // The copyable constant is gone from the module, not merely unreferenced.
  expect(Object.keys(installer)).not.toContain('CRUCIBLE_LATEST_PS1');
  expect(JSON.stringify(installer.installationSteps('win32')))
    .not.toContain(bootstrap.BOOTSTRAP_VERSION);
});

/*
 * §3.1's ROWS, IN ITS ORDER, and the platform decides which exist. The reducer
 * matches `id` and never a label, so this is the one place the two lists are
 * compared — a row added to the wire with no label here would draw nothing.
 */
test('the progress list is PHASE19 3.1, and Windows is the only platform with a move', () => {
  expect(installer.installationSteps('win32').map((step) => step.id))
    .toEqual(['install', 'windows-engine', 'linux-engine', 'job-types', 'models']);
  expect(installer.installationSteps('darwin').map((step) => step.id))
    .toEqual(['install', 'job-types', 'models']);
  expect(installer.installationSteps('other')).toEqual([]);
});
