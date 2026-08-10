/**
 * book-chain — ONE BOOK LINE PER WORKING CHAIN, and everything else indented
 * under the chain that owns it.
 *
 * ── What Owen asked for (2026-08-09) ────────────────────────────────────────
 *
 * "the user would only ever see two files on the main page - the pdf and the
 * epub… under the epub… smaller, indented lines that say 'working changes' or
 * something… working chains stay visually close to their parent. the working
 * changes are indented under the main archive epub they belong to. same with
 * footnote reference removal - thats indented under the parent. in whichever
 * order they were originally executed. the tts file is also indented under its
 * parent."
 *
 * And, about the buttons: "theyre supposed to be lined up with each other. from
 * right to left, on every file - delete, export, open. then, to the left of that
 * are special buttons, depending on whether the file is capable of running the
 * commands."
 *
 * ── And what he ratified a day later (2026-08-10) ───────────────────────────
 *
 * "we'll change the architecture to make working chains per-archive-file… i do
 * have different versions of books, and i want to be able to run adjustment
 * chains on different versions. tts copies will be nested under their respective
 * parent item, and if the user wants to process a specific TTS document then they
 * click the process button next to it. no ambiguity, no confusion." And: "having
 * the epub listed under documents instead of versions breaks the chain of
 * custody."
 *
 * So the arrangement is no longer "the book and its chain". It is a chain PER
 * FAMILY (shared/document/book-families.ts): each archive-grade EPUB a project
 * holds gets its own book line, with its own working changes, its own ledger and
 * its own narration copy indented under it, side by side with the others. A
 * project with one family renders exactly what it rendered before — that is the
 * whole compatibility story, and it is asserted in tools/test-book-chain.js.
 *
 * ── Why this is a module and not a template ─────────────────────────────────
 *
 * The versions page is 4000 lines of inline template. The two things that
 * regress silently there are the ORDER of the lines and WHICH buttons each one
 * gets, and neither can be tested inside a component template. Both are decided
 * here, from the rows main measured plus each chain's ledger, and the page
 * renders the answer.
 *
 * It is pure — no fs, no manifest, no Angular. The inputs are exactly what
 * `editor:get-versions` already emits (a row's `type`, `id`, extension and the
 * chain it belongs to) plus, per chain, the ledger entries emitted on its
 * `exported` row.
 *
 * ── The one structural decision this module makes ───────────────────────────
 *
 * The working copy is NOT a line. Owen: the user's "epub" IS the top-level line,
 * and opening it lands on the working copy (shared/document/artifact-open.ts).
 * So a chain's `exported` row — which names its working copy — is ABSORBED: it
 * contributes the working-changes line, the ledger lines, and (for a chain
 * hanging off an EPUB the user handed us, which has no cast book) the top-level
 * EPUB line itself. Which of those it is doing is `bookRowType`, and it is the
 * difference between a chain whose book was cast from pages and one whose book
 * the user handed us.
 *
 * ── There is no "the project's book" here any more ──────────────────────────
 *
 * Every line is stamped with the chain it belongs to, and the page hands that id
 * back with every act it performs. That is the same rule `requireFamily` enforces
 * on the other side of the IPC boundary, said in the layout: a project with two
 * versions must act on the one whose button was pressed, and a line that cannot
 * say which chain it is on is exactly the broken custody Owen named.
 */

/** The kinds of line the page draws, in the order they can appear. */
export type ChainLineKind =
  /** The archive PDF, top level. Nothing writes to it; it can be converted. */
  | 'archive-pdf'
  /**
   * A legacy working PDF, indented under the archive PDF it was copied from.
   *
   * Nothing mints these any more (`canMintWorkingCopy` returns false since the
   * artifact model settled on 2026-08-08), but projects that have one still show
   * it — a file on disk with no row is work with no door.
   */
  | 'working-pdf'
  /** THE EPUB — the one book line the user sees, top level. */
  | 'book'
  /**
   * The standing set of working-change RECORDS, indented under the book.
   *
   * Virtual: it names no file of its own. Its delete is `book:erase-changes`
   * with scope 'working-changes'.
   */
  | 'working-changes'
  /** One committed pass, indented under the book, in execution order. */
  | 'ledger'
  /** The narration copy — the file TTS reads — indented under the book. */
  | 'narration'
  /**
   * Everything the chain does not claim: the legacy stage outputs
   * (cleaned/simplified/repaired/translated) and the pre-archive
   * `source/original.*`. Top level, after the chain, buttons unchanged.
   */
  | 'loose';

