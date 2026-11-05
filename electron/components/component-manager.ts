/**
 * Component Manager — implements IComponentManager.
 *
 * Owns the installed.json manifest, external detection/recording, managed
 * download/install, verification, and the resolveEntry() integration seam.
 *
 * Install base:  <userData>/components/
 * Manifest:      <userData>/components/installed.json   (InstalledManifest)
 * Per component: <userData>/components/<id>/            (managed installs)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { app, shell } from 'electron';

import { getCatalog, getComponent } from './component-catalog';
import { systemProbe } from './system-probe';
import { downloadAndExtract, downloadFile } from './downloader';
import { getExternalInstaller, installableExternalIds, ExternalInstaller } from './external-installers';
import { LLAMA_CUDA_ID, downloadLlamaCudaInto } from './llama-cuda';
import { CUDA_RVC_ID, installCudaRvc, isCudaRvcInstalled, uninstallCudaRvc, cudaRvcMarkerPath } from './cuda-rvc';
import { ensureRvcVoice, removeRvcVoice, isRvcVoiceInstalled, rvcVoiceModelDir } from '../rvc-models';
import { getPythonInvocation, buildToolsSpawnEnv } from '../narrator-paths';
import type {
  IComponentManager,
  OptionalComponent,
  ComponentArtifact,
  ComponentStatus,
  ComponentState,
  Compatibility,
  InstalledRecord,
  InstalledManifest,
  InstallProgress,
  InstallPhase,
  InstallResult,
  VerifySpec,
  SystemProfile,
  Platform,
} from './component-types';
import { getMainLogger } from '../rolling-logger';
import { renameSyncWithRetry } from '../fs-retry';

// ─────────────────────────────────────────────────────────────────────────────
// Logging — tee to BOTH the console (dev) AND the rolling file logger, so component
// install/detection diagnostics survive in ~/Library/Logs/BookForge/bookforge.log.
// A packaged GUI app discards stdout, so console-only logs were invisible whenever
// an install silently failed (e.g. the RVC engine). Routed through here, the exact
// failure — including the stack on a thrown install error — is always on disk.
// getMainLogger() is lazy and may be pre-init during early detection; guard it.
// ─────────────────────────────────────────────────────────────────────────────

function clog(msg: string, data?: unknown): void {
  data !== undefined ? console.log(msg, data) : console.log(msg);
  try { getMainLogger().info(msg, data); } catch { /* logger not ready */ }
}
function cwarn(msg: string, data?: unknown): void {
  data !== undefined ? console.warn(msg, data) : console.warn(msg);
  try { getMainLogger().warn(msg, data); } catch { /* logger not ready */ }
}
function cerror(msg: string, data?: unknown): void {
  data !== undefined ? console.error(msg, data) : console.error(msg);
  try { getMainLogger().error(msg, data); } catch { /* logger not ready */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths + manifest I/O
// ─────────────────────────────────────────────────────────────────────────────

function getBaseDir(): string {
  return path.join(app.getPath('userData'), 'components');
}

function getManifestPath(): string {
  return path.join(getBaseDir(), 'installed.json');
}

function getInstallDir(id: string): string {
  return path.join(getBaseDir(), id);
}

function readManifest(): InstalledManifest {
  const manifestPath = getManifestPath();
  let corruptReason: string;
  try {
    if (!fs.existsSync(manifestPath)) {
      // Absent manifest = legitimate first run.
      return { components: {} };
    }
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as InstalledManifest;
    if (parsed && typeof parsed === 'object' && parsed.components) {
      return parsed;
    }
    corruptReason = 'file parsed but has no "components" object';
  } catch (err) {
    corruptReason = err instanceof Error ? err.message : String(err);
  }

  // installed.json EXISTS but is unreadable/invalid. Treating it as "nothing
  // installed" would let the next putRecord() overwrite it, discarding
  // manually-configured external component paths — preserve it FIRST.
  const backupPath = `${manifestPath}.corrupt-${Date.now()}`;
  try {
    renameSyncWithRetry(manifestPath, backupPath);
  } catch (renameErr) {
    cerror(`[COMPONENTS] installed.json is corrupt (${corruptReason}) AND could not be backed up — refusing to treat it as empty:`, renameErr);
    throw new Error(
      `installed.json is corrupt (${corruptReason}) and could not be backed up to ${backupPath}: ` +
      `${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
    );
  }
  cerror(`[COMPONENTS] installed.json is corrupt — preserved at ${backupPath}; continuing with an empty manifest (re-point or reinstall components in Settings → Add-ons). Read error: ${corruptReason}`);
  return { components: {} };
}

/** Atomic write: temp file in the same dir + rename. */
function writeManifest(manifest: InstalledManifest): void {
  const base = getBaseDir();
  const manifestPath = getManifestPath();
  try {
    fs.mkdirSync(base, { recursive: true });
    const tmp = path.join(base, `installed.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    renameSyncWithRetry(tmp, manifestPath);
  } catch (err) {
    cerror('[COMPONENTS] Failed to write installed.json:', err);
    throw err;
  }
}

function getRecord(id: string): InstalledRecord | undefined {
  return readManifest().components[id];
}

function putRecord(record: InstalledRecord): void {
  const manifest = readManifest();
  manifest.components[record.id] = record;
  writeManifest(manifest);
}

function dropRecord(id: string): void {
  const manifest = readManifest();
  if (manifest.components[id]) {
    delete manifest.components[id];
    writeManifest(manifest);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-flight managed installs
// ─────────────────────────────────────────────────────────────────────────────

interface InFlight {
  controller: AbortController;
  tempDir: string | null;
}

const inFlight = new Map<string, InFlight>();

// ─────────────────────────────────────────────────────────────────────────────
// External detection
// ─────────────────────────────────────────────────────────────────────────────

function currentPlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  return 'linux';
}

/**
 * PATH lookup via which/where — ASYNC (spawn, not execSync) so it never blocks
 * the main-process event loop. The old blocking execSync (8 s timeout each), run
 * across the external tools on a fresh install, was the bulk of the first-run
 * "components" load that froze the setup UI for ~15 s.
 */
function lookupOnPath(commandName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = os.platform() === 'win32' ? 'where' : 'which';
    let settled = false;
    let out = '';
    const done = (val: string | null) => { if (!settled) { settled = true; resolve(val); } };
    try {
      const child = spawn(cmd, [commandName], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } done(null); }, 8000);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', () => {
        clearTimeout(timer);
        const first = out.split('\n')[0]?.trim();
        done(first && fs.existsSync(first) ? first : null);
      });
    } catch {
      done(null);
    }
  });
}

