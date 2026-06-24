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

export const F5_ENV_ID = 'f5-env';

// Bump (with a new tarball + sha) to force a re-download on installed machines.
const F5_ENV_VERSION = '2026.06.24';

const F5_ENV_ARTIFACTS: ComponentArtifact[] = [
  // macOS arm64 — MLX (Metal). Real values; built + verified on the M1 Ultra.
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none', // Apple Silicon / Metal via MLX
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-macos-arm64.tar.gz',
    sha256: '49a6ed7b19083a77609e22754cb847bf202fae9a4d8da45656b941c71898eb7f',
    bytes: 1677322992,
    condaUnpack: true,
  },
  // win32 x64 — native CUDA wheel (f5_tts). Built + uploaded by the Windows side;
  // fill sha256/bytes when f5-env-windows-x64.tar.gz is published.
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'cuda',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/f5-env-windows-x64.tar.gz',
    sha256: '',
    bytes: 0,
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
    acquisition: ['managed'],
    sizeBytes: 1677322992,
    requirements: {
      platforms: ['win32', 'darwin'],
      // CPU-capable on paper, but the shipped builds use the GPU (Metal/CUDA).
      gpu: 'cuda', // 'cuda' = CUDA OR Apple Silicon for conda-env components
      minDiskMB: 6000,
    },
    artifacts: F5_ENV_ARTIFACTS,
    // Mac-primary verify. The Windows CUDA build exposes `f5_tts` instead; the
    // Windows side adjusts when it publishes its artifact.
    verify: { kind: 'python-import', module: 'f5_tts_mlx' },
    version: F5_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
