/**
 * version-family — what a book HAS, arranged as one family, with its stars.
 *
 * The versions page used to be five independent lists that each happened to
 * produce rows. Pipeline V2 (docs/PIPELINE_V2_PLAN.md, "Versions page") makes it
 * one family: the archive original is the parent, and the working copy and the
 * book EPUB are its children. This module is the whole of that arrangement, and
 * it is pure so the renderer cannot grow a second, subtly different copy of it.
 *
 * Three rules it exists to enforce:
 *
 *  - **Everything is DERIVED.** A row exists because a file exists; a star is lit
 *    because a boundary or a pass is recorded. Nothing here is remembered by the
 *    UI, and there is no state that can disagree with the disk.
 *  - **A pass is not a version.** Footnote removal, simplify and translate mint
 *    no row — they are stars on the book they edited. The pass-shaped rows the
 *    versions page used to emit are gone, and this module is why there is
 *    nowhere for them to come back.
 *  - **The archive can never earn a star.** archive/ is never written to
 *    (docs/DOCUMENT_PIPELINE.md), so no stage has ever landed on it. That is
 *    enforced by construction below: the archive branch reads neither the
 *    boundaries nor the passes, so no input can light one.
 */

/** The six things a book can have had done to it, in ladder order. */
export type VersionStar =
  | 'cast'
  | 'detect'
  | 'corrected'
  | 'footnotes'
  | 'simplified'
  | 'translated';

export const VERSION_STARS: readonly VersionStar[] = [
  'cast', 'detect', 'corrected', 'footnotes', 'simplified', 'translated',
];

/** What each star is called in front of the user. */
export const STAR_LABELS: Record<VersionStar, string> = {
  cast: 'Cast',
  detect: 'Detect',
  corrected: 'Corrected',
  footnotes: 'Footnotes',
  simplified: 'Simplified',
  translated: 'Translated',
};

/** What a lit star MEANS — the sentence its tooltip carries. */
export const STAR_MEANINGS: Record<VersionStar, string> = {
  cast: 'The words of the original are in this copy — you can select and search them.',
  detect: 'Every block on every page has been found and labelled.',
  corrected: 'OCR mistakes in the book have been corrected.',
  footnotes: 'Footnote markers have been removed from the book.',
  simplified: 'The book has been rewritten in simpler language.',
  translated: 'The book has been translated.',
};

/**
 * Which applied-pass kind lights which star.
 *
 * Only the EPUB passes are here. Cast and Detect are deliberately absent: they
 * are read from the BINDING's measured boundaries, not from the manifest's
 * record of what ran, because the working document is the authority on what has
 * landed in it. A book whose manifest remembers a `get-text` pass whose working
 * copy has since been reset must not show a Cast star.
 */
const PASS_STARS: Record<string, VersionStar> = {
  // The retired kind is the only one that has ever recorded a correction pass;
  // `ocr-correct --epub` (Phase D) records the same kind.
  'ocr-correction': 'corrected',
  footnotes: 'footnotes',
  simplify: 'simplified',
  translate: 'translated',
};

/** Which recorded stage boundary lights which star. */
const BOUNDARY_STARS: Record<string, VersionStar> = {
  'get-text': 'cast',
  blocks: 'detect',
};

export type FamilyRowKind = 'archive' | 'working' | 'epub';

/**
 * The stars a row of this kind CAN earn — its columns, lit or not.
 *
 * Kept apart from which are lit so a row never shows a star it could not
 * possibly get: an unlit "Simplified" beside the working copy would read as
 * work not done yet, when simplifying a working PDF is not a thing that exists.
 * The archive's empty list is the same construction as `starsFor` — it has no
 * columns, so it has nothing to light.
 */
export function starSlotsFor(kind: FamilyRowKind): VersionStar[] {
  switch (kind) {
    case 'archive':
      return [];
    case 'working':
      return VERSION_STARS.filter((s) => Object.values(BOUNDARY_STARS).includes(s));
    case 'epub':
      return VERSION_STARS.filter((s) => Object.values(PASS_STARS).includes(s));
  }
}

/** One recorded pass, as much of it as this module needs. */
export interface PassRecord {
  readonly kind: string;
  readonly at: string;
}

/**
 * What the files and the records say about one book. Every field is a
 * measurement or a recording — there is no field here a UI could set.
 */
export interface VersionFamilyInput {
  /**
   * The archive original, when the project has one ON DISK. Null is a real
   * state: a project whose original has been moved away still has a working
   * copy and a book, and they are shown without a parent rather than hidden
   * under one that is not there.
   */
  readonly archive: { readonly id: string } | null;
  /**
   * The working copy. Present only when the binding record AND the file are
   * both there — a record without a file describes a document that is gone, and
   * a file without a record belongs to bytes nothing can vouch for.
   */
  readonly working: {
    readonly id: string;
    /** The binding's recorded stage boundaries, in pipeline order. */
    readonly boundaries: readonly { readonly stage: string; readonly finishedAt: string }[];
    /**
     * The working document's own mtime — the measurement of when it was last
     * curated, because curation lands as an append to this file and nothing
     * records the individual edits.
     */
    readonly modifiedAt: string | null;
  } | null;
  /** The book, when it is on disk. */
  readonly epub: {
    readonly id: string;
    /**
     * `binding.epub.writtenAt` — when REFLOW wrote this book.
     *
     * NOT the file's mtime and NOT `outputs.epub.modifiedAt`: a footnote pass
     * rewrites the book in place and moves both, which would clear a staleness
     * warning that is still true. Null when no build was recorded, and then
     * nothing is claimed about staleness at all.
     */
    readonly builtAt: string | null;
  } | null;
  /** `manifest.outputs.epub.appliedPasses`, verbatim, in execution order. */
  readonly appliedPasses: readonly PassRecord[];
}