/**
 * Scan a component's DetectSpec: env var → PATH (commandNames) → candidates for
 * this platform. Returns the first existing path, or null. Records nothing.
 */
async function detectExternal(id: string): Promise<string | null> {
  const component = getComponent(id);
  if (!component || !component.detect) {
    return null;
  }

  const spec = component.detect;
  const platform = currentPlatform();

  // 1. Env var.
  if (spec.envVar && process.env[spec.envVar]) {
    const envPath = process.env[spec.envVar] as string;
    if (fs.existsSync(envPath)) {
      clog(`[COMPONENTS] ${id}: found via env ${spec.envVar}: ${envPath}`);
      return envPath;
    }
  }

  // 2. PATH lookup of command names.
  if (spec.commandNames) {
    for (const name of spec.commandNames) {
      const found = await lookupOnPath(name);
      if (found) {
        clog(`[COMPONENTS] ${id}: found on PATH: ${found}`);
        return found;
      }
    }
  }

  // 3. Candidate paths for this platform.
  if (spec.candidates) {
    for (const cand of spec.candidates) {
      if (cand.platform !== platform) continue;
      try {
        if (fs.existsSync(cand.path)) {
          clog(`[COMPONENTS] ${id}: found candidate: ${cand.path}`);
          return cand.path;
        }
      } catch {
        // ignore access errors
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification (VerifySpec runner)
// ─────────────────────────────────────────────────────────────────────────────

interface VerifyResult {
  ok: boolean;
  output: string;
}

/** Resolve the python executable inside a conda env root. */
function envPython(envRoot: string): string {
  if (os.platform() === 'win32') {
    const direct = path.join(envRoot, 'python.exe');
    if (fs.existsSync(direct)) return direct;
    const scripts = path.join(envRoot, 'Scripts', 'python.exe');
    if (fs.existsSync(scripts)) return scripts;
    return direct; // best guess
  }
  return path.join(envRoot, 'bin', 'python');
}

/**
 * Run an external command and capture its output. Uses spawn (not spawnSync) so the Electron main
 * thread / event loop stays free during long steps — without this, conda-unpack
 * (which can take many minutes on a multi-GB env, especially on a slow machine)
 * and heavy python-import verifies froze the whole UI, and spawnSync's fixed 30 s
 * cap turned a slow-but-fine unpack into ETIMEDOUT.
 *
 * Deliberately NO timeout: a legitimately slow computer must be allowed to finish.
 * The user stays in control via the install's Cancel button — pass its AbortSignal
 * and we kill the child on abort (an honest user action, not an arbitrary deadline).
 */
function runExecAsync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; signal?: AbortSignal }
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    if (opts?.signal?.aborted) {
      resolve({ ok: false, output: 'Cancelled' });
      return;
    }
    let out = '';
    let aborted = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts?.cwd, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    const onAbort = () => {
      aborted = true;
      try { child.kill(); } catch { /* already gone */ }
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, output: `${err.message}\n${out}`.trim() });
    });
    child.on('close', (code) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        resolve({ ok: false, output: `Cancelled\n${out}`.trim() });
      } else {
        resolve({ ok: code === 0, output: out.trim() });
      }
    });
  });
}

