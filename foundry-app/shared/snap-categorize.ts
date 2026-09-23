/**
 * BLOCK CATEGORIES BY SNAP — the pure half: what snap is shown, what it is asked,
 * and what its answers become.
 *
 * ── What this is (Owen, 2026-09-22) ─────────────────────────────────────────
 *
 * *"the new tile will be used to categorize blocks as section header, chapter
 * header, list, body text, etc. we'll hand snap a list of possible categories,
 * we'll send in the entire epub, and we'll ask it which one it should be … chapter
 * headers get chapter markers."*
 *
 * snap (C:\Users\tellt\Projects\snap, its README) answers a closed question with
 * ONE forward pass: it reads the model's next-token probabilities over lettered
 * options and never generates. So every block gets a category and a probability,
 * and a block the model was unsure of is left as it was rather than guessed at.
 *
 * AN EXPERIMENT, run outside Crucible on purpose: Crucible's chat door cannot
 * return the letter probabilities snap reads (no logprobs, no raw completion,
 * no prompt-cache reuse), and Owen ruled "not through crucible yet — good call".
 * If it earns its place it becomes a Crucible job, which is where a GPU feature
 * lives (the 2026-09-17 ruling that deleted the local page reader).
 *
 * ── Context: as much of the book as fits, with the contents as a hint ────────
 *
 * Owen: *"the more context it has for surrounding data, the better decision it
 * would make (i assume) … we could feed it the table of contents (if it exists)
 * and suggest it might use that. though sometimes TOCs dont exist."* Every window
 * therefore opens with the book's title and its navigation entries (the EPUB's own
 * contents), marked as a hint, and then as many consecutive blocks as the engine's
 * window holds. A book that fits is sent whole; a longer one is cut into windows
 * that prefer to break where a chapter starts.
 *
 * ── What the answers become ─────────────────────────────────────────────────
 *
 * OPS, the same `{op:'category'}` and `{op:'chapter', set}` a person's Apply
 * writes (shared/ops.ts), so the result is an ordinary edit step: drawn by the
 * existing chips, comparable against the step before, removable in one delete.
 */

import type { CategoryOp, ChapterSetOp } from './ops';

/** The categories snap chooses between: the engine's spelling, and what each one means to the model. */
export const SNAP_CATEGORY_OPTIONS: Readonly<Record<string, string>> = {
  Title: 'a chapter or part heading: the title that opens a chapter, a part or another major division of the book, including a chapter number printed on its own line',
  'Section-header': 'a heading inside a chapter that names a section or a subsection',
  Text: 'ordinary body text: a paragraph of the book\'s own prose',
  'List-item': 'one item of a bulleted or numbered list',
  Quote: 'a block quotation or an epigraph, set apart from the body text',
  Caption: 'a caption for a picture, a map, a figure or a table',
  Footnote: 'the text of a footnote or an endnote, usually beginning with its number',
};

/**
 * Categories snap is NOT asked about, and why: a picture, a formula and a table
 * are what the markup says they are — their shape is structural, not a reading
 * of the words — and page furniture does not occur in a book that has no pages.
 */
export const SNAP_SKIPPED_CATEGORIES: ReadonlySet<string> = new Set([
  'Picture', 'Formula', 'Table', 'Page-header', 'Page-footer',
]);

/** The one row shape this module needs — a subset of `BookRow`, so a test can build one by hand. */
export interface SnapRow {
  id: string;
  category: string;
  text: string;
}

/** The one chapter shape this module needs — a subset of `BookChapter`. */
export interface SnapChapter {
  id: string;
  title: string;
}

/** A run of consecutive rows sent to snap as one state: `rows.slice(start, end)`. */
export interface SnapWindow {
  start: number;
  end: number;
}

/**
 * A token estimate for text, deliberately HIGH.
 *
 * Qwen's tokenizer averages near four characters a token on English prose; this
 * counts one per 3.2 so a window sized by it cannot overrun the engine's context
 * on a book of short words or many numbers. An overrun is a refusal from the
 * engine; an underrun is only a slightly smaller window.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/** One block as snap sees it: its id in brackets, then its text on one line. */
export function blockLine(row: SnapRow): string {
  return `[${row.id}] ${row.text.replace(/\s+/g, ' ').trim()}`;
}

