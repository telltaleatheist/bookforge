/**
 * code-updater — the in-app half of the app self-update flow.
 *
 * Runs inside "BookForge proper" (it has the download infra + will own the update UI). It does
 * NOT replace running code. It downloads a newer code bundle into userData/app/<version>/, verifies
 * its sha256, and sets the launcher pointer's `pendingVersion`. The launcher applies the flip on
 * the NEXT launch (stage-now / boot-next) — see launcher/bootstrap.ts.
 *
 * Trust: there is no code signing; the manifest's sha256 (served over HTTPS) is the integrity
 * anchor, verified by downloadAndExtract() before the bundle is trusted.
 *
 * Version semantics in the launcher model:
 *   - launcher version  = app.getVersion() (baked into the .app at build time)
 *   - current code ver  = the booted bundle = readPointer().version
 */

import { app } from 'electron';
import * as fs from 'fs';
import {
  readPointer,
  writePointer,
  bundleDir,
  bundleIsComplete,
  linkBundleNodeModules,
} from '../launcher/boot-state';
import { downloadAndExtract } from '../components/downloader';
import type { InstallProgress, Platform, Arch } from '../components/component-types';
import { getManifest } from './remote-manifest';
import { gt, satisfies } from './semver';

export type CodeUpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'staged' // downloaded + verified; will apply on next launch
  | 'up-to-date'
  | 'incompatible' // newer code exists but needs a newer launcher
  | 'error';

export interface CodeUpdateStatus {
  state: CodeUpdateState;
  currentVersion: string | null;
  launcherVersion: string;
  availableVersion?: string;
  /** Set while state === 'downloading'. */
  progressPct?: number;
  /** Set when state === 'staged' — applies on next restart. */
  pendingVersion?: string;
  /** Set when state === 'incompatible'. */
  requiresLauncher?: string;
  error?: string;
  checkedAt?: number;
}

let status: CodeUpdateStatus = {
  state: 'idle',
  currentVersion: null,
  launcherVersion: app.getVersion(),
};

let inFlight: Promise<CodeUpdateStatus> | null = null;

export function getCodeUpdateStatus(): CodeUpdateStatus {
  return status;
}

/**
 * Check the manifest and, if a newer compatible code bundle exists, download + verify it and mark
 * it pending for the next launch. Safe to call in the background after startup. Concurrent calls
 * share one in-flight run.
 */
export function checkAndStageCodeUpdate(opts?: {
  onProgress?: (s: CodeUpdateStatus) => void;
  signal?: AbortSignal;
}): Promise<CodeUpdateStatus> {
  if (inFlight) return inFlight;
  inFlight = run(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(opts?: {
  onProgress?: (s: CodeUpdateStatus) => void;
  signal?: AbortSignal;
}): Promise<CodeUpdateStatus> {
  const emit = (next: Partial<CodeUpdateStatus>) => {
    status = { ...status, ...next };
    opts?.onProgress?.(status);
  };

  const launcherVersion = app.getVersion();
  const pointer = readPointer();
  const currentVersion = pointer?.version ?? null;
  emit({ state: 'checking', currentVersion, launcherVersion, error: undefined });

  try {
    const manifest = await getManifest(true);
    if (!manifest.code?.version || !manifest.code?.url) {
      emit({ state: 'up-to-date' });
      return status;
    }
    const available = manifest.code.version;
    emit({ availableVersion: available, checkedAt: Date.now() });

    // Not newer than what we're running? Done. (currentVersion null = dev/no launcher; skip.)
    if (!currentVersion || !gt(available, currentVersion)) {
      emit({ state: 'up-to-date' });
      return status;
    }

    // Newer, but does it need a launcher we don't have? The user must re-download the launcher.
    if (!satisfies(launcherVersion, manifest.code.minLauncher)) {
      emit({ state: 'incompatible', requiresLauncher: manifest.code.minLauncher });
      return status;
    }

    // Already downloaded on a prior run? Just (re)mark it pending.
    if (bundleIsComplete(available)) {
      markPending(available);
      emit({ state: 'staged', pendingVersion: available });
      return status;
    }

    // Download + verify into a staging dir, then atomically rename into the version folder so a
    // crash mid-download never leaves a partial bundle that looks complete.
    emit({ state: 'downloading', progressPct: 0 });
    const finalDir = bundleDir(available);
    const staging = finalDir + '.downloading';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const artifact = {
      platform: process.platform as Platform,
      arch: process.arch as Arch,
      url: manifest.code.url,
      sha256: manifest.code.sha256,
      bytes: manifest.code.bytes,
    };

    await downloadAndExtract(
      artifact,
      staging,
      (p: InstallProgress) => emit({ progressPct: Math.round(p.pct) }),
      opts?.signal
    );

    // The bundle's main must exist at <dir>/dist/electron/main.js for it to be bootable.
    if (!fs.existsSync(`${staging}/dist/electron/main.js`)) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error('Downloaded code bundle is missing dist/electron/main.js');
    }

    // A downloaded bundle is pure JS with no node_modules; link it to the launcher's real-disk copy
    // so ESM import() (mupdf, …) resolves — same as the seed path does. (CJS uses NODE_PATH.)
    linkBundleNodeModules(staging);

    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);

    markPending(available);
    emit({ state: 'staged', pendingVersion: available, progressPct: 100 });
    return status;
  } catch (err) {
    emit({ state: 'error', error: (err as Error).message });
    return status;
  }
}

/** Record the staged version on the launcher pointer so the next launch flips to it. */
function markPending(version: string): void {
  const pointer = readPointer();
  if (!pointer) return; // dev / no launcher — nothing to flip
  writePointer({ ...pointer, pendingVersion: version });
}
