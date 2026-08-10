/**
 * book-chain — two files on the page, and everything else indented under them.
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
 * ── Why this is a module and not a template ─────────────────────────────────
 *
 * The versions page is 3400 lines of inline template. The two things that
 * regress silently there are the ORDER of the lines and WHICH buttons each one
 * gets, and neither can be tested inside a component template. Both are decided
 * here, from the rows main measured plus the book's ledger, and the page renders
 * the answer.
 *
 * It is pure — no fs, no manifest, no Angular. The inputs are exactly what
 * `editor:get-versions` already emits (a row's `type`, `id` and extension) plus
 * the ledger entries it emits on the `exported` row.
 *
 * ── The one structural decision this module makes ───────────────────────────
 *
 * The working copy is NOT a line. Owen: the user's "epub" IS the top-level line,
 * and opening it lands on the working copy (shared/document/artifact-open.ts).
 * So the `exported` row — which names the working copy — is ABSORBED: it
 * contributes the working-changes line, the ledger lines, and (for an EPUB-native
 * project, which has no cast book) the top-level EPUB line itself. Which of
 * those it is doing is `bookRowType`, and it is the difference between a project
 * whose book was cast from pages and one whose book the user handed us.
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

export interface BookChainInput {
  /** Every document row main emitted, in main's own order. */
  readonly rows: readonly ChainRow[];
  /** `outputs.epub.ledger`, in execution order. Empty is the ordinary case. */
  readonly ledger: readonly ChainLedgerEntry[];
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
 * column is EMPTY rather than absent — that is what keeps the alignment. A line
 * that has the act but cannot perform it right now (the narration copy's delete)
 * is `true` here and disabled by the page with its reason.
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
   * Only where the act would otherwise have no home: the book line of a
   * PDF-origin project, whose `exported` row has been absorbed. When the book
   * line IS the exported row, erasing everything is that line's own delete and a
   * second button would be the same act twice.
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

/** The row types the chain claims. Everything else falls through to 'loose'. */
const CLAIMED = new Set(['archive', 'working', 'generated', 'exported', 'narration']);

/**
 * WHICH row is the top-level EPUB line, by type — or null when the project has
 * no book at all.
 *
 * The cast book when there is one: it is archive-grade, nothing writes to it,
 * and it is what every working copy of a PDF-origin project is minted from — so
 * it is "the epub" in the sense the user means. Otherwise the `exported` row,
 * which for an EPUB-native project IS the book the user handed us, one copy
 * along. There is no third answer: a project with neither has no book, and the
 * page says so rather than showing an empty line.
 */
export function bookRowType(rows: readonly ChainRow[]): 'generated' | 'exported' | null {
  if (rows.some((r) => r.type === 'generated')) return 'generated';
  if (rows.some((r) => r.type === 'exported')) return 'exported';
  return null;
}

/**
 * The page's lines, in the order they are drawn.
 *
 * Archive PDFs first, each with its legacy working PDF under it; then the book,
 * with its working changes, its ledger in execution order and its narration copy
 * indented under it; then everything the chain does not claim.
 */
export function bookChain(input: BookChainInput): ChainLine[] {
  const { rows, ledger } = input;
  const lines: ChainLine[] = [];

  const bookType = bookRowType(rows);
  const bookRow = bookType === null ? null : rows.find((r) => r.type === bookType) ?? null;
  const exportedRow = rows.find((r) => r.type === 'exported') ?? null;
  const narrationRow = rows.find((r) => r.type === 'narration') ?? null;

  // ── The archive PDFs, each with its working copy under it ──────────────────
  for (const pdf of rows.filter((r) => r.type === 'archive')) {
    lines.push({
      key: pdf.id,
      kind: 'archive-pdf',
      depth: 0,
      rowId: pdf.id,
      ledgerId: null,
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
      buttons: { ...NO_BUTTONS, convert: true, open: true, export: true, delete: true },
    });
  }

  // ── The book, and its chain ───────────────────────────────────────────────
  if (bookRow !== null) {
    lines.push({
      key: bookRow.id,
      kind: 'book',
      depth: 0,
      rowId: bookRow.id,
      ledgerId: null,
      buttons: {
        ...NO_BUTTONS,
        // Owen: analysis on EPUBs, "not on PDFs. its easier that way."
        analysis: bookRow.extension === 'epub',
        // The passes are done TO the book, so they are offered from the book —
        // and only when it is a book. A project whose top-level line is somehow
        // not an EPUB has nothing for simplify or translate to rewrite.
        passes: bookRow.extension === 'epub',
        // The exported row has been absorbed into this line, so its act comes
        // with it. When this line IS the exported row, that act is its delete.
        eraseEverything: bookType === 'generated' && exportedRow !== null,
        open: true,
        export: true,
        delete: true,
      },
    });

    // The standing record set. It exists exactly when a working copy does —
    // that is the file the records are made against.
    if (exportedRow !== null) {
      lines.push({
        key: `${exportedRow.id}:working-changes`,
        kind: 'working-changes',
        depth: 1,
        rowId: exportedRow.id,
        ledgerId: null,
        buttons: {
          ...NO_BUTTONS,
          // It names no file: the book line above is the file these changes are
          // recorded against, and an Open here would be that line's Open twice.
          delete: true,
        },
      });
    }

    // The passes the user committed to, in the order they ran. The ledger is
    // read off the exported row, so a project with no working copy has none.
    for (const entry of ledger) {
      lines.push({
        key: `ledger:${entry.id}`,
        kind: 'ledger',
        depth: 1,
        rowId: exportedRow === null ? null : exportedRow.id,
        ledgerId: entry.id,
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
        buttons: { ...NO_BUTTONS, process: true, open: true, export: true, delete: true },
      });
    }
  }

  // ── Everything the chain does not claim, in main's own order ──────────────
  for (const row of rows) {
    if (CLAIMED.has(row.type)) continue;
    lines.push({
      key: row.id,
      kind: 'loose',
      depth: 0,
      rowId: row.id,
      ledgerId: null,
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
