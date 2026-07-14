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
//
// 2026.07.14: env repacked to REINTEGRATE audio-separator so the Enhance tab's
// speech-separation stage can run in this env (electron/enhance-bridge.ts spawns
// `python -m audio_separator.utils.cli` here). Added to the pack:
//   - the git patch-1 fork of python-audio-separator
//   - onnxruntime-gpu
//   - a torchvision matching THIS env's torch. On the Windows dev box the env was
//     torch 2.7.0+cu128 → torchvision 0.22.0+cu128; the published managed env may
//     be torch 2.7.1+cu126 → torchvision 0.22.1+cu126 — pick the torchvision that
//     matches whatever torch the packed env actually carries.
const RVC_ENV_VERSION = '2026.07.14';

// ─────────────────────────────────────────────────────────────────────────────
// TODO(enhance-envs): fill after upload.
//
// The 2026.07.14 repack (audio-separator reintegrated) is built + uploaded to the
// GitHub Releases "assets" tag as a follow-up, so these are placeholders until
// then — component-manager treats an empty url (or bytes:0 with no parts) as "not
// published yet" and tells the user to install it themselves rather than 404ing.
// The pre-repack (2026.06.25) real values are kept in comments for reference.
//
//   WIN (now carries audio-separator + onnxruntime-gpu + CUDA torch/torchvision →
//   the reassembled archive very likely EXCEEDS GitHub's 2 GiB per-file cap, so it
//   MUST be split into parts, like f5-env's Windows artifact):
//     - RVC_ENV_WIN_URL     canonical archive NAME (not fetched directly when parts set)
//     - RVC_ENV_WIN_PARTS   ordered part URLs (…​.tar.gz.part00, .part01, …)
//     - RVC_ENV_WIN_SHA256  sha256 of the REASSEMBLED whole
//     - RVC_ENV_WIN_BYTES   size in bytes of the REASSEMBLED whole
//   Pre-repack win (single file): url urvc-env-windows-x64.tar.gz,
//     sha256 2d83525d3d51abf46dbcf9b352476cf3f14c4248b0fb46f030a22e7403c7debc,
//     bytes 717402185.
//
//   MAC (arm64, MPS fork — repack with audio-separator too):
//     - RVC_ENV_MAC_URL / RVC_ENV_MAC_SHA256 / RVC_ENV_MAC_BYTES
//   Pre-repack mac: url urvc-env-macos-arm64.tar.gz,
//     sha256 2b994018200cae54ee49e2981878f31b901dfbf730684072753fe112c35fff78,
//     bytes 513806644.
//
//   Then update RVC_ENV_HEADLINE_BYTES + sizeBytes/minDiskMB / the description's
//   size line below to match.
// ─────────────────────────────────────────────────────────────────────────────
const RVC_ENV_WIN_URL = '';    // TODO(enhance-envs): e.g. '…/assets/urvc-env-windows-x64.tar.gz'
const RVC_ENV_WIN_PARTS: string[] = []; // TODO(enhance-envs): ['…/urvc-env-windows-x64.tar.gz.part00', '…​.part01']
const RVC_ENV_WIN_SHA256 = ''; // TODO(enhance-envs): sha256 of the reassembled whole
const RVC_ENV_WIN_BYTES = 0;   // TODO(enhance-envs): bytes of the reassembled whole

const RVC_ENV_MAC_URL = '';    // TODO(enhance-envs): e.g. '…/assets/urvc-env-macos-arm64.tar.gz'
const RVC_ENV_MAC_SHA256 = ''; // TODO(enhance-envs): sha256
const RVC_ENV_MAC_BYTES = 0;   // TODO(enhance-envs): bytes

// Headline download size for the UI (largest applicable artifact). 0 until the
// artifacts above are filled — set to RVC_ENV_WIN_BYTES once known.
const RVC_ENV_HEADLINE_BYTES = 0; // TODO(enhance-envs): set after upload

// Per-platform conda-pack tarballs published as GitHub release assets (assets
// tag on telltaleatheist/bookforge).
const RVC_ENV_ARTIFACTS: ComponentArtifact[] = [
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'none',
    url: RVC_ENV_WIN_URL,
    parts: RVC_ENV_WIN_PARTS,
    sha256: RVC_ENV_WIN_SHA256,
    bytes: RVC_ENV_WIN_BYTES,
    condaUnpack: true,
  },
  // macOS arm64 — same fork, MPS-native (no CUDA overlay).
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none',
    url: RVC_ENV_MAC_URL,
    sha256: RVC_ENV_MAC_SHA256,
    bytes: RVC_ENV_MAC_BYTES,
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
      + 'voice model to smooth out synthetic artifacts. Also carries audio-separator '
      + 'for the Enhance tab.',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: RVC_ENV_HEADLINE_BYTES,
    requirements: {
      platforms: ['win32', 'darwin'],
      // CPU-capable; a GPU just makes it faster (added later as an overlay). The
      // Windows repack now bundles CUDA torch + onnxruntime-gpu (for audio-
      // separator), so it needs more disk than the pre-repack CPU env.
      gpu: 'none',
      // Bumped for the CUDA-carrying repack — download + extracted headroom.
      minDiskMB: 8000,
    },
    artifacts: RVC_ENV_ARTIFACTS,
    verify: { kind: 'python-import', module: 'ultimate_rvc' },
    version: RVC_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
