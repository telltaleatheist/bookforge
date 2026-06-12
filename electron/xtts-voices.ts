/**
 * XTTS voice catalog (main process).
 *
 * The catalog is the single source of truth for which voices the streaming
 * player offers. It's built by scanning the e2a voices folder, so it's
 * available before the worker (or the model) ever starts — the dropdown can be
 * populated immediately.
 *
 * Three groups:
 *  - Default:       the stock XTTS voice (Claribel Dervla, XTTS-v2's first
 *                   built-in speaker) cloned via the base model.
 *  - Fine-tuned:    a curated set with their own dedicated HF checkpoints.
 *  - Voice Library: every eng/*.wav reference clip, cloned via the base model.
 *
 * Each voice carries the HF (repo, sub) for the checkpoint to load and the
 * absolute refPath of the reference clip used to compute conditioning latents.
 * The worker is a generic executor: it just loads (repo, sub) and clones
 * refPath — it doesn't need to know the catalog.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDefaultE2aPath } from './e2a-paths';

export interface StreamVoice {
  id: string;       // stable id echoed back on load
  name: string;     // display name
  group: string;    // dropdown optgroup
  repo: string;     // HF repo for the model checkpoint
  sub: string;      // HF sub-path ('' = repo root, used by the base model)
  refPath: string;  // absolute path to the reference wav for conditioning latents
}

const BASE_REPO = 'coqui/XTTS-v2';
const BASE_SUB = '';
const FINE_TUNED_REPO = 'drewThomasson/fineTunedTTSModels';

// The stock XTTS voice. Claribel Dervla is XTTS-v2's first built-in speaker;
// cloning her reference clip via the base model reproduces the default voice.
const DEFAULT_VOICE_REL = 'eng/adult/female/ClaribelDervla.wav';

// Curated voices with dedicated fine-tuned checkpoints (premium quality).
const FINE_TUNED: Array<{ id: string; name: string; sub: string; refRel: string }> = [
  { id: 'ScarlettJohansson', name: 'Scarlett Johansson', sub: 'xtts-v2/eng/ScarlettJohansson/', refRel: 'eng/adult/female/ScarlettJohansson.wav' },
  { id: 'DavidAttenborough', name: 'David Attenborough', sub: 'xtts-v2/eng/DavidAttenborough/', refRel: 'eng/elder/male/DavidAttenborough.wav' },
  { id: 'MorganFreeman', name: 'Morgan Freeman', sub: 'xtts-v2/eng/MorganFreeman/', refRel: 'eng/adult/male/MorganFreeman.wav' },
  { id: 'NeilGaiman', name: 'Neil Gaiman', sub: 'xtts-v2/eng/NeilGaiman/', refRel: 'eng/adult/male/NeilGaiman.wav' },
  { id: 'RayPorter', name: 'Ray Porter', sub: 'xtts-v2/eng/RayPorter/', refRel: 'eng/adult/male/RayPorter.wav' },
  { id: 'RosamundPike', name: 'Rosamund Pike', sub: 'xtts-v2/eng/RosamundPike/', refRel: 'eng/adult/female/RosamundPike.wav' },
];

// Cache keyed by voices dir so a library-path change rebuilds the catalog.
let cache: { dir: string; voices: StreamVoice[] } | null = null;

/** Insert spaces so "BryanCranston" reads as "Bryan Cranston". */
function prettify(stem: string): string {
  return stem
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .trim();
}

function walkWavs(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkWavs(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.wav')) out.push(full);
  }
  return out;
}

export function getStreamVoices(): StreamVoice[] {
  const voicesDir = path.join(getDefaultE2aPath(), 'voices');
  if (cache && cache.dir === voicesDir) return cache.voices;

  const engDir = path.join(voicesDir, 'eng');
  const fineTunedIds = new Set(FINE_TUNED.map(f => f.id));
  const list: StreamVoice[] = [];

  // Default
  const defaultRef = path.join(voicesDir, ...DEFAULT_VOICE_REL.split('/'));
  if (fs.existsSync(defaultRef)) {
    list.push({ id: '__default__', name: 'XTTS Default', group: 'Default', repo: BASE_REPO, sub: BASE_SUB, refPath: defaultRef });
  }

  // Fine-tuned
  for (const f of FINE_TUNED) {
    const ref = path.join(voicesDir, ...f.refRel.split('/'));
    if (fs.existsSync(ref)) {
      list.push({ id: f.id, name: f.name, group: 'Fine-tuned', repo: FINE_TUNED_REPO, sub: f.sub, refPath: ref });
    }
  }

  // Voice library — every eng/*.wav cloned via the base model. Skip the
  // fine-tuned names (they appear in their own group) and de-dup names that
  // exist under more than one age/gender folder.
  const seen = new Set<string>();
  const library: StreamVoice[] = [];
  for (const wav of walkWavs(engDir)) {
    const stem = path.basename(wav, path.extname(wav));
    if (fineTunedIds.has(stem) || seen.has(stem)) continue;
    seen.add(stem);
    library.push({ id: stem, name: prettify(stem), group: 'Voice Library', repo: BASE_REPO, sub: BASE_SUB, refPath: wav });
  }
  library.sort((a, b) => a.name.localeCompare(b.name));
  list.push(...library);

  cache = { dir: voicesDir, voices: list };
  return list;
}

export function resolveStreamVoice(id: string): StreamVoice | undefined {
  return getStreamVoices().find(v => v.id === id);
}
