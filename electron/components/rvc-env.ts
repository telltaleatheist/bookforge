/**
 * RVC voice-conversion runtime (Ultimate RVC, BookForge fork) — an OPTIONAL,
 * managed conda-env component.
 *
 * RVC is an OPTIONAL post-TTS "enhancement" pass: after the audiobook is
 * rendered (and assembled), the user may re-render the narration through an RVC
 * voice model that closely matches the TTS voice, which cleans up XTTS vocoder
 * artifacts. It is NOT part of the core XTTS path, so it ships as a separate,
 * self-contained relocatable conda env that downloads on demand from the add-ons
 * / configuration page — exactly like the Orpheus env, but inference-only.
 *
 * Why a SEPARATE env (not merged into the e2a env): upstream ultimate-rvc pins
 * Python 3.12 + its own torch / transformers / onnxruntime-gpu, which conflict
 * with the e2a env (Python 3.11 + torch 2.7.1 + transformers 4.57 + CPU
 * onnxruntime). The BookForge fork (telltaleatheist/ultimate-rvc, branch
 * `bookforge`) is trimmed to the `generate convert-voice` path and relaxed to
 * Python 3.11 so this env can later reuse the SAME cp311 CUDA torch wheel that
 * the cuda-tts pack already downloads (a GPU overlay, wired separately) instead
 * of needing its own multi-GB CUDA download.
 *
 * This env ships CPU-only torch (small, portable); GPU acceleration is a later
 * overlay. The CLI is `urvc generate convert-voice`; verify imports the package.
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';

export const RVC_ENV_ID = 'rvc-env';

// Bump (with a new tarball + sha) to force a re-download on installed machines.
const RVC_ENV_VERSION = '2026.06.21';

// Per-platform conda-pack tarballs published as GitHub release assets (assets
// tag on telltaleatheist/bookforge). macOS arm64 is built from the same fork
// (MPS-native, no CUDA overlay) and added once packed — stub until then.
const RVC_ENV_ARTIFACTS: ComponentArtifact[] = [
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'none',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/urvc-env-windows-x64.tar.gz',
    sha256: 'd271f0171b9bb41db02e0c4bbe8f08f8f1d03dd4076121210db579a558cb4391',
    bytes: 755311249,
    condaUnpack: true,
  },
  // macOS arm64 — same fork, MPS-native (no CUDA overlay).
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/urvc-env-macos-arm64.tar.gz',
    sha256: '6b23ee7fa6fe3cab3844cf07780cb19d0ebf7966e0fb96947634c1e3509074e6',
    bytes: 517004471,
    condaUnpack: true,
  },
];

/** The RVC voice-conversion env component (managed conda-env). */
export function rvcEnvComponent(): OptionalComponent {
  return {
    id: RVC_ENV_ID,
    name: 'Voice Enhancement (RVC)',
    description:
      'Optional engine that re-renders finished narration through a matching RVC '
      + 'voice model to smooth out synthetic artifacts. ~720 MB download (~2.8 GB on disk).',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: 755311249,
    requirements: {
      platforms: ['win32', 'darwin'],
      // CPU-capable; a GPU just makes it faster (added later as an overlay).
      gpu: 'none',
      // download (~720 MB) + extracted (~2.8 GB) headroom.
      minDiskMB: 4000,
    },
    artifacts: RVC_ENV_ARTIFACTS,
    verify: { kind: 'python-import', module: 'ultimate_rvc' },
    version: RVC_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
