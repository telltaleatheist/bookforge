/**
 * THE TWO DIRECTORIES NARRATOR NEEDS, and the python that runs its tools doors.
 *
 *   `narratorScratchRoot()`  where a render's session lives while it is being
 *                            made — the value of `NARRATOR_SESSIONS_ROOT`, which
 *                            `narrator.render.session_store.sessions_root()`
 *                            reads, and the parent of every `ebook-<uuid>`.
 *   `toolsEnvPath()`         the python environment that runs assembly, resume,
 *                            list, whisper, the metadata tools and the ffmpeg /
 *                            ffprobe / sox binaries beside them.
 *
 * ── Phase 6: both of these used to be inside the ebook2audiobook checkout ────
 *
 * Until 2026-09-05 this file was `e2a-paths.ts`, the scratch root defaulted to
 * `<e2a>/tmp`, and the tools env WAS `<e2a>/python_env`. Deleting the checkout
 * took the python interpreter and the session scratch with it — which is why
 * "remove e2a" was not finished when nothing spawned `app.py` any more. Owen's
 * ruling (2026-09-05): *"create a new session scratch root for narrator. it
 * should take over on behalf of e2a"*.
 *
 * So there is now ONE owner of each, and neither derives from an e2a path:
 *
 *   scratch root : the configured `narratorScratchPath` (Settings → "Narrator
 *                  scratch folder"), else `<library>/tmp`. `main.ts`'s
 *                  `applyNarratorScratchRoot()` states it at startup and again
 *                  whenever the library root changes; `cli/narrator-sessions-root.js`
 *                  states the same two rules for a headless run, because a CLI
 *                  that resolved it differently names a session directory the app
 *                  will never look in.
 *   tools env    : `<userData>/runtime/tools-env` (the relocatable conda-pack env
 *                  `tools-env-bootstrap.ts` unpacks), else a `toolsEnvPath`
 *                  stated in tool-paths.json, else a refusal BY NAME. There is no
 *                  step-down to a machine-local conda env: a wrong interpreter
 *                  does not fail at the spawn, it fails somewhere deep inside a
 *                  worker with an ImportError that names a package instead of an
 *                  environment.
 *
 * Paths can still be overridden, in this order:
 *   1. Tool paths config file (managed by tool-paths.ts)
 *   2. `BOOKFORGE_TOOLS_ENV` (the tools env only)
 *   3. `setNarratorScratchRoot()` programmatically, which is what the app and the
 *      CLI both use to state the scratch root
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  getCondaPath as getToolCondaPath,
  getConfiguredToolsEnvPath,
  getFfmpegPath,
  updateConfig as updateToolConfig,
  shouldUseWsl2ForAllTts,
  shouldUseWsl2ForOrpheus,
  shouldUseWsl2ForHiggs,
  getWslDistro,
  getWslCondaPath,
  getWslSessionsRoot,
  getWslOrpheusCondaEnv,
  getWslHiggsCondaEnv,
  wslPathToWindows,
} from './tool-paths';
import { componentManager } from './components/component-manager';
import {
  getActiveToolsEnvPath,
  getToolsEnvDir,
  relocatablePythonPath,
  relocatableEnvBinDirs,
} from './tools-env-bootstrap';

// ─────────────────────────────────────────────────────────────────────────────
// The session scratch root
// ─────────────────────────────────────────────────────────────────────────────

let scratchRoot: string | null = null;

/**
 * State the machine-local scratch root for narrator sessions.
 *
 * `main.ts` derives this from the library root (`<library>/tmp`, INSIDE the
 * library so a finished session caches into the project as a same-volume clone),
 * unless Settings names one. Every native spawn carries it as
 * `NARRATOR_SESSIONS_ROOT`, and every render door passes `--session_dir` derived
 * from it.
 */
export function setNarratorScratchRoot(dir: string | null): void {
  scratchRoot = dir && dir.trim() ? dir.trim() : null;
  console.log('[NARRATOR-PATHS] Scratch root configured:', scratchRoot || '(none stated)');
}

