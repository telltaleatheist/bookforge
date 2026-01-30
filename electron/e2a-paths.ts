/**
 * Centralized ebook2audiobook path configuration
 *
 * Provides cross-platform default paths for ebook2audiobook installation.
 * Uses tool-paths.ts for base path detection and adds e2a-specific functionality.
 *
 * Paths can be overridden via:
 * 1. Tool paths config file (managed by tool-paths.ts)
 * 2. Environment variable: EBOOK2AUDIOBOOK_PATH
 * 3. Calling setE2aPath() / setCondaPath() programmatically
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  getCondaPath as getToolCondaPath,
  getE2aPath as getToolE2aPath,
  updateConfig as updateToolConfig,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  wslPathToWindows,
} from './tool-paths';

// ─────────────────────────────────────────────────────────────────────────────
// Configurable paths (runtime overrides - for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

let runtimeCondaPath: string | null = null;
let runtimeE2aPath: string | null = null;

/**
 * Set the conda executable path (runtime override)
 * For persistent config, use tool-paths.ts updateConfig()
 */
export function setCondaPath(condaPath: string | null): void {
  runtimeCondaPath = condaPath && condaPath.trim() ? condaPath.trim() : null;
  console.log('[E2A-PATHS] Conda path configured:', runtimeCondaPath || '(auto-detect)');

  // Also update persistent config
  if (runtimeCondaPath) {
    updateToolConfig({ condaPath: runtimeCondaPath });
  }
}

/**
 * Set the e2a installation path (runtime override)
 * For persistent config, use tool-paths.ts updateConfig()
 */
