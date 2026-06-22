/**
 * Which catalog voices are actually usable right now — i.e. their model
 * checkpoint is present on disk.
 *
 * The voice catalog (xtts-voices.ts) lists every voice whose *reference clip*
 * ships in the e2a voices folder, but a voice is only playable once its *model*
 * is installed:
 *   - Fine-tuned voices each need their own dedicated checkpoint (component id
 *     == voice id).
 *   - The stock "XTTS Default" voice and the entire "Voice Library" clone via
 *     the base model, so they're gated on the `xtts-base` component.
 *
 * Used by the TTS API server so external clients (the browser extension) only
 * see voices they can actually play, instead of the whole catalog.
 *
 * This is a leaf module: nothing in the component graph imports it, so pulling
 * in component-manager here introduces no import cycle.
 */

import { FINE_TUNED, getStreamVoices, StreamVoice } from '../xtts-voices';
import { componentManager } from './component-manager';

const BASE_COMPONENT_ID = 'xtts-base';

/** The component that provides a given catalog voice's model checkpoint. */
function componentForVoice(voiceId: string, fineTunedIds: Set<string>): string {
  return fineTunedIds.has(voiceId) ? voiceId : BASE_COMPONENT_ID;
}

/**
 * Ids of catalog voices whose model is installed. One listStatus() pass covers
 * the base model + every fine-tuned voice (it globs the HF cache and self-heals
 * records), so this reflects bundled, downloaded, and freshly-installed voices.
 */
export async function getInstalledVoiceIds(): Promise<string[]> {
  const statuses = await componentManager.listStatus();
  const installedComponents = new Set(
    statuses.filter((s) => s.state === 'installed').map((s) => s.component.id)
  );
  const fineTunedIds = new Set(FINE_TUNED.map((f) => f.id));
  return getStreamVoices()
    .filter((v) =>
      // User-added custom voices carry their own checkpoint, so they're always
      // usable regardless of which catalog components are installed.
      !!v.localCheckpointDir ||
      installedComponents.has(componentForVoice(v.id, fineTunedIds))
    )
    .map((v) => v.id);
}

/** Installed voices as full descriptors (same filter as getInstalledVoiceIds). */
export async function getInstalledVoices(): Promise<StreamVoice[]> {
  const installed = new Set(await getInstalledVoiceIds());
  return getStreamVoices().filter((v) => installed.has(v.id));
}

/**
 * Voices selectable for FULL-AUDIOBOOK generation, as picker options. Only
 * installed voices are returned (so every option actually works — this is what
 * lets BookForge ship without bundling every reference clip):
 *  - 'internal' (Default XTTS) when the base model is installed,
 *  - installed fine-tuned voices (bundled Scarlett + downloaded catalog voices),
 *  - user-added custom voices.
 * Voice-Library clones are intentionally excluded (e2a has no preset for them).
 * Built in the main process so the renderer needs no voice/install knowledge.
 */
export interface AudiobookVoiceOption {
  value: string;
  label: string;
}

/**
 * Voices selectable for full-audiobook generation: ONLY ones that are actually
 * present (Default XTTS, bundled/downloaded fine-tuned, user custom), so the
 * picker never offers a voice that isn't there. Download more from Settings →
 * Voices. Sorted alphabetically, with Default XTTS pinned first.
 */
export async function getAudiobookVoiceOptions(): Promise<AudiobookVoiceOption[]> {
  const voices = await getInstalledVoices();
  let hasDefault = false;
  const rest: AudiobookVoiceOption[] = [];
  for (const v of voices) {
    if (v.id === '__default__') {
      hasDefault = true;
    } else if (v.group === 'Fine-tuned' || v.group === 'Your Voices') {
      rest.push({ value: v.id, label: v.name });
    }
  }
  rest.sort((a, b) => a.label.localeCompare(b.label));
  return hasDefault ? [{ value: 'internal', label: 'Default XTTS' }, ...rest] : rest;
}
