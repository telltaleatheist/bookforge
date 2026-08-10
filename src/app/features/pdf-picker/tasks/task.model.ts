import {
  ALL_RAIL_TASK_IDS,
  RAIL_TASK_LABELS,
  type RailGroup,
  type RailTaskId,
  type RailTaskStatus,
  type RailTaskStatusKind,
} from '@shared/document/rail-tasks';

/**
 * Task model for the PDF-picker task-checklist rail.
 *
 * A *task* is a discrete piece of book-prep work with a factual, derivable
 * status. WHICH tasks the rail carries is a fact about the artifact on screen
 * and lives in `shared/document/rail-tasks.ts` — the source file gets the
 * curation modes and their tasks, the book gets its text passes and the
 * narration copy — so this file is the STATUS half: what each entry currently
 * says about the document.
 * `analysis` is a PanelId but NOT a TaskId — it is a status-less tool (flags +
 * search), not a checklist item.
 *
 * Status derivation lives here as pure, exhaustively-typed functions so it is
 * unit-testable in isolation and so a missing task case is a *compile* error
 * (see `deriveTaskStatus`'s `assertNever`). No silent fallbacks: every input is
 * an always-present value (an empty set/array is a real value, not a missing
 * one), and unknown states throw rather than guessing.
 */

/** Every rail entry, derived from the one table that lists them. */
export type TaskId = RailTaskId;

/**
 * The entries that change what the pointer does in the viewer. They are
 * ordinary rail entries with ordinary statuses — the rail IS the mode switcher,
 * so there is no second control anywhere that can disagree with it.
 *
 * `select` is the pointer interaction and opens no panel; `crop` is a mode that
 * also owns the right pane. Labelling is not among them: the palette lives
 * inside Select, on the right-side nav's own tabs, because a label is something
 * you do to a selection rather than a different thing the pointer is.
 *
 * Edit left this list on 2026-08-04 (docs/PIPELINE_V2_PLAN.md). Hand text
 * editing on the canvas is unnecessary — the EPUB passes do the text work — and
 * the working PDF's text is never edited at all. The one exception, chapter
 * titles, is edited in the right-nav Chapter tab.
 */
export const MODE_IDS = ['select', 'crop'] as const;
export type ModeId = typeof MODE_IDS[number];

export function isModeId(id: TaskId): id is ModeId {
  return (MODE_IDS as readonly string[]).includes(id);
}

/** A panel the right pane can show. `analysis` is a tool, not a checklist task. */
export type PanelId = TaskId | 'analysis';

export type TaskStatusKind = RailTaskStatusKind;
export type TaskStatus = RailTaskStatus;

/** A rail group, with its entries narrowed to the ids this picker knows. */
export interface TaskGroup extends RailGroup {
  readonly tasks: readonly TaskId[];
}

/** Human, sentence-case labels shown in the rail. */
export const TASK_LABELS: Record<TaskId, string> = RAIL_TASK_LABELS;

/**
 * Every task there is, in rail order, across both artifacts.
 *
 * For the loops that must consider all of them — the disabled-reason map, the
 * pre-export summary. It is NOT what any rail renders: a rail's rows are
 * `railGroupsForArtifact`, and the two answer different questions.
 */
export const TASK_ORDER: readonly TaskId[] = ALL_RAIL_TASK_IDS;

/** Glyph shown beside each task, keyed by its derived status kind. */
export const STATUS_GLYPH: Record<TaskStatusKind, string> = {
  done: '✓',              // ✓
  suggested: '●',         // ●
  untouched: '○',         // ○
  'required-missing': '⚠', // ⚠
};

// ─────────────────────────────────────────────────────────────────────────
// Pure derivation helpers
// ─────────────────────────────────────────────────────────────────────────

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// ── Select (mode) ─────────────────────────────────────────────────────────

/**
 * The pointer mode reports what has been done THROUGH it rather than whether it
 * is switched on: "which mode am I in" is already answered by the active
 * highlight, so a status that repeated it would carry no information.
 */
