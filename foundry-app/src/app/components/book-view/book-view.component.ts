import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

// The ONE hue table the analysis's colours come from — the panel's rails and the
// paper's tints are two treatments of it, never two lists. See `tintOf`.
import { analysisCategoryHue } from '@owen/foundry-core/shared/analysis-categories';
import { PDF_BLOCK_CATEGORIES, pdfCategoryColour, pdfCategoryLabel } from '@owen/foundry-core/shared/categories';
import type { BookLoad, BookRow } from '@owen/foundry-core/shared/book';
import { OriginalPanelComponent } from './original-panel.component';
// The reader's words for the three rewrites, and the only copy of them: the
// dialog's cards, the queue's row and this pane's sentences all print the same
// table, so a mode cannot be one thing in the history and another on a tooltip.
import { REWRITE_LABELS } from '@owen/foundry-core/shared/ledger';
// The model's inline dialect, mirrored from the emitter's — see `cut`.
import { INLINE_DROPPED, INLINE_ITALIC, INLINE_STRONG, inlineEmphasis } from '@owen/foundry-core/shared/inline';
import { replayOps, struckNotes, unwritten, type BookOp, type ReplayedRow } from '@owen/foundry-core/shared/ops';
import type { AskStackInput } from '@owen/foundry-core/shared/ask-history';
// The compare column's light: which characters went and which came, per block,
// drawn through the same walk as the analysis's — see `cut`.
import { foldQuotes, wordDiff, type ChangeRange, type WordDiff } from '@owen/foundry-core/shared/word-diff';

import { api } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { AnalysisViewService } from '../../core/analysis-view.service';
import { AskService } from '../../core/ask.service';
import { ChangesService } from '../../core/changes.service';
import { StageService } from '../../core/stage.service';
import type { LitRange } from '@owen/foundry-core/shared/analysis';
import { AnalysisPickerComponent } from '../analysis-panel/analysis-picker.component';
import { ComparePickerComponent } from '../compare/compare-picker.component';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { type Tab } from '../../core/documents.service';
import { NoticeService } from '../../core/notice.service';
import { editionFlow, editionPieces } from '@owen/foundry-core/shared/edition';
import { chapterOrder, flowNeighbours, seamJoins, sharedAnchor } from '@owen/foundry-core/shared/flow';
import { readTable, type TableRow } from '@owen/foundry-core/shared/table';
import { Line, PULSE_MS, ALIGNED_MIN_REM, SCROLL_SETTLE_MS, Gesture, WordsGesture, tintOf } from './book-view.model';
import { sizeOf, cut } from './book-view.lines';
import * as loading from './book-view.load';
import * as sheets from './book-view.sheets';
import * as bench from './book-view.bench';
import * as scrolling from './book-view.scroll';
import * as gestures from './book-view.gestures';
import * as journal from './book-view.journal';
import * as editing from './book-view.editing';
import * as blockMenu from './book-view.menu';
import * as wiring from './book-view.wiring';
import * as layout from './book-view.layout';

