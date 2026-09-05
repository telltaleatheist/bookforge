/**
 * THE TOOLS ENVIRONMENT — a relocatable Python (conda-pack), downloaded on first
 * run and unpacked under `<userData>/runtime/tools-env`.
 *
 * It is the python that runs everything BookForge needs that is NOT a TTS engine:
 * `narrator.compat.app` for assembly / resume / list, whisper and whisperx, the
 * metadata tools, and the ffmpeg / ffprobe / sox / mediainfo binaries the enhance
 * and denoise paths shell out to. The frozen env is built per-platform (from
 * `packaging/env/*.yml`), packed with conda-pack, and published as a GitHub
 * release asset (see ENV_RELEASES). On first run a packaged build downloads the
 * platform's tarball, verifies its sha256, extracts it under userData, and runs
 * the env's `conda-unpack` script to rewrite the prefix paths baked in at pack
 * time. From then on every tools spawn invokes the env's python directly — no
 * conda on the target machine.
 *
 * ── Phase 6: it used to live inside the ebook2audiobook checkout ─────────────
 *
 * Until 2026-09-05 this file was `e2a-env-bootstrap.ts`, the unpack target was
 * `<userData>/runtime/e2a-env`, and there was a SECOND payload beside it: a
 * snapshot of the whole ebook2audiobook source tree, staged into `resources/e2a`
 * by the packager and copied to `<userData>/runtime/e2a` on first run. Nothing
 * read that tree any more — `e2aIsReady` had already stopped asking about
 * `app.py`, and the only thing anything resolved out of it was `python_env`,
 * which the packager EXCLUDED from the snapshot. So it shipped a source tree the
 * app could not run and could not have used. It is gone, and with it the
 * `stanza-en` runtime asset, which existed for e2a's `lib/core.py` pipeline;
 * narrator's packer records (in `text/sentences.py`) that stanza is never
 * consulted on the Orpheus path, and `test_text_paragraph_packer.py` asserts the
 * module cannot even import it.
 *
 * The RELEASE ARTIFACT is unchanged — same URL, same sha256, same bytes. Only
 * the directory it unpacks into is renamed, and `migrateLegacyToolsEnvDir()`
 * renames an existing one in place rather than re-downloading 1.8 GB.
 *
 * Readiness is keyed on ENV_VERSION + the artifact sha256 (recorded in the
 * ready-marker): bumping ENV_VERSION or publishing a new tarball forces a
 * re-download + re-unpack. The downloaded tarball is cached under userData
 * across retries, then deleted once a build succeeds to reclaim its ~1.8 GB.
 *
 * Resolution (getActiveToolsEnvPath):
 *   1. BOOKFORGE_TOOLS_ENV — points at an already-unpacked relocatable env.
 *      Set but invalid → throw (a configured override must not be ignored).
 *   2. The unpacked env under userData. A PACKAGED build additionally requires
 *      the ready-marker to match this build's ENV_VERSION + sha256; a DEV run
 *      requires only that the interpreter is there, because dev never downloads
 *      and the env it finds was laid down by some earlier packaged build.
 *   3. null — no env unpacked here yet; `narrator-paths.ts` decides what that
 *      means and refuses BY NAME.
 */

import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { downloadFile, sha256File, osTarBin } from './components/downloader';

const TARBALL_NAME = 'tools-env.tar.gz';
const READY_MARKER = '.bookforge-env-ready.json';

/** The pre-Phase-6 unpack directory, renamed in place by migrateLegacyToolsEnvDir(). */
const LEGACY_ENV_DIRNAME = 'e2a-env';
/** The pre-Phase-6 override variable. Refused by name — see toolsEnvOverride(). */
const LEGACY_ENV_OVERRIDE = 'BOOKFORGE_E2A_ENV';

// Readiness is invalidated by EITHER a version bump or a changed tarball sha256.
// A new tarball's sha alone refreshes exactly the platforms whose artifact
// changed; ENV_VERSION is GLOBAL to all platforms, so bump it only for a
// semantic change that must force every platform to rebuild even with
// unchanged tarballs (e.g. unpack-layout or marker-format changes).
//
// PHASE 6 DID NOT BUMP IT, deliberately. The tarball's bytes did not change —
// only the name of the directory it is extracted into — and an existing unpack
// is RENAMED rather than rebuilt, so its marker stays valid and correct. Bumping
// would have forced every installed copy to re-download 1.8 GB to obtain the
// identical env.
const ENV_VERSION = '2026.06.16';

