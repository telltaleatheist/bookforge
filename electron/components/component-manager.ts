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
import { spawnSync, execSync } from 'child_process';
import { app } from 'electron';

import { CATALOG, getComponent } from './component-catalog';
import { systemProbe } from './system-probe';
import { downloadAndExtract } from './downloader';
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
  InstallResult,
  VerifySpec,
  SystemProfile,
  Platform,
} from './component-types';

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
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(content) as InstalledManifest;
      if (parsed && typeof parsed === 'object' && parsed.components) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('[COMPONENTS] Failed to read installed.json:', err);
  }
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
    fs.renameSync(tmp, manifestPath);
  } catch (err) {
    console.error('[COMPONENTS] Failed to write installed.json:', err);
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

/** PATH lookup via which/where. Returns the first resolved path, or null. */
function lookupOnPath(commandName: string): string | null {
  try {
    const cmd = os.platform() === 'win32' ? 'where' : 'which';
    const out = execSync(`${cmd} ${commandName}`, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    }).trim();
    if (out) {
      const first = out.split('\n')[0].trim();
      if (first && fs.existsSync(first)) {
        return first;
      }
    }
  } catch {
    // not on PATH
  }
  return null;
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
      console.log(`[COMPONENTS] ${id}: found via env ${spec.envVar}: ${envPath}`);
      return envPath;
    }
  }

  // 2. PATH lookup of command names.
  if (spec.commandNames) {
    for (const name of spec.commandNames) {
      const found = lookupOnPath(name);
      if (found) {
        console.log(`[COMPONENTS] ${id}: found on PATH: ${found}`);
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
          console.log(`[COMPONENTS] ${id}: found candidate: ${cand.path}`);
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

function runExecSync(cmd: string, args: string[]): VerifyResult {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
    if (res.error) {
      return { ok: false, output: res.error.message };
    }
    return { ok: res.status === 0, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run a VerifySpec against a resolved entry path.
 *  - exec         → run entryPath with args; success = exit 0 (+ optional expect)
 *  - python-import→ run <envRoot>/bin/python -c "import <module>"
 *  - path-exists  → fs.existsSync(entryPath)
 */
function runVerify(spec: VerifySpec, entryPath: string): VerifyResult {
  switch (spec.kind) {
    case 'exec': {
      if (!fs.existsSync(entryPath)) {
        return { ok: false, output: `Path does not exist: ${entryPath}` };
      }
      const res = runExecSync(entryPath, spec.args || []);
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
      if (!spec.module) {
        return { ok: false, output: 'python-import verify has no module' };
      }
      const py = envPython(entryPath);
      if (!fs.existsSync(py)) {
        return { ok: false, output: `Python not found in env: ${py}` };
      }
      return runExecSync(py, ['-c', `import ${spec.module}`]);
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

  const verifyResult = runVerify(component.verify, entryPath);
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
  console.log(`[COMPONENTS] ${id}: recorded external install at ${entryPath}`);

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

/** Run conda-unpack inside a freshly-extracted conda env. */
function runCondaUnpack(envRoot: string): void {
  const unpack =
    os.platform() === 'win32'
      ? path.join(envRoot, 'Scripts', 'conda-unpack.exe')
      : path.join(envRoot, 'bin', 'conda-unpack');

  if (!fs.existsSync(unpack)) {
    console.warn(`[COMPONENTS] conda-unpack not found at ${unpack}; skipping`);
    return;
  }
  const res = runExecSync(unpack, []);
  if (!res.ok) {
    throw new Error(`conda-unpack failed: ${res.output}`);
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
    console.warn('[COMPONENTS] chmod +x failed:', err);
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

  emit({ id, phase: 'resolve', pct: 0, message: 'Resolving artifact…' });

  const profile = await systemProbe.profile();
  const artifact = resolveArtifact(component, profile);

  if (!artifact) {
    return {
      id,
      ok: false,
      error: `No ${component.name} download is available for ${profile.platform}/${profile.arch}.`,
    };
  }

  // Stub URL → surface "install it yourself" WITHOUT fetching.
  if (!artifact.url || artifact.url.trim() === '') {
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

  // Set up an abort controller + temp dir for this install.
  const controller = new AbortController();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `bookforge-install-${id}-`));
  inFlight.set(id, { controller, tempDir });

  try {
    // ── Download + verify + extract into tempDir ──
    await downloadAndExtract(artifact, tempDir, emit, controller.signal);

    if (controller.signal.aborted) {
      throw new Error('Install cancelled');
    }

    // Determine the entry within the extracted tree. component.entryPath is
    // relative to the install dir for managed installs. For conda envs it is
    // typically '' (env root = install dir).
    const stagedEntry = component.entryPath
      ? path.join(tempDir, component.entryPath)
      : tempDir;

    // ── Post-install ──
    emit({ id, phase: 'postinstall', pct: 0, message: 'Finalizing…' });
    if (component.kind === 'conda-env' && artifact.condaUnpack) {
      runCondaUnpack(stagedEntry);
    } else if (component.kind === 'binary') {
      chmodEntry(stagedEntry);
    }
    emit({ id, phase: 'postinstall', pct: 100 });

    if (controller.signal.aborted) {
      throw new Error('Install cancelled');
    }

    // ── Verify-run ──
    emit({ id, phase: 'verify-run', pct: 0, message: 'Verifying install…' });
    const verifyResult = runVerify(component.verify, stagedEntry);
    if (!verifyResult.ok) {
      throw new Error(`Verification failed: ${verifyResult.output}`);
    }
    emit({ id, phase: 'verify-run', pct: 100 });

    // ── Atomic move into components/<id>/ ──
    const finalDir = getInstallDir(id);
    fs.mkdirSync(getBaseDir(), { recursive: true });
    // Remove any prior install dir.
    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }
    try {
      fs.renameSync(tempDir, finalDir);
    } catch {
      // Cross-device rename can fail (temp on a different volume) — fall back to
      // a recursive copy.
      fs.cpSync(tempDir, finalDir, { recursive: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const finalEntry = component.entryPath
      ? path.join(finalDir, component.entryPath)
      : finalDir;

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

    emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
    console.log(`[COMPONENTS] ${id}: managed install complete at ${finalDir}`);
    return { id, ok: true, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ id, phase: 'error', pct: 0, message });
    console.error(`[COMPONENTS] ${id}: managed install failed:`, message);
    return { id, ok: false, error: message };
  } finally {
    // Clean up temp dir if it still exists (rename moves it; failures leave it).
    const inf = inFlight.get(id);
    if (inf?.tempDir && fs.existsSync(inf.tempDir)) {
      try {
        fs.rmSync(inf.tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    inFlight.delete(id);
  }
}

async function cancel(id: string): Promise<void> {
  const inf = inFlight.get(id);
  if (!inf) {
    return;
  }
  console.log(`[COMPONENTS] ${id}: cancelling managed install`);
  inf.controller.abort();
  if (inf.tempDir && fs.existsSync(inf.tempDir)) {
    try {
      fs.rmSync(inf.tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  // The install() finally-block also cleans up and removes the map entry.
}

// ─────────────────────────────────────────────────────────────────────────────
// Uninstall
// ─────────────────────────────────────────────────────────────────────────────

async function uninstall(id: string): Promise<void> {
  const record = getRecord(id);
  if (!record) {
    console.log(`[COMPONENTS] ${id}: nothing to uninstall`);
    return;
  }

  if (record.source === 'managed') {
    const dir = getInstallDir(id);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[COMPONENTS] ${id}: removed managed install dir ${dir}`);
      } catch (err) {
        console.error(`[COMPONENTS] ${id}: failed to remove install dir:`, err);
        throw err;
      }
    }
    dropRecord(id);
  } else {
    // External: drop the record only — NEVER delete the user's own install.
    dropRecord(id);
    console.log(`[COMPONENTS] ${id}: forgot external install (left on disk)`);
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
      const verifyResult = runVerify(component.verify, detected);
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
        console.log(`[COMPONENTS] ${component.id}: auto-detected external install at ${detected}`);
      } else {
        console.warn(
          `[COMPONENTS] ${component.id}: detected ${detected} but it failed verify: ${verifyResult.output}`
        );
      }
    }
  }

  // If we have a record but its entry has vanished, treat it as not installed.
  if (record && !resolveEntry(component.id)) {
    console.warn(
      `[COMPONENTS] ${component.id}: recorded entry missing on disk (${record.entryPath}); dropping record`
    );
    dropRecord(component.id);
    record = undefined;
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
  for (const component of CATALOG) {
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
