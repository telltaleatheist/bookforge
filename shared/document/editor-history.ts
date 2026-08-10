/**
 * editor-history — the picker's undo/redo history, and the ONE block table it
 * and the merge/split records name their blocks in.
 *
 * ── The failure this exists to end ──────────────────────────────────────────
 *
 * A `mergeBlocks` history action used to carry, per merge, the FULL `TextBlock`
 * of every source it consumed AND the full merged block those sources were
 * joined into — so the same text was written down twice inside one record, and
 * a `TextBlock` is not a small thing (text, geometry, `line_boxes`, the `bf_*`
 * provenance a converted book stamps). A split action did the same with its
 * children. Measured on the live library, 2026-08-10: ONE project held a single
 * `mergeBlocks` entry of 15.57 MB — 2,923 merge definitions with full block
 * copies inside them — and `MAX_HISTORY` caps the number of ACTIONS at 200, not
 * the number of bytes, so one "merge everything" click is 15 MB of history on
 * its own. Every picker autosave rewrote that file, and the library is a
 * Syncthing volume, so it was re-synced too.
 *
 * ── The shape that replaces it ──────────────────────────────────────────────
 *
 * Every record here names blocks BY ID and nothing else. The blocks themselves
 * live in ONE table keyed by id — `blocksById`, held by the editor-state
 * service and passed through `getHistory`/`setHistory` — so a block that four
 * records mention is written down once. Undoing a merge is then "these source
 * ids become live again, that merged id stops being live", resolved against the
 * table; redoing it is the mirror.
 *
 * ── What actually goes to DISK, and why it is less ──────────────────────────
 *
 * The in-memory table is complete: every block any record names, so undo never
 * has to guess. The PERSISTED table is deliberately sparse, because most of
 * those blocks are ones the document produces again by itself when the project
 * is reopened:
 *
 *   - a merge's SOURCE blocks are the analyzer's own blocks, and they come back
 *     with the analysis (this is exactly what `restoreBlockMerges` has always
 *     relied on);
 *   - a merge's MERGED block is rebuilt from those sources by `createMergedBlock`;
 *   - a span-mode split's CHILDREN are rebuilt from the original block's spans.
 *
 * What is NOT reproducible has to be written down: a TEXT-mode split's children
 * (there are no spans to rebuild them from — this is why the old save persisted
 * `childBlocks` for exactly those), and any block named only by a history entry
 * that no live record will replay — the merged block of a merge that was undone
 * before the project was saved, for instance.
 *
 * `reproducibleBlockIds` states that set from the live document, and
 * `persistedBlockTable` is the table minus it. For the bulk merge above that
 * leaves the table EMPTY and the whole record a few kilobytes of id lists.
 *
 * ── Reading a project written before this ───────────────────────────────────
 *
 * `normalizeEditorHistory` accepts both shapes and always returns this one. The
 * OLD shape is recognised by the presence of EMBEDDED BLOCK OBJECTS —
 * `mergeDefinitions[].sourceBlocks` / `.mergedBlock`, `splitDefinition.childBlocks`,
 * `blockSplits[].childBlocks` — which the new shape never carries; the blocks
 * found there are harvested into the table and the fields are dropped. Anything
 * that is neither is a corrupted record and THROWS, naming the file: a history
 * that cannot be read is not the same thing as a project with no history, and
 * quietly returning an empty stack would look exactly like an undo history
 * somebody lost.
 */

import type { TextBlock } from '../ocr/text-block';

/** Axis-aligned rectangle in PDF page-point space (same space as TextBlock.x/y/w/h). */
export interface CropGeometryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A persistent crop applied to one page. The crop is a display-only region that
 * marks everything OUTSIDE `rect` as removed. `deletedBlockIds` records exactly
 * which live blocks THIS crop deleted on that page, so the crop can be reversed
 * without disturbing blocks that were already deleted by other means.
 */
export interface CropRegion {
  rect: CropGeometryRect;
  deletedBlockIds: string[];
}

