/**
 * System Probe — detect machine capabilities and evaluate component compatibility.
 *
 * Implements ISystemProbe from component-types.ts. Detects platform/arch, Apple
 * Silicon, CUDA (+ VRAM), RAM, free disk on the userData volume, and (Windows)
 * WSL availability. `evaluate()` is a pure compatibility check against a profile.
 */

import * as os from 'os';
import { execSync } from 'child_process';
import { app } from 'electron';

import { detectWslAvailability } from '../tool-paths';
import type {
  ISystemProbe,
  SystemProfile,
  CudaInfo,
  WslInfo,
  OptionalComponent,
  Compatibility,
  Platform,
  Arch,
} from './component-types';

// ─────────────────────────────────────────────────────────────────────────────
// State (cached profile)
// ─────────────────────────────────────────────────────────────────────────────

let cachedProfile: SystemProfile | null = null;

// Large sentinel for "couldn't measure disk" — skips the disk gate rather than
// failing it.
const DISK_SENTINEL_MB = Number.MAX_SAFE_INTEGER;

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin' || p === 'win32' || p === 'linux') {
    return p;
  }
  // Unknown platforms fall through to linux-ish behaviour; the catalog's
  // platform gates will simply reject components that aren't listed.
  return 'linux';
}

function normalizeArch(): Arch {
  return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

/**
 * Detect CUDA GPU via nvidia-smi (Windows/Linux only). Returns name + VRAM (MB).
 * Absence or any error → { available: false }.
 */
function detectCuda(platform: Platform): CudaInfo {
  if (platform === 'darwin') {
    return { available: false };
  }

  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();

    if (!out) {
      return { available: false };
    }

    // One GPU per line: "NVIDIA GeForce RTX 4090, 24564"
    const firstLine = out.split('\n')[0].trim();
    const parts = firstLine.split(',').map((s) => s.trim());
    const name = parts[0] || undefined;
    const vramMB = parts[1] ? parseInt(parts[1], 10) : undefined;

    return {
      available: true,
      name,
      vramMB: Number.isFinite(vramMB as number) ? vramMB : undefined,
    };
  } catch {
    return { available: false };
  }
}

/**
 * Free disk space (MB) on the volume that holds userData. Best-effort: on any
 * failure return a large sentinel and log so the disk gate is skipped, not
 * falsely failed.
 */
