/**
 * Downloadable TTS voices as optional components.
 *
 * BookForge bundles exactly one voice (Scarlett Johansson). Every other voice is
 * a managed `tts-model` component sourced from the remote catalog
 * (CatalogService): a one-click download fetches the checkpoint AND its reference
 * clip into e2a's HF cache (kind 'tts-model', installTarget 'e2a-hf-cache'). The
 * voice is then registered so both the streaming player and full-audiobook
 * generation can use it (see component-manager.fetchTtsModel → registration).
 *
 * The list comes from the catalog, so new voices added on HuggingFace appear
 * automatically after the daily catalog refresh — nothing is hardcoded here.
 */

import { BASE_REPO } from '../xtts-voices';
import { catalogService } from './catalog-service';
import type { OptionalComponent } from './component-types';

// The base XTTS-v2 model: repo-root files (note speakers_xtts.pth, which the
// 'internal'/default voice needs). One download unlocks the stock "XTTS Default"
// voice AND every "Voice Library" clone (they all clone via the base model).
const BASE_FILES = ['config.json', 'model.pth', 'vocab.json', 'speakers_xtts.pth'];
const BASE_APPROX_BYTES = 1_870_000_000;

// The default voice (Scarlett Johansson) installs automatically as part of the
// MANDATORY first-run download (electron/e2a-env-bootstrap.ts → ensureDefaultVoice),
// so it must never appear as an optional/pickable voice — it's always present.
const DEFAULT_VOICE_ID = 'ScarlettJohansson';

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

/** Human label for a voice's language code (catalog langs are eng/deu/rus/…). */
function langLabel(code: string): string {
  const map: Record<string, string> = {
    eng: 'English', deu: 'German', rus: 'Russian', spa: 'Spanish',
    fra: 'French', ita: 'Italian', por: 'Portuguese',
  };
  return map[code] || code;
}

/** Build the downloadable voice catalog: base model + every catalog voice. */
export function voiceComponents(): OptionalComponent[] {
  const voices = catalogService.voices()
    .filter((v) => v.id !== DEFAULT_VOICE_ID) // default voice is mandatory, not optional
    .map((v) => {
    const gb = (v.sizeBytes / 1_000_000_000).toFixed(1);
    return {
      id: v.id,
      name: v.name,
      description: `Fine-tuned XTTS voice (${langLabel(v.lang)}). ~${gb} GB download.`,
      kind: 'tts-model',
      acquisition: ['managed'],
      installTarget: 'e2a-hf-cache',
      sizeBytes: v.sizeBytes,
      requirements: { gpu: 'none' },
      artifacts: [],
      // The reference clip rides along so a downloaded voice is self-contained.
      hf: { repo: v.repo, sub: v.sub, files: v.files, ref: v.ref },
      verify: { kind: 'path-exists' },
      version: '',
      entryPath: '', // set to the downloaded model.pth at install time
    } satisfies OptionalComponent;
  });
  return [baseModelComponent(), ...voices];
}
