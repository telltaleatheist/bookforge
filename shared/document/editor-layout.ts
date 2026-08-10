/**
 * editor-layout — which LAYOUT of a book the picker's page and block records
 * were made against, said out loud so a later build can tell.
 *
 * ── The failure this exists to end ──────────────────────────────────────────
 *
 * The picker's edit set is written down in two vocabularies that are both
 * functions of a LAYOUT rather than of the book: `source.deletedPages` is a page
 * number, and `source.deletedBlockIds` names blocks by an md5 of where they were
 * drawn. Until Aug 2026 an EPUB was laid out by mupdf, which rasterizes a reflow
 * of it at 600×900×18; since quire it is paginated from the book's own DOM, and
 * the two disagree about everything a record like that is made of. Measured on
 * *Killing America*: mupdf 218 pages, quire 183. Same book, same bytes.
 *
 * A page number survives that change as a NUMBER and dies as a MEANING. Page 140
 * exists in both layouts and holds different words in each, so a saved project
 * replayed against the new pagination would strike out real paragraphs the user
 * never touched — silently, in a book they would have no reason to re-read. That
 * is the one outcome this module exists to make impossible.
 *
 * Block ids fail more kindly and just as wrongly: `md5("<page>:<idx>:<text>")`
 * and `md5("quire:<element key>:<page>")` are disjoint sets, so every old id
 * names nothing at all and every deletion the user made quietly does nothing.
 *
 * ── Why an identity and not a version number ────────────────────────────────
 *
 * Because "which layout" is three independent facts and any one of them moving
 * invalidates a record: WHO laid the book out (mupdf, quire), WHICH fragmenter
 * and version did the work (`pagedjs-0.4.3`), and WHAT BOX it was laid into
 * (600×900 at 18px). `quire-page-map.ts` already refuses a cached page map whose
 * strategy or geometry differs from what was asked for, and this is the same
 * refusal moved up a level — from "may I reuse this map" to "may I believe this
 * user's edits".
 *
 * ── ABSENCE is the legacy answer ────────────────────────────────────────────
 *
 * No manifest written before Aug 2026 carries this stamp, and the records those
 * manifests hold are mupdf's — so on an EPUB project, an ABSENT identity beside
 * page or block records means exactly one thing, and it is not "unknown". It is
 * the mupdf era. Same shape of argument as `narrationDeletionsStaleReason`,
 * which reads a book whose sha has moved as a void record rather than a puzzle.
 *
 * A PDF project is never any of this. mupdf's pagination of a PDF is the PDF's
 * own pages and has not changed; the cutover was for EPUBs alone. Every reader
 * here is therefore gated on the source being an EPUB, and a PDF project is
 * `not-an-epub` — not "current", which would be a claim, but "not a question
 * that applies".
 */

/** Where the identity lives on disk: `manifest.source.editorLayout`. */
export const EDITOR_LAYOUT_MANIFEST_KEY = 'editorLayout';

/** The two things that have ever laid a book out for the picker. */
export type EditorLayoutEngine = 'mupdf' | 'quire';

/**
 * The layout a set of page-keyed or block-keyed records was made against.
 *
 * Geometry is FLAT rather than nested so that comparing two identities is
 * comparing five scalars — the same five `pageMapPath` spells into a filename,
 * for the same reason: a layout is only the same layout if every one of them is.
 */
export interface EditorLayoutIdentity {
  engine: EditorLayoutEngine;
  /** The fragmenter, version included — `pagedjs-0.4.3`. */
  strategy: string;
  /** The stamping/map version the block ids were minted under. */
  version: number;
  /** The page box, in CSS pixels, and the root font size it was laid out at. */
  width: number;
  height: number;
  fontSize: number;
  /** ISO timestamp of the save that stamped it. Never compared. */
  recordedAt: string;
}

/**
 * Two identities describe the same layout.
 *
 * `recordedAt` is deliberately not read: it says WHEN a record was stamped, not
 * what it was stamped against, and two saves a month apart in one build describe
 * one layout.
 */
export function sameEditorLayout(
  a: EditorLayoutIdentity | null | undefined,
  b: EditorLayoutIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.engine === b.engine
    && a.strategy === b.strategy
    && a.version === b.version
    && a.width === b.width
    && a.height === b.height
    && a.fontSize === b.fontSize;
}

/** A layout in one phrase, for a sentence a user reads. */
export function describeEditorLayout(layout: EditorLayoutIdentity | null | undefined): string {
  if (!layout) {
    return 'mupdf\'s reflow of the book at 600×900×18 (the layout this app used for EPUBs before '
      + 'August 2026, which recorded no identity of its own)';
  }
  return `${layout.engine}/${layout.strategy} at `
    + `${layout.width}×${layout.height}×${layout.fontSize}`;
}

