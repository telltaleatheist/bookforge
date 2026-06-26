/**
 * DeepSpeed acceleration for XTTS text-to-speech.
 *
 * XTTS's autoregressive GPT decoder is the slow part of narration. DeepSpeed-
 * Inference fuses that decoder with custom CUDA kernels (fp16, same math — NOT
 * quantization), giving ~1.5x faster generation on an NVIDIA GPU. This OPTIONAL
 * overlay drops DeepSpeed (with a prebuilt, multi-arch `transformer_inference`
 * kernel) into the runtime env's site-packages. e2a then enables it automatically
 * when present — see parallel-tts-bridge.ts `xttsDeepspeedAvailable()` (which also
 * GPU-compat-probes) and e2a's _load_checkpoint (which falls back to standard XTTS
 * if the kernel can't load). So an incompatible GPU silently keeps standard XTTS.
 *
 * Why an overlay (not baked into the e2a-env tarball): the env is large and
 * re-downloaded on update; shipping DeepSpeed separately keeps that download small
 * and lets only CUDA users fetch it. Same model as cuda-tts / cuda-rvc — and like
 * them the success marker lives INSIDE the env, so it's automatically gone (and
 * the overlay re-applies) if the env is ever re-unpacked.
 *
 * The prebuilt kernel is compiled for sm_75;8.0;8.6;8.9;9.0 + PTX (Turing →
 * Hopper, forward-compatible). Built against the env's torch 2.7.1+cu126 / py3.11,
 * so this overlay is pinned to that env. win32-only (DeepSpeed inference is CUDA).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { downloadFile, osTarBin } from './downloader';
import { getActiveBundledEnvPath } from '../e2a-env-bootstrap';
import type { OptionalComponent, InstallProgress } from './component-types';

// ── Pins (must match the wheel built into the published overlay) ───────────────
const DEEPSPEED_VERSION = '0.19.2';
const ARTIFACT_URL =
  'https://github.com/telltaleatheist/bookforge/releases/download/assets/deepspeed-xtts-windows-x64.tar.gz';
const ARTIFACT_SHA256 = 'd054d72c4dee55338dd2ac42f09650e6b7edefe7ca41ac69d5ee5d07a9dd9ac0';
const ARTIFACT_BYTES = 4_021_269;

export const DEEPSPEED_XTTS_ID = 'deepspeed-xtts';

// Marker written inside the env on success (auto-removed if the env re-unpacks).
const MARKER = '.bookforge-deepspeed-xtts.json';

// ── Catalog entry ───────────────────────────────────────────────────────────

export function deepspeedXttsComponent(): OptionalComponent {
  return {
    id: DEEPSPEED_XTTS_ID,
    name: 'Faster XTTS Narration (DeepSpeed)',
    description:
      'Uses DeepSpeed to run XTTS narration ~1.5× faster on your NVIDIA graphics card. '
      + 'No effect on other engines; automatically skipped if your GPU is unsupported. ~4 MB download.',
    kind: 'binary',
    acquisition: ['managed'],
    sizeBytes: ARTIFACT_BYTES,
    requirements: {
      platforms: ['win32'],
      gpu: 'cuda',
    },
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        gpu: 'cuda',
        url: ARTIFACT_URL,
        sha256: ARTIFACT_SHA256,
        bytes: ARTIFACT_BYTES,
      },
    ],
    // Verified by importing deepspeed in the env (see manager); the cheap
    // catalog-side check is path-exists on the marker.
    verify: { kind: 'path-exists' },
    version: DEEPSPEED_VERSION,
    entryPath: '',
  };
}

// ── Env helpers ─────────────────────────────────────────────────────────────

/** The runtime env's python executable, or null if the env isn't unpacked. */
function envPython(): string | null {
  const envDir = getActiveBundledEnvPath();
  if (!envDir) return null;
  const py = process.platform === 'win32'
    ? path.join(envDir, 'python.exe')
    : path.join(envDir, 'bin', 'python');
  return fs.existsSync(py) ? py : null;
}

export function deepspeedXttsMarkerPath(): string | null {
  const envDir = getActiveBundledEnvPath();
  return envDir ? path.join(envDir, MARKER) : null;
}

/** True when the DeepSpeed overlay is installed in the current runtime env. */
export function isDeepspeedXttsInstalled(): boolean {
  const m = deepspeedXttsMarkerPath();
  return !!m && fs.existsSync(m);
}

// ── Download + install ──────────────────────────────────────────────────────

