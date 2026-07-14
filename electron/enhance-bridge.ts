/**
 * Enhance-tab pipeline runner (local Adobe-Podcast-style speech cleanup).
 *
 * Per input file, a Process run always cleans to the maximum — four GPU-aware
 * stages into a per-file cache dir under <userData>/runtime/enhance-cache/<key>:
 *   1. Decode    — ffmpeg → decoded.wav (44.1 kHz stereo working copy; video
 *                  inputs get their audio extracted here).
 *   2. Separate  — audio-separator (vocals_mel_band_roformer) → voice.wav (isolated
 *                  speech) + rest.wav (background). Runs in the RVC engine env
 *                  (rvc-env) — ultimate-rvc already depends on audio_separator, so
 *                  the package rides in that env; see getSeparatorPython().
 *   3. Denoise   — Resemble Enhance CLI in --denoise-only (mask-based) mode on
 *                  voice.wav → voice_denoised.wav. Param-independent for caching
 *                  (the mask denoiser ignores the CFM tuning knobs).
 *   4. Enhance   — Resemble Enhance CLI on the RAW voice.wav (NOT the denoised
 *                  stem — pre-denoising the enhancer's input measurably increases
 *                  wobble; ear-validated) → voice_enhanced.wav. Launched natively
 *                  (default) or through WSL2, driven entirely by the `enhance`
 *                  config block (see tool-paths EnhanceConfig).
 *
 * The sliders / preview / export read ONLY the cache — they never reprocess.
 *
 * Speech-slider semantics (IMPORTANT): the slider spans voice_denoised.wav (0%,
 * the mask-denoised floor — "just denoise" = enhancement at 0%) to
 * voice_enhanced.wav (100%). Resemble Enhance re-synthesizes the waveform
 * phase-decorrelated and micro-shifted from its input, so a time-domain
 * crossfade of those two stems at intermediate gains sums two unaligned copies
 * of the same voice — audible doubling + comb-filter mud (ear-validated; the
 * 50/50 sum measured ~50% worse on the flutter metric than either endpoint).
 * Export therefore renders intermediate Speech values in the STFT domain
 * (scripts/enhance_spectral_blend.py: magnitude interpolation, phase from the
 * enhanced render), cached per slider value as blend_<pct>.wav; the k=0 / k=1
 * endpoints use voice_denoised.wav / voice_enhanced.wav directly. The Background
 * slider stays a plain gain — rest.wav is a different source, not a phase-twin,
 * so summing it is correct. The mix code iterates a stem list so a future Music
 * slider (3-stem separation) drops in without reshaping the mixer.
 *
 * Re-Process behaviour: each stage is skipped when its output already exists and,
 * for enhance, when the cached enhance params match the requested ones. So a
 * re-Process reuses decode + separation + denoise (all param-independent) and
 * only re-runs the enhancer when its params changed (which also invalidates
 * cached blends). A full rebuild = Delete the row (which clears the cache) then
 * re-add. Per-file Advanced param overrides persist in the manifest
 * (setEnhanceOverrides) and merge over the config-block defaults.
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
import { toUnpackedPath } from './e2a-paths';
import { getRvcEnvRoot, getRvcPython } from './rvc-bridge';
import { relocatableEnvBinDirs, relocatableBinaryPath } from './e2a-env-bootstrap';
import { componentManager } from './components/component-manager';
import { RESEMBLE_ENV_ID } from './components/resemble-env';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { destroyWslGuestProcesses } from './wsl-lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// The managed Resemble Enhance env component. Resolving through the component
// system means installing it in Settings → Add-ons is all it takes for the
// Enhance tab's native launch mode to work; a user-pointed enhance.nativeEnvPath
// still overrides it (see getEnhanceNativeEnvRoot).

// The separator is invoked via the shipped run_audio_separator.py launcher — the
// `audio-separator` console script maps to audio_separator.utils.cli:main but the
// module has no __main__ guard (so `-m` is a silent no-op), and the .exe launcher
// has a stale relocated-env shebang. See resolveSeparatorLauncher().

/** The separation model + stem name mapping from the proven shell invocation. */
const SEPARATOR_MODEL = 'vocals_mel_band_roformer.ckpt';
const SEPARATOR_OUTPUT_NAMES = JSON.stringify({
  vocals: 'voice',
  other: 'rest',
  Vocals: 'voice',
  Instrumental: 'rest',
});

/**
 * Default Resemble Enhance params (used when the config block omits them) — the
 * tuning session's locked production recipe. smartChunk (silence-aware chunking,
 * required for long files), seeds (spectral-median ensemble) and anchor
 * (envelope anchoring) ride the same open-dict pass-through as the CFM knobs.
 */
