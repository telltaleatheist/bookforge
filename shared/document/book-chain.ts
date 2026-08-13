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
 * THE WORKING COPY IS NEVER A DOCUMENT ROW. Owen, 2026-08-10: "after i created
 * the generated document it created a 'working file' line in versions. the
 * working file should be invisible to the user. they control changes from the
 * parent of the chain, which is the archive file. the archive is never touched,
 * the working file is what's edited, but it shouldnt show for the user. its a
 * chain of custody indicator."
 *
 * So a chain's `exported` row — the row main emits for its working copy — is
 * ABSORBED. It is never drawn as a file of its own. What it contributes is:
 *
 *  - the working-changes line and the ledger lines, which are drawn UNDER the
 *    chain's parent row and are records rather than files;
 *  - for a chain hanging off an EPUB the user handed us, the parent row itself
 *    — because such a project has no row for its archive EPUB at all (main's
 *    `listProjectPdfs` lists PDFs, and an EPUB-native project holds none), so
 *    the copy's row is the only row that book has. It is drawn there as THE
 *    BOOK, named after the book, opening on the book — not as "a working file".
 *
 * Which of those it is doing is `bookRowType`.
 *
 * ── The absorption has to be UNCONDITIONAL, and once was not ────────────────
 *
 * This was already the intent and it had a hole, which is what Owen hit. The
 * loose sweep at the bottom draws every row no line claimed — a deliberate rule,
 * so a file on disk can never be work with no door — and it decided "claimed" by
 * asking whether any line had been drawn ON that row. A chain hanging off a CAST
 * book draws its parent row on the `generated` row, and reaches the `exported`
 * row only through the working-changes line and the ledger lines. A book that
 * has just been cast has NEITHER: no pass has run, and `hasWorkingChanges` is
 * false because the only records a fresh mint writes are the automatic
 * chapter-opener naming. So nothing named the working copy, the sweep found it
 * unclaimed, and drew it top level with Open, Export and Delete on it — the
 * "working file" line, appearing at exactly the moment a conversion finished.
 *
 * Absorption is therefore recorded as a FACT ABOUT THE CHAIN, decided when the
 * chain is laid out, and not inferred afterwards from which lines happened to
 * exist. A rule that is only true when other things are true is not the rule.
 *
 * ── There is no "the project's book" here any more ──────────────────────────
 *
 * Every line is stamped with the chain it belongs to, and the page hands that id
 * back with every act it performs. That is the same rule `requireFamily` enforces
 * on the other side of the IPC boundary, said in the layout: a project with two
 * versions must act on the one whose button was pressed, and a line that cannot
 * say which chain it is on is exactly the broken custody Owen named.
 *
 * ── DOCUMENTS AND LEDGERS ARE DIFFERENT THINGS (Owen, 2026-08-10) ───────────
 *
 * "maybe the open button should only exist on the archive file (aka the working
 * document). the working document shouldnt have a line item, it should be
 * invisible to the user. its only there to be opened/manipulated by the user.
 * the archive item is the one the user should be clicking to open/view/etc. the
 * 'working' document should only appear as an indented line item that says
 * 'working changes' which can be cleared, just like footnotes. footnotes and
 * working changes should not be able to be opened or exported individually. only
 * deleted. the tts document can have process/open/etc buttons since we actually
 * do stuff with that and its a real tangible document, not a UI device used to
 * show the user what's been done indirectly. footnotes and working changes are
 * more ledgers than documents, to the user's eyes"
 *
 * So the button matrix has TWO CLASSES of line, and this module is where the
 * difference is stated:
 *
 *  - DOCUMENTS — the archive PDF, the book (the control centre), the narration
 *    copy. Real files. They open, they export, they carry their own specials.
 *  - LEDGERS — the working-changes line and the ledger lines. They are the
 *    RECORD of what has been done, drawn under the document they were done to.
 *    They carry no Open and no Export; their acts are clear/delete, plus (on a
 *    pass) Review changes, which is a ledger's "what did this do" rather than a
 *    door onto a file.
 *
 * A ledger line's Open was not merely redundant — it was DESTRUCTIVE. It opened
 * the pass's snapshot as the project's displayed document, and the picker binds
 * a project-owned document it cannot prove the edits belong to WITHOUT applying
 * them, which is one autosave away from writing an empty edit set over an
 * evening of work. Owen, 2026-08-10: "i went back and hit open on footnote
 * removal… i closed it and reopened from the working copy and all my changes
 * were indeed cleared." The door is gone from the model, which is why it can no
 * longer be drawn.
 */

