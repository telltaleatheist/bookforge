/** The installer and its native/WSL decisions belong to Crucible. */
import {
  BOOTSTRAP_VERSION, hostInstallCommand, install, processRunner, startLocal,
  type Runner,
} from '@crucible/bootstrap';
import { addLocalCrucible } from './crucible-registry';
import { hosted } from './host';
import { probeSystem } from './system-probe';
import type { CrucibleInstallPlan, CrucibleInstallStep, InstallPlatform } from '../shared/slots';

export function installationSteps(platform: InstallPlatform): CrucibleInstallStep[] {
  if (platform === 'other') return [];
  return [{
    title: 'Install Crucible',
    detail: platform === 'win32'
      ? 'Crucible installs its native Windows engine and the tray that manages it. WSL is an optional upgrade in Crucible.'
      : 'Crucible installs its runtime, service and desktop controls. Foundry asks for text and page reading.',
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
        release: BOOTSTRAP_VERSION, jobTypes: ['llm'],
        onLine: (line, _stream, step) => onLine(`${step}: ${line}`),
      }, runner);
    } else {
      throw new Error('Crucible does not support this platform.');
    }
    onLine('Verifying Crucible…');
    const status = await startLocal({}, runner);
    if (status.state !== 'running') throw new Error(status.detail);
    const connected = await addLocalCrucible('');
    if (connected.outcome !== 'added' && connected.code !== 'already_registered') {
      throw new Error(connected.message);
    }
    onLine('Crucible is running and connected.');
  } finally {
    installing = false;
  }
}
