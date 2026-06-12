/**
 * Optional Component System — shared contract
 *
 * BookForge ships a small XTTS-only core. Heavy or platform-specific pieces
 * (Calibre, Orpheus, Tesseract) are OPTIONAL COMPONENTS that
 * the app detects-compatibility-for, downloads, installs, verifies, and removes
 * at runtime.
 *
 * Three honest states replace today's silent fallbacks:
 *   - installed     → resolved and verified, ready to use
 *   - available     → compatible with this machine, not yet installed
 *   - incompatible  → this machine can't run it (reasons[] explains why)
 *
 * This file is the LOCKED CONTRACT. Backend (probe/downloader/catalog/manager),
 * IPC bridge, and renderer all code against these types. Do not change a shape
 * here without updating every consumer in the same pass.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'darwin' | 'win32' | 'linux';
export type Arch = 'arm64' | 'x64';

/** GPU class a component needs. 'none' = pure CPU; 'any' = benefits from but
 *  does not require a GPU. */
export type GpuKind = 'apple-silicon' | 'cuda' | 'any' | 'none';

/** How a component is acquired and verified. */
export type ComponentKind =
  | 'binary'     // an executable (downloadable archive, or a user's own install)
  | 'conda-env'  // a conda env (conda-pack tarball, or a user's own `conda create`)
  | 'system';    // provided by the OS (e.g. Apple Vision); nothing to download

/**
 * How a component can be obtained. A component may support both — the user
 * chooses, and everything resolves through the same `resolveEntry` seam.
 *   - external → the user installs it themselves (normal installer / conda env);
 *                BookForge auto-detects it or the user points at it. No hosting.
 *   - managed  → BookForge downloads, extracts, and installs it. Needs hosting.
 */
export type AcquisitionMode = 'external' | 'managed';

export type ComponentState =
  | 'installed'
  | 'available'     // compatible, not installed
  | 'incompatible'  // system cannot run it
  | 'installing'
  | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog (ships in-app; later remote-fetchable for updatability)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComponentRequirements {
  /** If omitted, all platforms are eligible. */
  platforms?: Platform[];
  /** Default 'none'. */
  gpu?: GpuKind;
  /** Minimum VRAM for GPU-backed components (e.g. Orpheus/vLLM). */
  minVramMB?: number;
  minRamMB?: number;
  /** Free disk required to install (download + extracted footprint). */
  minDiskMB?: number;
}

export interface ComponentArtifact {
  platform: Platform;
  arch: Arch;
  /** Disambiguates GPU-specific builds (e.g. a cuda vs cpu env) when needed. */
  gpu?: GpuKind;
  /** Download URL. MAY be a stub ('' or a placeholder) until hosting is chosen
   *  in Phase 2 — the manager treats an empty/placeholder url as "not yet
   *  publishable" and surfaces it as an error rather than attempting a fetch. */
  url: string;
  /** sha256 of the artifact for integrity. Empty string allowed pre-hosting;
   *  when empty, the verify-checksum step is skipped with a logged warning. */
  sha256: string;
  /** Download size in bytes (for UI + disk pre-check). */
  bytes: number;
  /** conda-env only: run `conda-unpack` after extraction. */
  condaUnpack?: boolean;
}

export interface VerifySpec {
  kind: 'exec' | 'python-import' | 'path-exists';
  /** Path (relative to the install dir) to the executable or env python. */
  entry?: string;
  /** exec: arguments to pass (e.g. ['--version']). */
  args?: string[];
  /** python-import: module name to import (e.g. 'orpheus_tts'). */
  module?: string;
  /** Optional substring that must appear in stdout for success. */
  expect?: string;
}

/**
 * How to auto-detect an EXTERNAL (user-installed) component. Mirrors the
 * candidate-path scanning already in tool-paths.ts (getCondaCandidates, etc.).
 * All fields are data only — no functions — so the catalog stays serializable.
 */
export interface DetectSpec {
  /** Executable names to look up on PATH (e.g. 'ebook-convert', 'tesseract'). */
  commandNames?: string[];
  /** Absolute candidate paths to probe, tagged by platform. The first that
   *  exists and verifies wins. */
  candidates?: { platform: Platform; path: string }[];
  /** Environment variable that may hold the path (e.g. 'CALIBRE_PATH'). */
  envVar?: string;
}

