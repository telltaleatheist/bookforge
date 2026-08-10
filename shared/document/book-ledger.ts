/**
 * book-ledger — the passes a user COMMITTED to, each deletable on its own.
 *
 * ── What Owen asked for ─────────────────────────────────────────────────────
 *
 * "the user would only ever see two files on the main page - the pdf and the
 * epub… under the epub… smaller, indented lines that say 'working changes' or
 * something. if they run footnotes, there will be a small indented footnote line
 * there, too. they can delete either the working changes or the footnote
 * reference number removal lines. the footnote removal should have a diff that
 * records everything that was changed… (diff is frozen in time when the footnote
 * removal ran)". And, generalising it: "the user might not even run footnotes.
 * but it can be another entry in the 'ledger' of changes that the user committed
 * to."
 *
 * ── The two kinds of change, and why only one of them is a ledger entry ─────
 *
 * A project's edits come in two shapes and they compose differently:
 *
 *  1. WORKING CHANGES are RECORDS — `manifest.editor`, the `manifest.source`
 *     deletion keys, the chapter markers, `narrationDeletions`, `bookEdits`.
 *     They name elements by POSITION in the book's one enumeration walk
 *     (shared/vlm/narration-deletions.ts) and are re-applied over whatever the
 *     book currently says. They are not in this list and never will be: they are
 *     one standing set, cleared wholesale by `resetEditorRecords`, and their line
 *     in the UI is virtual.
 *  2. A PASS rewrites the book's BYTES in place (electron/processing-passes.ts).
 *     Once it has run there is no record of what it did except its diff, and no
 *     way back to the text it replaced except a copy of the book from before.
 *
 * So a ledger entry is a pass, and what makes it deletable on its own is that
 * the entry carries a SNAPSHOT: the book exactly as that pass left it. The
 * entries form a chain — base → snapshot 1 → snapshot 2 → … — and the working
 * copy is derived from the LAST snapshot, or from the archive-grade base when
 * the ledger is empty. Deleting an entry re-derives from the snapshot before it.
 *
 * ── THE INVARIANT that lets records and passes compose at all ───────────────
 *
 * Working-change records are keyed against the BASE's element enumeration, and
 * they have to stay valid across every re-derivation, or clearing a pass would
 * silently re-point every strike the user made at a different paragraph. That
 * holds only while a ledger pass changes TEXT and never element STRUCTURE. It is
 * not assumed: `registerLedgerPass` (electron/book-ledger.ts) walks the snapshot
 * and the base and refuses the entry when the per-file element counts differ.
 *
 * ── Kept pure ───────────────────────────────────────────────────────────────
 *
 * No fs, no manifest — the cascade rule and the sentences that describe it are
 * the part two IPC handlers and a UI have to agree about, so they live where
 * they can be tested without a project (`tools/test-ledger-lifecycle.js`).
 */

/** Where a ledger entry's snapshot and frozen diff live, project-relative. */
export const LEDGER_REL_DIR = 'source/ledger';

/**
 * The directory one entry owns outright, project-relative, forward slashes.
 *
 * One directory per entry, holding its snapshot and its receipt, and nothing
 * else in the project writes into it. That is what makes deleting an entry a
 * single `rm -r` of a path the manifest names, rather than a hunt for files by
 * pattern — and it is why the receipt is FROZEN here rather than left in the
 * pass's `stages/NN-<kind>/`, which every re-mint of the book clears
 * (`passesAfterEpubEvent`).
 */
export function ledgerEntryRelDir(id: string): string {
  return `${LEDGER_REL_DIR}/${id}`;
}

/**
 * One entry, as much of it as the pure rules need.
 *
 * The full record (snapshot path, digest, receipt, the provenance the snapshot's
 * bytes carry) is `LedgerEntry` in electron/manifest-types.ts. This is the
 * `RecordedPass` pattern from pass-lifecycle.ts, for the same reason: the rules
 * below are about ORDER and IDENTITY, and nothing about a file.
 */
export interface RecordedLedgerEntry {
  readonly id: string;
  /** The pass kind — `simplify`, `translate`. */
  readonly kind: string;
  /** What the row says, e.g. "Simplify". */
  readonly label: string;
  readonly createdAt: string;
}

