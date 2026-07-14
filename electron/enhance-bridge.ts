/**
 * Enhance-tab pipeline runner (local Adobe-Podcast-style speech cleanup).
 *
 * Per input file, a Process run does three GPU-aware stages into a per-file cache
 * dir under <userData>/runtime/enhance-cache/<key>:
 *   1. Decode    — ffmpeg → decoded.wav (44.1 kHz stereo working copy; video
 *                  inputs get their audio extracted here).
 *   2. Separate  — audio-separator (vocals_mel_band_roformer) → voice.wav (isolated
 *                  speech) + rest.wav (background). Runs in the RVC engine env
 *                  (rvc-env) — ultimate-rvc already depends on audio_separator, so
 *                  the package rides in that env; see getSeparatorPython().
 *   3. Enhance   — Resemble Enhance CLI on voice.wav → voice_enhanced.wav. Launched
 *                  natively (default) or through WSL2, driven entirely by the
 *                  `enhance` config block (see tool-paths EnhanceConfig).
 *
 * The sliders / preview / export read ONLY the cache — they never reprocess. The
 * two v1 sliders crossfade voice↔voice_enhanced (speech) and gain rest
 * (background); the mix code iterates a stem list so a future Music slider (3-stem
 * separation) drops in without reshaping the mixer.
 *
 * Re-Process behaviour: each stage is skipped when its output already exists and,
 * for enhance, when the cached enhance params match the requested ones. So a
 * re-Process reuses decode + separation (both param-independent) and only re-runs
 * the enhancer when its params changed. A full rebuild = Delete the row (which
 * clears the cache) then re-add.
 *
 * GPU: separation runs in rvc-env whose torch is CPU or CUDA per the installed
 * cuda-rvc overlay — i.e. the single global "Use GPU acceleration" choice, no
 * per-phase flag. The GPU stages take the shared gpu-arbiter lease so they don't
 * co-reside with a running TTS/RVC job and OOM the card.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { app, BrowserWindow } from 'electron';

import {
  getFfmpegPath,
  getFfprobePath,
  getEnhanceConfig,
  getWslDistro,
  windowsToWslPath,
  EnhanceParams,
  EnhanceLaunchMode,
} from './tool-paths';
import { getRvcEnvRoot, getRvcPython } from './rvc-bridge';
import { relocatableEnvBinDirs, relocatableBinaryPath } from './e2a-env-bootstrap';
import { componentManager } from './components/component-manager';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { destroyWslGuestProcesses } from './wsl-lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Component id for a future managed resemble-enhance env. The env is currently
 * built out-of-band (parallel workstream) and pointed at via EnhanceConfig, but
 * resolving through the component system too means it "just works" the day it
 * ships as a managed component — same shape as the other engine envs.
 */
const RESEMBLE_ENV_ID = 'resemble-env';

/** The separator's CLI entry point. The `audio-separator` console script maps to
 *  `audio_separator.utils.cli:main`; we run it as a module to dodge the stale
 *  console-script shebang baked into relocated envs (same gotcha as urvc.exe). */
const SEPARATOR_CLI_MODULE = 'audio_separator.utils.cli';

/** The separation model + stem name mapping from the proven shell invocation. */
const SEPARATOR_MODEL = 'vocals_mel_band_roformer.ckpt';
const SEPARATOR_OUTPUT_NAMES = JSON.stringify({
  vocals: 'voice',
  other: 'rest',
  Vocals: 'voice',
  Instrumental: 'rest',
});

/** Default Resemble Enhance params (used when the config block omits them). */
export const DEFAULT_ENHANCE_PARAMS: EnhanceParams = {
  nfe: 64,
  tau: 0.5,
  lambd: 0.9,
  solver: 'midpoint',
};

const MANIFEST_VERSION = 1;
const DECODED_NAME = 'decoded.wav';
const VOICE_NAME = 'voice.wav';
const REST_NAME = 'rest.wav';
const ENHANCED_NAME = 'voice_enhanced.wav';
const MANIFEST_NAME = 'manifest.json';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EnhanceProcessParams extends EnhanceParams {
  /** Pass true to run the enhancer's denoise-only mode (--denoise-only). */
  denoiseOnly: boolean;
}