/**
 * One block cut into several, by id.
 *
 * The children's block data is NOT here — it is in the block table, under
 * `childBlockIds`. `textMode` marks a split derived from the block's TEXT
 * because no span geometry was available (an OCR-generated or synthetic block):
 * its children cannot be rebuilt from spans on reload, so they are the one class
 * of block that always has to be persisted.
 */
export interface SplitDefinition {
  originalBlockId: string;
  /** Line-group indices where splits were placed. */
  splitPoints: number[];
  childBlockIds: string[];
  textMode?: boolean;
}

/**
 * Several blocks joined into one, by id.
 *
 * Both the sources and the merged block live in the block table. The merged
 * block's text is the sources' text joined, which is why storing it beside them
 * was storing the same characters twice.
 */
export interface MergeDefinition {
  mergedBlockId: string;
  sourceBlockIds: string[];
}

export interface HistoryAction {
  type: 'delete' | 'restore' | 'textEdit' | 'toggleBackgrounds' | 'move' | 'resize' | 'deletePage' | 'restorePage' | 'reorderPages' | 'selection' | 'paragraphBreak' | 'categoryCorrection' | 'splitBlock' | 'mergeBlocks' | 'cropApply' | 'cropClear';
  blockIds: string[];
  selectionBefore: string[];
  selectionAfter: string[];
  // For textEdit actions
  textBefore?: string | null;  // null means no correction (original text)
  textAfter?: string | null;
  // For toggleBackgrounds actions
  backgroundsBefore?: boolean;
  backgroundsAfter?: boolean;
  // For move actions
  offsetXBefore?: number;
  offsetYBefore?: number;
  offsetXAfter?: number;
  offsetYAfter?: number;
  // For resize actions
  widthBefore?: number;
  heightBefore?: number;
  widthAfter?: number;
  heightAfter?: number;
  // For page actions
  pageNumbers?: number[];
  pageOrderBefore?: number[];
  pageOrderAfter?: number[];
  // For paragraph break actions
  paragraphBreaksBefore?: string[];
  paragraphBreaksAfter?: string[];
  // For category correction actions
  categoryCorrectionsBefore?: [string, string][];
  categoryCorrectionsAfter?: [string, string][];
  blockCategoryBefore?: string;  // block's category_id before correction
  blockCategoryAfter?: string;   // block's category_id after correction
  bulkBlockCategoriesBefore?: [string, string][];  // for bulk: blockId → previous categoryId
  bulkBlockCategoriesAfter?: [string, string][];   // for bulk: blockId → new categoryId
  // For splitBlock actions — ids only; the blocks are in the block table.
  splitDefinition?: SplitDefinition;
  // For mergeBlocks actions — ids only; the blocks are in the block table.
  mergeDefinitions?: MergeDefinition[];
  // For cropApply / cropClear actions — composite crop region + block-deletion
  // reversal. Stored as plain Records (page number → value) so the action
  // round-trips through JSON when history is serialized into the project file.
  // A null value means "no crop region on that page".
  cropPagesBefore?: Record<string, CropRegion | null>;
  cropPagesAfter?: Record<string, CropRegion | null>;
  // Block IDs whose deleted-state this action toggled. On cropApply these were
  // newly deleted (apply/redo add them, undo restores them). On cropClear these
  // were restored (apply/redo restore them, undo re-deletes them).
  cropBlockIdsToggled?: string[];
}

/** The block table as it is written to (and read from) a project file. */
export type EditorBlockTable = Record<string, TextBlock>;

/** What a project's history records say, once every block is named by id. */
export interface NormalizedEditorHistory {
  blocks: EditorBlockTable;
  undoStack: HistoryAction[];
  redoStack: HistoryAction[];
  blockSplits: SplitDefinition[];
  blockMerges: MergeDefinition[];
}

/** The four raw fields a persisted project carries, exactly as they came off disk. */
export interface RawEditorHistory {
  /** The block table — present only on projects saved in the normalized shape. */
  historyBlocks?: unknown;
  undoStack?: unknown;
  redoStack?: unknown;
  blockSplits?: unknown;
  blockMerges?: unknown;
}

