/**
 * Launcher bootstrap — the persistent BookForge.app's entry point (`main` in the packaged
 * launcher). Runs BEFORE any app code. Its only jobs:
 *   1. ensure a code bundle exists in userData (seed the bundled baseline on first run),
 *   2. apply a previously-staged update (stage-now / boot-next) with rollback safety,
 *   3. point module resolution at the launcher's own node_modules,
 *   4. hand off to the code bundle's main.js via require().
 *
 * Native deps (better-sqlite3) and all node_modules live in the launcher; the code bundle is
 * pure JS and resolves them through the injected fallback path. See manifest-types.ts and
 * prototype/launcher-split/ for the design + validated mechanism.
 *
 * DEV (electron:dev, not packaged) is a pure passthrough — boots the local dist/ as today, so
 * the existing dev workflow is unchanged.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Module } from 'module';
import {
  USER_APP_ROOT,
  bundleDir,
  bundleCodeMain,
  bundleIsComplete,
  readPointer,
  writePointer,
} from './boot-state';

// __dirname (packaged) = <launcherRoot>/dist/electron/launcher
const LAUNCHER_ROOT = path.join(__dirname, '..', '..', '..'); // contains dist/, node_modules, icon
const LAUNCHER_NODE_MODULES = path.join(LAUNCHER_ROOT, 'node_modules');

function log(...args: unknown[]): void {
  console.log('[launcher]', ...args);
}

/**
 * Recursive copy using ONLY the JS-level fs API. The launcher's baseline lives inside the
 * packaged app.asar, and Electron's asar virtual filesystem only patches the JS fs functions
 * (readdirSync/readFileSync/writeFileSync) — NOT the native fs.cpSync, which silently copies
 * nothing out of an asar. So we walk + copy by hand to read baseline files out of the archive.
 */
function copyTreeAsarAware(src: string, dst: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTreeAsarAware(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.writeFileSync(dst, fs.readFileSync(src));
  }
}

/**
 * Copy the baseline code bundle shipped inside the launcher (the .app's dist/ + icon) into
 * userData/app/<version>/. Guarantees a working app on first launch with no network. node_modules
 * is intentionally NOT copied — it stays in the launcher and is resolved via the fallback path.
 * Staged into a temp dir then renamed so a kill mid-copy never leaves a half-seeded bundle that
 * looks complete.
 */
function seedBaseline(version: string): void {
  const dst = bundleDir(version);
  const staging = dst + '.seeding';
  log(`seeding baseline ${version} -> ${dst}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  copyTreeAsarAware(path.join(LAUNCHER_ROOT, 'dist'), path.join(staging, 'dist'));
  const icon = path.join(LAUNCHER_ROOT, 'bookforge-icon.png');
  if (fs.existsSync(icon)) fs.writeFileSync(path.join(staging, 'bookforge-icon.png'), fs.readFileSync(icon));
  fs.writeFileSync(
    path.join(staging, 'version.json'),
    JSON.stringify({ version, seededFrom: 'launcher-baseline' }, null, 2)
  );
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(staging, dst); // atomic publish
}

/** Decide which version to boot, applying a staged update or rolling back a failed one. */
function resolveBootVersion(): string {
  const baselineVersion = app.getVersion();
  let pointer = readPointer();

  // First run: no pointer -> seed + record baseline.
  if (!pointer) {
    if (!bundleIsComplete(baselineVersion)) seedBaseline(baselineVersion);
    writePointer({ version: baselineVersion });
    pointer = readPointer()!;
  }

  // Stage-now / boot-next: a previous run downloaded + verified a new bundle and marked it
  // pending. Apply the flip now, before booting.
  if (pointer.pendingVersion && pointer.pendingVersion !== pointer.version) {
    if (bundleIsComplete(pointer.pendingVersion)) {
      log(`applying staged update ${pointer.version} -> ${pointer.pendingVersion}`);
      pointer = { version: pointer.pendingVersion, lastGoodVersion: pointer.lastGoodVersion };
    } else {
      log(`staged ${pointer.pendingVersion} is incomplete; ignoring`);
      pointer = { version: pointer.version, lastGoodVersion: pointer.lastGoodVersion };
    }
    writePointer(pointer);
  }

  // Rollback: the target was attempted on a previous launch but never confirmed boot-OK (it
  // crashed during startup). Fall back to the last known-good version.
  const attempt = path.join(bundleDir(pointer.version), '.boot-attempt');
  const ok = path.join(bundleDir(pointer.version), '.boot-ok');
  if (
    fs.existsSync(attempt) &&
    !fs.existsSync(ok) &&
    pointer.lastGoodVersion &&
    pointer.lastGoodVersion !== pointer.version &&
    bundleIsComplete(pointer.lastGoodVersion)
  ) {
    log(`bundle ${pointer.version} failed a prior boot; rolling back to ${pointer.lastGoodVersion}`);
    pointer = { version: pointer.lastGoodVersion, lastGoodVersion: pointer.lastGoodVersion };
    writePointer(pointer);
  }

  // Safety net: if the chosen bundle is missing/incomplete, re-seed the baseline.
  if (!bundleIsComplete(pointer.version)) {
    log(`bundle ${pointer.version} incomplete; re-seeding baseline ${baselineVersion}`);
    seedBaseline(baselineVersion);
    pointer = { version: baselineVersion, lastGoodVersion: pointer.lastGoodVersion };
    writePointer(pointer);
  }

  return pointer.version;
}

/**
 * Make bare requires from the code bundle (which lives in userData with no node_modules nearby)
 * fall back to the launcher's node_modules.
 */
function injectLauncherModules(): void {
  process.env.NODE_PATH = LAUNCHER_NODE_MODULES + path.delimiter + (process.env.NODE_PATH || '');
  // @ts-expect-error _initPaths is internal but stable and the supported way to re-read NODE_PATH.
  Module._initPaths();
  log('module fallback ->', LAUNCHER_NODE_MODULES);
}

function main(): void {
  // Dev passthrough: boot the local dist/ exactly as before. No userData, no seeding.
  if (!app.isPackaged) {
    require(path.join(LAUNCHER_ROOT, 'dist', 'electron', 'main.js'));
    return;
  }

  log('userData app root =', USER_APP_ROOT);

  // Note: checking the manifest + downloading a newer code bundle happens IN the running app
  // (electron/update/code-updater.ts), which sets pointer.pendingVersion. The launcher's only
  // job is to APPLY that pending flip here (stage-now / boot-next), done in resolveBootVersion().
  const version = resolveBootVersion();

  // Mark an attempt so a startup crash is detected and rolled back next launch. The running app
  // clears this by calling markBootOk() (boot-state.ts) once it is healthy.
  try {
    fs.writeFileSync(path.join(bundleDir(version), '.boot-attempt'), '');
  } catch {
    /* non-fatal */
  }

  injectLauncherModules();

  const codeMain = bundleCodeMain(version);
  log(`booting code bundle "${version}" from`, codeMain);
  require(codeMain);
}

main();
