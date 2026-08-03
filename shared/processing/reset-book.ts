/**
 * Starting a book over — what "all processing state" IS, said once.
 *
 * A project accumulates processing state in four places: a machine-local foundry
 * run directory, numbered pass stage directories inside the project, the
 * exported book EPUB with its `appliedPasses` provenance, and the per-source
 * records the editor writes against a particular scan. "Start over" returns the
 * project to the state it had the moment it was imported — source document,
 * metadata and cover intact, everything derived from them gone — so the next run
 * rebuilds from the pages rather than on top of half a previous attempt.
 *
 * The types are here (one declaration, three programs: main, preload, renderer)
 * and so is the ONE piece of logic that has to be exactly right and is worth
 * testing on its own: which directories under `stages/` belong to a pass.
 */

/**
 * The pass kinds that name a stage directory — `manifest-service.passStageRelDir`
 * builds `stages/NN-<kind>` out of exactly these.
 *
 * `tesseract` is in the list because it is still a provenance KIND (see
 * docs/PROCESSING_PIPELINE_V2.md); it is not a job, but a directory named after
 * it could only have been made by this pipeline.
 */
export const PASS_STAGE_KINDS: readonly string[] = [
  'tesseract',
  'ocr-correction',
  'footnotes',
  'simplify',
  'translate',
];

/**
 * Stage directories that are NOT pass directories, protected by exact name.
 *
 * These belong to the language-learning pipeline and the TTS/analysis caches:
 * `01-cleanup` holds `cleaned.epub` / `simplified.epub`, `02-translate` holds the
 * per-language books (`de.epub`, `ko.epub`) which are genuinely different books,
 * `03-tts` is the sentence-audio cache that costs hours to rebuild, and
 * `04-analysis` is the Insights report. None of them is produced by a pass and
 * none is rebuilt by re-running one.
 *
 * ── THE COLLISION THIS EXISTS FOR ────────────────────────────────────────────
 *
 * `passStageRelDir(2, 'translate')` is the string `stages/02-translate` — the
 * SAME name the LL pipeline has always used for its per-language books. A
 * translate pass that happens to land at position 2 in a project that also went
 * through the LL pipeline would share a directory with it. The name wins:
 * deleting `02-translate` on the strength of a matching suffix would take real
 * books with it, and a stage directory that survives a reset costs the user one
 * re-run of a pass that writes into it anyway.
 */
export const RESERVED_STAGE_DIRS: readonly string[] = [
  '01-cleanup',
  '02-translate',
  '03-tts',
  '04-analysis',
];

/**
 * Is this directory name (a single component under `stages/`) a pass's working
 * space?
 *
 * Matched by SHAPE — `NN-<pass kind>` — and not by "everything in stages/",
 * because `stages/` is shared with the LL pipeline and the TTS cache. A reserved
 * name is never a pass directory regardless of its suffix.
 */
export function isPassStageDirName(name: string): boolean {
  if (RESERVED_STAGE_DIRS.includes(name)) return false;
  const match = /^(\d{2,})-(.+)$/.exec(name);
  if (!match) return false;
  return PASS_STAGE_KINDS.includes(match[2]);
}

/** The pass stage directories among a `stages/` listing, in listing order. */
export function selectPassStageDirs(names: readonly string[]): string[] {
  return names.filter(isPassStageDirName);
}

/**
 * One thing a reset removes — or would remove, or found nothing of.
 *
 * `present: false` is reported rather than dropped: a run directory is
 * machine-local, so a book scanned on the desktop and opened on the laptop has
 * none here, and "not present" is a different statement from "deleted".
 */
export interface BookResetItem {
  kind: 'run-dir' | 'stage-dir' | 'book-epub' | 'provenance' | 'source-records';
  /** One line for the confirmation dialog and the result. */
  label: string;
  /** Absolute path for a file or directory; absent for a manifest record. */
  path?: string;
  present: boolean;
  removed: boolean;
}

export interface BookResetSummary {
  projectDir: string;
  /** True when nothing was written — this is the answer to "what would happen?". */
  preview: boolean;
  items: BookResetItem[];
  /** True when the project carries no processing state at all. */
  empty: boolean;
}

/** The items that are actually there, i.e. what a reset has to do. */
export function presentResetItems(summary: BookResetSummary): BookResetItem[] {
  return summary.items.filter((i) => i.present);
}
