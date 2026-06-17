/**
 * Launcher boot state — the userData/app pointer + version-folder helpers.
 *
 * Side-effect-free on import, so BOTH the launcher bootstrap (which runs boot logic) and the
 * running app's main.ts (which calls markBootOk after a healthy startup) can import it without
 * re-triggering a boot. See bootstrap.ts for how these are used.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/** userData/app — holds version folders (<version>/dist/...) and current.json. */
export const USER_APP_ROOT = path.join(app.getPath('userData'), 'app');
export const POINTER = path.join(USER_APP_ROOT, 'current.json');

export interface Pointer {
  /** Version folder to boot. */
  version: string;
  /** Last version that booted successfully — rollback target. */
  lastGoodVersion?: string;
  /** A staged-but-not-yet-booted version (set by the updater; applied next launch). */
  pendingVersion?: string;
}

export function readPointer(): Pointer | null {
  try {
    return JSON.parse(fs.readFileSync(POINTER, 'utf8')) as Pointer;
  } catch {
    return null;
  }
}

export function writePointer(p: Pointer): void {
  fs.mkdirSync(USER_APP_ROOT, { recursive: true });
  const tmp = POINTER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, POINTER); // atomic
}

export function bundleDir(version: string): string {
  return path.join(USER_APP_ROOT, version);
}

export function bundleCodeMain(version: string): string {
  return path.join(bundleDir(version), 'dist', 'electron', 'main.js');
}

export function bundleIsComplete(version: string): boolean {
  return fs.existsSync(bundleCodeMain(version));
}

/**
 * Called by the running app once it has booted far enough to be considered healthy (e.g. after
 * the main window finishes loading). Confirms the current bundle as known-good and clears the
 * attempt sentinel so it won't be rolled back next launch. No-op in dev (no pointer).
 */
export function markBootOk(): void {
  const pointer = readPointer();
  if (!pointer) return;
  const dir = bundleDir(pointer.version);
  try {
    fs.writeFileSync(path.join(dir, '.boot-ok'), '');
    fs.rmSync(path.join(dir, '.boot-attempt'), { force: true });
    if (pointer.lastGoodVersion !== pointer.version) {
      writePointer({ ...pointer, lastGoodVersion: pointer.version });
    }
  } catch {
    /* non-fatal */
  }
}
