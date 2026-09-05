/**
 * Tool Paths Configuration
 *
 * Centralized configuration for external tool paths (conda, ffmpeg, etc.)
 * Paths are stored in a JSON config file and can be configured via the UI.
 *
 * Priority order:
 * 1. User-configured paths (from config file)
 * 2. Environment variables
 * 3. Auto-detected paths (searches common locations)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';
import { app } from 'electron';
import { getActiveBundledEnvPath, getActiveBundledE2aPath, relocatableBinaryPath } from './e2a-env-bootstrap';
import { getManagedBinaryPath } from './update/managed-bins';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the Enhance tab launches the Resemble Enhance CLI.
 * - 'native': run the resemble-enhance conda env's own python directly on Windows
 *   (the default — vLLM is the only engine that needs WSL; Resemble Enhance runs
 *   fine natively). This is a normal BookForge component env, managed/pointed the
 *   same way the other engine envs are.
 * - 'wsl': run a Linux python inside a WSL2 distro (optional/secondary mode).
 */
export type EnhanceLaunchMode = 'native' | 'wsl';

/**
 * Resemble Enhance CLI tuning params (the enhance_cli.py contract). An open
 * dict passed through as CLI flags (camelCase key → --kebab-case; boolean true
 * → bare flag, false → omitted), so upcoming tuning knobs (multi-seed ensemble,
 * envelope anchor, …) need no schema change here — the enhancer CLI defines
 * the vocabulary, this layer just forwards it.
 */
export type EnhanceParamValue = number | string | boolean;
export type EnhanceParams = Record<string, EnhanceParamValue>;

/**
 * Enhance-tab configuration block. Only the Resemble Enhance step needs wiring:
 * decode uses the app's ffmpeg and separation reuses the RVC engine env
 * (audio-separator). Missing/incomplete config surfaces a specific error in the
 * UI — there is NO silent fallback to a guessed interpreter or script.
 */
export interface EnhanceConfig {
  /** Launch mode for the enhancer. Default 'native'. */
  launchMode?: EnhanceLaunchMode;

  // ── native mode ──
  /**
   * The resemble-enhance env ROOT (…/envs/resemble-enhance). Its own python runs
   * the script. User-pointed the way engine envs are; when omitted, resolution
   * falls back to the component system (see enhance-bridge getEnhanceEnvRoot).
   * Empty ≠ a working default — an unresolved env is an error, not a guess.
   */
  nativeEnvPath?: string;
  /** Absolute Windows path to enhance_cli.py (native mode). */
  scriptPath?: string;

  // ── wsl mode (optional) ──
  /** Linux python interpreter, e.g. /home/user/miniconda3/envs/resemble-enhance/bin/python. */
  wslPythonPath?: string;
  /** Linux enhance_cli.py path. */
  wslScriptPath?: string;
  /** WSL distro name for the enhance run (defaults to the shared wslDistro). */
  wslDistro?: string;

  /** Default CLI params applied when a Process run doesn't override them. */
  params?: EnhanceParams;
}

export interface ToolPathsConfig {
  // Conda/Python
  condaPath?: string;

  // ebook2audiobook
  e2aPath?: string;

  // TTS scratch dir: where in-progress e2a sessions are written before being
  // cached into the project. Empty = derived sibling of the library root.
  ttsScratchPath?: string;

  // FFmpeg
  ffmpegPath?: string;

  // ClipForge: root directory for ClipForge collections (the second app in
  // this workspace). Empty/undefined = NOT configured — the ClipForge UI forces
  // an explicit choice on first run; there is deliberately NO default location.
  clipforgeRoot?: string;

  // Custom Orpheus models directory (folder-discovered voices live here). Empty =
  // default <userData>/runtime/orpheus-models. On Windows+WSL, point this at a
  // WSL-native location exposed as a UNC path (e.g. \\wsl$\Ubuntu\home\<user>\
  // orpheus-models) so the worker loads the model off ext4 instead of the slow
  // /mnt/c 9p mount — the WSL spawn translates the UNC path to a native /home/... path.
  orpheusModelsDir?: string;

  // HuggingFace account whose tagged repos form the Orpheus voice catalog
  // ("bookforge-orpheus-voice"-tagged models). Empty = catalog disabled.
  orpheusHfUser?: string;
  // HuggingFace access token for listing/downloading (esp. private) voice repos.
  // Empty = fall back to env HF_TOKEN / ~/.cache/huggingface/token.
  huggingFaceToken?: string;

  // User-managed list of Orpheus voice SOURCES (HF repo ids, e.g.
  // "owenmorgan/owen-morgan-orpheus-3b"). undefined = use the built-in defaults
  // (DEFAULT_ORPHEUS_SOURCES). Each repo's card carries its prompt token + label.
  orpheusVoiceSources?: string[];
  // User-added RVC enhancement voices: each a { url, name } pair — the archive
  // (.tar.gz/.zip containing a .pth [+ .index]) and the display/folder name. These
  // are ADDED to the built-in defaults (they don't replace them). No checksum
  // (user-hosted), so they're extracted-and-relocated rather than sha256-verified.
  rvcVoiceSources?: { url: string; name: string }[];

  /**
   * Which Orpheus artifact form the RESIDENT STREAMING path serves (the /listen player,
   * the TTS API server and the browser extension, which are all clients of the same
   * engine). Absent ⇒ 'merged'. The batch audiobook workers are NOT affected — they
   * always take the merged copy.
   *
   * 'merged' (default) renders from the fused checkpoint: ~10-20% fewer GEMMs per token
   * than the LoRA path, which is what streaming latency is actually made of. The cost is
   * that each merged voice is its own engine identity, so changing voice rebuilds the
   * engine (~6 GB load + CUDA-graph capture) instead of registering a LoRA on a warm one,
   * and voices can no longer be mixed within one batch (canServeVoicePerRequest).
   * Accepted deliberately (Owen, 2026-08-10): a warm switch still waits ~20-30 s for the
   * next sentence, so it was never the instant switch the design implied, while the
   * per-token saving applies to every sentence.
   *
   * 'adapter' restores the shared-base behaviour — warm voice switching and per-request
   * casting. Flipping this value is the ONLY thing needed to go back: both artifact forms
   * stay installed side by side, so there is nothing to re-download.
   *
   * A STRING rather than a boolean on purpose. Settings' tool-path draft is a
   * Record<string,string> and sends `'true'` for a checked box, which every `=== true`
   * reader in this file silently mis-reads (see the BOOLEAN_KEYS note below) — a string
   * enum cannot fall into that trap.
   */
  orpheusStreamingArtifact?: 'adapter' | 'merged';