/** As much of a `editor:get-versions` row as the arrangement needs. */
export interface ChainRow {
  readonly id: string;
  /** The row's `type` — main's own discriminator ('archive', 'exported', …). */
  readonly type: string;
  /** Lower-cased, no dot. '' for a row whose file has none. */
  readonly extension: string;
  /**
   * WHICH working chain this row belongs to, or null for a row that is on none.
   *
   * Set by main on the three rows a chain owns — its cast book (`generated`), its
   * working copy (`exported`) and its narration copy (`narration`). Null on the
   * archive PDFs (a PDF has no chain of its own; it reaches a book only by being
   * cast into one) and on the legacy stage outputs.
   */
  readonly familyId: string | null;
}

/** One ledger entry, as `editor:get-versions` emits it on the exported row. */
export interface ChainLedgerEntry {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly createdAt: string;
  /** Whether the entry's frozen diff is on disk. Drives Review changes. */
  readonly hasReceipt: boolean;
}

/**
 * One working chain, as much of it as the arrangement needs.
 *
 * The identity half is `FamilyIdentity` (shared/document/book-families.ts); this
 * adds the two things the LAYOUT needs and nothing else: the ledger to draw, and
 * the archive PDF row this chain's book was cast out of, so a PDF-origin chain
 * can be drawn beside the PDF it came from rather than somewhere else on the
 * page.
 */
export interface ChainFamily {
  readonly id: string;
  /**
   * Which archive-grade book this chain hangs off — and therefore which row is
   * its book line. `generated-epub` means the cast, which has a row of its own;
   * `archive-epub` means a file the user handed us, which has none, so the
   * working copy's row IS the line (see `bookRowType`).
   */
  readonly sourceKind: 'archive-epub' | 'generated-epub';
  /**
   * The source file's basename — the name this chain's custody is stated in.
   *
   * Owen, 2026-08-10: a book line that does not say which version it came from
   * "breaks the chain of custody". With one chain, main's own row description
   * already says it once; with several it is the only thing that tells two book
   * lines apart, so it travels on every line of the chain rather than being
   * looked up again by whoever is rendering.
   */
  readonly sourceName: string;
  /**
   * Whether erasing this chain's working changes would erase ANYTHING — the
   * picker's records (when this chain owns them), narration strikes, or a
   * deliberate book edit. Measured by main against the same list
   * `resetEditorRecords` clears, minus the automatic chapter-opener naming that
   * every fresh mint writes.
   *
   * This is what gates the working-changes line. It used to be drawn whenever a
   * working copy existed, and a successful erase re-mints the copy on the spot —
   * so the line reappeared instantly and the erase looked like it did nothing
   * (Owen, 2026-08-10: "it blinked and reloaded, and it was still there").
   */
  readonly hasWorkingChanges: boolean;
  /** This chain's ledger, in execution order. Empty is the ordinary case. */
  readonly ledger: readonly ChainLedgerEntry[];
  /**
   * The `archive` row whose pages this chain's book was read out of, or null.
   *
   * Only a `generated-epub` chain has one. It is what stamps the chain's id onto
   * the PDF's line — the PDF has no chain, but it does have exactly one book that
   * came out of it, and saying so in the data is what lets the page draw the two
   * together instead of guessing from their order.
   */
  readonly archiveRowId: string | null;
}

export interface BookChainInput {
  /** Every document row main emitted, in main's own order. */
  readonly rows: readonly ChainRow[];
  /**
   * The project's working chains, in the order the manifest records them.
   *
   * Empty is real and ordinary: a PDF nobody has converted has no chain, because
   * a chain hangs off an archive-grade EPUB and it has none yet.
   */
  readonly families: readonly ChainFamily[];
}

/**
 * Whether the Review changes button on a line is real, and if not, why not.
 *
 * 'no-receipt' is NOT the same as 'none': it means this line is a pass that was
 * committed to the book and whose frozen diff is missing, so the button is drawn
 * DISABLED saying so. A silent gap there would read as a pass that changed
 * nothing.
 */
export type ReviewAffordance = 'ready' | 'no-receipt' | 'none';

/**
 * Which buttons a line gets.
 *
 * The three standing ones (`open`, `export`, `delete`) are on every line and are
 * laid out in fixed columns, so they line up down the page. `false` means the
 * column is EMPTY rather than absent — that is what keeps the alignment. Delete
 * is live on EVERY chain line (Owen, 2026-08-10: "it should always be
 * available"), each routed to the remover that owns that artifact's records —
 * the page may still disable one with a reason when the ROW arrives in a state
 * its remover cannot classify.
 */
