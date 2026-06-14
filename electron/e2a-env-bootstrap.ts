/**
 * Bundled relocatable Python environment (conda-pack).
 *
 * Packaged builds ship the frozen `ebook2audiobook` conda env as a conda-pack
 * tarball in the app's resources (built from packaging/env/*.yml, packed to
 * packaging/artifacts/e2a-env-<platform>.tar.gz, shipped as
 * resources/e2a-env.tar.gz). On first run the tarball is extracted to a
 * writable folder under userData and the env's `conda-unpack` script rewrites
 * the prefix paths baked in at pack time. From then on every e2a spawn invokes
 * the env's python directly — no conda on the target machine.
 *
 * Resolution (getActiveBundledEnvPath):
 *   1. BOOKFORGE_E2A_ENV — points at an already-unpacked relocatable env.
 *      Lets dev builds exercise the relocatable code path without packaging.
 *      Set but invalid → throw (a configured override must not be ignored).
 *   2. The unpacked env under userData, when its ready-marker matches the
 *      shipped tarball (size + mtime — a new tarball forces a re-unpack).
 *   3. null — no bundled env; callers fall back to conda-based resolution.
 */

import { app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const TARBALL_NAME = 'e2a-env.tar.gz';
const READY_MARKER = '.bookforge-env-ready.json';
const E2A_SNAPSHOT_STAMP = '.bookforge-e2a-snapshot.json';
const E2A_READY_MARKER = '.bookforge-e2a-ready.json';

export function getBundledEnvTarballPath(): string {
  return path.join(process.resourcesPath, TARBALL_NAME);
}

export function getBundledEnvDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'e2a-env');
}

/** Direct python executable inside a relocatable env (no conda involved). */
export function relocatablePythonPath(envDir: string): string {
  return process.platform === 'win32'
    ? path.join(envDir, 'python.exe')
    : path.join(envDir, 'bin', 'python');
}

/**
 * PATH entries a relocatable env needs in front of the spawn PATH — the same
 * set `conda activate` would prepend. e2a resolves ffmpeg/ffprobe/sox/
 * mediainfo/ebook-convert via shutil.which, so these must be visible.
 */
export function relocatableEnvBinDirs(envDir: string): string[] {
  if (process.platform === 'win32') {
    return [
      envDir,
      path.join(envDir, 'Library', 'mingw-w64', 'bin'),
      path.join(envDir, 'Library', 'usr', 'bin'),
      path.join(envDir, 'Library', 'bin'),
      path.join(envDir, 'Scripts'),
    ];
  }
  return [path.join(envDir, 'bin')];
}

/**
 * A binary shipped inside a relocatable env (ffmpeg, sox, …), or null when the
 * env doesn't contain it. Searches the same dirs `conda activate` exposes —
 * on Windows conda puts binaries under Library/bin, not the env root.
 */
export function relocatableBinaryPath(envDir: string, name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of relocatableEnvBinDirs(envDir)) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface ReadyMarker {
  tarballSize: number;
  tarballMtimeMs: number;
}

function markerPath(envDir: string): string {
  return path.join(envDir, READY_MARKER);
}

