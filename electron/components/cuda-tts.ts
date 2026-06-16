/**
 * CUDA acceleration for XTTS text-to-speech (PyTorch GPU build).
 *
 * The bundled conda env ships CPU-only PyTorch (small, portable), so XTTS runs
 * on the CPU. On a Windows machine with an NVIDIA GPU, this OPTIONAL component
 * downloads the CUDA build of PyTorch (`torch+cu126`, matching the bundled
 * torch 2.7.1 so coqui-tts stays compatible) and overlays it into the runtime
 * env, replacing the CPU torch. After that, `torch.cuda.is_available()` is True,
 * so the streaming worker (xtts_stream.py) and the job workers auto-select the
 * GPU — generation runs ~5-10x faster.
 *
 * This is NOT the same as `llama-cuda` (that's the CUDA build of llama.cpp for
 * the local LLM). This one is PyTorch for the TTS engine.
 *
 * Install mechanism: download the wheels (upstream PyTorch CDN → owenmorgan.com
 * mirror) and `pip install --no-deps --force-reinstall` them into the runtime
 * env. A marker file inside the env records the install; because the marker
 * lives in the env dir, it's automatically gone if the env is ever re-unpacked
 * (app update), so the component correctly reverts to "available" then.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { downloadFile } from './downloader';
import { getActiveBundledEnvPath } from '../e2a-env-bootstrap';
import type { OptionalComponent, InstallProgress } from './component-types';

// ── Pins ──────────────────────────────────────────────────────────────────────
// Match the bundled env's torch version (2.7.1) so coqui-tts 0.27.x stays happy;
// only the CUDA variant differs. torch 2.7.1 ships cu118/cu126/cu128 — cu126
// (CUDA 12.6, driver ≥ ~560) balances performance and driver compatibility.
const TORCH_VERSION = '2.7.1';
const CU_TAG = 'cu126';
const PY_TAG = 'cp311-cp311';          // bundled env is Python 3.11
const PLAT_TAG = 'win_amd64';          // Windows x64 (the only CUDA-TTS target for now)

const PYTORCH_CDN = `https://download.pytorch.org/whl/${CU_TAG}`;
const MIRROR = 'https://owenmorgan.com/bookforge/torch';

// %2B is the URL-encoding of '+' that the PyTorch index uses in wheel names.
const TORCH_WHL = `torch-${TORCH_VERSION}%2B${CU_TAG}-${PY_TAG}-${PLAT_TAG}.whl`;
const TORCHAUDIO_WHL = `torchaudio-${TORCH_VERSION}%2B${CU_TAG}-${PY_TAG}-${PLAT_TAG}.whl`;

// Exact download size of the torch wheel (torchaudio is a few MB). Drives the
// disk pre-check + combined progress.
const TORCH_BYTES = 2_716_982_502;
const TORCHAUDIO_BYTES = 5_000_000;     // ~4-5 MB
const TOTAL_BYTES = TORCH_BYTES + TORCHAUDIO_BYTES;

export const CUDA_TTS_ID = 'cuda-tts';

// Marker written inside the env on success (auto-removed if the env re-unpacks).
const MARKER = '.bookforge-cuda-tts.json';

// ── Catalog entry ───────────────────────────────────────────────────────────

export function cudaTtsComponent(): OptionalComponent {
  return {
    id: CUDA_TTS_ID,
    name: 'Faster Voice Narration',
    description:
      'Uses your NVIDIA graphics card to generate the audiobook narration much faster than the processor. ~2.7 GB download (~7 GB on disk).',
    kind: 'binary',
    acquisition: ['managed'],
    sizeBytes: TOTAL_BYTES,
    requirements: {
      platforms: ['win32'],
      gpu: 'cuda',
    },
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        gpu: 'cuda',
        url: `${PYTORCH_CDN}/${TORCH_WHL}`,
        sha256: '',
        bytes: TOTAL_BYTES,
      },
    ],
    // Verified by re-importing torch in the env (see manager); path-exists on the
    // marker is the cheap catalog-side check.
    verify: { kind: 'path-exists' },
    version: `${TORCH_VERSION}+${CU_TAG}`,
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

export function cudaTtsMarkerPath(): string | null {
  const envDir = getActiveBundledEnvPath();
  return envDir ? path.join(envDir, MARKER) : null;
}
const markerPath = cudaTtsMarkerPath;

/** True when the CUDA torch overlay is installed in the current runtime env. */
export function isCudaTtsInstalled(): boolean {
  const m = markerPath();
  return !!m && fs.existsSync(m);
}

