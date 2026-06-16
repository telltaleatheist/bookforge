/**
 * Relocatable Python environment (conda-pack), downloaded on first run.
 *
 * The frozen `ebook2audiobook` conda env is built per-platform (from
 * packaging/env/*.yml), packed with conda-pack, and published as a GitHub
 * release asset (see ENV_RELEASES). It is NO LONGER bundled in the installer —
 * on first run a packaged build downloads the platform's tarball, verifies its
 * sha256, extracts it under userData, and runs the env's `conda-unpack` script
 * to rewrite the prefix paths baked in at pack time. From then on every e2a
 * spawn invokes the env's python directly — no conda on the target machine.
 *
 * Readiness is keyed on ENV_VERSION + the artifact sha256 (recorded in the
 * ready-marker): bumping ENV_VERSION or publishing a new tarball forces a
 * re-download + re-unpack. The downloaded tarball is cached under userData
 * across retries, then deleted once a build succeeds to reclaim its ~1.8 GB.
 *
 * Resolution (getActiveBundledEnvPath):
 *   1. BOOKFORGE_E2A_ENV — points at an already-unpacked relocatable env.
 *      Lets dev builds exercise the relocatable code path without packaging.
 *      Set but invalid → throw (a configured override must not be ignored).
 *   2. The unpacked env under userData, when its ready-marker matches the
 *      current ENV_VERSION + sha256.
 *   3. null — no managed env for this platform (or dev); callers fall back to
 *      conda-based resolution.
 */

import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { downloadFile, sha256File } from './components/downloader';

const TARBALL_NAME = 'e2a-env.tar.gz';
const READY_MARKER = '.bookforge-env-ready.json';
const E2A_SNAPSHOT_STAMP = '.bookforge-e2a-snapshot.json';
const E2A_READY_MARKER = '.bookforge-e2a-ready.json';

// Bump whenever a new env tarball is published: an installed env whose marker
// records a different version (or sha256) is torn down and rebuilt on launch.
const ENV_VERSION = '2026.06.16';

interface EnvRelease {
  url: string;
  sha256: string;
  bytes: number;
}

// Per-platform conda-pack tarballs, published as GitHub release assets. A
// platform/arch with no entry has no managed env — callers fall back to conda.
const ENV_RELEASES: Record<string, EnvRelease> = {
  'win32-x64': {
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/environment/e2a-env-windows-x64.tar.gz',
    sha256: 'ece7471e90a529ed192958ce1eb205a4145061e3bbb1e14721acaf92983d0090',
    bytes: 1842123032,
  },
  'darwin-arm64': {
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/mac/e2a-env-macos-arm64.tar.gz',
    sha256: '6840385831777babe7ecb7b6c8636c84fa0ebf5a6f223dd480579f57d67dacc4',
    bytes: 1676391339,
  },
};

/** The env release artifact for this platform/arch, or null if none exists. */
function envReleaseForThisPlatform(): EnvRelease | null {
  return ENV_RELEASES[`${process.platform}-${process.arch}`] ?? null;
}

export function getBundledEnvDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'e2a-env');
}

/** Where the env tarball downloads to — cached across retries, deleted on success. */
function envTarballCachePath(): string {
  return path.join(runtimeRoot(), TARBALL_NAME);
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
  version: string;
  sha256: string;
}

function markerPath(envDir: string): string {
  return path.join(envDir, READY_MARKER);
}

/** The ready-marker an unpack should write for the current platform, or null. */
function expectedMarker(): ReadyMarker | null {
  const release = envReleaseForThisPlatform();
  return release ? { version: ENV_VERSION, sha256: release.sha256 } : null;
}