function currentTarballIdentity(): ReadyMarker | null {
  try {
    const st = fs.statSync(getBundledEnvTarballPath());
    return { tarballSize: st.size, tarballMtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function envIsReady(envDir: string): boolean {
  try {
    const marker: ReadyMarker = JSON.parse(fs.readFileSync(markerPath(envDir), 'utf-8'));
    const tarball = currentTarballIdentity();
    if (!tarball) {
      // No tarball to compare against (e.g. dev run pointing userData at an old
      // unpack) — an unpacked env with a marker is trusted as-is.
      return fs.existsSync(relocatablePythonPath(envDir));
    }
    return (
      marker.tarballSize === tarball.tarballSize &&
      marker.tarballMtimeMs === tarball.tarballMtimeMs &&
      fs.existsSync(relocatablePythonPath(envDir))
    );
  } catch {
    return false;
  }
}

/**
 * The relocatable env to use for e2a spawns, or null when none is configured.
 * Synchronous and cheap — called on every spawn resolution.
 */
export function getActiveBundledEnvPath(): string | null {
  const override = process.env.BOOKFORGE_E2A_ENV;
  if (override && override.trim()) {
    const dir = override.trim();
    if (!fs.existsSync(relocatablePythonPath(dir))) {
      throw new Error(
        `BOOKFORGE_E2A_ENV is set to "${dir}" but no python executable was found at ` +
        `"${relocatablePythonPath(dir)}". Unset the variable or point it at an unpacked env.`
      );
    }
    return dir;
  }

  // The userData runtime copy is packaged-only. Dev shares the same userData
  // dir as a locally-built packaged app, so without this gate a dev run would
  // silently resolve to a stale unpacked env instead of the live conda env.
  // Dev exercises the relocatable path via BOOKFORGE_E2A_ENV above.
  if (!app.isPackaged) return null;

  const envDir = getBundledEnvDir();
  if (envIsReady(envDir)) return envDir;
  return null;
}

/** Whether this build ships a bundled env tarball (packaged installs do). */
export function hasBundledEnvTarball(): boolean {
  return fs.existsSync(getBundledEnvTarballPath());
}

function run(command: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * First-run setup: extract the shipped env tarball under userData and run its
 * conda-unpack. Idempotent — returns immediately when the env is already
 * unpacked and matches the shipped tarball. Returns the env dir, or null when
 * this build ships no tarball (dev).
 *
 * conda-unpack must be invoked through the env's own python: its shebang is
 * `#!/usr/bin/env python`, and a clean target machine has no python on PATH.
 */
export async function ensureBundledEnv(onProgress?: (message: string) => void): Promise<string | null> {
  const override = process.env.BOOKFORGE_E2A_ENV;
  if (override && override.trim()) return getActiveBundledEnvPath();

  if (!hasBundledEnvTarball()) return null;

  const envDir = getBundledEnvDir();
  if (envIsReady(envDir)) return envDir;

  const tarball = getBundledEnvTarballPath();
  console.log(`[E2A-ENV] Unpacking bundled Python env: ${tarball} -> ${envDir}`);
  onProgress?.('Preparing the bundled text-to-speech runtime (one-time setup)…');

  // A stale or partial unpack is never reusable — start clean.
  fs.rmSync(envDir, { recursive: true, force: true });
  fs.mkdirSync(envDir, { recursive: true });

  // bsdtar ships with macOS and with Windows 10 1803+ (System32\tar.exe).
  onProgress?.('Extracting Python environment…');
  await run('tar', ['-xzf', tarball, '-C', envDir]);

  onProgress?.('Fixing environment paths (conda-unpack)…');
  const python = relocatablePythonPath(envDir);
  const condaUnpack = process.platform === 'win32'
    ? path.join(envDir, 'Scripts', 'conda-unpack-script.py')
    : path.join(envDir, 'bin', 'conda-unpack');
  await run(python, [condaUnpack], { cwd: envDir });

  const identity = currentTarballIdentity();
  fs.writeFileSync(markerPath(envDir), JSON.stringify(identity), 'utf-8');
  console.log('[E2A-ENV] Bundled Python env ready:', envDir);
  onProgress?.('Text-to-speech runtime ready.');
  return envDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundled e2a code (the ebook2audiobook checkout itself)
// ─────────────────────────────────────────────────────────────────────────────
//
// e2a derives ALL of its working paths from its own root (lib/conf.py:
// tmp/, models/, voices/, ebooks/) and writes into them — HF model downloads,
// converted-voice caches, session temp files. App resources are read-only, so
// the shipped snapshot (resources/e2a, staged by packaging/stage-resources.js)
// is copied to a writable runtime dir on first run, exactly like the env
// tarball. Code is overwritten on every new snapshot; models/ and voices/ are
// merged without overwriting so downloaded models and voice caches survive
// app updates. Copies use APFS clone-on-write where available, so even a
// staged-models seed (~26 GB) is near-instant on the same volume.

/** The read-only e2a snapshot shipped in app resources (packaged builds). */
export function getBundledE2aSnapshotDir(): string {
  return path.join(process.resourcesPath, 'e2a');
}

/** The writable e2a root the packaged app actually runs from. */
export function getRuntimeE2aDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'e2a');
}

interface E2aSnapshotStamp {
  stamp: string;
}

function readStamp(file: string): E2aSnapshotStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed?.stamp === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function e2aIsReady(runtimeDir: string): boolean {
  const marker = readStamp(path.join(runtimeDir, E2A_READY_MARKER));
  if (!marker || !fs.existsSync(path.join(runtimeDir, 'app.py'))) return false;
  const shipped = readStamp(path.join(getBundledE2aSnapshotDir(), E2A_SNAPSHOT_STAMP));
  // No snapshot to compare against (dev) — an unpacked runtime with a marker
  // is trusted as-is. A shipped snapshot with a different stamp forces re-copy.
  if (!shipped) return true;
  return marker.stamp === shipped.stamp;
}

/**
 * The bundled e2a runtime dir to use, or null when none is set up. Synchronous
 * and cheap — consulted by getE2aPath() on every resolution.
 */
export function getActiveBundledE2aPath(): string | null {
  // Packaged-only, same reasoning as getActiveBundledEnvPath: a dev run must
  // keep resolving the live e2a checkout, not the runtime copy a locally-built
  // packaged app left in the shared userData dir.
  if (!app.isPackaged) return null;

  const runtimeDir = getRuntimeE2aDir();
  if (e2aIsReady(runtimeDir)) return runtimeDir;
  return null;
}

/** Whether this build ships an e2a code snapshot (packaged installs do). */
export function hasBundledE2aSnapshot(): boolean {
  return fs.existsSync(path.join(getBundledE2aSnapshotDir(), E2A_SNAPSHOT_STAMP));
}

/**
 * Whether the bundled runtime needs no further unpacking — i.e. there's nothing
 * for ensureBundledEnv/ensureBundledE2a to do. True in dev (no tarball/snapshot
 * ships) and on a packaged install whose env + e2a are already unpacked and
 * current. Used to decide up front whether to show the first-run setup overlay.
 */
export function bundledRuntimeReady(): boolean {
  const envNeedsSetup = hasBundledEnvTarball() && !envIsReady(getBundledEnvDir());
  const e2aNeedsSetup = hasBundledE2aSnapshot() && !e2aIsReady(getRuntimeE2aDir());
  return !envNeedsSetup && !e2aNeedsSetup;
}

// Clone-on-write where the filesystem supports it (APFS/ReFS), full copy
// elsewhere. COPYFILE_FICLONE falls back to a regular copy automatically.
const CLONE_MODE = fs.constants.COPYFILE_FICLONE;

/**
 * First-run / upgrade setup for the bundled e2a code. Idempotent: returns
 * immediately when the runtime copy matches the shipped snapshot. Returns the
 * runtime dir, or null when this build ships no snapshot (dev).
 */
export async function ensureBundledE2a(onProgress?: (message: string) => void): Promise<string | null> {
  if (!hasBundledE2aSnapshot()) return null;

  const snapshotDir = getBundledE2aSnapshotDir();
  const runtimeDir = getRuntimeE2aDir();
  if (e2aIsReady(runtimeDir)) return runtimeDir;

  console.log(`[E2A-CODE] Installing bundled e2a: ${snapshotDir} -> ${runtimeDir}`);
  onProgress?.('Installing the bundled audiobook engine…');
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Pass 1 — code: overwrite so snapshot updates land. models/ and voices/
  // are excluded here; they get merge semantics below.
  const skipTopLevel = new Set(['models', 'voices', E2A_SNAPSHOT_STAMP]);
  fs.cpSync(snapshotDir, runtimeDir, {
    recursive: true,
    force: true,
    mode: CLONE_MODE,
    // Copy symlinks as-is. The seeded HF model cache stores snapshots/* as
    // RELATIVE symlinks into blobs/*; without this, cpSync resolves the target
    // and its own is-subdir check throws EINVAL ("cannot copy to a subdirectory
    // of self"). Staging (stage-resources.js) writes these links verbatim, so the
    // runtime copy must preserve them verbatim too.
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(snapshotDir, src);
      if (!rel) return true;
      return !skipTopLevel.has(rel.split(path.sep)[0]);
    },
  });

  // Pass 2 — seeded assets: copy only what the runtime doesn't already have,
  // so model downloads and converted-voice caches survive app updates.
  for (const sub of ['models', 'voices']) {
    const src = path.join(snapshotDir, sub);
    if (!fs.existsSync(src)) continue;
    onProgress?.(sub === 'models' ? 'Installing bundled TTS models…' : 'Installing bundled voices…');
    fs.cpSync(src, path.join(runtimeDir, sub), {
      recursive: true,
      force: false,
      errorOnExist: false,
      mode: CLONE_MODE,
      // Preserve the HF cache's relative blobs/* ↔ snapshots/* symlinks (see
      // pass 1) — resolving them throws EINVAL on the seeded voice models.
      verbatimSymlinks: true,
    });
  }

  // Working dirs e2a expects under its root (conf.py points tempfile at tmp/).
  for (const sub of ['tmp', 'ebooks', 'audiobooks', 'models', 'voices']) {
    fs.mkdirSync(path.join(runtimeDir, sub), { recursive: true });
  }

  const shipped = readStamp(path.join(snapshotDir, E2A_SNAPSHOT_STAMP));
  fs.writeFileSync(path.join(runtimeDir, E2A_READY_MARKER), JSON.stringify(shipped), 'utf-8');
  console.log('[E2A-CODE] Bundled e2a ready:', runtimeDir);
  onProgress?.('Audiobook engine ready.');
  return runtimeDir;
}