import { EPUB_SUFFIX, WORKING_COPY_SUFFIX } from './book-path';

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
  /**
   * THE CHAIN'S PARENT ROW — the one book line the user sees, top level, and the
   * CONTROL CENTRE for its chain (Owen, 2026-08-10: "the archive document will
   * be the control center").
   *
   * It is the ARCHIVE-GRADE file the chain hangs off: the cast book for a chain
   * read out of a PDF, and the copy's own row for a chain hanging off an EPUB
   * the user handed us, which has no other row (see the header). Never the
   * working copy AS a working copy — that file has no line, and its acts are
   * performed from here.
   *
   * Everything the chain can do is on this row: Open (which lands on the working
   * copy), Process (the passes), Generate analysis, Export TTS copy, Erase all
   * changes and Delete. Nothing else on the chain opens.
   */
  | 'book'
  /**
   * The standing set of working-change RECORDS, indented under the parent row.
   *
   * Virtual: it names no file of its own. Its delete is `book:erase-changes`
   * with scope 'working-changes'. A LEDGER line — clear only.
   *
   * ── THE ONLY HANDLE THE USER HAS ON THE WORKING COPY (Owen, 2026-08-10) ────
   *
   * "they will see working changes as an indented line item with limited
   * options, which they can delete if they want to start over. working file
   * should not be visible. thats behind the scenes work."
   *
   * So this line carries the whole of "start over": clearing it is how a user
   * throws away their edits, and there is no door anywhere that offers to delete
   * the working FILE. That is not a capability that moved — it is one the user
   * never needed, because the file is custody bookkeeping and its records are
   * the thing they were ever actually deleting. The copy is re-minted on the
   * spot by the erase, which is why deleting it as a file could never have meant
   * anything different.
   */
  | 'working-changes'
  /**
   * One committed pass, indented under the book, in execution order.
   *
   * A LEDGER line: Review changes (what it did) and Delete (take it back). It
   * does not open and does not export — see the header.
   */
  | 'ledger'
  /** The narration copy — the file TTS reads — indented under the book. */
  | 'narration'
  /**
   * Everything the chain does not claim: the legacy stage outputs
   * (cleaned/simplified/repaired/translated) and the pre-archive
   * `source/original.*`. Top level, after the chain, buttons unchanged.
   */
  | 'loose';

/**
 * Is this row a BOOK — whatever container the book happens to be in?
 *
 * `extension` is main's `path.extname(...)` with the dot removed, so a working
 * copy that used to be `<stem>.working.epub` reported `epub` and now reports
 * `working`. Three buttons on the chain's book line were gated on `=== 'epub'`,
 * so the moment the copy exploded into a directory the book line lost Generate
 * analysis, Process and Export TTS copy — for every EPUB-native project, which
 * is the common case, and only for those (a PDF-origin project's book row is
 * `<stem>.generated.epub`, a real zip, so it kept its buttons). That is why it
 * read as "some books lost their buttons" rather than as a broken page.
 *
 * Asked here rather than with `isBookPath` because a `ChainRow` carries no
 * path — but it is the same rule and the same constant, so the two cannot drift.
 */