/** What deleting one entry costs: the entries that stand, and the ones that go. */
export interface LedgerDeletion<T extends RecordedLedgerEntry> {
  /** The entries still describing the book afterwards, oldest first. */
  readonly kept: readonly T[];
  /**
   * The entries that go, in the order they ran. The named entry is the first of
   * them; anything after it is a CASCADE.
   */
  readonly cascaded: readonly T[];
}

/**
 * Which entries survive deleting `id` — and everything that ran after it does
 * NOT.
 *
 * ── Why the cascade is honest rather than lazy ──────────────────────────────
 *
 * Each snapshot is the book after ITS pass, applied to the book the pass before
 * it left. Snapshot 3's bytes were produced from snapshot 2's, so there is no
 * file on this disk that is "the book with pass 2 undone but pass 3 still
 * applied" — producing one would mean re-running pass 3 over different text,
 * which is an AI call with a different result, not an undo. Owen licensed
 * exactly this: "if it isnt [possible], we can remove both, like a cascade of
 * changes."
 *
 * The cascade is NAMED rather than counted so the confirmation can list what
 * the user is about to lose. Deleting the LAST entry cascades nothing, which is
 * the ordinary case and needs no confirmation beyond its own.
 *
 * An id that is not in the list is a caller bug — a row the UI is showing that
 * the manifest does not have — and is refused by name rather than treated as
 * "nothing to delete".
 */
export function ledgerAfterDeleting<T extends RecordedLedgerEntry>(
  entries: readonly T[],
  id: string
): LedgerDeletion<T> {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new Error(
      `This book's ledger has no entry "${id}", so there is nothing to delete. It records `
      + `${entries.length} entr(y/ies)${entries.length > 0
        ? `: ${entries.map((e) => `${e.label} (${e.id})`).join(', ')}`
        : ''}. Reload the page — the row you pressed describes a change this book no longer has.`
    );
  }
  return { kept: entries.slice(0, index), cascaded: entries.slice(index) };
}

/** `Simplify, Translate and Simplify` — labels in the order they ran. */
export function listLedgerLabels(entries: readonly RecordedLedgerEntry[]): string {
  const labels = entries.map((entry) => entry.label);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What a deletion did, in one paragraph, naming every entry that went.
 *
 * The cascade is the part a user cannot infer: they pressed delete on one row
 * and three changes came out of their book. Saying which three, by name, is the
 * whole point — a count would leave them counting rows to work out which.
 */
export function describeLedgerDeletion(deletion: LedgerDeletion<RecordedLedgerEntry>): string {
  const [named, ...after] = deletion.cascaded;
  const standing = deletion.kept.length === 0
    ? 'The book is back to the archive-grade original it was copied from'
    : `The book is back to how ${listLedgerLabels(deletion.kept)} left it`;
  const cascade = after.length === 0
    ? ''
    : ` Everything run after it went with it, because each of those was applied to the text this `
      + `one produced and there is no book on disk with them applied to anything else — `
      + `${listLedgerLabels(after)}.`;
  return (
    `${named.label} has been removed from this book's ledger.${cascade} ${standing}. Your working `
    + 'changes are untouched: they are recorded against the book rather than written into it, and '
    + 'they apply to it again exactly as they did.'
  );
}

/**
 * The clause a re-mint adds when the fresh copy still carries recorded passes.
 *
 * A user who deleted the working copy of a book that has been through a pass
 * means "start MY edits over", not "throw away the hour of model time as well".
 * The receipt has to say which, so the sentence names what stood.
 */
export function describeLedgerKept(kept: readonly RecordedLedgerEntry[]): string {
  if (kept.length === 0) return '';
  return (
    `${listLedgerLabels(kept)} ${kept.length === 1 ? 'is' : 'are'} still applied — `
    + `${kept.length === 1 ? 'that pass' : 'those passes'} rewrote the book itself and `
    + `${kept.length === 1 ? 'is' : 'are'} recorded in its ledger, so `
    + `${kept.length === 1 ? 'it was' : 'they were'} kept. Delete `
    + `${kept.length === 1 ? 'that entry' : 'those entries'} to go back further.`
  );
}
