import { TextBlock, Category, PageDimension } from '../services/pdf.service';

/**
 * Task model for the PDF-picker task-checklist rail.
 *
 * A *task* is a discrete piece of book-prep work with a factual, derivable
 * status. Tasks are grouped by workflow stage in the left rail. `analysis` is a
 * PanelId but NOT a TaskId — it is a status-less tool (flags + search), not a
 * checklist item.
 *
 * Status derivation lives here as pure, exhaustively-typed functions so it is
 * unit-testable in isolation and so a missing task case is a *compile* error
 * (see `deriveTaskStatus`'s `assertNever`). No silent fallbacks: every input is
 * an always-present value (an empty set/array is a real value, not a missing
 * one), and unknown states throw rather than guessing.
 */

export type TaskId =
  | 'crop'
  | 'split'
  | 'ocr'
  | 'cleanup'
  | 'merge'
  | 'chapters'
  | 'paragraphs';

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
  { id: 'setup', label: 'Setup', tasks: ['crop', 'split', 'ocr'] },
  { id: 'cleanup', label: 'Clean up', tasks: ['cleanup', 'merge'] },
  { id: 'structure', label: 'Structure', tasks: ['chapters', 'paragraphs'] },
] as const;

/** Human, sentence-case labels shown in the rail. */
export const TASK_LABELS: Record<TaskId, string> = {
  crop: 'Crop',
  split: 'Split spreads',
  ocr: 'OCR text',
  cleanup: 'Headers & footers',
  merge: 'Merge blocks',
  chapters: 'Chapters',
  paragraphs: 'Paragraphs',
};

/**
 * Task order for keyboard digit shortcuts (1..7) and rail rendering.
 * Derived from TASK_GROUPS so the two never drift apart.
 */
export const TASK_ORDER: readonly TaskId[] = TASK_GROUPS.flatMap(g => [...g.tasks]);

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

function sourceLabel(source: 'toc' | 'heuristic' | 'manual' | 'mixed'): string {
  return source === 'toc' ? 'TOC' : source;
}

/** Median width/height aspect ratio across pages, or 0 when there are none. */
function medianAspect(pageDimensions: readonly PageDimension[]): number {
  if (pageDimensions.length === 0) return 0;
  const ratios = pageDimensions
    .filter(d => d.height > 0)
    .map(d => d.width / d.height)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 0;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 0
    ? (ratios[mid - 1] + ratios[mid]) / 2
    : ratios[mid];
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

// ── Split ─────────────────────────────────────────────────────────────────

export interface SplitStatusInput {
  /** True only after the user explicitly applied the split (not mere panel entry). */
  readonly applied: boolean;
  readonly enabled: boolean;
  readonly skippedCount: number;
  readonly pageDimensions: readonly PageDimension[];
}

export function deriveSplitStatus(i: SplitStatusInput): TaskStatus {
  // `enabled` alone is not proof of work: entering the split panel auto-enables
  // the config. Only an explicit Apply makes the status factual "done".
  if (i.applied && i.enabled) {
    return { kind: 'done', detail: `applied (${i.skippedCount} skipped)` };
  }
  if (medianAspect(i.pageDimensions) > 1.3) {
    return { kind: 'suggested', detail: 'wide pages detected' };
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

// ── Clean up (headers & footers) ────────────────────────────────────────────

export interface CleanupStatusInput {
  readonly blocks: readonly TextBlock[];
  readonly deletedBlockIds: ReadonlySet<string>;
  readonly categories: Record<string, Category>;
}

export function deriveCleanupStatus(i: CleanupStatusInput): TaskStatus {
  let live = 0;
  let removed = 0;
  let total = 0;
  for (const b of i.blocks) {
    if (b.region !== 'header' && b.region !== 'footer') continue;
    total++;
    const cat = i.categories[b.category_id];
    // A block is "removed" if it is deleted or its category was disabled.
    // A missing category means no disabled flag exists → the block is live
    // (this is a real determination from present data, not a masked default).
    const categoryDisabled = cat !== undefined && cat.enabled === false;
    if (i.deletedBlockIds.has(b.id) || categoryDisabled) {
      removed++;
    } else {
      live++;
    }
  }
  if (total === 0) {
    return { kind: 'untouched', detail: 'no header/footer blocks detected' };
  }
  if (live > 0) {
    return { kind: 'suggested', detail: `${live} header/footer ${plural(live, 'block')} present` };
  }
  return { kind: 'done', detail: `${removed} ${plural(removed, 'block')} removed` };
}

// ── Merge ─────────────────────────────────────────────────────────────────

export function deriveMergeStatus(mergeCount: number): TaskStatus {
  if (mergeCount > 0) {
    return { kind: 'done', detail: `${mergeCount} ${plural(mergeCount, 'merge')} applied` };
  }
  return { kind: 'untouched', detail: 'not applied' };
}

// ── Chapters ──────────────────────────────────────────────────────────────

export function deriveChaptersStatus(
  chapterCount: number,
  source: 'toc' | 'heuristic' | 'manual' | 'mixed',
): TaskStatus {
  if (chapterCount > 0) {
    return { kind: 'done', detail: `${chapterCount} ${plural(chapterCount, 'chapter')} (${sourceLabel(source)})` };
  }
  return { kind: 'required-missing', detail: 'none marked — required for export' };
}

// ── Paragraphs ────────────────────────────────────────────────────────────

export function deriveParagraphsStatus(breakCount: number): TaskStatus {
  if (breakCount > 0) {
    return { kind: 'done', detail: `${breakCount} ${plural(breakCount, 'break')}` };
  }
  return { kind: 'untouched', detail: 'not run' };
}

// ─────────────────────────────────────────────────────────────────────────
// Exhaustive dispatcher
// ─────────────────────────────────────────────────────────────────────────

export interface TaskStatusContext {
  readonly crop: CropStatusInput;
  readonly split: SplitStatusInput;
  readonly ocr: OcrStatusInput;
  readonly cleanup: CleanupStatusInput;
  readonly mergeCount: number;
  readonly chapterCount: number;
  readonly chaptersSource: 'toc' | 'heuristic' | 'manual' | 'mixed';
  readonly paragraphBreakCount: number;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled task id: ${String(x)}`);
}

export function deriveTaskStatus(id: TaskId, ctx: TaskStatusContext): TaskStatus {
  switch (id) {
    case 'crop':
      return deriveCropStatus(ctx.crop);
    case 'split':
      return deriveSplitStatus(ctx.split);
    case 'ocr':
      return deriveOcrStatus(ctx.ocr);
    case 'cleanup':
      return deriveCleanupStatus(ctx.cleanup);
    case 'merge':
      return deriveMergeStatus(ctx.mergeCount);
    case 'chapters':
      return deriveChaptersStatus(ctx.chapterCount, ctx.chaptersSource);
    case 'paragraphs':
      return deriveParagraphsStatus(ctx.paragraphBreakCount);
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