interface EnvRelease {
  url: string;
  sha256: string;
  bytes: number;
}

// Per-platform conda-pack tarballs, published as GitHub release assets. A
// platform/arch with no entry has no managed env — resolution then refuses.
//
// The asset FILENAMES still say `e2a-env`: they are published artifacts with a
// fixed URL and a recorded sha256, and renaming them would invalidate every
// installed copy's marker for no gain. The name in the URL is history; the
// directory it lands in is the thing that had to stop lying.
const ENV_RELEASES: Record<string, EnvRelease> = {
  'win32-x64': {
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/e2a-env-windows-x64.tar.gz',
    sha256: 'ece7471e90a529ed192958ce1eb205a4145061e3bbb1e14721acaf92983d0090',
    bytes: 1842123032,
  },
  'darwin-arm64': {
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/e2a-env-macos-arm64.tar.gz',
    sha256: '1bbc63bf1af30babae38b2b795e1a2e938a9f5a231b649ac346d1abbb554f478',
    bytes: 1728116297,
  },
};

/** The env release artifact for this platform/arch, or null if none exists. */
function envReleaseForThisPlatform(): EnvRelease | null {
  return ENV_RELEASES[`${process.platform}-${process.arch}`] ?? null;
}

/** Where the tools environment is unpacked. */
export function getToolsEnvDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'tools-env');
}

/**
 * ONE-TIME MOVE: `<userData>/runtime/e2a-env` → `<userData>/runtime/tools-env`.
 *
 * A rename, not a re-download. The tarball is unchanged, the ready-marker inside
 * the directory is still true of it, and the env is relocatable only in the
 * conda-unpack sense — its baked prefixes were rewritten at unpack time to the
 * OLD absolute path. That sounds like it should break, and it does not: every
 * caller runs the interpreter by absolute path and BookForge prepends the env's
 * own bin dirs to PATH (`buildToolsSpawnEnv`), which is what a conda activation
 * does. The stale prefix would only matter to something that read
 * `sys.prefix`-derived paths off the packed metadata, and the smoke test below
 * is what proves the interpreter still starts after the move.
 *
 * Idempotent and best-effort: called once at startup, before anything resolves
 * an env. A failure leaves the legacy directory alone and the new name absent,
 * which resolution then reports BY NAME rather than silently using the old path.
 */
export function migrateLegacyToolsEnvDir(): void {
  const target = getToolsEnvDir();
  if (fs.existsSync(target)) return;
  const legacy = path.join(app.getPath('userData'), 'runtime', LEGACY_ENV_DIRNAME);
  if (!fs.existsSync(legacy)) return;
  try {
    fs.renameSync(legacy, target);
    console.log(`[TOOLS-ENV] Migrated the tools environment: ${legacy} -> ${target}`);
  } catch (err) {
    console.error(
      `[TOOLS-ENV] Could not rename ${legacy} to ${target}. The tools environment will be ` +
        'reported as missing until this succeeds (or the env is re-downloaded).',
      err,
    );
  }
}

/** Direct python executable inside a relocatable env (no conda involved). */
export function relocatablePythonPath(envDir: string): string {
  return process.platform === 'win32'
    ? path.join(envDir, 'python.exe')
    : path.join(envDir, 'bin', 'python');
}

/**
 * PATH entries a relocatable env needs in front of the spawn PATH — the same
 * set `conda activate` would prepend. narrator's assembly resolves ffmpeg /
 * ffprobe / sox / mediainfo via shutil.which, so these must be visible.
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
 * The BOOKFORGE_TOOLS_ENV override, and the refusal of its old spelling.
 *
 * `BOOKFORGE_E2A_ENV` named the same thing until Phase 6. It is REFUSED rather
 * than accepted-as-an-alias: a machine that still exports it is a machine whose
 * shell profile or CI job would keep working by accident while every other name
 * in the app said tools-env, and the first time the two disagreed nothing would
 * report it.
 */
