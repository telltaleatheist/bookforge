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
import { getActiveToolsEnvPath, relocatableBinaryPath, relocatablePythonPath } from './tools-env-bootstrap';
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
   * Where in-progress narrator sessions are written before being cached into the
   * project — the value of `NARRATOR_SESSIONS_ROOT`. Empty = `<library>/tmp`.
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
  /**
   * DEAD KEY, read only to refuse. Pre-Phase-6 this named the guest's
   * ebook2audiobook checkout and `<wslE2aPath>/tmp` was the sessions root.
   * Sessions still sitting there are named in a refusal rather than silently
   * scanned alongside the new root — see legacyGuestSessionsRoot().
   */
  wslE2aPath?: string;
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
 * `wslE2aPath` is NOT migrated. It named a checkout, not a sessions root, and
 * carrying it forward would keep writing BookForge's scratch into somebody
 * else's git repository. It is left in the file, unread except by the refusal
 * that names it (see legacyGuestSessionsRoot).
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

/**
 * ONE-TIME, AT STARTUP: adopt the environment that used to be resolved as
 * `<ebook2audiobook>/python_env` (or the conda env literally named
 * `ebook2audiobook`) as an explicit `toolsEnvPath`.
 *
 * Before Phase 6 the tools env was DERIVED from the e2a checkout: dev resolved
 * `<e2a>/python_env`, and a Mac with no prefix env resolved the named conda env
 * `ebook2audiobook`. Nothing in either is an e2a artifact any more — the contents
 * are numpy/soundfile/mutagen/whisper/ffmpeg — but the LOCATION was, and Owen's
 * ruling was to make the mechanism narrator's rather than to move gigabytes.
 *
 * So the path is RECORDED once, in tool-paths.json, and from then on it is a
 * stated setting like any other. After this runs, nothing resolves a python by
 * asking where ebook2audiobook is. Deleting the checkout afterwards is a broken
 * `toolsEnvPath` that says exactly which directory went missing, instead of a
 * silent re-derivation onto some other machine's layout.
 *
 * Runs only when there is nothing else to use: no `toolsEnvPath`, and no managed
 * `runtime/tools-env`. Called from main.ts after the legacy-directory rename.
 */
