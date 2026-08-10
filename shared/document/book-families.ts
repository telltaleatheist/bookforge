/**
 * book-families — one working chain per archive-grade EPUB, and the rule that
 * says which chain a question is about.
 *
 * ── What Owen ratified (2026-08-10) ─────────────────────────────────────────
 *
 * "we'll change the architecture to make working chains per-archive-file. PDFs
 * have no working chain. only epubs. PDFs only exist to convert to epub. but i
 * do have different versions of books, and i want to be able to run adjustment
 * chains on different versions. tts copies will be nested under their respective
 * parent item, and if the user wants to process a specific TTS document then
 * they click the process button next to it. no ambiguity, no confusion."
 *
 * And, on why the parentage has to be in the data rather than in the layout:
 * "having the epub listed under documents instead of versions breaks the chain
 * of custody."
 *
 * ── The family IS the chain of custody, said as data ────────────────────────
 *
 * A family hangs off ONE archive-grade EPUB — the file the user handed us, or
 * the book a page reader cast from their PDF — and owns everything derived from
 * it: the working copy, that copy's ledger, its strikes, its book edits, and the
 * narration copy cut from it. `manifest.outputs.epub` used to hold exactly one
 * of those chains, which is why a project could only ever have one book; the
 * record has moved under the family that owns it, and a project may now carry
 * several side by side.
 *
 * A PDF is never a family source. It has no working chain of its own — it
 * reaches an editable book only by being cast into one, and THAT book (kind
 * `generated-epub`) is the family source. This is not a convention: nothing here
 * can classify a PDF as archive-grade EPUB, so the type makes it unsayable.
 *
 * ── Why the resolution rule is pure, and lives here ─────────────────────────
 *
 * Three kinds of caller have to agree about which family a question is about:
 * main's IPC handlers (which hold a project directory), the modules that already
 * hold a manifest they read themselves (electron/processing-chain.ts,
 * electron/vlm-convert.ts), and the renderer's batch scan over the whole library
 * (src/app/features/studio/services/studio.service.ts), which reads manifests
 * directly and never round-trips through IPC. Three derivations of "which book
 * is this" is how two surfaces come to act on different books while pointing at
 * the same row — so there is one, here, testable without a project.
 */

/** The archive-grade EPUB a family hangs off, and what kind of book it is. */
export interface FamilySource {
  /** Project-relative, forward slashes — as the manifest records it. */
  readonly path: string;
  /**
   * Which archive-grade book this is.
   *
   *  - `archive-epub` — a file the user handed us, in `archive/` (or, for a
   *    project from the pre-archive era, `source/original.epub`).
   *  - `generated-epub` — the book a page reader cast from the user's PDF.
   *
   * Nothing may ever write to either. The kind travels because the surfaces
   * that talk about erasing changes have to name the book the user lands on,
   * and "your original" and "the book cast from your pages" are different
   * sentences.
   */
  readonly kind: 'archive-epub' | 'generated-epub';
  /**
   * The source's sha256 when the chain was minted, or null when the file was
   * not there to be measured. Provenance, not a check: a copy is proved by
   * measuring the source and the copy at the moment one is made.
   */
  readonly sha256: string | null;
}

/**
 * As much of a family as the resolution rule needs.
 *
 * The full record (`BookFamily` in electron/manifest-types.ts) carries the
 * working copy and the narration copy too. The rules below are about IDENTITY,
 * and nothing about a file — the same split `RecordedLedgerEntry` makes.
 */
export interface FamilyIdentity {
  /**
   * `fam-<8 hex>`, minted once and never derived from anything.
   *
   * OPAQUE ON PURPOSE. The obvious alternative was to name a family after its
   * source file, the way `manifest.variants` names an archive entry
   * (`arch:<path>`) — and that id IS the path, so renaming the file mints a
   * different one and every record keyed to the old id is orphaned. A family
   * outlives its source's NAME: the path below is repointed by the same
   * machinery that repoints everything else, and the id does not move.
   */
  readonly id: string;
  readonly source: FamilySource;
}

