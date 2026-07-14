/**
 * Resemble Enhance runtime — an OPTIONAL, managed conda-env component.
 *
 * Resemble Enhance is the generative speech cleaner behind the Enhance tab: it
 * denoises (mask-based) AND re-synthesizes the isolated voice stem into clean,
 * natural speech for TTS training data. It ships as its own relocatable conda env
 * (not the e2a env) because it pins Python 3.11 + torch 2.1.1 (cu121 on
 * Windows/Linux, MPS on macOS) — incompatible with the e2a env's torch 2.7.1.
 *
 * The tarball is fully baked at conda-pack time — the app only extracts +
 * relocates it, it does NOT pip-install. What the pack contains:
 *   - Python 3.11
 *   - torch 2.1.1 (+cu121 on win/linux, MPS build on macOS) + torchaudio 2.1.1
 *   - resemble-enhance installed `--no-deps` + its runtime deps
 *     (librosa, soundfile, numpy, omegaconf, celluloid, pandas, ptflops, rich,
 *      scipy, tqdm, resampy, tabulate) — the same set the Enhance CLI needs, plus
 *     numpy/librosa/soundfile that scripts/enhance_spectral_blend.py imports.
 *   - a deepspeed inference stub (resemble-enhance imports deepspeed at module
 *     load; the stub satisfies the import without the multi-GB CUDA build, since
 *     inference never calls it — see AUDIO_ENHANCEMENT.md).
 *   - setuptools<81 (newer setuptools drops pkg_resources shims resemble-enhance
 *     still imports).
 *
 * Verify: `import resemble_enhance` in the env's python (which also loads torch,
 * so a broken torch/device surfaces here). See runVerify (python-import).
 *
 * The env is resolved by electron/enhance-bridge.ts →
 * getEnhanceNativeEnvRoot() → componentManager.resolveEntry(RESEMBLE_ENV_ID),
 * so once this is installed the Enhance tab's native launch mode "just works".
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';
import { namedCondaEnvCandidates } from './conda-env-detect';

export const RESEMBLE_ENV_ID = 'resemble-env';

// Bump (with a new tarball + sha) to force a re-download on installed machines.
// NOTE: like every managed conda-env, bumping this does NOT auto-retrigger a
// download — component-manager marks an env "installed" whenever the record +
// files resolve, without diffing version/sha. To push a new build the user
// uninstalls + reinstalls from Settings → Add-ons. See rvc-env.ts for the full
// rationale.
const RESEMBLE_ENV_VERSION = '2026.07.14';

// ─────────────────────────────────────────────────────────────────────────────
// TODO(enhance-envs): fill after upload.
//
// The conda-packed tarballs are built + uploaded to the GitHub Releases "assets"
// tag (telltaleatheist/bookforge) as a follow-up. Until then these are empty
// placeholders — component-manager treats an empty url (or bytes:0 with no parts)
// as "not published yet" and tells the user to install it themselves, rather than
// attempting a 404 fetch. Fill in:
//
//   WIN (torch 2.1.1+cu121 → reassembled archive EXCEEDS GitHub's 2 GiB per-file
//   cap, so it MUST be split into parts the downloader concatenates):
//     - RESEMBLE_ENV_WIN_URL     canonical archive NAME (not fetched directly when
//                                parts are set; used to derive filename/type)
//     - RESEMBLE_ENV_WIN_PARTS   ordered part URLs (…​.tar.gz.part00, .part01, …)
//     - RESEMBLE_ENV_WIN_SHA256  sha256 of the REASSEMBLED whole
//     - RESEMBLE_ENV_WIN_BYTES   size in bytes of the REASSEMBLED whole
//
//   MAC (arm64, MPS build — smaller, single file):
//     - RESEMBLE_ENV_MAC_URL     download URL
//     - RESEMBLE_ENV_MAC_SHA256  sha256
//     - RESEMBLE_ENV_MAC_BYTES   size in bytes
//
//   Then update RESEMBLE_ENV_HEADLINE_BYTES + sizeBytes/minDiskMB below to match.
// ─────────────────────────────────────────────────────────────────────────────
const RESEMBLE_ENV_WIN_URL = ''; // TODO(enhance-envs): canonical archive name, e.g. '…/assets/resemble-env-windows-x64.tar.gz'
const RESEMBLE_ENV_WIN_PARTS: string[] = []; // TODO(enhance-envs): ['…/resemble-env-windows-x64.tar.gz.part00', '…​.part01']
const RESEMBLE_ENV_WIN_SHA256 = ''; // TODO(enhance-envs): sha256 of the reassembled whole
const RESEMBLE_ENV_WIN_BYTES = 0;   // TODO(enhance-envs): bytes of the reassembled whole

const RESEMBLE_ENV_MAC_URL = '';    // TODO(enhance-envs): e.g. '…/assets/resemble-env-macos-arm64.tar.gz'
const RESEMBLE_ENV_MAC_SHA256 = ''; // TODO(enhance-envs): sha256
const RESEMBLE_ENV_MAC_BYTES = 0;   // TODO(enhance-envs): bytes

// Headline download size for the UI (largest applicable artifact). 0 until the
// artifacts above are filled — update to the Windows byte count once known.
const RESEMBLE_ENV_HEADLINE_BYTES = 0; // TODO(enhance-envs): set to RESEMBLE_ENV_WIN_BYTES after upload

const RESEMBLE_ENV_ARTIFACTS: ComponentArtifact[] = [
  // win32 x64 — CUDA build (torch 2.1.1+cu121). Split into parts (> 2 GiB) like
  // the f5-env Windows artifact. `url` is the canonical name; `parts` are fetched
  // + concatenated; `sha256`/`bytes` describe the reassembled whole.
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'cuda',
    url: RESEMBLE_ENV_WIN_URL,
    parts: RESEMBLE_ENV_WIN_PARTS,
    sha256: RESEMBLE_ENV_WIN_SHA256,
    bytes: RESEMBLE_ENV_WIN_BYTES,
    condaUnpack: true,
  },
  // macOS arm64 — MPS (Metal) build (torch 2.1.1 MPS). Single file.
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'apple-silicon', // Metal via MPS (matches the f5/orpheus darwin artifacts)
    url: RESEMBLE_ENV_MAC_URL,
    sha256: RESEMBLE_ENV_MAC_SHA256,
    bytes: RESEMBLE_ENV_MAC_BYTES,
    condaUnpack: true,
  },
  // linux x64 — skipped for now (no artifact). Add when a Linux tarball is built.
];

/** The Resemble Enhance env component (managed conda-env). */
export function resembleEnvComponent(): OptionalComponent {
  return {
    id: RESEMBLE_ENV_ID,
    name: 'Resemble Enhance',
    description:
      'Resemble Enhance — local generative voice enhancement for the Enhance tab. '
      + 'Denoises and re-synthesizes speech into clean audio for TTS training. '
      + 'Runs on an NVIDIA CUDA GPU or Apple Silicon.',
    kind: 'conda-env',
    acquisition: ['external', 'managed'],
    sizeBytes: RESEMBLE_ENV_HEADLINE_BYTES,
    requirements: {
      platforms: ['win32', 'darwin'],
      // 'cuda' = CUDA OR Apple Silicon for conda-env components (see the GPU NOTE
      // in component-catalog.ts / system-probe.evaluate()).
      gpu: 'cuda',
      // torch 2.1.1+cu121 download + extracted footprint headroom.
      minDiskMB: 6000,
    },
    artifacts: RESEMBLE_ENV_ARTIFACTS,
    // Point-to-your-env: a user who builds their own `resemble-enhance` conda env
    // is auto-detected (Settings → Add-ons) via RESEMBLE_ENV_PATH or a named env.
    detect: {
      candidates: namedCondaEnvCandidates('resemble-enhance'),
      envVar: 'RESEMBLE_ENV_PATH',
    },
    // Importing resemble_enhance also loads torch, so a broken torch/device is
    // caught here too. Built in the main process → correct for both platforms.
    verify: { kind: 'python-import', module: 'resemble_enhance' },
    version: RESEMBLE_ENV_VERSION,
    entryPath: '', // env root = install dir
    externalHelpUrl: 'https://github.com/resemble-ai/resemble-enhance',
  };
}