  // WSL2 Configuration (Windows only)
  useWsl2ForAllTts?: boolean;     // Use WSL2 for ALL TTS engines (not just Orpheus)
  useWsl2ForOrpheus?: boolean;    // Master toggle to use WSL2 for Orpheus (legacy, superseded by useWsl2ForAllTts)
  wslDistro?: string;              // WSL distro name (e.g., "Ubuntu")
  wslCondaPath?: string;           // Conda path inside WSL (e.g., "/home/user/anaconda3/bin/conda")
  wslE2aPath?: string;             // e2a path inside WSL (e.g., "/home/user/ebook2audiobook")
  wslOrpheusCondaEnv?: string;     // Conda env name for Orpheus in WSL (default: "orpheus_tts")

  // Higgs Audio v3, served from WSL. The same shape as the Orpheus pair above and
  // for a STRONGER reason than Orpheus's: Orpheus runs on native Windows and
  // merely runs badly there (vLLM's CUDA graphs don't capture, so it needs
  // enforce_eager and goes ~6x slower). Higgs v3's serving stack is vLLM-Omni,
  // which has no Windows build at all — the page-reader VLM's situation, not
  // Orpheus's. So there is no native fallback to be slower than, and the toggle
  // is what decides whether the engine can run at all rather than how fast.
  useWsl2ForHiggs?: boolean;       // Route Higgs jobs through WSL (Windows only)
  wslHiggsCondaEnv?: string;       // Conda env name for Higgs in WSL (default: "higgs3")

  // Page reading (Convert to EPUB) served from WSL. Same shape as the Orpheus
  // pair above and for a related but DISTINCT reason: Orpheus needs WSL because
  // vLLM's CUDA graphs don't capture on native Windows, while the page reader
  // needs it because vLLM has no Windows build AT ALL — `pip download vllm
  // --only-binary=:all:` on the bundled interpreter answers "from versions:
  // none" (measured 2026-08-07). The native-Windows alternative, dots.ocr under
  // transformers, does run — and takes 23.9 GB of VRAM for a 3B model, because
  // no Windows flash-attn wheel exists for this torch build and the vision
  // tower falls back to eager attention over ~3,450 patches. So this is an
  // opt-in pointer at an env the user already built, never a managed download.
  useWsl2ForVlm?: boolean;         // Serve the document vision model from WSL
  wslVlmCondaEnv?: string;         // Conda env name holding vLLM (e.g. "dots")
  wslVlmModel?: string;            // HF repo the server loads, e.g. "rednote-hilab/dots.ocr"

  // Enhance tab (local Adobe-Podcast-style speech cleanup). Only the Resemble
  // Enhance step needs wiring; see EnhanceConfig.
  enhance?: EnhanceConfig;

  /**
   * The Ollama model that reads printed numbers as spoken words for narration
   * (electron/tts-number-normalizer.ts). A tag, e.g. `qwen3.5:9b-q8_0`.
   *
   * ABSENT means the normalizer's own `DEFAULT_NORMALIZER_MODEL` — a DECLARED
   * default for a preference nobody has expressed, which is a different thing
   * from a required value that went missing. The default is declared once, in
   * the normalizer, so the tag in a cache path and the tag in an error message
   * are the same string; this key is the override.
   */
  ttsNumberNormalizerModel?: string;
}

interface ToolPathsState {
  config: ToolPathsConfig;
  configPath: string;
  loaded: boolean;
  // Latched when an EXISTING tool-paths.json could not be read/parsed. While set,
  // saveConfig/updateConfig refuse to write: the in-memory config is empty only
  // because the load failed, and persisting it would permanently wipe the user's
  // conda/ffmpeg/WSL/HF-token/voice configuration. Cleared only by restarting the
  // app with a readable (or absent) config file.
  loadFailed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const state: ToolPathsState = {
  config: {},
  configPath: '',
  loaded: false,
  loadFailed: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Config File Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the path to the tool paths config file
 */
function getConfigPath(): string {
  if (state.configPath) {
    return state.configPath;
  }

  // Store in app's user data directory
  const userDataPath = app.getPath('userData');
  state.configPath = path.join(userDataPath, 'tool-paths.json');
  return state.configPath;
}

/**
 * Load configuration from file
 */
export function loadConfig(): ToolPathsConfig {
  if (state.loaded) {
    return state.config;
  }

  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      state.config = JSON.parse(content);
      console.log('[TOOL-PATHS] Loaded config from:', configPath);
    } else {
      console.log('[TOOL-PATHS] No config file found, using defaults');
      state.config = {};
    }
  } catch (err) {
    // The config file EXISTS but couldn't be read/parsed. Preserve it BEFORE
    // anything can overwrite it, and latch loadFailed so saveConfig/updateConfig
    // refuse to persist the (empty) in-memory config over the user's settings.
    state.config = {};
    state.loadFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      const backupPath = `${configPath}.corrupt-${Date.now()}`;
      fs.renameSync(configPath, backupPath);
      console.error(`[TOOL-PATHS] tool-paths.json is corrupt — preserved at ${backupPath}. Config writes are disabled until the app restarts with a readable (or absent) config file. Load error: ${message}`);
    } catch (renameErr) {
      console.error(`[TOOL-PATHS] tool-paths.json is corrupt AND could not be backed up (config writes disabled until restart). Load error: ${message}. Backup error:`, renameErr);
    }
  }

  state.loaded = true;
  return state.config;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ToolPathsConfig): void {
  if (state.loadFailed) {
    throw new Error(
      'Refusing to save tool paths: the existing tool-paths.json could not be read at startup ' +
      '(it was preserved with a .corrupt-<timestamp> suffix in the app data folder). ' +
      'Saving now would permanently overwrite your tool configuration. ' +
      'Restart BookForge to start from a clean config, then re-apply your settings.'
    );
  }

  const configPath = getConfigPath();

  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    state.config = config;
    console.log('[TOOL-PATHS] Saved config to:', configPath);
  } catch (err) {
    console.error('[TOOL-PATHS] Error saving config:', err);
    throw err;
  }
}