export function setE2aPath(e2aPath: string | null): void {
  runtimeE2aPath = e2aPath && e2aPath.trim() ? e2aPath.trim() : null;
  console.log('[E2A-PATHS] E2A path configured:', runtimeE2aPath || '(auto-detect)');

  // Also update persistent config
  if (runtimeE2aPath) {
    updateToolConfig({ e2aPath: runtimeE2aPath });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution (delegates to tool-paths.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the default ebook2audiobook installation path
 * Checks runtime override first, then delegates to tool-paths.ts
 */
export function getDefaultE2aPath(): string {
  // 1. Check runtime override
  if (runtimeE2aPath && fs.existsSync(runtimeE2aPath)) {
    return runtimeE2aPath;
  }

  // 2. Delegate to centralized tool-paths
  return getToolE2aPath();
}

/**
 * Get the default tmp path for ebook2audiobook sessions
 */
export function getDefaultE2aTmpPath(): string {
  return path.join(getDefaultE2aPath(), 'tmp');
}

/**
 * Get the environment path for a specific TTS engine.
 *
 * Different TTS engines may require different conda environments due to
 * dependency conflicts (e.g., vLLM requires transformers>=4.56, but coqui-tts
 * needs an older version).
 *
 * @param ttsEngine - The TTS engine name (e.g., 'xtts', 'orpheus')
 * @param e2aPath - Optional base e2a path (defaults to auto-detected path)
 * @returns The path to the appropriate conda environment
 */
export function getEnvPathForEngine(ttsEngine?: string, e2aPath?: string): string {
  const basePath = e2aPath || getDefaultE2aPath();

  // Orpheus uses a separate environment due to vLLM dependency conflicts
  if (ttsEngine?.toLowerCase() === 'orpheus') {
    const orpheusEnvPath = path.join(basePath, 'orpheus_env');
    if (fs.existsSync(orpheusEnvPath)) {
      return orpheusEnvPath;
    }
    // Fall back to python_env if orpheus_env doesn't exist
    console.warn('[E2A-PATHS] Warning: orpheus_env not found, falling back to python_env');
  }

  // Default: use python_env for XTTS and other engines
  return path.join(basePath, 'python_env');
}

/**
 * Get the conda run arguments for executing Python in the ebook2audiobook environment.
 *
 * ebook2audiobook uses a prefix-based conda environment (./python_env folder in the project)
 * rather than a named environment. This function returns the correct args for conda run.
 *
 * Note: For Orpheus TTS on Windows, WSL2 with orpheus_tts conda env is preferred for
 * CUDA graph performance. This function is for fallback/legacy Windows native execution.
 *
 * @param e2aPath - Optional base e2a path (defaults to auto-detected path)
 * @param ttsEngine - Optional TTS engine name to determine which environment to use
 */
export function getCondaRunArgs(e2aPath?: string, ttsEngine?: string): string[] {
  const basePath = e2aPath || getDefaultE2aPath();
  const envPath = getEnvPathForEngine(ttsEngine, basePath);

  // Check if the environment exists (prefix-based environment)
  if (fs.existsSync(envPath)) {
    console.log(`[E2A-PATHS] Using conda env: ${envPath} for engine: ${ttsEngine || 'default'}`);
    return ['run', '--no-capture-output', '-p', envPath, 'python'];
  }

  // Fallback to named environment (legacy or custom setup)
  console.log('[E2A-PATHS] Falling back to named environment: ebook2audiobook');
  return ['run', '--no-capture-output', '-n', 'ebook2audiobook', 'python'];
}

/**
 * Get the Python command to use for ebook2audiobook
 * @deprecated Use getCondaRunArgs() instead for more flexibility
 */
export function getPythonCommand(): { command: string; args: string[] } {
  return {
    command: 'conda',
    args: getCondaRunArgs(),
  };
}

/**
 * Get platform-specific conda activation prefix for shell commands
 *
 * @param e2aPath - Optional base e2a path (defaults to auto-detected path)
 * @param ttsEngine - Optional TTS engine name to determine which environment to use
 */
export function getCondaActivation(e2aPath?: string, ttsEngine?: string): string {
  const platform = os.platform();
  const basePath = e2aPath || getDefaultE2aPath();
  const envPath = getEnvPathForEngine(ttsEngine, basePath);

  // Check if the environment exists (prefix-based environment)
  const hasLocalEnv = fs.existsSync(envPath);

  if (platform === 'win32') {
    if (hasLocalEnv) {
      return `conda activate "${envPath}" && `;
    }
    return 'conda activate ebook2audiobook && ';
  } else {
    if (hasLocalEnv) {
      return `source $(conda info --base)/etc/profile.d/conda.sh && conda activate "${envPath}" && `;
    }
    return 'source $(conda info --base)/etc/profile.d/conda.sh && conda activate ebook2audiobook && ';
  }
}

/**
 * Normalize a path for the current platform
 * Converts forward slashes to backslashes on Windows
 */
export function normalizePath(p: string): string {
  return path.normalize(p);
}

/**
 * Get the full path to the conda executable.
 * Checks runtime override first, then delegates to tool-paths.ts
 */
export function getCondaPath(): string {
  // 1. Check runtime override
  if (runtimeCondaPath && fs.existsSync(runtimeCondaPath)) {
    return runtimeCondaPath;
  }

  // 2. Delegate to centralized tool-paths
  return getToolCondaPath();
}

// ─────────────────────────────────────────────────────────────────────────────
// WSL Path Conversion (Windows only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Windows path to WSL path format
 * C:\Users\foo\book.epub -> /mnt/c/Users/foo/book.epub
 *
 * @param winPath - Windows path (e.g., "C:\Users\foo\file.txt")
 * @returns WSL-compatible path (e.g., "/mnt/c/Users/foo/file.txt")
 */
export function windowsToWslPath(winPath: string): string {
  if (!winPath) return winPath;

  // Normalize to forward slashes first
  const normalized = winPath.replace(/\\/g, '/');

  // Match drive letter pattern (C:, D:, etc.)
  const match = normalized.match(/^([A-Za-z]):(.*)/);
  if (match) {
    const driveLetter = match[1].toLowerCase();
    const restOfPath = match[2];
    return `/mnt/${driveLetter}${restOfPath}`;
  }

  // Not a Windows path, return as-is
  return winPath;
}

/**
 * Convert a WSL path to Windows path format
 * /mnt/c/Users/foo/book.epub -> C:\Users\foo\book.epub
 *
 * @param wslPath - WSL path (e.g., "/mnt/c/Users/foo/file.txt")
 * @returns Windows path (e.g., "C:\Users\foo\file.txt")
 */
export function wslToWindowsPath(wslPath: string): string {
  if (!wslPath) return wslPath;

  // Match WSL mount pattern (/mnt/c/...)
  const match = wslPath.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (match) {
    const driveLetter = match[1].toUpperCase();
    const restOfPath = (match[2] || '').replace(/\//g, '\\');
    return `${driveLetter}:${restOfPath}`;
  }

  // Not a WSL mounted path, return as-is
  return wslPath;
}

/**
 * Check if the current configuration should use WSL for Orpheus
 * Re-exported for convenience
 */
export { shouldUseWsl2ForOrpheus, getWslDistro, getWslCondaPath, getWslE2aPath, getWslOrpheusCondaEnv, wslPathToWindows };

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const e2aPaths = {
  getDefaultE2aPath,
  getDefaultE2aTmpPath,
  getPythonCommand,
  getCondaActivation,
  getCondaPath,
  getEnvPathForEngine,
  normalizePath,
  setCondaPath,
  setE2aPath,
  // WSL path conversion
  windowsToWslPath,
  wslToWindowsPath,
  wslPathToWindows,
  // WSL config (re-exported from tool-paths)
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
};
