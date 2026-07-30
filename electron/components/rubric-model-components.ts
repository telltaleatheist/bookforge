/**
 * The downloadable page-layout (rubric) model as an optional component.
 *
 * Maps `RUBRIC_MODELS` — the source of truth in `../rubric-models.ts` — into
 * `OptionalComponent`s so it flows through the SAME ComponentService
 * download/install/status/remove machinery as voices, RVC models and
 * speech-to-text. That is what puts it in the Settings components list and in the
 * setup page's download dock, rather than needing a bespoke downloader UI.
 *
 * The actual fetch is the `kind: 'rubric-model'` branch in component-manager,
 * which delegates to `downloadRubricModel` (deduped, so a Detect run that finds
 * no model can await the same download the user started in Settings).
 */

import { RUBRIC_MODELS } from '../rubric-models';
import type { OptionalComponent } from './component-types';

export const RUBRIC_MODEL_COMPONENT_PREFIX = 'rubric-model-';

/** Component id for a model id ('rubric-v3-4b' → 'rubric-model-rubric-v3-4b'). */
export function rubricModelComponentId(modelId: string): string {
  return `${RUBRIC_MODEL_COMPONENT_PREFIX}${modelId}`;
}

/** Model id for a component id, or null when it isn't one. */
export function rubricModelIdFromComponentId(componentId: string): string | null {
  return componentId.startsWith(RUBRIC_MODEL_COMPONENT_PREFIX)
    ? componentId.slice(RUBRIC_MODEL_COMPONENT_PREFIX.length)
    : null;
}

export function rubricModelComponents(): OptionalComponent[] {
  return RUBRIC_MODELS.map((m) => ({
    id: rubricModelComponentId(m.id),
    // Named for what it does. "Rubric" is our word for it and means nothing to
    // someone who just wants their scanned book to export cleanly.
    name: m.name,
    description: m.note,
    kind: 'rubric-model',
    acquisition: ['managed'],
    sizeBytes: m.bytes,
    // Runs on whatever llama-server can use — Metal, CUDA, or CPU. Slower on
    // CPU, but a page is a few hundred tokens of output, so it still finishes.
    requirements: {
      gpu: 'none',
      minRamMB: m.minRAM * 1024,
      // Only the GGUF lands on disk — nothing is extracted alongside it.
      minDiskMB: Math.ceil(m.bytes / (1024 * 1024)) + 256,
    },
    // The fetch is driven by the model id → downloadRubricModel, not by a
    // generic artifact download, so no per-platform artifacts are needed.
    artifacts: [],
    verify: { kind: 'path-exists' },
    version: '1',
    entryPath: '', // resolved to the GGUF path at install time
  } satisfies OptionalComponent));
}
