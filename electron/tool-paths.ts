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
import { execSync } from 'child_process';
import { app } from 'electron';
import { getActiveToolsEnvPath, relocatableBinaryPath, relocatablePythonPath } from './tools-env-bootstrap';
import { getManagedBinaryPath } from './update/managed-bins';
import { renameSyncWithRetry } from './fs-retry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolPathsConfig {
  // Conda/Python
  condaPath?: string;

  /**
   * The Python environment that runs the ENGINE-AGNOSTIC doors: audiobook
   * assembly, session resume/list, whisper, the metadata tools, plus the
   * ffmpeg/ffprobe/sox binaries beside them.
   *
   * Normally ABSENT. BookForge downloads and unpacks its own relocatable env
   * into `<userData>/runtime/tools-env` (tools-env-bootstrap.ts) and that is what
   * every install uses. This key exists for the machine that already has a
   * suitable env and does not want a second 1.8 GB copy — and it is what the
   * one-time Phase 6 migration writes when it adopts the environment that used
   * to be resolved as `<ebook2audiobook>/python_env`.
   *
   * Set-but-missing is an ERROR, not a skip (narrator-paths.ts:resolveToolsEnv).
   */
  toolsEnvPath?: string;

  /**
   * Where in-progress narrator sessions are written before being published into
   * the project — the value of `NARRATOR_SESSIONS_ROOT`. Empty =
   * `defaultNarratorScratchRoot()`, `~/Documents/BookForge/scratch`, which is
   * MACHINE-LOCAL (it was `<library>/tmp` until 2026-09-21).
   *
   * Called `ttsScratchPath` until Phase 6; `migrateLegacyConfigKeys()` renames a
   * stored value once, on load, so there are never two live spellings.
   */
  narratorScratchPath?: string;

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

  /*
   * `orpheusHfUser` IS DELETED (2026-09-14, audit section 3.8). It had a
   * Settings row promising that a HuggingFace account's tagged repos would
   * become downloadable, and NO READER anywhere in electron/ — the catalog has
   * always been driven by `orpheusVoiceSources` instead
   * (`orpheus-hf-catalog.ts`). A field that records an instruction nothing
   * carries out is worse than no field.
   */
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
   * and the Bookshelf reader bridge, which are all clients of the same
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
  /*
   * `useWsl2ForAllTts` IS DELETED (2026-09-14, audit section 3.16). Its reader
   * was `shouldUseWsl2ForAllTts()`, which was a hard-wired `return false` —
   * so the key could be set and could never be true, and two call sites were
   * spending a branch on it. Orpheus is the one engine that ever needed the
   * guest, and `useWsl2ForOrpheus` is the toggle that says so.
   */
  wslDistro?: string;              // WSL distro name (e.g., "Ubuntu")
  wslCondaPath?: string;           // Conda path inside WSL (e.g., "/home/user/anaconda3/bin/conda")
  /**
   * The GUEST-SIDE sessions root: where a WSL render writes `ebook-<uuid>`.
   *
   * Empty = `<guest home>/bookforge-sessions`, derived from `wslCondaPath` (see
   * getWslSessionsRoot). It replaced `wslE2aPath`, which named the ebook2audiobook
   * CHECKOUT inside the guest and put the sessions in its `tmp/` — so deleting
   * that checkout took every in-flight render with it, and BookForge's scratch
   * lived inside somebody else's repository.
   */
  wslSessionsRoot?: string;
  /*
   * `wslE2aPath` IS DELETED (2026-09-14, audit section 3.16). It named the
   * guest's ebook2audiobook checkout, and its last reader was a refusal about
   * pre-Phase-6 sessions still sitting in `<wslE2aPath>/tmp`. e2a left this
   * repo on 2026-09-05; an upgrade refusal for a path that has not been
   * written in a year is a UNC listing on the main thread for a directory that
   * is not there. A machine that genuinely still holds those sessions moves
   * them into `getWslSessionsRoot()`, which is what the refusal said to do.
   */

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
      renameSyncWithRetry(configPath, backupPath);
      console.error(`[TOOL-PATHS] tool-paths.json is corrupt — preserved at ${backupPath}. Config writes are disabled until the app restarts with a readable (or absent) config file. Load error: ${message}`);
    } catch (renameErr) {
      console.error(`[TOOL-PATHS] tool-paths.json is corrupt AND could not be backed up (config writes disabled until restart). Load error: ${message}. Backup error:`, renameErr);
    }
  }

  state.loaded = true;
  migrateLegacyConfigKeys();
  return state.config;
}

