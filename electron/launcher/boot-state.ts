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
 * Give a bundle dir (seeded OR self-update-downloaded) a node_modules symlink to the launcher's
 * real-disk node_modules.
 *
 * Dynamic `import()` — used for the ESM-only `mupdf` and other lazy deps — goes through the ESM
 * resolver, which IGNORES the NODE_PATH fallback the launcher injects AND cannot traverse into an
 * .asar (both verified: a symlink into app.asar still fails "Cannot find package 'mupdf'"). With
 * `asarUnpack: ["node_modules/**"]` the deps are extracted to <Resources>/app.asar.unpacked/
 * node_modules on real disk; symlinking the bundle's node_modules there makes both ESM import() and
 * CJS require resolve. 'junction' keeps it working on Windows without admin (ignored on macOS/Linux,
 * which use a plain dir symlink). Best-effort: CJS still resolves via NODE_PATH if this fails.
 */
export function linkBundleNodeModules(bundleRootDir: string): void {
  const real = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(real)) return; // asar-disabled / dev layout — nothing to link
  const link = path.join(bundleRootDir, 'node_modules');
  try {
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(real, link, 'junction');
  } catch {
    /* best-effort */
  }
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