/**
 * What a project's stamp says about whether its page and block records may be
 * believed.
 *
 *  - `not-an-epub` — the question does not apply. A PDF's pagination is the
 *    PDF's own pages and did not change.
 *  - `current` — stamped, and the stamp is this build's layout.
 *  - `clean` — an EPUB with no stamp and no page- or block-keyed records. There
 *    is nothing to disbelieve; the next save stamps it.
 *  - `legacy` — an EPUB with records and NO stamp: mupdf's, by the argument in
 *    this file's header.
 *  - `foreign` — an EPUB stamped with a layout that is not this one. A future
 *    geometry or fragmenter change lands here, and lands loudly.
 */
export type EditorLayoutStatus = 'not-an-epub' | 'current' | 'clean' | 'legacy' | 'foreign';

/**
 * Whether this project's page and block records may be believed, from the three
 * facts that decide it: what the project was made from, what its stamp says, and
 * whether it holds any such record at all.
 *
 * `hasLayoutKeyedRecords` is asked LAST and only of an unstamped EPUB, because
 * it is the difference between "made before the stamp existed and has work in
 * it" and "made before the stamp existed and is empty". The second is not a
 * problem to report, it is a project nobody has edited.
 */
export function editorLayoutStatus(
  sourceType: string,
  recorded: EditorLayoutIdentity | null | undefined,
  current: EditorLayoutIdentity,
  hasLayoutKeyedRecords: boolean,
): EditorLayoutStatus {
  if (sourceType !== 'epub') return 'not-an-epub';
  if (recorded) return sameEditorLayout(recorded, current) ? 'current' : 'foreign';
  return hasLayoutKeyedRecords ? 'legacy' : 'clean';
}

/**
 * How many records of each class a project carries that only a layout can
 * explain.
 *
 * Counted rather than sampled because the refusal names the numbers: "157 page
 * deletions and 228 block deletions" is a sentence a user can weigh against
 * their memory of the evening they spent making them, and "some deletions" is
 * not.
 */
export interface LayoutKeyedRecordCensus {
  /** `source.deletedPages` — page numbers of the layout. */
  deletedPages: number;
  /** `source.deletedBlockIds` — md5s of where blocks were drawn. */
  deletedBlockIds: number;
  /** `source.pageOrder` — a permutation of the layout's page count. */
  pageOrder: number;
  /** `editor.undoStack` — actions carrying block ids and page numbers. */
  undoStack: number;
  /** `editor.redoStack` — the same. */
  redoStack: number;
  /** `manifest.chapters` entries carrying a `page` (the picker's Chapter). */
  chaptersWithPage: number;
  /**
   * Everything under `editor` keyed by block id, by field name and size —
   * `blockEdits`, `categoryCorrections`, `blockSplits`, `blockMerges`,
   * `ocrBlocks`, `manualBlocks`, `paragraphBreaks`, `textCorrections`,
   * `customCategories`, and whatever the editor grows next.
   *
   * A LIST rather than named fields because the set has drifted before and will
   * again: main's reset handler already clears the editor state wholesale
   * rather than by name, for exactly that reason, and a census that hard-coded
   * the field list would go quietly incomplete the same way.
   */
  blockKeyedEditorFields: Array<{ field: string; count: number }>;
}

/**
 * The editor-state fields whose contents are keyed by BLOCK ID or by PAGE,
 * and therefore mean nothing in a layout that mints neither the same way.
 *
 * Measured against the 378 projects in the library, 2026-08-09, so this is a
 * list of shapes that exist rather than of shapes that might:
 *   blockEdits           `{ "<block id>": { text } }`
 *   categoryCorrections  `[["<block id>", "<category>"], …]`
 *   learnedCategories    the same pairs, learned rather than hand-set
 *   paragraphBreaks      `["<block id>", …]`
 *   blockMerges          `[{ mergedBlockId, sourceBlockIds: ["<block id>"] }]`
 *   ocrBlocks            whole blocks, each with an id and a page
 *   customCategories     highlight rectangles, each on a page
 *
 * The rest of the editor state is NOT here and is deliberately left alone:
 * `ocrCategories` is keyed by CATEGORY id ("title", "caption"),
 * `classificationThresholds` is numbers, `sourceFileSha256` is a hash of the
 * file, and `rubricPredictions` is a record of an external rubric run keyed in
 * that run's own id space (`ocr_p4_0_7r8inz`) rather than in the picker's. None
 * of them names a position in a layout, so none of them goes stale when the
 * layout changes.
 */
export const LAYOUT_KEYED_EDITOR_FIELDS: readonly string[] = [
  'blockEdits',
  'blockMerges',
  'blockSplits',
  'categoryCorrections',
  'cropRegions',
  'customCategories',
  'learnedCategories',
  'manualBlocks',
  'ocrBlocks',
  'paragraphBreaks',
  'textCorrections',
];

/** How many things a persisted editor field holds, whatever shape it is. */
function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 1;
}

/**
 * Everything a project holds that only a layout can explain, counted.
 *
 * Takes the three raw manifest sub-objects rather than a `ProjectManifest`
 * because the manifest type is declared twice (once in the main process, once in
 * the renderer) and neither declaration admits all sixteen fields the picker's
 * save actually writes — so a census typed against either would count what the
 * type believes rather than what the file holds.
 */