/**
 * Download the overlay wheels and pip-install DeepSpeed into the runtime env.
 * The artifact is a tarball of wheels: the prebuilt multi-arch DeepSpeed wheel
 * plus the few deps the bundled env lacks (hjson/ninja/nvidia-ml-py/py-cpuinfo).
 * Installed fully offline with --no-index so nothing else in the env is touched.
 * Throws on any failure. After this, e2a auto-enables DeepSpeed for XTTS.
 */
export async function installDeepspeedXtts(
  emit: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const py = envPython();
  if (!py) {
    throw new Error('The audiobook engine isn’t ready yet — finish first-run setup, then add DeepSpeed acceleration.');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-deepspeed-xtts-'));
  try {
    const tarball = path.join(tmp, 'deepspeed-xtts.tar.gz');
    const wheelsDir = path.join(tmp, 'wheels');
    fs.mkdirSync(wheelsDir, { recursive: true });

    emit({ id: DEEPSPEED_XTTS_ID, phase: 'download', pct: 0, message: 'Downloading DeepSpeed for XTTS…' });
    await downloadFile(ARTIFACT_URL, tarball, DEEPSPEED_XTTS_ID, (p) => {
      emit({
        id: DEEPSPEED_XTTS_ID, phase: 'download',
        pct: Math.min(100, Math.round(((p.receivedBytes ?? 0) / ARTIFACT_BYTES) * 100)),
        receivedBytes: p.receivedBytes, totalBytes: ARTIFACT_BYTES,
        message: 'Downloading DeepSpeed for XTTS…',
      });
    }, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    // Extract the wheels.
    const ex = spawnSync(osTarBin(), ['-xzf', tarball, '-C', wheelsDir], {
      encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000,
    });
    if (ex.status !== 0) {
      throw new Error(`Failed to extract DeepSpeed overlay: ${(ex.stderr || ex.stdout || '').trim().slice(-800)}`);
    }

    // Install DeepSpeed (+ the bundled missing deps) into the env, fully offline.
    // --no-index + --find-links: pip pulls deepspeed and the 4 bundled deps from
    // the wheels dir, and leaves every already-satisfied dep (torch/numpy/…)
    // untouched, so the env's existing packages can't be disturbed.
    emit({ id: DEEPSPEED_XTTS_ID, phase: 'postinstall', pct: 0, message: 'Installing DeepSpeed into the engine…' });
    const res = spawnSync(
      py,
      ['-m', 'pip', 'install', '--no-index', '--find-links', wheelsDir, '--no-warn-script-location', 'deepspeed'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 },
    );
    if (res.status !== 0) {
      const out = `${res.stdout || ''}${res.stderr || ''}`.trim().slice(-1500);
      throw new Error(`pip install of DeepSpeed failed (exit ${res.status}): ${out}`);
    }
    emit({ id: DEEPSPEED_XTTS_ID, phase: 'postinstall', pct: 100 });

    // Verify the package imports (the GPU-compat check + safe fallback happen at
    // render time — see xttsDeepspeedAvailable / e2a _load_checkpoint).
    emit({ id: DEEPSPEED_XTTS_ID, phase: 'verify-run', pct: 0, message: 'Verifying DeepSpeed…' });
    const check = spawnSync(
      py, ['-c', 'import deepspeed,sys; sys.stdout.write(deepspeed.__version__)'],
      { encoding: 'utf8', windowsHide: true, timeout: 180_000 },
    );
    if (check.status !== 0 || !check.stdout || !check.stdout.trim()) {
      throw new Error(`DeepSpeed did not import after install: ${(check.stderr || check.stdout || '').trim().slice(-800)}`);
    }
    emit({ id: DEEPSPEED_XTTS_ID, phase: 'verify-run', pct: 100 });

    const m = deepspeedXttsMarkerPath();
    if (m) {
      fs.writeFileSync(m, JSON.stringify({
        version: check.stdout.trim(),
        installedAt: new Date().toISOString(),
      }, null, 2));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Remove the overlay: clear the marker and pip-uninstall deepspeed so XTTS reverts
 * to standard inference. Best-effort — the marker is cleared even if the uninstall
 * can't complete (a stray deepspeed package is harmless; the compat probe + e2a
 * fallback still apply).
 */
export function uninstallDeepspeedXtts(): void {
  const m = deepspeedXttsMarkerPath();
  if (m && fs.existsSync(m)) {
    try { fs.unlinkSync(m); } catch { /* ignore */ }
  }
  const py = envPython();
  if (!py) return;
  spawnSync(
    py, ['-m', 'pip', 'uninstall', '-y', 'deepspeed'],
    { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 },
  );
}
