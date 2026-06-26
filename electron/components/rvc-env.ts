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

// NOTE: bumping this version does NOT auto-trigger a re-download. Managed
// conda-env components go through component-manager's buildStatus, which marks a
// component "installed" whenever an installed.json record exists and the files
// resolve on disk — it never diffs record.version / sha256 against the declared
// values (unlike component-updater.ts, which only governs the manifest-driven
// server binaries like ffmpeg/yt-dlp). To push a new env onto an already-
// installed machine the user must uninstall + reinstall from Settings → Add-ons.
// A fresh install always fetches the current artifact below and verifies its sha.
//
// 2026.06.25: Windows env repacked with the convert-dir CLI (fork main.py);
// macOS env repacked with the MPS-aware empty_cache patch
// (packaging/env/patch-urvc-mps-memory.py) — fixes the Apple Silicon unified-
// memory balloon on long convert-dir batches. See electron/rvc-bridge.ts.
const RVC_ENV_VERSION = '2026.06.25';

// Per-platform conda-pack tarballs published as GitHub release assets (assets
// tag on telltaleatheist/bookforge). macOS arm64 is built from the same fork
// (MPS-native, no CUDA overlay) and added once packed — stub until then.
const RVC_ENV_ARTIFACTS: ComponentArtifact[] = [
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'none',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/urvc-env-windows-x64.tar.gz',
    sha256: '2d83525d3d51abf46dbcf9b352476cf3f14c4248b0fb46f030a22e7403c7debc',
    bytes: 717402185,
    condaUnpack: true,
  },
  // macOS arm64 — same fork, MPS-native (no CUDA overlay).
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/urvc-env-macos-arm64.tar.gz',
    sha256: '2b994018200cae54ee49e2981878f31b901dfbf730684072753fe112c35fff78',
    bytes: 513806644,
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
      + 'voice model to smooth out synthetic artifacts. ~685 MB download (~2.8 GB on disk).',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: 717402185,
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
