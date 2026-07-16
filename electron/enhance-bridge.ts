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
import { getRvcEnvRoot, getRvcPython, convertFileRvc, rvcEnhancementReady } from './rvc-bridge';
import { getRvcVoiceById, isRvcVoiceInstalled } from './rvc-models';
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

/**
 * Which engine cleans the isolated voice stem. 'resemble' (default) is the tab's
 * original Adobe-Podcast-style denoise+enhance; 'rvc' re-renders the voice through
 * an RVC voice model (the SAME conversion the assembly page runs post-TTS).
 */
export type EnhanceMethod = 'resemble' | 'rvc';

/**
 * RVC voice-conversion settings — the assembly page's exact knob set (a voice
 * model + index rate + protect rate + pitch in semitones; see rvc-job.ts). No
 * f0/rms/filter controls are surfaced anywhere in the app, so none are added here.
 */
export interface RvcEnhanceSettings {
  /** RVC voice asset id (== the rvc-model component id). Required when method='rvc'. */
  voiceId: string;
  /** Index influence (0–1). */
  indexRate: number;
  /** Consonant/breath protection (0–0.5). */
  protectRate: number;
  /** Pitch shift in semitones (0 keeps the source pitch). */
  nSemitones: number;
}

/** RVC knob defaults — mirror the assembly page (rvc-job.ts): index 0.5, protect
 *  0.5, semitones 0. voiceId '' means "none chosen" and errors loudly at run. */
export const DEFAULT_RVC_ENHANCE_SETTINGS: RvcEnhanceSettings = {
  voiceId: '',
  indexRate: 0.5,
  protectRate: 0.5,
  nSemitones: 0,
};

// macOS/MPS memory bounds for the enhance stage (see runEnhancerCli). Tuned so a
// 30-min file at nfe=64/seeds=5 stays well under system RAM instead of spilling to
// swap. Chunk sizes cap per-inference activation memory; the high-watermark ratio
// caps total MPS allocation (a fraction of the ~48 GB recommended working set on a
// 64 GB machine). All overridable — the ratio via env, chunk sizes via params.
const MPS_CHUNK_TARGET_S = 12;
const MPS_CHUNK_MAX_S = 18;
// Both ratios are relative to the MPS "recommended working set" (~48 GB on a 64 GB
// machine). PyTorch requires low ≤ high. The stock defaults (high 1.7 / low 1.4)
// let the allocator spill PAST physical RAM into swap — that runaway is the RAM
// nuke. We clamp to high 1.0 / low 0.9 (~48 GB hard ceiling, freeing starts ~43 GB)
// so a runaway can never exceed physical RAM, while still leaving a bounded 12–18 s
// chunk enough room to complete. Measured: a tighter 0.7/0.6 ceiling ABORTS the
// model mid-inference (RuntimeError/abort), so don't go below what a chunk needs.
const MPS_HIGH_WATERMARK_RATIO = '1.0';
const MPS_LOW_WATERMARK_RATIO = '0.9';

const MANIFEST_VERSION = 4;
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
  /** Session key (cache folder name). Passed for a RESTORED session so the run
   *  addresses the folder directly and can decode from the stored original even
   *  if the external source has since moved/been deleted. Omitted for a fresh
   *  add (derived from sourcePath). */
  key?: string;
  /** Enhance params for this run. Merged over the config block's defaults, which
   *  sit over DEFAULT_ENHANCE_PARAMS. */
  params?: EnhanceProcessParams;
  /** Cleanup method for this run. Defaults to the file's persisted choice, then
   *  'resemble' (the tab's original behaviour). */
  method?: EnhanceMethod;
  /** RVC settings for this run — used only when method resolves to 'rvc'. Merged
   *  over the file's persisted RVC settings, which sit over the defaults. */
  rvcSettings?: Partial<RvcEnhanceSettings>;
  /** What to run this pass:
   *   - 'auto' (default): the full cascade, cache-driven — run only the steps
   *     that are missing/changed to reach a complete Separate → Denoise → Enhance.
   *     This is the main Process button.
   *   - 'all': the full cascade, forced from decode.
   *   - 'separate' / 'denoise' / 'enhance': run ONLY that ONE step, à la carte, on
   *     the best-available input (the separated raw voice if present, else the
   *     decoded original — so Denoise-first denoises the original full mix and
   *     Generate-first converts the original). Decode auto-runs as a prerequisite
   *     when the working copy is missing, but a solo step NEVER auto-runs Separate
   *     or Denoise for you. */
  reprocess?: ReprocessScope;
}

/** The force-redo scope for a Process run (see EnhanceProcessConfig.reprocess). */
export type ReprocessScope = 'auto' | 'all' | 'separate' | 'denoise' | 'enhance';

/** A per-file settings patch persisted in the cache manifest (survives restarts).
 *  Each part is merged independently so unrelated settings are never clobbered. */