export function deriveSelectStatus(removedBlockCount: number): TaskStatus {
  if (removedBlockCount > 0) {
    return { kind: 'done', detail: `${removedBlockCount} ${plural(removedBlockCount, 'block')} removed` };
  }
  return { kind: 'untouched', detail: 'nothing removed' };
}

// ── Crop ──────────────────────────────────────────────────────────────────

/** Minimal geometry shape shared by TextBlocks and crop rectangles. */
export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * True when `block` lies FULLY outside `rect` (no overlap at all). This is the
 * single geometry test used both to decide which blocks a crop removes and to
 * drop OCR blocks re-introduced outside an existing crop, so the two can never
 * drift. "Keep straddlers" falls out for free: a block that partly overlaps is
 * not fully outside, so it is kept whole.
 */
export function isBlockFullyOutside(block: Rectangle, rect: Rectangle): boolean {
  const blockRight = block.x + block.width;
  const blockBottom = block.y + block.height;
  const cropRight = rect.x + rect.width;
  const cropBottom = rect.y + rect.height;
  return (
    blockRight < rect.x ||   // block is entirely to the left
    block.x > cropRight ||   // block is entirely to the right
    blockBottom < rect.y ||  // block is entirely above
    block.y > cropBottom     // block is entirely below
  );
}

export interface CropStatusInput {
  /** Number of pages that currently carry a persistent crop region. */
  readonly croppedPageCount: number;
}

export function deriveCropStatus(i: CropStatusInput): TaskStatus {
  if (i.croppedPageCount > 0) {
    return { kind: 'done', detail: `applied to ${i.croppedPageCount} ${plural(i.croppedPageCount, 'page')}` };
  }
  return { kind: 'untouched', detail: 'not applied' };
}

// ── Merge ─────────────────────────────────────────────────────────────────

export function deriveMergeStatus(mergeCount: number): TaskStatus {
  if (mergeCount > 0) {
    return { kind: 'done', detail: `${mergeCount} ${plural(mergeCount, 'merge')} applied` };
  }
  return { kind: 'untouched', detail: 'not applied' };
}

// ── Export TTS copy ───────────────────────────────────────────────────────

/**
 * The narration copy: written, or not written yet.
 *
 * Deliberately not "up to date". The copy is cut from strikes recorded against
 * the book's sha256, and a book that has moved on makes every strike prove
 * itself against the text it remembers striking
 * (shared/vlm/narration-deletions.ts) — so the export either cuts or refuses BY
 * NAME, which is an answer no control up here could guess at.
 *
 * No longer a rail task (2026-08-08): the export is the primary action at the
 * bottom-right of the viewer, and this is what it says under its own label. It
 * keeps the `TaskStatus` shape because that is the app's one vocabulary for
 * "what does this control currently say about itself", and inventing a second
 * one for a single button would be a second vocabulary.
 */
export function deriveNarrationCopyStatus(exists: boolean): TaskStatus {
  return exists
    ? { kind: 'done', detail: 'written' }
    : { kind: 'untouched', detail: 'not written' };
}

// ─────────────────────────────────────────────────────────────────────────
// Exhaustive dispatcher
// ─────────────────────────────────────────────────────────────────────────

export interface TaskStatusContext {
  /** Blocks the user removed (deleted) — what Select mode is for. */
  readonly removedBlockCount: number;
  readonly crop: CropStatusInput;
  readonly mergeCount: number;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled task id: ${String(x)}`);
}

export function deriveTaskStatus(id: TaskId, ctx: TaskStatusContext): TaskStatus {
  switch (id) {
    case 'select':
      return deriveSelectStatus(ctx.removedBlockCount);
    case 'crop':
      return deriveCropStatus(ctx.crop);
    case 'merge':
      return deriveMergeStatus(ctx.mergeCount);
    default:
      return assertNever(id);
  }
}

/** Derive statuses for every task, in TASK_ORDER, as a Map. */
export function deriveAllTaskStatuses(ctx: TaskStatusContext): Map<TaskId, TaskStatus> {
  const statuses = new Map<TaskId, TaskStatus>();
  for (const id of TASK_ORDER) {
    statuses.set(id, deriveTaskStatus(id, ctx));
  }
  return statuses;
}
