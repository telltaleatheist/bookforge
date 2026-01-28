/**
 * Centralized ebook2audiobook path configuration
 *
 * Provides cross-platform default paths for ebook2audiobook installation.
 * Paths can be overridden via:
 * 1. Environment variable: EBOOK2AUDIOBOOK_PATH
 * 2. Application settings (e2aPath setting)
 * 3. Calling setE2aPath() programmatically
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Platform-specific default paths
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultE2aPaths(): { primary: string; fallback: string } {
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'win32') {
    // Windows: Use user's Projects folder
    const projectsDir = path.join(homeDir, 'Projects');
    return {
      primary: path.join(projectsDir, 'ebook2audiobook'),
      fallback: path.join(projectsDir, 'ebook2audiobook'),
    };
  } else if (platform === 'darwin') {
    // macOS: Original paths for backward compatibility
    return {
      primary: '/Users/telltale/Projects/ebook2audiobook-latest',
      fallback: '/Users/telltale/Projects/ebook2audiobook',
    };
  } else {
    // Linux and others
    return {
      primary: path.join(homeDir, 'Projects', 'ebook2audiobook'),
      fallback: path.join(homeDir, 'ebook2audiobook'),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the default ebook2audiobook installation path
 * Checks environment variable first, then platform-specific defaults
 */
export function getDefaultE2aPath(): string {
  // 1. Check environment variable
  if (process.env.EBOOK2AUDIOBOOK_PATH) {
    return process.env.EBOOK2AUDIOBOOK_PATH;
  }

  // 2. Check platform-specific paths
  const defaults = getDefaultE2aPaths();

  // Prefer primary path if it exists
  try {
    if (fs.existsSync(defaults.primary)) {
      return defaults.primary;
    }
  } catch {
    // Fall through
  }

  // Try fallback path
  try {
    if (fs.existsSync(defaults.fallback)) {
      return defaults.fallback;
    }
  } catch {
    // Fall through
  }

  // Return primary as default even if it doesn't exist yet
  return defaults.primary;
}

/**
 * Get the default tmp path for ebook2audiobook sessions
 */
export function getDefaultE2aTmpPath(): string {
  return path.join(getDefaultE2aPath(), 'tmp');
}

/**
 * Get the conda run arguments for executing Python in the ebook2audiobook environment.
 *
 * ebook2audiobook uses a prefix-based conda environment (./python_env folder in the project)
 * rather than a named environment. This function returns the correct args for conda run.
 */
export function getCondaRunArgs(e2aPath?: string): string[] {
  const platform = os.platform();
  const basePath = e2aPath || getDefaultE2aPath();
  const pythonEnvPath = path.join(basePath, 'python_env');

  // Check if local python_env exists (prefix-based environment)
  if (fs.existsSync(pythonEnvPath)) {
    return ['run', '--no-capture-output', '-p', pythonEnvPath, 'python'];
  }

  // Fallback to named environment (legacy or custom setup)
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
 */
export function getCondaActivation(e2aPath?: string): string {
  const platform = os.platform();
  const basePath = e2aPath || getDefaultE2aPath();
  const pythonEnvPath = path.join(basePath, 'python_env');

  // Check if local python_env exists (prefix-based environment)
  const hasLocalEnv = fs.existsSync(pythonEnvPath);

  if (platform === 'win32') {
    if (hasLocalEnv) {
      return `conda activate "${pythonEnvPath}" && `;
    }
    return 'conda activate ebook2audiobook && ';
  } else {
    if (hasLocalEnv) {
      return `source $(conda info --base)/etc/profile.d/conda.sh && conda activate "${pythonEnvPath}" && `;
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
 * On Windows, conda may not be in PATH when running from Electron,
 * so we need to use the full path.
 */
export function getCondaPath(): string {
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'win32') {
    // Check common Windows conda locations
    const candidates = [
      path.join(homeDir, 'Miniforge3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'miniconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'anaconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'Miniconda3', 'Scripts', 'conda.exe'),
      path.join(homeDir, 'Anaconda3', 'Scripts', 'conda.exe'),
      'C:\\ProgramData\\Miniforge3\\Scripts\\conda.exe',
      'C:\\ProgramData\\miniconda3\\Scripts\\conda.exe',
      'C:\\ProgramData\\Anaconda3\\Scripts\\conda.exe',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback to just 'conda' and hope it's in PATH
    return 'conda';
  } else {
    // On macOS/Linux, conda is usually in PATH or we can find it
    const candidates = [
      path.join(homeDir, 'miniforge3', 'bin', 'conda'),
      path.join(homeDir, 'miniconda3', 'bin', 'conda'),
      path.join(homeDir, 'anaconda3', 'bin', 'conda'),
      '/opt/homebrew/Caskroom/miniforge/base/bin/conda',
      '/usr/local/Caskroom/miniforge/base/bin/conda',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return 'conda';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const e2aPaths = {
  getDefaultE2aPath,
  getDefaultE2aTmpPath,
  getPythonCommand,
  getCondaActivation,
  getCondaPath,
  normalizePath,
};