export const DEFAULT_ENHANCE_PARAMS: EnhanceParams = {
  nfe: 64,
  tau: 0.75,
  lambd: 0.1,
  solver: 'midpoint',
  smartChunk: true,
  seeds: 5,
  anchor: true,
};

const MANIFEST_VERSION = 2;
const DECODED_NAME = 'decoded.wav';
const VOICE_NAME = 'voice.wav';
const REST_NAME = 'rest.wav';
const DENOISED_NAME = 'voice_denoised.wav';
const ENHANCED_NAME = 'voice_enhanced.wav';
const MANIFEST_NAME = 'manifest.json';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Params for one Process run: the open enhancer-CLI dict (see EnhanceParams in
 * tool-paths — keys map camelCase → --kebab-case, booleans are presence flags,
 * e.g. denoiseOnly: true → --denoise-only).
 */
export type EnhanceProcessParams = EnhanceParams;

export interface EnhanceProcessConfig {
  /** Absolute path to the source audio/video file. */
  sourcePath: string;
  /** Enhance params for this run. Merged over the config block's defaults, which
   *  sit over DEFAULT_ENHANCE_PARAMS. */
  params?: EnhanceProcessParams;
}

export interface EnhanceProgress {
  phase: 'preparing' | 'decoding' | 'separating' | 'denoising' | 'enhancing' | 'complete' | 'error';
  percentage: number;
  message?: string;
  error?: string;
}

/** Absolute stem paths in a file's cache (what the renderer turns into URLs).
 *  `voice` is the raw isolated stem — the enhancer's input, kept for re-runs —
 *  but the Speech slider spans denoised (0%) ↔ enhanced (100%). */
export interface EnhanceStems {
  voice: string;
  denoised: string;
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
  /** Params the cached enhanced render was made with (last completed enhance). */
  params?: EnhanceProcessParams;
  /** Per-file Advanced overrides persisted in the manifest. */
  overrides?: EnhanceProcessParams;
  /** defaults ← config block ← per-file overrides — what the next Process runs
   *  with (and what the Advanced panel displays). */
  effectiveParams: EnhanceProcessParams;
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
  stages: { decode: boolean; separate: boolean; denoise: boolean; enhance: boolean };
  /** Params the last completed enhance stage ran with (change detection). */
  enhanceParams: EnhanceProcessParams;
  /** Per-file Advanced overrides (survive app restarts; merged over defaults). */
  paramOverrides?: EnhanceProcessParams;
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
    denoised: path.join(dir, DENOISED_NAME),
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

/** Merge order: built-in defaults ← config-block defaults ← per-file overrides
 *  (from the cache manifest) ← this run's explicit params. */
function resolveParams(overrides?: EnhanceProcessParams, params?: EnhanceProcessParams): EnhanceProcessParams {
  return { ...DEFAULT_ENHANCE_PARAMS, ...getEnhanceConfig().params, ...overrides, ...params };
}

function paramsEqual(a: EnhanceProcessParams, b: EnhanceProcessParams): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * The enhancer-CLI argv for a params dict: camelCase → --kebab-case; boolean
 * true → bare flag, false → omitted; everything else → flag + value.
 */
function enhanceParamArgs(params: EnhanceProcessParams): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (typeof value === 'boolean') {
      if (value) args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
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
    // Specific + actionable: the engine isn't installed. Separate from the
    // separator/RVC-env readiness check so the Enhance tab points the user at
    // exactly the piece that's missing. NO silent fallback.
    throw new Error(
      'Install the Resemble Enhance engine in Settings → Add-ons '
        + '(or point enhance.nativeEnvPath at your own resemble-enhance env).'
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
 * Scan a chunk for the LAST enhancer-CLI "CHUNK i/N (Xs-Ys)" progress line and
 * map i/N into [lo, hi]. Real chunk counts (not a heuristic NN% scrape) — the
 * enhance stage dominates the run (~0.57x realtime at seeds=5), so its progress
 * must be trustworthy.
 */
function chunkProgressFromChunk(chunk: string, lo: number, hi: number): number | null {
  let done: number | null = null;
  let total: number | null = null;
  const re = /CHUNK\s+(\d+)\s*\/\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    done = parseInt(m[1], 10);
    total = parseInt(m[2], 10);
  }
  if (done === null || total === null || total <= 0) return null;
  return Math.round(lo + (hi - lo) * Math.min(1, done / total));
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
    resolveSeparatorLauncher(),
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
      const pct = scaledPercentFromChunk(chunk, 10, 40);
      if (pct !== null) onPercent(pct);
    },
  });

  const stems = stemsFor(cacheDir);
  if (!fs.existsSync(stems.voice) || !fs.existsSync(stems.rest)) {
    throw new Error('separation did not produce voice.wav + rest.wav — check the audio-separator model.');
  }
}