/** The part of every window that is the same: the book, and its contents as a hint. */
export function bookHeader(title: string, chapters: readonly SnapChapter[]): string {
  const lines = [`BOOK: ${title}`];
  if (chapters.length > 0) {
    lines.push(
      'TABLE OF CONTENTS (the book\'s own navigation — a hint: a chapter heading usually '
      + 'matches one of these entries, but the list can be incomplete or wrong):',
    );
    for (const chapter of chapters) lines.push(`- ${chapter.title}`);
  } else {
    lines.push('TABLE OF CONTENTS: none — this book has no navigation to go by.');
  }
  return lines.join('\n');
}

/**
 * CUT THE BOOK INTO WINDOWS THAT EACH FIT `budget` TOKENS, header included.
 *
 * Greedy, and it prefers a chapter boundary: when a window is full it ends at the
 * last chapter start inside it, if that start is past the window's middle —
 * otherwise at the row where it filled, because a window half the size it could
 * be costs more context than a mid-chapter cut does. A single block longer than a
 * whole window is still sent alone rather than dropped: the engine refuses it by
 * name if it truly cannot hold it, which is a sentence rather than a silent gap.
 */
export function buildWindows(
  rows: readonly SnapRow[],
  chapterStarts: ReadonlySet<string>,
  headerTokens: number,
  budget: number,
): SnapWindow[] {
  const room = budget - headerTokens;
  if (room <= 0) {
    throw new Error(
      `The engine's window (${budget} tokens) cannot even hold the book's title and contents `
      + `(${headerTokens} tokens). Start it with a larger context.`,
    );
  }
  const windows: SnapWindow[] = [];
  let start = 0;
  while (start < rows.length) {
    let used = 0;
    let end = start;
    while (end < rows.length) {
      const cost = estimateTokens(blockLine(rows[end]!)) + 1;
      if (end > start && used + cost > room) break;
      used += cost;
      end += 1;
    }
    if (end < rows.length) {
      for (let cut = end - 1; cut > start + (end - start) / 2; cut -= 1) {
        if (chapterStarts.has(rows[cut]!.id)) { end = cut; break; }
      }
    }
    windows.push({ start, end });
    start = end;
  }
  return windows;
}

/** The state snap is handed for one window: the header, where this window sits, and its blocks. */
export function windowState(
  header: string,
  rows: readonly SnapRow[],
  window: SnapWindow,
  index: number,
  count: number,
): string {
  const where = count === 1
    ? 'BLOCKS (the whole book, in reading order; each line is one block: its id in brackets, then its text):'
    : `BLOCKS (part ${index + 1} of ${count} of the book, in reading order; the blocks before and after `
      + 'this part are not shown; each line is one block: its id in brackets, then its text):';
  const body = rows.slice(window.start, window.end).map(blockLine).join('\n');
  return `${header}\n\n${where}\n${body}`;
}

/** The question asked about one block — snap's `choice` question shape. */
export function blockQuestion(row: SnapRow): {
  type: 'choice'; instructions: string; options: Readonly<Record<string, string>>;
} {
  return {
    type: 'choice',
    instructions: `What kind of block is [${row.id}]? Judge it by its own text, the blocks around it `
      + 'and the table of contents.',
    options: SNAP_CATEGORY_OPTIONS,
  };
}

/** Does snap get asked about this row at all? */
export function isAsked(row: SnapRow): boolean {
  return !SNAP_SKIPPED_CATEGORIES.has(row.category) && row.text.trim().length > 0;
}

/** snap's answer to one `choice` question — the fields this module reads. */
export interface SnapChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  label_mass: number;
}

/** When an answer is trusted enough to change a block. */
export interface SnapPolicy {
  /** The chosen category's share of the letter probability. */
  minConfidence: number;
  /** The letters' share of ALL probability — below it the model wanted to say something else. */
  minLabelMass: number;
}

export const DEFAULT_SNAP_POLICY: SnapPolicy = { minConfidence: 0.6, minLabelMass: 0.9 };

/** One row of the report written beside the step: what was asked, answered and done. */
export interface SnapReportRow {
  id: string;
  was: string;
  answer: string;
  confidence: number;
  labelMass: number;
  probabilities: Record<string, number>;
  /** `changed`, `same`, or why a different answer was not applied. */
  outcome: 'changed' | 'same' | 'low-confidence' | 'low-label-mass';
}

export interface SnapDecision {
  categoryOps: CategoryOp[];
  chapterOps: ChapterSetOp[];
  report: SnapReportRow[];
}

