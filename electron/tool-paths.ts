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

  // DeepFilterNet (deprecated - use Resemble Enhance instead)
  deepFilterCondaEnv?: string;  // Conda environment name for DeepFilterNet

  // Resemble Enhance (audio enhancement for removing reverb/echo from TTS output)
  resembleCondaEnv?: string;    // Conda environment name for Resemble Enhance (default: 'resemble')
  resembleDevice?: 'auto' | 'cuda' | 'mps' | 'cpu';  // Device for Resemble Enhance (default: 'auto')
  useWsl2ForResemble?: boolean; // Use WSL2 for Resemble Enhance on Windows (default: true on Windows)
  wslResembleCondaEnv?: string; // Conda env name for Resemble in WSL (default: 'resemble')

  // WSL2 Configuration (Windows only, for Orpheus TTS)
  useWsl2ForOrpheus?: boolean;    // Master toggle to use WSL2 for Orpheus
  wslDistro?: string;              // WSL distro name (e.g., "Ubuntu")
  wslCondaPath?: string;           // Conda path inside WSL (e.g., "/home/user/anaconda3/bin/conda")
  wslE2aPath?: string;             // e2a path inside WSL (e.g., "/home/user/ebook2audiobook")
  wslOrpheusCondaEnv?: string;     // Conda env name for Orpheus in WSL (default: "orpheus_tts")
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

/**
 * Get Resemble Enhance conda environment name
 * Priority: config > fallback to 'resemble'
 * See AUDIO_ENHANCEMENT.md for setup instructions
 */
export function getResembleCondaEnv(): string {
  loadConfig();
  return state.config.resembleCondaEnv || 'resemble';
}

/**
 * Get Resemble Enhance device for inference
 * Priority: config > auto-detect based on platform
 *
 * Auto-detection:
 * - Windows: 'cuda' (NVIDIA GPU with CUDA)
 * - macOS: 'mps' (Apple Silicon Metal Performance Shaders)
 * - Linux: 'cuda' (NVIDIA GPU with CUDA)
 *
 * Falls back to 'cpu' if GPU is not available (handled by resemble-enhance itself)
 */
export function getResembleDevice(): 'cuda' | 'mps' | 'cpu' {
  loadConfig();

  const configured = state.config.resembleDevice;

  // If explicitly configured (not 'auto'), use that
  if (configured && configured !== 'auto') {
    return configured;
  }

  // Auto-detect based on platform
  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS: Use MPS (Metal Performance Shaders) for Apple Silicon
    // Note: MPS may need PYTORCH_ENABLE_MPS_FALLBACK=1 for some ops
    return 'mps';
  } else if (platform === 'win32' || platform === 'linux') {
    // Windows/Linux: Use CUDA for NVIDIA GPUs
    return 'cuda';
  }

  // Fallback to CPU for unknown platforms
  return 'cpu';
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
    resembleEnv: {
      configured: !!state.config.resembleCondaEnv,
      detected: true,  // Can't easily check if env exists
      path: getResembleCondaEnv(),
    },
    resembleDevice: {
      configured: !!state.config.resembleDevice && state.config.resembleDevice !== 'auto',
      detected: true,
      path: getResembleDevice(),  // Returns the resolved device (cuda/mps/cpu)
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

/**
 * Check if WSL2 should be used for Orpheus TTS
 * Returns true only on Windows with useWsl2ForOrpheus enabled
 */
export function shouldUseWsl2ForOrpheus(): boolean {
  if (os.platform() !== 'win32') {
    return false;
  }
  loadConfig();
  // Handle both boolean true and string 'true' (settings UI saves as string)
  const value = state.config.useWsl2ForOrpheus as unknown;
  return value === true || value === 'true';
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
  loadConfig();
  return state.config.wslOrpheusCondaEnv || 'orpheus_tts';
}

/**
 * Check if WSL2 should be used for Resemble Enhance
 * On Windows, defaults to true (Resemble works better on Linux)
 */
export function shouldUseWsl2ForResemble(): boolean {
  if (os.platform() !== 'win32') {
    return false;
  }
  loadConfig();
  // Default to true on Windows since Resemble is designed for Linux
  const value = state.config.useWsl2ForResemble as unknown;
  // If not explicitly set, default to true on Windows
  if (value === undefined) {
    return true;
  }
  return value === true || value === 'true';
}

/**
 * Get WSL Resemble conda environment name from config
 */
export function getWslResembleCondaEnv(): string {
  loadConfig();
  return state.config.wslResembleCondaEnv || 'resemble';
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
  getCondaPath,
  getFfmpegPath,
  getE2aPath,
  getDeepFilterCondaEnv,
  getResembleCondaEnv,
  getResembleDevice,
  getToolStatus,
  // WSL2 functions
  detectWslAvailability,
  checkWslOrpheusSetup,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  shouldUseWsl2ForResemble,
  getWslResembleCondaEnv,
  wslPathToWindows,
  windowsToWslPath,
};