/**
 * ONE-TIME, ON LOAD: rename the keys Phase 6 retired, so there is never a moment
 * when two spellings are both live.
 *
 * `ttsScratchPath` → `narratorScratchPath` is a pure rename: same meaning, same
 * value, an e2a-era name for a narrator directory. It is rewritten to disk
 * immediately, because a value that is only renamed in memory is a value the
 * Settings panel will helpfully save back under the old name.
 *
 * `wslE2aPath` is NOT migrated and is no longer read AT ALL (2026-09-14). It
 * named a checkout, not a sessions root, and carrying it forward would keep
 * writing BookForge's scratch into somebody else's git repository. A file that
 * still carries the key keeps it; nothing looks.
 *
 * Deliberately NOT wrapped in a try that swallows: if the rewrite fails, the
 * failure is the same one `saveConfig` reports for any other write, and hiding
 * it here would leave the app running on an in-memory rename nobody can see.
 */
function migrateLegacyConfigKeys(): void {
  const raw = state.config as Record<string, unknown>;
  const legacyScratch = raw['ttsScratchPath'];
  if (typeof legacyScratch !== 'string') return;
  delete raw['ttsScratchPath'];
  if (legacyScratch.trim() && !state.config.narratorScratchPath) {
    state.config.narratorScratchPath = legacyScratch.trim();
  }
  if (state.loadFailed) return; // writes are disabled; the rename stays in memory
  console.log(
    `[TOOL-PATHS] Migrated ttsScratchPath -> narratorScratchPath (${legacyScratch.trim() || 'empty, dropped'})`,
  );
  saveConfig({ ...state.config });
}