/** The family, or the sentence saying why the question cannot be answered. Never both. */
export type FamilyResolution<F extends FamilyIdentity> =
  | { family: F; refusal: null }
  | { family: null; refusal: string };

/**
 * The stem every file in a family is named after: its SOURCE's own basename.
 *
 * `<stem>.working.epub` beside `<stem>.tts.epub` is a sidecar declaration of
 * which archive-grade book they are copies of — that is what the naming
 * convention has meant since 2026-08-08, and per-family chains are the reason it
 * had to. A project with two families has two working copies in one `source/`
 * directory, and the only thing that says which is which is this stem.
 *
 * The `.generated` half of a cast book's name is stripped, so the cast, the copy
 * and the narration copy of a PDF-origin family all read as one family named
 * after the PDF — which is what they were before families existed, and the
 * reason the migration does not rename a single file on disk.
 */
export function familyStem(source: FamilySource): string {
  const base = source.path.split('/').pop() ?? '';
  if (source.kind === 'generated-epub') {
    const stem = base.replace(/\.generated\.epub$/i, '');
    if (stem !== base) return stem;
    throw new Error(
      `A generated book is named <stem>.generated.epub, and this family's source is "${base}", `
      + 'which is not. Its working copy cannot be named after it without inventing a second name '
      + 'for the same book.'
    );
  }
  return base.replace(/\.[^./\\]+$/, '');
}

/**
 * What to call a SECOND reading of the same pages, so it can have a chain.
 *
 * ── Why the obvious name is the wrong one ───────────────────────────────────
 *
 * Every file in a chain is named after its source's basename (`familyStem`
 * above): `<stem>.working.epub` beside `<stem>.tts.epub` is a sidecar
 * declaration of which archive-grade book they are copies of. So a second
 * reading called `Deathstalker.epub`, added beside a cast called
 * `Deathstalker.generated.epub`, has the SAME stem as the chain already there —
 * two chains, one working copy, and the second mint would destroy the first.
 * `addBookFamily` refuses that by name, correctly.
 *
 * But that name was never the user's: it is derived from the PDF, so refusing a
 * version because of a name the code chose would be refusing the feature. The
 * reading is NUMBERED instead, and the number is the smallest one no existing
 * chain is already named after — stable (running it twice gives readings 2 and
 * 3, not two readings 2) and independent of what happens to be in `archive/`,
 * because the STEM is what collides and two files may share a stem with
 * different extensions.
 *
 * From 2: the reading already in the project is the first, whether or not the
 * user thinks of it that way.
 */
