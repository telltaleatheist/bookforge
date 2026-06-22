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
import { CUDA_TTS_ID, installCudaTts, isCudaTtsInstalled, uninstallCudaTts, cudaTtsMarkerPath } from './cuda-tts';
import { CUDA_RVC_ID, installCudaRvc, isCudaRvcInstalled, uninstallCudaRvc, cudaRvcMarkerPath } from './cuda-rvc';
import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv } from '../e2a-paths';
import { registerDownloadedVoice, removeCustomVoice, isDownloadedVoiceId } from '../custom-voices';
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
import { getMainLogger } from '../rolling-logger';

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
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(content) as InstalledManifest;
      if (parsed && typeof parsed === 'object' && parsed.components) {
        return parsed;
      }
    }
  } catch (err) {
    cerror('[COMPONENTS] Failed to read installed.json:', err);
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

function runExecSync(cmd: string, args: string[], opts?: { cwd?: string }): VerifyResult {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      cwd: opts?.cwd,
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
      // Run with the env dir as cwd: a package may derive writable paths from
      // Path.cwd() at import (ultimate_rvc sets BASE_DIR = cwd, then mkdir's
      // BASE_DIR/"logs"). A GUI app launched from Finder inherits cwd="/", so a
      // bare import would try to create "/logs" and fail on the read-only root.
      // The env dir is always writable here (it's the freshly-extracted install).
      return runExecSync(py, ['-c', `import ${spec.module}`], { cwd: entryPath });
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

/** Run conda-unpack inside a freshly-extracted conda env. */
function runCondaUnpack(envRoot: string): void {
  if (os.platform() === 'win32') {
    const unpack = path.join(envRoot, 'Scripts', 'conda-unpack.exe');
    if (!fs.existsSync(unpack)) {
      cwarn(`[COMPONENTS] conda-unpack not found at ${unpack}; skipping`);
      return;
    }
    const res = runExecSync(unpack, []);
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
  const res = runExecSync(runner, args);
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
    cwarn('[COMPONENTS] chmod +x failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS-model fetch (kind 'tts-model') — download a HF voice into e2a's HF cache
// ─────────────────────────────────────────────────────────────────────────────

/** The HF-cache repo dir name for a repo id ('a/b' → 'models--a--b'). */
function hfRepoDir(repo: string): string {
  return `models--${repo.replace(/\//g, '--')}`;
}

/** The checkpoint file within a voice's `files` (the .pth, or the last entry). */
function modelFileOf(files: string[]): string {
  return files.find((f) => f.endsWith('.pth')) || files[files.length - 1];
}

/**
 * Glob e2a's HF cache for a tts-model's checkpoint across snapshot revisions.
 * Returns the absolute model.pth path if present (so bundled + already-downloaded
 * voices surface as Installed), else null.
 */
function findTtsModelEntry(component: OptionalComponent): string | null {
  if (!component.hf) return null;
  const { repo, sub, files } = component.hf;
  const snapshotsRoot = path.join(
    getDefaultE2aPath(), 'models', 'tts', hfRepoDir(repo), 'snapshots'
  );
  let snaps: string[];
  try {
    snaps = fs.readdirSync(snapshotsRoot);
  } catch {
    return null;
  }
  const subParts = sub.split('/').filter(Boolean);
  const modelFile = modelFileOf(files);
  for (const snap of snaps) {
    const candidate = path.join(snapshotsRoot, snap, ...subParts, modelFile);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Probe e2a's models/stanza for a language pack's dir. Returns the absolute
 * stanza/<code> path if it exists and is non-empty (so bundled + already-
 * downloaded packs surface as Installed), else null.
 */
function findLanguagePackEntry(component: OptionalComponent): string | null {
  if (!component.stanza) return null;
  try {
    const dir = path.join(getDefaultE2aPath(), 'models', 'stanza', component.stanza.code);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      return dir;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Download a tts-model by spawning the bundled-python helper, which fetches the
 * voice into the same HF cache the XTTS engine reads — so the result is
 * byte-identical to a bundled voice. Progress comes from BF_PROGRESS lines the
 * helper prints; the final stdout line is a JSON result.
 */
async function fetchTtsModel(
  component: OptionalComponent,
  emit: (p: InstallProgress) => void
): Promise<InstallResult> {
  const id = component.id;
  if (!component.hf) {
    return { id, ok: false, error: `${component.name} has no HuggingFace coordinates.` };
  }

  emit({ id, phase: 'resolve', pct: 0, message: 'Preparing download…' });

  const controller = new AbortController();
  inFlight.set(id, { controller, tempDir: null });

  // Drive the helper from the component's HF coordinates (repo/sub/files) rather
  // than a preset name, so it works uniformly for fine-tuned voices AND the base
  // model (whose preset 'sub' doesn't match its actual repo layout).
  const { command, args: pyArgs } = getPythonInvocation(getDefaultE2aPath(), 'xtts');
  const helperArgs = [
    ...pyArgs,
    '-m', 'bookforge_ext.download_model',
    '--engine', 'xtts',
    '--repo', component.hf.repo,
    '--sub', component.hf.sub,
    '--files', ...component.hf.files,
    // Catalog voices carry a reference clip fetched alongside the checkpoint so
    // the downloaded voice is self-contained (the base model has none).
    ...(component.hf.ref ? ['--ref', component.hf.ref] : []),
    '--bf-progress',
  ];

  return await new Promise<InstallResult>((resolve) => {
    let finalJson = '';
    let stderrTail = '';
    let stdoutBuf = '';
    let settled = false;
    // Track each HF progress bar by description; the largest-total bar is the
    // checkpoint, which we surface as the headline percentage.
    const totalByDesc = new Map<string, number>();
    const recvByDesc = new Map<string, number>();

    const child = spawn(command, helperArgs, {
      cwd: getDefaultE2aPath(),
      env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    });

    controller.signal.addEventListener('abort', () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    });

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith('BF_PROGRESS ')) {
          const m = line.match(/^BF_PROGRESS\s+(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          const recv = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          const desc = m[3] || 'model';
          if (total > 0) {
            totalByDesc.set(desc, total);
            recvByDesc.set(desc, recv);
          }
          let bigDesc = '';
          let bigTotal = 0;
          for (const [k, v] of totalByDesc) if (v > bigTotal) { bigTotal = v; bigDesc = k; }
          const r = recvByDesc.get(bigDesc) || 0;
          const pct = bigTotal > 0 ? Math.min(100, Math.round((r / bigTotal) * 100)) : 0;
          emit({ id, phase: 'download', pct, receivedBytes: r, totalBytes: bigTotal,
                 message: `Downloading ${component.name}…` });
        } else if (line.startsWith('{')) {
          finalJson = line;
        }
      }
    });

    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    const finish = (result: InstallResult) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      resolve(result);
    };

    child.on('error', (err) => {
      emit({ id, phase: 'error', pct: 0, message: err.message });
      finish({ id, ok: false, error: err.message });
    });

    child.on('close', (code) => {
      if (controller.signal.aborted) {
        const msg = 'Download cancelled';
        emit({ id, phase: 'error', pct: 0, message: msg });
        return finish({ id, ok: false, error: msg });
      }
      let parsed: { ok?: boolean; error?: string; files?: Record<string, string>;
                    subDir?: string; snapshotDir?: string; ref?: string } | null = null;
      try { parsed = finalJson ? JSON.parse(finalJson) : null; } catch { /* keep null */ }

      if (code === 0 && parsed?.ok && parsed.files) {
        const entryPath = parsed.files[modelFileOf(component.hf!.files)]
          || Object.values(parsed.files).find((p) => p.endsWith('.pth'))
          || Object.values(parsed.files)[0];
        const subDir = parsed.subDir || parsed.snapshotDir || path.dirname(entryPath);
        const record: InstalledRecord = {
          id,
          version: component.version,
          source: 'managed',
          path: subDir,
          entryPath,
          bytes: component.sizeBytes || undefined,
          installedAt: new Date().toISOString(),
        };
        putRecord(record);
        // A downloaded catalog voice (checkpoint + ref clip now on disk) is
        // registered so the player and full-audiobook generation use it via the
        // same rails as a user voice — no bundled clip or e2a preset needed.
        if (component.hf!.ref && parsed.ref) {
          try {
            registerDownloadedVoice({
              id, name: component.name, checkpointDir: subDir, refPath: parsed.ref,
            });
          } catch (err) {
            cwarn(`[COMPONENTS] ${id}: voice registration failed:`, err);
          }
        }
        emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
        return finish({ id, ok: true, record });
      }

      const error = parsed?.error || stderrTail.trim() || `Download failed (exit ${code}).`;
      emit({ id, phase: 'error', pct: 0, message: error });
      finish({ id, ok: false, error });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Language-pack fetch (kind 'language-pack') — download a Stanza segmentation
// model into e2a's models/stanza/<code> via the python helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download a Stanza language pack by spawning the bundled-python helper, which
 * runs stanza.download() into e2a's models/stanza dir — where the segmentation
 * pipeline reads it via STANZA_RESOURCES_DIR. Progress comes from BF_PROGRESS
 * lines the helper prints; the final stdout line is a JSON result.
 */
async function fetchLanguagePack(
  component: OptionalComponent,
  emit: (p: InstallProgress) => void
): Promise<InstallResult> {
  const id = component.id;
  if (!component.stanza) {
    return { id, ok: false, error: `${component.name} has no Stanza language code.` };
  }

  emit({ id, phase: 'resolve', pct: 0, message: 'Preparing download…' });

  const controller = new AbortController();
  inFlight.set(id, { controller, tempDir: null });

  const { command, args: pyArgs } = getPythonInvocation(getDefaultE2aPath(), 'xtts');
  const helperArgs = [
    ...pyArgs,
    '-m', 'bookforge_ext.download_model',
    '--engine', 'stanza',
    '--lang', component.stanza.code,
    '--total', String(component.sizeBytes || 0),
    '--bf-progress',
  ];

  return await new Promise<InstallResult>((resolve) => {
    let finalJson = '';
    let stderrTail = '';
    let stdoutBuf = '';
    let settled = false;
    // The helper emits a single progress stream keyed by language; reuse the
    // same per-desc tracking so the largest-total bar drives the headline pct.
    const totalByDesc = new Map<string, number>();
    const recvByDesc = new Map<string, number>();

    const child = spawn(command, helperArgs, {
      cwd: getDefaultE2aPath(),
      env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    });

    controller.signal.addEventListener('abort', () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    });

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith('BF_PROGRESS ')) {
          const m = line.match(/^BF_PROGRESS\s+(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          const recv = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          const desc = m[3] || 'model';
          if (total > 0) {
            totalByDesc.set(desc, total);
            recvByDesc.set(desc, recv);
          }
          let bigDesc = '';
          let bigTotal = 0;
          for (const [k, v] of totalByDesc) if (v > bigTotal) { bigTotal = v; bigDesc = k; }
          const r = recvByDesc.get(bigDesc) || 0;
          const pct = bigTotal > 0 ? Math.min(100, Math.round((r / bigTotal) * 100)) : 0;
          emit({ id, phase: 'download', pct, receivedBytes: r, totalBytes: bigTotal,
                 message: `Downloading ${component.name}…` });
        } else if (line.startsWith('{')) {
          finalJson = line;
        }
      }
    });

    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    const finish = (result: InstallResult) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      resolve(result);
    };

    child.on('error', (err) => {
      emit({ id, phase: 'error', pct: 0, message: err.message });
      finish({ id, ok: false, error: err.message });
    });

    child.on('close', (code) => {
      if (controller.signal.aborted) {
        const msg = 'Download cancelled';
        emit({ id, phase: 'error', pct: 0, message: msg });
        return finish({ id, ok: false, error: msg });
      }
      let parsed: { ok?: boolean; error?: string; dir?: string; lang?: string } | null = null;
      try { parsed = finalJson ? JSON.parse(finalJson) : null; } catch { /* keep null */ }

      if (code === 0 && parsed?.ok && parsed.dir) {
        const entryPath = parsed.dir;
        const record: InstalledRecord = {
          id,
          version: component.version,
          source: 'managed',
          path: entryPath,
          entryPath,
          bytes: component.sizeBytes || undefined,
          installedAt: new Date().toISOString(),
        };
        putRecord(record);
        emit({ id, phase: 'done', pct: 100, message: `${component.name} installed.` });
        return finish({ id, ok: true, record });
      }

      const error = parsed?.error || stderrTail.trim() || `Download failed (exit ${code}).`;
      emit({ id, phase: 'error', pct: 0, message: error });
      finish({ id, ok: false, error });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CUDA TTS (kind 'binary', id 'cuda-tts') — overlay GPU PyTorch into the env
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCudaTts(
  component: OptionalComponent,
  emit: (p: InstallProgress) => void
): Promise<InstallResult> {
  const id = component.id;
  const controller = new AbortController();
  inFlight.set(id, { controller, tempDir: null });
  try {
    await installCudaTts(emit, controller.signal);
    const marker = cudaTtsMarkerPath() || '';
    const record: InstalledRecord = {
      id,
      version: component.version,
      source: 'managed',
      path: marker,
      entryPath: marker, // the env marker; resolveEntry checks it exists
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

  // TTS voices fetch into e2a's HF cache via the python helper, not a single
  // archive download — different mechanism, same install()/progress contract.
  if (component.kind === 'tts-model') {
    return fetchTtsModel(component, emit);
  }

  // Language packs fetch into e2a's models/stanza dir via the python helper,
  // same mechanism as tts-model — different helper branch, same contract.
  if (component.kind === 'language-pack') {
    return fetchLanguagePack(component, emit);
  }

  // CUDA TTS overlays a GPU PyTorch build into the runtime env (pip), not a
  // download-into-dir — its own branch, same install()/progress contract.
  if (component.id === CUDA_TTS_ID) {
    return fetchCudaTts(component, emit);
  }

  // CUDA RVC overlays a GPU PyTorch build into the rvc-env (pip), same mechanism
  // as cuda-tts but targeting the enhancement engine's env.
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
    // The CUDA pack fetches two release zips (build + cudart) with an upstream→
    // mirror fallback and flattens them, rather than the single-archive path.
    if (component.id === LLAMA_CUDA_ID) {
      await downloadLlamaCudaInto(tempDir, emit, controller.signal);
    } else {
      await downloadAndExtract(artifact, tempDir, emit, controller.signal);
    }

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
  clog(`[COMPONENTS] ${id}: cancelling managed install`);
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
    clog(`[COMPONENTS] ${id}: nothing to uninstall`);
    return;
  }

  // CUDA TTS isn't a dir under components/ — it's an overlay in the runtime env.
  // Revert to CPU torch + clear the marker, then drop the record.
  if (id === CUDA_TTS_ID) {
    try {
      uninstallCudaTts();
    } catch (err) {
      cerror(`[COMPONENTS] ${id}: revert to CPU torch failed:`, err);
    }
    dropRecord(id);
    clog(`[COMPONENTS] ${id}: reverted GPU TTS overlay`);
    return;
  }

  // CUDA RVC is the same kind of overlay, in the rvc-env.
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

  // A downloaded catalog voice is also registered as a voice — forget that
  // registration (and its staged e2a layout) so it stops appearing in pickers.
  if (isDownloadedVoiceId(id)) {
    try { removeCustomVoice(id); } catch { /* best-effort */ }
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

  // For tts-model voices without a (valid) record, glob the HF cache: bundled and
  // already-downloaded voices surface as Installed for free, and a snapshot path
  // that changed across an app update is re-detected here.
  if (!record && component.kind === 'tts-model') {
    const found = findTtsModelEntry(component);
    if (found) {
      record = {
        id: component.id,
        version: component.version,
        source: 'managed',
        path: path.dirname(found),
        entryPath: found,
        bytes: component.sizeBytes || undefined,
        installedAt: new Date().toISOString(),
      };
      putRecord(record);
      clog(`[COMPONENTS] ${component.id}: detected TTS model in HF cache at ${found}`);
    }
  }

  // Same for language packs: bundled and already-downloaded Stanza models in
  // e2a's models/stanza dir surface as Installed for free.
  if (!record && component.kind === 'language-pack') {
    const found = findLanguagePackEntry(component);
    if (found) {
      record = {
        id: component.id,
        version: component.version,
        source: 'managed',
        path: found,
        entryPath: found,
        installedAt: new Date().toISOString(),
      };
      putRecord(record);
      clog(`[COMPONENTS] ${component.id}: detected Stanza language pack at ${found}`);
    }
  }

  // CUDA TTS: the marker lives in the runtime env, so it auto-clears if the env
  // is re-unpacked (app update) — detection always reflects the real env state.
  if (!record && component.id === CUDA_TTS_ID && isCudaTtsInstalled()) {
    const marker = cudaTtsMarkerPath() || '';
    record = {
      id: component.id,
      version: component.version,
      source: 'managed',
      path: marker,
      entryPath: marker,
      installedAt: new Date().toISOString(),
    };
    putRecord(record);
    clog(`[COMPONENTS] ${component.id}: detected CUDA PyTorch overlay in env`);
  }

  // CUDA RVC: same marker-in-env detection, for the enhancement engine's env.
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