export interface EnhanceProcessConfig {
  /** Absolute path to the source audio/video file. */
  sourcePath: string;
  /** Enhance params for this run. Omitted fields fall back to DEFAULT_ENHANCE_PARAMS. */
  params?: Partial<EnhanceProcessParams>;
}

export interface EnhanceProgress {
  phase: 'preparing' | 'decoding' | 'separating' | 'enhancing' | 'complete' | 'error';
  percentage: number;
  message?: string;
  error?: string;
}

/** Absolute stem paths in a file's cache (what the renderer turns into URLs). */
export interface EnhanceStems {
  voice: string;
  rest: string;
  enhanced: string;
}

export interface EnhanceCacheEntry {
  cached: boolean;
  /** True only when every stage output is present on disk. */
  complete: boolean;
  key: string;
  cacheDir: string;
  stems?: EnhanceStems;
  params?: EnhanceProcessParams;
  sampleRate?: number;
}

export interface EnhanceResult {
  success: boolean;
  data?: EnhanceCacheEntry;
  error?: string;
  wasStopped?: boolean;
}

interface EnhanceManifest {
  version: number;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  createdAt: string;
  updatedAt: string;
  stages: { decode: boolean; separate: boolean; enhance: boolean };
  enhanceParams: EnhanceProcessParams;
}

/** A single in-flight file run, so stopEnhanceProcessing can tear it down. */
interface ActiveRun {
  jobId: string;
  child: ChildProcess | null;
  /** Non-null while the current child is a WSL guest run — kill via the WSL ladder. */
  wslKillPattern: string | null;
  aborted: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

function sendProgress(win: BrowserWindow | null, jobId: string, progress: EnhanceProgress): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('enhance:progress', { jobId, progress });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache layout
// ─────────────────────────────────────────────────────────────────────────────

function enhanceCacheRoot(): string {
  return path.join(app.getPath('userData'), 'runtime', 'enhance-cache');
}

/** Where audio-separator downloads its model weights (pinned so it downloads once). */
function separatorModelDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'audio-separator-models');
}

/**
 * Stable per-file cache key from identity (path + size + mtime) — cheap even for
 * multi-GB inputs (no full-content read). A change to any of the three re-keys the
 * file, so an edited source doesn't silently reuse a stale cache.
 */
export function enhanceCacheKey(sourcePath: string, size: number, mtimeMs: number): string {
  const normalized = path.resolve(sourcePath).replace(/\\/g, '/').toLowerCase();
  const h = crypto.createHash('sha256');
  h.update(`${normalized}|${size}|${Math.round(mtimeMs)}`);
  return h.digest('hex').slice(0, 16);
}

function cacheDirFor(sourcePath: string): { key: string; dir: string } {
  const st = fs.statSync(sourcePath);
  const key = enhanceCacheKey(sourcePath, st.size, st.mtimeMs);
  return { key, dir: path.join(enhanceCacheRoot(), key) };
}

function stemsFor(dir: string): EnhanceStems {
  return {
    voice: path.join(dir, VOICE_NAME),
    rest: path.join(dir, REST_NAME),
    enhanced: path.join(dir, ENHANCED_NAME),
  };
}

function readManifest(dir: string): EnhanceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf-8')) as EnhanceManifest;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, manifest: EnhanceManifest): void {
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
}

function resolveParams(params?: Partial<EnhanceProcessParams>): EnhanceProcessParams {
  return {
    nfe: params?.nfe ?? DEFAULT_ENHANCE_PARAMS.nfe,
    tau: params?.tau ?? DEFAULT_ENHANCE_PARAMS.tau,
    lambd: params?.lambd ?? DEFAULT_ENHANCE_PARAMS.lambd,
    solver: params?.solver ?? DEFAULT_ENHANCE_PARAMS.solver,
    denoiseOnly: params?.denoiseOnly ?? false,
  };
}

