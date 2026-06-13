/**
 * Downloadable TTS voices as optional components.
 *
 * BookForge bundles exactly one voice (Scarlett Johansson). The other curated
 * fine-tuned voices are managed `tts-model` components: a one-click download
 * fetches the checkpoint into e2a's HF cache (kind 'tts-model', installTarget
 * 'e2a-hf-cache'), where the XTTS engine finds it with no special-casing.
 *
 * The catalog is derived from electron/xtts-voices.ts (the single source of
 * truth) so the player dropdown and the Settings → Voices list never diverge.
 */

import {
  FINE_TUNED,
  FINE_TUNED_REPO,
  FINE_TUNED_FILES,
  FINE_TUNED_APPROX_BYTES,
  BASE_REPO,
} from '../xtts-voices';
import type { OptionalComponent } from './component-types';

// The base XTTS-v2 model: repo-root files (note speakers_xtts.pth, which the
// 'internal'/default voice needs). One download unlocks the stock "XTTS Default"
// voice AND every "Voice Library" clone (they all clone via the base model).
const BASE_FILES = ['config.json', 'model.pth', 'vocab.json', 'speakers_xtts.pth'];
const BASE_APPROX_BYTES = 1_870_000_000;

/** The base XTTS-v2 model as a downloadable "Default voice pack" component. */
function baseModelComponent(): OptionalComponent {
  return {
    id: 'xtts-base',
    name: 'Default Voice Pack (XTTS base)',
    description:
      'The base XTTS model. Unlocks the stock voice and the entire Voice Library (all reference-clip clones). ~1.9 GB download.',
    kind: 'tts-model',
    acquisition: ['managed'],
    installTarget: 'e2a-hf-cache',
    sizeBytes: BASE_APPROX_BYTES,
    requirements: { gpu: 'none' },
    artifacts: [],
    hf: { repo: BASE_REPO, sub: '', files: BASE_FILES },
    verify: { kind: 'path-exists' },
    version: '',
    entryPath: '',
  };
}

/** Build the downloadable voice catalog: base model + each fine-tuned voice. */
export function voiceComponents(): OptionalComponent[] {
  const voices = FINE_TUNED.map((v) => {
    const who = v.gender === 'female' ? 'female' : 'male';
    return {
      id: v.id,
      name: v.name,
      description: `Premium fine-tuned XTTS voice (English, ${who}). ~1.7 GB download.`,
      kind: 'tts-model',
      acquisition: ['managed'],
      installTarget: 'e2a-hf-cache',
      sizeBytes: FINE_TUNED_APPROX_BYTES,
      requirements: { gpu: 'none' },
      artifacts: [],
      hf: { repo: FINE_TUNED_REPO, sub: v.sub, files: FINE_TUNED_FILES },
      verify: { kind: 'path-exists' },
      version: '',
      entryPath: '', // set to the downloaded model.pth at install time
    } satisfies OptionalComponent;
  });
  return [baseModelComponent(), ...voices];
}