function toolsEnvOverride(): string | null {
  const legacy = process.env[LEGACY_ENV_OVERRIDE];
  if (legacy && legacy.trim()) {
    throw new Error(
      `${LEGACY_ENV_OVERRIDE} is set (${legacy.trim()}). It was renamed to BOOKFORGE_TOOLS_ENV ` +
        'when the tools environment stopped being an ebook2audiobook artifact. Rename the ' +
        'variable — it is refused rather than honoured so nothing keeps working by accident.',
    );
  }
  const override = process.env.BOOKFORGE_TOOLS_ENV;
  return override && override.trim() ? override.trim() : null;
}

/**
 * The relocatable tools env to use, or null when none is unpacked here.
 * Synchronous and cheap — called on every spawn resolution.
 */
export function getActiveToolsEnvPath(): string | null {
  const override = toolsEnvOverride();
  if (override) {
    if (!fs.existsSync(relocatablePythonPath(override))) {
      throw new Error(
        `BOOKFORGE_TOOLS_ENV is set to "${override}" but no python executable was found at ` +
        `"${relocatablePythonPath(override)}". Unset the variable or point it at an unpacked env.`
      );
    }
    return override;
  }

  const envDir = getToolsEnvDir();
  // PACKAGED: the marker must match THIS build's ENV_VERSION + sha256, so an
  // env left by an older build is rebuilt rather than silently used.
  if (app.isPackaged) return envIsReady(envDir) ? envDir : null;
  // DEV: no download ever runs, so there is no version to be behind. The env
  // found here was laid down by a packaged build on this machine and the only
  // question worth asking is whether its interpreter is there. (Before Phase 6
  // dev refused this directory outright and fell back to `<e2a>/python_env` —
  // which is exactly the dependency Phase 6 removes.)
  return fs.existsSync(relocatablePythonPath(envDir)) ? envDir : null;
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

/** Where the env tarball downloads to — cached across retries, deleted on success. */
function envTarballCachePath(): string {
  return path.join(runtimeRoot(), TARBALL_NAME);
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
 * First-run setup: download the env tarball, extract it under userData and run
 * its conda-unpack. Idempotent — returns immediately when the env is already
 * unpacked and matches the published tarball. Returns the env dir, or null when
 * this platform has no published env (dev).
 *
 * conda-unpack must be invoked through the env's own python: its shebang is
 * `#!/usr/bin/env python`, and a clean target machine has no python on PATH.
 */
let envEnsureInFlight: Promise<string | null> | null = null;

export async function ensureToolsEnv(onProgress?: (message: string) => void): Promise<string | null> {
  if (toolsEnvOverride()) return getActiveToolsEnvPath();
  // Dev never downloads 1.8 GB behind the developer's back: it uses whatever a
  // packaged build already unpacked here, or refuses by name.
  if (!app.isPackaged) return null;
  if (!hasManagedEnv()) return null;

  // Never run two builds at once (atomic publish makes it safe, but it's wasteful).
  if (envEnsureInFlight) return envEnsureInFlight;
  envEnsureInFlight = doEnsureToolsEnv(onProgress).finally(() => { envEnsureInFlight = null; });
  return envEnsureInFlight;
}

// ─────────────────────────────────────────────────────────────────────────────
// First-run download progress → setup ETA
//
// The mandatory download is a known size, so a live speed measurement
// (bytes ÷ elapsed) gives a usable "about N min left". Download-only accounting
// — the extract/conda-unpack tail isn't byte-measured (the UI shows "finishing").
// ─────────────────────────────────────────────────────────────────────────────

let dlTotalBytes = 0;
let dlCompletedBytes = 0; // bytes from phases whose download finished
let dlCurrentBytes = 0;   // bytes received in the active phase
let dlStartMs = 0;

/** Reset + size the mandatory-download tracker. Call once before the update. */
export function beginSetupDownload(): void {
  const env = envReleaseForThisPlatform();
  dlTotalBytes = env ? env.bytes : 0;
  dlCompletedBytes = 0;
  dlCurrentBytes = 0;
  dlStartMs = Date.now();
}

function dlReport(received: number): void {
  if (dlStartMs !== 0) dlCurrentBytes = received;
}
function dlComplete(phaseBytes: number): void {
  if (dlStartMs === 0) return;
  dlCompletedBytes += phaseBytes;
  dlCurrentBytes = 0;
}

export interface SetupDownload {
  downloadedBytes: number;
  totalBytes: number;
  etaSeconds: number | null;
}

/** Live mandatory-download progress + ETA, or null when none is in flight. */
export function setupDownloadProgress(): SetupDownload | null {
  if (dlTotalBytes <= 0 || dlStartMs === 0) return null;
  const downloadedBytes = Math.min(dlCompletedBytes + dlCurrentBytes, dlTotalBytes);
  const elapsed = (Date.now() - dlStartMs) / 1000;
  // Warm up before trusting the speed — early samples are noisy.
  const speed = elapsed > 3 && downloadedBytes > 0 ? downloadedBytes / elapsed : 0;
  const remaining = Math.max(0, dlTotalBytes - downloadedBytes);
  const etaSeconds = speed > 0 ? Math.round(remaining / speed) : null;
  return { downloadedBytes, totalBytes: dlTotalBytes, etaSeconds };
}

async function downloadEnvTarball(
  release: EnvRelease,
  destPath: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const mb = (n?: number) => (n != null ? Math.round(n / 1_000_000) : 0);
  let lastPct = -1;
  await downloadFile(release.url, destPath, 'tools-env', (p) => {
    dlReport(p.receivedBytes ?? 0);
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
      console.warn('[TOOLS-ENV] Cached env tarball checksum mismatch — re-downloading.');
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

async function doEnsureToolsEnv(onProgress?: (message: string) => void): Promise<string | null> {
  const release = envReleaseForThisPlatform();
  if (!release) return null;

  const envDir = getToolsEnvDir();

  // Healthy AND verified → nothing to do. A marker-ready env that fails its
  // self-test is corrupt (the classic "set up but doesn't work") — rebuild it.
  if (envIsReady(envDir)) {
    if (smokeTestEnv(envDir)) return envDir;
    console.warn('[TOOLS-ENV] Env is marked ready but failed its self-test — rebuilding (corruption).');
    onProgress?.('Repairing a corrupted text-to-speech runtime…');
  } else if (fs.existsSync(envDir)) {
    console.warn('[TOOLS-ENV] Env present but incomplete — rebuilding.');
  }

  fs.mkdirSync(runtimeRoot(), { recursive: true });
  sweepStale(envDir);

  // Fetch (or reuse a cached) sha256-verified tarball before building.
  const tarball = await ensureTarballDownloaded(release, onProgress);
  dlComplete(release.bytes);

  const tempDir = `${envDir}.tmp-${process.pid}-${Date.now()}`;
  console.log(`[TOOLS-ENV] Building Python env: ${tarball} -> ${tempDir}`);
  onProgress?.('Preparing the text-to-speech runtime (one-time setup)…');
  removeDirRobust(tempDir);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // bsdtar ships with macOS and with Windows 10 1803+ (System32\tar.exe). Pin to its absolute
    // path (osTarBin) so a GNU tar earlier on PATH can't misread the "C:\…" drive-letter paths.
    onProgress?.('Extracting Python environment…');
    await run(osTarBin(), ['-xzf', tarball, '-C', tempDir]);

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

    console.log('[TOOLS-ENV] Python env ready:', envDir);
    onProgress?.('Text-to-speech runtime ready.');
    return envDir;
  } catch (err) {
    removeDirRobust(tempDir);           // never leave a half-built temp behind
    // Keep the verified tarball cached so a retry doesn't re-download ~1.8 GB.
    throw err;
  }
}

/**
 * Whether the bundled runtime needs no further setup — i.e. there's nothing for
 * the first-run "update" (ensureToolsEnv) to do. True in dev (nothing
 * downloads) and on a packaged install whose tools env is current.
 * Used to decide up front whether to show the first-run setup overlay.
 */
export function bundledRuntimeReady(): boolean {
  const envNeedsSetup = app.isPackaged && hasManagedEnv() && !envIsReady(getToolsEnvDir());
  return !envNeedsSetup;
}