export interface ChainButtons {
  /** Convert to EPUB — the archive PDF and a legacy working PDF. */
  readonly convert: boolean;
  /** Generate analysis — archive-grade EPUBs only, never a PDF. */
  readonly analysis: boolean;
  /**
   * Process — opens the book passes, on the top-level EPUB.
   *
   * Owen, 2026-08-09: "the translate/simplify/footnotes options are available
   * from a modal that appears if the user hits process on the archive files."
   * The passes are things done to the BOOK, so they are offered from the book's
   * own line and from nowhere else — a Simplify hanging off a stage output would
   * promise to rewrite that file, which is not what the pass does.
   */
  readonly passes: boolean;
  /**
   * Process — takes THIS line's file to narration.
   *
   * The narration copy's line, and only it: that is the file TTS reads, and the
   * button carries its path so the pipeline is told which document it has rather
   * than looking one up (Owen's law about coming to the TTS page FROM the button
   * on the document).
   */
  readonly process: boolean;
  /**
   * Erase all changes (scope 'everything').
   *
   * On the book line of BOTH origins, and always as a SPECIAL — never as the
   * line's delete. It was the delete's label once, and Owen caught what that
   * does to the grid (2026-08-10): "its a specialty button, and should be on
   * the left side instead of covering the delete button" — the delete column is
   * 78px wide because "Delete" is, and a longer act crammed into it paints over
   * its neighbours. So the delete column holds acts called Delete, and the acts
   * with real names sit in the flexible specials column where their names fit.
   */
  readonly eraseEverything: boolean;
  readonly review: ReviewAffordance;
  readonly open: boolean;
  readonly export: boolean;
  readonly delete: boolean;
}

export interface ChainLine {
  /** Stable across reloads — the `@for` track key. */
  readonly key: string;
  readonly kind: ChainLineKind;
  /** 0 for a top-level file, 1 for a line indented under it. */
  readonly depth: 0 | 1;
  /**
   * The `editor:get-versions` row this line ACTS ON, or null for a line that
   * names no row (the virtual working-changes line).
   *
   * The ledger lines carry the `exported` row's id: it is the book they are
   * entries in, and the page needs it to reach the project's own delete paths.
   */
  readonly rowId: string | null;
  /** The ledger entry this line is, for a 'ledger' line. Null otherwise. */
  readonly ledgerId: string | null;
  /**
   * WHICH working chain this line is on — the id every act performed from it
   * hands back to main.
   *
   * Null only for a line that is on no chain: a PDF nobody has cast a book out
   * of, a legacy working PDF, a stage output. Every other line has one, and that
   * is what makes "press the button on the version you mean" a mechanism rather
   * than an instruction — a project with two chains has two book lines, and the
   * one the user pressed says which.
   */
  readonly familyId: string | null;
  /**
   * The archive-grade book this line's chain hangs off, by basename. Null
   * exactly when `familyId` is.
   *
   * The chain of custody, carried on the line rather than looked up: the page
   * uses it to name the book in every confirmation it writes, so a user erasing
   * one version's changes is told which version by name.
   */
  readonly sourceName: string | null;
  readonly buttons: ChainButtons;
}

const NO_BUTTONS: ChainButtons = {
  convert: false,
  analysis: false,
  passes: false,
  process: false,
  eraseEverything: false,
  review: 'none',
  open: false,
  export: false,
  delete: false,
};

/** The row types a chain claims. Everything else falls through to 'loose'. */
const CLAIMED = new Set(['archive', 'working', 'generated', 'exported', 'narration']);

/**
 * WHICH row is THIS CHAIN'S top-level EPUB line, by type — or null when that row
 * is not there.
 *
 * The cast book for a chain that hangs off one: it is archive-grade, nothing
 * writes to it, and it is what that chain's working copy is minted from — so it
 * is "the epub" in the sense the user means. Otherwise the chain's `exported`
 * row, which for a chain hanging off an EPUB the user handed us IS that book,
 * one copy along. There is no third answer: a chain with neither row on screen
 * has no book to draw, and the page says nothing rather than showing an empty
 * line.
 *
 * It takes the FAMILY rather than deciding from the rows alone, and that is the
 * change families forced: "is there a generated row?" is a question about the
 * project, and a project may hold a cast book AND a second edition the user
 * handed us. Only the chain knows which kind of book it is a chain of.
 */
export function bookRowType(
  rows: readonly ChainRow[],
  family: ChainFamily
): 'generated' | 'exported' | null {
  // The cast, when this chain has one AND its file is still on screen. A chain
  // whose cast the user removed by hand still has a book — their working copy,
  // which is that book one copy along — and drawing it is not a fallback for a
  // missing value but the definition of the line: the top-level EPUB is the
  // furthest archive-grade thing this chain has, and the copy when it has none.
  if (family.sourceKind === 'generated-epub' && rowOf(rows, 'generated', family.id) !== null) {
    return 'generated';
  }
  return rowOf(rows, 'exported', family.id) === null ? null : 'exported';
}

