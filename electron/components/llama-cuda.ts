/**
 * CUDA acceleration pack for the bundled local-LLM engine (llama-server).
 *
 * BookForge ships the CPU-only llama.cpp build in the installer (small, runs
 * everywhere). On a Windows machine with an NVIDIA GPU, this OPTIONAL component
 * downloads the CUDA build of llama-server.exe + its CUDA DLLs (cublas, the
 * ggml-cuda backend) + the CUDA runtime redistributable (cudart), landing them
 * in userData/components/llama-cuda/. llama-bridge's resolveBinary() then prefers
 * that GPU binary over the bundled CPU one — local AI cleanup runs on the GPU.
 *
 * Download sources, tried in order:
 *   1. llama.cpp GitHub release (the upstream home of these prebuilt zips)
 *   2. owenmorgan.com/bookforge/llama/ mirror (byte-identical fallback)
 *
 * Two archives are fetched (the llama.cpp release splits them this way):
 *   - llama-<ver>-bin-win-cuda-<tag>-x64.zip   → llama-server.exe + ggml/cublas
 *   - cudart-llama-bin-win-cuda-<tag>-x64.zip  → cudart64_*.dll, cublas runtime
 * Their contents are flattened side-by-side into the install dir (like
 * resources/bin in the bundled case), plus the VC++ runtime DLLs copied from the
 * bundled resources/bin so the GPU exe has everything it needs to load.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadFile, extractArchive } from './downloader';
import type { OptionalComponent, InstallProgress } from './component-types';

// ─────────────────────────────────────────────────────────────────────────────
// Pins — KEEP IN SYNC with scripts/download-llama-cpp.js (LLAMA_CPP_VERSION /
// WIN_CUDA_TAG). The bundled CPU build and this CUDA pack must come from the same
// llama.cpp release so the server protocol + ggml format match.
// ─────────────────────────────────────────────────────────────────────────────

const LLAMA_CPP_VERSION = 'b7482';
const WIN_CUDA_TAG = '12.4';

const GH_REL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;
const MIRROR = 'https://owenmorgan.com/bookforge/llama';

const BUILD_ZIP = `llama-${LLAMA_CPP_VERSION}-bin-win-cuda-${WIN_CUDA_TAG}-x64.zip`;
const CUDART_ZIP = `cudart-llama-bin-win-cuda-${WIN_CUDA_TAG}-x64.zip`;

// Exact content-lengths of the two zips (verified against the b7482 release and
// the mirror). Used for combined download progress + the disk pre-check.
const BUILD_BYTES = 204_029_366;
const CUDART_BYTES = 391_443_627;
const TOTAL_BYTES = BUILD_BYTES + CUDART_BYTES;

export const LLAMA_CUDA_ID = 'llama-cuda';

// VC++ runtime DLLs the binary needs on a clean system. The bundled CPU build
// already ships these in resources/bin (copied from System32 at package time);
// we reuse them rather than re-acquiring.
const VCRUNTIME_DLLS = [
  'MSVCP140.dll',
  'MSVCP140_CODECVT_IDS.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
];

// ─────────────────────────────────────────────────────────────────────────────
// Catalog entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CUDA acceleration pack as a managed `binary` component. Windows + NVIDIA
 * only — on any other machine system-probe.evaluate() marks it incompatible
 * (honest state) rather than hiding it.
 *
 * The single artifact below is what the manager's compat/disk/url gates inspect;
 * the actual fetch (two zips + mirror fallback) runs through
 * downloadLlamaCudaInto(). `url` points at the real upstream build zip and
 * `bytes` is the combined download so the disk pre-check is honest.
 */
export function llamaCudaComponent(): OptionalComponent {
  return {
    id: LLAMA_CUDA_ID,
    name: 'GPU Acceleration (CUDA)',
    description:
      'NVIDIA CUDA build of the local AI engine. Runs on-device AI text cleanup on your GPU instead of the CPU — dramatically faster. ~570 MB download (~1 GB on disk).',
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
        url: `${GH_REL}/${BUILD_ZIP}`,
        sha256: '',
        bytes: TOTAL_BYTES,
      },
    ],
    verify: { kind: 'exec', args: ['--version'], expect: 'version' },
    version: LLAMA_CPP_VERSION,
    entryPath: 'llama-server.exe',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Download + extract
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively find the first file matching `predicate`, or null. */
function findFile(dir: string, predicate: (name: string) => boolean): string | null {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      const found = findFile(full, predicate);
      if (found) return found;
    } else if (predicate(entry)) {
      return full;
    }
  }
  return null;
}

