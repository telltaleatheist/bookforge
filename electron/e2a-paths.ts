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

import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  getCondaPath as getToolCondaPath,
  getE2aPath as getToolE2aPath,
  getFfmpegPath,
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
import {
  getActiveBundledEnvPath,
  relocatablePythonPath,
  relocatableEnvBinDirs,
  hasManagedEnv,
} from './e2a-env-bootstrap';

// ─────────────────────────────────────────────────────────────────────────────
// Configurable paths (runtime overrides - for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

let runtimeCondaPath: string | null = null;
let runtimeE2aPath: string | null = null;
let e2aScratchDir: string | null = null;

/**
 * Set the machine-local scratch dir for e2a temp/session storage. main.ts
 * derives this from the library root (a sibling of the library folder, so it
 * shares the volume — session caching becomes an APFS/ReFS clone — but stays
 * outside the Syncthing-synced tree). Passed to every e2a spawn as
 * E2A_TMP_DIR, which lib/conf.py honors over its <e2a_root>/tmp default.
 */
export function setE2aScratchDir(dir: string | null): void {
  e2aScratchDir = dir && dir.trim() ? dir.trim() : null;
  console.log('[E2A-PATHS] e2a scratch dir configured:', e2aScratchDir || '(default <e2a>/tmp)');
}

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
 * Get the tmp path for ebook2audiobook sessions.
 *
 * Prefers the configured scratch dir (see setE2aScratchDir). The scratch
 * lives on the library volume, which may be an external drive that isn't
 * mounted yet — in that case fall back to <e2a>/tmp for this call rather
 * than failing spawns that don't need the library (e.g. streaming TTS).
 */