function isBookRow(row: ChainRow): boolean {
  return `.${row.extension}` === EPUB_SUFFIX
    || `.${row.extension}` === WORKING_COPY_SUFFIX;
}

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
  /**
   * Whether the book this pass left — the entry's SNAPSHOT — is on disk.
   *
   * A separate question from `hasReceipt` and asked of a different file. The
   * receipt is the word-diff a pass froze; the snapshot is the book itself, and
   * it is what the side-by-side compare shows. Both are asked of the DISK by
   * main rather than read off the manifest, for the reason `hasReceipt` learned
   * the hard way: a record naming a file that is not there draws an enabled
   * button onto an empty surface.
   */
  readonly hasSnapshot: boolean;
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
  /**
   * Whether the archive-grade book this chain hangs off is on disk.
   *
   * The FIRST ledger entry's "before" is that file and nothing else — there is
   * no earlier snapshot — so the compare affordance on the first pass depends on
   * it exactly as every later pass depends on its predecessor's snapshot. Main
   * measures it with the same `fs.existsSync` `requireFamilySource` refuses on,
   * which is why a chain whose source has been moved away draws the button
   * disabled saying so rather than opening a pane onto nothing.
   */
  readonly hasSource: boolean;
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
 * Whether the side-by-side compare on a line is real, and if not, why not.
 *
 * ── WHICH TWO BOOKS A PASS IS COMPARED AS, PROVED FROM THE DERIVATION ───────
 *
 * A ledger entry's snapshot is the book AFTER its pass ran. That is not a
 * reading of the field's name — it is what `deriveWorkingCopy` does with it
 * (electron/manifest-service.ts): given `{ from: 'ledger', keep }` it copies
 * `keep[keep.length - 1].snapshot` and the record it writes says those entries
 * are APPLIED. `deleteLedgerEntry` is the same fact from the other side: to take
 * entry N back it derives from `deletion.kept` — everything BEFORE N — and from
 * the archive-grade base when nothing is left. So "the book without pass N" is
 * entry N-1's snapshot, or the family's source for the first entry, and "the
 * book with pass N" is entry N's own snapshot.
 *
 * Hence the two disabled states, which are different missing files and get
 * different sentences:
 *
 *  - 'no-after' — this entry's own snapshot is gone. The pass's result is not on
 *    this disk, so there is no "after" to show.
 *  - 'no-before' — the file this pass ran ON is gone: the previous entry's
 *    snapshot, or the chain's archive-grade source for the first pass.
 *
 * 'none' is a line that is not a pass at all.
 */
export type CompareAffordance = 'ready' | 'no-after' | 'no-before' | 'none';