// ── Download + install ──────────────────────────────────────────────────────

async function downloadWheel(
  fileName: string,
  destPath: string,
  priorBytes: number,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const onProgress = (p: InstallProgress) => {
    const global = priorBytes + (p.receivedBytes ?? 0);
    emit({
      id: CUDA_TTS_ID,
      phase: 'download',
      pct: Math.min(100, Math.round((global / TOTAL_BYTES) * 100)),
      receivedBytes: global,
      totalBytes: TOTAL_BYTES,
      message: 'Downloading GPU voice engine (PyTorch CUDA)…',
    });
  };
  try {
    await downloadFile(`${PYTORCH_CDN}/${fileName}`, destPath, CUDA_TTS_ID, onProgress, signal);
    return;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`[COMPONENTS] cuda-tts: PyTorch CDN ${fileName} failed (${err instanceof Error ? err.message : err}); trying mirror`);
  }
  await downloadFile(`${MIRROR}/${fileName}`, destPath, CUDA_TTS_ID, onProgress, signal);
}

/**
 * Download the CUDA torch wheels and pip-install them into the runtime env,
 * replacing the CPU torch. Throws on any failure. After this, the env's
 * torch.cuda.is_available() is True and the TTS workers auto-select the GPU.
 */
export async function installCudaTts(
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const py = envPython();
  if (!py) {
    throw new Error('The audiobook engine isn’t ready yet — finish first-run setup, then install GPU acceleration.');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-cuda-tts-'));
  try {
    const torchWhl = path.join(tmp, TORCH_WHL.replace('%2B', '+'));
    const audioWhl = path.join(tmp, TORCHAUDIO_WHL.replace('%2B', '+'));

    await downloadWheel(TORCH_WHL, torchWhl, 0, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');
    await downloadWheel(TORCHAUDIO_WHL, audioWhl, TORCH_BYTES, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    // pip install into the env. --no-deps: the CPU torch already pulled the same
    // deps (filelock/sympy/networkx/jinja2/fsspec/typing-extensions); the cu126
    // wheel bundles its own CUDA libs. --force-reinstall swaps CPU → CUDA.
    emit({ id: CUDA_TTS_ID, phase: 'postinstall', pct: 0, message: 'Installing PyTorch CUDA into the engine…' });
    const res = spawnSync(
      py,
      ['-m', 'pip', 'install', '--no-deps', '--force-reinstall', '--no-warn-script-location', torchWhl, audioWhl],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
    );
    if (res.status !== 0) {
      const out = `${res.stdout || ''}${res.stderr || ''}`.trim().slice(-1500);
      throw new Error(`pip install of CUDA PyTorch failed (exit ${res.status}): ${out}`);
    }
    emit({ id: CUDA_TTS_ID, phase: 'postinstall', pct: 100 });

    // Verify the overlay took: CUDA build present (is_available also needs the
    // GPU/driver, but the build being CUDA is the install's success criterion).
    emit({ id: CUDA_TTS_ID, phase: 'verify-run', pct: 0, message: 'Verifying GPU engine…' });
    const check = spawnSync(
      py,
      ['-c', 'import torch,sys; sys.stdout.write(str(torch.version.cuda or "")); '],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    if (check.status !== 0 || !check.stdout || !check.stdout.trim()) {
      throw new Error(`CUDA PyTorch did not load after install: ${(check.stderr || check.stdout || '').trim().slice(-800)}`);
    }
    emit({ id: CUDA_TTS_ID, phase: 'verify-run', pct: 100 });

    const m = markerPath();
    if (m) {
      fs.writeFileSync(m, JSON.stringify({
        version: `${TORCH_VERSION}+${CU_TAG}`,
        cuda: check.stdout.trim(),
        installedAt: new Date().toISOString(),
      }, null, 2));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Revert to CPU torch: remove the marker and reinstall the CPU build so the
 * engine stops using (and requiring) the GPU. Best-effort — if the CPU
 * reinstall can't reach PyPI, the marker is still cleared and the CUDA torch
 * stays (harmless on a GPU machine).
 */
export function uninstallCudaTts(): void {
  const m = markerPath();
  if (m && fs.existsSync(m)) {
    try { fs.unlinkSync(m); } catch { /* ignore */ }
  }
  const py = envPython();
  if (!py) return;
  spawnSync(
    py,
    ['-m', 'pip', 'install', '--no-deps', '--force-reinstall',
     `torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`,
     '--index-url', 'https://download.pytorch.org/whl/cpu'],
    { encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000 },
  );
}