export interface EnhanceOverridesPatch {
  /** Resemble enhancer knobs to merge into the persisted overrides. */
  params?: EnhanceProcessParams;
  /** The chosen cleanup method to persist. */
  method?: EnhanceMethod;
  /** RVC settings to merge into the persisted RVC overrides. */
  rvcSettings?: Partial<RvcEnhanceSettings>;
}

/** One restorable Enhance session, rebuilt from a cache folder's manifest. */
export interface EnhanceSession {
  key: string;
  sourcePath: string;
  sourceName: string;
  durationSec: number;
  sizeBytes: number;
  complete: boolean;
  stems?: EnhanceStems;
  /** Per-stem on-disk availability (chip lit/dim + slider enable). */
  available?: EnhanceStemAvailability;
  effectiveParams: EnhanceProcessParams;
  /** Effective cleanup method (persisted choice ← default) for UI restore. */
  method: EnhanceMethod;
  /** Effective RVC settings (persisted override ← defaults) for UI restore. */
  rvcSettings: RvcEnhanceSettings;
  /** True when the pristine original is stored in the session folder. */
  hasOriginal: boolean;
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

/** Which stems actually exist on disk (its stage completed). Drives the chip
 *  stepper's lit/dim state and which sliders are enabled — à la carte steps mean a
 *  session can have some stems without being fully `complete`. */
export interface EnhanceStemAvailability {
  voice: boolean;
  denoised: boolean;
  rest: boolean;
  enhanced: boolean;
}

export interface EnhanceCacheEntry {
  cached: boolean;
  /** True only when every stage output is present on disk. */
  complete: boolean;
  key: string;
  cacheDir: string;
  /** The four stem PATHS (always present for a cached session, even if a given
   *  stem hasn't been rendered yet — check `available` for existence). */
  stems?: EnhanceStems;
  /** Per-stem on-disk availability (chip lit/dim + slider enable). */
  available?: EnhanceStemAvailability;
  /** Params the cached enhanced render was made with (last completed enhance). */
  params?: EnhanceProcessParams;
  /** Per-file Advanced overrides persisted in the manifest. */
  overrides?: EnhanceProcessParams;
  /** defaults ← config block ← per-file overrides — what the next Process runs
   *  with (and what the Advanced panel displays). */
  effectiveParams: EnhanceProcessParams;
  /** Effective cleanup method (persisted choice ← 'resemble') for the UI. */
  method: EnhanceMethod;
  /** Effective RVC settings (persisted override ← defaults) for the UI. */
  rvcSettings: RvcEnhanceSettings;
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
  /** Basename of the source, kept for display after the source path may be gone. */
  sourceName?: string;
  sourceSize: number;
  sourceMtimeMs: number;
  /** Source duration (seconds), captured once so session restore needs no probe. */
  durationSec?: number;
  /** Filename of the pristine original copied into this session folder (e.g.
   *  'original.mp3'), so the session is self-contained and survives the source
   *  being moved/deleted. Absent on pre-v3 sessions. */
  originalFile?: string;
  createdAt: string;
  updatedAt: string;
  stages: { decode: boolean; separate: boolean; denoise: boolean; enhance: boolean };
  /** Params the last completed enhance stage ran with (change detection). */
  enhanceParams: EnhanceProcessParams;
  /** Per-file Advanced overrides (survive app restarts; merged over defaults). */
  paramOverrides?: EnhanceProcessParams;
  /** Method the current ENHANCED stem was rendered with (change detection +
   *  method-aware availability). Absent on pre-RVC sessions ⇒ treated as
   *  'resemble'. An enhanced stem made with a DIFFERENT method than the currently
   *  selected one is stale — it must not light the Enhance chip. */
  method?: EnhanceMethod;
  /** Method the current DENOISED stem was rendered with (resemble mask-denoise vs
   *  RVC raw-copy differ, so denoise is method-specific too). Absent on legacy
   *  sessions ⇒ migrate from `method` (denoise + enhance ran together then). */
  denoiseMethod?: EnhanceMethod;
  /** RVC settings the enhanced stem was rendered with (when method === 'rvc';
   *  change detection). */
  rvcSettings?: RvcEnhanceSettings;
  /** Per-file persisted method choice (survives restarts; the UI's selection). */
  methodOverride?: EnhanceMethod;
  /** Per-file persisted RVC settings (survive restarts; merged over defaults). */
  rvcSettingsOverride?: Partial<RvcEnhanceSettings>;
}

/** A single in-flight file run, so stopEnhanceProcessing can tear it down. */
interface ActiveRun {
  jobId: string;
  /** Stable session key (cache folder) this job is processing. The renderer's row
   *  id is ephemeral (rebuilt on every navigate-away/back), so reconnecting the UI
   *  to a still-running job matches on this key, not the jobId. */
  key: string;
  sourcePath: string;
  child: ChildProcess | null;
  /** Non-null while the current child is a WSL guest run — kill via the WSL ladder. */
  wslKillPattern: string | null;
  aborted: boolean;
  /** Latest progress emitted — lets a remounting renderer restore the row's state
   *  immediately instead of waiting for the next progress tick. */
  lastProgress: EnhanceProgress | null;
}

const activeRuns = new Map<string, ActiveRun>();

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

function sendProgress(win: BrowserWindow | null, jobId: string, progress: EnhanceProgress): void {
  // Record the latest progress on the active run (if any) and tag the event with
  // the stable session key, so the renderer can match it to a row even after a
  // navigate-away/back cycle rebuilt every row with a fresh ephemeral id.
  const run = activeRuns.get(jobId);
  if (run) run.lastProgress = progress;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('enhance:progress', { jobId, key: run?.key ?? '', progress });
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

/** A session key is always a 16-hex slice (see enhanceCacheKey). Validate before
 *  using it as a path segment so a bad key can never escape the cache root. */
function isValidSessionKey(key: string): boolean {
  return /^[a-f0-9]{16}$/.test(key);
}

/** The session folder for a known key (no source stat — works after the source
 *  file is gone). */
function sessionDirForKey(key: string): string {
  return path.join(enhanceCacheRoot(), key);
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

/** Effective cleanup method: this run's explicit choice ← the file's persisted
 *  choice ← 'resemble' (the tab's original behaviour). */
function resolveMethod(manifest: EnhanceManifest | null, explicit?: EnhanceMethod): EnhanceMethod {
  return explicit ?? manifest?.methodOverride ?? 'resemble';
}

/** Effective RVC settings: defaults ← the file's persisted overrides ← this run's
 *  explicit settings. */
function resolveRvcSettings(
  manifest: EnhanceManifest | null,
  explicit?: Partial<RvcEnhanceSettings>,
): RvcEnhanceSettings {
  return { ...DEFAULT_RVC_ENHANCE_SETTINGS, ...manifest?.rvcSettingsOverride, ...explicit };
}

/** Whether two resolved RVC settings would produce the same render. */
function rvcSettingsEqual(a: RvcEnhanceSettings | undefined, b: RvcEnhanceSettings): boolean {
  if (!a) return false;
  return (
    a.voiceId === b.voiceId &&
    a.indexRate === b.indexRate &&
    a.protectRate === b.protectRate &&
    a.nSemitones === b.nSemitones
  );
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
  // scriptPath: an explicit config override wins (a user pointing at their own
  // enhance_cli.py); otherwise fall back to the shipped script, resolved from the
  // bundle exactly like resolveBlendScript()/resolveSeparatorLauncher(). Nothing
  // ever writes enhance.scriptPath in a managed install, so this default is what
  // makes the Enhance tab work out of the box (previously it hard-errored here,
  // disabling Process on every fresh package).
  let scriptPath = cfg.scriptPath;
  if (scriptPath) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`enhance.scriptPath does not exist: ${scriptPath}`);
    }
  } else {
    scriptPath = resolveEnhancerScript();
  }
  return { launchMode, python, envRoot, scriptPath };
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
    // macOS/MPS memory policy: the CFM enhancer on Apple Silicon's unified memory
    // balloons during inference (see the module header + Orpheus-MLX cache-limit
    // gotcha). Two bounds, applied ONLY on darwin so Windows/CUDA is unchanged:
    //   1. Smaller silence-aligned chunks — each chunk is ONE inference, so this
    //      caps peak activation memory. Passed to BOTH the denoise and enhance
    //      passes (this function runs both) so their cut boundaries stay aligned.
    //   2. PYTORCH_MPS_HIGH_WATERMARK_RATIO — a hard ceiling on MPS allocation so
    //      PyTorch reuses/frees buffers instead of spilling into swap and pressuring
    //      the whole system. Overridable via env for per-machine tuning.
    const mac = os.platform() === 'darwin';
    const macArgs = mac && !paramArgs.includes('--chunk-max-s')
      ? ['--chunk-target-s', String(MPS_CHUNK_TARGET_S), '--chunk-max-s', String(MPS_CHUNK_MAX_S)]
      : [];
    const args = [
      enhancer.scriptPath!,
      '--input', voicePath,
      '--output', outputPath,
      ...paramArgs,
      ...macArgs,
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
        ...(mac
          ? {
              PYTORCH_MPS_HIGH_WATERMARK_RATIO:
                process.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO ?? MPS_HIGH_WATERMARK_RATIO,
              PYTORCH_MPS_LOW_WATERMARK_RATIO:
                process.env.PYTORCH_MPS_LOW_WATERMARK_RATIO ?? MPS_LOW_WATERMARK_RATIO,
            }
          : {}),
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

/**
 * Re-render the isolated voice stem through an RVC voice model into `outputPath`
 * (the enhance pipeline's 'enhance' stage when method === 'rvc'). Runs under the
 * caller's GPU lease — convertFileRvc takes none. The spawned urvc child is
 * registered on `run` so stopEnhanceProcessing reaps it via the same native
 * process-tree kill the resemble native path uses. Per-file `[RVC] done/total`
 * progress maps into [55, 99].
 */
async function stageRvcConvert(
  run: ActiveRun,
  voicePath: string,
  outputPath: string,
  modelName: string,
  indexRate: number,
  settings: RvcEnhanceSettings,
  onPercent: (pct: number) => void,
): Promise<void> {
  try {
    await convertFileRvc({
      inputPath: voicePath,
      outputPath,
      modelName,
      indexRate,
      protectRate: settings.protectRate,
      nSemitones: settings.nSemitones,
      onSpawn: (child) => { run.child = child; run.wslKillPattern = null; },
      onProgress: (done, total) => {
        const frac = total > 0 ? done / total : 0;
        onPercent(Math.round(55 + (99 - 55) * Math.min(1, frac)));
      },
    });
    // Conform the RVC render to the voice stem's sample rate + PCM_16 format. RVC
    // outputs at the model's trained rate (often 40 k/48 k) and may be float WAV;
    // the two speech stems MUST share a rate for the Speech-slider blend (which
    // hard-errors on a mismatch) and the export mix, and s16 keeps the <audio>
    // preview playable. A no-op re-encode when the rate already matches.
    await conformStemToReference(run, outputPath, voicePath);
  } catch (err) {
    // A user Stop reaps the child → convertFileRvc rejects; surface it as a
    // cancellation so the outer handler reports "stopped", not a hard failure.
    if (run.aborted) throw new Error('cancelled');
    throw err;
  } finally {
    run.child = null;
  }
}

/**
 * Re-encode `targetPath` to the sample rate AND channel count of `referencePath`
 * as PCM_16 WAV (in place), so a produced speech stem matches the pipeline's other
 * stems. RVC output is often mono at the model's rate; the export mixer (ffmpeg
 * amix) requires consistent channel layouts and the Speech-slider blend requires a
 * shared rate, so both are conformed to the (stereo, 44.1 k) voice stem. Async +
 * cancel-aware (registers its ffmpeg child on `run`) so a long re-encode neither
 * blocks the main process nor ignores a Stop. Throws loudly if the reference
 * format can't be read (NO silent fallback) — an unfixed mismatch breaks the mix.
 */
async function conformStemToReference(run: ActiveRun, targetPath: string, referencePath: string): Promise<void> {
  const ref = probeAudioFormat(referencePath);
  const ffmpeg = getFfmpegPath();
  const tmp = targetPath + '.conform.wav';
  const child = spawn(ffmpeg, [
    '-y', '-i', targetPath,
    '-ar', String(ref.rate),
    '-ac', String(ref.channels),
    '-c:a', 'pcm_s16le',
    tmp,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await execStage(run, child, {});
  if (!fs.existsSync(tmp)) {
    throw new Error('conforming the RVC output to the pipeline format produced no file.');
  }
  fs.rmSync(targetPath, { force: true });
  fs.renameSync(tmp, targetPath);
}

/** The sample rate (Hz) + channel count of an audio file, or throw. NO fallback —
 *  a stem whose format can't be read must surface, not silently assume 44.1 k /
 *  stereo. ffprobe reads only the header, so this stays fast regardless of size. */
function probeAudioFormat(filePath: string): { rate: number; channels: number } {
  const ffprobe = getFfprobePath();
  // Keep the keys (default output prints `sample_rate=...` / `channels=...`) and
  // parse by name — the field ORDER for a bare nokey=1 list isn't guaranteed.
  const out = execSync(
    `"${ffprobe}" -v error -select_streams a:0 -show_entries stream=sample_rate,channels -of default=noprint_wrappers=1 "${filePath}"`,
    { encoding: 'utf-8', windowsHide: true }
  );
  const readKey = (key: string): number => {
    const m = new RegExp(`^${key}=(\\d+)`, 'm').exec(out);
    return m ? parseInt(m[1], 10) : NaN;
  };
  const rate = readKey('sample_rate');
  const channels = readKey('channels');
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(channels) || channels <= 0) {
    throw new Error(`Could not read the audio format of ${filePath}.`);
  }
  return { rate, channels };
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

/** Per-stem availability: a stem counts as available only when its file exists AND
 *  its stage flag is set (a truncated file from an interrupted run has its flag
 *  still false — see the need-logic comment — so it must not read as ready).
 *
 *  Denoise + Enhance are also METHOD-SPECIFIC: the enhanced/denoised stems are
 *  re-rendered whenever the method switches, so a stem made with a DIFFERENT
 *  method than the currently-selected one is stale and must NOT read as available
 *  (else the Enhance chip lights + the Speech slider enables after only an RVC run
 *  when Resemble is selected, etc.). Separate (voice/rest) is method-agnostic.
 *  Drives the chip stepper + slider enablement. */
function stemAvailabilityFor(manifest: EnhanceManifest | null, stems: EnhanceStems): EnhanceStemAvailability {
  const ok = (p: string, flag: boolean | undefined): boolean => !!flag && fs.existsSync(p);
  const selected = resolveMethod(manifest);
  // Legacy sessions have no denoiseMethod (denoise + enhance ran together under the
  // same method) — migrate from `method` so an existing full session stays lit.
  const denoiseMadeWith = manifest?.denoiseMethod ?? manifest?.method;
  return {
    voice: ok(stems.voice, manifest?.stages.separate),
    rest: ok(stems.rest, manifest?.stages.separate),
    denoised: ok(stems.denoised, manifest?.stages.denoise) && denoiseMadeWith === selected,
    enhanced: ok(stems.enhanced, manifest?.stages.enhance) && manifest?.method === selected,
  };
}

/** Whether every stage output for the SELECTED method is present on disk (drives
 *  Export). Uses the method-aware availability, so a session enhanced under the
 *  other method is not "complete" until re-run under the selected one. */
function sessionComplete(dir: string, manifest: EnhanceManifest | null, stems: EnhanceStems): boolean {
  if (!manifest) return false;
  const av = stemAvailabilityFor(manifest, stems);
  return av.voice && av.rest && av.denoised && av.enhanced;
}

/** Cache entry from a known session folder (no source stat — restore-safe). */
function cacheEntryForDir(key: string, dir: string): EnhanceCacheEntry {
  const manifest = fs.existsSync(dir) ? readManifest(dir) : null;
  const effectiveParams = resolveParams(manifest?.paramOverrides);
  const method = resolveMethod(manifest);
  const rvcSettings = resolveRvcSettings(manifest);
  if (!fs.existsSync(dir)) {
    return { cached: false, complete: false, key, cacheDir: dir, effectiveParams, method, rvcSettings };
  }
  const stems = stemsFor(dir);
  const complete = sessionComplete(dir, manifest, stems);
  return {
    cached: true,
    complete,
    key,
    cacheDir: dir,
    // Always hand back the stem PATHS + per-stem availability so the chip stepper
    // can play/enable whatever has been rendered so far (à la carte steps).
    stems,
    available: stemAvailabilityFor(manifest, stems),
    params: manifest?.enhanceParams,
    overrides: manifest?.paramOverrides,
    effectiveParams,
    method,
    rvcSettings,
  };
}

/** Inspect a file's cache without processing (for restoring UI state on load). */
export function getEnhanceCacheEntry(sourcePath: string): EnhanceCacheEntry {
  const { key, dir } = cacheDirFor(sourcePath);
  return cacheEntryForDir(key, dir);
}

/** Rebuild the full set of restorable sessions from the cache folder. Reads each
 *  manifest directly — no source stat — so sessions survive the source moving. */
export function listEnhanceSessions(): EnhanceSession[] {
  const root = enhanceCacheRoot();
  if (!fs.existsSync(root)) return [];
  const sessions: (EnhanceSession & { updatedAt: string })[] = [];
  for (const key of fs.readdirSync(root)) {
    if (!isValidSessionKey(key)) continue;
    const dir = path.join(root, key);
    let manifest: EnhanceManifest | null;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      manifest = readManifest(dir);
    } catch { continue; }
    if (!manifest) continue;
    const stems = stemsFor(dir);
    const complete = sessionComplete(dir, manifest, stems);
    sessions.push({
      key,
      sourcePath: manifest.sourcePath,
      sourceName: manifest.sourceName ?? path.basename(manifest.sourcePath),
      durationSec: manifest.durationSec ?? 0,
      sizeBytes: manifest.sourceSize ?? 0,
      complete,
      stems,
      available: stemAvailabilityFor(manifest, stems),
      effectiveParams: resolveParams(manifest.paramOverrides),
      method: resolveMethod(manifest),
      rvcSettings: resolveRvcSettings(manifest),
      hasOriginal: !!manifest.originalFile && fs.existsSync(path.join(dir, manifest.originalFile)),
      updatedAt: manifest.updatedAt ?? '',
    });
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions.map(({ updatedAt, ...s }) => s);
}

/** Delete a session by key (restore-safe — works when the source is gone). */
export function clearEnhanceCacheByKey(key: string): void {
  if (!isValidSessionKey(key)) return;
  try { fs.rmSync(sessionDirForKey(key), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Persist per-file Advanced param overrides (merged into any existing ones) in
 * the cache manifest, creating a stub manifest for a not-yet-processed file.
 * Returns the updated cache entry so the UI can re-display effective params.
 */
export function setEnhanceOverrides(sourcePath: string, patch: EnhanceOverridesPatch, key?: string): EnhanceCacheEntry {
  let resolvedKey: string;
  let dir: string;
  if (key && isValidSessionKey(key)) {
    resolvedKey = key;
    dir = sessionDirForKey(key);
  } else {
    ({ key: resolvedKey, dir } = cacheDirFor(sourcePath));
  }
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const st = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
  const manifest: EnhanceManifest = readManifest(dir) ?? {
    version: MANIFEST_VERSION,
    sourcePath,
    sourceName: path.basename(sourcePath),
    sourceSize: st?.size ?? 0,
    sourceMtimeMs: st?.mtimeMs ?? 0,
    createdAt: now,
    updatedAt: now,
    stages: { decode: false, separate: false, denoise: false, enhance: false },
    enhanceParams: {},
  };
  // Merge each part independently so the resemble knobs, the method choice, and
  // the RVC settings never clobber one another.
  if (patch.params) manifest.paramOverrides = { ...manifest.paramOverrides, ...patch.params };
  if (patch.method) manifest.methodOverride = patch.method;
  if (patch.rvcSettings) manifest.rvcSettingsOverride = { ...manifest.rvcSettingsOverride, ...patch.rvcSettings };
  manifest.updatedAt = now;
  writeManifest(dir, manifest);
  return cacheEntryForDir(resolvedKey, dir);
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
  const sourceExists = fs.existsSync(config.sourcePath);

  // Fail fast on a missing SEPARATOR env BEFORE taking the GPU lease — both
  // methods need separation. The method-specific engine (resemble enhancer OR the
  // RVC voice) is resolved below, once the effective method is known.
  try {
    getSeparatorPython();
  } catch (err) {
    const error = (err as Error).message;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  // Resolve the session folder. A restored session passes its key so the run
  // addresses the folder directly (no source stat) and can decode from the
  // stored original even if the external source is gone. A fresh add derives the
  // key from the source (which must therefore exist).
  let key: string;
  let dir: string;
  if (config.key && isValidSessionKey(config.key)) {
    key = config.key;
    dir = sessionDirForKey(key);
  } else {
    if (!sourceExists) {
      return { success: false, error: `File not found: ${config.sourcePath}` };
    }
    ({ key, dir } = cacheDirFor(config.sourcePath));
  }
  fs.mkdirSync(dir, { recursive: true });
  const decodedPath = path.join(dir, DECODED_NAME);
  const stems = stemsFor(dir);

  const now = new Date().toISOString();
  const prev = readManifest(dir);

  // Copy the pristine original into the session folder (once) so the session is
  // self-contained: it survives the source moving/being deleted, and Delete
  // removes it along with the assets. Decode reads from the stored original.
  let originalFile = prev?.originalFile;
  let originalPath = originalFile ? path.join(dir, originalFile) : null;
  if ((!originalPath || !fs.existsSync(originalPath)) && sourceExists) {
    originalFile = 'original' + (path.extname(config.sourcePath) || '.bin');
    originalPath = path.join(dir, originalFile);
    try {
      if (!fs.existsSync(originalPath)) fs.copyFileSync(config.sourcePath, originalPath);
    } catch (err) {
      return { success: false, error: `Could not stage the original into the session: ${(err as Error).message}` };
    }
  }
  const decodeInput = originalPath && fs.existsSync(originalPath)
    ? originalPath
    : (sourceExists ? config.sourcePath : null);
  if (!decodeInput) {
    return { success: false, error: `Source not found and no stored original for this session: ${config.sourcePath}` };
  }

  const st = sourceExists ? fs.statSync(config.sourcePath) : null;
  // Effective params: the manifest's per-file Advanced overrides sit between the
  // config-block defaults and any explicit per-run params.
  const params = resolveParams(prev?.paramOverrides, config.params);
  // Effective method + RVC settings for this run (this run's explicit choice ←
  // the file's persisted choice ← defaults).
  const method = resolveMethod(prev, config.method);
  const rvcSettings = resolveRvcSettings(prev, config.rvcSettings);

  // Resolve the method-specific engine, failing with a precise, actionable error
  // (NO silent fallback) BEFORE taking the GPU lease.
  let enhancer: ResolvedEnhancer | null = null;
  let rvcModelName: string | null = null;
  let rvcRunIndexRate = rvcSettings.indexRate;
  try {
    if (method === 'resemble') {
      enhancer = resolveEnhancer();
    } else {
      const ready = rvcEnhancementReady();
      if (!ready.ok) throw new Error(`RVC voice conversion is unavailable: ${ready.reason}`);
      if (!rvcSettings.voiceId) throw new Error('Choose an RVC voice model before processing.');
      const voice = getRvcVoiceById(rvcSettings.voiceId);
      if (!voice) throw new Error(`Unknown RVC voice: ${rvcSettings.voiceId}`);
      if (!isRvcVoiceInstalled(rvcSettings.voiceId)) {
        throw new Error(`The RVC voice "${voice.label}" is not installed — add it in Settings → Voice Enhancement.`);
      }
      rvcModelName = voice.modelName;
      // Match the assembly page exactly (rvc-job.ts): a voice with no usable index
      // must convert at index-rate 0; a voice with a tuned default overrides the
      // requested rate. Otherwise the requested rate is used.
      rvcRunIndexRate = voice.forceIndexRate0 ? 0 : (voice.defaultIndexRate ?? rvcSettings.indexRate);
    }
  } catch (err) {
    const error = (err as Error).message;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  const manifest: EnhanceManifest = prev ?? {
    version: MANIFEST_VERSION,
    sourcePath: config.sourcePath,
    sourceName: path.basename(config.sourcePath),
    sourceSize: st?.size ?? 0,
    sourceMtimeMs: st?.mtimeMs ?? 0,
    createdAt: now,
    updatedAt: now,
    stages: { decode: false, separate: false, denoise: false, enhance: false },
    enhanceParams: params,
  };
  // Backfill self-containment fields on the (possibly pre-existing) manifest.
  manifest.originalFile = originalFile;
  // Persist the effective method + RVC settings as this file's remembered choice
  // so it restores across app restarts (like the resemble Advanced overrides).
  manifest.methodOverride = method;
  manifest.rvcSettingsOverride = rvcSettings;
  if (!manifest.sourceName) manifest.sourceName = path.basename(manifest.sourcePath);
  if (manifest.durationSec == null) {
    try { manifest.durationSec = (await probeEnhanceInput(decodeInput)).durationSec; } catch { /* best-effort */ }
  }

  const run: ActiveRun = {
    jobId, key, sourcePath: config.sourcePath,
    child: null, wslKillPattern: null, aborted: false, lastProgress: null,
  };
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
    //
    // A stage counts as DONE only when BOTH its output exists AND the manifest
    // recorded the stage complete. The stage flag is written only AFTER the stage
    // fully succeeds, so a present-but-PARTIAL output (a prior run stopped or
    // OOM'd mid-write leaves a truncated file with its flag still false) must be
    // redone. Testing file existence alone would treat the truncated file as
    // finished: every "need" goes false, the run short-circuits to "fully cached",
    // yet sessionComplete() (which reads the flag) stays false — so the UI would
    // sit at "processing 0%" forever with nothing running. Gate on the flag too.
    const stages = prev?.stages;
    // A method switch (resemble ⇄ rvc) re-renders BOTH the denoised floor and the
    // enhanced stem, since each method produces them differently (resemble: mask
    // denoise + generative enhance; rvc: raw-voice floor + RVC-converted voice).
    // Compare against the method the CURRENT stems were MADE with (prev.method),
    // not the persisted override — the override is saved the moment the user
    // toggles the switch, before this Process re-renders anything. A pre-RVC
    // session has no `method` and its stems are resemble-made.
    const prevMadeMethod: EnhanceMethod = prev?.method ?? 'resemble';
    const methodChanged = prevMadeMethod !== method;

    // Scope model:
    //   - 'auto'/'all' → the full cascade (canonical Separate → Denoise → Enhance).
    //     'auto' is cache-driven; 'all' forces every step from decode.
    //   - 'separate'/'denoise'/'enhance' → run ONLY that ONE step, à la carte, on
    //     the best-available input. A solo step NEVER auto-runs the others; decode
    //     still auto-runs as a prerequisite when the working copy is missing.
    const scope: ReprocessScope = config.reprocess ?? 'auto';
    const cascade = scope === 'auto' || scope === 'all';
    const forceAll = scope === 'all';
    const soloSeparate = scope === 'separate';
    const soloDenoise = scope === 'denoise';
    const soloEnhance = scope === 'enhance';

    // Decode is a prerequisite for every step (format-normalize the original into
    // the 44.1 kHz working copy). It is not a user-facing step of its own.
    const needDecode = forceAll || !fs.existsSync(decodedPath) || !stages?.decode;
    const needSeparate =
      soloSeparate ||
      (cascade &&
        (needDecode || !fs.existsSync(stems.voice) || !fs.existsSync(stems.rest) || !stages?.separate));
    const needDenoise =
      soloDenoise ||
      (cascade &&
        (needSeparate || !fs.existsSync(stems.denoised) || !stages?.denoise || methodChanged));
    const needEnhance =
      soloEnhance ||
      (cascade &&
        (needSeparate ||
          !fs.existsSync(stems.enhanced) ||
          !prev ||
          !stages?.enhance ||
          methodChanged ||
          (method === 'resemble'
            ? !paramsEqual(prev.enhanceParams, params)
            : !rvcSettingsEqual(prev.rvcSettings, rvcSettings))));

    if (!needDecode && !needSeparate && !needDenoise && !needEnhance) {
      // Fully cached with matching params — nothing to do, no GPU needed.
      sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Already processed.' });
      activeRuns.delete(jobId);
      return { success: true, data: cacheEntryForDir(key, dir) };
    }

    // Only the separation/denoise/enhancement stages are GPU-bound.
    if (needSeparate || needDenoise || needEnhance) {
      sendProgress(mainWindow, jobId, { phase: 'preparing', percentage: 0, message: 'Waiting for the GPU…' });
      await acquireGpu(gpuOwner, { timeoutMs: 10 * 60_000 });
      gpuHeld = true;
    }

    if (needDecode) {
      sendProgress(mainWindow, jobId, { phase: 'decoding', percentage: 5, message: 'Decoding audio…' });
      await stageDecode(run, decodeInput, decodedPath);
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

    // Best-available cleanup input for Denoise + Generate: the separated raw voice
    // when we have it (computed AFTER the separate block, so a cascade that just
    // separated picks up the fresh stem), else the decoded original — a Denoise or
    // Generate run à la carte before any Separate works on the full mix.
    // NOTE (approved default): Generate consumes this RAW input, never the denoised
    // stem — pre-denoising measurably increases wobble (ear-validated). Denoise is
    // a PARALLEL "cleaned speech" view, not a Generate prerequisite.
    const haveSeparatedVoice = manifest.stages.separate === true && fs.existsSync(stems.voice);
    const cleanupInput = haveSeparatedVoice ? stems.voice : decodedPath;

    if (needDenoise) {
      if (method === 'rvc') {
        // RVC has no separate denoise model; the Speech slider's 0% floor is the
        // raw input (the "before" for an A/B against the RVC render), so copy it.
        sendProgress(mainWindow, jobId, { phase: 'denoising', percentage: 50, message: 'Preparing voice…' });
        fs.copyFileSync(cleanupInput, stems.denoised);
      } else {
        sendProgress(mainWindow, jobId, { phase: 'denoising', percentage: 40, message: 'Denoising speech…' });
        await runEnhancerCli(run, enhancer!, cleanupInput, stems.denoised, params,
          { denoiseOnly: true, progressLo: 40, progressHi: 55 },
          (pct) => sendProgress(mainWindow, jobId, { phase: 'denoising', percentage: pct, message: 'Denoising speech…' })
        );
      }
      manifest.stages.denoise = true;
      // Record which method this denoised stem was made with (resemble mask vs RVC
      // raw-copy) so a later method switch marks it stale (method-aware availability).
      manifest.denoiseMethod = method;
      // The denoised stem is the blend floor — a new one orphans cached blends.
      clearCachedBlends(dir);
      persist();
    }

    if (needEnhance) {
      if (method === 'rvc') {
        // Re-render the raw input through the chosen RVC voice model. Runs under
        // THIS job's GPU lease (convertFileRvc takes no lease of its own).
        sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: 55, message: 'Converting voice with RVC…' });
        await stageRvcConvert(run, cleanupInput, stems.enhanced, rvcModelName!, rvcRunIndexRate, rvcSettings,
          (pct) => sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: pct, message: 'Converting voice with RVC…' })
        );
      } else {
        // NOTE: input is the RAW input, NOT the denoised one — pre-denoising the
        // enhancer's input measurably increases wobble (ear-validated).
        sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: 55, message: 'Enhancing speech…' });
        await runEnhancerCli(run, enhancer!, cleanupInput, stems.enhanced, params,
          { denoiseOnly: false, progressLo: 55, progressHi: 99 },
          (pct) => sendProgress(mainWindow, jobId, { phase: 'enhancing', percentage: pct, message: 'Enhancing speech…' })
        );
      }
      manifest.stages.enhance = true;
      manifest.enhanceParams = params;
      manifest.method = method;
      manifest.rvcSettings = rvcSettings;
      // A new enhanced render orphans any cached spectral blends of the old one.
      clearCachedBlends(dir);
      persist();
    }

    activeRuns.delete(jobId);
    sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Done.' });
    return { success: true, data: cacheEntryForDir(key, dir) };
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

/** A still-running Process job, for reconnecting the UI after the user navigated
 *  away and came back. Keyed by the stable session key (not the ephemeral jobId). */
export interface ActiveEnhanceJob {
  jobId: string;
  key: string;
  sourcePath: string;
  progress: EnhanceProgress | null;
}

/** Snapshot of every in-flight Process run. The Enhance tab calls this on mount to
 *  re-adopt jobs that kept running while it was unmounted. */
export function listActiveEnhanceJobs(): ActiveEnhanceJob[] {
  return [...activeRuns.values()].map((r) => ({
    jobId: r.jobId,
    key: r.key,
    sourcePath: r.sourcePath,
    progress: r.lastProgress,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / mix
// ─────────────────────────────────────────────────────────────────────────────

export interface EnhanceExportConfig {
  sourcePath: string;
  /** Session key of a restored session, so export works when the source is gone. */
  key?: string;
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

/** The shipped enhance_cli.py (asarUnpack'd real file in packaged builds). */
function resolveEnhancerScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'enhance_cli.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'enhance_cli.py'),
    path.join(__dirname, 'scripts', 'enhance_cli.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('enhance_cli.py is missing from the app bundle.');
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
  const entry = config.key && isValidSessionKey(config.key)
    ? cacheEntryForDir(config.key, sessionDirForKey(config.key))
    : getEnhanceCacheEntry(config.sourcePath);
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
