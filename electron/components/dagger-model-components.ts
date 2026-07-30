/**
 * The downloadable footnote-marker model as an optional component.
 *
 * Maps `DAGGER_MODELS` — the source of truth in `../dagger-models.ts` — into
 * `OptionalComponent`s so it flows through the SAME ComponentService
 * download/install/status/remove machinery as voices, RVC models,
 * speech-to-text and the page-layout model. That is what puts it in the Settings
 * add-ons list and in the setup page's download dock, rather than needing a
 * bespoke downloader UI.
 *
 * The actual fetch is the `kind: 'dagger-model'` branch in component-manager,
 * which delegates to `downloadDaggerModel` (deduped, so a cleanup run that finds
 * no model can await the same download the user started in Settings).
 */

import { DAGGER_MODELS } from '../dagger-models';
import type { OptionalComponent } from './component-types';

export const DAGGER_MODEL_COMPONENT_PREFIX = 'dagger-model-';

/** Component id for a model id ('dagger-v1-0.6b' → 'dagger-model-dagger-v1-0.6b'). */
export function daggerModelComponentId(modelId: string): string {
  return `${DAGGER_MODEL_COMPONENT_PREFIX}${modelId}`;
}

/** Model id for a component id, or null when it isn't one. */
export function daggerModelIdFromComponentId(componentId: string): string | null {
  return componentId.startsWith(DAGGER_MODEL_COMPONENT_PREFIX)
    ? componentId.slice(DAGGER_MODEL_COMPONENT_PREFIX.length)
    : null;
}

export function daggerModelComponents(): OptionalComponent[] {
  return DAGGER_MODELS.map((m) => ({
    id: daggerModelComponentId(m.id),
    // Named for what it does. "Dagger" is our word for it and means nothing to
    // someone who just wants their scanned book to read cleanly.
    name: m.name,
    description: m.note,
    kind: 'dagger-model',
    acquisition: ['managed'],
    sizeBytes: m.bytes,
    // Runs on whatever llama-server can use — Metal, CUDA, or CPU. At 0.6B even
    // the CPU path keeps up with a cleanup pass.
    requirements: {
      gpu: 'none',
      minRamMB: m.minRAM * 1024,
      // Only the GGUF lands on disk — nothing is extracted alongside it.
      minDiskMB: Math.ceil(m.bytes / (1024 * 1024)) + 256,
    },
    // The fetch is driven by the model id → downloadDaggerModel, not by a
    // generic artifact download, so no per-platform artifacts are needed.
    artifacts: [],
    verify: { kind: 'path-exists' },
    version: '1',
    entryPath: '', // resolved to the GGUF path at install time
  } satisfies OptionalComponent));
}