function paramsEqual(a: EnhanceProcessParams, b: EnhanceProcessParams): boolean {
  return (
    a.nfe === b.nfe &&
    a.tau === b.tau &&
    a.lambd === b.lambd &&
    a.solver === b.solver &&
    a.denoiseOnly === b.denoiseOnly
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine resolution (loud, specific errors — NO silent fallback)
// ─────────────────────────────────────────────────────────────────────────────

/** The separator env's python (the RVC engine env), or throws with a fix hint. */
function getSeparatorPython(): { python: string; root: string } {
  const root = getRvcEnvRoot();
  if (!root) {
    throw new Error(
      'Speech separation needs the RVC engine env, which is not installed. ' +
        'Install it in Settings → Add-ons (it also carries the audio-separator package).'
    );
  }
  const python = getRvcPython();
  if (!python) {
    throw new Error(`The RVC engine env at ${root} has no python runtime.`);
  }
  return { python, root };
}

interface ResolvedEnhancer {
  launchMode: EnhanceLaunchMode;
  // native
  python?: string;
  envRoot?: string;
  scriptPath?: string;
  // wsl
  wslPython?: string;
  wslScript?: string;
  distro?: string;
}

/** The native resemble-enhance env root: config-pointed, else component-managed. */
function getEnhanceNativeEnvRoot(): string | null {
  const cfg = getEnhanceConfig();
  if (cfg.nativeEnvPath) return cfg.nativeEnvPath;
  return componentManager.resolveEntry(RESEMBLE_ENV_ID);
}

/**
 * Resolve the enhancer launch config into a runnable command, throwing a precise
 * error for whatever is missing so the UI can tell the user exactly what to fix.
 */
function resolveEnhancer(): ResolvedEnhancer {
  const cfg = getEnhanceConfig();
  const launchMode: EnhanceLaunchMode = cfg.launchMode ?? 'native';

  if (launchMode === 'wsl') {
    if (!cfg.wslPythonPath) {
      throw new Error(
        'Enhance is set to WSL mode but enhance.wslPythonPath is not configured ' +
          '(the Linux python of the resemble-enhance env).'
      );
    }
    if (!cfg.wslScriptPath) {
      throw new Error('Enhance is set to WSL mode but enhance.wslScriptPath (enhance_cli.py) is not configured.');
    }
    const distro = cfg.wslDistro ?? getWslDistro();
    if (!distro) {
      throw new Error('Enhance WSL mode needs a distro: set enhance.wslDistro (or the shared wslDistro).');
    }
    return { launchMode, wslPython: cfg.wslPythonPath, wslScript: cfg.wslScriptPath, distro };
  }

  // native (default)
  const envRoot = getEnhanceNativeEnvRoot();
  if (!envRoot) {
    throw new Error(
      'The Resemble Enhance env is not configured. Point enhance.nativeEnvPath at the ' +
        'resemble-enhance conda env (or install it as a managed component in Settings → Add-ons).'
    );
  }
  const python = relocatableBinaryPath(envRoot, 'python');
  if (!python) {
    throw new Error(`The resemble-enhance env at ${envRoot} has no python interpreter.`);
  }
  if (!cfg.scriptPath) {
    throw new Error('enhance.scriptPath (the enhance_cli.py path) is not configured.');
  }
  if (!fs.existsSync(cfg.scriptPath)) {
    throw new Error(`enhance.scriptPath does not exist: ${cfg.scriptPath}`);
  }
  return { launchMode, python, envRoot, scriptPath: cfg.scriptPath };
}

/**
 * Whether an Enhance run can start right now, and why not. Cheap enough to call
 * from the UI to gate the Process button / show setup hints.
 */
export function enhanceReadiness(): { ok: boolean; reason?: string } {
  try {
    getSeparatorPython();
    resolveEnhancer();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Child-process helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Kill a native child's whole process tree (taskkill /T on Windows). Never used
 *  on a WSL GUEST process — only on native children and the wsl.exe wrapper. */
function killNativeTree(child: ChildProcess, label: string): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    return;
  }
  if (os.platform() === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      // Already exited — nothing to reap.
    }
  } else {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  console.log(`[ENHANCE] killed ${label} (pid ${pid})`);
}

/** Scan a stdout/stderr chunk for the LAST "NN%" and map it into [lo, hi]. */
function scaledPercentFromChunk(chunk: string, lo: number, hi: number): number | null {
  let last: number | null = null;
  const re = /(\d{1,3})%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const p = parseInt(m[1], 10);
    if (p >= 0 && p <= 100) last = p;
  }
  if (last === null) return null;
  return Math.round(lo + (hi - lo) * (last / 100));
}

/**
 * Spawn a stage's child, track it on `run`, and resolve/reject on close. Rejects
 * with 'cancelled' when the run was aborted. `onChunk` sees every stdout+stderr
 * chunk (for progress parsing). `wslKillPattern` set ⇒ the child is a WSL guest
 * run and stop() must use the WSL-safe kill ladder, never SIGKILL.
 */
function execStage(
  run: ActiveRun,
  child: ChildProcess,
  opts: { onChunk?: (chunk: string) => void; wslKillPattern?: string | null }
): Promise<void> {
  run.child = child;
  run.wslKillPattern = opts.wslKillPattern ?? null;

  return new Promise<void>((resolve, reject) => {
    let tail = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      opts.onChunk?.(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      run.child = null;
      run.wslKillPattern = null;
      reject(err);
    });
    child.on('close', (code) => {
      run.child = null;
      run.wslKillPattern = null;
      if (run.aborted) { reject(new Error('cancelled')); return; }
      if (code === 0) { resolve(); return; }
      reject(new Error(`exited with code ${code}: ${tail.trim()}`));
    });
  });
}