/**
 * Which shape a persisted project's history is in.
 *
 *  - `embedded` — at least one record carries a block OBJECT inside it. Written
 *    before this module existed; needs migrating.
 *  - `normalized` — records name blocks by id, and a block table is present.
 *  - `empty` — no history, no splits, no merges. Neither shape applies, and
 *    there is nothing to migrate.
 *
 * Reported separately from the migration itself so a caller can SAY which shape
 * it read (the picker logs it) rather than migrating in silence.
 */
export type EditorHistoryShape = 'embedded' | 'normalized' | 'empty';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a value IS, for a message that has to name what was found instead. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

/** True when this record carries a block object rather than a block id. */
function carriesEmbeddedBlocks(record: unknown): boolean {
  if (!isObject(record)) return false;
  return 'sourceBlocks' in record || 'mergedBlock' in record || 'childBlocks' in record;
}

function actionCarriesEmbeddedBlocks(action: unknown): boolean {
  if (!isObject(action)) return false;
  const merges = action['mergeDefinitions'];
  if (Array.isArray(merges) && merges.some(carriesEmbeddedBlocks)) return true;
  return carriesEmbeddedBlocks(action['splitDefinition']);
}

/**
 * Which shape this project's history is in, decided by the ONE signal that
 * separates them: whether any record holds a block object.
 */
export function editorHistoryShape(raw: RawEditorHistory): EditorHistoryShape {
  const stacks = [raw.undoStack, raw.redoStack];
  for (const stack of stacks) {
    if (Array.isArray(stack) && stack.some(actionCarriesEmbeddedBlocks)) return 'embedded';
  }
  if (Array.isArray(raw.blockSplits) && raw.blockSplits.some(carriesEmbeddedBlocks)) {
    return 'embedded';
  }
  if (Array.isArray(raw.blockMerges) && raw.blockMerges.some(carriesEmbeddedBlocks)) {
    return 'embedded';
  }
  const anyRecords = [raw.undoStack, raw.redoStack, raw.blockSplits, raw.blockMerges]
    .some(v => Array.isArray(v) && v.length > 0);
  if (!anyRecords && !isObject(raw.historyBlocks)) return 'empty';
  return 'normalized';
}

/**
 * Read a project's history records into the normalized shape, whichever shape
 * they were written in.
 *
 * `source` names the file in every message this can throw — an editor-state
 * sidecar is one book's entire editing history, and "could not read the merge
 * records" is only actionable if it says WHOSE.
 */