/** This chain's row of a given type, matched by the chain it declares it is on. */
function rowOf(
  rows: readonly ChainRow[],
  type: string,
  familyId: string
): ChainRow | null {
  return rows.find((r) => r.type === type && r.familyId === familyId) ?? null;
}

/**
 * The page's lines, in the order they are drawn.
 *
 * Archive PDFs first, then any legacy working PDF; then one chain per family —
 * its book line, with its working changes, its ledger in execution order and its
 * narration copy indented under it; then everything no chain claims.
 *
 * ── Why the chains cast from a PDF are drawn first ──────────────────────────
 *
 * A chain whose book was read out of a PDF belongs beside that PDF: it is the
 * only thing on the page the PDF's Convert produced, and the two read as one
 * story. Chains hanging off an EPUB the user handed us have no top-level file of
 * their own above them, so they follow. Within each group the manifest's own
 * order stands — the order the user added the versions in.
 *
 * A project with ONE chain is unaffected by all of this: there is one group, one
 * book line, and the arrangement is exactly what it was before families existed.
 */
export function bookChain(input: BookChainInput): ChainLine[] {
  const { rows, families } = input;
  const lines: ChainLine[] = [];

  /** The chain cast out of a given archive PDF row, when one was. */
  const castFrom = (archiveRowId: string): ChainFamily | null =>
    families.find((f) => f.archiveRowId === archiveRowId) ?? null;

  // ── The archive PDFs, each with any legacy working PDF under it ────────────
  //
  // A PDF has no chain of its own — Owen: "PDFs have no working chain. only
  // epubs. PDFs only exist to convert to epub" — but it does have at most one
  // book that came out of it, and the line says which so the page can draw them
  // together and an act taken from the PDF knows what it produced.
  for (const pdf of rows.filter((r) => r.type === 'archive')) {
    const cast = castFrom(pdf.id);
    lines.push({
      key: pdf.id,
      kind: 'archive-pdf',
      depth: 0,
      rowId: pdf.id,
      ledgerId: null,
      familyId: cast === null ? null : cast.id,
      sourceName: cast === null ? null : cast.sourceName,
      buttons: { ...NO_BUTTONS, convert: true, open: true, export: true, delete: true },
    });
  }
  for (const working of rows.filter((r) => r.type === 'working')) {
    lines.push({
      key: working.id,
      kind: 'working-pdf',
      depth: 1,
      rowId: working.id,
      ledgerId: null,
      // The retired artifact: a copy of the PDF, not of a book, so it is on no
      // chain and never was.
      familyId: null,
      sourceName: null,
      buttons: { ...NO_BUTTONS, convert: true, open: true, export: true, delete: true },
    });
  }

  // ── One chain per family ──────────────────────────────────────────────────
  const ordered = [
    ...families.filter((f) => f.archiveRowId !== null),
    ...families.filter((f) => f.archiveRowId === null),
  ];
  for (const family of ordered) {
    const bookType = bookRowType(rows, family);
    const bookRow = bookType === null ? null : rowOf(rows, bookType, family.id);
    const exportedRow = rowOf(rows, 'exported', family.id);
    const narrationRow = rowOf(rows, 'narration', family.id);
    if (bookRow === null) continue;

    const stamp = { familyId: family.id, sourceName: family.sourceName };

    lines.push({
      key: bookRow.id,
      kind: 'book',
      depth: 0,
      rowId: bookRow.id,
      ledgerId: null,
      ...stamp,
      buttons: {
        ...NO_BUTTONS,
        // Owen: analysis on EPUBs, "not on PDFs. its easier that way."
        analysis: bookRow.extension === 'epub',
        // The passes are done TO the book, so they are offered from the book —
        // and only when it is a book. A chain whose top-level line is somehow
        // not an EPUB has nothing for simplify or translate to rewrite.
        passes: bookRow.extension === 'epub',
        // Wherever there is a working copy there are changes to erase, and the
        // act lives HERE, as a special, whichever row this line is standing on.
        eraseEverything: exportedRow !== null,
        open: true,
        export: true,
        // Always (Owen, 2026-08-10: "it should always be available"). What it
        // DOES differs by what the line is standing on: cast from pages, this
        // line is the generated book and Delete is the heavy act (the cast
        // goes, the working copy with it); handed to us, it is the working copy
        // and Delete routes to the same erase the special performs — the file
        // comes straight back, which its confirmation says. The special stays
        // beside it because it is the act's honest NAME; the column only ever
        // says Delete because 78px is what "Delete" fits.
        delete: true,
      },
    });

    // The standing record set — drawn only when there ARE records to erase.
    // The working copy alone is not enough: every mint writes the automatic
    // chapter-opener naming, so "a copy exists" is true the instant an erase
    // finishes, and gating on it made the line survive its own delete.
    if (exportedRow !== null && family.hasWorkingChanges) {
      lines.push({
        key: `${exportedRow.id}:working-changes`,
        kind: 'working-changes',
        depth: 1,
        rowId: exportedRow.id,
        ledgerId: null,
        ...stamp,
        buttons: {
          ...NO_BUTTONS,
          // It names no file: the book line above is the file these changes are
          // recorded against, and an Open here would be that line's Open twice.
          delete: true,
        },
      });
    }

    // The passes the user committed to, in the order they ran. The ledger is
    // read off this chain's exported row, so a chain with no working copy on
    // screen draws none.
    if (exportedRow !== null) for (const entry of family.ledger) {
      lines.push({
        // Keyed by the CHAIN as well as the entry: two chains mint their entry
        // ids from the same RNG and nothing forbids a collision, and two lines
        // with one key is two lines the list cannot tell apart.
        key: `${family.id}:ledger:${entry.id}`,
        kind: 'ledger',
        depth: 1,
        rowId: exportedRow.id,
        ledgerId: entry.id,
        ...stamp,
        buttons: {
          ...NO_BUTTONS,
          review: entry.hasReceipt ? 'ready' : 'no-receipt',
          // The entry owns a snapshot: the book exactly as this pass left it.
          open: true,
          export: true,
          delete: true,
        },
      });
    }

    if (narrationRow !== null) {
      lines.push({
        key: narrationRow.id,
        kind: 'narration',
        depth: 1,
        rowId: narrationRow.id,
        ledgerId: null,
        ...stamp,
        buttons: { ...NO_BUTTONS, process: true, open: true, export: true, delete: true },
      });
    }
  }

  // ── Everything no chain claimed, in main's own order ──────────────────────
  //
  // The legacy stage outputs and the pre-archive source — plus, deliberately, a
  // `generated`/`exported`/`narration` row whose chain is not in `families` at
  // all. That is IPC shape drift rather than a state, and the alternative is a
  // file on disk with a row main measured and no line on the page: work with no
  // door, which is the exact bug the versions rebuild started from. It gets its
  // three standing acts and none of the chain's specials, because nothing here
  // can say which book it is a copy of.
  const drawn = new Set(lines.map((l) => l.rowId));
  for (const row of rows) {
    if (CLAIMED.has(row.type) && drawn.has(row.id)) continue;
    if (row.type === 'archive' || row.type === 'working') continue;
    lines.push({
      key: row.id,
      kind: 'loose',
      depth: 0,
      rowId: row.id,
      ledgerId: null,
      familyId: null,
      sourceName: null,
      buttons: { ...NO_BUTTONS, open: true, export: true, delete: true },
    });
  }

  return lines;
}