/**
 * Which buttons a line gets.
 *
 * The three standing ones (`open`, `export`, `delete`) are laid out in fixed
 * columns, so they line up down the page. `false` means the column is EMPTY
 * rather than absent — that is what keeps the alignment. Delete is live on EVERY
 * chain line (Owen, 2026-08-10: "it should always be available"), each routed to
 * the remover that owns that artifact's records — the page may still disable one
 * with a reason when the ROW arrives in a state its remover cannot classify.
 *
 * `open` and `export` are the DOCUMENT half and are on documents only: the
 * archive PDF, the book, the narration copy. The ledger kinds
 * (`working-changes`, `ledger`) leave both columns empty — see the header.
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
   * Export TTS copy — cut this chain's narration copy from its book.
   *
   * ── Moved here from the picker (Owen, 2026-08-10) ──────────────────────────
   *
   * "lets also make it so they can generate a tts file from the versions window,
   * with a button, instead of only doing it from inside the pdf picker." And,
   * completing the move: "we dont do tts configuration from there. we do it from
   * the main window."
   *
   * On the PARENT ROW, and there ALWAYS — not only while the chain has no
   * narration copy yet. Cutting the copy again is the ordinary act, not the
   * exceptional one: every block struck out after the last cut is a change the
   * narration copy does not have, and a button that disappeared once the file
   * existed would leave the second cut with no door. That is the same mistake as
   * a working copy with no line, in the other direction.
   *
   * It is NOT the narration row's Process, which means something else entirely —
   * take THIS file to narration. One makes the file, the other reads it.
   *
   * Gated on the parent row being an EPUB, exactly as the passes are: a
   * narration copy is cut from a book, and a chain whose parent line is somehow
   * not one has nothing to cut.
   */
  readonly ttsExport: boolean;
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
  /**
   * Compare — the book before this pass and the book after it, side by side, as
   * real pages.
   *
   * A SECOND account of the same pass, beside `review`, and deliberately not a
   * replacement for it: the receipt is a word-diff and this is the book, so a
   * pass whose receipt was never written (translate records none, by design —
   * a diff of a translation shares no words with what it replaced) still has a
   * compare, and that is the first review affordance translate has ever had.
   *
   * It reads two files and opens neither as the session's document. See the
   * ledger line's own comment for why that distinction is the whole point.
   */
  readonly compare: CompareAffordance;
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
  ttsExport: false,
  eraseEverything: false,
  review: 'none',
  compare: 'none',
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

  /**
   * The rows a chain has deliberately NOT drawn as files of their own.
   *
   * Every chain's working copy goes in here, whether or not any line ended up
   * standing on it — that is the unconditional half of the absorption rule the
   * header argues for, and the reason it is a set built as the chains are laid
   * out rather than a question asked of the finished lines. The loose sweep
   * skips these: they are not undrawn work, they are work the model has decided
   * has no line.
   */
  const absorbed = new Set<string>();

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

    // The working copy has no line of its own, and that is settled HERE — before
    // anything is drawn and regardless of what ends up being drawn. When this
    // chain's parent row IS the copy's row (a chain hanging off an EPUB the user
    // handed us) it is still absorbed: what gets drawn on it is the BOOK, and
    // the loose sweep must not consider the same row a second time as a file.
    if (exportedRow !== null) absorbed.add(exportedRow.id);

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
        analysis: isBookRow(bookRow),
        // The passes are done TO the book, so they are offered from the book —
        // and only when it is a book. A chain whose top-level line is somehow
        // not an EPUB has nothing for simplify or translate to rewrite.
        passes: isBookRow(bookRow),
        // Cutting the narration copy, from the book it is cut FROM. Same gate as
        // the passes and for the same reason — see ChainButtons.ttsExport.
        ttsExport: isBookRow(bookRow),
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
          // The ledger half of the matrix — clear, and nothing else.
          delete: true,
        },
      });
    }

    // The passes the user committed to, in the order they ran. The ledger is
    // read off this chain's exported row, so a chain with no working copy on
    // screen draws none.
    if (exportedRow !== null) for (const [index, entry] of family.ledger.entries()) {
      // The file this pass RAN ON: the snapshot the pass before it left, and the
      // chain's archive-grade source for the first pass — which is precisely
      // where `deleteLedgerEntry` sends the working copy back to when it takes
      // this entry away. See CompareAffordance for the derivation this is read
      // off; the layout does not decide it, it states it.
      const beforeOnDisk = index === 0
        ? family.hasSource
        : family.ledger[index - 1].hasSnapshot;
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
          // A LEDGER, not a document (Owen, 2026-08-10: "footnotes and working
          // changes are more ledgers than documents, to the user's eyes"). What
          // this line offers is the account of what the pass did and the act
          // that takes it back — never a door onto the snapshot.
          //
          // The entry still OWNS a snapshot; that file is how the pass is undone
          // (`deriveWorkingCopy` from the ledger) and it is not a version of the
          // book the user is meant to work in. Opening it bound the project to a
          // document whose edits the picker could not vouch for and left the
          // session writable, which is how an evening of working changes was
          // destroyed by pressing Open on this line.
          review: entry.hasReceipt ? 'ready' : 'no-receipt',
          // The pages, rather than the words. Asked of BOTH books, because a
          // compare with one pane is not a compare — and named separately so
          // the button can say which of the two is missing. Neither file is
          // opened as anything: the compare reads them where they lie, which is
          // what makes offering a door onto a snapshot safe here and not above.
          compare: !entry.hasSnapshot
            ? 'no-after'
            : beforeOnDisk ? 'ready' : 'no-before',
          open: false,
          export: false,
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
    // A working copy is never swept up here. It is not a row that failed to be
    // drawn — it is a row the model has decided has no line, and the sweep's
    // "work with no door" argument does not apply to it: every door onto that
    // file is on its chain's parent row, which IS drawn. Asked before the
    // `drawn` check because the whole bug was that `drawn` cannot answer this —
    // a freshly cast book has no working-changes line and no ledger, so nothing
    // stood on the copy's row and the sweep drew it as a file called "Working
    // copy" (Owen, 2026-08-10).
    if (absorbed.has(row.id)) continue;
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
