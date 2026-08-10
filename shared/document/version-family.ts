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

/**
 * The two things a book can have had done to it, in ladder order.
 *
 * Four stars went in Aug 2026, and all four for the same reason: nothing runs
 * that would light them. **Cast** and **Detect** were read off the working
 * copy's recorded stage boundaries, and a working copy is a plain copy with a
 * marker now — no stage writes a boundary, so those two columns could only ever
 * be empty. **Corrected** and **Footnotes** were EPUB passes that no longer
 * exist: OCR repair went with the Tesseract pipeline, and footnote references
 * come out as the narration copy is written, which edits no book.
 *
 * A book that HAS one of those in its provenance keeps it — the record is
 * history and history is not rewritten. It simply reaches the versions page as
 * a provenance badge (with its diff still reviewable) rather than as a star,
 * which follows by construction from `starForPassKind` answering null.
 */
export type VersionStar =
  | 'simplified'
  | 'translated';

export const VERSION_STARS: readonly VersionStar[] = ['simplified', 'translated'];

/** What each star is called in front of the user. */
export const STAR_LABELS: Record<VersionStar, string> = {
  simplified: 'Simplified',
  translated: 'Translated',
};

/** What a lit star MEANS — the sentence its tooltip carries. */
export const STAR_MEANINGS: Record<VersionStar, string> = {
  simplified: 'The book has been rewritten in simpler language.',
  translated: 'The book has been translated.',
};

/**
 * Which applied-pass kind lights which star.
 *
 * The two EPUB passes, and nothing else. A kind absent from here is not an
 * omission: it is a pass that no longer runs, or one that PRODUCED the book
 * rather than transforming it, and neither has a column on the EPUB row.
 */
export const PASS_STARS: Record<string, VersionStar> = {
  simplify: 'simplified',
  translate: 'translated',
};

/**
 * The star a pass kind lights, or null when it lights none.
 *
 * Null is a real answer and it is load-bearing. `vlm-convert`, `get-text`,
 * `blocks` and `reflow` are recorded against the book as the passes that
 * PRODUCED it; `ocr-correction`, `footnotes`, `tesseract` and `detection`
 * belong to books processed before Aug 2026. None has a star, and answering
 * null here is exactly what hands them to the provenance badges instead — so a
 * historical book keeps its history and its reviewable diffs without a column
 * that can never light for anything made today.
 *
 * This is exported because the star is the way IN to a pass's diff (Owen, third
 * session: a diff "should be linked to the file it was applied to"), and the
 * provenance badges have to know which kinds the stars are already carrying so
 * the two do not both offer the same review.
 */
export function starForPassKind(kind: string): VersionStar | null {
  return PASS_STARS[kind] ?? null;
}

export type FamilyRowKind = 'archive' | 'generated' | 'working' | 'epub';

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
    // The generated book earns none for the same reason the archive does not:
    // it is archive-grade, nothing may write to it, so no pass has ever landed
    // on it. Every pass runs on the working copy minted FROM it.
    case 'generated':
    // The working copy earns none either, and that is a fact about what runs
    // rather than a gap: curation is a person editing a file, and there is no
    // stage over it whose completion a star could report.
    case 'working':
      return [];
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
   * The book cast from the archive PDF's pages, when the project has one ON
   * DISK. Null for an EPUB-native project — nothing generated a book, because
   * the user handed us one — and null for a PDF nobody has converted.
   */
  readonly generated: { readonly id: string } | null;
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
  readonly epub: { readonly id: string } | null;
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
   * Always null, and declared so the row shape does not change under a consumer
   * if something provable turns up again.
   *
   * It used to say "built before your latest edits — rebuild to include them",
   * measured from `binding.epub.writtenAt` against the working copy's mtime.
   * Nothing writes that field any more (the reflow stage that did is gone), so
   * the comparison had exactly one input and could never fire. A warning that
   * cannot fire is worse than none: it reads as proof there is nothing to warn
   * about.
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
    // Same construction and the same guarantee as the archive's: this branch
    // reads no input at all, so nothing can light a star on a file nothing
    // writes to.
    case 'generated':
      return [];
    // Same construction, same guarantee: the working branch reads neither the
    // boundaries nor the passes, so no input can light a star on it.
    case 'working':
      return [];
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
 * The family, parent first.
 *
 * The children are indented only when there IS a parent on disk. A working copy
 * shown one level in under nothing would read as belonging to the row above it,
 * whatever that row happened to be.
 *
 * The ladder is archive → generated → working → book, and it is the derivation
 * order too: the archive PDF's pages are cast into the generated book, and the
 * book the user edits is a byte copy of that. The generated row is a CHILD of
 * the archive rather than a second parent, because it is derived from it —
 * everything below the archive is.
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
  if (input.generated) {
    rows.push({
      id: input.generated.id,
      kind: 'generated',
      depth: childDepth,
      stars: starsFor('generated', input),
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
      staleness: null,
    });
  }
  return rows;
}

/**
 * Why this book cannot be narrated, or null when it can.
 *
 * The versions page's per-row **Process** button and the picker's "Next →
 * Narration" both ask this, and they must get the SAME sentence: one lock
 * explained two ways is two locks as far as the user is concerned.
 *
 * The input is narrowed to the one fact the question turns on, and that
 * narrowing is exact rather than partial: narration takes the book and nothing
 * else (e2a accepts nothing but an EPUB), so a caller that knows whether the
 * book exists knows everything this needs. Lives here because the family is
 * where "does this project have a book" is already measured, from
 * `manifestService.readExportEpub` having found one on disk.
 */
export function narrationRefusal(book: { readonly bookEpubExists: boolean }): string | null {
  return book.bookEpubExists
    ? null
    : 'Narration reads the book, and this project does not have one yet — convert its PDF to an '
      + 'EPUB from this page first.';
}
