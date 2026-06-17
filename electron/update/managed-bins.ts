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

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export const MANAGED_BINS_DIR = path.join(app.getPath('userData'), 'managed-bins');
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
  const rec = readState()[id];
  return rec && fs.existsSync(rec.dir) ? rec.dir : null;
}

/** Absolute path to an installed managed binary's executable, or null if not installed. */
export function getManagedBinaryPath(id: string): string | null {
  const rec = readState()[id];
  return rec && fs.existsSync(rec.entryPath) ? rec.entryPath : null;
}

/** Default executable path within an artifact when the manifest doesn't specify `entry`. */
export function defaultEntryRel(id: string): string {
  return process.platform === 'win32' ? `${id}.exe` : id;
}