/**
 * Update specific config values (merge with existing)
 */
/**
 * The keys this config declares as BOOLEAN, listed because the renderer cannot
 * send one.
 *
 * Settings' tool-path draft is a `Record<string, string>` — every checkbox in it
 * writes the STRING `'true'` or `''` (see `toggleWsl2ForOrpheus`), and
 * `tool-paths:update-config` passes what it is given straight through. So a
 * checked box stored `"useWsl2ForOrpheus": "true"`, while every reader asks
 * `=== true`, and `'true' !== true`: the toggle appeared on and did nothing.
 * It has been invisible because the one machine using it has a BOOLEAN in its
 * tool-paths.json, written by some earlier path — flip that switch in the UI
 * once and Orpheus silently stops routing through WSL.
 *
 * Coerced here, at the boundary where the string actually arrives, rather than
 * by loosening the readers: `=== true` is the correct question to ask of a
 * boolean, and a reader that also accepted `'true'` would be carrying the
 * renderer's serialisation quirk into every call site forever.
 */
const BOOLEAN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'useWsl2ForAllTts',
  'useWsl2ForOrpheus',
  'useWsl2ForVlm',
  'useWsl2ForHiggs',
]);

export function updateConfig(updates: Partial<ToolPathsConfig>): ToolPathsConfig {
  loadConfig();

  const coerced: Record<string, unknown> = { ...updates };
  for (const key of BOOLEAN_CONFIG_KEYS) {
    if (!(key in coerced)) continue;
    const raw = coerced[key];
    if (typeof raw !== 'string') continue;
    // '' is left alone: the loop below deletes empty values, which is how an
    // unchecked box removes the key rather than storing `false`.
    if (raw !== '') coerced[key] = raw === 'true';
  }

  const newConfig = { ...state.config, ...coerced } as ToolPathsConfig;

  // Remove undefined/null values
  for (const key of Object.keys(newConfig) as (keyof ToolPathsConfig)[]) {
    if (newConfig[key] === undefined || newConfig[key] === null || newConfig[key] === '') {
      delete newConfig[key];
    }
  }

  saveConfig(newConfig);
  return newConfig;
}

/**
 * Get current configuration
 */
export function getConfig(): ToolPathsConfig {
  loadConfig();
  return { ...state.config };
}

/**
 * Get the Enhance-tab config block (empty object when unconfigured — callers
 * validate the specific fields they need and surface a precise error rather than
 * silently substituting a guessed interpreter/script path).
 */
export function getEnhanceConfig(): EnhanceConfig {
  loadConfig();
  return { ...(state.config.enhance ?? {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Detection Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find first existing path from a list of candidates
 */
function findExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore access errors
    }
  }
  return null;
}

/**
 * Get common conda installation paths for current platform
 */
function getCondaCandidates(): string[] {
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'win32') {
    return [
      path.join(homeDir, 'Miniforge3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'miniconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'Miniconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'anaconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'Anaconda3', 'Scripts', 'conda.exe'),
      'C:\\ProgramData\\Miniforge3\\Scripts\\conda.exe',
      'C:\\ProgramData\\miniconda3\\Scripts\\conda.exe',
      'C:\\ProgramData\\Anaconda3\\Scripts\\conda.exe',
    ];
  } else if (platform === 'darwin') {
    return [
      // Homebrew installations
      '/opt/homebrew/Caskroom/miniconda/base/bin/conda',
      '/opt/homebrew/Caskroom/miniforge/base/bin/conda',
      '/usr/local/Caskroom/miniconda/base/bin/conda',
      '/usr/local/Caskroom/miniforge/base/bin/conda',
      // User installations
      path.join(homeDir, 'miniforge3', 'bin', 'conda'),
      path.join(homeDir, 'Miniforge3', 'bin', 'conda'),
      path.join(homeDir, 'miniconda3', 'bin', 'conda'),
      path.join(homeDir, 'anaconda3', 'bin', 'conda'),
    ];
  } else {
    // Linux
    return [
      path.join(homeDir, 'miniforge3', 'bin', 'conda'),
      path.join(homeDir, 'miniconda3', 'bin', 'conda'),
      path.join(homeDir, 'anaconda3', 'bin', 'conda'),
      '/opt/conda/bin/conda',
    ];
  }
}

/**
 * Get common ffmpeg installation paths for current platform
 */
function getFfmpegCandidates(): string[] {
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'win32') {
    return [
      path.join(homeDir, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(homeDir, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ];
  } else if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ];
  } else {
    // Linux
    return [
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ];
  }
}

/**
 * Get common e2a installation paths for current platform
 */