export function adoptLegacyToolsEnv(legacyE2aRoots: string[]): void {
  loadConfig();
  if (state.config.toolsEnvPath) return;
  if (getActiveToolsEnvPath()) return;

  const candidates: string[] = [];
  for (const root of legacyE2aRoots) {
    if (root && root.trim()) candidates.push(path.join(root.trim(), 'python_env'));
  }
  // The Mac's shape: a conda env named `ebook2audiobook` with no prefix folder in
  // the checkout. Recorded by PREFIX, not by name, so the stored value is a path
  // like every other tools env and `conda run -p` is the only invocation form.
  const condaExe = getCondaPath();
  const envsDirs: string[] = [];
  if (condaExe && condaExe !== 'conda' && fs.existsSync(condaExe)) {
    envsDirs.push(path.join(path.dirname(path.dirname(condaExe)), 'envs'));
  }
  envsDirs.push(path.join(os.homedir(), '.conda', 'envs'));
  for (const d of envsDirs) candidates.push(path.join(d, 'ebook2audiobook'));

  for (const candidate of candidates) {
    if (!fs.existsSync(relocatablePythonPath(candidate))) continue;
    console.log(
      `[TOOL-PATHS] Adopting ${candidate} as the tools environment (toolsEnvPath). ` +
        'It is recorded in tool-paths.json from now on — nothing resolves a python ' +
        'from an ebook2audiobook path any more.',
    );
    updateConfig({ toolsEnvPath: candidate });
    return;
  }
  console.warn(
    '[TOOL-PATHS] No tools environment is installed and none could be adopted. Assembly, ' +
      'resume/list, whisper and the metadata tools will refuse by name until one exists ' +
      '(first-run setup downloads it; Settings can point at an existing one).',
  );
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
 * Where an ebook2audiobook checkout used to be looked for.
 *
 * The ONLY caller left is `adoptLegacyToolsEnv`, the one-time migration that
 * records `<checkout>/python_env` as `toolsEnvPath`. Nothing resolves a path to
 * run from here — after the migration this list is never consulted again, and
 * on a machine that has a managed tools env it is never consulted at all.
 */
export function legacyE2aCandidates(): string[] {
  const platform = os.platform();
  const homeDir = os.homedir();

  const projectDirs = [
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Developer'),
    path.join(homeDir, 'dev'),
    path.join(homeDir, 'Code'),
    homeDir,
  ];

  const candidates: string[] = [];
  if (process.env.EBOOK2AUDIOBOOK_PATH) candidates.push(process.env.EBOOK2AUDIOBOOK_PATH);
  for (const dir of projectDirs) {
    candidates.push(path.join(dir, 'ebook2audiobook-latest'));
    candidates.push(path.join(dir, 'ebook2audiobook'));
  }
  if (platform === 'win32') candidates.push('C:\\ebook2audiobook');
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

export interface WslOrpheusSetupResult {
  valid: boolean;
  condaFound: boolean;
  /** The GUEST sessions root exists (or its parent does, so it can be created). */
  sessionsRootFound: boolean;
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
  sessionsRoot?: string;
  orpheusCondaEnv?: string;
}): WslOrpheusSetupResult {
  // Only works on Windows
  if (os.platform() !== 'win32') {
    return {
      valid: false,
      condaFound: false,
      sessionsRootFound: false,
      orpheusEnvFound: false,
      errors: ['WSL is only available on Windows'],
    };
  }

  const errors: string[] = [];
  // The execSync string form of the ONE argv builder — see wslScriptArgs. These
  // probes carry no `$` of their own, but their default paths do ($USER), and a
  // probe that silently loses a `$` is exactly what broke the Higgs doctor, so
  // they take the same route rather than being the three that still do not.
  const wslPrefix = wslScriptArgs(config.distro, '').slice(0, -1).join(' ');
  const wslLoginPrefix = wslPrefix.replace(/ -c$/, ' -lc');

  // Default paths if not specified
  const condaPath = config.condaPath || '/home/$USER/anaconda3/bin/conda';
  // The sessions root is CREATED by a render, so the question the doctor asks is
  // whether its PARENT exists — a guest home that is there means the derived root
  // is writable, and demanding the directory itself would report a machine that
  // has simply not rendered yet as broken.
  const sessionsRoot = config.sessionsRoot || getWslSessionsRoot();
  const orpheusCondaEnv = config.orpheusCondaEnv || getWslOrpheusCondaEnv();

  let condaFound = false;
  let sessionsRootFound = false;
  let orpheusEnvFound = false;

  try {
    // Check conda exists
    const condaCheck = execSync(
      `wsl.exe ${wslPrefix} "test -f ${condaPath} && echo 'found' || echo 'not found'"`,
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
    // The sessions root, or the directory it will be created in.
    const parent = sessionsRoot.replace(/\/+[^/]+\/*$/, '') || '/';
    const rootCheck = execSync(
      `wsl.exe ${wslPrefix} "test -d ${sessionsRoot} -o -d ${parent} && echo 'found' || echo 'not found'"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    sessionsRootFound = rootCheck.includes('found');
    if (!sessionsRootFound) {
      errors.push(`The WSL sessions root ${sessionsRoot} cannot be created (${parent} does not exist)`);
    }
  } catch (err) {
    errors.push(`Failed to check the WSL sessions root: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // Check orpheus_tts conda environment exists
    // Use conda env list to check if the environment exists
    const condaBase = condaPath.replace(/\/bin\/conda$/, '');
    const orpheusCheck = execSync(
      `wsl.exe ${wslLoginPrefix} "source ${condaBase}/etc/profile.d/conda.sh && conda env list | grep -q '^${orpheusCondaEnv} ' && echo 'found' || echo 'not found'"`,
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
    valid: condaFound && sessionsRootFound && orpheusEnvFound,
    condaFound,
    sessionsRootFound,
    orpheusEnvFound,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Higgs WSL doctor
// ─────────────────────────────────────────────────────────────────────────────

/** One thing the doctor looked at, and what it found. */
export interface HiggsCheck {
  /**
   * Stable id, so a UI can key on it without matching prose.
   *
   * THE IDS OF BOTH ARMS LIVE IN ONE UNION, because one renderer displays both:
   * `distro`/`vllm-omni`/`patch`/`launcher` can only come from the WSL doctor,
   * `python`/`mlx`/`mlx-audio`/`narrator`/`weights` only from the MLX one, `env`
   * from either (each arm has an environment), and `toggle`/`platform` from the
   * dispatcher that chooses between them.
   */
  id:
    | 'distro' | 'env' | 'vllm-omni' | 'patch' | 'launcher'
    | 'toggle'
    | 'python' | 'mlx' | 'mlx-audio' | 'narrator' | 'weights'
    | 'platform';
  /** What a person reads. Patch rows carry the patch's own id here. */
  label: string;
  ok: boolean;
  /** Present when `ok` is false: what is wrong, in a sentence someone can act on. */
  detail?: string;
}

/**
 * WHICH HIGGS BACKEND this machine would render on — the thing the checks are
 * checks OF. 'none' is a real answer: Linux has neither the WSL route nor an MLX
 * one, and reporting that as a failed WSL doctor (which is what happened before
 * the darwin arm existed) told a Mac user to install WSL.
 */
export type HiggsArm = 'wsl' | 'mlx' | 'none';

export interface HiggsSetupResult {
  valid: boolean;
  /** Which backend was examined. See HiggsArm. */
  arm: HiggsArm;
  /**
   * WHAT TO DO ABOUT A FAILURE, ON THIS ARM — one sentence, always present.
   *
   * It travels WITH the result because the renderer must not decide it: the
   * narration modal used to append "Set it up in Settings → Higgs" to every
   * failure, which on a Mac named a panel that only offers the WSL installer.
   * The doctor knows which arm it ran; the modal does not.
   */
  remedy: string;
  checks: HiggsCheck[];
  /**
   * Lines that are TRUE BUT NOT PASS/FAIL — the catalog voices this arm could
   * load, say. They never touch `valid`: a machine with a green environment and
   * no installed fine-tune is a working Higgs installation.
   */
  notes?: string[];
  /** The env prefix the probe resolved, for error messages and the installer. */
  envPrefix?: string;
}

/** What a WSL-arm failure is fixed by. One copy, used by every WSL return. */
export const WSL_HIGGS_REMEDY =
  'Run Install/Repair on Settings → Higgs, which builds the WSL environment and re-applies '
  + 'the site-packages patches.';

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
  /**
   * A string the patched file must NOT contain — the other half of the proof.
   *
   * A marker alone answers "did somebody apply something here". For the
   * sentinel filter that is not enough: the retired `patch_tail_trim.py` wrote
   * one of the same helpers, and the thing that actually has to be true is that
   * upstream's ONE-FRAME TRIM is gone. `[:, :-1]` occurs twice in the pristine
   * stage processor and zero times after the filter patch (measured on the
   * certifying box, vllm-omni 0.28.0, 2026-09-05), so marker-present plus
   * this-absent is exactly "the token-identity filter is in and no trim code
   * remains".
   */
  absentMarker?: string;
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
    id: 'higgs-sentinel-filter',
    relPath: 'vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py',
    // NOT `_trim_trailing_sentinel_frames`: the patch writes that helper too, and
    // so did the retired patch_tail_trim.py — grepping for it would certify a
    // band-aided file as patched.
    marker: '_filter_sentinel_frames',
    absentMarker: '[:, :-1]',
    why:
      'Without it every rendered chunk ends with ~240 ms of audible garbage — the ' +
      'ramp-down sentinels are substituted with codec code 0, which is a VALID code ' +
      'that decodes to real sound, and only one of the seven frames they smear ' +
      'across is trimmed. The patch keeps a frame only when all 8 codebooks are in ' +
      '[0, 1023], so nothing out of range reaches the codec at all.',
  },
];

/** The launcher the installer deploys INTO the env, so the stack is self-contained. */
export const HIGGS_LAUNCH_SCRIPT = 'serve_higgs_v3.sh';

/**
 * THE ARGV FOR RUNNING A SHELL SCRIPT INSIDE WSL — and the `--exec` is the whole
 * point of this function existing.
 *
 * MEASURED ON owens-pc, 2026-09-05, through the SAME `spawn('wsl.exe', args)`
 * the doctor uses:
 *
 *   ['-d','Ubuntu','bash','-c','f=hi; echo f=$f']            -> "f="     WRONG
 *   ['-d','Ubuntu','--','bash','-c','f=hi; echo f=$f']       -> "f="     WRONG
 *   ['-d','Ubuntu','--exec','bash','-c','f=hi; echo f=$f']   -> "f=hi"   right
 *   ['-d','Ubuntu','-e','bash','-c','f=hi; echo f=$f']       -> "f=hi"   right
 *
 * WITHOUT `--exec`, `wsl.exe` hands the command line to the distro's DEFAULT
 * SHELL first, so that shell expands every `$` before `bash -c` ever sees the
 * script. A variable the script assigns to itself is unset in that outer shell,
 * so it expands to EMPTY and the script runs with a hole in it. `$(...)`
 * assigned to a variable goes the same way, and so does `$!`.
 *
 * `--` DOES NOT FIX IT, which is worth stating because it is the obvious guess:
 * it stops wsl.exe parsing the rest as its own options, but the default shell
 * still runs the command. `--exec` (`-e`) is the flag that means "no shell",
 * and it is what `vlm-page-server.ts`, `cli/orpheus-batch-render.js` and
 * `narrator/serve/__main__.py` were already using.
 *
 * WHAT IT COST: the Higgs doctor's patch probe is
 * `f=$(ls <glob> | head -1); if [ -n "$f" ] ...`, so `$f` was always empty and
 * BOTH patch rows reported "was not found in <env>" on a machine whose files
 * were present AND correctly patched (sentinel marker present, `[:, :-1]`
 * absent, sha 0b36f650 — the certifying server's own file). A doctor that
 * reports a good env as broken sends someone to run Install/Repair over a
 * working install, which on this box would have overwritten the patched
 * site-packages file the current certificate is bound to.
 *
 * Anything passing a SCRIPT to wsl.exe goes through here. Passing an argv
 * directly (`wsl.exe -d D cat /path`) is unaffected — there is no `$` for a
 * shell to eat — and so is `bash -s` with the script on STDIN, which is why
 * `wsl-mounts.ts` needs no change.
 */
export function wslScriptArgs(distro: string | undefined, script: string): string[] {
  return [...(distro ? ['-d', distro] : []), '--exec', 'bash', '-c', script];
}

/**
 * The Higgs doctor's probe script and its result parsing, shared by the sync and
 * async entry points so the two can never disagree about what "green" means.
 */
function higgsProbeScript(envPrefix: string): string {
  // `grep -qF`, fixed-string: `absentMarker` is `[:, :-1]`, which as a BASIC
  // REGULAR EXPRESSION is a bracket expression matching one character out of a
  // set — it would match almost every line of the file and report every env as
  // broken. The markers have no metacharacters today, but they are greppd the
  // same way so that adding one later cannot quietly change what is being asked.
  const patchProbe = HIGGS_PATCHES.map(
    (p) =>
      `f=$(ls ${envPrefix}/lib/python*/site-packages/${p.relPath} 2>/dev/null | head -1); ` +
      `if [ -z "$f" ]; then echo 'patch:${p.id}=absent'; ` +
      `elif ! grep -qF '${p.marker}' "$f"; then echo 'patch:${p.id}=unpatched'; ` +
      (p.absentMarker
        ? `elif grep -qF '${p.absentMarker}' "$f"; then echo 'patch:${p.id}=trim-survived'; `
        : '') +
      `else echo 'patch:${p.id}=ok'; fi`,
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
            : state === 'trim-survived'
              ? `${p.relPath} carries the patch marker "${p.marker}" AND still contains ` +
                `"${p.absentMarker}", which the patch removes. That is a half-applied or ` +
                `stacked state, not a patched one. Restore the file (reinstall the package) and ` +
                `re-run the Higgs installer.`
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
} = {}): Promise<HiggsSetupResult> {
  if (os.platform() !== 'win32') {
    // Reachable only by calling this WSL-specific function directly. `higgsDoctor()`
    // in higgs-doctor.ts routes darwin to the MLX doctor and names any other
    // platform, so nobody arrives here by asking "is Higgs ready".
    return Promise.resolve({
      valid: false,
      arm: 'wsl',
      remedy: WSL_HIGGS_REMEDY,
      checks: [{ id: 'distro', label: 'WSL distribution', ok: false, detail: 'WSL is only available on Windows' }],
    });
  }
  const { distro, envName, envPrefix } = higgsDoctorTarget(config);
  const args = wslScriptArgs(distro, higgsProbeScript(envPrefix));

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (probeError: string | null) => {
      if (done) return;
      done = true;
      const checks = higgsChecksFrom(out, probeError, distro, envName, envPrefix);
      resolve({
        valid: checks.every((c) => c.ok), arm: 'wsl', remedy: WSL_HIGGS_REMEDY, checks, envPrefix,
      });
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
 * env exists, vllm-omni imports, the sentinel-filter patch is missing" is a different
 * problem from "there is no env", and a doctor that stopped at the first failure
 * would make them look the same.
 */
export function checkWslHiggsSetup(config: {
  distro?: string;
  condaPath?: string;
  higgsCondaEnv?: string;
} = {}): HiggsSetupResult {
  if (os.platform() !== 'win32') {
    return {
      valid: false,
      arm: 'wsl',
      remedy: WSL_HIGGS_REMEDY,
      checks: [{ id: 'distro', label: 'WSL distribution', ok: false, detail: 'WSL is only available on Windows' }],
    };
  }
  const { distro, envName, envPrefix } = higgsDoctorTarget(config);
  // The SAME argv the async doctor builds, joined for execSync's command string.
  // Built from wslScriptArgs so the two forms cannot drift on the one flag that
  // decides whether the probe works at all — see that function.
  const script = higgsProbeScript(envPrefix);
  const syncArgv = wslScriptArgs(distro, script)
    .slice(0, -1)
    .join(' ');

  let out = '';
  let probeError: string | null = null;
  try {
    out = execSync(`wsl.exe ${syncArgv} "${script.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  const checks = higgsChecksFrom(out, probeError, distro, envName, envPrefix);
  return {
    valid: checks.every((c) => c.ok), arm: 'wsl', remedy: WSL_HIGGS_REMEDY, checks, envPrefix,
  };
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
      + 'Add-ons, or turn off "WSL2 for Orpheus" to render natively.',
  );
}

/**
 * The PRE-PHASE-6 guest sessions root, or null when the dead key is absent.
 *
 * Returned ONLY so a caller can REFUSE BY NAME. Sessions that were in flight
 * when this machine upgraded are still sitting in `<wslE2aPath>/tmp`, and the
 * two things BookForge must not do with them are equally bad: scan both roots
 * (try-A-then-B, and a resume that silently reads a directory nothing writes any
 * more), or say nothing and start the book again from sentence 0.
 */
export function legacyGuestSessionsRoot(): string | null {
  loadConfig();
  const legacy = state.config.wslE2aPath?.trim();
  return legacy ? `${legacy}/tmp` : null;
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
  getConfiguredToolsEnvPath,
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
  getWslSessionsRoot,
  legacyGuestSessionsRoot,
  getWslOrpheusCondaEnv,
  getWslHiggsCondaEnv,
  wslPathToWindows,
  windowsToWslPath,
};
