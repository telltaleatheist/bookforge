/**
 * Downloadable Whisper (speech-to-text) models as optional components.
 *
 * These map `WHISPER_MODELS` (the source of truth in `whisper-models.ts`) into
 * first-class `OptionalComponent`s so they flow through the SAME ComponentService
 * download/install/status/remove machinery as voices and language packs — which
 * means the bottom-right download dock (SetupDownloadService) can queue them.
 * The actual fetch/delete is handled by the `kind: 'stt-model'` branch in
 * component-manager (which reuses `downloadWhisperModel` / `deleteWhisperModel`).
 *
 * The "Generate sentences" picker enqueues one of these when the chosen model
 * isn't on disk yet; the queued transcription job then awaits the same download
 * (deduped inside whisper-models.ts) before transcribing.
 */

import { WHISPER_MODELS } from '../whisper-models';
import type { OptionalComponent } from './component-types';

export const WHISPER_MODEL_COMPONENT_PREFIX = 'whisper-model-';

/** Component id for a whisper model id ('small' → 'whisper-model-small'). */
export function whisperModelComponentId(modelId: string): string {
  return `${WHISPER_MODEL_COMPONENT_PREFIX}${modelId}`;
}

/** Whisper model id for a component id, or null when it isn't one. */
export function whisperModelIdFromComponentId(componentId: string): string | null {
  return componentId.startsWith(WHISPER_MODEL_COMPONENT_PREFIX)
    ? componentId.slice(WHISPER_MODEL_COMPONENT_PREFIX.length)
    : null;
}

/** Build the downloadable Whisper-model components from the model catalog. */
export function whisperModelComponents(): OptionalComponent[] {
  return WHISPER_MODELS.map((m) => ({
    id: whisperModelComponentId(m.id),
    // User-facing name: "speech to text", never "Whisper" (users don't know
    // what Whisper is) — models go by their size label.
    name: `Speech to text (${m.label})`,
    description: m.note,
    kind: 'stt-model',
    acquisition: ['managed'],
    sizeBytes: m.sizeMB * 1024 * 1024,
    // Platform-agnostic model weights; transcription runs on CPU or GPU alike.
    requirements: { gpu: 'none' },
    // The fetch is driven by the model id → downloadWhisperModel (not a generic
    // artifact download), so no per-platform artifacts are needed here.
    artifacts: [],
    verify: { kind: 'path-exists' },
    version: '1',
    entryPath: '', // resolved to the model dir at install time
  } satisfies OptionalComponent));
}
