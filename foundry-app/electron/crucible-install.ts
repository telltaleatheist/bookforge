/** The installer and its native/WSL decisions belong to Crucible. */
import {
  BOOTSTRAP_VERSION, hostInstallCommand, install, processRunner, startLocal,
  type Runner,
} from '@crucible/bootstrap';
import { addLocalCrucible, probeCrucible } from './crucible-registry';
import { hosted } from './host';
import { probeSystem } from './system-probe';
import type { CrucibleInstallPlan, CrucibleInstallStep, InstallPlatform } from '../shared/slots';

export function installationSteps(platform: InstallPlatform): CrucibleInstallStep[] {
  if (platform === 'other') return [];
  return [{
    title: 'Install Crucible',
    detail: platform === 'win32'
      ? 'Crucible installs its native Windows engine and the tray that manages it. WSL is an optional upgrade in Crucible.'
      : 'Crucible installs its runtime, service and desktop controls. Models are prepared after you choose where work runs.',
    command: platform === 'win32' ? hostInstallCommand(BOOTSTRAP_VERSION) : null,
    done: false,
  }, {
    title: 'Connect Foundry',
    detail: 'Verify the service, then read the connection Crucible publishes on this computer.',
    command: null, done: false,
  }];
}

export async function crucibleInstallPlan(): Promise<CrucibleInstallPlan> {
  const platform: InstallPlatform = ['win32', 'darwin', 'linux'].includes(process.platform)
    ? process.platform as InstallPlatform : 'other';
  return {
    platform, wsl: null, machine: (await probeSystem()).detail,
    steps: installationSteps(platform), elevated: [],
    readme: 'https://github.com/telltaleatheist/crucible',
    driven: platform !== 'other' && !hosted(),
    drivenWhy: hosted() ? 'Install Crucible from BookForge.'
      : platform === 'other' ? 'Crucible does not support this platform.' : '',
  };
}

let installing = false;

export async function driveCrucibleInstall(
  onLine: (line: string) => void,
  runner: Runner = processRunner(),
): Promise<void> {
  if (hosted()) throw new Error('Install Crucible from BookForge.');
  if (installing) throw new Error('A Crucible installation is already running.');
  installing = true;
  try {
    if (runner.platform === 'win32') {
      onLine('Installing the native Windows engine and its tray…');
      const result = await runner.stream([
        'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; " + hostInstallCommand(BOOTSTRAP_VERSION),
      ], { timeoutMs: 3_600_000, onLine: (line) => onLine(line) });
      if (result.failure !== null || result.code !== 0) {
        throw new Error(result.failure ?? `Crucible installer exited ${result.code}: ${result.stderr.trim()}`);
      }
    } else if (runner.platform === 'darwin' || runner.platform === 'linux') {
      await install({
        release: BOOTSTRAP_VERSION, jobTypes: ['echo'],
        onLine: (line, _stream, step) => onLine(`${step}: ${line}`),
      }, runner);
    } else {
      throw new Error('Crucible does not support this platform.');
    }
    onLine('Verifying Crucible…');
    const status = await startLocal({}, runner);
    if (status.state !== 'running') throw new Error(status.detail);
    const connected = await addLocalCrucible('');
    if (connected.outcome !== 'added') {
      if (connected.code !== 'already_registered') throw new Error(connected.message);
      /*
       * ALREADY REGISTERED IS NOT A FAILURE and is not verified either: that arm
       * carries no server name, because nothing was added to name. The row it is
       * talking about was checked when it was added and is checked again by the
       * Servers card's own Test, which is where somebody looking at a suspicious
       * engine goes.
       */
    } else {
      await verifyInstalled(status.name, connected.serverName, onLine);
    }
    onLine('Crucible is running and connected.');
  } finally {
    installing = false;
  }
}

/**
 * IS THE ENGINE ANSWERING THE ENGINE WE JUST INSTALLED?
 *
 * ── The distinction, which is not pedantry ────────────────────────────────
 *
 * Everything above proves the installer exited 0 and that SOMETHING is serving
 * on the address Crucible published here. Neither of those is the thing worth
 * knowing. A machine can already be running an engine — somebody else's, an
 * older one, one reached through a tray that points into WSL — and the steps
 * above would report a clean install while the row that got registered belongs
 * to a different process than the one the installer built.
 *
 * bookforge-02, 2026-09-17, having built this first and offering it verbatim:
 * it is *"the difference between 'the installer exited 0' and 'the engine
 * answering is the engine we installed'."* Foundry had the first half only.
 *
 * ── THREE COMPARISONS, AND WHY EACH IS A DIFFERENT QUESTION ───────────────
 *
 *   1. **The installation record against the pairing file.** `startLocal` reads
 *      what Crucible installed here; `addLocalCrucible` reads the connection
 *      Crucible published here. They are two files written by one installer, and
 *      disagreeing means the published connection is not this installation's.
 *   2. **The pairing file against the engine that answers it.** A name in a file
 *      is a claim. `info().server.name` is the process on the socket saying what
 *      it is, and this is the only one of the three that involves the running
 *      engine at all.
 *   3. **The backend against the kinds this build knows.** Not an identity
 *      check — a vocabulary one. An engine reporting something outside the set
 *      is newer than this app, which is a fact worth naming rather than a
 *      failure to swallow.
 *
 * NONE OF THEM IS FATAL TO THE INSTALL, and that is deliberate: the engine IS
 * installed and IS registered by the time this runs, so throwing would report a
 * completed install as a failure and leave a working row behind a refusal. Each
 * mismatch is said on the installer's own line feed, where somebody watching
 * will see it, and the log keeps it.
 */
async function verifyInstalled(
  installedName: string | null,
  registeredName: string,
  onLine: (line: string) => void,
): Promise<void> {
  if (installedName !== null && installedName !== registeredName) {
    onLine(
      `Note: Crucible installed an engine calling itself "${installedName}", but the connection `
      + `published on this computer names "${registeredName}". Foundry registered the published `
      + 'one. If this machine runs more than one engine, check Settings › Crucible Servers.',
    );
  }
  const probe = await probeCrucible(registeredName);
  if (probe.outcome !== 'ok') {
    onLine(`Note: "${registeredName}" was registered but did not answer: ${probe.message}`);
    return;
  }
  if (probe.serverName !== registeredName) {
    onLine(
      `Note: the engine at that address calls itself "${probe.serverName}" rather than `
      + `"${registeredName}". The row is registered under the published name.`,
    );
  }
  /*
   * `none` IS A KIND AND NOT AN ABSENCE — PHASE15 §3.5's host mode, a Windows
   * machine with no WSL2, which has no accelerator and says so. Treating it as
   * unknown would warn about the one configuration this installer most often
   * produces on a fresh machine.
   */
  const KNOWN = ['cuda-linux', 'mlx-darwin', 'llama-windows', 'none'];
  if (!KNOWN.includes(probe.backend)) {
    onLine(
      `Note: this engine reports a backend this version of Foundry does not know `
      + `("${probe.backend}"). It is registered and should work; Foundry may be older than `
      + 'the Crucible now on this computer.',
    );
  }
}