/**
 * One enhancer-CLI pass (shared by the denoise + enhance stages — same script,
 * same env, --denoise-only distinguishes them). Progress comes from the CLI's
 * "CHUNK i/N (Xs-Ys)" lines mapped into [progressLo, progressHi].
 */
async function runEnhancerCli(
  run: ActiveRun,
  enhancer: ResolvedEnhancer,
  voicePath: string,
  outputPath: string,
  params: EnhanceProcessParams,
  opts: { denoiseOnly: boolean; progressLo: number; progressHi: number },
  onPercent: (pct: number) => void
): Promise<void> {
  const paramArgs = [...enhanceParamArgs(params), ...(opts.denoiseOnly ? ['--denoise-only'] : [])];

  let child: ChildProcess;
  let wslKillPattern: string | null = null;

  if (enhancer.launchMode === 'wsl') {
    // Convert the Windows cache paths (on /mnt/c/...) for the guest.
    const wslInput = windowsToWslPath(voicePath);
    const wslOutput = windowsToWslPath(outputPath);
    const cmdParts = [
      enhancer.wslPython!,
      enhancer.wslScript!,
      '--input', wslInput,
      '--output', wslOutput,
      ...paramArgs,
    ].map(shellQuote);
    const bashCommand = `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 && ${cmdParts.join(' ')}`;
    const wslArgs = ['-d', enhancer.distro!, 'bash', '-c', bashCommand];
    // Target ONLY this run's guest process for a stop: the output path carries
    // this file's unique cache key, so it never matches another job.
    wslKillPattern = `enhance_cli\\.py.*${path.basename(path.dirname(outputPath))}`;
    child = spawn('wsl.exe', wslArgs, { env: process.env, shell: false, windowsHide: true });
  } else {
    const args = [
      enhancer.scriptPath!,
      '--input', voicePath,
      '--output', outputPath,
      ...paramArgs,
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
      const pct = chunkProgressFromChunk(chunk, opts.progressLo, opts.progressHi);
      if (pct !== null) onPercent(pct);
    },
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      opts.denoiseOnly
        ? 'the denoiser produced no output — check the enhance CLI configuration.'
        : 'the enhancer produced no output — check the enhance CLI configuration.'
    );
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
  const manifest = fs.existsSync(dir) ? readManifest(dir) : null;
  const effectiveParams = resolveParams(manifest?.paramOverrides);
  if (!fs.existsSync(dir)) {
    return { cached: false, complete: false, key, cacheDir: dir, effectiveParams };
  }
  const stems = stemsFor(dir);
  const complete =
    !!manifest &&
    manifest.stages.decode &&
    manifest.stages.separate &&
    manifest.stages.denoise &&
    manifest.stages.enhance &&
    fs.existsSync(stems.voice) &&
    fs.existsSync(stems.denoised) &&
    fs.existsSync(stems.rest) &&
    fs.existsSync(stems.enhanced);
  return {
    cached: true,
    complete,
    key,
    cacheDir: dir,
    stems: complete ? stems : undefined,
    params: manifest?.enhanceParams,
    overrides: manifest?.paramOverrides,
    effectiveParams,
  };
}

/**
 * Persist per-file Advanced param overrides (merged into any existing ones) in
 * the cache manifest, creating a stub manifest for a not-yet-processed file.
 * Returns the updated cache entry so the UI can re-display effective params.
 */