export function normalizeEditorHistory(
  raw: RawEditorHistory,
  source: string,
): NormalizedEditorHistory {
  // Annotated on the VARIABLE, not just on the arrow: that is what makes
  // TypeScript treat a call to it as never-returning, so every check below
  // narrows the value it just rejected instead of needing a cast to survive it.
  const fail: (what: string) => never = (what: string) => {
    throw new Error(
      `${source}: ${what}. This project's undo history cannot be read, and it has NOT been `
      + 'changed — nothing here is entitled to guess what a half-written record meant.',
    );
  };

  const table = new Map<string, TextBlock>();

  // The table a normalized project already carries, first — the records below
  // add to it rather than replace it, and a block written under a key that is
  // not its own id would silently make every reference to it dangle.
  if (raw.historyBlocks !== undefined) {
    if (!isObject(raw.historyBlocks)) {
      fail(`editor history block table is ${describe(raw.historyBlocks)}, not an object of blocks`);
    }
    for (const [key, value] of Object.entries(raw.historyBlocks as Record<string, unknown>)) {
      if (!isObject(value)) {
        fail(`history block '${key}' is ${describe(value)}, not a block`);
      }
      const id = (value as Record<string, unknown>)['id'];
      if (id !== key) {
        fail(`history block '${key}' calls itself '${String(id)}', so nothing can resolve it`);
      }
      table.set(key, value as unknown as TextBlock);
    }
  }

  const harvest = (value: unknown, where: string): void => {
    if (!isObject(value)) fail(`${where} is ${describe(value)}, not a block`);
    const id = (value as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id === '') {
      fail(`${where} has no block id, so no record could ever name it`);
    }
    table.set(id as string, value as unknown as TextBlock);
  };

  const requireStringArray = (value: unknown, where: string): string[] => {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
      fail(`${where} is ${describe(value)}, not a list of block ids`);
    }
    return value as string[];
  };

  const readMerge = (value: unknown, where: string): MergeDefinition => {
    if (!isObject(value)) fail(`${where} is ${describe(value)}, not a merge record`);
    const record = value as Record<string, unknown>;
    const mergedBlockId = record['mergedBlockId'];
    if (typeof mergedBlockId !== 'string' || mergedBlockId === '') {
      fail(`${where} names no merged block`);
    }
    const sourceBlockIds = requireStringArray(record['sourceBlockIds'], `${where}.sourceBlockIds`);

    // The OLD shape, harvested and dropped. Both fields are optional
    // INDIVIDUALLY because the two old writers differed: the undo stack carried
    // both, the saved `block_merges` list carried neither.
    if ('mergedBlock' in record) harvest(record['mergedBlock'], `${where}.mergedBlock`);
    if ('sourceBlocks' in record) {
      const sources = record['sourceBlocks'];
      if (!Array.isArray(sources)) {
        fail(`${where}.sourceBlocks is ${describe(sources)}, not a list of blocks`);
      }
      (sources as unknown[]).forEach((b, i) => harvest(b, `${where}.sourceBlocks[${i}]`));
    }

    return { mergedBlockId: mergedBlockId as string, sourceBlockIds };
  };

  const readSplit = (value: unknown, where: string): SplitDefinition => {
    if (!isObject(value)) fail(`${where} is ${describe(value)}, not a split record`);
    const record = value as Record<string, unknown>;
    const originalBlockId = record['originalBlockId'];
    if (typeof originalBlockId !== 'string' || originalBlockId === '') {
      fail(`${where} names no block that was split`);
    }
    const splitPoints = record['splitPoints'];
    if (!Array.isArray(splitPoints) || splitPoints.some(p => typeof p !== 'number')) {
      fail(`${where}.splitPoints is ${describe(splitPoints)}, not a list of line indices`);
    }
    const childBlockIds = requireStringArray(record['childBlockIds'], `${where}.childBlockIds`);

    if ('childBlocks' in record) {
      const children = record['childBlocks'];
      // The old `block_splits` list wrote `childBlocks: undefined` for every
      // span-mode split, so an absent value here is that writer's "none", not a
      // malformed record.
      if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) {
          fail(`${where}.childBlocks is ${describe(children)}, not a list of blocks`);
        }
        (children as unknown[]).forEach((b, i) => harvest(b, `${where}.childBlocks[${i}]`));
      }
    }

    const split: SplitDefinition = {
      originalBlockId: originalBlockId as string,
      splitPoints: splitPoints as number[],
      childBlockIds,
    };
    if (record['textMode'] === true) split.textMode = true;
    return split;
  };

  const readStack = (value: unknown, name: string): HistoryAction[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      fail(`${name} is ${describe(value)}, not a list of history actions`);
    }
    return (value as unknown[]).map((entry, index) => {
      const where = `${name}[${index}]`;
      if (!isObject(entry)) fail(`${where} is ${describe(entry)}, not a history action`);
      const record = entry as Record<string, unknown>;
      const type = record['type'];
      if (typeof type !== 'string' || type === '') {
        fail(`${where} has no action type, so nothing could ever undo it`);
      }

      // Copied rather than mutated: `raw` is the caller's object, and the
      // unrecognised action types this build no longer produces must pass
      // through untouched exactly as they always did.
      const action = { ...record } as unknown as HistoryAction;

      if (type === 'mergeBlocks') {
        const defs = record['mergeDefinitions'];
        if (!Array.isArray(defs)) {
          fail(`${where} is a merge but carries ${describe(defs)} in place of its merge records`);
        }
        action.mergeDefinitions = (defs as unknown[])
          .map((d, i) => readMerge(d, `${where}.mergeDefinitions[${i}]`));
      } else if (type === 'splitBlock') {
        const def = record['splitDefinition'];
        if (def === undefined) {
          fail(`${where} is a split but carries no split record`);
        }
        action.splitDefinition = readSplit(def, `${where}.splitDefinition`);
      }

      return action;
    });
  };

  const undoStack = readStack(raw.undoStack, 'undo_stack');
  const redoStack = readStack(raw.redoStack, 'redo_stack');

  const readRecordList = <T>(
    value: unknown,
    name: string,
    read: (v: unknown, where: string) => T,
  ): T[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(`${name} is ${describe(value)}, not a list`);
    return (value as unknown[]).map((v, i) => read(v, `${name}[${i}]`));
  };

  const blockSplits = readRecordList(raw.blockSplits, 'block_splits', readSplit);
  const blockMerges = readRecordList(raw.blockMerges, 'block_merges', readMerge);

  const blocks: EditorBlockTable = {};
  for (const [id, block] of table) blocks[id] = block;

  return { blocks, undoStack, redoStack, blockSplits, blockMerges };
}