export function censusLayoutKeyedRecords(
  source: Record<string, unknown> | null | undefined,
  editor: Record<string, unknown> | null | undefined,
  chapters: ReadonlyArray<Record<string, unknown>> | null | undefined,
): LayoutKeyedRecordCensus {
  const s = source ?? {};
  const e = editor ?? {};
  const blockKeyedEditorFields: Array<{ field: string; count: number }> = [];
  for (const field of LAYOUT_KEYED_EDITOR_FIELDS) {
    const n = sizeOf(e[field]);
    if (n > 0) blockKeyedEditorFields.push({ field, count: n });
  }
  return {
    deletedPages: sizeOf(s['deletedPages']),
    deletedBlockIds: sizeOf(s['deletedBlockIds']),
    pageOrder: sizeOf(s['pageOrder']),
    undoStack: sizeOf(e['undoStack']),
    redoStack: sizeOf(e['redoStack']),
    chaptersWithPage: (chapters ?? []).filter((c) => typeof c?.['page'] === 'number').length,
    blockKeyedEditorFields,
  };
}

export function layoutKeyedRecordTotal(census: LayoutKeyedRecordCensus): number {
  return census.deletedPages
    + census.deletedBlockIds
    + census.pageOrder
    + census.undoStack
    + census.redoStack
    + census.chaptersWithPage
    + census.blockKeyedEditorFields.reduce((n, f) => n + f.count, 0);
}

/** `n thing(s)`, the plural spelling this codebase uses everywhere. */
function count(n: number, noun: string): string {
  return `${n} ${noun}(s)`;
}

/**
 * What the user is told when a project's records were made against a layout this
 * build does not produce, and the migration could not carry them over.
 *
 * The shape is the one `describeWorkingCopyRemint` and the stale-sha refusal
 * use: say what was found, say why it cannot be used, say what happens next.
 * The last part is not optional — "these are stale" with no instruction is a
 * message that leaves the user holding a project they cannot reason about.
 */
export function describeStaleLayoutRecords(
  bookName: string,
  census: LayoutKeyedRecordCensus,
  recorded: EditorLayoutIdentity | null,
  current: EditorLayoutIdentity,
): string {
  const classes: string[] = [];
  if (census.deletedPages > 0) classes.push(count(census.deletedPages, 'deleted page'));
  if (census.deletedBlockIds > 0) classes.push(count(census.deletedBlockIds, 'deleted block'));
  if (census.pageOrder > 0) classes.push(`a reordering of ${census.pageOrder} page(s)`);
  if (census.undoStack > 0) classes.push(count(census.undoStack, 'undo step'));
  if (census.redoStack > 0) classes.push(count(census.redoStack, 'redo step'));
  if (census.chaptersWithPage > 0) {
    classes.push(count(census.chaptersWithPage, 'chapter marker placed on a page'));
  }
  for (const field of census.blockKeyedEditorFields) {
    classes.push(`${count(field.count, 'record')} under editor.${field.field}`);
  }

  const listed = classes.length === 0
    ? 'no records'
    : classes.length === 1
      ? classes[0]
      : `${classes.slice(0, -1).join(', ')} and ${classes[classes.length - 1]}`;

  return (
    `${bookName} carries ${listed} recorded against ${describeEditorLayout(recorded)}. This app now `
    + `lays EPUBs out with ${describeEditorLayout(current)}, which paginates the book's own markup `
    + 'and gives it a different number of pages and different block identities — so a page number '
    + 'or a block id from the old layout names something else here, or nothing at all. They are NOT '
    + 'applied: replaying them would strike out paragraphs you never touched.\n\n'
    + 'Open the book in the picker and strike out what you want left out of the narration again. '
    + 'The old records stay in the project until you next save it.'
  );
}

/**
 * What the user is told when the migration DID carry the deletions over.
 *
 * Said out loud rather than done quietly, because the numbers change: the same
 * intent expressed in a layout with fewer pages is a different count of pages
 * and a different count of blocks, and a user who deleted 157 pages and finds
 * 131 struck needs to be told that is the same book and not a loss.
 */
export function describeLayoutMigration(
  bookName: string,
  before: { deletedPages: number; deletedBlockIds: number },
  after: { deletedPages: number; deletedBlockIds: number; elements: number },
  recorded: EditorLayoutIdentity | null,
  current: EditorLayoutIdentity,
): string {
  return (
    `${bookName}: ${count(before.deletedPages, 'deleted page')} and `
    + `${count(before.deletedBlockIds, 'deleted block')} recorded against `
    + `${describeEditorLayout(recorded)} were re-read as ${count(after.elements, 'element')} of the `
    + `book's own markup and written back as ${count(after.deletedPages, 'deleted page')} and `
    + `${count(after.deletedBlockIds, 'deleted block')} of ${describeEditorLayout(current)}. The `
    + 'page and block counts differ because the two layouts break the book in different places; the '
    + 'text left out is the same text.'
  );
}
