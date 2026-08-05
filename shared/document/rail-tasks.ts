/**
 * rail-tasks — what the picker's left rail offers, and why it differs per file.
 *
 * The rail used to be "the curation tools", shown exactly where curation was
 * possible. That made it disappear at the EPUB station — which is precisely
 * where the book's own passes now live (Owen, 2026-08-04: "lets move
 * translate/simplify/footnotes to a left side nav just like the select/edit
 * modes were when in a pdf").
 *
 * So the rule changed, and this module is the whole of it:
 *
 *  - **The rail's CONTENTS are a fact about the ARTIFACT on screen.** The source
 *    (the archive original and its working copy — the same pages, painted or
 *    not) offers the curation modes and their tasks. The book offers the text
 *    passes that rewrite it. `ViewedArtifact` is already the measured answer to
 *    "which file is in the viewer" (shared/document/stations.ts), so the table
 *    below is keyed by it and by nothing else.
 *  - **Whether an entry is ALLOWED is a separate question**, answered by the
 *    picker with its own sentence per entry (curation is refused on the archive
 *    of a cast book, and on a book that is still opening). The two must not be
 *    conflated again: hiding the rail answered the second question by deleting
 *    the first, which is how the passes ended up with nowhere to live.
 *
 * The task ids are DERIVED from the table, so a new entry is a compile error at
 * every site that switches on one (see `deriveTaskStatus`'s `assertNever` in
 * the picker's task.model.ts). Phase D's fourth EPUB entry (`ocr-correct
 * --epub`) is one line here plus the sites the compiler then names.
 */

import type { ViewedArtifact } from './stations';
import { latestPassByKind, type PassRecord } from './version-family';

/** One labelled group of rail entries. */
export interface RailGroup {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly string[];
}

/**
 * The rail, per artifact, in rail order.
 *
 * `source` is unchanged from the rail as it stood: the modes first (the rail IS
 * the mode switcher, so there is no second control that can disagree with it),
 * then the tasks. `book` is the EPUB station's passes, in the plan's preferred
 * order — correction → footnotes → simplify → translate, minus the correction
 * pass that does not exist yet (docs/PIPELINE_V2_PLAN.md, "Stations and their
 * actions"). That order is a default and not a gate: any is runnable whenever
 * there is a book.
 */
export const ARTIFACT_RAIL_GROUPS = {
  source: [
    { id: 'modes', label: 'Mode', tasks: ['select', 'crop'] },
    { id: 'setup', label: 'Setup', tasks: ['ocr'] },
    { id: 'cleanup', label: 'Clean up', tasks: ['merge'] },
  ],
  book: [
    { id: 'passes', label: 'Text passes', tasks: ['footnotes', 'simplify', 'translate'] },
  ],
} as const satisfies Record<ViewedArtifact, readonly RailGroup[]>;

type ArtifactRailGroups = typeof ARTIFACT_RAIL_GROUPS;

/** Every rail entry there is — derived from the table, never listed twice. */
export type RailTaskId =
  ArtifactRailGroups[keyof ArtifactRailGroups][number]['tasks'][number];

/** The entries that rewrite the BOOK. Derived, so the table stays the authority. */
export type EpubPassTaskId = ArtifactRailGroups['book'][number]['tasks'][number];

/**
 * The entries that run a pass over the book, in rail order — the table's `book`
 * rail, read at runtime so a pass added there joins this set by construction.
 */
export const EPUB_PASS_TASK_IDS: readonly EpubPassTaskId[] =
  ARTIFACT_RAIL_GROUPS.book.flatMap((g) => [...g.tasks]);

/** Human, sentence-case labels shown in the rail. */
export const RAIL_TASK_LABELS: Record<RailTaskId, string> = {
  select: 'Select',
  crop: 'Crop',
  ocr: 'OCR text',
  merge: 'Merge blocks',
  footnotes: 'Remove footnotes',
  simplify: 'Simplify',
  translate: 'Translate',
};

/** The rail the artifact on screen gets. */
export function railGroupsForArtifact(artifact: ViewedArtifact): readonly RailGroup[] {
  return ARTIFACT_RAIL_GROUPS[artifact];
}

/** The entries that artifact's rail shows, in rail order. */
export function railTaskIdsFor(artifact: ViewedArtifact): readonly RailTaskId[] {
  return railGroupsForArtifact(artifact).flatMap((g) => [...g.tasks]) as RailTaskId[];
}