export interface OptionalComponent {
  id: string;                  // 'calibre' | 'orpheus' | 'tesseract'
  name: string;                // display name
  description: string;         // one or two lines for the UI
  kind: ComponentKind;
  /** Which acquisition modes this component offers. At least one. 'external'
   *  is the zero-hosting default; 'managed' requires published artifacts. */
  acquisition: AcquisitionMode[];
  /** Headline size for the UI (largest applicable managed artifact); 0 for
   *  external-only components. */
  sizeBytes: number;
  requirements: ComponentRequirements;
  /** Managed-mode download targets. Empty for external-only components. */
  artifacts: ComponentArtifact[];
  /** External-mode auto-detection. Present when 'external' is supported. */
  detect?: DetectSpec;
  verify: VerifySpec;
  /** Version/tag this catalog entry points at (matched against InstalledRecord
   *  to detect upgrades). Empty/loose for external installs we don't version. */
  version: string;
  /** Path that consumers resolve to USE the component (binary → the executable;
   *  conda-env → the env root). For MANAGED installs this is relative to the
   *  install dir; for EXTERNAL it is the absolute detected/chosen path stored on
   *  the InstalledRecord. */
  entryPath: string;
  /** Optional URL to the user-facing install instructions for external mode
   *  (e.g. the Calibre download page), surfaced as a "How to install" link. */
  externalHelpUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// System profile + compatibility
// ─────────────────────────────────────────────────────────────────────────────

export interface CudaInfo {
  available: boolean;
  name?: string;
  vramMB?: number;
}

export interface WslInfo {
  available: boolean;
  distros: string[];
  defaultDistro?: string;
}

export interface SystemProfile {
  platform: Platform;
  arch: Arch;
  appleSilicon: boolean;
  cuda: CudaInfo;
  ramMB: number;
  freeDiskMB: number;
  /** Windows only; reuses the existing tool-paths WSL detection. */
  wsl?: WslInfo;
}

export interface Compatibility {
  compatible: boolean;
  /** Runs, but sub-optimally (e.g. low VRAM, CPU fallback). */
  degraded?: boolean;
  /** Human-readable lines shown in the UI when incompatible or degraded. */
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Installed record — persisted to userData/components/installed.json
// ─────────────────────────────────────────────────────────────────────────────

export interface InstalledRecord {
  id: string;
  version: string;
  /** How this install was obtained. */
  source: AcquisitionMode;
  /** Absolute install directory. For external installs this is the directory
   *  containing the entry (informational). */
  path: string;
  /** Absolute resolved entry (executable for binary, env root for conda-env). */
  entryPath: string;
  /** Managed installs only — integrity + size of the fetched artifact. */
  sha256?: string;
  bytes?: number;
  /** ISO timestamp; stamped in the main process. */
  installedAt: string;
}

export interface InstalledManifest {
  components: Record<string, InstalledRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime status (catalog × installed × compatibility) — returned to the UI
// ─────────────────────────────────────────────────────────────────────────────

export interface ComponentStatus {
  component: OptionalComponent;
  state: ComponentState;
  compatibility: Compatibility;
  installed?: InstalledRecord;
  /** Present while state === 'installing'. */
  progress?: InstallProgress;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install progress — streamed over IPC during install()
// ─────────────────────────────────────────────────────────────────────────────

export type InstallPhase =
  | 'resolve'      // pick artifact, pre-check disk/compat
  | 'download'
  | 'verify'       // checksum
  | 'extract'
  | 'postinstall'  // conda-unpack, chmod, etc.
  | 'verify-run'   // run VerifySpec
  | 'done'
  | 'error';

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  /** 0–100 within the current phase. */
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  record?: InstalledRecord;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service interfaces — implemented in the backend, consumed by IPC
// ─────────────────────────────────────────────────────────────────────────────

export interface ISystemProbe {
  /** Detect the current machine's capabilities (cached after first call). */
  profile(force?: boolean): Promise<SystemProfile>;
  /** Pure function: does this component fit the given profile? */
  evaluate(component: OptionalComponent, profile: SystemProfile): Compatibility;
}

export interface IComponentManager {
  /** Catalog × installed × compatibility for every known component. */
  listStatus(): Promise<ComponentStatus[]>;
  getStatus(id: string): Promise<ComponentStatus | null>;

  // ── Managed acquisition (BookForge downloads it) ──────────────────────────
  /** Download + verify + extract + verify-run. onProgress fires per phase tick. */
  install(id: string, onProgress?: (p: InstallProgress) => void): Promise<InstallResult>;
  /** Abort an in-flight managed install for `id` (no-op if none running). */
  cancel(id: string): Promise<void>;

  // ── External acquisition (user installs it; BookForge points at it) ───────
  /** Scan the component's DetectSpec (PATH + candidate paths + env var) and
   *  return the first path that exists, or null. Does not record anything. */
  detectExternal(id: string): Promise<string | null>;
  /** Verify a user-supplied (or detected) path against the VerifySpec and, on
   *  success, record it as an external install. Throws with a clear reason if
   *  the path does not verify. */
  setExternalPath(id: string, entryPath: string): Promise<ComponentStatus>;

  // ── Removal (both modes) ──────────────────────────────────────────────────
  /** Managed: delete the install dir + record. External: drop the record only
   *  (never deletes the user's own install). */
  uninstall(id: string): Promise<void>;

  // ── Integration seam ──────────────────────────────────────────────────────
  /** Absolute entry path for an installed+verified component (managed OR
   *  external), else null. e2a-paths / ebook-convert-bridge call this instead
   *  of guessing or silently falling back. */
  resolveEntry(id: string): string | null;
}
