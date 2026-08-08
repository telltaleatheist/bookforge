/**
 * rail-tasks — what the picker's left rail offers, and why it differs per file.
 *
 * The picker is ONE SCREEN (Owen, 2026-08-07). There is no station bar, no
 * bottom tabs and no archive → working → epub ladder to walk: **the file on
 * screen decides the tools**, and this module is the whole of that decision.
 *
 *  - **The rail's CONTENTS are a fact about the ARTIFACT on screen.** A PDF —
 *    the archive original or the working copy, the same pages either way —
 *    offers the curation modes and their tasks. An EPUB offers the passes that
 *    rewrite the book, and the narration copy cut from it. `ViewedArtifact` is
 *    the measured answer to "which kind of file is in the viewer", and it is
 *    measured from the file's own extension: a `.epub` is a book, anything else
 *    is a source document. Nothing else is consulted, because nothing else can
 *    change what a file IS.
 *  - **Whether an entry is ALLOWED is a separate question**, answered by the
 *    picker with its own sentence per entry (curation is refused on the archive
 *    original, and every pass is refused on a document with no project). The two
 *    must not be conflated: hiding the rail answered the second question by
 *    deleting the first, which is how the passes once ended up with nowhere to
 *    live.
 *
 * The task ids are DERIVED from the table, so a new entry is a compile error at
 * every site that switches on one (see `deriveTaskStatus`'s `assertNever` in
 * the picker's task.model.ts).
 */

import { samePath } from './same-path';
import { latestPassByKind, type PassRecord } from './version-family';

/**
 * What the file in the viewer IS.
 *
 * `source` is the document being curated — the project's archive PDF and the
 * working copy cast from it are the same PAGES, and the difference between them
 * is whether curation is allowed rather than what the rail carries. `book` is an
 * EPUB: the project's own book, or the original of a project that arrived as
 * one.
 */
export type ViewedArtifact = 'source' | 'book';

/**
 * Which artifact the viewer is showing — measured from the file's extension, and
 * nothing else.
 *
 * An EPUB is a book. There is no case in which the picker holds an EPUB that is
 * not one: a project's export, a project's EPUB original and a loose ebook are
 * all read the same way and offer the same tools. Everything else is a source
 * document.
 *
 * Empty is `source`, and that is not a fallback — a window with nothing loaded
 * renders no rail at all, and `source` is what it will be showing the instant it
 * does have a file, since a book is only ever reached by opening one.
 */
export function viewedArtifactOf(displayedPath: string): ViewedArtifact {
  return /\.epub$/i.test(displayedPath) ? 'book' : 'source';
}

/**
 * Is the PDF on screen the project's WORKING COPY — the file curation is
 * written into?
 *
 * The project record, not a filename pattern: main derives the working copy's
 * name from the original's and reports it on `document:state`, so a window that
 * matched `.working.pdf` itself would be a second derivation of a name that is
 * settled once. Null on either side means "not it" — a project with no working
 * copy, or a window with nothing open.
 */
export function viewingWorkingCopy(args: {
  readonly displayedPath: string;
  readonly workingPath: string | null;
}): boolean {
  const { displayedPath, workingPath } = args;
  if (displayedPath === '' || workingPath === null) return false;
  return samePath(displayedPath, workingPath);
}

/** One labelled group of rail entries. */
export interface RailGroup {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly string[];
}

/**
 * The book's text passes: the two runs that rewrite `outputs.epub` in place.
 *
 * Declared apart from the table so `EpubPassTaskId` can be derived from THIS and
 * not from "everything on the book's rail" — the narration copy sits beside them
 * and is not a pass. It writes a second file and records no provenance, so a
 * type that swept it in would demand a pass kind for it.
 */
const BOOK_PASS_GROUP = {
  id: 'passes',
  label: 'Text passes',
  tasks: ['simplify', 'translate'],
} as const;

/**
 * The rail, per artifact, in rail order.
 *
 * `source` is the pointer modes first (the rail IS the mode switcher, so there
 * is no second control that can disagree with it), then the tasks. The Setup/OCR
 * group is gone with the Tesseract pipeline it belonged to (Aug 2026): reading
 * the pages is `foundry vlm-convert`, which produces a BOOK and is started from
 * Studio's versions page rather than from a curation rail.
 *
 * "Export TTS copy" left this table on 2026-08-08 (Owen's call). The rail is a
 * checklist of work you do TO the book; writing the narration copy is what you
 * do WHEN YOU ARE DONE with it, and sitting it among the modes made the last
 * step of the flow look like another tool to try. It is now the primary action
 * in the bottom-right of the viewer, where a next/continue action goes, and the
 * picker owns it directly — so it is deliberately NOT a rail task id any more,
 * and nothing derives a status, a digit shortcut or a disabled-reason for it
 * through the rail.
 */
export const ARTIFACT_RAIL_GROUPS = {
  source: [
    { id: 'modes', label: 'Mode', tasks: ['select', 'crop'] },
    { id: 'cleanup', label: 'Clean up', tasks: ['merge'] },
  ],
  book: [
    BOOK_PASS_GROUP,
  ],
} as const satisfies Record<ViewedArtifact, readonly RailGroup[]>;

type ArtifactRailGroups = typeof ARTIFACT_RAIL_GROUPS;

/** Every rail entry there is — derived from the table, never listed twice. */
export type RailTaskId =
  ArtifactRailGroups[keyof ArtifactRailGroups][number]['tasks'][number];

/** The entries that run a PASS over the book. Derived from the pass group alone. */
export type EpubPassTaskId = typeof BOOK_PASS_GROUP['tasks'][number];

/** Those entries, in rail order. */
export const EPUB_PASS_TASK_IDS: readonly EpubPassTaskId[] = [...BOOK_PASS_GROUP.tasks];

/** Human, sentence-case labels shown in the rail. */
export const RAIL_TASK_LABELS: Record<RailTaskId, string> = {
  select: 'Select',
  crop: 'Crop',
  merge: 'Merge blocks',
  simplify: 'Simplify',
  translate: 'Translate',
};

/**
 * What the primary action at the bottom of the viewer is called.
 *
 * Here rather than in the picker because it is the same kind of fact as every
 * label above it — what a control is called — and the export dialog's title has
 * to say the same words as the button that opened it.
 */
export const NARRATION_EXPORT_LABEL = 'Export TTS copy';

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
 * page's stars and the provenance badges read it too), so a book simplified
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
