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
  linkBundleNodeModules,
  readBuildId,
  readPointer,
  writePointer,
} from './boot-state';
import { gt } from '../update/semver';

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
 * is NOT copied — instead the bundle gets a symlink to the launcher's real-disk node_modules so
 * both CJS require (also covered by NODE_PATH) and ESM import() resolve (see linkBundleNodeModules).
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
  // Point the bundle's node_modules at the launcher's real-disk copy so ESM import() resolves
  // (NODE_PATH only covers CJS require; the ESM resolver can't traverse the asar).
  linkBundleNodeModules(staging);
  fs.writeFileSync(
    path.join(staging, 'version.json'),
    JSON.stringify({ version, seededFrom: 'launcher-baseline' }, null, 2)
  );
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(staging, dst); // atomic publish
}

/**
 * Did this bundle attempt a boot that never confirmed healthy? (attempt sentinel present, ok
 * sentinel absent — same signal the rollback path uses.) Used to avoid re-adopting a baked
 * baseline that crash-loops on startup.
 */
function bootFailedBefore(version: string): boolean {
  const dir = bundleDir(version);
  return fs.existsSync(path.join(dir, '.boot-attempt')) && !fs.existsSync(path.join(dir, '.boot-ok'));
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

  // Reinstalled a different .app? The launcher boots the userData bundle, not the code baked into
  // the .app, so a fresh install would otherwise keep running the older pinned bundle until the
  // in-app updater happened to pull something newer (or userData was wiped by hand). Adopt the baked
  // baseline — re-seeding from the just-installed .app so the bundle matches the binary — when it is
  // either a NEWER version, or the SAME version but a different BUILD (different build-info buildId).
  // The build-id case is what makes manual version bumps unnecessary: a rebuild+reinstall at the same
  // version is still picked up, instead of silently running the previously-seeded bundle. Runs AFTER
  // the pending flip so a newer published update still wins.
  //
  // Crash-loop guards differ by case:
  //  - newer VERSION: skip if that version already failed a boot here, so a crashing newer build
  //    can't trap us in re-adopt → crash → rollback → re-adopt. (Reinstall a fixed build to recover.)
  //  - same-version different BUILD: always give the new build a chance (its buildId differs, so the
  //    old build's failure markers don't describe it). After seeding, the pinned buildId equals the
  //    baked one, so it won't re-seed on the next boot — at worst it boots the new build once; a
  //    fixed reinstall (new buildId) supersedes it.
  const bakedBuildId = readBuildId(LAUNCHER_ROOT);
  const pinnedBuildId = readBuildId(bundleDir(pointer.version));
  const versionFresher = gt(baselineVersion, pointer.version) && !bootFailedBefore(baselineVersion);
  const buildFresher =
    baselineVersion === pointer.version && !!bakedBuildId && bakedBuildId !== pinnedBuildId;
  if (versionFresher || buildFresher) {
    log(
      `adopting baked baseline ${baselineVersion} (${buildFresher ? `new build ${bakedBuildId} ≠ ${pinnedBuildId}` : `newer than pinned ${pointer.version}`})`,
    );
    seedBaseline(baselineVersion);
    pointer = { version: baselineVersion, lastGoodVersion: pointer.lastGoodVersion ?? pointer.version };
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
