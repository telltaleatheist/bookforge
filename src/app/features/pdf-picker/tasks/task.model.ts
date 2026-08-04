import { TextBlock } from '../services/pdf.service';

/**
 * Task model for the PDF-picker task-checklist rail.
 *
 * A *task* is a discrete piece of book-prep work with a factual, derivable
 * status. Tasks are grouped by workflow stage in the left rail, and the first
 * group is the viewer's modes — the rail is the mode switcher as well as the
 * checklist, so there is no separate control that can disagree with it.
 * `analysis` is a PanelId but NOT a TaskId — it is a status-less tool (flags +
 * search), not a checklist item.
 *
 * Status derivation lives here as pure, exhaustively-typed functions so it is
 * unit-testable in isolation and so a missing task case is a *compile* error
 * (see `deriveTaskStatus`'s `assertNever`). No silent fallbacks: every input is
 * an always-present value (an empty set/array is a real value, not a missing
 * one), and unknown states throw rather than guessing.
 */

export type TaskId =
  | 'select'
  | 'crop'
  | 'ocr'
  | 'merge';

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

export type TaskStatusKind = 'done' | 'suggested' | 'untouched' | 'required-missing';

export interface TaskStatus {
  readonly kind: TaskStatusKind;
  /** Factual, non-judgmental detail line, e.g. "applied to 12 pages", "not run". */
  readonly detail: string;
}

export interface TaskGroup {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly TaskId[];
}

export const TASK_GROUPS: readonly TaskGroup[] = [
  { id: 'modes', label: 'Mode', tasks: ['select', 'crop'] },
  // Split spreads left this rail on 2026-08-04: Owen's corpus has no spread
  // scans, and if one ever shows up splitting returns at the OCR/Cast step,
  // consumed by the cast, rather than as a mode the pointer can be in.
  { id: 'setup', label: 'Setup', tasks: ['ocr'] },
  // Chapters left this rail when they stopped being a list beside the book. A
  // chapter is a block labelled `chapter`, so it is made on the Label tab and
  // read on the Chapter tab of the document nav — there is nothing left for a
  // checklist row to have a status about. Headers and footers left it for the
  // same reason: they are a category, and a category is selected and deleted
  // like any other. Paragraph structure left it because reflow decides it.
  { id: 'cleanup', label: 'Clean up', tasks: ['merge'] },
] as const;

/** Human, sentence-case labels shown in the rail. */
export const TASK_LABELS: Record<TaskId, string> = {
  select: 'Select',
  crop: 'Crop',
  ocr: 'OCR text',
  merge: 'Merge blocks',
};

/**
 * Task order for keyboard digit shortcuts (1..9) and rail rendering.
 * Derived from TASK_GROUPS so the two never drift apart.
 */
export const TASK_ORDER: readonly TaskId[] = TASK_GROUPS.flatMap(g => [...g.tasks]);

/**
 * Rail entries reachable by a digit key. Entries with a letter binding keep it
 * — rebinding them to digits would cost existing muscle memory to buy nothing —
 * so the digits run over everything else in rail order and stay inside 1..9.
 */
const LETTER_TASKS: Readonly<Partial<Record<TaskId, string>>> = {
  select: 'S',
};

const DIGIT_TASKS: readonly TaskId[] = TASK_ORDER.filter(id => !(id in LETTER_TASKS));

/** The key hint shown on each rail row. */
export const TASK_SHORTCUTS: Record<TaskId, string> = (() => {
  const out = { ...LETTER_TASKS } as Record<TaskId, string>;
  DIGIT_TASKS.forEach((id, i) => { out[id] = String(i + 1); });
  return out;
})();

/** The rail entry a digit key activates, or undefined when that digit is unused. */
export function taskForDigit(digit: number): TaskId | undefined {
  return DIGIT_TASKS[digit - 1];
}

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

// ── OCR ───────────────────────────────────────────────────────────────────

export interface OcrStatusInput {
  readonly blocks: readonly TextBlock[];
  readonly deletedBlockIds: ReadonlySet<string>;
  readonly totalPages: number;
}

export function deriveOcrStatus(i: OcrStatusInput): TaskStatus {
  const ocrPages = new Set<number>();
  const pagesWithText = new Set<number>();
  for (const b of i.blocks) {
    if (b.is_ocr) ocrPages.add(b.page);
    // A page "has text" if it holds a live (non-deleted) non-image block.
    if (!i.deletedBlockIds.has(b.id) && b.is_image !== true) {
      pagesWithText.add(b.page);
    }
  }
  if (ocrPages.size > 0) {
    return { kind: 'done', detail: `run on ${ocrPages.size} ${plural(ocrPages.size, 'page')}` };
  }
  const pagesWithoutText = Math.max(0, i.totalPages - pagesWithText.size);
  if (pagesWithoutText > 0) {
    return { kind: 'suggested', detail: `${pagesWithoutText} ${plural(pagesWithoutText, 'page')} have no text` };
  }
  return { kind: 'untouched', detail: 'not run' };
}

/** Count of pages with no live text block — exposed for the OCR panel. */
export function countPagesWithoutText(i: OcrStatusInput): number {
  const pagesWithText = new Set<number>();
  for (const b of i.blocks) {
    if (!i.deletedBlockIds.has(b.id) && b.is_image !== true) {
      pagesWithText.add(b.page);
    }
  }
  return Math.max(0, i.totalPages - pagesWithText.size);
}

// ── Merge ─────────────────────────────────────────────────────────────────

export function deriveMergeStatus(mergeCount: number): TaskStatus {
  if (mergeCount > 0) {
    return { kind: 'done', detail: `${mergeCount} ${plural(mergeCount, 'merge')} applied` };
  }
  return { kind: 'untouched', detail: 'not applied' };
}

/**
 * The count below which building the book is worth one interruption.
 *
 * Not a gate: an article or a single essay really is one chapter, and refusing
 * those books outright would strand them. But an unchaptered book produces one
 * enormous audiobook file with nothing to skip between, and that is discovered
 * hours later at TTS time.
 */
export const CHAPTERS_EXPORT_MINIMUM = 2;

// ─────────────────────────────────────────────────────────────────────────
// Exhaustive dispatcher
// ─────────────────────────────────────────────────────────────────────────

export interface TaskStatusContext {
  /** Blocks the user removed (deleted) — what Select mode is for. */
  readonly removedBlockCount: number;
  readonly crop: CropStatusInput;
  readonly ocr: OcrStatusInput;
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
    case 'ocr':
      return deriveOcrStatus(ctx.ocr);
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