// ── Reading the table, and the four transitions that read it ───────────────
//
// A record names ids; the document holds blocks. These are the whole of the
// translation between the two, kept here rather than in the Angular service so
// that the undo of a merge is one function with one meaning — the picker calls
// them and so does tools/test-editor-history.js.

/**
 * Resolve block ids against a block table, or THROW naming the first id it does
 * not hold and what was being attempted.
 *
 * A record that names a block the table never received is corrupted history,
 * and the two quiet alternatives are both worse than a stack trace: dropping
 * the id silently loses a block the user is watching for, and substituting a
 * block of the same id from somewhere else would let an undo paint one book's
 * block onto another's page.
 */
export function requireBlocks(
  table: ReadonlyMap<string, TextBlock>,
  ids: readonly string[],
  purpose: string,
): TextBlock[] {
  return ids.map(id => {
    const block = table.get(id);
    if (!block) {
      throw new Error(
        `Cannot ${purpose}: block ${id} is not in this document's block table. The record naming `
        + 'it is corrupted, or the blocks it was made against are not the blocks that are loaded.',
      );
    }
    return block;
  });
}

/** The document's blocks once merges are applied — which is also their redo. */
export function blocksAfterMerge(
  blocks: readonly TextBlock[],
  definitions: readonly MergeDefinition[],
  mergedBlocks: readonly TextBlock[],
): TextBlock[] {
  const consumed = new Set<string>();
  for (const def of definitions) {
    for (const id of def.sourceBlockIds) consumed.add(id);
  }
  return [...blocks.filter(b => !consumed.has(b.id)), ...mergedBlocks];
}

/** The document's blocks once merges are undone: the sources come back. */
export function blocksAfterMergeUndone(
  blocks: readonly TextBlock[],
  definitions: readonly MergeDefinition[],
  sourceBlocks: readonly TextBlock[],
): TextBlock[] {
  const merged = new Set(definitions.map(d => d.mergedBlockId));
  return [...blocks.filter(b => !merged.has(b.id)), ...sourceBlocks];
}

/** The document's blocks once a split is applied — which is also its redo. */
export function blocksAfterSplit(
  blocks: readonly TextBlock[],
  childBlocks: readonly TextBlock[],
): TextBlock[] {
  return [...blocks, ...childBlocks];
}

/** The document's blocks once a split is undone: the children go away. */
export function blocksAfterSplitUndone(
  blocks: readonly TextBlock[],
  definition: SplitDefinition,
): TextBlock[] {
  const children = new Set(definition.childBlockIds);
  return blocks.filter(b => !children.has(b.id));
}

// ── The cap, and what falls out of the table when it bites ─────────────────

/**
 * How many ACTIONS one document's undo stack keeps.
 *
 * A count of actions is only a meaningful cap because an action is a list of
 * ids: when it carried whole blocks, one bulk merge was 15 MB of "one action".
 */
export const MAX_EDITOR_HISTORY = 200;

/** Drop the oldest actions past the cap, in place. Returns the ones dropped. */
export function trimUndoStack(
  undoStack: HistoryAction[],
  max: number = MAX_EDITOR_HISTORY,
): HistoryAction[] {
  if (undoStack.length <= max) return [];
  return undoStack.splice(0, undoStack.length - max);
}

