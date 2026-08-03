/**
 * The downloadable page-layout (blocks) model as an optional component.
 *
 * Maps `BLOCKS_MODELS` — the source of truth in `../blocks-models.ts` — into
 * `OptionalComponent`s so it flows through the SAME ComponentService
 * download/install/status/remove machinery as voices, RVC models and
 * speech-to-text. That is what puts it in the Settings components list and in the
 * setup page's download dock, rather than needing a bespoke downloader UI.
 *
 * The actual fetch is the `kind: 'blocks-model'` branch in component-manager,
 * which delegates to `downloadBlocksModel` (deduped, so a Detect run that finds
 * no model can await the same download the user started in Settings).
 */

import { BLOCKS_MODELS } from '../blocks-models';
import type { OptionalComponent } from './component-types';

export const BLOCKS_MODEL_COMPONENT_PREFIX = 'blocks-model-';

/**
 * Component id for a model id
 * ('foundry-blocks-v1-4b' → 'blocks-model-foundry-blocks-v1-4b').
 *
 * The id is RECORDED in the installed-components state, so the rubric → blocks
 * rename (Aug 2026) orphaned any `rubric-model-rubric-v*` record a user had.
 * Deliberately not migrated: the record only says "this component is installed",
 * `listStatus` walks the CATALOG and never reads an id it does not know, and
 * presence is re-detected from the GGUF on disk anyway (see `isBlocksModelPresent`
 * and the detection branch in component-manager). The stale row is inert.
 */
export function blocksModelComponentId(modelId: string): string {
  return `${BLOCKS_MODEL_COMPONENT_PREFIX}${modelId}`;
}

/** Model id for a component id, or null when it isn't one. */
export function blocksModelIdFromComponentId(componentId: string): string | null {
  return componentId.startsWith(BLOCKS_MODEL_COMPONENT_PREFIX)
    ? componentId.slice(BLOCKS_MODEL_COMPONENT_PREFIX.length)
    : null;
}

export function blocksModelComponents(): OptionalComponent[] {
  return BLOCKS_MODELS.map((m) => ({
    id: blocksModelComponentId(m.id),
    // Named for what it does. "Blocks" is the stage name and means nothing to
    // someone who just wants their scanned book to export cleanly.
    name: m.name,
    description: m.note,
    kind: 'blocks-model',
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
    // The fetch is driven by the model id → downloadBlocksModel, not by a
    // generic artifact download, so no per-platform artifacts are needed.
    artifacts: [],
    verify: { kind: 'path-exists' },
    version: '1',
    entryPath: '', // resolved to the GGUF path at install time
  } satisfies OptionalComponent));
}