/**
 * What deleting the working-change records costs, in one paragraph.
 *
 * The counterpart to `describeLedgerDeletion` (shared/document/book-ledger.ts)
 * for the other kind of change, and it says the same two things in the same
 * order: what goes, and what stands. The ledger standing is the whole point of
 * the narrower scope — a user clearing their own edits has not asked to throw
 * away an hour of model time, and a confirmation that did not say so would be
 * describing `scope: 'everything'`.
 */
export function describeWorkingChangesErase(keptLabels: readonly string[]): string {
  const kept = keptLabels.length === 0
    ? 'This book has no recorded passes, so the fresh copy is the archive-grade book exactly.'
    : `${keptLabels.length === 1 ? 'The pass' : 'The passes'} you committed to — `
      + `${keptLabels.join(', ')} — ${keptLabels.length === 1 ? 'stays' : 'stay'} applied: `
      + `${keptLabels.length === 1 ? 'it rewrote' : 'they rewrote'} the book itself and `
      + `${keptLabels.length === 1 ? 'is' : 'are'} recorded in its ledger, so the fresh copy is `
      + 'derived from the snapshot the last of them left. Delete those entries to go back further.';
  return (
    'Every change you have made to this book is cleared, and a fresh copy takes its place '
    + 'immediately:\n'
    + '  • your block and page deletions\n'
    + '  • text corrections, splits, merges and category learning\n'
    + '  • chapter markers and any chapter openings you folded\n'
    + '  • everything struck out for narration\n'
    + '  • undo / redo history\n\n'
    + kept
  );
}