/**
 * The scratch root IF IT CAN BE USED RIGHT NOW, else null.
 *
 * The root normally lives on the library volume, which can be an external drive
 * or a network share that is not mounted — and a Listen session, a voice test or
 * a metadata probe needs neither the library nor a session directory. So this
 * answers "is there a usable sessions root" without inventing one: the caller
 * that can proceed without it (the spawn-env builder) omits the variable, and
 * narrator then REFUSES BY NAME in the two doors that actually need it
 * (`--list_sessions`, and `--resume_session` given a bare id). Every other door
 * passes `--session_dir` explicitly and never reads it.
 *
 * This is deliberately not a fallback: nothing is substituted, and no door
 * silently writes a book somewhere other than where it was asked to.
 */
export function narratorScratchRootIfAvailable(): string | null {
  if (!scratchRoot) return null;
  const volume = path.dirname(scratchRoot);
  if (!fs.existsSync(volume)) return null;
  try {
    fs.mkdirSync(scratchRoot, { recursive: true });
  } catch {
    return null;
  }
  return scratchRoot;
}

/**
 * The scratch root, or a refusal naming what is missing.
 *
 * Used by everything that is ABOUT a session — deriving `--session_dir`, the
 * startup sweep, the narration-cut cache, the resume scan.
 */
export function narratorScratchRoot(): string {
  const dir = narratorScratchRootIfAvailable();
  if (dir) return dir;
  if (!scratchRoot) {
    throw new Error(
      'No narrator scratch root has been stated. The app states it at startup from the ' +
        'library root (<library>/tmp) or from the "Narrator scratch folder" setting; a ' +
        'headless run states it through cli/narrator-sessions-root.js. It is where every ' +
        'render session is written, so there is no default to guess.',
    );
  }
  throw new Error(
    `The narrator scratch root ${scratchRoot} cannot be used: its parent volume ` +
      `(${path.dirname(scratchRoot)}) is not mounted. Sessions are written there, so ` +
      'this is not something to work around — mount the library volume, or point ' +
      '"Narrator scratch folder" at a local path in Settings.',
  );
}

/**
 * The environment variable `narrator.render.session_store.sessions_root()` reads.
 *
 * Named here, once, so the spawn side and the refusal side cannot drift. It was
 * `E2A_TMP_DIR` until Phase 6; narrator REFUSES the old name by name if it is
 * still set anywhere, so a stale export cannot keep a machine working by accident
 * while every other name in the system says narrator.
 */
export const SESSIONS_ROOT_ENV = 'NARRATOR_SESSIONS_ROOT';

// ─────────────────────────────────────────────────────────────────────────────
// Conda executable (runtime override kept for the Settings panel)
// ─────────────────────────────────────────────────────────────────────────────

let runtimeCondaPath: string | null = null;

/**
 * Set the conda executable path (runtime override)
 * For persistent config, use tool-paths.ts updateConfig()
 */