export function nextReadingName(takenStems: readonly string[], stem: string): string {
  const taken = new Set(takenStems.map((s) => s.toLowerCase()));
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (reading ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(
    `There are already 998 readings of "${stem}" here. Nothing will name a 999th — delete some of `
    + 'the ones you have and read the pages again.'
  );
}

/**
 * WHICH family a question is about — the whole of the ambiguity rule.
 *
 * ── One family is an ANSWER, not a fallback ─────────────────────────────────
 *
 * A project with exactly one working chain has exactly one book, so "the
 * project's book" names it unambiguously. That is a theorem about the data
 * rather than a guess about intent, and it is what lets every surface written
 * before families existed go on working untouched: they ask without an id, and
 * on the ~385 projects in the library there is one family to be asked about.
 *
 * ── Several families without an id is a REFUSAL ─────────────────────────────
 *
 * The moment a project has two chains, "the project's book" names two files and
 * picking one would put an evening of edits on whichever the code happened to
 * reach first. So it refuses, and it NAMES both — a surface that has not learned
 * family identity yet fails loudly at the exact moment ambiguity becomes real,
 * which is the only moment at which the failure can be seen and fixed.
 *
 * An id that names no family refuses the same way, listing what there is: it
 * means a stale row, and resolving it to "the first one" would act on a book the
 * user is not looking at.
 */
export function resolveFamily<F extends FamilyIdentity>(
  families: readonly F[],
  familyId: string | undefined,
  projectName: string
): FamilyResolution<F> {
  if (familyId !== undefined) {
    const named = families.find((family) => family.id === familyId);
    if (named) return { family: named, refusal: null };
    return {
      family: null,
      refusal: families.length === 0
        ? `${projectName} has no working chains at all, so ${familyId} names nothing in it. Open the `
          + 'book once and its chain is made.'
        : `${projectName} has no working chain called ${familyId}. It has `
          + `${describeFamilies(families)}. Reload the window — this row is from a build of the `
          + 'project that no longer describes it.',
    };
  }

  if (families.length === 1) return { family: families[0], refusal: null };
  if (families.length === 0) {
    return {
      family: null,
      refusal: `${projectName} has no working chain. A chain hangs off an archive-grade EPUB — the `
        + 'book you handed us, or the book read out of your PDF\'s pages — and this project has '
        + 'neither yet.',
    };
  }
  return {
    family: null,
    refusal: `${projectName} has ${families.length} working chains — ${describeFamilies(families)} `
      + '— and this act was asked for without saying which. Press the button on the version you '
      + 'mean: every chain has its own working copy, its own recorded passes and its own narration '
      + 'copy, and acting on the wrong one would clear edits made to a different book.',
  };
}

/**
 * The project's ONE chain, or null when that is not a thing it has.
 *
 * The same rule as `resolveFamily`'s no-id case, for a caller that cannot throw:
 * a LISTING over the whole library, which must not fail all ~385 projects
 * because one of them has two versions. Null means "this project does not have
 * exactly one book", and the two ways of not having one — none yet, several —
 * are both real; the caller renders what it can and says nothing it cannot
 * prove.
 *
 * It is NOT a softer `resolveFamily`. Anything that ACTS on a book — a mint, an
 * erase, a strike — must go through the resolver and get the sentence, because
 * "I could not tell which" is an answer a listing can absorb and a delete cannot.
 */
export function soleFamily<F extends FamilyIdentity>(families: readonly F[]): F | null {
  return families.length === 1 ? families[0] : null;
}

/** The families by the names a user would recognise them by: their source files. */
export function describeFamilies(families: readonly FamilyIdentity[]): string {
  return families
    .map((family) => `${family.source.path.split('/').pop() ?? family.source.path} (${family.id})`)
    .join(', ');
}

/**
 * Whether this family is the one the PROJECT-GLOBAL picker records describe.
 *
 * ── The one record set that did not move under a family ─────────────────────
 *
 * `manifest.editor`, the deletion keys under `manifest.source` and
 * `manifest.chapters` are the picker's curation of A DOCUMENT LAID OUT AT A
 * POINT IN TIME — page numbers and block ids, stamped with the pagination they
 * were made in (`source.editorLayout`). They are not records about a book's
 * markup; the book's own records (`narrationDeletions`, `bookEdits`, the ledger)
 * are element-keyed and DID move under the family that owns them.
 *
 * They stayed project-global because the object they live in is: `manifest.source`
 * also holds the project's source IDENTITY (`type`, `originalFilename`,
 * `fileHash`), which is one fact about the project and not one per chain.
 * Splitting that object would give a project two answers to "what was imported
 * into it".
 *
 * So the records belong to the family whose source DESCENDS FROM THE ARCHIVE
 * ORIGINAL — the file `manifest.source` is about. That is the family the picker
 * curated:
 *
 *  - a `generated-epub` family always qualifies: a cast book exists only because
 *    a page reader read the archive original's pages, so the picker's page
 *    deletions are the deletions that produced it;
 *  - an `archive-epub` family qualifies when its source IS the archive original.
 *    A second version added beside it is a different file, laid out separately,
 *    and the picker's records say nothing about it.
 *
 * Erasing a non-owning family's changes therefore clears that family's own
 * records and leaves the picker's alone. Guessing either way round would clear
 * an evening of curation of one book because the user reset another.
 */
export function familyOwnsPickerRecords(
  family: FamilyIdentity,
  archiveOriginalRelPath: string | null
): boolean {
  if (family.source.kind === 'generated-epub') return true;
  if (archiveOriginalRelPath === null) return false;
  return family.source.path.toLowerCase() === archiveOriginalRelPath.toLowerCase();
}
