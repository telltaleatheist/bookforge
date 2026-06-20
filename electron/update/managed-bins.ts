/**
 * managed-bins store — the on-disk record of OUR installed server-hosted binaries (ffmpeg,
 * yt-dlp, …) and the seam consumers use to RESOLVE them.
 *
 * Kept separate from component-updater.ts (the network installer) so lean consumers like
 * tool-paths.ts can resolve an installed binary without pulling the download machinery.
 *
 * Layout: userData/managed-bins/<id>/        (extracted artifact)
 *         userData/managed-bins/state.json   ({ [id]: InstalledBinary })
 */

import * as fs from 'fs';
import * as path from 'path';
import { workerData } from 'worker_threads';
import { migrateLegacyDir } from '../shared-paths';

/**
 * Resolve the userData base dir WITHOUT a static `import { app } from 'electron'`.
 *
 * This module is pulled into the pdf-worker thread (pdf-analyzer → mutool-bridge
 * → here). A worker thread can't access electron's `app`: in a packaged build
 * the 'electron' module isn't even resolvable, so a static import crashes the
 * worker at startup ("Cannot find module 'electron'", exit code 1) and every
 * document fails to load. Resolve electron lazily and, when it's unavailable
 * (the worker), use the userData path the spawner injects via workerData / env.
 */
function resolveUserDataDir(): string {
  try {
    // Lazy: present in main/renderer, a bare path string or absent in a worker.
    const electron = require('electron') as { app?: { getPath(name: string): string } };
    if (electron && typeof electron === 'object' && electron.app?.getPath) {
      return electron.app.getPath('userData');
    }
  } catch { /* worker thread — electron is not available here */ }
  const injected = (workerData && workerData.userDataPath) || process.env.BOOKFORGE_USERDATA_DIR;
  if (injected) return injected;
  throw new Error('[managed-bins] cannot resolve userData dir (no electron app, no workerData.userDataPath / BOOKFORGE_USERDATA_DIR)');
}

// Managed binaries (ffmpeg, llama-server, yt-dlp, …) are identical across apps,
// so they live in the OwenMorgan shared dir and are reused by every OwenMorgan
// app. A one-time migration moves any pre-existing per-app install so current
// installs don't re-download. Records in state.json may carry pre-migration
// absolute paths — the resolvers below reconstruct against the CURRENT base
// (artifacts always live at <base>/<id>/…), so a relocated store still resolves.
export const MANAGED_BINS_DIR = migrateLegacyDir(
  path.join(resolveUserDataDir(), 'managed-bins'),
  'managed-bins'
);
const STATE_PATH = path.join(MANAGED_BINS_DIR, 'state.json');

export interface InstalledBinary {
  version: string;
  sha256: string;
  bytes: number;
  /** Extracted artifact directory. */
  dir: string;
  /** Absolute path to the executable within `dir`. */
  entryPath: string;
  installedAt: string;
}
export type ManagedBinState = Record<string, InstalledBinary>;

export function readState(): ManagedBinState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as ManagedBinState;
  } catch {
    return {};
  }
}

export function writeState(state: ManagedBinState): void {
  fs.mkdirSync(MANAGED_BINS_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

export function recordInstalled(id: string, record: InstalledBinary): void {
  const state = readState();
  state[id] = record;
  writeState(state);
}

export function getInstalled(id: string): InstalledBinary | null {
  return readState()[id] ?? null;
}

export function getManagedBinaryDir(id: string): string | null {
  if (!readState()[id]) return null;
  // Resolve against the current base rather than the recorded absolute path, so
  // a store relocated into the shared dir (or a synced state.json) still works.
  const dir = path.join(MANAGED_BINS_DIR, id);
  return fs.existsSync(dir) ? dir : null;
}

/** Absolute path to an installed managed binary's executable, or null if not installed. */
export function getManagedBinaryPath(id: string): string | null {
  const rec = readState()[id];
  if (!rec) return null;
  // Recompute from the current base: artifacts live at <base>/<id>/, and the
  // executable keeps its position within the artifact (rec.entryPath relative
  // to rec.dir). Robust to the store having moved since it was recorded.
  const relEntry = path.relative(rec.dir, rec.entryPath);
  const entryPath = path.join(MANAGED_BINS_DIR, id, relEntry);
  return fs.existsSync(entryPath) ? entryPath : null;
}

/** Default executable path within an artifact when the manifest doesn't specify `entry`. */
export function defaultEntryRel(id: string): string {
  return process.platform === 'win32' ? `${id}.exe` : id;
}
