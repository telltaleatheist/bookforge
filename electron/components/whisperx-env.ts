/**
 * WhisperX forced-alignment runtime — an OPTIONAL, managed conda-env component.
 *
 * Powers the "Align to my ebook" mode of Generate Sentences: instead of
 * transcribing the audiobook with Whisper (which mis-spells names and drops
 * words), it force-aligns the project's EPUB text directly to the narration with
 * a wav2vec2 phoneme model. The result is a read-along VTT whose TEXT is the
 * book's exact prose and whose TIMING is phoneme-accurate (~0.1s), immune to
 * transcription errors. Falls back to plain Whisper when there is no ebook.
 *
 * Why a SEPARATE env (not merged into the e2a env): WhisperX pulls the full
 * torch / torchaudio / transformers / pyannote stack, which conflicts with the
 * e2a env's pinned versions. It ships as its own small, self-contained
 * relocatable conda env (~400 MB download, ~1.4 GB on disk) that downloads on
 * demand from Settings → Add-ons — the same machinery as the RVC / Orpheus envs.
 *
 * CPU-ONLY at runtime: the alignment worker forces device=cpu. MPS (Apple GPU)
 * balloons memory catastrophically for wav2vec2 and must never be used — the
 * engine (electron/scripts/align_audiobook.py) hard-codes cpu. The wav2vec2
 * align model (~378 MB) is NOT baked into the tarball; torch fetches it on first
 * use into a managed TORCH_HOME (see electron/whisperx-align-bridge.ts).
 */

import type { OptionalComponent, ComponentArtifact } from './component-types';
import { namedCondaEnvCandidates } from './conda-env-detect';

export const WHISPERX_ENV_ID = 'whisperx-env';

// NOTE: bumping this version does NOT auto-trigger a re-download (see the same
// note in rvc-env.ts) — managed conda-env components are "installed" whenever an
// installed.json record resolves on disk. To push a new env the user must
// uninstall + reinstall from Settings → Add-ons.
const WHISPERX_ENV_VERSION = '2026.07.09';

// Per-platform conda-pack tarballs published as GitHub release assets (assets
// tag on telltaleatheist/bookforge). Windows x64 built separately later — stub
// until then.
const WHISPERX_ENV_ARTIFACTS: ComponentArtifact[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    gpu: 'none',
    url: 'https://github.com/telltaleatheist/bookforge/releases/download/assets/whisperx-env-macos-arm64.tar.gz',
    sha256: '8a5d362543ece52d6231d1444911d83a2ad941d1f477bfb7bda0c55d7e1e4980',
    bytes: 421250340,
    condaUnpack: true,
  },
];

/** The WhisperX forced-alignment env component (managed conda-env). */
export function whisperxEnvComponent(): OptionalComponent {
  return {
    id: WHISPERX_ENV_ID,
    name: 'Ebook Alignment (WhisperX)',
    description:
      'Optional engine that force-aligns your ebook text to an audiobook for '
      + 'perfectly-spelled, accurately-timed read-along sentences. '
      + '~400 MB download (~1.4 GB on disk; a one-time ~378 MB model downloads on first use).',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: 421250340,
    requirements: {
      platforms: ['darwin', 'win32'],
      // CPU-only by design (MPS balloons memory). No GPU requirement.
      gpu: 'none',
      // download (~400 MB) + extracted (~1.4 GB) + wav2vec2 model (~378 MB) headroom.
      minDiskMB: 2600,
    },
    artifacts: WHISPERX_ENV_ARTIFACTS,
    // Lets a user point at an existing conda env instead of downloading.
    detect: {
      commandNames: [],
      candidates: namedCondaEnvCandidates('whisperx'),
      envVar: 'WHISPERX_ENV_PATH',
    },
    verify: { kind: 'python-import', module: 'whisperx' },
    version: WHISPERX_ENV_VERSION,
    entryPath: '', // env root = install dir
  };
}