export function getDefaultE2aTmpPath(): string {
  if (e2aScratchDir) {
    const volume = path.dirname(e2aScratchDir);
    if (fs.existsSync(volume)) {
      fs.mkdirSync(e2aScratchDir, { recursive: true });
      return e2aScratchDir;
    }
    console.warn(`[E2A-PATHS] Scratch dir volume not mounted (${volume}), using default e2a tmp for this call`);
  }
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

  // vLLM-based engines run in their own external/managed conda env (their deps
  // conflict with the bundled env). The user points at it via Settings → Add-ons;
  // we resolve through the component seam with NO silent fallback to python_env
  // (it lacks their deps and would crash deep in the worker). The UI already hides
  // these engines until installed; this guards stale jobs and saved settings.
  const externalEngineComponent: Record<string, string> = {
    orpheus: 'orpheus',
    voxtral: 'voxtral-env',
  };
  const componentId = externalEngineComponent[ttsEngine?.toLowerCase() ?? ''];
  if (componentId) {
    const managed = componentManager.resolveEntry(componentId);
    if (managed) {
      return managed;
    }
    const label = componentId.charAt(0).toUpperCase() + componentId.slice(1);
    throw new Error(
      `${label} TTS environment not found. Install or locate ${label} in Settings → Add-ons.`
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
 * Resolve the Python environment for a TTS engine — with NO silent fallback.
 *
 * Three supported layouts:
 *  - relocatable: the conda-pack env a packaged build ships (or the
 *    BOOKFORGE_E2A_ENV override in dev). Run via its python directly —
 *    no conda exists on a clean target machine.
 *  - prefix: an env folder shipped inside the e2a install (./python_env),
 *    run via `conda run -p`.
 *  - named: the "ebook2audiobook" conda env, run via `conda run -n`, but only
 *    after confirming it exists.
 * If none can be found, we throw a clear error rather than handing conda a
 * name/path that will fail cryptically deep in the worker spawn.
 */
function resolveCondaEnv(
  e2aPath?: string,
  ttsEngine?: string
): { kind: 'relocatable'; path: string } | { kind: 'prefix'; path: string } | { kind: 'named'; name: string } {
  const basePath = e2aPath || getDefaultE2aPath();
  const envPath = getEnvPathForEngine(ttsEngine, basePath);

  // vLLM engines never use the bundled env (their deps conflict with it); the path
  // from the component seam is verified to exist or has thrown.
  if (['orpheus', 'voxtral'].includes(ttsEngine?.toLowerCase() ?? '')) {
    return { kind: 'prefix', path: envPath };
  }

  // Bundled relocatable env wins: packaged installs always use it, and the
  // BOOKFORGE_E2A_ENV override exists precisely to force this path in dev.
  const bundled = getActiveBundledEnvPath();
  if (bundled) return { kind: 'relocatable', path: bundled };

  // A packaged install that SHIPS a managed env must use ONLY that env — never a
  // machine-local conda env. Falling back to a developer's "ebook2audiobook" conda
  // env made fresh installs look already set up on dev machines while being broken
  // on real users' machines (no conda). No fallback: if the managed env isn't ready
  // here, that's a bug to surface, not paper over. (The first-run setup downloads
  // and verifies it; TTS work is gated on runtime.ready, so this never trips in the
  // normal flow.)
  if (app.isPackaged && hasManagedEnv()) {
    throw new Error(
      'The bundled Python runtime is not installed yet. It downloads during first-run ' +
      'setup — a packaged build never uses a system conda environment.'
    );
  }

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

export interface PythonInvocation {
  command: string;
  args: string[];
}

/**
 * Redirect a path that lands inside app.asar to its asarUnpack'd real-file
 * location. Electron's patched fs sees files inside the archive (so existsSync
 * passes), but a spawned subprocess (Python) uses the real fs and cannot read
 * them — it must be handed the app.asar.unpacked path instead.
 */
export function toUnpackedPath(p: string): string {
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    return p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

/**
 * How to launch Python in the e2a environment: spawn `command` with
 * `[...args, <script>, ...scriptArgs]`.
 *
 * Relocatable env → the env's python directly (no conda on the machine).
 * Prefix / named env → `conda run`. Throws when no env can be found.
 *
 * Note: For Orpheus TTS on Windows, WSL2 with orpheus_tts conda env is preferred
 * for CUDA graph performance — that route never consults this function.
 *
 * @param e2aPath - Optional base e2a path (defaults to auto-detected path)
 * @param ttsEngine - Optional TTS engine name to determine which environment to use
 */
export function getPythonInvocation(e2aPath?: string, ttsEngine?: string): PythonInvocation {
  const env = resolveCondaEnv(e2aPath, ttsEngine);
  if (env.kind === 'relocatable') {
    console.log(`[E2A-PATHS] Using bundled relocatable env: ${env.path} for engine: ${ttsEngine || 'default'}`);
    return { command: relocatablePythonPath(env.path), args: [] };
  }
  if (env.kind === 'prefix') {
    console.log(`[E2A-PATHS] Using conda env: ${env.path} for engine: ${ttsEngine || 'default'}`);
    return { command: getCondaPath(), args: ['run', '--no-capture-output', '-p', env.path, 'python'] };
  }
  return { command: getCondaPath(), args: ['run', '--no-capture-output', '-n', env.name, 'python'] };
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

  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';

  // Relocate e2a's temp/session storage to the configured scratch dir.
  // getDefaultE2aTmpPath() resolves the scratch (or the <e2a>/tmp default
  // when none is set / its volume is offline); conf.py in the e2a fork
  // honors E2A_TMP_DIR. Explicit `extra.E2A_TMP_DIR` still wins (spread above
  // happens first, so re-apply it).
  env.E2A_TMP_DIR = extra.E2A_TMP_DIR || getDefaultE2aTmpPath();

  // e2a's Python resolves ffmpeg/ffprobe from PATH (the conda env doesn't ship
  // them). A packaged app launched from Finder/Explorer inherits a minimal PATH,
  // so make the resolved ffmpeg's directory visible to every e2a spawn.
  const ffmpegDir = path.dirname(getFfmpegPath());
  if (ffmpegDir && ffmpegDir !== '.' && !(env[pathKey] || '').includes(ffmpegDir)) {
    env[pathKey] = `${ffmpegDir}${path.delimiter}${env[pathKey] || ''}`;
  }

  // Relocatable env: replicate what `conda activate` would have done — the
  // env's bin dirs go first so its python, ffmpeg/ffprobe/sox/mediainfo and
  // ebook-convert win over anything else on the machine.
  const bundled = getActiveBundledEnvPath();
  if (bundled) {
    for (const dir of relocatableEnvBinDirs(bundled).reverse()) {
      if (!(env[pathKey] || '').includes(dir)) {
        env[pathKey] = `${dir}${path.delimiter}${env[pathKey] || ''}`;
      }
    }
    env.CONDA_PREFIX = bundled;
  }

  if (process.platform === 'win32') {
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
  getPythonInvocation,
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