export function setCondaPath(condaPath: string | null): void {
  runtimeCondaPath = condaPath && condaPath.trim() ? condaPath.trim() : null;
  console.log('[NARRATOR-PATHS] Conda path configured:', runtimeCondaPath || '(auto-detect)');

  // Also update persistent config
  if (runtimeCondaPath) {
    updateToolConfig({ condaPath: runtimeCondaPath });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The tools environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the tools environment is run: its own python, or `conda run -p`.
 *
 * 'relocatable' is the conda-pack env BookForge downloads and unpacks itself —
 * a clean target machine has no conda at all, so its interpreter is invoked
 * directly. 'prefix' is an env somebody else built and pointed `toolsEnvPath` at,
 * which may have activation scripts that matter, so conda runs it.
 */
type ToolsEnv = { kind: 'relocatable'; path: string } | { kind: 'prefix'; path: string };

function resolveToolsEnv(): ToolsEnv {
  const managed = getActiveToolsEnvPath();
  if (managed) return { kind: 'relocatable', path: managed };

  const configured = getConfiguredToolsEnvPath();
  if (configured) {
    // Set-but-missing is an ERROR, never a skip: the whole point of stating it is
    // that a different env would run the wrong code.
    if (!fs.existsSync(configured)) {
      throw new Error(
        `toolsEnvPath is set in tool-paths.json to "${configured}", which does not exist. ` +
          'Point it at a real environment or clear it so the managed runtime is used.',
      );
    }
    return { kind: 'prefix', path: configured };
  }

  throw new Error(
    'The tools Python environment is not installed. It runs audiobook assembly, session ' +
      'resume/list, whisper and the metadata tools, and BookForge downloads it on first ' +
      `run into ${getToolsEnvDir()}. Looked for BOOKFORGE_TOOLS_ENV, then that directory, ` +
      'then a "toolsEnvPath" in tool-paths.json. Run the first-run setup, or point ' +
      'toolsEnvPath at an environment that has numpy, soundfile, mutagen and ffmpeg.',
  );
}

/**
 * The tools environment DIRECTORY.
 *
 * Exported because two callers want the folder rather than a command line: the
 * whisper overlay installer (which pips into it) and the page-reader's
 * interpreter search.
 */
export function toolsEnvPath(): string {
  return resolveToolsEnv().path;
}

/** The tools env directory, or null when none is installed. Never throws. */
export function toolsEnvPathIfInstalled(): string | null {
  try {
    return toolsEnvPath();
  } catch {
    return null;
  }
}

/**
 * A marker path for an environment that lives inside the WSL guest.
 *
 * It is never opened. The WSL spawn resolves its env by NAME (`conda run -n
 * <envName>`), and this value exists only so the Windows-side resolution has
 * something non-throwing to return for an engine whose environment is not on
 * this filesystem at all — the Listen picker's availability probe asks the same
 * question the spawn does, and it must not report "unavailable" for the one
 * arrangement that actually works.
 */
function guestEnvMarker(name: string): string {
  return path.join(app.getPath('userData'), 'runtime', name);
}

/**
 * Get the environment path for a specific TTS engine.
 *
 * Different TTS engines require different environments (vLLM's transformers pin
 * conflicts with the tools env's, and MLX is in neither).
 *
 * @param ttsEngine - The TTS engine name (e.g. 'orpheus', 'higgs'); omitted for
 *                    the engine-agnostic tools doors.
 */
export function getEnvPathForEngine(ttsEngine?: string): string {
  // Orpheus via WSL2: the spawn resolves `-n <wslOrpheusCondaEnv>` inside the
  // guest, so this value is never used as a real Windows path. Returning here
  // short-circuits the Windows 'orpheus' component lookup below, which would throw
  // (that component isn't installed when Orpheus runs in WSL).
  if (ttsEngine?.toLowerCase() === 'orpheus' && shouldUseWsl2ForOrpheus()) {
    return guestEnvMarker('orpheus_wsl_env');
  }

  // Higgs never resolves to a WINDOWS env, ever — not even the "point at your own
  // install" shape F5 and Voxtral had. Its serving stack is vLLM-Omni, which has
  // no Windows build at all, so the only correct answer on win32 is the WSL env
  // prefix and the only correct answer without the WSL toggle is a refusal.
  //
  // THE REFUSAL IS THE POINT. Falling through to the branch below would hand back
  // the generic tools env, which does not contain vllm_omni and would fail
  // somewhere deep in a worker with an ImportError that says nothing about WSL.
  // This says the thing a person can act on.
  if (ttsEngine?.toLowerCase() === 'higgs') {
    if (process.platform === 'win32') {
      if (!shouldUseWsl2ForHiggs()) {
        throw new Error(
          'Higgs runs on vLLM-Omni, which has no Windows build. Enable "WSL2 for Higgs" in ' +
            'Settings → Higgs and install the Higgs environment there.',
        );
      }
      return guestEnvMarker('higgs_wsl_env');
    }
    const managed = componentManager.resolveEntry('higgs-env');
    if (managed) return managed;
    throw new Error(
      'Higgs TTS environment not found. Install or locate it in Settings → Higgs.',
    );
  }

  // Orpheus runs in its OWN external/managed conda env (vLLM's deps conflict with
  // the tools env's). The user points at it via Settings → Add-ons; we resolve
  // through the component seam with NO silent fallback to the tools env (it lacks
  // vLLM and would crash deep in the worker). The UI already hides the engine
  // until installed; this guards stale jobs and saved settings.
  //
  // This map had two more rows — `voxtral: 'voxtral-env'` and `f5: 'f5-env'` —
  // removed with their components on 2026-09-05 when the narration picker became
  // Orpheus and Higgs. A saved job that still names one now falls through to the
  // tools env, which does not have that engine either; `assertRunnableTtsEngine`
  // refuses both ids BY NAME long before a spawn (shared/tts/engine-caps.ts).
  const externalEngineComponent: Record<string, string> = {
    orpheus: 'orpheus',
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

  // No engine — the tools doors.
  return toolsEnvPath();
}

/**
 * The macOS environment narrator's Orpheus runs in: MLX, not vLLM.
 *
 * NOT the same env as the tools env, and deliberately so. The Mac Orpheus backend
 * needs mlx / mlx-lm / mlx-audio at specific pins (mlx 0.32.0 for the cross-thread
 * decode stream, mlx-lm 0.31.3 for `GenerationBatch`, mlx-audio 0.4.8 — PORT_NOTES
 * section 7a measured all three), and the old ebook2audiobook env was below two of
 * those floors, which is why three MLX test cases SKIP there. Pointing narrator at
 * a near-miss env would not fail: it would silently decline to overlap decoding and
 * run serially, which reads as "the Mac is just slower".
 *
 * ── The lookup, and why it refuses instead of falling back ──────────────────
 *
 * The component seam first, so an installer owns this the moment it exists. Then
 * the conda base Homebrew's miniconda uses, which is where that installer will put
 * it and where a hand-built env goes today. Then a refusal NAMING the env — never
 * a step down to some other Orpheus env, because the whole point of the pins is
 * that the near-miss env is the failure mode.
 */
export function getNarratorMlxEnv(): string {
  const managed = componentManager.resolveEntry('narrator-mlx');
  if (managed) return managed;

  const brewMiniconda = '/opt/homebrew/Caskroom/miniconda/base/envs';
  const prefix = path.join(brewMiniconda, 'narrator-mlx');
  if (fs.existsSync(prefix)) return prefix;

  throw new Error(
    "The 'narrator-mlx' environment is not installed. Orpheus on macOS runs on MLX " +
      '(mlx 0.32.0 / mlx-lm 0.31.3 / mlx-audio 0.4.8) in its own conda env — the ' +
      'tools environment has none of them and a near-miss env would silently render ' +
      `serially. Looked for a managed 'narrator-mlx' component, then ${prefix}. ` +
      'Create it from packaging/env/narrator-mlx.yml, or point at it in Settings → Add-ons.',
  );
}

/**
 * NO NAMED-ENV ARM ANY MORE, and that is a deletion worth naming.
 *
 * `resolveCondaEnv` used to have a third kind beside 'relocatable' and 'prefix':
 * a conda env resolved BY NAME (`conda run -n ebook2audiobook`), reached when no
 * prefix env existed inside the checkout. It is how Owen's Mac ran every tools
 * door — that machine has the env under a name and no `python_env` folder to
 * find. It is gone because a name is not a location: two conda installs on one
 * machine can both answer to it, and which one `conda run -n` picks depends on
 * the conda that happens to resolve first.
 *
 * The Mac keeps working because `adoptLegacyToolsEnv` (tool-paths.ts) records
 * that env's PREFIX once, so it becomes a stated `toolsEnvPath` like any other.
 */

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
 * How to launch Python for a given engine: spawn `command` with
 * `[...args, <script or -m module>, ...scriptArgs]`.
 *
 * Relocatable env → the env's python directly (no conda on the machine).
 * Prefix env → `conda run -p`. Throws when no env can be found.
 *
 * Note: for Orpheus on Windows with the WSL toggle on, and for Higgs on Windows,
 * the spawn crosses into the guest and never consults this function.
 *
 * @param ttsEngine - Optional TTS engine name; omitted for the tools doors.
 */
export function getPythonInvocation(ttsEngine?: string): PythonInvocation {
  if (ttsEngine) {
    // An engine env is always somebody else's prefix (a component, or a guest
    // marker the WSL spawn never reaches) — run it through conda.
    const envPath = getEnvPathForEngine(ttsEngine);
    console.log(`[NARRATOR-PATHS] Using conda env: ${envPath} for engine: ${ttsEngine}`);
    return { command: getCondaPath(), args: ['run', '--no-capture-output', '-p', envPath, 'python'] };
  }
  const env = resolveToolsEnv();
  if (env.kind === 'relocatable') {
    console.log(`[NARRATOR-PATHS] Using the managed tools env: ${env.path}`);
    return { command: relocatablePythonPath(env.path), args: [] };
  }
  console.log(`[NARRATOR-PATHS] Using the stated tools env: ${env.path}`);
  return { command: getCondaPath(), args: ['run', '--no-capture-output', '-p', env.path, 'python'] };
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
export { shouldUseWsl2ForAllTts, shouldUseWsl2ForOrpheus, shouldUseWsl2ForHiggs, getWslDistro, getWslCondaPath, getWslSessionsRoot, getWslOrpheusCondaEnv, getWslHiggsCondaEnv, wslPathToWindows };

// ─────────────────────────────────────────────────────────────────────────────
// Safe env builder for tools spawns
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
export function buildToolsSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...extra,
  };

  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';

  // `narrator.render.session_store.sessions_root()` reads this. An explicit
  // `extra[SESSIONS_ROOT_ENV]` wins (the spread above happens first, so re-apply
  // it); otherwise the stated scratch root, IF its volume is mounted.
  //
  // When it is not, the variable is left UNSET rather than pointed somewhere
  // else. Two doors need it (`--list_sessions`, and `--resume_session` with a
  // bare id) and both refuse by name when it is missing; every other door carries
  // `--session_dir` and never reads it. See narratorScratchRootIfAvailable.
  const stated = extra[SESSIONS_ROOT_ENV] || narratorScratchRootIfAvailable();
  if (stated) env[SESSIONS_ROOT_ENV] = stated;
  else delete env[SESSIONS_ROOT_ENV];

  // narrator resolves ffmpeg/ffprobe from PATH (the env may not ship them). A
  // packaged app launched from Finder/Explorer inherits a minimal PATH, so make
  // the resolved ffmpeg's directory visible to every tools spawn.
  const ffmpegDir = path.dirname(getFfmpegPath());
  if (ffmpegDir && ffmpegDir !== '.' && !(env[pathKey] || '').includes(ffmpegDir)) {
    env[pathKey] = `${ffmpegDir}${path.delimiter}${env[pathKey] || ''}`;
  }

  // Managed tools env: replicate what `conda activate` would have done — the
  // env's bin dirs go first so its python, ffmpeg/ffprobe/sox/mediainfo and
  // ebook-convert win over anything else on the machine.
  const managed = getActiveToolsEnvPath();
  if (managed) {
    for (const dir of relocatableEnvBinDirs(managed).reverse()) {
      if (!(env[pathKey] || '').includes(dir)) {
        env[pathKey] = `${dir}${path.delimiter}${env[pathKey] || ''}`;
      }
    }
    env.CONDA_PREFIX = managed;
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

export const narratorPaths = {
  narratorScratchRoot,
  narratorScratchRootIfAvailable,
  setNarratorScratchRoot,
  toolsEnvPath,
  getPythonInvocation,
  getCondaPath,
  getEnvPathForEngine,
  normalizePath,
  setCondaPath,
  // WSL path conversion
  windowsToWslPath,
  wslToWindowsPath,
  wslPathToWindows,
  // WSL config (re-exported from tool-paths)
  shouldUseWsl2ForOrpheus,
  shouldUseWsl2ForHiggs,
  getWslDistro,
  getWslCondaPath,
  getWslSessionsRoot,
  getWslHiggsCondaEnv,
};
