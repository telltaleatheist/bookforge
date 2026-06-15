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
import { listCustomVoices } from './custom-voices';

export interface StreamVoice {
  id: string;       // stable id echoed back on load
  name: string;     // display name
  group: string;    // dropdown optgroup
  repo: string;     // HF repo for the model checkpoint ('' for local custom voices)
  sub: string;      // HF sub-path ('' = repo root, used by the base model)
  refPath: string;  // absolute path to the reference wav for conditioning latents
  // Set for user-added custom voices: load the checkpoint from this local
  // folder (config.json/model.pth/vocab.json) instead of fetching from HF.
  localCheckpointDir?: string;
}

export const BASE_REPO = 'coqui/XTTS-v2';
const BASE_SUB = '';
export const FINE_TUNED_REPO = 'drewThomasson/fineTunedTTSModels';

// The stock XTTS voice. Claribel Dervla is XTTS-v2's first built-in speaker;
// cloning her reference clip via the base model reproduces the default voice.
const DEFAULT_VOICE_REL = 'eng/adult/female/ClaribelDervla.wav';

// The three checkpoint files each fine-tuned XTTS voice ships on HuggingFace
// (the 4th preset file, ref.wav, is a local clip, not downloaded).
export const FINE_TUNED_FILES = ['config.json', 'model.pth', 'vocab.json'];
// Each fine-tuned checkpoint is ~1.7 GB (model.pth) plus a few hundred KB.
export const FINE_TUNED_APPROX_BYTES = 1_860_000_000;

export interface FineTunedVoice {
  id: string;
  name: string;
  sub: string;
  refRel: string;
  lang: string;
  gender: 'male' | 'female';
}