/** Shell-quote a single arg for a WSL `bash -c` command (single-quote wrapped). */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stages
// ─────────────────────────────────────────────────────────────────────────────

async function stageDecode(run: ActiveRun, sourcePath: string, decodedPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const args = [
    '-y',
    '-i', sourcePath,
    '-vn',                    // drop any video track — we only want audio
    '-ac', '2',               // stereo
    '-ar', '44100',           // 44.1 kHz working copy
    '-c:a', 'pcm_s16le',
    decodedPath,
  ];
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await execStage(run, child, {});
  if (!fs.existsSync(decodedPath)) {
    throw new Error('decode produced no output — the input may not contain a decodable audio track.');
  }
}

async function stageSeparate(
  run: ActiveRun,
  decodedPath: string,
  cacheDir: string,
  onPercent: (pct: number) => void
): Promise<void> {
  const { python, root } = getSeparatorPython();
  const modelDir = separatorModelDir();
  fs.mkdirSync(modelDir, { recursive: true });

  const args = [
    '-m', SEPARATOR_CLI_MODULE,
    decodedPath,
    '--model_filename', SEPARATOR_MODEL,
    '--output_dir', cacheDir,
    '--output_format', 'WAV',
    '--model_file_dir', modelDir,
    '--custom_output_names', SEPARATOR_OUTPUT_NAMES,
  ];

  // Env bin dirs on PATH so the env's ffmpeg/sox resolve. KMP_DUPLICATE_LIB_OK
  // guards the env's multiple bundled OpenMP runtimes (same rvc-env gotcha).
  const pathValue = [...relocatableEnvBinDirs(root), process.env.PATH || ''].join(path.delimiter);
  const child = spawn(python, args, {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: pathValue,
      Path: pathValue,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      KMP_DUPLICATE_LIB_OK: 'TRUE',
    },
  });

  await execStage(run, child, {
    onChunk: (chunk) => {
      const pct = scaledPercentFromChunk(chunk, 15, 70);
      if (pct !== null) onPercent(pct);
    },
  });

  const stems = stemsFor(cacheDir);
  if (!fs.existsSync(stems.voice) || !fs.existsSync(stems.rest)) {
    throw new Error('separation did not produce voice.wav + rest.wav — check the audio-separator model.');
  }
}

