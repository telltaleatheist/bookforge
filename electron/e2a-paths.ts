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
  shouldUseWsl2ForAllTts,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  wslPathToWindows,
} from './tool-paths';
import { componentManager } from './components/component-manager';

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

  // Orpheus uses a separate environment due to vLLM dependency conflicts.
  // (This is the NATIVE execution path — Windows WSL Orpheus is routed elsewhere
  // via shouldUseWsl2ForOrpheus and never reaches here.)
  if (ttsEngine?.toLowerCase() === 'orpheus') {
    // Prefer an Orpheus the user manages via Settings → Add-ons — an external/BYO
    // conda env they pointed at, or (later) a managed install.
    const managed = componentManager.resolveEntry('orpheus');
    if (managed) {
      return managed;
    }
    // Legacy/bundled layout: a prefix env shipped inside the e2a install.
    const orpheusEnvPath = path.join(basePath, 'orpheus_env');
    if (fs.existsSync(orpheusEnvPath)) {
      return orpheusEnvPath;
    }
    // NO silent fallback to python_env: that env has no vLLM/Orpheus and would
    // crash deep in the worker. Fail clearly so the cause is obvious. (The UI
    // already hides Orpheus when it isn't installed; this guards stale jobs and
    // saved settings.)
    throw new Error(
      'Orpheus TTS environment not found. Install or locate Orpheus in ' +
      'Settings → Add-ons, or create an "orpheus_env" beside your ebook2audiobook install.'
    );
  }

  // Default: use python_env for XTTS and other engines
  return path.join(basePath, 'python_env');
}

// The named conda environment used when an install ships no prefix env folder.
const NAMED_ENV = 'ebook2audiobook';

/**
 * Directories where conda keeps its named environments, best-effort: derived from the
 * resolved conda executable's base, the user's ~/.conda, and CONDA_ENVS_DIRS/PATH.
 * Empty when we can't locate a real conda install (e.g. conda is only a bare command
 * on PATH), which the caller treats as "can't verify" rather than "doesn't exist".
 */
function condaEnvsDirs(): string[] {
  const dirs: string[] = [];
  const condaExe = getCondaPath();
  // .../base/bin/conda  ·  .../base/condabin/conda(.bat)  ·  ...\Scripts\conda.exe
  // → strip the executable and its bin/Scripts/condabin dir to get the conda base.
  if (condaExe && condaExe !== 'conda' && fs.existsSync(condaExe)) {
    dirs.push(path.join(path.dirname(path.dirname(condaExe)), 'envs'));
  }
  dirs.push(path.join(os.homedir(), '.conda', 'envs'));
  const envVar = process.env.CONDA_ENVS_DIRS || process.env.CONDA_ENVS_PATH;
  if (envVar) for (const d of envVar.split(path.delimiter)) if (d.trim()) dirs.push(d.trim());
  return dirs;
}

/** Whether a conda env named `name` exists in any known envs directory. */
function condaNamedEnvExists(name: string): boolean {
  return condaEnvsDirs().some((d) => fs.existsSync(path.join(d, name)));
}

/**
 * Resolve the conda environment for a TTS engine — with NO silent fallback.
 *
 * Two supported install layouts: a prefix env folder shipped inside the e2a install
 * (./python_env, ./orpheus_env), or a named conda env ("ebook2audiobook"). The prefix
 * env wins when present; otherwise we use the named env *but only after confirming it
 * exists*. If neither can be found, we throw a clear error rather than handing conda a
 * name/path that will fail cryptically deep in the worker spawn.
 */
function resolveCondaEnv(
  e2aPath?: string,
  ttsEngine?: string
): { kind: 'prefix'; path: string } | { kind: 'named'; name: string } {
  const basePath = e2aPath || getDefaultE2aPath();
  const envPath = getEnvPathForEngine(ttsEngine, basePath);

  if (fs.existsSync(envPath)) return { kind: 'prefix', path: envPath };

  // No prefix env shipped with this install — use the named conda env.
  const dirs = condaEnvsDirs();
  if (dirs.length === 0) {
    // Couldn't locate a real conda install to check against. Proceed with the named
    // env; conda's own resolution surfaces a clear error if it's actually missing.
    console.warn(`[E2A-PATHS] Using named conda env '${NAMED_ENV}' — could not locate conda to verify it (no prefix env at ${envPath})`);
    return { kind: 'named', name: NAMED_ENV };
  }
  if (condaNamedEnvExists(NAMED_ENV)) {
    console.log(`[E2A-PATHS] Using named conda env '${NAMED_ENV}' (no prefix env at ${envPath})`);
    return { kind: 'named', name: NAMED_ENV };
  }
  throw new Error(
    `No ebook2audiobook conda environment found. Looked for a prefix env at "${envPath}" ` +
    `and a named env "${NAMED_ENV}" under: ${dirs.join(', ')}. ` +
    `Create the env or set the correct e2a / conda paths in Settings.`
  );
}