@Component({
  selector: 'app-book-view',
  imports: [NgTemplateOutlet, AnalysisPickerComponent, ComparePickerComponent, OriginalPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './book-view.component.html',
  styleUrl: './book-view.component.scss',
})
export class BookViewComponent {
  readonly tab = input.required<Tab>();
  /**
   * THE STEP THIS VIEWER IS LOCKED TO, or null for the ordinary case — the
   * position.
   *
   * Compare's one wire into this component (docs/PLAN.md §4, unit 8d). Set, it
   * changes exactly three things and nothing else: the book is read through
   * `book:load-at` for the named row instead of `book:load` for the pointer,
   * `viewing()` goes true so the whole read-only projection the export view has
   * used for months applies, and no stack is registered — see each of the three.
   *
   * IT IS AN INPUT AND NOT A FLAG ON THE TAB, because a compare column's tab is
   * synthetic (`CompareColumnComponent`) and `Tab` is the shape of a document the
   * window HAS OPEN. Putting a step id on it would make every real tab carry a
   * field that is meaningless for it, and would invite something in the documents
   * service to start meaning something by it.
   */
  readonly atStep = input<string | null>(null);

  readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly stacks = inject(BookStacksService);
  /**
   * The open analysis, read for ONE thing: which characters of which blocks the
   * paper lights. See `lit` below — nothing else on this component touches it,
   * and this viewer never writes to it.
   */
  readonly analysis = inject(AnalysisViewService);
  /**
   * The open comparison's diff, read for one thing and written for one thing:
   * which characters of which blocks changed against the other column (read,
   * `changeLight`), and what this sheet's rows ARE so that diff can be made
   * (written, the publishing effect in the constructor). Only a pane that is a
   * PARTY to the comparison touches it either way — see `party`.
   */
  readonly changes = inject(ChangesService);
  /**
   * The stage, asked two questions and nothing more: is there a comparison, and
   * is the document in front of the person this one. Both go into `party`.
   */
  readonly stage = inject(StageService);
  readonly notices = inject(NoticeService);
  readonly ledger = inject(LedgerService);
  /** For `afterNextRender` from an event handler — see `edit`. */
  readonly injector = inject(Injector);

  readonly book = signal<BookLoad | null>(null);
  protected readonly loading = signal(true);
  protected readonly problem = signal<string | null>(null);

  /**
   * WHAT AN OLD SAVE ON THIS PATH DECIDED AND THIS BOOK HAS NOWHERE TO PUT.
   *
   * Empty for every project made under the op grammar. A `curate` step froze its
   * decisions in the coordinates the bank uses, and they are re-keyed onto block
   * ids when the book is opened; the handful that cannot be placed come back as
   * sentences (`BookLoad.unplaced`). They are drawn ON THE PAPER rather than
   * pushed to the notice strip, because the strip is for what a gesture would not
   * do and this is a standing fact about the book in front of the person — it is
   * true for as long as they stand on that row, and a strip that said it once
   * would have said it to somebody who was still reading the title.
   */
  protected readonly unplaced = computed<readonly string[]>(() => this.book()?.unplaced ?? []);

  /** The blocks the user has picked. Purely visual, and purely this pane's. */
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  /** The note whose apparatus is under the pointer — it and its markers light together. */
  protected readonly lit = signal<string | null>(null);
  /**
   * ── The original panel: the scan's page, docked beside the book ────────────
   *
   * `originalOpen` is the head-row toggle and `originalRow` is where the
   * reading IS — the block the panel aims its page and outline at. Aimed by
   * the click that selects a block and by the bench's own scroll
   * (`followOriginal`), so the panel tracks the reading without being asked;
   * NEVER cleared by a gesture, because a docked reference that blanked
   * whenever the selection dropped would go dark exactly when a person leans
   * back to look. It changes when the reading moves and only then.
   *
   * THE CARD'S PLACEMENT STATE DIED WITH THE CARD (the gravestone in the
   * template): a docked column needs no viewport arithmetic, no measured
   * width, and no viewChild to read either off.
   */
  protected readonly originalOpen = signal<boolean>(false);
  protected readonly originalRow = signal<BookRow | null>(null);
  /**
   * THE SCAN THIS BOOK WAS READ OFF, or null for a book with no paper behind it.
   * Read straight off the load rather than resolved here — `BookLoad.originalPath`
   * carries the whole argument for what null means and why it means it twice.
   */
  protected readonly original = computed<string | null>(() => this.book()?.originalPath ?? null);
  /*
   * A SECOND SIGNAL STOOD HERE (Wave 41's gravestone) for `originalPages`, the
   * folder of photographed pages a captured book was read off. A captured book's
   * original IS a PDF now, so `original` above answers for it and the original
   * panel draws the page — which is what the second field was holding
   * a place for and never got.
   */
  /** The block a jump landed on, tinted for `PULSE_MS`. */
  protected readonly pulse = signal<string | null>(null);
  /** The source page a hovered ghost names, hairlining every block it spans. */
  protected readonly ghosted = signal<number | null>(null);
  /** The rectangle being dragged, in the sheet's own coordinates. */
  protected readonly marquee =
    signal<{ left: number; top: number; width: number; height: number } | null>(null);

  /**
   * THE STACK — everything decided since the last Apply, oldest first.
   *
   * A LIFO the app works out of (docs/RENDERER.md §0, ruling 5). Undo pops the
   * last one onto `undone`; redo puts it back; Apply writes the whole list as a
   * step and empties both.
   *
   * IT USED TO BE "IN MEMORY AND NOWHERE ELSE", and closing scrapped it. That
   * ruling was reversed on 2026-08-22 after a real project lost real work to it:
   * every gesture below also hands the difference to `rememberPending`, which
   * writes it to the project's sidecar on a debounce, and `load` puts it back. The
   * list is still the only thing anything DRAWS from and still the only thing undo
   * touches — the sidecar is a copy that catches the window falling over, not a
   * second account of the book.
   *
   * IT IS A SIGNAL BECAUSE THE VIEW IS A FUNCTION OF IT. Every gesture on this
   * surface ends as a push here, and the sheet is `replayOps` over the chain and
   * this list — so a push repaints the book and there is no second place where a
   * change is also applied by hand.
   */
  protected readonly pending = signal<readonly BookOp[]>([]);

  /**
   * The tip step's ops as the last load (or the last Apply) recorded them — the
   * disk's side of `waiting()`'s comparison. Empty when the position has no
   * amendable tip, which makes the old arithmetic fall out: nothing landed, so
   * everything pending is waiting.
   */
  readonly landedOps = signal<readonly BookOp[]>([]);
  /** What undo has taken off the stack, newest last. Cleared by any new gesture. */
  readonly undone = signal<readonly BookOp[]>([]);

  /**
   * EVERYTHING THE PERSON DID, IN ORDER — ops and corrected paragraphs in one
   * journal, because undo has to walk back through both.
   *
   * ── The defect this repairs (found live, 2026-08-23) ────────────────────────
   *
   * On a translated or simplified position a text edit is not an op: the words
   * belong to the records file, commit routes them through `correct`, and the
   * ops stack never hears about them (docs/RENDERER.md §5 — one truth per
   * paragraph). Which meant Ctrl+Z did NOTHING for exactly the edit people make
   * most — Owen: *"changing the text inside a block definitely wasnt undoing"* —
   * while strikes, made of ops, took back fine beside it. Reproduced end to end
   * in a sandboxed window before this was written: the committed words landed in
   * the records, `pending` stayed empty, and the chord had nothing to pop.
   *
   * ── What a journal entry is, and what undoing one does ─────────────────────
   *
   * An `op` entry is a MARKER — the op itself stays on `pending`, which Apply
   * and the sidecar read exactly as before; the marker only records where it
   * falls among the corrections. A `words` entry carries the paragraph's before
   * and after, and undoing it is ANOTHER CORRECTION, back to `before` — through
   * the same `correct` door, so the records file stays the one truth and what
   * lands on disk is the honest history of somebody changing their mind. Redo is
   * the same door aimed at `after`.
   *
   * SESSION-SCOPED for the `words` half, deliberately: the ops half survives in
   * the sidecar as it always has, and a correction is already durable in the
   * records — what does not survive a reload is only the MEMORY of which
   * direction you were walking, which is `history.ts`'s own retired rule
   * (undo does not persist across sessions, docs/DERIVED-BOOK.md §3).
   */
  readonly did = signal<readonly Gesture[]>([]);
  /** The gestures undo walked back over, newest last. Cleared by any new gesture. */
  readonly rewound = signal<readonly Gesture[]>([]);
  /** Corrections the journal can still take back — the Undo button's other reason to exist. */
  protected readonly corrected = computed(
    () => this.did().filter((gesture) => gesture.kind === 'words').length);
  /** True while `book:apply` is in flight, so the button cannot be pressed twice. */
  protected readonly applying = signal(false);

  /** The block being retyped, or null. Exactly one at a time, by construction. */
  protected readonly editingId = signal<string | null>(null);

  /**
   * The block whose chapter chip is being renamed, or null.
   *
   * A SECOND SIGNAL AND NOT A MODE OF THE FIRST. `editingId` is a caret in the
   * BOOK's words and this is a caret in a division's name; they are two different
   * things being typed into, they commit through different doors and Enter means
   * something different in each (a cut, and a name). One signal serving both would
   * be a state that has to be asked what it is about before it can be read.
   */
  protected readonly renaming = signal<string | null>(null);

  /**
   * The category list, open over a block's chip.
   *
   * `ids` is every block the choice will land on. It is more than one exactly
   * when the chip pressed belongs to a MULTI-SELECTION — Owen's ask, verbatim:
   * *"i want to be able to select multiple blocks and change all their
   * categories at once."* The selection is captured AT OPEN, like the
   * right-click menu's counts, so the list acts on what the person was looking
   * at when they pressed and not on whatever the selection says by the time
   * they choose. `category` stays the pressed block's own, because "current"
   * is only honest as a mark about the chip that was pressed.
   */
  protected readonly menu = signal<{
    ids: readonly string[];
    category: string;
    x: number;
    y: number;
  } | null>(null);

  /** The categories the chip's list offers — the ONE table, in the engine's order. */
  protected readonly categories = PDF_BLOCK_CATEGORIES;

  /**
   * WHICH OF THE TWO REGISTERS IS ON SCREEN — the bench, or the edition.
   *
   * ── IT IS NOT REMEMBERED, AND THAT IS THE RULING ────────────────────────────
   *
   * Nothing writes this down: not the project file, not the window's layout, not
   * a step. Opening a book opens it on the bench, and so does moving to another
   * step, because a preview is a GLANCE and not a state of the project — the
   * person went to look at what the export will do and then came back to work. A
   * mode that survived a reload would mean somebody could open a book they have
   * decisions waiting on and be handed a page with no gutters, no chips and no
   * Apply, with nothing on screen saying why. `load` puts it back for exactly
   * that reason.
   *
   * IT IS ALSO NOT AN OP AND NOT IN THE UNDO STACK, on the selection's own rule:
   * it is a fact about this pane and about nothing in the book.
   */
  protected readonly mode = signal<'workbench' | 'edition'>('workbench');
  /** Read all over the template and the guards — the mode, asked as a question. */
  protected readonly edition = computed(() => this.mode() === 'edition');

  /**
   * A TAB THAT SHOWS A FINISHED EXPORT — the sheet locked to the Final version
   * register over an exploded copy of the file (user ruling, 2026-08-16:
   * left-click opens it, Ctrl+S saves a copy). Nothing about it is a position:
   * no stack, no Apply, no register toggle, and every door that would edit
   * says where editing lives instead.
   */
  protected readonly viewing = computed(() =>
    this.tab().viewOnly === true || this.atStep() !== null);

  /**
   * WHETHER THE SOURCE STANDS BESIDE THE TRANSLATION — the second control, and
   * the one that is not a register.
   *
   * NOT REMEMBERED, on `mode`'s ruling and for its reason: a book opens with one
   * column and so does moving to another step, because two columns are a way of
   * READING this book rather than a fact about it. `load` puts it back.
   *
   * WHAT IS ON SCREEN IS `aligned()` BELOW AND NOT THIS. This is what the person
   * asked for; that is what the pane can honestly give them, which also depends on
   * there being a source to show, room to show it in, and a register that has two
   * columns to give. The template reads only the second, so the segment that looks
   * pressed and the sheet that is drawn cannot come apart.
   */
  readonly alignment = signal<'alone' | 'aligned'>('alone');

  /**
   * WHETHER A CURLED QUOTE COUNTS AS A CHANGE — the pair's own checkbox, off by
   * default (Owen's ask is quoted at the control). It changes the LIGHT and
   * never the text: both sheets draw the quotes they actually hold, and this
   * decides only whether the diff was taken over the folded strings
   * (`foldQuotes`) or the written ones.
   */
  protected readonly quoteFixes = signal(false);

  protected showQuoteFixes(on: boolean): void {
    this.quoteFixes.set(on);
  }

  /** The translation this position stands under, or null — main's own walk. */
  protected readonly translation = computed(() => this.book()?.translation ?? null);

  /**
   * WHAT THAT PASS IS CALLED — "translation" or "simplification", the one noun
   * every sentence about the pair uses.
   *
   * A simplify is a translate step carrying a mode (shared/types.ts,
   * `RewriteMode`), which is what let this pane draw the aligned view for one
   * without being told about it — and is exactly why the copy was wrong: three
   * sentences said "translation" to somebody who had pressed Simplify, and being
   * told your own act was a different act is worse than being told nothing.
   *
   * READ ONLY WHERE THERE IS A PASS. Every string built from this is drawn under
   * `translation() !== null`, so the null case is not a state anything says out
   * loud; it is a computed nobody reads on a book in its own language.
   */
  protected readonly pass = computed<'translation' | 'simplification'>(() =>
    this.translation()?.rewrite === undefined ? 'translation' : 'simplification');

  /**
   * The pane's own width and the root's font size, in pixels, measured.
   *
   * NEITHER IS ASSUMED. The width comes from a `ResizeObserver` on this host —
   * the pane is a pane in a window with panels either side of it, so the window's
   * width is not this surface's width and never was — and the rem comes from the
   * document's own computed style. Both start at zero, which reads as "not
   * measured yet" and makes the aligned view unavailable until the first frame
   * has been through: an availability answered before anything has been laid out
   * would be an answer about nothing.
   */
  readonly wide = signal(0);
  readonly rem = signal(0);

  readonly roomy = layout.roomy.call(this);

  protected readonly alignRefusal = layout.alignRefusal.call(this);

  protected readonly aligned = layout.aligned.call(this);

  protected readonly twinned = layout.twinned.call(this);

  /** True while a correction is in flight — one paragraph at a time, per gesture. */
  correcting = false;

  /**
   * Which load is the current one.
   *
   * A pane can be pointed at another project before the first answer arrives —
   * and a book file that has to be MADE first takes seconds. Without the ticket
   * the slower of two answers would land last and put one project's blocks under
   * another project's name.
   */
  asked = 0;

  /**
   * The pointer gesture in flight: where it started, and on what.
   *
   * WHAT WAS UNDER THE PRESS IS RECORDED HERE AND ACTED ON AT `release`, and
   * there is not a `(click)` binding anywhere on this sheet. The marquee takes
   * POINTER CAPTURE so that a drag survives leaving the paper, and a captured
   * pointer retargets the compatibility mouse events with it — so a `click` on a
   * note marker would arrive at the sheet with no idea which marker it had been.
   * One gesture, decided in one place, from what the press actually landed on.
   */
  pressed: {
    x: number;
    y: number;
    /** The block the press landed in, or null for the paper between them. */
    id: string | null;
    /**
     * THE ANCHOR, IN SHEET COORDINATES — where on the PAPER the press landed,
     * not where on the screen. The first marquee stored only client coordinates,
     * and a wheel-scroll mid-drag moved the paper under a screen point that
     * stayed put: the rectangle's origin drifted with the scroll and everything
     * scrolled past fell out of the sweep (user report, 2026-08-16). Pinned to
     * the sheet, the origin is the paragraph the hand started at, wherever the
     * scrollbar has since taken it.
     */
    sheetX: number;
    sheetY: number;
    /** The pointer's last known place, so a scroll can re-run the sweep. */
    lastX: number;
    lastY: number;
    /** The sheet the marquee is being drawn on, for the scroll re-sweep. */
    sheet: HTMLElement | null;
    /** True when it landed on a reference number rather than on words. */
    onMarker: boolean;
    /** The note that number belongs to, or null when nothing carries it. */
    note: string | null;
    /**
     * The finding whose highlight the press landed on, or null — which is every
     * press on every book with no analysis panel open. See `press`.
     */
    hitKey: string | null;
    /** Where this block jumps to when it is clicked — a note's first marker. */
    jump: string | null;
    extend: boolean;
    /** Alt was down: the press asks for every block of this one's category. */
    similar: boolean;
    base: ReadonlySet<string>;
    dragging: boolean;
  } | null = null;

  pulseTimer: ReturnType<typeof setTimeout> | null = null;

  /** The jump's glide in flight, or null — so a second jump replaces the first. */
  gliding: number | null = null;

  /**
   * THE PEEK — which counterpart is on the card, and where the card sits.
   *
   * Raw geometry in SHEET coordinates, decided once at the click (`peekAt`) so
   * the card and its leader ride the scroll like any other ink on the paper —
   * the whole point of the card is that the scrollbar is the reader's and a
   * click must not move it. `from` is the NOTE the pair belongs to, whichever
   * half was clicked, so the card can light that note's own number inside the
   * paragraph it shows. Cleared by any press on the paper, by Escape, by a mode
   * change and by travel — a card is a glance, not a state of the pane.
   */
  protected readonly peek = signal<{
    target: string;
    from: string | null;
    x: number;
    y: number;
    line: { left: number; top: number; width: number; height: number;
      x1: number; y1: number; x2: number; y2: number };
  } | null>(null);

  /**
   * True between a successful Apply and the reload it causes — the one thing
   * that tells the two reasons for a reload apart.
   *
   * ── Why the stack is NOT cleared the instant main answers ──────────────────
   *
   * Because the answer is not the reload. Main lands the step and moves the
   * pointer; the history is adopted, the position effect notices, the tab's
   * revision moves and `load` runs — three turns later, in Angular's own time.
   * Clearing the ops on the answer would leave the sheet drawing the OLD chain
   * with an empty stack over it for those three turns, which is the book without
   * the changes somebody just applied: a flash of the unedited document, at the
   * exact moment they are looking for confirmation that it worked. So the stack
   * stands until the chain that replaces it has arrived.
   *
   * Which leaves `load` unable to tell "these were just written down" from "you
   * stepped away and let them go", and both clear the same list. This is the
   * difference, held for one round trip and spent by the first load that sees it.
   * A boolean rather than the ids, because the question is which of two things
   * happened and not which ops were involved.
   */
  landed = false;

  constructor() {
    const destroy = inject(DestroyRef);
    effect(() => {
      const dir = this.tab().path;
      /*
       * AND THE REVISION, which is what makes a pointer move reach this pane. The
       * tab's path is the PROJECT directory and never changes; what changes when
       * somebody clicks a row in Steps is which book `book:load` would answer with
       * — a different reading, or the same reading with a different chain of
       * applied changes over it. `PositionSyncService.showBook` bumps this on a genuine
       * position move and on nothing else, which is what keeps clicking the row you
       * are already standing on free.
       */
      this.tab().revision;
      /*
       * AND THE COMPARED STEP, which is the same fact one door along. A compare
       * column's tab never moves — its path is the project and its revision is
       * frozen at zero — so `atStep` is the only thing that says which book this
       * instance is about, and picking a second row without leaving compare mode
       * has to reach the load. Reading it HERE rather than only inside `load` is
       * what makes that true of the component rather than of the way its host
       * happens to be written: the compare column does destroy and rebuild this
       * viewer between steps today, and a correctness that depends on somebody
       * else's re-render is a correctness that ends the day they optimise it.
       */
      this.atStep();
      // Untracked, because the load writes the signals this component draws from,
      // and an effect that reads its own writes is a loop waiting for a disk.
      untracked(() => void this.load(dir));
    });
    wiring.announceStack.call(this, destroy);
    wiring.watchWidthAndAim.call(this, destroy);
    wiring.publishRows.call(this, destroy);
    wiring.travelTogether.call(this);
    wiring.wireSurface.call(this, destroy);
  }

  private load(projectDir: string): Promise<void> { return loading.load.call(this, projectDir); }

  protected waiting(): number { return loading.waiting.call(this); }

  readonly view = sheets.view.call(this);

  protected readonly stranded = layout.stranded.call(this);

  protected readonly refused = layout.refused.call(this);

  readonly chaptersOwned = sheets.chaptersOwned.call(this);

  readonly struckNotes = layout.struckNotesField.call(this);

  readonly printed = sheets.printed.call(this);

  readonly hitLight = sheets.hitLight.call(this);

  readonly asks = inject(AskService);

  readonly askLight = sheets.askLight.call(this);

  readonly party = sheets.party.call(this);

  alignedMemo = sheets.alignedMemo.call(this);

  readonly alignedDiff = sheets.alignedDiff.call(this);

  readonly changeLight = sheets.changeLight.call(this);

  protected readonly chosenHit = sheets.chosenHit.call(this);

  protected readonly lines = sheets.lines.call(this);

  protected readonly sourceLines = sheets.sourceLines.call(this);

  protected readonly sourceProblem = layout.sourceProblem.call(this);

  protected readonly sourceTitle = sheets.sourceTitle.call(this);

  readonly editionLines = sheets.editionLines.call(this);

  protected readonly sheetLines = layout.sheetLines.call(this);

  protected readonly headingSize = layout.headingSize.call(this);

  protected plate(row: BookRow): string | null { return layout.plate.call(this, row); }

  protected show(register: 'workbench' | 'edition'): void { return bench.show.call(this, register); }

  protected align(which: 'alone' | 'aligned'): void { return bench.align.call(this, which); }

  toBench(id: string | null): void { return bench.toBench.call(this, id); }

  protected spans(line: Line): boolean { return layout.spans.call(this, line); }

  protected light(noteId: string | null): void { return layout.light.call(this, noteId); }

  protected lightRow(line: Line): void { return layout.lightRow.call(this, line); }

  aimOriginal(id: string): void { return bench.aimOriginal.call(this, id); }

  protected toggleOriginal(): void { return bench.toggleOriginal.call(this); }

  followOriginal(): void { return bench.followOriginal.call(this); }

  followAnalysis(): void { return bench.followAnalysis.call(this); }

  /** The observer watching the selected passage's block, or null when none is. */
  selectionWatch: IntersectionObserver | null = null;

  watchSelection(id: string | null): void { return bench.watchSelection.call(this, id); }

  protected twin(id: string | null): void { return bench.twin.call(this, id); }

  protected dim(): void { return bench.dim.call(this); }

  protected haunt(page: number | null): void { return bench.haunt.call(this, page); }

  // ───────────────────────────────────────────────────────────────────────────
  // The scroll lock — two columns, one place in the book
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ONE COLUMN DRIVES AT A TIME, and this is which.
   *
   * ── The loop this exists to break ──────────────────────────────────────────
   *
   * Scrolling A moves B. Moving B fires B's own scroll event. If that event moved
   * A, the two columns would push each other down the page for as long as the
   * arithmetic disagreed by a pixel — the classic two-way scroll loop, and it does
   * not merely jitter, it makes both columns unusable. So the column a HAND is on
   * takes the wheel, the other one's events are ignored for the duration, and the
   * wheel goes back when that hand stops (`scrollend`, or `SCROLL_SETTLE_MS` for
   * the one case that fires nothing).
   *
   * IT IS A FIELD AND NOT A SIGNAL. Nothing draws it, it changes many times a
   * second while a wheel is turning, and a signal would put a change-detection
   * pass behind every one of those.
   */
  driving: 'live' | 'source' | null = null;
  drivingTimer: ReturnType<typeof setTimeout> | null = null;

  scrolled(which: 'live' | 'source'): void { return scrolling.scrolled.call(this, which); }

  settled(which: 'live' | 'source'): void { return scrolling.settled.call(this, which); }

  lock(driver: 'live' | 'source'): void { return scrolling.lock.call(this, driver); }

  /**
   * The card, resolved against the book being drawn — the peek's geometry
   * joined with the target row's own pieces, label and state. Null while no
   * card is up OR when the chain has taken the target out of the book from
   * under an open card, which closes it by answering nothing.
   */
  protected readonly peeked = computed(() => {
    const peek = this.peek();
    if (peek === null) return null;
    const line = this.lines().find((one) => one.row.id === peek.target);
    if (line === undefined) return null;
    return {
      target: peek.target,
      label: line.label,
      page: line.row.pages[0] ?? line.row.page,
      pieces: line.pieces,
      struck: line.row.struck === true,
      x: peek.x,
      y: peek.y,
      line: peek.line,
    };
  });

  protected peekFrom(): string | null { return scrolling.peekFrom.call(this); }

  peekAt(sheet: HTMLElement, clientX: number, clientY: number, target: string, from: string | null): void { return scrolling.peekAt.call(this, sheet, clientX, clientY, target, from); }

  protected travel(id: string): void { return scrolling.travel.call(this, id); }

  protected dismissCards(): void { return scrolling.dismissCards.call(this); }

  scrollTo(id: string): void { return scrolling.scrollTo.call(this, id); }

  land(id: string): void { return scrolling.land.call(this, id); }

  protected press(event: PointerEvent): void { return gestures.press.call(this, event); }

  protected drag(event: PointerEvent): void { return gestures.drag.call(this, event); }

  sweep(sheet: HTMLElement, clientX: number, clientY: number): void { return gestures.sweep.call(this, sheet, clientX, clientY); }

  protected release(event: PointerEvent): void { return gestures.release.call(this, event); }

  push(...ops: readonly BookOp[]): void { return journal.push.call(this, ...ops); }

  askStack(): AskStackInput | null { return journal.askStack.call(this); }

  pushAsOne(what: string, ops: readonly BookOp[]): void { return journal.pushAsOne.call(this, what, ops); }

  pushOps(ops: readonly BookOp[], grouped: string | null): void { return journal.pushOps.call(this, ops, grouped); }

  resetJournal(): void { return journal.resetJournal.call(this); }

  remember(): void { return journal.remember.call(this); }

  protected undo(): void { return journal.undo.call(this); }

  protected redo(): void { return journal.redo.call(this); }

  replayWords(entry: WordsGesture, direction: 'undo' | 'redo'): Promise<void> { return journal.replayWords.call(this, entry, direction); }

  replayedFeedback(op: BookOp, direction: 'undo' | 'redo', what?: string): void { return journal.replayedFeedback.call(this, op, direction, what); }

  describeOp(op: BookOp): string { return journal.describeOp.call(this, op); }

  opAnchor(op: BookOp, direction: 'undo' | 'redo'): string | null { return journal.opAnchor.call(this, op, direction); }

  protected applyLabel(): string { return journal.applyLabel.call(this); }

  protected apply(): Promise<boolean> { return journal.apply.call(this); }

  protected discardStack(): void { return journal.discardStack.call(this); }

  protected cancel(event: Event): void { return journal.cancel.call(this, event); }

  protected edit(event: MouseEvent): void { return editing.edit.call(this, event); }

  beginEditing(id: string | null): void { return editing.beginEditing.call(this, id); }

  protected commit(id: string, event: Event): void { return editing.commit.call(this, id, event); }

  correct(id: string, text: string, journal?: Parameters<typeof editing.correct>[2]): Promise<boolean> { return editing.correct.call(this, id, text, journal); }

  protected revert(text: string, event: Event): void { return editing.revert.call(this, text, event); }

  commitEditing(): void { return editing.commitEditing.call(this); }

  protected openCategories(event: MouseEvent, id: string): void { return editing.openCategories.call(this, event, id); }

  protected relabel(ids: readonly string[], category: string): void { return editing.relabel.call(this, ids, category); }

  /**
   * The right-click menu: two verbs about every block of this one's kind.
   *
   * The lists are computed AT OPEN over the flowing lines the sheet is drawing,
   * so the counts in the labels are the counts the verbs will act on — a menu
   * that counted at click time could say a number the replay had since moved.
   * In the edition, and inside any editable, the browser keeps its own menu:
   * the preview offers no verbs, and a caret's right-click is the caret's.
   */
  protected readonly context = signal<{
    x: number;
    y: number;
    /** The block under the pointer — the menu's block-scoped verbs act on it. */
    id: string;
    /**
     * True when a division already starts at this block, so the menu does not
     * offer to add one that is already there. \`set\` would legally retitle it
     * (ChapterSetOp says so on purpose), but a menu item that RENAMES under a
     * label that says ADD is the kind of quiet lie the chip's own double-click
     * rename exists to make unnecessary.
     */
    chapter: boolean;
    colour: string;
    plural: string;
    ids: string[];
    unstruck: string[];
    /**
     * The block this one may be joined onto — the nearest earlier row still in
     * the book — or null where the offer would mint an op the replay refuses.
     * Computed at open (`joinAbove`), which is the menu's own rule: the label
     * is only shown where pressing it lands.
     */
    joinInto: string | null;
  } | null>(null);

  protected blockMenu(event: MouseEvent, line: Line): void { return blockMenu.blockMenu.call(this, event, line); }

  joinAbove(row: ReplayedRow): string | null { return blockMenu.joinAbove.call(this, row); }

  protected joinFromMenu(): void { return blockMenu.joinFromMenu.call(this); }

  protected editFromMenu(): void { return blockMenu.editFromMenu.call(this); }

  protected chapterFromMenu(): void { return blockMenu.chapterFromMenu.call(this); }

  protected dropChapter(id: string): void { return blockMenu.dropChapter.call(this, id); }

  /**
   * A BLOCK THE READING NEVER PRODUCED, ADDED WHERE IT BELONGS — the phantom
   * editor, opened from the menu's two insert verbs.
   *
   * ── What was asked for ──────────────────────────────────────────────────────
   *
   * Owen (2026-08-23): *"there were some cases where the blocks just werent
   * there. the chapter titles werent transferred over. if that happens i need
   * some way to add a new block in a specific location."* Every other gesture on
   * this sheet repairs a block the bank holds; this is the one for a block it
   * missed outright.
   *
   * ── The shape of the gesture, and why it is two steps ──────────────────────
   *
   * The menu names WHERE (above or below the block under the pointer) and the
   * phantom collects the WORDS — an empty editable block drawn at the exact
   * place the real one will stand, focused, committing on blur or Enter exactly
   * as the block editor does. Two steps because the op requires words
   * (`InsertOp`: an insert of nothing is a decision nobody can act on), and a
   * dialog asking for them would collect a paragraph somewhere other than where
   * it is going. A phantom abandoned empty decides nothing and leaves nothing —
   * no op, no row, no step.
   *
   * WHAT IT IS BORN AS: `Text`, always. The commonest miss is a chapter title,
   * but a default of Section-header would be wrong for every other kind of miss,
   * and the block arrives SELECTED — the category chip is already beside it, and
   * the chapter marker is one right-click away, both ordinary ops on an ordinary
   * row the moment it exists.
   */
  protected readonly inserting = signal<{ anchor: string; where: 'above' | 'below' } | null>(null);

  protected insertFromMenu(where: 'above' | 'below'): void { return blockMenu.insertFromMenu.call(this, where); }

  protected commitInsert(event: Event): void { return blockMenu.commitInsert.call(this, event); }

  protected cancelInsert(event: Event): void { return blockMenu.cancelInsert.call(this, event); }

  protected selectSimilar(): void { return blockMenu.selectSimilar.call(this); }

  protected strikeSimilar(): void { return blockMenu.strikeSimilar.call(this); }

  protected join(before: string, into: string): void { return editing.join.call(this, before, into); }

  protected joinChosen(event: Event): void { return editing.joinChosen.call(this, event); }

  protected split(id: string, event: Event): void { return editing.split.call(this, id, event); }

  protected rename(id: string, event: Event): void { return editing.rename.call(this, id, event); }

  protected commitChapter(id: string, was: string, event: Event): void { return editing.commitChapter.call(this, id, was, event); }

  protected abandonChapter(was: string, event: Event): void { return editing.abandonChapter.call(this, was, event); }

  // ───────────────────────────────────────────────────────────────────────────
  // Dragging a division — §4's rule lift, landed
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The division being carried: which one, where its hand is, and the block it
   * would land above right now. Null between drags, which is almost always.
   */
  protected readonly draggingRule = signal<{
    id: string;
    over: string | null;
    /** True once the pointer has cleared the slop — before that it is a click. */
    live: boolean;
    startY: number;
  } | null>(null);

  protected grabRule(event: PointerEvent, id: string): void { return gestures.grabRule.call(this, event, id); }

  protected dragRule(event: PointerEvent): void { return gestures.dragRule.call(this, event); }

  protected dropRule(event: PointerEvent): void { return gestures.dropRule.call(this, event); }
}