async function stageEnhance(
  run: ActiveRun,
  enhancer: ResolvedEnhancer,
  voicePath: string,
  enhancedPath: string,
  params: EnhanceProcessParams,
  onPercent: (pct: number) => void
): Promise<void> {
  const numeric = [
    '--nfe', String(params.nfe),
    '--tau', String(params.tau),
    '--lambd', String(params.lambd),
    '--solver', params.solver,
    ...(params.denoiseOnly ? ['--denoise-only'] : []),
  ];

  let child: ChildProcess;
  let wslKillPattern: string | null = null;

  if (enhancer.launchMode === 'wsl') {
    // Convert the Windows cache paths (on /mnt/c/...) for the guest.
    const wslInput = windowsToWslPath(voicePath);
    const wslOutput = windowsToWslPath(enhancedPath);
    const cmdParts = [
      enhancer.wslPython!,
      enhancer.wslScript!,
      '--input', wslInput,
      '--output', wslOutput,
      ...numeric,
    ].map(shellQuote);
    const bashCommand = `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 && ${cmdParts.join(' ')}`;
    const wslArgs = ['-d', enhancer.distro!, 'bash', '-c', bashCommand];
    // Target ONLY this run's guest process for a stop: the enhanced output path
    // carries this file's unique cache key, so it never matches another job.
    wslKillPattern = `enhance_cli\\.py.*${path.basename(path.dirname(enhancedPath))}`;
    child = spawn('wsl.exe', wslArgs, { env: process.env, shell: false, windowsHide: true });
  } else {
    const args = [
      enhancer.scriptPath!,
      '--input', voicePath,
      '--output', enhancedPath,
      ...numeric,
    ];
    const pathValue = [...relocatableEnvBinDirs(enhancer.envRoot!), process.env.PATH || ''].join(path.delimiter);
    child = spawn(enhancer.python!, args, {
      cwd: enhancer.envRoot!,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: pathValue,
        Path: pathValue,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
  }

  await execStage(run, child, {
    wslKillPattern,
    onChunk: (chunk) => {
      const pct = scaledPercentFromChunk(chunk, 70, 99);
      if (pct !== null) onPercent(pct);
    },
  });

  if (!fs.existsSync(enhancedPath)) {
    throw new Error('the enhancer produced no output — check the enhance CLI configuration.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** ffprobe an input for the UI file row (duration + size). */
export async function probeEnhanceInput(sourcePath: string): Promise<{ durationSec: number; sizeBytes: number }> {
  const st = fs.statSync(sourcePath);
  const ffprobe = getFfprobePath();
  const out = execSync(
    `"${ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${sourcePath}"`,
    { encoding: 'utf-8', windowsHide: true }
  ).trim();
  const durationSec = parseFloat(out);
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    sizeBytes: st.size,
  };
}

/** Inspect a file's cache without processing (for restoring UI state on load). */
export function getEnhanceCacheEntry(sourcePath: string): EnhanceCacheEntry {
  const { key, dir } = cacheDirFor(sourcePath);
  if (!fs.existsSync(dir)) {
    return { cached: false, complete: false, key, cacheDir: dir };
  }
  const manifest = readManifest(dir);
  const stems = stemsFor(dir);
  const complete =
    !!manifest &&
    manifest.stages.decode &&
    manifest.stages.separate &&
    manifest.stages.enhance &&
    fs.existsSync(stems.voice) &&
    fs.existsSync(stems.rest) &&
    fs.existsSync(stems.enhanced);
  return {
    cached: true,
    complete,
    key,
    cacheDir: dir,
    stems: complete ? stems : undefined,
    params: manifest?.enhanceParams,
  };
}

/** Delete a file's cache dir (used by the row Delete button). */
export function clearEnhanceCache(sourcePath: string): void {
  const { dir } = cacheDirFor(sourcePath);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Run (or resume) the Process pipeline for one file. Resolves with the completed
 * cache entry; progress flows out-of-band via 'enhance:progress'. Stages already
 * present on disk are skipped (see the module header).
 */
export async function runEnhanceProcessing(
  jobId: string,
  config: EnhanceProcessConfig,
  mainWindow: BrowserWindow | null
): Promise<EnhanceResult> {
  if (!fs.existsSync(config.sourcePath)) {
    return { success: false, error: `File not found: ${config.sourcePath}` };
  }

  // Fail fast on missing engine/config BEFORE taking the GPU lease.
  let enhancer: ResolvedEnhancer;
  try {
    getSeparatorPython();
    enhancer = resolveEnhancer();
  } catch (err) {
    const error = (err as Error).message;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  const params = resolveParams(config.params);
  const { key, dir } = cacheDirFor(config.sourcePath);
  fs.mkdirSync(dir, { recursive: true });
  const decodedPath = path.join(dir, DECODED_NAME);
  const stems = stemsFor(dir);

  const st = fs.statSync(config.sourcePath);
  const now = new Date().toISOString();
  const prev = readManifest(dir);
  const manifest: EnhanceManifest = prev ?? {
    version: MANIFEST_VERSION,
    sourcePath: config.sourcePath,
    sourceSize: st.size,
    sourceMtimeMs: st.mtimeMs,
    createdAt: now,
    updatedAt: now,
    stages: { decode: false, separate: false, enhance: false },
    enhanceParams: params,
  };

  const run: ActiveRun = { jobId, child: null, wslKillPattern: null, aborted: false };
  activeRuns.set(jobId, run);

  const gpuOwner = `enhance:job:${jobId}`;
  let gpuHeld = false;

  const persist = () => {
    manifest.updatedAt = new Date().toISOString();
    writeManifest(dir, manifest);
  };

  try {
    // What still needs doing? Decode + separate are param-independent; enhance is
    // redone when its params changed (or its output is missing).
    const needDecode = !fs.existsSync(decodedPath);
    const needSeparate = needDecode || !fs.existsSync(stems.voice) || !fs.existsSync(stems.rest);
    const needEnhance =
      needSeparate ||
      !fs.existsSync(stems.enhanced) ||
      !prev ||
      !paramsEqual(prev.enhanceParams, params);

    if (!needDecode && !needSeparate && !needEnhance) {
      // Fully cached with matching params — nothing to do, no GPU needed.
      sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Already processed.' });
      activeRuns.delete(jobId);
      return { success: true, data: getEnhanceCacheEntry(config.sourcePath) };
    }

    // Only the separation + enhancement stages are GPU-bound.
    if (needSeparate || needEnhance) {
      sendProgress(mainWindow, jobId, { phase: 'preparing', percentage: 0, message: 'Waiting for the GPU…' });
      await acquireGpu(gpuOwner, { timeoutMs: 10 * 60_000 });
      gpuHeld = true;
    }

    if (needDecode) {
      sendProgress(mainWindow, jobId, { phase: 'decoding', percentage: 5, message: 'Decoding audio…' });
      await stageDecode(run, config.sourcePath, decodedPath);
      manifest.stages.decode = true;
      // A fresh decode invalidates downstream stems.
      manifest.stages.separate = false;
      manifest.stages.enhance = false;
      persist();
    }

    if (needSeparate) {
      sendProgress(mainWindow, jobId, { phase: 'separating', percentage: 15, message: 'Separating speech from background…' });
      await stageSeparate(run, decodedPath, dir, (pct) =>
        sendProgress(mainWindow, jobId, { phase: 'separating', percentage: pct, message: 'Separating speech from background…' })
      );
      manifest.stages.separate = true;
      manifest.stages.enhance = false;
      persist();
    }

    if (needEnhance) {
      sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: 70, message: 'Enhancing speech…' });
      await stageEnhance(run, enhancer, stems.voice, stems.enhanced, params, (pct) =>
        sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: pct, message: 'Enhancing speech…' })
      );
      manifest.stages.enhance = true;
      manifest.enhanceParams = params;
      persist();
    }

    activeRuns.delete(jobId);
    sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Done.' });
    return { success: true, data: getEnhanceCacheEntry(config.sourcePath) };
  } catch (err) {
    activeRuns.delete(jobId);
    const wasStopped = run.aborted || (err as Error).message === 'cancelled';
    persist(); // keep whatever stages completed so a re-Process resumes
    const error = wasStopped ? 'Enhancement stopped.' : `Enhancement failed: ${(err as Error).message}`;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error, wasStopped };
  } finally {
    if (gpuHeld) releaseGpu(gpuOwner);
  }
}

/**
 * Stop a file's in-flight pipeline. Native children are reaped by process-tree
 * kill; a WSL enhance run uses the WSL-safe TERM→verify→escalate ladder (NEVER
 * SIGKILL a guest GPU process — it wedges CUDA in the guest until reboot).
 */
export async function stopEnhanceProcessing(jobId: string): Promise<void> {
  const run = activeRuns.get(jobId);
  if (!run) return;
  run.aborted = true;
  const child = run.child;
  if (run.wslKillPattern) {
    console.log(`[ENHANCE] stopping WSL guest for ${jobId} (no SIGKILL)`);
    await destroyWslGuestProcesses(run.wslKillPattern, { label: `enhance:${jobId}` });
    // Only after the guest is confirmed dead, reap the wsl.exe wrapper on Windows.
    if (child) killNativeTree(child, `enhance-wsl-wrapper:${jobId}`);
  } else if (child) {
    killNativeTree(child, `enhance:${jobId}`);
  }
}

export function isEnhanceProcessingActive(jobId: string): boolean {
  return activeRuns.has(jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / mix
// ─────────────────────────────────────────────────────────────────────────────

export interface EnhanceExportConfig {
  sourcePath: string;
  outputPath: string;
  /** 0 = original isolated speech, 1 = fully enhanced speech (crossfade). */
  speech: number;
  /** 0 = background removed, 1 = background at original level (stem gain). */
  background: number;
}

/**
 * Render the final mix to disk at the current slider gains: pcm_s24le WAV, sample
 * rate preserved from the cached stems. Reads ONLY the cache. The stem list is
 * built here so a future Music slider adds one entry and one gain, nothing else.
 */
export async function exportEnhanceMix(config: EnhanceExportConfig): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const entry = getEnhanceCacheEntry(config.sourcePath);
  if (!entry.complete || !entry.stems) {
    return { success: false, error: 'This file has not been fully processed yet — run Process first.' };
  }
  const { voice, rest, enhanced } = entry.stems;

  const speech = clamp01(config.speech);
  const background = clamp01(config.background);

  // Mix inputs (order matches the -i order below). A future Music stem appends here.
  const inputs: { path: string; gain: number }[] = [
    { path: voice, gain: 1 - speech },
    { path: enhanced, gain: speech },
    { path: rest, gain: background },
  ];

  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();

  // Preserve the stems' sample rate.
  let sampleRate = 44100;
  try {
    const sr = execSync(
      `"${ffprobe}" -v error -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "${voice}"`,
      { encoding: 'utf-8', windowsHide: true }
    ).trim().split('\n')[0];
    const parsed = parseInt(sr, 10);
    if (Number.isFinite(parsed) && parsed > 0) sampleRate = parsed;
  } catch {
    // Fall through to 44.1k (the decode target) — not a masked bug, the working
    // copies are decoded at 44.1k, so this is the known stem rate.
  }

  const inputArgs = inputs.flatMap((i) => ['-i', i.path]);
  const filterParts = inputs.map((i, idx) => `[${idx}:a]volume=${i.gain.toFixed(4)}[a${idx}]`);
  const mixLabels = inputs.map((_, idx) => `[a${idx}]`).join('');
  const filter = `${filterParts.join(';')};${mixLabels}amix=inputs=${inputs.length}:normalize=0[out]`;

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:a', 'pcm_s24le',
    '-ar', String(sampleRate),
    config.outputPath,
  ];

  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => resolve({ success: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(config.outputPath)) {
        resolve({ success: true, outputPath: config.outputPath });
      } else {
        resolve({ success: false, error: `Export failed (ffmpeg exit ${code}): ${tail.trim()}` });
      }
    });
  });
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