/**
 * Run a VerifySpec against a resolved entry path.
 *  - exec         → run entryPath with args; success = exit 0 (+ optional expect)
 *  - python-import→ run <envRoot>/bin/python -c "import <module>"
 *  - path-exists  → fs.existsSync(entryPath)
 */
async function runVerify(spec: VerifySpec, entryPath: string, signal?: AbortSignal): Promise<VerifyResult> {
  switch (spec.kind) {
    case 'exec': {
      if (!fs.existsSync(entryPath)) {
        return { ok: false, output: `Path does not exist: ${entryPath}` };
      }
      const res = await runExecAsync(entryPath, spec.args || [], { signal });
      if (!res.ok) return res;
      if (spec.expect && !res.output.includes(spec.expect)) {
        return {
          ok: false,
          output: `Expected "${spec.expect}" in output, got: ${res.output.slice(0, 200)}`,
        };
      }
      return res;
    }
    case 'python-import': {
      // `modules` (multi) takes precedence over the single `module`.
      const mods = spec.modules?.length ? spec.modules : spec.module ? [spec.module] : [];
      if (!mods.length) {
        return { ok: false, output: 'python-import verify has no module(s)' };
      }
      const py = envPython(entryPath);
      if (!fs.existsSync(py)) {
        return { ok: false, output: `Python not found in env: ${py}` };
      }
      // Run with the env dir as cwd: a package may derive writable paths from
      // Path.cwd() at import (ultimate_rvc sets BASE_DIR = cwd, then mkdir's
      // BASE_DIR/"logs"). A GUI app launched from Finder inherits cwd="/", so a
      // bare import would try to create "/logs" and fail on the read-only root.
      // The env dir is always writable here (it's the freshly-extracted install).
      // Importing several modules in one `-c` fails fast if ANY is missing/broken.
      return runExecAsync(py, ['-c', `import ${mods.join(', ')}`], { cwd: entryPath, signal });
    }
    case 'path-exists': {
      const target = spec.entry ? path.join(entryPath, spec.entry) : entryPath;
      return fs.existsSync(target)
        ? { ok: true, output: target }
        : { ok: false, output: `Path does not exist: ${target}` };
    }
    default:
      return { ok: false, output: `Unknown verify kind: ${(spec as VerifySpec).kind}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// External path recording
// ─────────────────────────────────────────────────────────────────────────────

async function setExternalPath(id: string, entryPath: string): Promise<ComponentStatus> {
  const component = getComponent(id);
  if (!component) {
    throw new Error(`Unknown component: ${id}`);
  }

  const verifyResult = await runVerify(component.verify, entryPath);
  if (!verifyResult.ok) {
    throw new Error(
      `${component.name} did not verify at ${entryPath}: ${verifyResult.output || 'verification failed'}`
    );
  }

  const record: InstalledRecord = {
    id,
    version: component.version,
    source: 'external',
    path: path.dirname(entryPath),
    entryPath,
    installedAt: new Date().toISOString(),
  };
  putRecord(record);
  clog(`[COMPONENTS] ${id}: recorded external install at ${entryPath}`);

  const status = await getStatus(id);
  if (!status) {
    throw new Error(`Failed to build status for ${id} after recording`);
  }
  return status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveArtifact(
  component: OptionalComponent,
  profile: SystemProfile
): ComponentArtifact | undefined {
  // Prefer an exact platform+arch match; among those, prefer one whose gpu suits
  // the machine (apple-silicon on Mac, cuda when CUDA present).
  const matches = component.artifacts.filter(
    (a) => a.platform === profile.platform && a.arch === profile.arch
  );
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const preferred = matches.find((a) => {
    if (a.gpu === 'apple-silicon') return profile.appleSilicon;
    if (a.gpu === 'cuda') return profile.cuda.available;
    return true;
  });
  return preferred || matches[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-install steps
// ─────────────────────────────────────────────────────────────────────────────

/** Run conda-unpack inside a freshly-extracted conda env. Async + abortable so a
 *  multi-minute unpack on a slow machine neither freezes the UI nor times out. */
async function runCondaUnpack(envRoot: string, signal?: AbortSignal): Promise<void> {
  if (os.platform() === 'win32') {
    const unpack = path.join(envRoot, 'Scripts', 'conda-unpack.exe');
    if (!fs.existsSync(unpack)) {
      cwarn(`[COMPONENTS] conda-unpack not found at ${unpack}; skipping`);
      return;
    }
    const res = await runExecAsync(unpack, [], { signal });
    if (!res.ok) throw new Error(`conda-unpack failed: ${res.output}`);
    return;
  }

  // POSIX: the conda-unpack script's shebang is `#!/usr/bin/env python`, which
  // resolves `python` off PATH. The env's own bin is NOT on the app's PATH, and
  // macOS has no system `python` (only python3), so executing the script directly
  // fails with "env: python: No such file or directory". Invoke it through the
  // env's own python so the shebang is bypassed entirely — no PATH dependency.
  const unpack = path.join(envRoot, 'bin', 'conda-unpack');
  const py = path.join(envRoot, 'bin', 'python');
  if (!fs.existsSync(unpack)) {
    cwarn(`[COMPONENTS] conda-unpack not found at ${unpack}; skipping`);
    return;
  }
  const runner = fs.existsSync(py) ? py : unpack; // fall back to the script if no python symlink
  const args = runner === py ? [unpack] : [];
  const res = await runExecAsync(runner, args, { signal });
  if (!res.ok) {
    throw new Error(`conda-unpack failed: ${res.output}`);
  }
}

/**
 * Remove a dir, retrying through the transient file locks Windows holds for a
 * moment after a child process (e.g. a killed conda-unpack) exits — without the
 * retry, rmSync throws EBUSY/EPERM and the multi-GB temp dir leaks.
 */
async function rmrfWithRetry(dir: string, attempts = 4): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (!fs.existsSync(dir)) return;
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        cwarn(`[COMPONENTS] temp cleanup failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/**
 * Reclaim leftover install temp dirs from PRIOR runs that never cleaned up — a
 * conda-unpack killed by timeout/cancel can leave locked files the in-line
 * cleanup couldn't remove, and an app crash mid-install skips the finally
 * entirely. Swept at the start of each install. Skips any dir that belongs to an
 * install currently in flight (concurrent voice downloads).
 */
function sweepStaleInstallTemp(): void {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  const active = new Set<string>();
  for (const inf of inFlight.values()) {
    if (inf.tempDir) active.add(path.basename(inf.tempDir));
  }
  for (const name of entries) {
    if (!name.startsWith('bookforge-install-')) continue;
    if (active.has(name)) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      clog(`[COMPONENTS] swept stale install temp: ${name}`);
    } catch (err) {
      cwarn(`[COMPONENTS] could not sweep stale temp ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** chmod +x the entry executable on unix for a managed binary. */
function chmodEntry(entryPath: string): void {
  if (os.platform() === 'win32') return;
  try {
    if (fs.existsSync(entryPath)) {
      fs.chmodSync(entryPath, 0o755);
    }
  } catch (err) {
    cwarn('[COMPONENTS] chmod +x failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUDA RVC (kind 'binary', id 'cuda-rvc') — overlay GPU PyTorch into the rvc-env
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCudaRvc(
  component: OptionalComponent,
  emit: (p: InstallProgress) => void
): Promise<InstallResult> {
  const id = component.id;
  const controller = new AbortController();
  inFlight.set(id, { controller, tempDir: null });
  try {
    await installCudaRvc(emit, controller.signal);
    const marker = cudaRvcMarkerPath();
    const record: InstalledRecord = {
      id,
      version: component.version,
      source: 'managed',
      path: marker,
      entryPath: marker,
      bytes: component.sizeBytes || undefined,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
    return { id, ok: true, record };
  } catch (err) {
    const message = controller.signal.aborted
      ? 'Install cancelled'
      : (err instanceof Error ? err.message : String(err));
    emit({ id, phase: 'error', pct: 0, message });
    return { id, ok: false, error: message };
  } finally {
    inFlight.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RVC enhancement voice (kind 'rvc-model') — download a model tarball and extract
// it into the rvc-models dir (beside the rvc-env engine), reusing ensureRvcVoice.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRvcVoice(
  component: OptionalComponent,
  emit: (p: InstallProgress) => void
): Promise<InstallResult> {
  const id = component.id;
  // ensureRvcVoice dedups internally; there's no cancellable controller, but we
  // register an entry so listStatus/cancel see a consistent in-flight map.
  const controller = new AbortController();
  inFlight.set(id, { controller, tempDir: null });
  try {
    emit({ id, phase: 'download', pct: 0, message: `Downloading ${component.name}…` });
    await ensureRvcVoice(id, (message) => {
      // ensureRvcVoice reports human strings like "Downloading X… 45% (…)"; pull
      // the percent for the bar and map the phase by message content.
      const m = /(\d+)\s*%/.exec(message);
      const pct = m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : 0;
      const phase: InstallPhase = /verify/i.test(message)
        ? 'verify'
        : /install/i.test(message)
          ? 'extract'
          : 'download';
      emit({ id, phase, pct, message });
    });

    const dir = rvcVoiceModelDir(id) || '';
    const record: InstalledRecord = {
      id,
      version: component.version,
      source: 'managed',
      path: dir,
      entryPath: dir, // the voice model dir; resolveEntry checks it exists
      bytes: component.sizeBytes || undefined,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
    clog(`[COMPONENTS] ${id}: RVC voice installed at ${dir}`);
    return { id, ok: true, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ id, phase: 'error', pct: 0, message });
    cerror(`[COMPONENTS] ${id}: RVC voice install failed: ${message}`, {
      id, message, stack: err instanceof Error ? err.stack : undefined,
    });
    return { id, ok: false, error: message };
  } finally {
    inFlight.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Managed install
// ─────────────────────────────────────────────────────────────────────────────

async function install(
  id: string,
  onProgress?: (p: InstallProgress) => void
): Promise<InstallResult> {
  const emit = (p: InstallProgress) => {
    try {
      onProgress?.(p);
    } catch {
      /* ignore consumer errors */
    }
  };

  const component = getComponent(id);
  if (!component) {
    return { id, ok: false, error: `Unknown component: ${id}` };
  }
  if (!component.acquisition.includes('managed')) {
    return { id, ok: false, error: `${component.name} does not support managed install.` };
  }

  // RVC enhancement voices download a model tarball into the rvc-models dir via
  // ensureRvcVoice — different mechanism (extract-into-dir), same contract.
  if (component.kind === 'rvc-model') {
    return fetchRvcVoice(component, emit);
  }

  // CUDA RVC overlays a GPU PyTorch build into the rvc-env (pip) — its own
  // branch, same install()/progress contract.
  if (component.id === CUDA_RVC_ID) {
    return fetchCudaRvc(component, emit);
  }

  emit({ id, phase: 'resolve', pct: 0, message: 'Resolving artifact…' });

  const profile = await systemProbe.profile();
  const artifact = resolveArtifact(component, profile);
  clog(`[COMPONENTS] ${id}: install start`, {
    platform: profile.platform, arch: profile.arch,
    url: artifact?.url, bytes: artifact?.bytes, condaUnpack: artifact?.condaUnpack,
  });

  if (!artifact) {
    cerror(`[COMPONENTS] ${id}: no artifact for ${profile.platform}/${profile.arch}`);
    return {
      id,
      ok: false,
      error: `No ${component.name} download is available for ${profile.platform}/${profile.arch}.`,
    };
  }

  // Stub / unpublished artifact → surface "install it yourself" WITHOUT fetching.
  // Two placeholder shapes: an empty url, OR a real url whose asset isn't built
  // yet (bytes:0 + no parts — e.g. the Voxtral win32 entry). The latter would
  // otherwise 404 mid-download and read as a broken install rather than a
  // not-published-yet engine.
  const hasParts = Array.isArray(artifact.parts) && artifact.parts.length > 0;
  const unpublished = !artifact.url || artifact.url.trim() === '' || (!hasParts && artifact.bytes === 0);
  if (unpublished) {
    const help = component.externalHelpUrl ? ` (${component.externalHelpUrl})` : '';
    const error = `${component.name} isn't available for download yet — install it yourself${help}`;
    emit({ id, phase: 'error', pct: 0, message: error });
    return { id, ok: false, error };
  }

  // Pre-check compatibility.
  const compat = systemProbe.evaluate(component, profile);
  if (!compat.compatible) {
    const error = `${component.name} is not compatible with this machine: ${compat.reasons.join(' ')}`;
    emit({ id, phase: 'error', pct: 0, message: error });
    return { id, ok: false, error };
  }

  // Pre-check disk (only if we have a measurement and a known artifact size).
  const sentinel = Number.MAX_SAFE_INTEGER;
  if (profile.freeDiskMB !== sentinel && artifact.bytes > 0) {
    const neededMB = Math.ceil((artifact.bytes / 1024 / 1024) * 2.5); // download + extracted
    if (profile.freeDiskMB < neededMB) {
      const error = `Not enough free disk for ${component.name}: needs ~${neededMB} MB, ${profile.freeDiskMB} MB available.`;
      emit({ id, phase: 'error', pct: 0, message: error });
      return { id, ok: false, error };
    }
  }

  // Reclaim any temp dirs leaked by prior failed/killed installs before adding ours.
  sweepStaleInstallTemp();

  // Set up an abort controller + temp dir for this install.
  const controller = new AbortController();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `bookforge-install-${id}-`));
  inFlight.set(id, { controller, tempDir });

  // The env is moved into finalDir BEFORE relink/verify (see below); track it so
  // the finally can sweep a partial finalDir if those later steps fail/cancel.
  let finalDir: string | null = null;
  let installed = false;

  try {
    // ── Download + verify + extract into tempDir ──
    // downloadAndExtract emits its sub-progress under a platform-arch id
    // (e.g. 'win32-x64'); the renderer filters progress by COMPONENT id, so
    // those events were silently dropped and the bar sat at "Resolving 0%"
    // until 'done'. Re-stamp every download/verify/extract event with the
    // component id so the bar actually tracks the download.
    const dlProgress = (p: InstallProgress) => emit({ ...p, id });
    // The CUDA pack fetches two release zips (build + cudart) with an upstream→
    // mirror fallback and flattens them, rather than the single-archive path.
    if (component.id === LLAMA_CUDA_ID) {
      await downloadLlamaCudaInto(tempDir, dlProgress, controller.signal);
    } else {
      await downloadAndExtract(artifact, tempDir, dlProgress, controller.signal);
    }

    if (controller.signal.aborted) {
      throw new Error('Install cancelled');
    }

    // ── Move into components/<id>/ FIRST, then relink+verify IN PLACE ──
    // conda-unpack rewrites every absolute prefix in the env — including the
    // shebang/launcher of each console-script entry point (Windows `Scripts\*.exe`,
    // POSIX `bin/*`) — to wherever the env CURRENTLY sits. It MUST run at the
    // env's final resting path. The old order (unpack in tempDir, THEN move)
    // baked the temp path into every entry point, so after the move they pointed
    // at the since-deleted `…/Temp/bookforge-install-<id>-XXX/` interpreter and
    // silently broke: on Windows `urvc.exe` exits 1 with NO output (launcher dies
    // before Python starts), on macOS/Linux `bin/urvc` gives "bad interpreter".
    // python.exe + `python -m <pkg>` survived (Python resolves sys.prefix from the
    // interpreter's own location), which is why most of the env worked and only
    // console scripts failed. Moving first fixes the whole class. See rvc-bridge.ts.
    finalDir = getInstallDir(id);
    fs.mkdirSync(getBaseDir(), { recursive: true });
    // Drop any prior record up front. A reinstall replaces the dir below and the
    // relink/verify that follow take minutes; if the app dies mid-relink we want
    // the component to read as "not installed" (record gone, partial dir swept by
    // the finally) rather than "installed but half-relinked". Normal reinstalls
    // uninstall first, so finalDir usually doesn't pre-exist here anyway.
    dropRecord(id);
    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }
    try {
      renameSyncWithRetry(tempDir, finalDir);
    } catch {
      // Cross-device rename can fail (temp on a different volume) — fall back to
      // a recursive copy.
      fs.cpSync(tempDir, finalDir, { recursive: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Entry within the moved tree. component.entryPath is relative to the install
    // dir; for conda envs it is typically '' (env root = install dir).
    const finalEntry = component.entryPath
      ? path.join(finalDir, component.entryPath)
      : finalDir;

    // ── Post-install (relink IN the final dir) ──
    // conda-unpack relinks every prefix in a multi-GB env and reports no progress
    // of its own, so the bar is shown indeterminate (animated) in the UI. Say why
    // it's sitting here so a multi-minute unpack doesn't look hung.
    emit({ id, phase: 'postinstall', pct: 0, message: 'Relinking the environment — this can take a few minutes on a large engine…' });
    if (component.kind === 'conda-env' && artifact.condaUnpack) {
      await runCondaUnpack(finalEntry, controller.signal);
    } else if (component.kind === 'binary') {
      chmodEntry(finalEntry);
    }
    emit({ id, phase: 'postinstall', pct: 100 });

    if (controller.signal.aborted) {
      throw new Error('Install cancelled');
    }

    // ── Verify-run (in the final dir) ──
    emit({ id, phase: 'verify-run', pct: 0, message: 'Verifying install…' });
    const verifyResult = await runVerify(component.verify, finalEntry, controller.signal);
    if (!verifyResult.ok) {
      throw new Error(`Verification failed: ${verifyResult.output}`);
    }
    emit({ id, phase: 'verify-run', pct: 100 });

    const record: InstalledRecord = {
      id,
      version: component.version,
      source: 'managed',
      path: finalDir,
      entryPath: finalEntry,
      sha256: artifact.sha256 || undefined,
      bytes: artifact.bytes || undefined,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    installed = true;

    emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
    clog(`[COMPONENTS] ${id}: managed install complete at ${finalDir}`);
    return { id, ok: true, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ id, phase: 'error', pct: 0, message });
    // Log the FULL failure to the file — message, the phase that was last emitted,
    // and the stack — so a silent install failure on a user's machine is diagnosable
    // from the log instead of vanishing to discarded stdout.
    cerror(`[COMPONENTS] ${id}: managed install failed: ${message}`, {
      id,
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { id, ok: false, error: message };
  } finally {
    // Clean up temp dir if it still exists (rename moves it on success; a
    // failure/cancel leaves it, sometimes behind a transient Windows lock).
    const inf = inFlight.get(id);
    if (inf?.tempDir) {
      await rmrfWithRetry(inf.tempDir);
    }
    // Sweep a partial finalDir: we now move the env in BEFORE relink/verify, so a
    // failure or cancel during those steps leaves a half-installed dir. The record
    // was already dropped, so removing the dir restores a clean "not installed".
    if (finalDir && !installed) {
      await rmrfWithRetry(finalDir);
    }
    inFlight.delete(id);
  }
}

async function cancel(id: string): Promise<void> {
  const inf = inFlight.get(id);
  if (!inf) {
    return;
  }
  clog(`[COMPONENTS] ${id}: cancelling managed install`);
  inf.controller.abort();
  // Don't rm the temp dir here: aborting unwinds install(), whose finally cleans
  // up with retry (a just-killed conda-unpack briefly locks files on Windows, so
  // an immediate rmSync here would race the unwind and fail anyway).
}

// ─────────────────────────────────────────────────────────────────────────────
// Uninstall
// ─────────────────────────────────────────────────────────────────────────────

async function uninstall(id: string): Promise<void> {
  const record = getRecord(id);
  if (!record) {
    clog(`[COMPONENTS] ${id}: nothing to uninstall`);
    return;
  }

  // CUDA RVC isn't a dir under components/ — it's an overlay in the rvc-env.
  // Revert to CPU torch + clear the marker, then drop the record.
  if (id === CUDA_RVC_ID) {
    try {
      uninstallCudaRvc();
    } catch (err) {
      cerror(`[COMPONENTS] ${id}: revert RVC env to CPU torch failed:`, err);
    }
    dropRecord(id);
    clog(`[COMPONENTS] ${id}: reverted GPU RVC overlay`);
    return;
  }

  // RVC voices live in the rvc-models dir (not components/<id>) — delete the
  // model folder + marker via rvc-models, then drop the record.
  if (getComponent(id)?.kind === 'rvc-model') {
    try {
      removeRvcVoice(id);
    } catch (err) {
      cerror(`[COMPONENTS] ${id}: failed to remove RVC voice:`, err);
    }
    dropRecord(id);
    clog(`[COMPONENTS] ${id}: removed RVC voice`);
    return;
  }


  if (record.source === 'managed') {
    const dir = getInstallDir(id);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        clog(`[COMPONENTS] ${id}: removed managed install dir ${dir}`);
      } catch (err) {
        cerror(`[COMPONENTS] ${id}: failed to remove install dir:`, err);
        throw err;
      }
    }
    dropRecord(id);
  } else {
    // External: drop the record only — NEVER delete the user's own install.
    dropRecord(id);
    clog(`[COMPONENTS] ${id}: forgot external install (left on disk)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveEntry — the integration seam
// ─────────────────────────────────────────────────────────────────────────────

function resolveEntry(id: string): string | null {
  const record = getRecord(id);
  if (!record || !record.entryPath) {
    return null;
  }
  try {
    if (fs.existsSync(record.entryPath)) {
      return record.entryPath;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

function stateFromCompat(compat: Compatibility): ComponentState {
  return compat.compatible ? 'available' : 'incompatible';
}

async function buildStatus(
  component: OptionalComponent,
  profile: SystemProfile
): Promise<ComponentStatus> {
  const compatibility = systemProbe.evaluate(component, profile);

  // Already recorded?
  let record = getRecord(component.id);

  // For external components that aren't recorded yet, auto-detect and, on a hit,
  // record so they surface as Installed.
  if (!record && component.acquisition.includes('external') && component.detect) {
    const detected = await detectExternal(component.id);
    if (detected) {
      const verifyResult = await runVerify(component.verify, detected);
      if (verifyResult.ok) {
        record = {
          id: component.id,
          version: component.version,
          source: 'external',
          path: path.dirname(detected),
          entryPath: detected,
          installedAt: new Date().toISOString(),
        };
        putRecord(record);
        clog(`[COMPONENTS] ${component.id}: auto-detected external install at ${detected}`);
      } else {
        cwarn(
          `[COMPONENTS] ${component.id}: detected ${detected} but it failed verify: ${verifyResult.output}`
        );
      }
    }
  }

  // If we have a record but its entry has vanished, treat it as not installed.
  if (record && !resolveEntry(component.id)) {
    cwarn(
      `[COMPONENTS] ${component.id}: recorded entry missing on disk (${record.entryPath}); dropping record`
    );
    dropRecord(component.id);
    record = undefined;
  }

  // RVC voices: the model folder lives in the rvc-models dir, so an already-
  // downloaded voice (or one installed via the legacy path) surfaces as Installed
  // for free, and a record whose folder was deleted out-of-band self-corrects.
  if (!record && component.kind === 'rvc-model' && isRvcVoiceInstalled(component.id)) {
    const dir = rvcVoiceModelDir(component.id) || '';
    record = {
      id: component.id,
      version: component.version,
      source: 'managed',
      path: dir,
      entryPath: dir,
      bytes: component.sizeBytes || undefined,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    clog(`[COMPONENTS] ${component.id}: detected RVC voice at ${dir}`);
  }

  // CUDA RVC: the marker lives in the rvc-env, so it auto-clears if the env is
  // re-unpacked (app update) — detection always reflects the real env state.
  if (!record && component.id === CUDA_RVC_ID && isCudaRvcInstalled()) {
    const marker = cudaRvcMarkerPath();
    record = {
      id: component.id,
      version: component.version,
      source: 'managed',
      path: marker,
      entryPath: marker,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    clog(`[COMPONENTS] ${component.id}: detected CUDA PyTorch overlay in RVC env`);
  }

  let state: ComponentState;
  if (record) {
    state = 'installed';
  } else {
    state = stateFromCompat(compatibility);
  }

  return {
    component,
    state,
    compatibility,
    installed: record,
  };
}

async function listStatus(): Promise<ComponentStatus[]> {
  const profile = await systemProbe.profile();
  const out: ComponentStatus[] = [];
  for (const component of getCatalog()) {
    out.push(await buildStatus(component, profile));
  }
  return out;
}

async function getStatus(id: string): Promise<ComponentStatus | null> {
  const component = getComponent(id);
  if (!component) return null;
  const profile = await systemProbe.profile();
  return buildStatus(component, profile);
}

// ─────────────────────────────────────────────────────────────────────────────
// External-tool installer: download the right OS installer and launch it.
// Standalone (not on the locked IComponentManager contract). Unlike install(),
// it never emits 'done' — the tool is installed out-of-band by its own OS
// installer, so the card's real state comes from detection afterward.
// ─────────────────────────────────────────────────────────────────────────────

export async function runInstaller(
  id: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<InstallResult> {
  const emit = (p: InstallProgress) => { try { onProgress?.(p); } catch { /* ignore */ } };
  const component = getComponent(id);
  if (!component) return { id, ok: false, error: `Unknown component: ${id}` };

  const installer: ExternalInstaller | null = getExternalInstaller(id);
  if (!installer) {
    return { id, ok: false, error: `No installer is available for ${component.name} on this platform.` };
  }

  const controller = new AbortController();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `bookforge-installer-${id}-`));
  inFlight.set(id, { controller, tempDir });
  const dest = path.join(tempDir, installer.filename);

  try {
    emit({ id, phase: 'download', pct: 0, message: `Downloading the ${component.name} installer…` });
    await downloadFile(installer.url, dest, id, emit, controller.signal);

    emit({ id, phase: 'postinstall', pct: 100, message: installer.action === 'open' ? 'Opening installer…' : 'Launching installer…' });
    const launchErr = await shell.openPath(dest);
    if (launchErr) throw new Error(launchErr);

    return { id, ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit({ id, phase: 'error', pct: 0, message: error });
    return { id, ok: false, error };
  } finally {
    inFlight.delete(id);
  }
}

/** Component ids that have a downloadable installer for the current platform. */
export function listInstallableIds(): string[] {
  return installableExternalIds();
}

/** Human guidance to show after an installer is launched (esp. dmg drag-install). */
export function installerNote(id: string): string | null {
  return getExternalInstaller(id)?.note ?? null;
}

/**
 * Is a managed install for this id running right now?
 *
 * A standalone export rather than a method on IComponentManager, which
 * component-types.ts declares a LOCKED CONTRACT — same shape as `runInstaller`
 * and `listInstallableIds` above. The startup upgrade sweep asks so it does not
 * queue an upgrade on top of a transfer somebody else already started into the
 * same directory.
 */
export function isInstalling(id: string): boolean {
  return inFlight.has(id);
}

/**
 * Every recorded install, read straight off installed.json.
 *
 * For callers that want the RECORD and nothing else. `listStatus` answers a
 * bigger question and pays for it: it runs every component's detect spec, which
 * spawns `which`, probes candidate paths and runs python imports — ~35 s on a
 * machine with the engines installed — and it RECORDS what it finds. The startup
 * upgrade sweep wants none of that. It only ever acts on managed records, so
 * external detection could not change its answer, and quietly recording new
 * external installs is not something a background check should be doing.
 */
export function listInstalledRecords(): InstalledRecord[] {
  return Object.values(readManifest().components);
}

/** Does this component's recorded entry still exist on disk? */
export function recordedEntryExists(id: string): boolean {
  return resolveEntry(id) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const componentManager: IComponentManager = {
  listStatus,
  getStatus,
  install,
  cancel,
  detectExternal,
  setExternalPath,
  uninstall,
  resolveEntry,
};