/**
 * Get the conda run arguments for executing Python in the ebook2audiobook environment.
 *
 * Returns args for either a prefix env (./python_env) or the named env, per the
 * detected install layout (see resolveCondaEnv). Throws if neither env exists.
 *
 * Note: For Orpheus TTS on Windows, WSL2 with orpheus_tts conda env is preferred for
 * CUDA graph performance. This function is for legacy Windows native execution.
 *
 * @param e2aPath - Optional base e2a path (defaults to auto-detected path)
 * @param ttsEngine - Optional TTS engine name to determine which environment to use
 */
export function getCondaRunArgs(e2aPath?: string, ttsEngine?: string): string[] {
  const env = resolveCondaEnv(e2aPath, ttsEngine);
  if (env.kind === 'prefix') {
    console.log(`[E2A-PATHS] Using conda env: ${env.path} for engine: ${ttsEngine || 'default'}`);
    return ['run', '--no-capture-output', '-p', env.path, 'python'];
  }
  return ['run', '--no-capture-output', '-n', env.name, 'python'];
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
  const env = resolveCondaEnv(e2aPath, ttsEngine);
  // Prefix env → activate by path (quoted); named env → activate by name.
  const target = env.kind === 'prefix' ? `"${env.path}"` : env.name;

  if (platform === 'win32') {
    return `conda activate ${target} && `;
  }
  return `source $(conda info --base)/etc/profile.d/conda.sh && conda activate ${target} && `;
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
// Shell Escaping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape arguments for shell: true spawn calls.
 * Node.js spawn with shell:true uses /bin/sh on Unix and cmd.exe on Windows.
 * These have different quoting rules:
 * - Unix: wrap in single quotes, escape embedded single quotes
 * - Windows cmd.exe: wrap in double quotes, escape embedded double quotes
 */
export function shellEscapeArgs(args: string[]): string[] {
  if (process.platform === 'win32') {
    // cmd.exe: wrap in double quotes, double any embedded double quotes
    return args.map(arg => {
      if (/[\s"^&|<>()!%]/.test(arg)) {
        return `"${arg.replace(/"/g, '""')}"`;
      }
      return arg;
    });
  }
  // Unix: wrap in single quotes, escape embedded single quotes
  return args.map(arg => {
    if (/['\s"\\$`!#&|;(){}[\]*?<>~]/.test(arg)) {
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }
    return arg;
  });
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
 * Check if the current configuration should use WSL for TTS
 * Re-exported for convenience
 */
export { shouldUseWsl2ForAllTts, shouldUseWsl2ForOrpheus, getWslDistro, getWslCondaPath, getWslE2aPath, getWslOrpheusCondaEnv, wslPathToWindows };

// ─────────────────────────────────────────────────────────────────────────────
// Safe env builder for conda spawns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a spawn-safe environment by spreading process.env and adding extras.
 *
 * On Windows, process.env is a case-insensitive proxy, but spreading it into
 * a plain object loses that property.  conda's `conda run` can further strip
 * entries during environment activation, sometimes dropping System32 from PATH
 * which breaks its internal `chcp` call.  This helper guarantees System32 is
 * always present.
 */
export function buildCondaSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...extra,
  };

  if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    // Always prepend System32 — conda's env activation can replace PATH entirely,
    // so even if System32 is already present, putting it first ensures it survives.
    env[pathKey] = `${system32}${path.delimiter}${env[pathKey] || ''}`;
    // Ensure COMSPEC is set so conda can find cmd.exe for .bat activation scripts
    if (!env.COMSPEC) {
      env.COMSPEC = path.join(system32, 'cmd.exe');
    }
  }

  return env;
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
