/**
 * F5-TTS runtime — an OPTIONAL, managed conda-env component.
 *
 * F5-TTS is a flow-matching TTS with strong long-form prosody and zero-shot
 * cloning from a reference clip. It ships as its own relocatable conda env (not
 * the e2a env) because the Apple-Silicon build needs `f5-tts-mlx` and its
 * `mlx`/`vocos-mlx` stack, which aren't in the e2a env.
 *
 * Two platform builds:
 *   - macOS arm64 → MLX (Metal). e2a env clone + f5-tts-mlx 0.2.6
 *     (lucasnewman/f5-tts-mlx). Verified end-to-end on an M1 Ultra (relocated,
 *     packed env renders a clean wav). High-level API:
 *       from f5_tts_mlx.generate import generate
 *       generate(generation_text=..., output_path=..., ref_audio_path=None, steps=8, ...)
 *     or load once via f5_tts_mlx.cfm.F5TTS.from_pretrained(...) for the e2a
 *     per-sentence loop.
 *   - win32 x64 → native CUDA wheel (`f5_tts`). Built + published by the Windows
 *     side; fill sha256/bytes when f5-env-windows-x64.tar.gz is published.
 *
 * Model WEIGHTS are NOT in the tarball — they download from HuggingFace on first
 * use (lucasnewman/f5-tts-mlx on Mac).
 *
 * NOTE: the e2a engine class lib/classes/tts_engines/f5.py does not exist yet —
 * the Windows side writes it (mirroring voxtral.py); this env is ready for it.
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';
import { namedCondaEnvCandidates } from './conda-env-detect';

export const F5_ENV_ID = 'f5-env';

// Bump (with a new tarball + sha) to force a re-download on installed machines.
const F5_ENV_VERSION = '2026.06.24';

const F5_ENV_ARTIFACTS: ComponentArtifact[] = [
  // macOS arm64 — MLX (Metal). Real values; built + verified on the M1 Ultra.
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'apple-silicon', // Metal via MLX (matches the orpheus darwin artifact)
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-macos-arm64.tar.gz',
    sha256: '49a6ed7b19083a77609e22754cb847bf202fae9a4d8da45656b941c71898eb7f',
    bytes: 1677322992,
    condaUnpack: true,
  },
  // win32 x64 — native CUDA wheel (f5_tts). Built + verified on Windows. The
  // reassembled archive is 3.24 GB (torch bundles CUDA), over GitHub Releases'
  // 2 GiB per-file cap, so it's hosted as two parts the downloader concatenates.
  // `url` is the canonical name (not fetched directly); sha256/bytes are the whole.
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'cuda',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-windows-x64.tar.gz',
    parts: [
      'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-windows-x64.tar.gz.part00',
      'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-windows-x64.tar.gz.part01',
    ],
    sha256: '673213e90f750378f911af98de8480fdb2a0088aedb69aa6e9f21f935f586cef',
    bytes: 3476487943,
    condaUnpack: true,
  },
];

/** The F5-TTS env component (managed conda-env). */
export function f5EnvComponent(): OptionalComponent {
  return {
    id: F5_ENV_ID,
    name: 'F5-TTS',
    description:
      'Flow-matching neural TTS with strong long-form prosody and reference-clip '
      + 'voice cloning. Runs on Apple Silicon (MLX) or an NVIDIA CUDA GPU. ~1.6 GB download.',
    kind: 'conda-env',
    acquisition: ['external', 'managed'],
    sizeBytes: 1677322992,
    requirements: {
      platforms: ['win32', 'darwin'],
      // CPU-capable on paper, but the shipped builds use the GPU (Metal/CUDA).
      gpu: 'cuda', // 'cuda' = CUDA OR Apple Silicon for conda-env components
      minDiskMB: 6000,
    },
    artifacts: F5_ENV_ARTIFACTS,
    // Point-to-your-env: a user who builds their own conda env is auto-detected
    // (Settings → Add-ons) via F5_ENV_PATH or a named `f5` env.
    detect: {
      candidates: namedCondaEnvCandidates('f5'),
      envVar: 'F5_ENV_PATH',
    },
    // Platform-aware verify: the Apple-Silicon build exposes `f5_tts_mlx` (MLX),
    // the Windows CUDA build exposes `f5_tts`. Built in the main process, so
    // process.platform is the running OS — correct for both managed installs and
    // point-to-your-env detection.
    verify: {
      kind: 'python-import',
      module: process.platform === 'win32' ? 'f5_tts' : 'f5_tts_mlx',
    },
    version: F5_ENV_VERSION,
    entryPath: '', // env root = install dir
    externalHelpUrl: 'https://github.com/SWivid/F5-TTS',
  };
}