export function setEnhanceOverrides(sourcePath: string, overrides: EnhanceProcessParams): EnhanceCacheEntry {
  const { dir } = cacheDirFor(sourcePath);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const st = fs.statSync(sourcePath);
  const manifest: EnhanceManifest = readManifest(dir) ?? {
    version: MANIFEST_VERSION,
    sourcePath,
    sourceSize: st.size,
    sourceMtimeMs: st.mtimeMs,
    createdAt: now,
    updatedAt: now,
    stages: { decode: false, separate: false, denoise: false, enhance: false },
    enhanceParams: {},
  };
  manifest.paramOverrides = { ...manifest.paramOverrides, ...overrides };
  manifest.updatedAt = now;
  writeManifest(dir, manifest);
  return getEnhanceCacheEntry(sourcePath);
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

  const { key, dir } = cacheDirFor(config.sourcePath);
  fs.mkdirSync(dir, { recursive: true });
  const decodedPath = path.join(dir, DECODED_NAME);
  const stems = stemsFor(dir);

  const st = fs.statSync(config.sourcePath);
  const now = new Date().toISOString();
  const prev = readManifest(dir);
  // Effective params: the manifest's per-file Advanced overrides sit between the
  // config-block defaults and any explicit per-run params.
  const params = resolveParams(prev?.paramOverrides, config.params);
  const manifest: EnhanceManifest = prev ?? {
    version: MANIFEST_VERSION,
    sourcePath: config.sourcePath,
    sourceSize: st.size,
    sourceMtimeMs: st.mtimeMs,
    createdAt: now,
    updatedAt: now,
    stages: { decode: false, separate: false, denoise: false, enhance: false },
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
    // What still needs doing? Decode + separate + denoise are param-independent
    // (the mask denoiser ignores the CFM tuning knobs); enhance is redone when
    // its params changed (or its output is missing).
    const needDecode = !fs.existsSync(decodedPath);
    const needSeparate = needDecode || !fs.existsSync(stems.voice) || !fs.existsSync(stems.rest);
    const needDenoise = needSeparate || !fs.existsSync(stems.denoised);
    const needEnhance =
      needSeparate ||
      !fs.existsSync(stems.enhanced) ||
      !prev ||
      !paramsEqual(prev.enhanceParams, params);

    if (!needDecode && !needSeparate && !needDenoise && !needEnhance) {
      // Fully cached with matching params — nothing to do, no GPU needed.
      sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Already processed.' });
      activeRuns.delete(jobId);
      return { success: true, data: getEnhanceCacheEntry(config.sourcePath) };
    }

    // Only the separation/denoise/enhancement stages are GPU-bound.
    if (needSeparate || needDenoise || needEnhance) {
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
      manifest.stages.denoise = false;
      manifest.stages.enhance = false;
      persist();
    }

    if (needSeparate) {
      sendProgress(mainWindow, jobId, { phase: 'separating', percentage: 10, message: 'Separating speech from background…' });
      await stageSeparate(run, decodedPath, dir, (pct) =>
        sendProgress(mainWindow, jobId, { phase: 'separating', percentage: pct, message: 'Separating speech from background…' })
      );
      manifest.stages.separate = true;
      manifest.stages.denoise = false;
      manifest.stages.enhance = false;
      persist();
    }

    if (needDenoise) {
      sendProgress(mainWindow, jobId, { phase: 'denoising', percentage: 40, message: 'Denoising speech…' });
      await runEnhancerCli(run, enhancer, stems.voice, stems.denoised, params,
        { denoiseOnly: true, progressLo: 40, progressHi: 55 },
        (pct) => sendProgress(mainWindow, jobId, { phase: 'denoising', percentage: pct, message: 'Denoising speech…' })
      );
      manifest.stages.denoise = true;
      // The denoised stem is the blend floor — a new one orphans cached blends.
      clearCachedBlends(dir);
      persist();
    }

    if (needEnhance) {
      // NOTE: input is the RAW voice stem, NOT the denoised one — pre-denoising
      // the enhancer's input measurably increases wobble (ear-validated).
      sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: 55, message: 'Enhancing speech…' });
      await runEnhancerCli(run, enhancer, stems.voice, stems.enhanced, params,
        { denoiseOnly: false, progressLo: 55, progressHi: 99 },
        (pct) => sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: pct, message: 'Enhancing speech…' })
      );
      manifest.stages.enhance = true;
      manifest.enhanceParams = params;
      // A new enhanced render orphans any cached spectral blends of the old one.
      clearCachedBlends(dir);
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
  /** 0 = denoised speech (mask-based floor), 1 = fully enhanced speech.
   *  Intermediate values are rendered as an STFT-domain blend (see the module
   *  header — a time-domain crossfade of these two stems doubles the voice). */
  speech: number;
  /** 0 = background removed, 1 = background at original level (stem gain). */
  background: number;
}

/** Delete cached spectral blends (blend_<pct>.wav) in a file's cache dir. */
function clearCachedBlends(cacheDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return; // cache dir gone — nothing to clear
  }
  for (const name of names) {
    if (/^blend_\d+\.wav$/.test(name)) {
      try { fs.rmSync(path.join(cacheDir, name)); } catch { /* best-effort */ }
    }
  }
}

/** The shipped enhance_spectral_blend.py (asarUnpack'd real file in packaged builds). */
function resolveBlendScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'enhance_spectral_blend.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'enhance_spectral_blend.py'),
    path.join(__dirname, 'scripts', 'enhance_spectral_blend.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('enhance_spectral_blend.py is missing from the app bundle.');
  }
  return toUnpackedPath(found);
}