export interface VersionFamilyRow {
  readonly id: string;
  readonly kind: FamilyRowKind;
  /** 0 for the parent, 1 for a child indented under it. */
  readonly depth: 0 | 1;
  readonly stars: readonly VersionStar[];
  /**
   * Set only on the EPUB row, and only when it can be PROVED from what is on
   * disk. The sentence deliberately does not count the edits: nothing records
   * them individually (curation is an append to the working document), so a
   * number here would be invented. See docs/PIPELINE_V2_PLAN.md.
   */
  readonly staleness: string | null;
}

/**
 * The last run of each kind, and how many times that kind ran.
 *
 * The one implementation of latest-wins. The provenance badges and the stars
 * both read it, because a book that was footnoted twice is footnoted once as
 * far as its current state is concerned — and two answers to "which run
 * describes this book" is how one panel comes to call one pass two things.
 */
export function latestPassByKind<T extends PassRecord>(
  passes: readonly T[]
): Map<string, { latest: T; count: number }> {
  const byKind = new Map<string, { latest: T; count: number }>();
  for (const pass of passes) {
    const seen = byKind.get(pass.kind);
    // Execution order, so the last one seen is the one that describes the book.
    byKind.set(pass.kind, { latest: pass, count: seen ? seen.count + 1 : 1 });
  }
  return byKind;
}

/**
 * The stars a row has earned.
 *
 * The archive branch is the construction that makes "the archive can never earn
 * a star" true rather than merely intended: it reads neither `boundaries` nor
 * `appliedPasses`, so there is no input that could light one.
 */
export function starsFor(kind: FamilyRowKind, input: VersionFamilyInput): VersionStar[] {
  switch (kind) {
    case 'archive':
      return [];
    case 'working': {
      const working = input.working;
      if (!working) return [];
      const lit = new Set<VersionStar>();
      for (const boundary of working.boundaries) {
        const star = BOUNDARY_STARS[boundary.stage];
        if (star) lit.add(star);
      }
      return VERSION_STARS.filter((s) => lit.has(s));
    }
    case 'epub': {
      if (!input.epub) return [];
      const latest = latestPassByKind(input.appliedPasses);
      const lit = new Set<VersionStar>();
      for (const kindRan of latest.keys()) {
        const star = PASS_STARS[kindRan];
        if (star) lit.add(star);
      }
      return VERSION_STARS.filter((s) => lit.has(s));
    }
  }
}

/**
 * Whether the book was built before the working copy's latest edits, said in
 * the weakest form that is TRUE.
 *
 * "built before your last N edits" is what the plan asks for and what cannot be
 * honestly produced: curation lands as one append per batch and nothing on disk
 * records how many edits went into it, so N would be a number nobody measured.
 * The comparison itself IS measured — the working document's mtime against the
 * build time the binding recorded — so the sentence says that and stops.
 *
 * Both sides must be known. An unrecorded build time means the book predates
 * the binding recording one, and inventing a comparison against the EPUB's own
 * mtime would read a footnote pass (which rewrites the book in place) as
 * "rebuilt", clearing a warning that is still true.
 */
export function epubStaleness(input: VersionFamilyInput): string | null {
  const { epub, working } = input;
  if (!epub || !working) return null;
  if (!epub.builtAt || !working.modifiedAt) return null;
  const built = Date.parse(epub.builtAt);
  const curated = Date.parse(working.modifiedAt);
  if (!Number.isFinite(built) || !Number.isFinite(curated)) return null;
  if (curated <= built) return null;
  return 'Built before your latest edits to the working copy — rebuild to include them.';
}

/**
 * The family, parent first.
 *
 * The children are indented only when there IS a parent on disk. A working copy
 * shown one level in under nothing would read as belonging to the row above it,
 * whatever that row happened to be.
 */
export function versionFamily(input: VersionFamilyInput): VersionFamilyRow[] {
  const rows: VersionFamilyRow[] = [];
  const childDepth: 0 | 1 = input.archive ? 1 : 0;

  if (input.archive) {
    rows.push({
      id: input.archive.id,
      kind: 'archive',
      depth: 0,
      stars: starsFor('archive', input),
      staleness: null,
    });
  }
  if (input.working) {
    rows.push({
      id: input.working.id,
      kind: 'working',
      depth: childDepth,
      stars: starsFor('working', input),
      staleness: null,
    });
  }
  if (input.epub) {
    rows.push({
      id: input.epub.id,
      kind: 'epub',
      depth: childDepth,
      stars: starsFor('epub', input),
      staleness: epubStaleness(input),
    });
  }
  return rows;
}
