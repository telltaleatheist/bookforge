/**
 * Voxtral TTS runtime — an OPTIONAL, managed conda-env component.
 *
 * Voxtral is a Mistral multi-stage neural TTS (Mistral LLM backbone +
 * flow-matching acoustic stage + neural codec, 24 kHz). It ships as its own
 * relocatable conda env rather than riding the e2a env because the engine needs
 * mlx-audio >= 0.4.4 (the version that added the `voxtral_tts` model), which in
 * turn requires transformers >= 5.5 — incompatible with the e2a env's
 * transformers 4.57 that coqui-XTTS is pinned to. Bundling it separately keeps
 * XTTS/Orpheus untouched (the RVC-env pattern).
 *
 * Two platform builds, two backends — the engine class (e2a
 * lib/classes/tts_engines/voxtral.py) auto-selects per platform:
 *   - macOS arm64 → MLX (Metal). e2a env clone + mlx-audio 0.4.4 +
 *     mistral-common[audio]. Verified end-to-end on an M1 Ultra (load + render
 *     of the test sentence, 5 EN presets, and a 27 s long-form passage in one
 *     request at ~0.34x realtime).
 *   - win32 x64 → vLLM-omni (CUDA, via WSL). Built + published by the Windows
 *     side; flaky on a 24 GB card, which is why Mac is Voxtral's primary home.
 *
 * Model WEIGHTS are NOT in the tarball — mlx-community/Voxtral-4B-TTS-2603-mlx-4bit
 * (~2.5 GB) downloads from HuggingFace on first use.
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';

export const VOXTRAL_ENV_ID = 'voxtral-env';

// Bump (with a new tarball + sha) to force a re-download on installed machines.
const VOXTRAL_ENV_VERSION = '2026.06.24';

const VOXTRAL_ENV_ARTIFACTS: ComponentArtifact[] = [
  // macOS arm64 — MLX (Metal). Real values; built + verified on the M1 Ultra.
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none', // Apple Silicon / Metal via MLX (not CUDA)
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/voxtral-env-macos-arm64.tar.gz',
    sha256: 'cd886f441a52e3380551f0c0b69694d4f597f1c00beaaa4dc943fd5eacae464d',
    bytes: 1712498848,
    condaUnpack: true,
  },
  // win32 x64 — vLLM-omni (CUDA, via WSL). Built + uploaded by the Windows side;
  // fill sha256/bytes when voxtral-env-windows-x64.tar.gz is published.
  {
    platform: 'win32',
    arch: 'x64',
    gpu: 'cuda',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/voxtral-env-windows-x64.tar.gz',
    sha256: '',
    bytes: 0,
    condaUnpack: true,
  },
];

/** The Voxtral TTS env component (managed conda-env). */
export function voxtralEnvComponent(): OptionalComponent {
  return {
    id: VOXTRAL_ENV_ID,
    name: 'Voxtral TTS',
    description:
      'ElevenLabs-class neural TTS — 20 preset voices plus zero-shot voice cloning. '
      + 'Runs on Apple Silicon (MLX) or an NVIDIA CUDA GPU (vLLM). ~1.6 GB download '
      + '(plus ~2.5 GB model weights fetched on first use).',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: 1712498848,
    requirements: {
      // 'cuda' here means CUDA OR Apple Silicon for conda-env components — see
      // the GPU NOTE in component-catalog.ts / system-probe.evaluate().
      platforms: ['win32', 'darwin'],
      gpu: 'cuda',
      minDiskMB: 6000,
    },
    artifacts: VOXTRAL_ENV_ARTIFACTS,
    // mistral-common (the tekken tokenizer) is present in BOTH the MLX and
    // vLLM-omni builds and absent from the base e2a env, so it cleanly proves
    // this env is the Voxtral one regardless of platform/backend.
    verify: { kind: 'python-import', module: 'mistral_common' },
    version: VOXTRAL_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