// Curated voices with dedicated fine-tuned checkpoints (premium quality). This
// is the single source of truth for both the player dropdown and the
// downloadable-voice catalog (see components/voice-components.ts). Each id maps
// to a drewThomasson/fineTunedTTSModels checkpoint dir (sub) and a bundled
// reference clip (refRel) used for conditioning latents. Only voices with BOTH
// a checkpoint and a local clip are listed. The first six are also mirrored on
// owenmorgan.com as a download fallback; the rest fetch from HuggingFace.
export const FINE_TUNED: FineTunedVoice[] = [
  { id: 'AiExplained', name: 'AI Explained', sub: 'xtts-v2/eng/AiExplained/', refRel: 'eng/adult/male/AiExplained.wav', lang: 'eng', gender: 'male' },
  { id: 'AsmrRacoon', name: 'ASMR Racoon', sub: 'xtts-v2/eng/AsmrRacoon/', refRel: 'eng/adult/male/AsmrRacoon.wav', lang: 'eng', gender: 'male' },
  { id: 'Awkwafina', name: 'Awkwafina', sub: 'xtts-v2/eng/Awkwafina/', refRel: 'eng/adult/female/Awkwafina.wav', lang: 'eng', gender: 'female' },
  { id: 'BobOdenkirk', name: 'Bob Odenkirk', sub: 'xtts-v2/eng/BobOdenkirk/', refRel: 'eng/adult/male/BobOdenkirk.wav', lang: 'eng', gender: 'male' },
  { id: 'BobRoss', name: 'Bob Ross', sub: 'xtts-v2/eng/BobRoss/', refRel: 'eng/adult/male/BobRoss.wav', lang: 'eng', gender: 'male' },
  { id: 'BrinaPalencia', name: 'Brina Palencia', sub: 'xtts-v2/eng/BrinaPalencia/', refRel: 'eng/adult/female/BrinaPalencia.wav', lang: 'eng', gender: 'female' },
  { id: 'BryanCranston', name: 'Bryan Cranston', sub: 'xtts-v2/eng/BryanCranston/', refRel: 'eng/adult/male/BryanCranston.wav', lang: 'eng', gender: 'male' },
  { id: 'DavidAttenborough', name: 'David Attenborough', sub: 'xtts-v2/eng/DavidAttenborough/', refRel: 'eng/elder/male/DavidAttenborough.wav', lang: 'eng', gender: 'male' },
  { id: 'DeathPussInBoots', name: 'Death (Puss in Boots)', sub: 'xtts-v2/eng/DeathPussInBoots/', refRel: 'eng/adult/male/DeathPussInBoots.wav', lang: 'eng', gender: 'male' },
  { id: 'DermotCrowley', name: 'Dermot Crowley', sub: 'xtts-v2/eng/DermotCrowley/', refRel: 'eng/elder/male/DermotCrowley.wav', lang: 'eng', gender: 'male' },
  { id: 'EvaSeymour', name: 'Eva Seymour', sub: 'xtts-v2/eng/EvaSeymour/', refRel: 'eng/adult/female/EvaSeymour.wav', lang: 'eng', gender: 'female' },
  { id: 'GhostMW2', name: 'Ghost (MW2)', sub: 'xtts-v2/eng/GhostMW2/', refRel: 'eng/adult/male/GhostMW2.wav', lang: 'eng', gender: 'male' },
  { id: 'GideonOfnirEldenRing', name: 'Gideon Ofnir (Elden Ring)', sub: 'xtts-v2/eng/GideonOfnirEldenRing/', refRel: 'eng/elder/male/GideonOfnirEldenRing.wav', lang: 'eng', gender: 'male' },
  { id: 'JillRedfield', name: 'Jill Redfield', sub: 'xtts-v2/eng/JillRedfield/', refRel: 'eng/adult/female/JillRedfield.wav', lang: 'eng', gender: 'female' },
  { id: 'JohnButlerASMR', name: 'John Butler (ASMR)', sub: 'xtts-v2/eng/JohnButlerASMR/', refRel: 'eng/elder/male/JohnButlerASMR.wav', lang: 'eng', gender: 'male' },
  { id: 'JohnMulaney', name: 'John Mulaney', sub: 'xtts-v2/eng/JohnMulaney/', refRel: 'eng/adult/male/JohnMulaney.wav', lang: 'eng', gender: 'male' },
  { id: 'JuliaWhenlan', name: 'Julia Whelan', sub: 'xtts-v2/eng/JuliaWhenlan/', refRel: 'eng/adult/female/JuliaWhenlan.wav', lang: 'eng', gender: 'female' },
  { id: 'LeeHorsley', name: 'Lee Horsley', sub: 'xtts-v2/eng/LeeHorsley/', refRel: 'eng/adult/male/LeeHorsley.wav', lang: 'eng', gender: 'male' },
  { id: 'MelinaEldenRing', name: 'Melina (Elden Ring)', sub: 'xtts-v2/eng/MelinaEldenRing/', refRel: 'eng/adult/female/MelinaEldenRing.wav', lang: 'eng', gender: 'female' },
  { id: 'MorganFreeman', name: 'Morgan Freeman', sub: 'xtts-v2/eng/MorganFreeman/', refRel: 'eng/adult/male/MorganFreeman.wav', lang: 'eng', gender: 'male' },
  { id: 'NeilGaiman', name: 'Neil Gaiman', sub: 'xtts-v2/eng/NeilGaiman/', refRel: 'eng/adult/male/NeilGaiman.wav', lang: 'eng', gender: 'male' },
  { id: 'PeterGriffinFamilyGuy', name: 'Peter Griffin (Family Guy)', sub: 'xtts-v2/eng/PeterGriffinFamilyGuy/', refRel: 'eng/adult/male/PeterGriffinFamilyGuy.wav', lang: 'eng', gender: 'male' },
  { id: 'RafeBeckley', name: 'Rafe Beckley', sub: 'xtts-v2/eng/RafeBeckley/', refRel: 'eng/adult/male/RafeBeckley.wav', lang: 'eng', gender: 'male' },
  { id: 'RainyDayHeadSpace', name: 'Rainy Day Headspace', sub: 'xtts-v2/eng/RainyDayHeadSpace/', refRel: 'eng/elder/male/RainyDayHeadSpace.wav', lang: 'eng', gender: 'male' },
  { id: 'RayPorter', name: 'Ray Porter', sub: 'xtts-v2/eng/RayPorter/', refRel: 'eng/adult/male/RayPorter.wav', lang: 'eng', gender: 'male' },
  { id: 'RelaxForAWhile', name: 'Relax For A While', sub: 'xtts-v2/eng/RelaxForAWhile/', refRel: 'eng/adult/female/RelaxForAWhile.wav', lang: 'eng', gender: 'female' },
  { id: 'RosamundPike', name: 'Rosamund Pike', sub: 'xtts-v2/eng/RosamundPike/', refRel: 'eng/adult/female/RosamundPike.wav', lang: 'eng', gender: 'female' },
  { id: 'ScarlettJohansson', name: 'Scarlett Johansson', sub: 'xtts-v2/eng/ScarlettJohansson/', refRel: 'eng/adult/female/ScarlettJohansson.wav', lang: 'eng', gender: 'female' },
  { id: 'SladeTeenTitans', name: 'Slade (Teen Titans)', sub: 'xtts-v2/eng/SladeTeenTitans/', refRel: 'eng/adult/male/SladeTeenTitans.wav', lang: 'eng', gender: 'male' },
  { id: 'StanleyParable', name: 'Stanley Parable Narrator', sub: 'xtts-v2/eng/StanleyParable/', refRel: 'eng/adult/male/StanleyParable.wav', lang: 'eng', gender: 'male' },
  { id: 'SubZeroMKX', name: 'Sub-Zero (MKX)', sub: 'xtts-v2/eng/SubZeroMKX/', refRel: 'eng/adult/male/SubZeroMKX.wav', lang: 'eng', gender: 'male' },
  { id: 'Top15s', name: 'Top15s', sub: 'xtts-v2/eng/Top15s/', refRel: 'eng/adult/male/Top15s.wav', lang: 'eng', gender: 'male' },
  { id: 'WhisperSalemASMR', name: 'Whisper Salem (ASMR)', sub: 'xtts-v2/eng/WhisperSalemASMR/', refRel: 'eng/adult/male/WhisperSalemASMR.wav', lang: 'eng', gender: 'male' },
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

/**
 * Registered voices loaded from a local folder: user-added ones ('Your Voices')
 * and voices downloaded from the catalog ('Fine-tuned'). Both load their
 * checkpoint from the local folder (no HF fetch) and clone their own clip.
 */
function customStreamVoices(): StreamVoice[] {
  return listCustomVoices().map((v) => ({
    id: v.id,
    name: v.name,
    group: v.source === 'catalog' ? 'Fine-tuned' : 'Your Voices',
    repo: '',
    sub: '',
    refPath: v.refPath,
    localCheckpointDir: v.checkpointDir,
  }));
}

export function getStreamVoices(): StreamVoice[] {
  // Registered voices are rebuilt fresh every call (cheap) so a just-added or
  // just-downloaded voice shows up immediately; only the folder scan is cached.
  const custom = customStreamVoices();
  const customIds = new Set(custom.map((v) => v.id));
  // A downloaded catalog voice supersedes its bundled-clip scan entry (same id):
  // drop the scanned one so it isn't listed twice and so it loads from the local
  // checkpoint instead of re-fetching from HuggingFace.
  const scanned = getScannedStreamVoices().filter((v) => !customIds.has(v.id));
  return [...scanned, ...custom];
}

function getScannedStreamVoices(): StreamVoice[] {
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
