/**
 * CUDA acceleration for RVC voice enhancement (PyTorch GPU build).
 *
 * The rvc-env component ships CPU-only PyTorch, so RVC enhancement runs on the
 * CPU. On a Windows machine with an NVIDIA GPU, this OPTIONAL overlay downloads
 * the CUDA build of PyTorch and pip-installs it INTO the installed rvc-env,
 * replacing the CPU torch. After that the env's torch.cuda.is_available() is
 * True and `urvc` auto-selects the GPU (no device flag needed) — RVC runs ~5×
 * faster.
 *
 * This is the RVC sibling of `cuda-tts` (which overlays the e2a env). It reuses
 * the EXACT same cp311 `torch 2.7.1+cu126` wheels cuda-tts hosts — the rvc-env's
 * torch is pinned to 2.7.1 specifically so the same wheel applies — so there's
 * no new download to host. Part of the unified "GPU acceleration" choice, which
 * installs cuda-tts + llama-cuda + cuda-rvc together.
 *
 * Mac: not applicable — the macOS rvc-env ships MPS-native torch, so RVC uses
 * the GPU there with no overlay (this component is win32-only, like cuda-tts).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { downloadFile } from './downloader';
import { RVC_ENV_ID } from './rvc-env';
import type { OptionalComponent, InstallProgress } from './component-types';

// ── Pins (must match the rvc-env's torch 2.7.1 + the cuda-tts wheel) ──────────
const TORCH_VERSION = '2.7.1';
const CU_TAG = 'cu126';
const PY_TAG = 'cp311-cp311';          // rvc-env is Python 3.11 (BookForge fork relaxation)
const PLAT_TAG = 'win_amd64';

const PYTORCH_CDN = `https://download.pytorch.org/whl/${CU_TAG}`;
const TORCH_WHL = `torch-${TORCH_VERSION}%2B${CU_TAG}-${PY_TAG}-${PLAT_TAG}.whl`;
const TORCHAUDIO_WHL = `torchaudio-${TORCH_VERSION}%2B${CU_TAG}-${PY_TAG}-${PLAT_TAG}.whl`;

const TORCH_BYTES = 2_716_982_502;
const TORCHAUDIO_BYTES = 5_000_000;
const TOTAL_BYTES = TORCH_BYTES + TORCHAUDIO_BYTES;

export const CUDA_RVC_ID = 'cuda-rvc';
const MARKER = '.bookforge-cuda-rvc.json';

// ── Catalog entry ───────────────────────────────────────────────────────────

export function cudaRvcComponent(): OptionalComponent {
  return {
    id: CUDA_RVC_ID,
    name: 'Faster Voice Enhancement',
    description:
      'Uses your NVIDIA graphics card to run RVC voice enhancement much faster than the processor. '
      + 'Requires the Voice Enhancement (RVC) engine. ~2.7 GB download.',
    kind: 'binary',
    acquisition: ['managed'],
    sizeBytes: TOTAL_BYTES,
    requirements: {
      platforms: ['win32'],
      gpu: 'cuda',
    },
    artifacts: [
      { platform: 'win32', arch: 'x64', gpu: 'cuda', url: `${PYTORCH_CDN}/${TORCH_WHL}`, sha256: '', bytes: TOTAL_BYTES },
    ],
    // Verified by reimporting torch in the env (see installCudaRvc); the cheap
    // catalog-side check is path-exists on the marker.
    verify: { kind: 'path-exists' },
    version: `${TORCH_VERSION}+${CU_TAG}`,
    entryPath: '',
  };
}

// ── Env helpers ─────────────────────────────────────────────────────────────

/**
 * The rvc-env root: the BOOKFORGE_RVC_ENV dev override, else the managed
 * component install dir. Resolved locally (not via componentManager) to avoid an
 * import cycle (component-manager imports this module).
 */
function rvcEnvRoot(): string {
  const override = process.env.BOOKFORGE_RVC_ENV?.trim();
  return override || path.join(app.getPath('userData'), 'components', RVC_ENV_ID);
}