/**
 * Drop from a block table every block no surviving record names. Returns the
 * ids removed.
 *
 * The keep-set is exactly what can still ask for a block: both history stacks,
 * the live split records and the live merge records. A block that is on screen
 * is reachable through one of those by construction — a merged block is in the
 * merge records until it is unmerged or undone, a split's children are in the
 * split records for as long as the split stands — and an analyzer block was
 * never in the table to begin with.
 */
export function pruneBlockTable(
  table: Map<string, TextBlock>,
  undoStack: readonly HistoryAction[],
  redoStack: readonly HistoryAction[],
  splits: Iterable<SplitDefinition>,
  merges: Iterable<MergeDefinition>,
): string[] {
  const keep = blockIdsReferencedByHistory(undoStack, redoStack, splits, merges);
  const removed: string[] = [];
  for (const id of [...table.keys()]) {
    if (!keep.has(id)) {
      table.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Every block id the given records name. */
export function blockIdsReferencedByHistory(
  undoStack: readonly HistoryAction[],
  redoStack: readonly HistoryAction[],
  splits: Iterable<SplitDefinition>,
  merges: Iterable<MergeDefinition>,
): Set<string> {
  const referenced = new Set<string>();
  const addSplit = (def: SplitDefinition): void => {
    referenced.add(def.originalBlockId);
    for (const id of def.childBlockIds) referenced.add(id);
  };
  const addMerge = (def: MergeDefinition): void => {
    referenced.add(def.mergedBlockId);
    for (const id of def.sourceBlockIds) referenced.add(id);
  };
  for (const stack of [undoStack, redoStack]) {
    for (const action of stack) {
      if (action.splitDefinition) addSplit(action.splitDefinition);
      if (action.mergeDefinitions) action.mergeDefinitions.forEach(addMerge);
    }
  }
  for (const def of splits) addSplit(def);
  for (const def of merges) addMerge(def);
  return referenced;
}

/**
 * The block ids the LOAD path puts back into the table by itself, so that
 * writing them to disk would be writing a second copy of something the document
 * already produces.
 *
 * Three sources, and they are the three the restore does in order:
 *   1. every block the analysis hands back — that is `liveBlockIds` plus the
 *      merge SOURCES the analysis still holds (a merge removes its sources from
 *      the live list, but the analyzer knows nothing about the merge and hands
 *      them back on the next open, which is what `restoreBlockMerges` resolves
 *      them from);
 *   2. every live merge's merged block, which `createMergedBlock` rebuilds from
 *      those sources;
 *   3. every SPAN-mode split's children, which are rebuilt from the original
 *      block's spans. TEXT-mode children are deliberately absent: there are no
 *      spans to rebuild them from, so they are the class that must be written.
 */
export function reproducibleBlockIds(
  liveBlockIds: Iterable<string>,
  merges: Iterable<MergeDefinition>,
  splits: Iterable<SplitDefinition>,
): Set<string> {
  const reproducible = new Set<string>(liveBlockIds);
  for (const def of merges) {
    reproducible.add(def.mergedBlockId);
    for (const id of def.sourceBlockIds) reproducible.add(id);
  }
  for (const def of splits) {
    reproducible.add(def.originalBlockId);
    if (!def.textMode) {
      for (const id of def.childBlockIds) reproducible.add(id);
    }
  }
  return reproducible;
}

/**
 * The block table as it goes to disk: everything the in-memory table holds that
 * the document will NOT produce again on its own.
 */
export function persistedBlockTable(
  table: ReadonlyMap<string, TextBlock>,
  reproducible: ReadonlySet<string>,
): EditorBlockTable {
  const out: EditorBlockTable = {};
  for (const [id, block] of table) {
    if (!reproducible.has(id)) out[id] = block;
  }
  return out;
}

/** A persisted table, as the in-memory one. */
export function blockTableFromRecord(record: EditorBlockTable): Map<string, TextBlock> {
  return new Map(Object.entries(record));
}