/**
 * WHAT THE ANSWERS COME TO: category changes, and chapter markers on the headings.
 *
 * A category changes only when snap chose a different one confidently
 * (`SnapPolicy`); everything else stays exactly as it was and the report says why.
 *
 * CHAPTERS ARE ADDED, NEVER TAKEN AWAY. A run of consecutive `Title` rows (after
 * the changes) is one heading — a number line and a title line are one chapter
 * opening — and it gets a chapter marker at its first row, titled with the run's
 * text, unless a chapter already starts at that row or within the three rows
 * before it (an EPUB's navigation often lands on the ornament or the number just
 * above the words). The publisher's own divisions are left alone: a nav entry the
 * model reads differently is still the publisher's statement, and removing one
 * is a person's call.
 */
export function decide(
  rows: readonly SnapRow[],
  answers: ReadonlyMap<string, SnapChoiceAnswer>,
  chapters: readonly SnapChapter[],
  policy: SnapPolicy = DEFAULT_SNAP_POLICY,
): SnapDecision {
  const categoryOps: CategoryOp[] = [];
  const report: SnapReportRow[] = [];
  const finalCategory = new Map<string, string>();
  for (const row of rows) {
    finalCategory.set(row.id, row.category);
    const answer = answers.get(row.id);
    if (answer === undefined) continue;
    let outcome: SnapReportRow['outcome'];
    if (answer.choice === row.category) {
      outcome = 'same';
    } else if (answer.label_mass < policy.minLabelMass) {
      outcome = 'low-label-mass';
    } else if (answer.confidence < policy.minConfidence) {
      outcome = 'low-confidence';
    } else {
      outcome = 'changed';
      categoryOps.push({ op: 'category', id: row.id, category: answer.choice });
      finalCategory.set(row.id, answer.choice);
    }
    report.push({
      id: row.id,
      was: row.category,
      answer: answer.choice,
      confidence: answer.confidence,
      labelMass: answer.label_mass,
      probabilities: answer.probabilities,
      outcome,
    });
  }

  const starts = new Set(chapters.map((chapter) => chapter.id));
  const chapterOps: ChapterSetOp[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (finalCategory.get(rows[i]!.id) !== 'Title') continue;
    if (i > 0 && finalCategory.get(rows[i - 1]!.id) === 'Title') continue;
    let end = i;
    while (end + 1 < rows.length && finalCategory.get(rows[end + 1]!.id) === 'Title') end += 1;
    let covered = false;
    for (let back = i; back >= Math.max(0, i - 3); back -= 1) {
      if (starts.has(rows[back]!.id)) { covered = true; break; }
    }
    if (covered) continue;
    const title = runTitle(rows.slice(i, end + 1).map((row) => row.text));
    if (title.length === 0) continue;
    chapterOps.push({ op: 'chapter', set: rows[i]!.id, title });
  }
  return { categoryOps, chapterOps, report };
}

/**
 * A heading run's title: its lines joined, a bare number or "Chapter N" line
 * joined to the words after it with a colon — the shape an EPUB's own navigation
 * uses ("1: The Legacies of Revolution").
 */
export function runTitle(lines: readonly string[]): string {
  const parts = lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0);
  if (parts.length === 0) return '';
  const numberLine = /^(chapter|part|book)?\s*([0-9]+|[ivxlcdm]+)\.?$/i;
  if (parts.length > 1 && numberLine.test(parts[0]!)) {
    return `${parts[0]}: ${parts.slice(1).join(' ')}`;
  }
  return parts.join(' ');
}

// ── The tile's wire: what the renderer sends, hears and gets back ─────────────

export interface SnapCategorizeSettings {
  /** The snap checkout: `scripts/serve.ps1`, `.venv/Scripts/snap.exe`, `models/`. */
  snapHome: string;
  /** The engine's context, in tokens, when this press starts it. */
  contextTokens: number;
  minConfidence?: number;
  minLabelMass?: number;
}

export interface SnapProgress {
  projectDir: string;
  phase: 'starting' | 'asking' | 'applying' | 'stopping' | 'done' | 'failed' | 'cancelled';
  message: string;
  done?: number;
  total?: number;
}

export interface SnapCategorizeResult {
  asked: number;
  changed: number;
  chapters: number;
  lowConfidence: number;
  windows: number;
  /** The report of every answer, beside the book. */
  reportPath: string;
  /** Whether this press started the model — and so brought it down again. */
  startedModel: boolean;
  /** Null when there was nothing to change, so no step was made. */
  applied: boolean;
}
