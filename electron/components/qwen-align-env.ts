/**
 * Qwen3 forced-alignment runtime (Apple Silicon) — an OPTIONAL, managed
 * conda-env component.
 *
 * WHAT IT IS. The env that can run `narrator align --backend qwen3`
 * (python/narrator/align/aligner.py): Qwen3-ForcedAligner-0.6B driven through
 * the `qwen-asr` package, the fast alternative to the wav2vec2 CTC path in
 * `whisperx-env`. Measured on this M1 Ultra on 2026-09-08: **97x realtime warm
 * on MPS in bfloat16** (33 s cold, model load included, for 95 s of audio).
 *
 * WHY A SEPARATE ENV rather than more packages in an env we already ship:
 *   - `qwen-asr` 0.0.6 PINS transformers 4.57.6. Adding it to the narrator-mlx
 *     env would DOWNGRADE that env's transformers underneath the MLX stack.
 *   - `qwen-asr` drags gradio + flask along as dependencies. `whisperx-env` is a
 *     deliberately small CPU-only env; a web-UI stack has no business in it.
 *   - `whisperx-env` is CPU-BY-DESIGN (MPS balloons memory for wav2vec2). This
 *     env is the opposite: it exists to use the Apple GPU. One env cannot honour
 *     both rules.
 *
 * WHAT IS PINNED (the env this tarball was packed from, built + proven on the
 * Mac Studio 2026-09-08): python 3.11.x, torch 2.14 (MPS), transformers 4.57.6
 * (the qwen-asr pin), qwen-asr 0.0.6, soundfile 0.14, accelerate 1.12, librosa,
 * plus gradio/flask as qwen-asr dependencies. Packed with
 * `conda-pack --format tar.gz`, so it is relocatable and needs `conda-unpack`
 * after extraction — hence `condaUnpack: true`, exactly like `whisperx-env`.
 *
 * THE WEIGHTS ARE NOT IN THE TARBALL. `Qwen3ForcedAligner.from_pretrained`
 * pulls `Qwen/Qwen3-ForcedAligner-0.6B` (~1.2 GB) from Hugging Face on first
 * use — the same arrangement as whisperx's ~378 MB wav2vec2 checkpoint, which
 * torch fetches into a managed `TORCH_HOME`
 * (`electron/whisperx-align-bridge.ts`, `electron/coverage-align-job.ts`). The
 * mirror for this backend is **`HF_HOME`** pointed at
 * `<userData>/runtime/qwen-align-cache`: HF_HOME is the umbrella variable, so
 * one setting covers the hub cache AND everything else huggingface_hub writes,
 * where `HF_HUB_CACHE` would relocate only the hub subdirectory and leave the
 * rest in `~/.cache/huggingface`. TORCH_HOME's shape is one variable; this
 * keeps it one variable. The align ROW that spawns this env (and therefore the
 * code that creates that directory and passes the variable) does not exist yet
 * — it is being built on the PC side. This entry is the component only.
 *
 * DARWIN-ARM64 ONLY, and it says so honestly: `platforms: ['darwin']` plus
 * `gpu: 'apple-silicon'`, so an Intel Mac is told "Requires Apple Silicon (arm64
 * Mac)" rather than being offered a download it cannot use. Windows is NOT
 * served by this component: the PC runs a WSL conda env named `qwen-align`,
 * reached through the `qwenAlignEnv` tool-path setting, and a WSL env is not
 * something a Windows-side managed install can lay down.
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';
import { namedCondaEnvCandidates } from './conda-env-detect';

export const QWEN_ALIGN_ENV_ID = 'qwen-align-env';

// NOTE: bumping this version does NOT auto-trigger a re-download (see the same
// note in rvc-env.ts / whisperx-env.ts) — managed conda-env components are
// "installed" whenever an installed.json record resolves on disk. To push a new
// env the user must uninstall + reinstall from Settings → Add-ons.
const QWEN_ALIGN_ENV_VERSION = '2026.09.08';

const QWEN_ALIGN_ENV_BYTES = 499191377;

// conda-pack tarball published as a GitHub release asset (assets tag on
// telltaleatheist/bookforge). ONE artifact on purpose — see the darwin-arm64
// note in the docblock.
const QWEN_ALIGN_ENV_ARTIFACTS: ComponentArtifact[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'apple-silicon',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/qwen-align-env-macos-arm64.tar.gz',
    sha256: '69b4bb14c644fa94cf7b243de071758d2197b5b1c248bf887c062db9fda415f2',
    bytes: QWEN_ALIGN_ENV_BYTES,
    condaUnpack: true,
  },
];

/** The Qwen3 forced-alignment env component (managed conda-env). */
export function qwenAlignEnvComponent(): OptionalComponent {
  return {
    id: QWEN_ALIGN_ENV_ID,
    name: 'Qwen3 forced aligner (Apple Silicon)',
    description:
      'Optional GPU aligner that matches your ebook text to the narration on the '
      + 'Mac\'s own GPU — about 20x faster than the WhisperX aligner. '
      + '~476 MB download (a one-time ~1.2 GB model downloads on first use).',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: QWEN_ALIGN_ENV_BYTES,
    requirements: {
      // Apple Silicon only. The Windows machine uses a WSL env named
      // `qwen-align` (the `qwenAlignEnv` tool-path setting), not this download.
      platforms: ['darwin'],
      gpu: 'apple-silicon',
      // download (~476 MB) + extracted (~2 GB, torch 2.14) + the HF-pulled
      // Qwen3-ForcedAligner-0.6B weights (~1.2 GB) + headroom.
      minDiskMB: 4000,
    },
    artifacts: QWEN_ALIGN_ENV_ARTIFACTS,
    // Lets a user point at an existing conda env instead of downloading — and
    // auto-adopts a hand-built one. `namedCondaEnvCandidates('qwen-align')`
    // covers the Homebrew miniconda root this Mac's env was built under
    // (/opt/homebrew/Caskroom/miniconda/base/envs/qwen-align) along with the
    // miniforge/anaconda roots. The env var mirrors whisperx-env's
    // WHISPERX_ENV_PATH: a component points at its OWN env, and narrator's
    // NARRATOR_ALIGN_PYTHON (python/narrator/align/env.py) stays what it is —
    // the operator's "align with THIS interpreter" override, which outranks
    // every component and is not a component's to claim.
    detect: {
      commandNames: [],
      candidates: namedCondaEnvCandidates('qwen-align'),
      envVar: 'QWEN_ALIGN_ENV_PATH',
    },
    // Three imports in ONE `python -c`, on the rvc-env precedent, because a
    // bare `import qwen_asr` passes on an env that cannot actually align: torch
    // is what puts the model on MPS, and soundfile is what decodes the audio.
    // Each is a way this env is broken while the headline package imports fine.
    verify: { kind: 'python-import', modules: ['qwen_asr', 'torch', 'soundfile'] },
    version: QWEN_ALIGN_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