/** The shipped run_audio_separator.py launcher (asarUnpack'd real file in packaged builds). */
function resolveSeparatorLauncher(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'run_audio_separator.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'run_audio_separator.py'),
    path.join(__dirname, 'scripts', 'run_audio_separator.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('run_audio_separator.py is missing from the app bundle.');
  }
  return toUnpackedPath(found);
}

/**
 * The speech stem for a Speech-slider value: the endpoint files themselves at
 * k=0 (voice_denoised.wav) / k=1 (voice_enhanced.wav), otherwise a cached
 * STFT-domain blend (blend_<pct>.wav) rendered by enhance_spectral_blend.py in
 * the SAME env/launch mode as the enhancer (it only needs numpy/librosa/
 * soundfile, which that env carries). k is quantized to the UI's integer
 * percent so the cache key and the rendered blend always agree.
 */
async function resolveSpeechStem(cacheDir: string, stems: EnhanceStems, speech: number): Promise<string> {
  const pct = Math.round(clamp01(speech) * 100);
  if (pct <= 0) return stems.denoised;
  if (pct >= 100) return stems.enhanced;

  const blendPath = path.join(cacheDir, `blend_${pct}.wav`);
  if (fs.existsSync(blendPath)) return blendPath;

  const enhancer = resolveEnhancer(); // throws the precise config error if unset
  const script = resolveBlendScript();
  const k = pct / 100;

  let child: ChildProcess;
  if (enhancer.launchMode === 'wsl') {
    // The blend is CPU-only numpy — safe to run in the guest, and the stems are
    // reachable via /mnt/<drive>. Same interpreter as the enhancer by design.
    const cmdParts = [
      enhancer.wslPython!,
      windowsToWslPath(script),
      '--voice', windowsToWslPath(stems.denoised),
      '--enhanced', windowsToWslPath(stems.enhanced),
      '--output', windowsToWslPath(blendPath),
      '--k', String(k),
    ].map(shellQuote);
    const bashCommand = `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 && ${cmdParts.join(' ')}`;
    child = spawn('wsl.exe', ['-d', enhancer.distro!, 'bash', '-c', bashCommand], {
      env: process.env, shell: false, windowsHide: true,
    });
  } else {
    const pathValue = [...relocatableEnvBinDirs(enhancer.envRoot!), process.env.PATH || ''].join(path.delimiter);
    child = spawn(enhancer.python!, [
      script,
      '--voice', stems.denoised,
      '--enhanced', stems.enhanced,
      '--output', blendPath,
      '--k', String(k),
    ], {
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

  await new Promise<void>((resolve, reject) => {
    let tail = '';
    const onData = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`spectral blend exited with code ${code}: ${tail.trim()}`));
    });
  }).catch((err) => {
    // Never leave a half-written blend behind — it would be trusted as cached.
    try { fs.rmSync(blendPath, { force: true }); } catch { /* best-effort */ }
    throw err;
  });

  if (!fs.existsSync(blendPath)) {
    throw new Error('spectral blend produced no output.');
  }
  return blendPath;
}

/**
 * Render the final mix to disk at the current slider gains: pcm_s24le WAV, sample
 * rate preserved from the cached stems. Reads ONLY the cache (plus, for an
 * intermediate Speech value, a blend derived from it on first use). The stem list
 * is built here so a future Music slider adds one entry and one gain, nothing else.
 */
export async function exportEnhanceMix(config: EnhanceExportConfig): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const entry = getEnhanceCacheEntry(config.sourcePath);
  if (!entry.complete || !entry.stems) {
    return { success: false, error: 'This file has not been fully processed yet — run Process first.' };
  }
  const { rest } = entry.stems;

  const speech = clamp01(config.speech);
  const background = clamp01(config.background);

  let speechStem: string;
  try {
    speechStem = await resolveSpeechStem(entry.cacheDir, entry.stems, speech);
  } catch (err) {
    return { success: false, error: `Export failed: ${(err as Error).message}` };
  }

  // Mix inputs (order matches the -i order below). The speech stem always enters
  // at unity — the Speech slider chose WHICH speech render, not its level. A
  // future Music stem appends here with its own gain.
  const inputs: { path: string; gain: number }[] = [
    { path: speechStem, gain: 1 },
    { path: rest, gain: background },
  ];

  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();

  // Preserve the stems' sample rate.
  let sampleRate = 44100;
  try {
    const sr = execSync(
      `"${ffprobe}" -v error -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "${speechStem}"`,
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