function detectFreeDiskMB(platform: Platform): number {
  let userDataPath = '';
  try {
    userDataPath = app.getPath('userData');
  } catch {
    userDataPath = os.tmpdir();
  }

  try {
    if (platform === 'win32') {
      // Determine the drive letter of userData (default C:).
      const driveMatch = userDataPath.match(/^([A-Za-z]):/);
      const drive = driveMatch ? `${driveMatch[1].toUpperCase()}:` : 'C:';

      // Prefer wmic; fall back to fsutil.
      try {
        const out = execSync(
          `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace`,
          { encoding: 'utf8', timeout: 10000, windowsHide: true }
        ).trim();
        // Output: "FreeSpace\n123456789"
        const lines = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && /^\d+$/.test(l));
        if (lines.length > 0) {
          const bytes = parseInt(lines[0], 10);
          if (Number.isFinite(bytes)) {
            return Math.round(bytes / 1024 / 1024);
          }
        }
      } catch {
        // fall through to fsutil
      }

      const fsout = execSync(`fsutil volume diskfree ${drive}`, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim();
      // Look for "Total free bytes : 123,456,789"
      const freeMatch = fsout.match(/free bytes[^:]*:\s*([\d,]+)/i);
      if (freeMatch) {
        const bytes = parseInt(freeMatch[1].replace(/,/g, ''), 10);
        if (Number.isFinite(bytes)) {
          return Math.round(bytes / 1024 / 1024);
        }
      }

      console.warn('[COMPONENTS] Could not parse free disk on Windows; skipping disk gate');
      return DISK_SENTINEL_MB;
    }

    // unix: df -k <path>, parse the Available column (KB → MB).
    const out = execSync(`df -k "${userDataPath}"`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    const lines = out.split('\n');
    if (lines.length >= 2) {
      // Header: Filesystem 1024-blocks Used Available Capacity Mounted on
      // The data row may wrap on long device names; take the last line and its
      // numeric columns.
      const dataLine = lines[lines.length - 1].trim();
      const cols = dataLine.split(/\s+/);
      // Available is the 4th numeric-ish column from the left on a normal row.
      // Standard layout: [fs, blocks, used, avail, capacity, mount...]
      const availKB = cols.length >= 4 ? parseInt(cols[3], 10) : NaN;
      if (Number.isFinite(availKB)) {
        return Math.round(availKB / 1024);
      }
    }

    console.warn('[COMPONENTS] Could not parse df output; skipping disk gate');
    return DISK_SENTINEL_MB;
  } catch (err) {
    console.warn(
      '[COMPONENTS] Free-disk detection failed; skipping disk gate:',
      err instanceof Error ? err.message : String(err)
    );
    return DISK_SENTINEL_MB;
  }
}

/**
 * Map tool-paths' WslDetectionResult into the contract's WslInfo shape.
 */
function detectWsl(platform: Platform): WslInfo | undefined {
  if (platform !== 'win32') {
    return undefined;
  }
  const result = detectWslAvailability();
  return {
    available: result.available,
    distros: result.distros,
    defaultDistro: result.defaultDistro,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

async function profile(force?: boolean): Promise<SystemProfile> {
  if (cachedProfile && !force) {
    return cachedProfile;
  }

  const platform = normalizePlatform();
  const arch = normalizeArch();
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const cuda = detectCuda(platform);
  const ramMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeDiskMB = detectFreeDiskMB(platform);
  const wsl = detectWsl(platform);

  const prof: SystemProfile = {
    platform,
    arch,
    appleSilicon,
    cuda,
    ramMB,
    freeDiskMB,
    wsl,
  };

  console.log(
    `[COMPONENTS] System profile: ${platform}/${arch}` +
      `${appleSilicon ? ' (Apple Silicon)' : ''}` +
      `, CUDA=${cuda.available ? `${cuda.name ?? 'yes'} ${cuda.vramMB ?? '?'}MB` : 'no'}` +
      `, RAM=${ramMB}MB, freeDisk=${freeDiskMB === DISK_SENTINEL_MB ? 'unknown' : `${freeDiskMB}MB`}` +
      `${wsl ? `, WSL=${wsl.available ? wsl.distros.join('/') : 'no'}` : ''}`
  );

  cachedProfile = prof;
  return prof;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluate (pure compatibility)
// ─────────────────────────────────────────────────────────────────────────────

function evaluate(component: OptionalComponent, prof: SystemProfile): Compatibility {
  const reasons: string[] = [];
  let degraded = false;

  const req = component.requirements || {};

  // 1. Platform exclusion.
  if (req.platforms && req.platforms.length > 0 && !req.platforms.includes(prof.platform)) {
    reasons.push(`Not available on ${prof.platform}.`);
    return { compatible: false, reasons };
  }

  // 2. GPU requirement.
  //
  // Special rule (see catalog notes): a conda-env component whose requirements
  // declare gpu:'cuda' is ALSO accepted on Apple Silicon. Orpheus runs on either
  // CUDA (vLLM) or Apple Silicon (MLX), but the contract's GpuKind has no
  // "cuda-or-apple-silicon" member, so we encode the alternative here: for
  // conda-env kind, gpu:'cuda' means "CUDA OR Apple Silicon".
  const gpu = req.gpu ?? 'none';
  const condaEnvAcceptsAppleSilicon = component.kind === 'conda-env';

  if (gpu === 'apple-silicon') {
    if (!prof.appleSilicon) {
      reasons.push('Requires Apple Silicon (arm64 Mac).');
      return { compatible: false, reasons };
    }
  } else if (gpu === 'cuda') {
    const cudaOk = prof.cuda.available;
    const appleAlt = condaEnvAcceptsAppleSilicon && prof.appleSilicon;

    if (!cudaOk && !appleAlt) {
      if (condaEnvAcceptsAppleSilicon) {
        reasons.push('Requires an NVIDIA CUDA GPU or Apple Silicon.');
      } else if (prof.appleSilicon) {
        // A CUDA-only accelerator pack on Apple Silicon. The Mac isn't GPU-less —
        // it just uses Metal (MPS) instead of CUDA — so say so, rather than imply
        // "no GPU here". MPS is a device choice in TTS settings, not a download.
        reasons.push('For NVIDIA CUDA GPUs only — not needed on your Apple-Silicon Mac, which has its own GPU acceleration (Metal/MPS).');
      } else {
        reasons.push('Requires an NVIDIA CUDA GPU.');
      }
      return { compatible: false, reasons };
    }

    // VRAM gate only applies on the CUDA path (Apple Silicon uses unified memory
    // and is checked via RAM, if at all).
    if (cudaOk && req.minVramMB !== undefined) {
      const vram = prof.cuda.vramMB;
      if (vram === undefined) {
        // Couldn't read VRAM but a GPU is present — flag as degraded rather than
        // a hard fail so the user isn't blocked by a missing measurement.
        reasons.push('Could not read GPU VRAM; the component may be under-resourced.');
        degraded = true;
      } else if (vram < req.minVramMB) {
        // No CPU fallback for these GPU-backed components → incompatible.
        if (appleAlt) {
          // CUDA is too small but Apple Silicon is also available — fine.
        } else {
          reasons.push(
            `Requires at least ${req.minVramMB} MB VRAM; this GPU has ${vram} MB.`
          );
          return { compatible: false, reasons };
        }
      }
    }
  }
  // gpu === 'none' or 'any' → no GPU gate.

  // 3. RAM gate.
  if (req.minRamMB !== undefined && prof.ramMB < req.minRamMB) {
    reasons.push(
      `Requires at least ${req.minRamMB} MB RAM; this machine has ${prof.ramMB} MB.`
    );
    return { compatible: false, reasons };
  }

  // 4. Disk gate (skipped when freeDiskMB is the sentinel).
  if (
    req.minDiskMB !== undefined &&
    prof.freeDiskMB !== DISK_SENTINEL_MB &&
    prof.freeDiskMB < req.minDiskMB
  ) {
    reasons.push(
      `Requires at least ${req.minDiskMB} MB free disk; ${prof.freeDiskMB} MB available.`
    );
    return { compatible: false, reasons };
  }

  return { compatible: true, degraded: degraded || undefined, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const systemProbe: ISystemProbe = {
  profile,
  evaluate,
};