function envIsReady(envDir: string): boolean {
  try {
    const marker: ReadyMarker = JSON.parse(fs.readFileSync(markerPath(envDir), 'utf-8'));
    const expected = expectedMarker();
    if (!expected) {
      // No managed env for this platform (e.g. a dev override unpack) — an
      // unpacked env with a marker is trusted as-is if the interpreter exists.
      return fs.existsSync(relocatablePythonPath(envDir));
    }
    return (
      marker.version === expected.version &&
      marker.sha256 === expected.sha256 &&
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

/** Whether a managed env exists for this platform (i.e. there's one to download). */
export function hasManagedEnv(): boolean {
  return envReleaseForThisPlatform() !== null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Corruption-resistant runtime setup
//
// First-run unpack is the #1 source of a broken install (interrupted extract, a
// killed app mid-conda-unpack, antivirus quarantining a DLL, a second instance
// racing the same dir). The defenses below make a half-built runtime impossible
// to "go live", and let the app self-heal a corrupt one on the next launch:
//   • build into a temp dir, smoke-test it, then ATOMICALLY rename it into place
//   • on startup, verify a "ready" env actually runs; if not, erase + rebuild
//   • Windows-safe removal (rename-to-trash + retried delete) so locks can't wedge
// ─────────────────────────────────────────────────────────────────────────────

function runtimeRoot(): string {
  return path.join(app.getPath('userData'), 'runtime');
}

/**
 * Remove a directory tree, tolerating Windows file locks. Renaming the dir out of
 * the way first frees its name immediately (so a fresh build can take it) even if
 * a stray handle delays the actual delete; the rename target is then deleted
 * best-effort. Falls back to a retried in-place delete if the rename can't run.
 */
function removeDirRobust(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const trash = `${dir}.trash-${Date.now()}`;
  try {
    fs.renameSync(dir, trash);
    try { fs.rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* a held file delays it — swept on a later run */ }
    return;
  } catch {
    // Rename failed (e.g. a handle on the dir itself) — try a retried delete.
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

/** Sweep leftover temp/trash dirs from interrupted prior runs (best-effort). */
function sweepStale(baseDir: string): void {
  const parent = path.dirname(baseDir);
  const base = path.basename(baseDir);
  try {
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.trash-`)) {
        try { fs.rmSync(path.join(parent, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
        catch { /* ignore */ }
      }
    }
  } catch { /* parent missing — nothing to sweep */ }
}

/**
 * Fast integrity check: the relocated interpreter must actually start. Catches
 * the common Windows corruption (missing python3xx.dll / VCRUNTIME, a truncated
 * extract) that the size+mtime marker can't see. Cheap (~a few hundred ms).
 */
function smokeTestEnv(envDir: string): boolean {
  const python = relocatablePythonPath(envDir);
  if (!fs.existsSync(python)) return false;
  try {
    const res = spawnSync(python, ['--version'], { timeout: 30000, windowsHide: true, cwd: envDir });
    return res.status === 0;
  } catch {
    return false;
  }
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
let envEnsureInFlight: Promise<string | null> | null = null;

export async function ensureBundledEnv(onProgress?: (message: string) => void): Promise<string | null> {
  const override = process.env.BOOKFORGE_E2A_ENV;
  if (override && override.trim()) return getActiveBundledEnvPath();
  // Dev runs from the live conda env, never a download/unpack. (A locally-built
  // packaged app sharing this userData dir is what exercises the relocatable path.)
  if (!app.isPackaged) return null;
  if (!hasManagedEnv()) return null;

  // Never run two builds at once (atomic publish makes it safe, but it's wasteful).
  if (envEnsureInFlight) return envEnsureInFlight;
  envEnsureInFlight = doEnsureBundledEnv(onProgress).finally(() => { envEnsureInFlight = null; });
  return envEnsureInFlight;
}

/**
 * Download the env tarball into destPath, relaying byte progress as setup
 * messages. Uses the shared component downloader (redirects + progress).
 */
async function downloadEnvTarball(
  release: EnvRelease,
  destPath: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const mb = (n?: number) => (n != null ? Math.round(n / 1_000_000) : 0);
  let lastPct = -1;
  await downloadFile(release.url, destPath, 'e2a-env', (p) => {
    if (typeof p.pct === 'number' && p.pct !== lastPct) {
      lastPct = p.pct;
      const detail = p.totalBytes
        ? ` ${p.pct}% (${mb(p.receivedBytes)} / ${mb(p.totalBytes)} MB)`
        : '';
      onProgress?.(`Downloading the text-to-speech runtime…${detail}`);
    }
  });
}

/**
 * Ensure a sha256-verified env tarball is present at the cache path and return
 * it. A cached tarball from a prior run (interrupted during unpack) is reused
 * after a checksum re-check rather than re-downloading ~1.8 GB; a corrupt or
 * mismatched one is discarded and re-fetched. Throws if freshly downloaded bytes
 * don't match the expected sha256.
 */
async function ensureTarballDownloaded(
  release: EnvRelease,
  onProgress?: (message: string) => void,
): Promise<string> {
  const cache = envTarballCachePath();

  if (fs.existsSync(cache)) {
    onProgress?.('Checking the downloaded runtime…');
    try {
      const got = await sha256File(cache);
      if (got.toLowerCase() === release.sha256.toLowerCase()) return cache;
      console.warn('[E2A-ENV] Cached env tarball checksum mismatch — re-downloading.');
    } catch {
      /* unreadable — re-download */
    }
    try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
  }

  await downloadEnvTarball(release, cache, onProgress);

  onProgress?.('Verifying the download…');
  const got = await sha256File(cache);
  if (got.toLowerCase() !== release.sha256.toLowerCase()) {
    try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
    throw new Error(
      `Downloaded env checksum mismatch (expected ${release.sha256}, got ${got}). The download was corrupt.`
    );
  }
  return cache;
}

async function doEnsureBundledEnv(onProgress?: (message: string) => void): Promise<string | null> {
  const release = envReleaseForThisPlatform();
  if (!release) return null;

  const envDir = getBundledEnvDir();

  // Healthy AND verified → nothing to do. A marker-ready env that fails its
  // self-test is corrupt (the classic "set up but doesn't work") — rebuild it.
  if (envIsReady(envDir)) {
    if (smokeTestEnv(envDir)) return envDir;
    console.warn('[E2A-ENV] Env is marked ready but failed its self-test — rebuilding (corruption).');
    onProgress?.('Repairing a corrupted text-to-speech runtime…');
  } else if (fs.existsSync(envDir)) {
    console.warn('[E2A-ENV] Env present but incomplete — rebuilding.');
  }

  fs.mkdirSync(runtimeRoot(), { recursive: true });
  sweepStale(envDir);

  // Fetch (or reuse a cached) sha256-verified tarball before building.
  const tarball = await ensureTarballDownloaded(release, onProgress);

  const tempDir = `${envDir}.tmp-${process.pid}-${Date.now()}`;
  console.log(`[E2A-ENV] Building Python env: ${tarball} -> ${tempDir}`);
  onProgress?.('Preparing the text-to-speech runtime (one-time setup)…');
  removeDirRobust(tempDir);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // bsdtar ships with macOS and with Windows 10 1803+ (System32\tar.exe).
    onProgress?.('Extracting Python environment…');
    await run('tar', ['-xzf', tarball, '-C', tempDir]);

    onProgress?.('Fixing environment paths (conda-unpack)…');
    const python = relocatablePythonPath(tempDir);
    const condaUnpack = process.platform === 'win32'
      ? path.join(tempDir, 'Scripts', 'conda-unpack-script.py')
      : path.join(tempDir, 'bin', 'conda-unpack');
    await run(python, [condaUnpack], { cwd: tempDir });

    // Verify the build BEFORE it can go live.
    onProgress?.('Verifying the runtime…');
    if (!smokeTestEnv(tempDir)) {
      throw new Error('The unpacked Python runtime failed its self-test (the interpreter would not start).');
    }

    // Mark complete inside the temp dir, then ATOMICALLY publish it: the live
    // env only ever appears as a fully-built, verified, marked tree.
    fs.writeFileSync(
      markerPath(tempDir),
      JSON.stringify({ version: ENV_VERSION, sha256: release.sha256 } satisfies ReadyMarker),
      'utf-8',
    );
    removeDirRobust(envDir);            // clear any stale/corrupt live dir (frees the name)
    fs.renameSync(tempDir, envDir);     // atomic on the same volume

    // Build succeeded — the cached download is no longer needed; reclaim ~1.8 GB.
    try { fs.rmSync(tarball, { force: true }); } catch { /* ignore */ }

    console.log('[E2A-ENV] Python env ready:', envDir);
    onProgress?.('Text-to-speech runtime ready.');
    return envDir;
  } catch (err) {
    removeDirRobust(tempDir);           // never leave a half-built temp behind
    // Keep the verified tarball cached so a retry doesn't re-download ~1.8 GB.
    throw err;
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// First-run runtime assets (default voice + English language pack)
//
// These are NOT bundled in the installer. They're published as GitHub release
// archives whose internal layout mirrors the e2a runtime's models/ tree, so they
// extract straight into getRuntimeE2aDir() and land exactly where the bundled
// seed used to put them. Platform-independent (model weights + JSON + audio), so
// one archive each serves Windows and macOS. Downloaded as part of the first-run
// "update" alongside the Python env. Other voices/languages stay optional and
// download on demand through the component system (HuggingFace / Stanford).
// ─────────────────────────────────────────────────────────────────────────────

interface RuntimeAsset {
  id: string;       // marker + cache filename
  label: string;    // human label for progress messages
  url: string;
  sha256: string;
  bytes: number;
  version: string;  // bump (with a new archive) to force a re-download + re-extract
}

const RUNTIME_ASSETS: Record<string, RuntimeAsset> = {
  'default-voice': {
    id: 'default-voice',
    label: 'Scarlett Johansson voice',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/voice-model/default-voice-johansson.tar.gz',
    sha256: 'dc300f068b62442c95f0ccab3f84224983a402b2c7bbb178b0de4f05f860c959',
    bytes: 1738859112,
    version: '2026.06.16',
  },
  'stanza-en': {
    id: 'stanza-en',
    label: 'English language pack',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/stanzas/stanza-en.tar.gz',
    sha256: 'cf3a83493d8c0b426524bb5d000c77d2b52ed2261e8f8dfcb5021ec8bd00825f',
    bytes: 197028208,
    version: '2026.06.16',
  },
};

/** Per-asset ready-marker, kept inside the e2a runtime so it's torn down with it. */
function assetMarkerPath(id: string): string {
  return path.join(getRuntimeE2aDir(), `.bookforge-asset-${id}.json`);
}

function runtimeAssetReady(asset: RuntimeAsset): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(assetMarkerPath(asset.id), 'utf-8'));
    return m.version === asset.version && m.sha256 === asset.sha256;
  } catch {
    return false;
  }
}

const assetEnsureInFlight: Record<string, Promise<void> | undefined> = {};

async function doEnsureRuntimeAsset(
  asset: RuntimeAsset,
  onProgress?: (message: string) => void,
): Promise<void> {
  const e2aDir = getRuntimeE2aDir();
  // The asset's models/ subtree extracts into the e2a runtime root. ensureBundledE2a
  // normally creates this first; mkdir defensively in case ordering changes.
  fs.mkdirSync(e2aDir, { recursive: true });
  fs.mkdirSync(runtimeRoot(), { recursive: true });

  const cache = path.join(runtimeRoot(), `${asset.id}.tar.gz`);

  // Reuse a cached, verified archive from an interrupted prior run rather than
  // re-downloading; discard a corrupt/mismatched one.
  let haveValid = false;
  if (fs.existsSync(cache)) {
    onProgress?.(`Checking the downloaded ${asset.label}…`);
    try {
      const got = await sha256File(cache);
      haveValid = got.toLowerCase() === asset.sha256.toLowerCase();
    } catch {
      /* unreadable — re-download */
    }
    if (!haveValid) { try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ } }
  }

  if (!haveValid) {
    const mb = (n?: number) => (n != null ? Math.round(n / 1_000_000) : 0);
    let lastPct = -1;
    await downloadFile(asset.url, cache, `asset-${asset.id}`, (p) => {
      if (typeof p.pct === 'number' && p.pct !== lastPct) {
        lastPct = p.pct;
        const detail = p.totalBytes
          ? ` ${p.pct}% (${mb(p.receivedBytes)} / ${mb(p.totalBytes)} MB)`
          : '';
        onProgress?.(`Downloading the ${asset.label}…${detail}`);
      }
    });
    onProgress?.(`Verifying the ${asset.label}…`);
    const got = await sha256File(cache);
    if (got.toLowerCase() !== asset.sha256.toLowerCase()) {
      try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
      throw new Error(
        `Downloaded ${asset.label} checksum mismatch (expected ${asset.sha256}, got ${got}). The download was corrupt.`
      );
    }
  }

  onProgress?.(`Installing the ${asset.label}…`);
  await run('tar', ['-xzf', cache, '-C', e2aDir]);

  fs.writeFileSync(
    assetMarkerPath(asset.id),
    JSON.stringify({ version: asset.version, sha256: asset.sha256 }),
    'utf-8',
  );
  // Reclaim the cached archive once installed.
  try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
}

function ensureRuntimeAsset(
  asset: RuntimeAsset,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (!app.isPackaged) return Promise.resolve(); // dev uses the live e2a checkout's models
  if (runtimeAssetReady(asset)) return Promise.resolve();
  const existing = assetEnsureInFlight[asset.id];
  if (existing) return existing;
  const p = doEnsureRuntimeAsset(asset, onProgress).finally(() => { assetEnsureInFlight[asset.id] = undefined; });
  assetEnsureInFlight[asset.id] = p;
  return p;
}

/** Download + install the default Scarlett Johansson voice (+ XTTS base) if missing. */
export function ensureDefaultVoice(onProgress?: (message: string) => void): Promise<void> {
  return ensureRuntimeAsset(RUNTIME_ASSETS['default-voice'], onProgress);
}

/** Download + install the English Stanza language pack if missing. */
export function ensureEnglishStanza(onProgress?: (message: string) => void): Promise<void> {
  return ensureRuntimeAsset(RUNTIME_ASSETS['stanza-en'], onProgress);
}

/** Whether the mandatory first-run runtime assets are installed (true in dev). */
export function defaultRuntimeAssetsReady(): boolean {
  if (!app.isPackaged) return true;
  return (
    runtimeAssetReady(RUNTIME_ASSETS['default-voice']) &&
    runtimeAssetReady(RUNTIME_ASSETS['stanza-en'])
  );
}

/**
 * Whether the bundled runtime needs no further setup — i.e. there's nothing for
 * the first-run "update" (ensureBundledEnv/ensureBundledE2a/ensureDefaultVoice/
 * ensureEnglishStanza) to do. True in dev (nothing ships/downloads) and on a
 * packaged install whose env + e2a + default voice + English pack are all current.
 * Used to decide up front whether to show the first-run setup overlay.
 */
export function bundledRuntimeReady(): boolean {
  const envNeedsSetup = app.isPackaged && hasManagedEnv() && !envIsReady(getBundledEnvDir());
  const e2aNeedsSetup = hasBundledE2aSnapshot() && !e2aIsReady(getRuntimeE2aDir());
  const assetsNeedSetup = app.isPackaged && !defaultRuntimeAssetsReady();
  return !envNeedsSetup && !e2aNeedsSetup && !assetsNeedSetup;
}

// Clone-on-write where the filesystem supports it (APFS/ReFS), full copy
// elsewhere. COPYFILE_FICLONE falls back to a regular copy automatically.
const CLONE_MODE = fs.constants.COPYFILE_FICLONE;

/**
 * First-run / upgrade setup for the bundled e2a code. Idempotent: returns
 * immediately when the runtime copy matches the shipped snapshot. Returns the
 * runtime dir, or null when this build ships no snapshot (dev).
 */
let e2aEnsureInFlight: Promise<string | null> | null = null;

export async function ensureBundledE2a(onProgress?: (message: string) => void): Promise<string | null> {
  if (!hasBundledE2aSnapshot()) return null;
  if (e2aEnsureInFlight) return e2aEnsureInFlight;
  e2aEnsureInFlight = doEnsureBundledE2a(onProgress).finally(() => { e2aEnsureInFlight = null; });
  return e2aEnsureInFlight;
}

async function doEnsureBundledE2a(onProgress?: (message: string) => void): Promise<string | null> {
  const snapshotDir = getBundledE2aSnapshotDir();
  const runtimeDir = getRuntimeE2aDir();
  if (e2aIsReady(runtimeDir)) return runtimeDir;

  console.log(`[E2A-CODE] Installing bundled e2a: ${snapshotDir} -> ${runtimeDir}`);
  onProgress?.('Installing the bundled audiobook engine…');
  // In-place (to preserve downloaded models/voices on update). The marker is
  // written last, so an interrupted copy never reads as ready and is re-laid
  // (pass-1 force-overwrites the code) on the next run.
  fs.mkdirSync(runtimeRoot(), { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Pass 1 — code: overwrite so snapshot updates land. models/ and voices/
  // are excluded here; they get merge semantics below.
  //
  // ASYNC copy (fs.promises.cp), NOT fs.cpSync: this runs in the Electron MAIN
  // process, and a synchronous multi-GB copy blocks its event loop for the whole
  // duration — which starves every IPC reply the renderer is waiting on, so the
  // first-run UI freezes / becomes "very slow to respond" (worst on Windows NTFS,
  // where COPYFILE_FICLONE falls back to a full byte copy). The async form yields
  // between files, keeping IPC — and the UI — responsive while it copies.
  const skipTopLevel = new Set(['models', 'voices', E2A_SNAPSHOT_STAMP]);
  await fs.promises.cp(snapshotDir, runtimeDir, {
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
    // Async copy (see pass 1) — keeps the main-process event loop / IPC alive so
    // the setup UI stays responsive while the (potentially large) assets copy.
    await fs.promises.cp(src, path.join(runtimeDir, sub), {
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
