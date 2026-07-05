/**
 * Downloadable RVC enhancement voices as optional components.
 *
 * RVC voices are the model tarballs that the post-TTS voice-enhancement pass
 * (`reassembly-bridge` → `enhanceSentences`) renders narration through. They live
 * beside the `rvc-env` engine in the RVC models dir, NOT in e2a's HF cache.
 *
 * These map `RVC_VOICE_ASSETS` (the source of truth in `rvc-models.ts`) into
 * first-class `OptionalComponent`s so they flow through the SAME ComponentService
 * download/install/status/remove machinery as XTTS `tts-model` voices — one
 * download system, one card UI. The actual fetch/extract is handled by the
 * `kind: 'rvc-model'` branch in component-manager (which reuses `ensureRvcVoice`).
 *
 * Like the bundled XTTS voices, these are hardcoded (not catalog-sourced): there
 * are only a couple of curated enhancement voices and they ride alongside the
 * Owen Morgan HuggingFace repo.
 */

import { getAllRvcVoiceAssets } from '../rvc-models';
import type { OptionalComponent } from './component-types';

/** Build the downloadable RVC-voice components — built-in defaults PLUS the user's
 *  added sources (Settings). Both flow through the same rvc-model install path. */
export function rvcVoiceComponents(): OptionalComponent[] {
  return getAllRvcVoiceAssets().map((v) => ({
    id: v.id,
    name: v.label,
    description: `Voice-enhancement model. Enhances ${v.matches}.`,
    kind: 'rvc-model',
    acquisition: ['managed'],
    sizeBytes: v.bytes,
    // Platform-agnostic model weights; only the RVC engine (rvc-env) is
    // platform-specific. No GPU required to download or run on Mac (MPS) / CPU.
    requirements: { gpu: 'none' },
    // The fetch is driven by component.id → ensureRvcVoice (not a generic
    // artifact download), so no per-platform artifacts are needed here. The
    // url/sha256/bytes live on the RvcVoiceAsset and are used by ensureRvcVoice.
    artifacts: [],
    verify: { kind: 'path-exists' },
    version: v.version,
    entryPath: '', // resolved to the voice model dir at install time
  } satisfies OptionalComponent));
}