/** The stated tools environment, or undefined when none is configured. */
export function getConfiguredToolsEnvPath(): string | undefined {
  loadConfig();
  const stated = state.config.toolsEnvPath?.trim();
  return stated && stated.length > 0 ? stated : undefined;
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
  const bundledEnv = getActiveToolsEnvPath();
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
  const bundledEnv = getActiveToolsEnvPath();
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
  const toolsEnv = getConfiguredToolsEnvPath() ?? getActiveToolsEnvPath() ?? '';

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
    toolsEnv: {
      configured: !!state.config.toolsEnvPath,
      detected: !!toolsEnv && fs.existsSync(relocatablePythonPath(toolsEnv)),
      path: toolsEnv,
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
 * The argv that hands wsl.exe a SCRIPT. `--exec` is the point: without it wsl.exe runs the command through
 * the login shell first, which expands every `$var` in the script before bash ever sees it, so the script
 * reads its own variables as empty. Passing an argv directly (`wsl.exe -d D cat /path`) has no `$` for a shell to
 * eat, and neither does `bash -s` with the script on stdin, so those need no change.
 */
export function wslScriptArgs(distro: string | undefined, script: string): string[] {
  return [...(distro ? ['-d', distro] : []), '--exec', 'bash', '-c', script];
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
 * `<conda root>/envs/<name>` inside the guest — a conda env's PREFIX, which is
 * what a launcher needs when it must build `CUDA_HOME`, `PATH` and a `bin/python`
 * out of the environment rather than merely activate it.
 *
 * ONE derivation, here beside `getWslCondaPath` because that is the thing it
 * derives from. `higgs-spawn.ts` had it as a private `wslCondaBase` and
 * `text-server.ts` needs the identical answer; two spellings of "where does
 * `<root>/bin/conda` say the envs live" is one that can be fixed while the other
 * is not.
 *
 * THE CONDA PATH IS AN ARGUMENT, NOT A CALL, and that is not fussiness: reading
 * it inside this function would put it past the seam `tools/test-serve-spawn-env.js`
 * uses — that keeper stubs `getWslCondaPath` on this module to assert the exact
 * environment a Higgs spawn exports, and a derivation that called it internally
 * answered with the unconfigured placeholder instead of the stub (caught by that
 * keeper, 2026-09-08). Callers pass `getWslCondaPath()`.
 */
export function wslCondaEnvPrefix(condaPath: string, envName: string): string {
  return `${condaPath.replace(/\/bin\/conda$/, '')}/envs/${envName}`;
}

/** The default guest sessions directory name, under the guest's home. */
const WSL_SESSIONS_DIRNAME = 'bookforge-sessions';

/**
 * THE GUEST-SIDE SESSIONS ROOT — where a WSL render writes `ebook-<uuid>`.
 *
 * It used to be `<wslE2aPath>/tmp`, i.e. the `tmp/` directory of the guest's
 * ebook2audiobook CHECKOUT: BookForge's scratch lived inside somebody else's git
 * repository, and `git clean` or deleting the checkout took every in-flight
 * render with it. Phase 6 moves it to a directory that is BookForge's.
 *
 * Stated wins; otherwise it is DERIVED from the guest home, which is read off
 * `wslCondaPath` — the one guest path a WSL render already cannot run without.
 * The derivation is deliberately narrow: `/home/<user>/…` only, and only from a
 * value the user actually configured.
 *
 * IT REFUSES RATHER THAN GUESSING, for the reason the old default failed. That
 * default was the literal string `/home/$USER/ebook2audiobook` — UNEXPANDED, and
 * nothing expands it, because the value goes into a single-quoted bash word. A
 * machine with nothing configured wrote its session into a directory literally
 * named `$USER` and BookForge then read from the path it MEANT and found nothing.
 */
export function getWslSessionsRoot(): string {
  loadConfig();
  const configured = state.config.wslSessionsRoot?.trim();
  if (configured) return configured;

  const conda = state.config.wslCondaPath?.trim();
  const home = conda?.match(/^(\/home\/[^/$]+)\//)?.[1];
  if (home) return `${home}/${WSL_SESSIONS_DIRNAME}`;

  throw new Error(
    'No WSL sessions root is configured. It names where a WSL render writes its '
      + 'session, so there is no safe default: BookForge derives it from the guest home '
      + `in "WSL Conda Path" (<home>/${WSL_SESSIONS_DIRNAME}), and that setting is either `
      + "empty or not a /home/<user>/… path. Set \"WSL Sessions Root\" in Settings → "
      + 'Add-ons.',
  );
}

/**
 * Should Higgs jobs run inside WSL?
 *
 * Windows-only and explicitly opted into.
 * It is a SEPARATE toggle rather than a second reader of the Orpheus one for the
 * same reason each door's toggle is separate: a machine can perfectly well have a
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
 * HAS A DEFAULT (`higgs3`), and for the reason that
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

/*
 * `windowsToWslPath` WAS HERE and is gone. It was the second of three copies of
 * the Windows→guest rule, and the one that knew least: it answered only for a
 * drive letter, so a models directory named on the Windows side as
 * `\\wsl$\<distro>\...` — the spelling this very file documents for
 * `orpheusModelsDir` — went to the guest verbatim. THE converter is
 * `narrator-paths.windowsToWslPath`, the inverse of `wslToWindowsPath` beside
 * it; `wslPathToWindows` above stays because it is the `\\wsl$` prefix builder
 * that one is built on, not a converter to choose between.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const toolPaths = {
  loadConfig,
  saveConfig,
  updateConfig,
  getConfig,
  getCondaPath,
  getFfmpegPath,
  getConfiguredToolsEnvPath,
  getToolStatus,
  // WSL2 functions
  detectWslAvailability,
  shouldUseWsl2ForHiggs,
  getWslDistro,
  getWslCondaPath,
  getWslSessionsRoot,
  getWslHiggsCondaEnv,
  wslPathToWindows,
};
