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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolPathsConfig {
  // Conda/Python
  condaPath?: string;

  // ebook2audiobook
  e2aPath?: string;

  // FFmpeg
  ffmpegPath?: string;

  // DeepFilterNet
  deepFilterCondaEnv?: string;  // Conda environment name for DeepFilterNet

  // WSL2 Configuration (Windows only, for Orpheus TTS)
  useWsl2ForOrpheus?: boolean;    // Master toggle to use WSL2 for Orpheus
  wslDistro?: string;              // WSL distro name (e.g., "Ubuntu")
  wslCondaPath?: string;           // Conda path inside WSL (e.g., "/home/user/miniconda3/bin/conda")
  wslE2aPath?: string;             // e2a path inside WSL (e.g., "/home/user/ebook2audiobook")
}

interface ToolPathsState {
  config: ToolPathsConfig;
  configPath: string;
  loaded: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const state: ToolPathsState = {
  config: {},
  configPath: '',
  loaded: false,
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
    console.error('[TOOL-PATHS] Error loading config:', err);
    state.config = {};
  }

  state.loaded = true;
  return state.config;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ToolPathsConfig): void {
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
export function updateConfig(updates: Partial<ToolPathsConfig>): ToolPathsConfig {
  loadConfig();
  const newConfig = { ...state.config, ...updates };

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
    candidates.push(path.join(dir, 'ebook2audiobook'));
    candidates.push(path.join(dir, 'ebook2audiobook-latest'));
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
 * Priority: config > env var > auto-detect > fallback to 'ffmpeg'
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

  // 3. Auto-detect
  const detected = findExistingPath(getFfmpegCandidates());
  if (detected) {
    return detected;
  }

  // 4. Fallback
  return 'ffmpeg';
}

/**
 * Get ebook2audiobook installation path
 * Priority: config > env var > auto-detect
 */
export function getE2aPath(): string {
  loadConfig();

  // 1. Check configured path
  if (state.config.e2aPath && fs.existsSync(state.config.e2aPath)) {
    return state.config.e2aPath;
  }

  // 2. Check environment variable
  if (process.env.EBOOK2AUDIOBOOK_PATH && fs.existsSync(process.env.EBOOK2AUDIOBOOK_PATH)) {
    return process.env.EBOOK2AUDIOBOOK_PATH;
  }

  // 3. Auto-detect
  const detected = findExistingPath(getE2aCandidates());
  if (detected) {
    return detected;
  }

  // 4. Return a reasonable default (may not exist)
  const homeDir = os.homedir();
  return path.join(homeDir, 'Projects', 'ebook2audiobook');
}

/**
 * Get DeepFilterNet conda environment name
 * Priority: config > fallback to 'ebook2audiobook'
 */
export function getDeepFilterCondaEnv(): string {
  loadConfig();
  return state.config.deepFilterCondaEnv || 'ebook2audiobook';
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
    deepFilterEnv: {
      configured: !!state.config.deepFilterCondaEnv,
      detected: true,  // Can't easily check if env exists
      path: getDeepFilterCondaEnv(),
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
 * Verifies conda, e2a, and orpheus_env are present
 */
export function checkWslOrpheusSetup(config: {
  distro?: string;
  condaPath?: string;
  e2aPath?: string;
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
  const distroArg = config.distro ? ['-d', config.distro] : [];

  // Default paths if not specified
  const condaPath = config.condaPath || '/home/$USER/miniconda3/bin/conda';
  const e2aPath = config.e2aPath || '/home/$USER/ebook2audiobook';
  const orpheusEnvPath = `${e2aPath}/orpheus_env`;

  let condaFound = false;
  let e2aFound = false;
  let orpheusEnvFound = false;

  try {
    // Check conda exists
    const condaCheck = execSync(
      `wsl.exe ${distroArg.join(' ')} bash -c "test -f ${condaPath} && echo 'found' || echo 'not found'"`,
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
      `wsl.exe ${distroArg.join(' ')} bash -c "test -d ${e2aPath} && echo 'found' || echo 'not found'"`,
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
    // Check orpheus_env exists
    const orpheusCheck = execSync(
      `wsl.exe ${distroArg.join(' ')} bash -c "test -d ${orpheusEnvPath} && echo 'found' || echo 'not found'"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    orpheusEnvFound = orpheusCheck.includes('found');
    if (!orpheusEnvFound) {
      errors.push(`Orpheus environment not found at ${orpheusEnvPath}`);
    }
  } catch (err) {
    errors.push(`Failed to check orpheus_env: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    valid: condaFound && e2aFound && orpheusEnvFound,
    condaFound,
    e2aFound,
    orpheusEnvFound,
    errors,
  };
}

/**
 * Check if WSL2 should be used for Orpheus TTS
 * Returns true only on Windows with useWsl2ForOrpheus enabled
 */
export function shouldUseWsl2ForOrpheus(): boolean {
  if (os.platform() !== 'win32') {
    return false;
  }
  loadConfig();
  return state.config.useWsl2ForOrpheus === true;
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
  getE2aPath,
  getDeepFilterCondaEnv,
  getToolStatus,
  // WSL2 functions
  detectWslAvailability,
  checkWslOrpheusSetup,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
};