/** Copy every *.dll in `srcDir` (non-recursive) into `destDir`. */
function copyDlls(srcDir: string, destDir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (f.toLowerCase().endsWith('.dll')) {
      fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
      n++;
    }
  }
  return n;
}

/** The bundled resources/bin dir (packaged or dev), or null if not found. */
function bundledBinDir(): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath || '';
  const roots = [
    path.join(resourcesPath, 'bin'),
    // dist/electron/components → repo root
    path.join(__dirname, '..', '..', '..', 'resources', 'bin'),
  ];
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) return root;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Copy the VC++ runtime DLLs from the bundled resources/bin into destDir. */
function copyBundledVcRuntime(destDir: string): void {
  const binDir = bundledBinDir();
  if (!binDir) {
    console.warn('[COMPONENTS] llama-cuda: bundled resources/bin not found; VC++ runtime not copied');
    return;
  }
  for (const dll of VCRUNTIME_DLLS) {
    const src = path.join(binDir, dll);
    const dest = path.join(destDir, dll);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    } catch (err) {
      console.warn(`[COMPONENTS] llama-cuda: could not copy ${dll}:`, err);
    }
  }
}

/**
 * Download one release zip, upstream first then the mirror, into `archivePath`.
 * `priorBytes` is the bytes already accounted for by earlier files so the
 * emitted percentage spans the whole multi-archive download.
 */
async function downloadZipWithFallback(
  fileName: string,
  archivePath: string,
  priorBytes: number,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const onProgress = (p: InstallProgress) => {
    const global = priorBytes + (p.receivedBytes ?? 0);
    emit({
      id: LLAMA_CUDA_ID,
      phase: 'download',
      pct: Math.min(100, Math.round((global / TOTAL_BYTES) * 100)),
      receivedBytes: global,
      totalBytes: TOTAL_BYTES,
      message: 'Downloading GPU acceleration…',
    });
  };

  try {
    await downloadFile(`${GH_REL}/${fileName}`, archivePath, LLAMA_CUDA_ID, onProgress, signal);
    return;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(
      `[COMPONENTS] llama-cuda: upstream ${fileName} failed (${err instanceof Error ? err.message : err}); trying mirror`
    );
  }
  await downloadFile(`${MIRROR}/${fileName}`, archivePath, LLAMA_CUDA_ID, onProgress, signal);
}

/**
 * Fetch the CUDA build + cudart zips (upstream → mirror), extract, and flatten
 * llama-server.exe + every CUDA/ggml DLL + the cudart runtime + the bundled VC++
 * runtime side-by-side into `destDir`. Throws on download/extract failure or if
 * the server exe is missing afterwards. Honors `signal` for cancellation.
 */
export async function downloadLlamaCudaInto(
  destDir: string,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-llama-cuda-'));

  try {
    // ── 1. CUDA build zip → llama-server.exe + ggml/cublas DLLs ──
    const buildZip = path.join(tmp, BUILD_ZIP);
    await downloadZipWithFallback(BUILD_ZIP, buildZip, 0, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 0, message: 'Extracting GPU engine…' });
    const buildDir = path.join(tmp, 'build');
    await extractArchive(buildZip, buildDir, BUILD_ZIP);
    const serverSrc = findFile(buildDir, (f) => f.toLowerCase() === 'llama-server.exe');
    if (!serverSrc) throw new Error('llama-server.exe not found in the CUDA build archive');
    const buildBinDir = path.dirname(serverSrc);
    fs.copyFileSync(serverSrc, path.join(destDir, 'llama-server.exe'));
    copyDlls(buildBinDir, destDir);

    // ── 2. cudart redistributable → cudart64_*.dll + cublas runtime ──
    const cudartZip = path.join(tmp, CUDART_ZIP);
    await downloadZipWithFallback(CUDART_ZIP, cudartZip, BUILD_BYTES, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 50, message: 'Extracting CUDA runtime…' });
    const cudartDir = path.join(tmp, 'cudart');
    await extractArchive(cudartZip, cudartDir, CUDART_ZIP);
    const cudartDll = findFile(cudartDir, (f) => f.toLowerCase().endsWith('.dll'));
    copyDlls(cudartDll ? path.dirname(cudartDll) : cudartDir, destDir);

    // ── 3. VC++ runtime from the bundled CPU build ──
    copyBundledVcRuntime(destDir);
    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 100, message: 'Extracted' });

    if (!fs.existsSync(path.join(destDir, 'llama-server.exe'))) {
      throw new Error('llama-server.exe missing after extraction');
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