function getE2aCandidates(): string[] {
  const platform = os.platform();
  const homeDir = os.homedir();

  // Common project directories
  const projectDirs = [
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Developer'),
    path.join(homeDir, 'dev'),
    path.join(homeDir, 'Code'),
    homeDir,
  ];

  const candidates: string[] = [];

  for (const dir of projectDirs) {
    // Check -latest first (typically more up-to-date)
    candidates.push(path.join(dir, 'ebook2audiobook-latest'));
    candidates.push(path.join(dir, 'ebook2audiobook'));
  }

  if (platform === 'win32') {
    candidates.push('C:\\ebook2audiobook');
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Path Getters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get conda executable path
 * Priority: config > env var > auto-detect > fallback to 'conda'
 */
export function getCondaPath(): string {
  loadConfig();

  // 1. Check configured path
  if (state.config.condaPath && fs.existsSync(state.config.condaPath)) {
    return state.config.condaPath;
  }

  // 2. Check environment variable
  if (process.env.CONDA_EXE && fs.existsSync(process.env.CONDA_EXE)) {
    return process.env.CONDA_EXE;
  }

  // 3. Auto-detect
  const detected = findExistingPath(getCondaCandidates());
  if (detected) {
    return detected;
  }

  // 4. Fallback
  return 'conda';
}

/**
 * Get ffmpeg executable path
 * Priority: config > env var > bundled relocatable env > auto-detect > fallback to 'ffmpeg'
 */
export function getFfmpegPath(): string {
  loadConfig();

  // 1. Check configured path
  if (state.config.ffmpegPath && fs.existsSync(state.config.ffmpegPath)) {
    return state.config.ffmpegPath;
  }

  // 2. Check environment variable
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  // 2.5. A managed (server-pushed, auto-updated) ffmpeg, if installed. Ranks above the bundled
  // env so binary updates we publish actually take effect; explicit config/env above still win.
  const managed = getManagedBinaryPath('ffmpeg');
  if (managed) {
    return managed;
  }

  // 3. Bundled relocatable env (packaged builds / BOOKFORGE_E2A_ENV override).
  // The env tarball ships ffmpeg, so a clean target machine needs no system
  // install — BookForge's own ffmpeg calls use the same binary e2a does.
  const bundledEnv = getActiveBundledEnvPath();
  if (bundledEnv) {
    const bundledFfmpeg = relocatableBinaryPath(bundledEnv, 'ffmpeg');
    if (bundledFfmpeg) {
      return bundledFfmpeg;
    }
    console.warn(`[TOOL-PATHS] Bundled env at ${bundledEnv} contains no ffmpeg — the tarball is missing its binaries; falling back to system detection`);
  }

  // 4. Auto-detect
  const detected = findExistingPath(getFfmpegCandidates());
  if (detected) {
    return detected;
  }

  // 5. Fallback
  return 'ffmpeg';
}

/**
 * Get ffprobe executable path.
 * ffprobe ships alongside ffmpeg (same env / same dir), so this mirrors
 * getFfmpegPath()'s resolution order, swapping the binary name.
 * Priority: env var > bundled relocatable env > auto-detect > fallback to 'ffprobe'
 */
export function getFfprobePath(): string {
  loadConfig();

  // 1. Environment variable
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return process.env.FFPROBE_PATH;
  }

  // 2. A managed (server-pushed, auto-updated) ffprobe, if installed.
  const managed = getManagedBinaryPath('ffprobe');
  if (managed) {
    return managed;
  }

  // 3. Bundled relocatable env (packaged builds) — same env that carries ffmpeg.
  const bundledEnv = getActiveBundledEnvPath();
  if (bundledEnv) {
    const bundledFfprobe = relocatableBinaryPath(bundledEnv, 'ffprobe');
    if (bundledFfprobe) {
      return bundledFfprobe;
    }
  }

  // 4. Auto-detect: ffprobe sits next to a discovered ffmpeg, so derive from there.
  const detectedFfmpeg = findExistingPath(getFfmpegCandidates());
  if (detectedFfmpeg) {
    const dir = path.dirname(detectedFfmpeg);
    const ext = os.platform() === 'win32' ? '.exe' : '';
    const sibling = path.join(dir, `ffprobe${ext}`);
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }

  // 5. Fallback
  return 'ffprobe';
}

/**
 * Get ebook2audiobook installation path
 * Priority: config > env var > bundled runtime copy > auto-detect
 */
export function getE2aPath(): string {
  loadConfig();

  // 1. Check configured path
  if (state.config.e2aPath && fs.existsSync(state.config.e2aPath)) {
    return state.config.e2aPath;
  }

  // 2. Check environment variable. Set-but-missing is an ERROR, not a skip: this is
  // the seam the headless CLI exposes (--orpheus-install), and silently falling
  // through to a different install renders with the wrong code (NO FALLBACKS).
  if (process.env.EBOOK2AUDIOBOOK_PATH) {
    if (!fs.existsSync(process.env.EBOOK2AUDIOBOOK_PATH)) {
      throw new Error(
        `EBOOK2AUDIOBOOK_PATH is set but does not exist: ${process.env.EBOOK2AUDIOBOOK_PATH}`
      );
    }
    return process.env.EBOOK2AUDIOBOOK_PATH;
  }

  // 3. Bundled e2a (packaged builds): the shipped snapshot copied to a
  // writable runtime dir by ensureBundledE2a() on first run.
  const bundledE2a = getActiveBundledE2aPath();
  if (bundledE2a) {
    return bundledE2a;
  }

  // 4. Auto-detect
  const detected = findExistingPath(getE2aCandidates());
  if (detected) {
    return detected;
  }

  // 5. Return a reasonable default (may not exist)
  const homeDir = os.homedir();
  return path.join(homeDir, 'Projects', 'ebook2audiobook');
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection Status (for UI)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolStatus {
  configured: boolean;  // User has configured this path
  detected: boolean;    // Path exists and was found
  path: string;         // The resolved path
}

/**
 * Get status of all tools (for displaying in settings UI)
 */
export function getToolStatus(): Record<string, ToolStatus> {
  loadConfig();

  const condaPath = getCondaPath();
  const ffmpegPath = getFfmpegPath();
  const e2aPath = getE2aPath();

  return {
    conda: {
      configured: !!state.config.condaPath,
      detected: condaPath !== 'conda' && fs.existsSync(condaPath),
      path: condaPath,
    },
    ffmpeg: {
      configured: !!state.config.ffmpegPath,
      detected: ffmpegPath !== 'ffmpeg' && fs.existsSync(ffmpegPath),
      path: ffmpegPath,
    },
    e2a: {
      configured: !!state.config.e2aPath,
      detected: fs.existsSync(e2aPath),
      path: e2aPath,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WSL2 Support (Windows only)
// ─────────────────────────────────────────────────────────────────────────────

export interface WslDetectionResult {
  available: boolean;
  version?: number;  // 1 or 2
  distros: string[];
  defaultDistro?: string;
  error?: string;
}

export interface WslOrpheusSetupResult {
  valid: boolean;
  condaFound: boolean;
  e2aFound: boolean;
  orpheusEnvFound: boolean;
  errors: string[];
}

/**
 * Detect if WSL2 is available on this Windows machine
 * Returns info about available distros
 */
export function detectWslAvailability(): WslDetectionResult {
  // WSL is only available on Windows
  if (os.platform() !== 'win32') {
    return { available: false, distros: [], error: 'WSL is only available on Windows' };
  }

  try {
    // Check if wsl.exe exists and get version
    const versionOutput = execSync('wsl.exe --version', {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    // Parse WSL version from output (first line usually contains "WSL version: X.X.X")
    const versionMatch = versionOutput.match(/WSL.*?:\s*(\d+)/i);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : 2;

    // List available distros
    const listOutput = execSync('wsl.exe --list --quiet', {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    // Parse distro names (filter out empty lines and clean up encoding issues)
    const distros = listOutput
      .split('\n')
      .map((line) => line.replace(/\0/g, '').trim())  // Remove null chars from UTF-16 output
      .filter((line) => line.length > 0);

    // Get default distro (first in list, or explicitly marked)
    let defaultDistro: string | undefined;
    try {
      const defaultOutput = execSync('wsl.exe --list --verbose', {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim();
      // Default distro is marked with * in verbose output
      const defaultMatch = defaultOutput.match(/\*\s+(\S+)/);
      if (defaultMatch) {
        defaultDistro = defaultMatch[1].replace(/\0/g, '');
      }
    } catch {
      defaultDistro = distros[0];
    }

    return {
      available: distros.length > 0,
      version,
      distros,
      defaultDistro,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check if WSL is simply not installed
    if (errorMessage.includes('not recognized') || errorMessage.includes('not found')) {
      return { available: false, distros: [], error: 'WSL is not installed' };
    }

    return { available: false, distros: [], error: errorMessage };
  }
}

/**
 * Check if Orpheus setup exists in WSL
 * Verifies conda, e2a, and orpheus_tts conda environment are present
 */
export function checkWslOrpheusSetup(config: {
  distro?: string;
  condaPath?: string;
  e2aPath?: string;
  orpheusCondaEnv?: string;
}): WslOrpheusSetupResult {
  // Only works on Windows
  if (os.platform() !== 'win32') {
    return {
      valid: false,
      condaFound: false,
      e2aFound: false,
      orpheusEnvFound: false,
      errors: ['WSL is only available on Windows'],
    };
  }

  const errors: string[] = [];
  const distroArg = config.distro ? `-d ${config.distro}` : '';

  // Default paths if not specified
  const condaPath = config.condaPath || '/home/$USER/anaconda3/bin/conda';
  const e2aPath = config.e2aPath || '/home/$USER/ebook2audiobook';
  const orpheusCondaEnv = config.orpheusCondaEnv || getWslOrpheusCondaEnv();

  let condaFound = false;
  let e2aFound = false;
  let orpheusEnvFound = false;

  try {
    // Check conda exists
    const condaCheck = execSync(
      `wsl.exe ${distroArg} bash -c "test -f ${condaPath} && echo 'found' || echo 'not found'"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    condaFound = condaCheck.includes('found');
    if (!condaFound) {
      errors.push(`Conda not found at ${condaPath}`);
    }
  } catch (err) {
    errors.push(`Failed to check conda: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // Check e2a directory exists
    const e2aCheck = execSync(
      `wsl.exe ${distroArg} bash -c "test -d ${e2aPath} && echo 'found' || echo 'not found'"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    e2aFound = e2aCheck.includes('found');
    if (!e2aFound) {
      errors.push(`ebook2audiobook not found at ${e2aPath}`);
    }
  } catch (err) {
    errors.push(`Failed to check e2a: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // Check orpheus_tts conda environment exists
    // Use conda env list to check if the environment exists
    const condaBase = condaPath.replace(/\/bin\/conda$/, '');
    const orpheusCheck = execSync(
      `wsl.exe ${distroArg} bash -lc "source ${condaBase}/etc/profile.d/conda.sh && conda env list | grep -q '^${orpheusCondaEnv} ' && echo 'found' || echo 'not found'"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    ).trim();
    orpheusEnvFound = orpheusCheck.includes('found');
    if (!orpheusEnvFound) {
      errors.push(`Orpheus conda environment '${orpheusCondaEnv}' not found`);
    }
  } catch (err) {
    errors.push(`Failed to check orpheus conda env: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    valid: condaFound && e2aFound && orpheusEnvFound,
    condaFound,
    e2aFound,
    orpheusEnvFound,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Higgs WSL doctor
// ─────────────────────────────────────────────────────────────────────────────

/** One thing the doctor looked at, and what it found. */
export interface HiggsCheck {
  /** Stable id, so a UI can key on it without matching prose. */
  id: 'distro' | 'env' | 'vllm-omni' | 'patch' | 'launcher';
  /** What a person reads. Patch rows carry the patch's own id here. */
  label: string;
  ok: boolean;
  /** Present when `ok` is false: what is wrong, in a sentence someone can act on. */
  detail?: string;
}

export interface WslHiggsSetupResult {
  valid: boolean;
  checks: HiggsCheck[];
  /** The env prefix the probe resolved, for error messages and the installer. */
  envPrefix?: string;
}

/**
 * The two site-packages patches the Higgs v3 stack does not work without.
 *
 * MIRRORED FROM THE CATALOG ON PURPOSE, and the duplication is deliberate rather
 * than sloppy: `higgs-models.json`'s copy is the RECORD (what the patch is, why
 * it exists, which script applies it) and belongs with the voices, while this
 * copy is what a doctor running before any voice is chosen needs. Importing the
 * catalog here would make `tool-paths.ts` — which every path resolution in the
 * app goes through — depend on a JSON file it has no other reason to read, and
 * would make a malformed catalog break WSL detection. The two are kept in step by
 * `tools/test-higgs-engine.js`, which asserts the ids and markers match AND
 * that the checked-in patch scripts actually write the markers this greps for.
 *
 * The grep names the EXACT target file, so a `.orig` sitting beside it is never
 * matched — which matters, because a stale `.orig` was the one way this doctor
 * could have reported green over unpatched code (the patch scripts now read the
 * LIVE file for the same reason).
 *
 * `marker` is a string the patch INTRODUCES that the pristine file cannot
 * contain, so grepping for it answers "is this patch applied" without diffing.
 * Both must be re-applied after any pip upgrade in the env, which is why they are
 * reported BY NAME instead of as one "the env looks wrong".
 */
export const HIGGS_PATCHES: ReadonlyArray<{
  id: string;
  relPath: string;
  marker: string;
  why: string;
}> = [
  {
    id: 'vllm-negative-token-id',
    relPath: 'vllm/v1/engine/input_processor.py',
    marker: 'min_input_id != -100',
    why:
      "vLLM 0.28's blanket negative-token-id rejection fires on vllm-omni's audio " +
      'placeholder (-100), so every voice-clone request returns HTTP 400 and only the ' +
      'default voice can serve.',
  },
  {
    id: 'higgs-tail-trim',
    relPath: 'vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py',
    marker: '_trim_trailing_sentinel_frames',
    why:
      'Without it every rendered chunk ends with ~240 ms of audible garbage — the ' +
      'ramp-down sentinels decode as real sound because they are substituted with ' +
      'codec code 0 and only one frame is trimmed.',
  },
];

/** The launcher the installer deploys INTO the env, so the stack is self-contained. */
export const HIGGS_LAUNCH_SCRIPT = 'serve_higgs_v3.sh';

/**
 * The Higgs doctor's probe script and its result parsing, shared by the sync and
 * async entry points so the two can never disagree about what "green" means.
 */
function higgsProbeScript(envPrefix: string): string {
  const patchProbe = HIGGS_PATCHES.map(
    (p) =>
      `f=$(ls ${envPrefix}/lib/python*/site-packages/${p.relPath} 2>/dev/null | head -1); ` +
      `if [ -n "$f" ] && grep -q '${p.marker}' "$f"; then echo 'patch:${p.id}=ok'; ` +
      `elif [ -n "$f" ]; then echo 'patch:${p.id}=unpatched'; else echo 'patch:${p.id}=absent'; fi`,
  ).join('; ');
  return [
    `test -d ${envPrefix} && echo 'env=ok' || echo 'env=absent'`,
    `${envPrefix}/bin/python -c 'import vllm_omni' >/dev/null 2>&1 && echo 'omni=ok' || echo 'omni=absent'`,
    patchProbe,
    `test -x ${envPrefix}/bin/${HIGGS_LAUNCH_SCRIPT} && echo 'launcher=ok' || echo 'launcher=absent'`,
  ].join('; ');
}

/** Turn the probe's `key=value` lines into the reported check list. */
function higgsChecksFrom(
  out: string, probeError: string | null, distro: string | undefined,
  envName: string, envPrefix: string,
): HiggsCheck[] {
  const seen = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = line.replace(/\0/g, '').trim().match(/^([^=]+)=(.+)$/);
    if (m) seen.set(m[1], m[2]);
  }

  const checks: HiggsCheck[] = [];
  checks.push(
    probeError
      ? {
          id: 'distro',
          label: `WSL distribution${distro ? ` "${distro}"` : ''}`,
          ok: false,
          detail: `Could not run a command in WSL: ${probeError}`,
        }
      : { id: 'distro', label: `WSL distribution${distro ? ` "${distro}"` : ''}`, ok: true },
  );

  // Every check below reads a probe line. A MISSING line is not a pass: when the
  // probe itself failed there is no line at all, and defaulting those to ok would
  // report a green doctor for a machine with no WSL.
  const envOk = seen.get('env') === 'ok';
  checks.push({
    id: 'env',
    label: `Conda env "${envName}"`,
    ok: envOk,
    detail: envOk ? undefined : `Not found at ${envPrefix}. Install it from Settings → Higgs.`,
  });

  const omniOk = seen.get('omni') === 'ok';
  checks.push({
    id: 'vllm-omni',
    label: 'vllm-omni importable',
    ok: omniOk,
    detail: omniOk
      ? undefined
      : `${envPrefix}/bin/python could not import vllm_omni — the serving stack is not installed in this env.`,
  });

  for (const p of HIGGS_PATCHES) {
    const state = seen.get(`patch:${p.id}`);
    checks.push({
      id: 'patch',
      label: `Patch "${p.id}"`,
      ok: state === 'ok',
      detail:
        state === 'ok'
          ? undefined
          : state === 'unpatched'
            ? `${p.relPath} is present but NOT patched. ${p.why} Re-run the Higgs installer — a pip upgrade in this env reverts it.`
            : `${p.relPath} was not found in ${envPrefix}. ${p.why}`,
    });
  }

  const launcherOk = seen.get('launcher') === 'ok';
  checks.push({
    id: 'launcher',
    label: HIGGS_LAUNCH_SCRIPT,
    ok: launcherOk,
    detail: launcherOk ? undefined : `Not executable at ${envPrefix}/bin/${HIGGS_LAUNCH_SCRIPT}.`,
  });
  return checks;
}

/** Where the doctor looks, derived once so both entry points agree. */
function higgsDoctorTarget(config: { distro?: string; condaPath?: string; higgsCondaEnv?: string }) {
  const distro = config.distro || getWslDistro();
  const condaPath = config.condaPath || getWslCondaPath();
  const envName = config.higgsCondaEnv || getWslHiggsCondaEnv();
  // `<base>/bin/conda` → `<base>/envs/<name>`. The same derivation
  // checkWslOrpheusSetup does from the same setting, so the two doctors cannot
  // disagree about where conda keeps its environments.
  const condaBase = condaPath.replace(/\/bin\/conda$/, '');
  return { distro, envName, envPrefix: `${condaBase}/envs/${envName}` };
}

/**
 * The doctor, ASYNCHRONOUSLY — the entry point everything on the main thread
 * should use.
 *
 * `checkWslHiggsSetup` below is `execSync`, roughly a second against a cold WSL
 * VM, and the main thread is the one the bookshelf server shares. The review
 * caught it being run at prep, at EVERY worker start, at assembly and at retake:
 * a per-range health check on a resource that cannot change between the workers
 * of one job. The environment check now happens ONCE PER JOB, in `prepareSession`,
 * which is already an async context — and it happens through this.
 */
export function checkWslHiggsSetupAsync(config: {
  distro?: string;
  condaPath?: string;
  higgsCondaEnv?: string;
} = {}): Promise<WslHiggsSetupResult> {
  if (os.platform() !== 'win32') {
    return Promise.resolve({
      valid: false,
      checks: [{ id: 'distro', label: 'WSL distribution', ok: false, detail: 'WSL is only available on Windows' }],
    });
  }
  const { distro, envName, envPrefix } = higgsDoctorTarget(config);
  const args = distro
    ? ['-d', distro, 'bash', '-c', higgsProbeScript(envPrefix)]
    : ['bash', '-c', higgsProbeScript(envPrefix)];

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (probeError: string | null) => {
      if (done) return;
      done = true;
      const checks = higgsChecksFrom(out, probeError, distro, envName, envPrefix);
      resolve({ valid: checks.every((c) => c.ok), checks, envPrefix });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('wsl.exe', args, { windowsHide: true });
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err));
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish('the WSL probe did not answer within 30 s');
    }, 30000);
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    proc.on('error', (err) => { clearTimeout(timer); finish(err.message); });
    proc.on('close', () => { clearTimeout(timer); finish(null); });
  });
}

/**
 * Is the Higgs v3 serving stack actually usable in WSL? (SYNCHRONOUS.)
 *
 * PREFER `checkWslHiggsSetupAsync`. This one blocks the calling thread for about
 * a second against a cold VM, and on the main thread that is the thread the
 * bookshelf server shares. It is kept because the Settings panel's own IPC and
 * the installer's `--check` both want a straight-line answer, and because
 * deleting it would leave two probe implementations to drift — the two share
 * `higgsProbeScript` and `higgsChecksFrom` precisely so they cannot.
 *
 * ONE `wsl.exe` ROUND TRIP, not five. Each spawn of `wsl.exe` costs the better
 * part of a second on a cold VM, and a doctor that takes five seconds is a doctor
 * nobody runs. The probe emits one `key=value` line per check and this parses
 * them, so adding a check is a line in the script and a row in the result rather
 * than another spawn.
 *
 * EVERY CHECK IS REPORTED, PASS OR FAIL — the probe never short-circuits. "The
 * env exists, vllm-omni imports, the tail-trim patch is missing" is a different
 * problem from "there is no env", and a doctor that stopped at the first failure
 * would make them look the same.
 */
export function checkWslHiggsSetup(config: {
  distro?: string;
  condaPath?: string;
  higgsCondaEnv?: string;
} = {}): WslHiggsSetupResult {
  if (os.platform() !== 'win32') {
    return {
      valid: false,
      checks: [{ id: 'distro', label: 'WSL distribution', ok: false, detail: 'WSL is only available on Windows' }],
    };
  }
  const { distro, envName, envPrefix } = higgsDoctorTarget(config);
  const distroArg = distro ? `-d ${distro}` : '';
  const script = higgsProbeScript(envPrefix);

  let out = '';
  let probeError: string | null = null;
  try {
    out = execSync(`wsl.exe ${distroArg} bash -c "${script.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  const checks = higgsChecksFrom(out, probeError, distro, envName, envPrefix);
  return { valid: checks.every((c) => c.ok), checks, envPrefix };
}

/**
 * WSL routing for TTS.
 *
 * `shouldUseWsl2ForAllTts()` stays off: only Orpheus needs WSL (vLLM CUDA graphs
 * don't capture on native Windows — see CLAUDE.md). XTTS/F5/Voxtral run natively.
 *
 * `shouldUseWsl2ForOrpheus()` is the explicit, user-driven opt-in: when the
 * "Enable WSL2 for Orpheus" toggle in Settings → Add-ons is on (config
 * `useWsl2ForOrpheus`), Orpheus jobs are routed through the WSL spawn path
 * (parallel-tts-bridge → spawnWithWslSupport → `-n <wslOrpheusCondaEnv>`).
 * Windows-only; always false elsewhere.
 */
export function shouldUseWsl2ForAllTts(): boolean {
  return false;
}

export function shouldUseWsl2ForOrpheus(): boolean {
  if (os.platform() !== 'win32') return false;
  loadConfig();
  return state.config.useWsl2ForOrpheus === true;
}

/**
 * Which artifact form the resident streaming engine serves — see
 * `ToolPathsConfig.orpheusStreamingArtifact` for what each costs and why 'merged' is the
 * default. This is the single switch between the fused and adapter streaming patterns.
 *
 * An unrecognised value THROWS rather than quietly reverting to the default. A typo here
 * would otherwise route every stream down the other pattern with nothing reporting it,
 * and the two are near-indistinguishable by ear — the difference shows up only as
 * latency, which is exactly what someone setting this key is trying to change.
 */
export function getOrpheusStreamingArtifact(): 'adapter' | 'merged' {
  loadConfig();
  // Read as `unknown`, not as the declared union: this value comes off a JSON file that
  // people hand-edit, and the Settings draft writes '' for a cleared field. The declared
  // type is the CONTRACT; these checks are what enforce it at the boundary.
  const v = state.config.orpheusStreamingArtifact as unknown;
  if (v === undefined || v === null || v === '') return 'merged';
  if (v !== 'adapter' && v !== 'merged') {
    throw new Error(
      `tool-paths.json: orpheusStreamingArtifact is ${JSON.stringify(v)}; the only valid ` +
      `values are "merged" (fused checkpoint, the default) and "adapter" (shared base + LoRA).`,
    );
  }
  return v;
}

/**
 * WSL routing for the document vision model that reads pages.
 *
 * The same explicit opt-in as `shouldUseWsl2ForOrpheus()`, and deliberately a
 * SEPARATE toggle rather than a second reader of that one: a machine can have a
 * WSL env with vLLM for Orpheus and none for the page reader, or the reverse,
 * and one flag standing for both would route a conversion at an env that does
 * not hold the model. Windows-only; every other platform either reads pages
 * locally (Apple Silicon, MLX) or is pointed at a server by URL.
 */
export function shouldUseWsl2ForVlm(): boolean {
  if (os.platform() !== 'win32') return false;
  loadConfig();
  return state.config.useWsl2ForVlm === true;
}

/**
 * The conda env in WSL that holds vLLM, or undefined when none is set.
 *
 * NO DEFAULT, unlike `getWslOrpheusCondaEnv()`. That one can name
 * 'orpheus_tts' because it is the name this project's own setup instructions
 * create (CLAUDE.md). There is no conventional name for a vLLM env a user built
 * themselves — the one on this machine is called `dots` — so a guess here would
 * send `conda run -n <wrong>` at the wall and report a conda error instead of
 * the setting nobody filled in.
 */
export function getWslVlmCondaEnv(): string | undefined {
  loadConfig();
  const name = state.config.wslVlmCondaEnv?.trim();
  return name && name.length > 0 ? name : undefined;
}

/**
 * The HuggingFace repo the WSL server loads, or undefined when none is set.
 *
 * It is a setting rather than a constant because the name has to match on both
 * sides: vLLM serves the repo it was started with, and foundry sends that same
 * string as the `model` field of every chat request (its registry calls it
 * `endpointModel`). Two places naming the model independently is how they come
 * to disagree, so the server is started from this value and foundry is told
 * this value.
 */
export function getWslVlmModel(): string | undefined {
  loadConfig();
  const repo = state.config.wslVlmModel?.trim();
  return repo && repo.length > 0 ? repo : undefined;
}

/**
 * Get WSL distro name from config
 */
export function getWslDistro(): string | undefined {
  loadConfig();
  return state.config.wslDistro;
}

/**
 * Get WSL conda path from config
 */
export function getWslCondaPath(): string {
  loadConfig();
  return state.config.wslCondaPath || '/home/$USER/miniconda3/bin/conda';
}

/**
 * Get WSL e2a path from config
 */
export function getWslE2aPath(): string {
  loadConfig();
  return state.config.wslE2aPath || '/home/$USER/ebook2audiobook';
}

/**
 * Get WSL Orpheus conda environment name from config
 */
export function getWslOrpheusCondaEnv(): string {
  // CLI/dev seam: override the WSL Orpheus conda env for this process without editing
  // tool-paths.json (mirrors BOOKFORGE_ORPHEUS_MODELS_DIR).
  const envOverride = process.env.WSL_ORPHEUS_CONDA_ENV?.trim();
  if (envOverride) return envOverride;
  loadConfig();
  return state.config.wslOrpheusCondaEnv || 'orpheus_tts';
}

/**
 * Should Higgs jobs run inside WSL?
 *
 * Windows-only and explicitly opted into, exactly like `shouldUseWsl2ForOrpheus`.
 * It is a SEPARATE toggle rather than a second reader of the Orpheus one for the
 * same reason `useWsl2ForVlm` is separate: a machine can perfectly well have a
 * WSL env for one of these and not the other, and folding them together would
 * make enabling Orpheus silently promise a Higgs env that is not there.
 *
 * On macOS/Linux this is false and Higgs runs natively — there is no WSL to route
 * through, and the vllm-omni stack installs directly.
 */
export function shouldUseWsl2ForHiggs(): boolean {
  if (os.platform() !== 'win32') return false;
  loadConfig();
  return state.config.useWsl2ForHiggs === true;
}

/**
 * The conda env in WSL that holds the Higgs v3 serving stack.
 *
 * HAS A DEFAULT (`higgs3`), unlike `getWslVlmCondaEnv()`, and for the reason that
 * one gives for not having one: `higgs3` is a name BookForge's own installer
 * creates, so it is a true statement about a machine that ran the installer
 * rather than a guess about an env the user built themselves.
 */
export function getWslHiggsCondaEnv(): string {
  // CLI/dev seam, mirroring WSL_ORPHEUS_CONDA_ENV: override for one process
  // without editing the config file.
  const envOverride = process.env.WSL_HIGGS_CONDA_ENV?.trim();
  if (envOverride) return envOverride;
  loadConfig();
  return state.config.wslHiggsCondaEnv || 'higgs3';
}

/**
 * Convert a WSL path to a Windows UNC path that Node.js can access
 * e.g., /home/user/file.txt -> \\wsl$\Ubuntu\home\user\file.txt
 */
export function wslPathToWindows(wslPath: string, distro?: string): string {
  if (!wslPath || !wslPath.startsWith('/')) {
    return wslPath; // Not a WSL path
  }
  const distroName = distro || getWslDistro() || 'Ubuntu';
  // Convert forward slashes to backslashes and prepend UNC prefix
  const windowsPath = `\\\\wsl$\\${distroName}${wslPath.replace(/\//g, '\\')}`;
  return windowsPath;
}

/**
 * Convert a Windows path to a WSL path
 * e.g., C:\Users\foo\file.txt -> /mnt/c/Users/foo/file.txt
 */
export function windowsToWslPath(winPath: string): string {
  if (!winPath || !/^[A-Za-z]:/.test(winPath)) {
    return winPath; // Not a Windows path
  }
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(.*)/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}${match[2]}`;
  }
  return winPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const toolPaths = {
  loadConfig,
  saveConfig,
  updateConfig,
  getConfig,
  getEnhanceConfig,
  getCondaPath,
  getFfmpegPath,
  getE2aPath,
  getToolStatus,
  // WSL2 functions
  detectWslAvailability,
  checkWslOrpheusSetup,
  checkWslHiggsSetup,
  shouldUseWsl2ForAllTts,
  shouldUseWsl2ForOrpheus,
  shouldUseWsl2ForHiggs,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  getWslHiggsCondaEnv,
  wslPathToWindows,
  windowsToWslPath,
};