function envPython(): string | null {
  const root = rvcEnvRoot();
  const py = process.platform === 'win32'
    ? path.join(root, 'python.exe')
    : path.join(root, 'bin', 'python');
  return fs.existsSync(py) ? py : null;
}

export function cudaRvcMarkerPath(): string {
  return path.join(rvcEnvRoot(), MARKER);
}

/** True when the CUDA torch overlay is installed in the rvc-env. */
export function isCudaRvcInstalled(): boolean {
  return fs.existsSync(cudaRvcMarkerPath());
}

// ── Download + install ──────────────────────────────────────────────────────

async function downloadWheel(
  fileName: string,
  destPath: string,
  priorBytes: number,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const onProgress = (p: InstallProgress) => {
    const global = priorBytes + (p.receivedBytes ?? 0);
    emit({
      id: CUDA_RVC_ID,
      phase: 'download',
      pct: Math.min(100, Math.round((global / TOTAL_BYTES) * 100)),
      receivedBytes: global,
      totalBytes: TOTAL_BYTES,
      message: 'Downloading GPU enhancement engine (PyTorch CUDA)…',
    });
  };
  await downloadFile(`${PYTORCH_CDN}/${fileName}`, destPath, CUDA_RVC_ID, onProgress, signal);
}

/**
 * Download the CUDA torch wheels and pip-install them into the rvc-env, replacing
 * its CPU torch. Throws on any failure. Requires the rvc-env to be installed.
 */
export async function installCudaRvc(
  emit: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const py = envPython();
  if (!py) {
    throw new Error('Install the Voice Enhancement (RVC) engine first, then add GPU acceleration for it.');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-cuda-rvc-'));
  try {
    const torchWhl = path.join(tmp, TORCH_WHL.replace('%2B', '+'));
    const audioWhl = path.join(tmp, TORCHAUDIO_WHL.replace('%2B', '+'));

    await downloadWheel(TORCH_WHL, torchWhl, 0, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');
    await downloadWheel(TORCHAUDIO_WHL, audioWhl, TORCH_BYTES, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: CUDA_RVC_ID, phase: 'postinstall', pct: 0, message: 'Installing PyTorch CUDA into the RVC engine…' });
    const res = spawnSync(
      py,
      ['-m', 'pip', 'install', '--no-deps', '--force-reinstall', '--no-warn-script-location', torchWhl, audioWhl],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
    );
    if (res.status !== 0) {
      const out = `${res.stdout || ''}${res.stderr || ''}`.trim().slice(-1500);
      throw new Error(`pip install of CUDA PyTorch into the RVC env failed (exit ${res.status}): ${out}`);
    }
    emit({ id: CUDA_RVC_ID, phase: 'postinstall', pct: 100 });

    emit({ id: CUDA_RVC_ID, phase: 'verify-run', pct: 0, message: 'Verifying GPU engine…' });
    const check = spawnSync(
      py,
      ['-c', 'import torch,sys; sys.stdout.write(str(torch.version.cuda or ""))'],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    if (check.status !== 0 || !check.stdout || !check.stdout.trim()) {
      throw new Error(`CUDA PyTorch did not load in the RVC env after install: ${(check.stderr || check.stdout || '').trim().slice(-800)}`);
    }
    emit({ id: CUDA_RVC_ID, phase: 'verify-run', pct: 100 });

    fs.writeFileSync(cudaRvcMarkerPath(), JSON.stringify({
      version: `${TORCH_VERSION}+${CU_TAG}`,
      cuda: check.stdout.trim(),
      installedAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Revert the RVC env to CPU torch: clear the marker and reinstall the CPU build.
 * Best-effort — if PyPI is unreachable, the marker is still cleared (the CUDA
 * torch staying is harmless on a GPU machine).
 */
export function uninstallCudaRvc(): void {
  const m = cudaRvcMarkerPath();
  if (fs.existsSync(m)) {
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