/**
 * Every entry across every artifact, in rail order, source first.
 *
 * For the loops that must consider all of them — the disabled-reason map, the
 * pre-export summary — rather than for anything that renders a rail.
 */
export const ALL_RAIL_TASK_IDS: readonly RailTaskId[] = [
  ...new Set<RailTaskId>([...railTaskIdsFor('source'), ...railTaskIdsFor('book')]),
];

/**
 * Entries that keep a LETTER binding. Rebinding them to digits would cost
 * existing muscle memory to buy nothing.
 */
const LETTER_TASKS: Readonly<Partial<Record<RailTaskId, string>>> = {
  select: 'S',
};

/**
 * The key hints for the rail that is actually on screen.
 *
 * Per artifact, deliberately: the digits run over the rows the user can SEE, so
 * 1 is always the first digit-bound row in front of them and a digit can never
 * activate an entry that is not there. A global numbering gave the book's rail
 * the hints 4, 5, 6 with no 1, 2, 3 anywhere on it.
 */
export function railShortcutsFor(
  artifact: ViewedArtifact
): Readonly<Partial<Record<RailTaskId, string>>> {
  const out: Partial<Record<RailTaskId, string>> = {};
  const digits = railDigitTasksFor(artifact);
  if (digits.length > 9) {
    throw new Error(
      `The ${artifact} rail has ${digits.length} entries wanting a digit key and there are only `
      + 'nine. Give one of them a letter binding (LETTER_TASKS) before adding another.'
    );
  }
  for (const id of railTaskIdsFor(artifact)) {
    const letter = LETTER_TASKS[id];
    if (letter) out[id] = letter;
  }
  digits.forEach((id, i) => { out[id] = String(i + 1); });
  return out;
}

/** The digit-bound entries of one rail, in rail order. */
function railDigitTasksFor(artifact: ViewedArtifact): readonly RailTaskId[] {
  return railTaskIdsFor(artifact).filter((id) => !(id in LETTER_TASKS));
}

/** The entry a digit activates on the rail that is on screen, or undefined. */
export function railTaskForDigit(
  artifact: ViewedArtifact,
  digit: number
): RailTaskId | undefined {
  return railDigitTasksFor(artifact)[digit - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Statuses
// ─────────────────────────────────────────────────────────────────────────────

export type RailTaskStatusKind = 'done' | 'suggested' | 'untouched' | 'required-missing';

export interface RailTaskStatus {
  readonly kind: RailTaskStatusKind;
  /** Factual, non-judgmental detail line, e.g. "applied to 12 pages", "not run". */
  readonly detail: string;
}

/**
 * Which recorded pass kind each EPUB entry IS.
 *
 * Written out rather than assumed from the id: the ids are the rail's and the
 * kinds are the manifest's (`AppliedPassKind`), and they happen to spell the
 * same today. A silent rename on either side would otherwise light the wrong
 * status.
 */
const PASS_KIND_OF: Record<EpubPassTaskId, string> = {
  footnotes: 'footnotes',
  simplify: 'simplify',
  translate: 'translate',
};

/**
 * The day a pass ran, as the local calendar has it, or null when the record
 * carries no readable timestamp.
 *
 * Null is a real state and not a missing value standing in for one: a manifest
 * is a file that outlives the build that wrote it, and a record whose `at` this
 * app cannot read is still proof the pass RAN — which is the part the status is
 * about.
 */
function recordedDay(at: string): string | null {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Whether this pass has been applied to the book on screen, from the book's own
 * provenance.
 *
 * `latestPassByKind` is the ONE implementation of latest-wins (the versions
 * page's stars and the provenance badges read it too), so a book footnoted
 * twice reads here exactly as it reads there.
 *
 * `passes` is `manifest.outputs.epub.appliedPasses`, verbatim. An empty list is
 * a real value — a freshly built book has had nothing done to it — and says
 * "not run" rather than nothing at all.
 */
export function derivePassStatus(
  id: EpubPassTaskId,
  passes: readonly PassRecord[]
): RailTaskStatus {
  const record = latestPassByKind(passes).get(PASS_KIND_OF[id]);
  if (!record) return { kind: 'untouched', detail: 'not run' };
  const day = recordedDay(record.latest.at);
  const when = day ? ` ${day}` : '';
  return {
    kind: 'done',
    detail: record.count === 1
      ? `applied${when}`
      : `applied ${record.count} times, last${when}`,
  };
}
